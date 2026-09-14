// Local diagnostic harness. It is not a production endpoint or provider-capacity qualification.
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { availableParallelism, arch, cpus, platform, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { keccak256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { migrate } from '../../src/db/migrate.js';
import { buildRequestTypedData, REST_AUTH_HEADERS as H } from '../../src/rest/auth/signatures.js';
import { PostgresWalletAppGrantStore } from '../../src/rest/wallet/appGrantsPostgres.js';
import type { WalletAppGrant } from '../../src/rest/wallet/appGrants.js';
import { PostgresWalletPolicyStore } from '../../src/rest/wallet/policyPostgres.js';
import { PostgresWalletAuthorityRefreshQueue } from '../../src/rest/wallet/authorityRefreshPostgres.js';
import { createWalletLoginSetup } from '../../test/fixtures/wallet-login-setup.js';
import { runOpenLoop } from './wallet-pressure-schedule.js';

const audience = 'https://wallet-pressure.example';
const origins = ['https://pressure-one.example', 'https://pressure-two.example'];
// Public fixture key only, generated requests remain in memory and never enter reports.
const signer = privateKeyToAccount(`0x${'75'.repeat(32)}`);
export interface WalletPressureOptions {
  durationMs?: number; readRate?: number; mutationRate?: number; inventory?: number;
  hotWallet?: boolean; faultMs?: number; maxInFlight?: number; poolMax?: number;
}
function message(child: ChildProcess, kind: string, timeoutMs = 10_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error('Pressure service response timed out.')), timeoutMs);
    const receive = (value: any) => { if (value?.kind === kind) done(undefined, value); };
    const fail = () => done(new Error('Pressure service exited.'));
    function done(error?: Error, value?: unknown) {
      clearTimeout(timer); child.off('message', receive); child.off('exit', fail); child.off('error', fail);
      if (error) reject(error); else resolve(value);
    }
    child.on('message', receive); child.once('exit', fail); child.once('error', fail);
  });
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const kill = setTimeout(() => child.kill('SIGKILL'), 7500);
    const timeout = setTimeout(() => done(new Error('Pressure service cleanup timed out.')), 10_000);
    const exited = () => done();
    function done(error?: Error) { clearTimeout(kill); clearTimeout(timeout); child.off('exit', exited); if (error) reject(error); else resolve(); }
    child.once('exit', exited); if (child.connected) child.send('stop'); else child.kill('SIGTERM');
  });
}
export async function runWalletPressure(input: WalletPressureOptions = {}): Promise<any> {
  const config = { durationMs: 5000, readRate: 10, mutationRate: 2, inventory: 2,
    hotWallet: false, faultMs: 250, maxInFlight: 64, poolMax: 4, ...input };
  for (const [key, maximum] of [['durationMs', 7_100_000], ['inventory', 10_000], ['faultMs', 5000], ['maxInFlight', 512], ['poolMax', 10]] as const)
    assert(Number.isSafeInteger(config[key]) && config[key] >= (key === 'inventory' ? 2 : 1) && config[key] <= maximum, 'Invalid bounded pressure configuration.');
  assert(typeof config.hotWallet === 'boolean' && Number.isFinite(config.readRate) && Number.isFinite(config.mutationRate)
    && config.readRate >= 0 && config.mutationRate >= 0 && config.readRate + config.mutationRate > 0
    && config.readRate + config.mutationRate <= 1200, 'Invalid offered pressure rates.');
  const connectionString = process.env.TEST_DATABASE_URL;
  assert(connectionString, 'A disposable local TEST_DATABASE_URL is required.');
  const database = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(database.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname),
    'Pressure diagnostics require a local PostgreSQL test database.');
  const schema = `wallet_pressure_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000, query_timeout: 12_000 });
  let pool: Pool | undefined, schemaCreated = false;
  const children: Array<{ child: ChildProcess; url: string; pid: number }> = [];
  const controller = new AbortController(), cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const report: any = { scope: 'diagnostic-synthetic-chain-http-postgres', productionThroughputQualified: false,
    startedAt: new Date().toISOString(), endedAt: null, machine: { platform: platform(), arch: arch(),
      availableParallelism: availableParallelism(), logicalCpus: cpus().length, totalMemoryBytes: totalmem(), node: process.versions.node },
    configuration: { ...config, replicaCount: 2, requestTimeoutMs: 12_000, poolConnectionTimeoutMs: 5000,
      queryTimeoutMs: 12_000, statementTimeoutMs: 10_000, accountOriginQuotaPerMinute: 300, siteQuotaPerMinute: 10_000 },
    fixture: { genuineEnrolledWallets: 2, syntheticInactiveAccountRows: config.inventory - 2,
      syntheticChain: true, authorityMaximumAgeMs: 30_000, refreshMaxTracked: 32,
      refreshMaxConcurrent: 2, refreshMaxStartsPerMinute: 30 },
    limitations: ['Diagnostic routes exercise production authentication, quota, account reads and actor guards; claims are not session/grant mutations.',
      'Inactive account rows have no enrollment, credential or readiness; they measure only account-table cardinality.',
      'Synthetic observations use the real authority reducer, database CAS and unchanged deadlines; no RPC capacity is measured.',
      'Pool acquisition waits and locking-statement durations are measured; locking-statement time includes execution, not solely lock wait.',
      'Child process/database histograms are cumulative since startup. Only generator app/route latencies and rates reset per measured phase.',
      'Only a held-account-lock fault is injected here. Crash, provider, restore, owner/recovery and retention qualification remain separate.',
      'Two-hour grant renewal is not implemented; expired grants must fail rather than silently renew.'],
    phases: [], processes: [], correctness: { childrenStopped: false, schemaRemoved: false } };
  let succeededClaims = 0, unexpectedSuccesses = 0;
  try {
    const version = (await admin.query("SELECT current_setting('server_version_num') AS number,current_setting('server_version') AS version")).rows[0];
    assert(Math.floor(Number(version.number) / 10_000) === 16, 'Pressure diagnostics require PostgreSQL16.'); report.machine.postgres = version.version;
    await admin.query(`CREATE SCHEMA ${schema}`); schemaCreated = true;
    pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000, query_timeout: 12_000,
      options: `-c search_path=${schema} -c statement_timeout=10000 -c idle_in_transaction_session_timeout=10000` });
    await migrate(pool);
    await pool.query('CREATE TABLE wallet_pressure_claims(id text PRIMARY KEY,account_id text NOT NULL REFERENCES rest_accounts(id),principal_id text NOT NULL,app smallint NOT NULL)');
    await new PostgresWalletPolicyStore(pool).activate({ expectedRevision: 0, nextRevision: 1,
      configuration: { version: 'center-wallet-policy-v1', applications: origins.map(origin => ({ origin, walletCallbacks: [`${origin}/callback`] })) } });
    const wallets = [await createWalletLoginSetup(pool), await createWalletLoginSetup(pool)];
    if (config.inventory > 2) await pool.query(`INSERT INTO rest_accounts(id,owner_address,authority_chain_id,display_name,bio,avatar_uri,created_at,updated_at)
      SELECT 'eip155:8453:0x'||lpad(to_hex(value),40,'0'),'0x'||lpad(to_hex(value),40,'0'),8453,'','',NULL,
        floor(extract(epoch FROM clock_timestamp()))::bigint,floor(extract(epoch FROM clock_timestamp()))::bigint FROM generate_series(1,$1) value`, [config.inventory - 2]);
    const grants: WalletAppGrant[][] = [];
    const store = new PostgresWalletAppGrantStore(pool);
    for (const wallet of wallets) {
      const authority = (await pool.query('SELECT authority_epoch,session_epoch FROM rest_wallet_authority WHERE account_id=$1', [wallet.accountId])).rows[0];
      const row: WalletAppGrant[] = [];
      for (const origin of origins) row.push(await store.insert({ accountId: wallet.accountId, signerAddress: signer.address,
        origin, callbackUri: `${origin}/callback`, audience, expectedAppGeneration: 1,
        expectedAuthorityEpoch: authority.authority_epoch, expectedSessionEpoch: authority.session_epoch, expiresAt: Math.floor(Date.now() / 1000) + 3600 }));
      grants.push(row);
    }
    for (let i = 0; i < 2; i++) {
      const child = fork(fileURLToPath(new URL('./wallet-pressure-process.ts', import.meta.url)), [], {
        execArgv: ['--import', 'tsx'], env: { PATH: process.env.PATH, TEST_DATABASE_URL: connectionString,
          WALLET_PRESSURE_SCHEMA: schema, WALLET_PRESSURE_POOL_MAX: String(config.poolMax),
          WALLET_PRESSURE_LIFETIME_MS: String(config.durationMs + Math.min(config.durationMs, 60_000) + 90_000) },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const handle = { child, url: '', pid: child.pid ?? 0 }; children.push(handle);
      const ready = await message(child, 'ready'); handle.url = `http://127.0.0.1:${ready.port}`; handle.pid = ready.pid;
    }
    const replicas = new Map<string, number>();
    async function prepare(app: 0 | 1, route: 'read' | 'diagnostic-claim') {
      const wallet = config.hotWallet ? 0 : app, grant = grants[wallet]![app]!, id = randomUUID();
      const body = route === 'read' ? Buffer.alloc(0) : Buffer.from(JSON.stringify({ id }));
      const issuedAt = Math.floor(Date.now() / 1000), target = route === 'read' ? '/read' : '/diagnostic-claim';
      const claims = { accountId: grant.accountId, signer: signer.address, grantId: grant.id,
        method: route === 'read' ? 'GET' : 'POST', requestTarget: target, contentType: route === 'read' ? '' : 'application/json',
        bodyHash: keccak256(body), issuedAt, expiresAt: issuedAt + 60, nonce: `0x${randomUUID().replaceAll('-', '').repeat(2)}` as Hex,
        idempotencyKey: route === 'read' ? '' : id };
      const signature = await signer.signTypedData(buildRequestTypedData(audience, claims));
      const headers = new Headers({ [H.account]: claims.accountId, [H.signer]: claims.signer, [H.grant]: claims.grantId,
        [H.issuedAt]: String(issuedAt), [H.expiresAt]: String(claims.expiresAt), [H.nonce]: claims.nonce,
        [H.signature]: signature, origin: origins[app]!, 'content-type': claims.contentType,
        ...(claims.idempotencyKey ? { [H.idempotencyKey]: claims.idempotencyKey } : {}) });
      return { id, accountId: grant.accountId, target, method: claims.method, headers, body: route === 'read' ? undefined : body };
    }
    async function send(request: Awaited<ReturnType<typeof prepare>>, signal: AbortSignal) {
      const route = `${request.headers.get('origin')}:${request.target}`, replica = replicas.get(route) ?? 0;
      replicas.set(route, replica + 1);
      const response = await fetch(children[replica % 2]!.url + request.target,
        { method: request.method, headers: request.headers, ...(request.body ? { body: request.body } : {}), signal });
      const body: any = await response.json();
      const expected = body?.ok === true && (request.target === '/read' ? body.kind === 'read' && body.accountId === request.accountId
        : body.kind === 'diagnostic-claim' && body.id === request.id);
      if (response.ok && !expected) unexpectedSuccesses++;
      return { status: response.status, admitted: response.headers.get('x-wallet-pressure-admitted') === '1', success: response.ok && expected };
    }
    const phase = async (name: string, durationMs: number) => {
      const result = await runOpenLoop({ durationMs, readRate: config.readRate, mutationRate: config.mutationRate,
        maxInFlight: config.maxInFlight, maxLagMs: 250, requestTimeoutMs: 12_000, drainTimeoutMs: 13_000, signal: controller.signal,
        execute: async (offer, signal) => {
          const response = await send(await prepare(offer.app, offer.route), signal);
          if (response.success && offer.route === 'diagnostic-claim') succeededClaims++;
          return response;
        } });
      const snapshotsFor = () => Promise.all(children.map(async ({ child }) => { const pending = message(child, 'snapshot'); child.send('snapshot'); return pending; }));
      let snapshots = await snapshotsFor();
      const idleDeadline = performance.now() + 2000;
      while (snapshots.some(value => value.active > 0) && performance.now() < idleDeadline) {
        await new Promise(resolve => setTimeout(resolve, 25)); snapshots = await snapshotsFor();
      }
      report.phases.push({ name, result, queue: await new PostgresWalletAuthorityRefreshQueue(pool!).stats(), processes: snapshots });
      if (result.unsettled || result.stoppedEarly || snapshots.some(value => value.active > 0))
        throw new Error('Pressure work did not settle before the next phase.');
    };
    await phase('steady', config.durationMs);
    const lock = await pool.connect(); await lock.query('BEGIN');
    await lock.query('SELECT id FROM rest_accounts WHERE id=$1 FOR UPDATE', [wallets[0]!.accountId]);
    let releasing: Promise<void> | undefined, sampling = false, maxLockWaiters = 0;
    const lockedAt = performance.now(); let heldMs = 0;
    const release = () => releasing ??= (async () => {
      try { await lock.query('ROLLBACK'); heldMs = performance.now() - lockedAt; } finally { lock.release(); }
    })();
    const timer = setTimeout(() => { void release().catch(() => {}); }, config.faultMs);
    const sample = setInterval(() => {
      if (sampling) return; sampling = true;
      void admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [schema])
        .then(value => { maxLockWaiters = Math.max(maxLockWaiters, Number(value.rows[0].count)); })
        .catch(() => {}).finally(() => { sampling = false; });
    }, 10);
    try { await phase('held-account-lock', Math.max(1000, config.faultMs + 250)); }
    finally { clearTimeout(timer); clearInterval(sample); await release(); }
    report.fault = { kind: 'held-account-lock', plannedMs: config.faultMs, heldMs, maxObservedLockWaiters: maxLockWaiters };
    await phase('recovery', Math.min(config.durationMs, 60_000));
    const invalid = await prepare(0, 'diagnostic-claim'); invalid.headers.set(H.nonce, `0x${'ff'.repeat(32)}`);
    report.correctness.invalidSignatureStatus = (await send(invalid, AbortSignal.timeout(12_000))).status;
    const replay = await prepare(0, 'diagnostic-claim'), first = await send(replay, AbortSignal.timeout(12_000));
    if (first.success) succeededClaims++;
    const before = Number((await pool.query('SELECT count(*)::int AS count FROM wallet_pressure_claims WHERE id=$1 AND account_id=$2', [replay.id, replay.accountId])).rows[0].count);
    report.correctness.replayStatus = (await send(replay, AbortSignal.timeout(12_000))).status;
    const replayAfter = Number((await pool.query('SELECT count(*)::int AS count FROM wallet_pressure_claims WHERE id=$1 AND account_id=$2', [replay.id, replay.accountId])).rows[0].count);
    const after = Number((await pool.query('SELECT count(*)::int AS count FROM wallet_pressure_claims')).rows[0].count);
    Object.assign(report.correctness, { replayAddedClaim: replayAfter !== before, unexpectedSuccesses,
      durableClaims: after, successfulDiagnosticClaimResponses: succeededClaims, durableClaimsMatchSuccessfulResponses: after === succeededClaims,
      duplicateClaims: Number((await pool.query('SELECT count(*)::int AS count FROM (SELECT id FROM wallet_pressure_claims GROUP BY id HAVING count(*)>1) duplicate')).rows[0].count),
      consumedRequestNonces: Number((await pool.query('SELECT count(*)::int AS count FROM rest_request_nonces')).rows[0].count) });
    report.processes = report.phases.at(-1).processes;
    report.generator = { memory: process.memoryUsage(), cpu: process.cpuUsage() };
    report.measurementComplete = report.phases.every((value: any) => !value.result.unsettled && !value.result.stoppedEarly);
    report.correctnessPassed = unexpectedSuccesses === 0 && after === succeededClaims && replayAfter === before
      && report.correctness.invalidSignatureStatus === 401 && report.correctness.replayStatus === 409;
    report.diagnosticTargetsMet = report.phases.every((phase: any) => phase.result.rows.every((row: any) => !row.offered
      || (row.success / row.offered >= 0.99 && row.scheduledLatency.p95Ms <= 500 && row.scheduledLatency.p99Ms <= 1000)));
    return report;
  } catch {
    report.measurementComplete = false; report.correctnessPassed = false;
    throw Object.assign(new Error('Local pressure measurement did not complete.'), { report });
  } finally {
    controller.abort(); process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
    const stopped = await Promise.allSettled(children.map(({ child }) => stop(child)));
    report.correctness.childrenStopped = stopped.every(value => value.status === 'fulfilled');
    try { await pool?.end(); } finally {
      try { if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`); report.correctness.schemaRemoved = true; }
      finally { await admin.end(); report.endedAt = new Date().toISOString(); }
    }
    if (!report.correctness.childrenStopped) throw new Error('Pressure service cleanup failed.');
  }
}

async function main() {
  const input: WalletPressureOptions = {};
  for (let index = 2; index < process.argv.length; index++) {
    const flag = process.argv[index];
    if (flag === '--hot-wallet') { input.hotWallet = true; continue; }
    const names: Record<string, keyof WalletPressureOptions> = { '--duration-ms': 'durationMs', '--read-rate': 'readRate',
      '--mutation-rate': 'mutationRate', '--inventory': 'inventory', '--fault-ms': 'faultMs', '--max-in-flight': 'maxInFlight', '--pool-max': 'poolMax' };
    const key = names[flag!]; if (!key) throw new Error('Unknown wallet pressure option.');
    (input as Record<string, unknown>)[key] = Number(process.argv[++index]);
  }
  const directory = resolve('.generated/wallet-observations/pressure', `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const { captureSourceSnapshot } = await import(new URL('./check-required-tests.mjs', import.meta.url).href);
  const sourceStart = await captureSourceSnapshot(process.cwd());
  let report: any;
  try { report = await runWalletPressure(input); }
  catch (error) { report = error && typeof error === 'object' && 'report' in error ? error.report
    : { scope: 'diagnostic-synthetic-chain-http-postgres', productionThroughputQualified: false,
      measurementComplete: false, failure: 'Local pressure preflight failed.' }; }
  const sourceEnd = await captureSourceSnapshot(process.cwd());
  Object.assign(report, { sourceStart, sourceEnd, sourceChangedDuringRun: sourceStart.fingerprint !== sourceEnd.fingerprint });
  const temporary = resolve(directory, 'summary.tmp');
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, resolve(directory, 'summary.json'));
  if (!report.measurementComplete || !report.correctnessPassed || report.sourceChangedDuringRun) process.exitCode = 1;
  process.stdout.write(`Local diagnostic pressure report: ${resolve(directory, 'summary.json')}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void main().catch(() => { process.stderr.write('Local wallet pressure diagnostic failed; no throughput qualification was produced.\n'); process.exitCode = 1; });
