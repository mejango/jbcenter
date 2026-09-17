import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { keccak256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { migrate } from '../src/db/migrate.js';
import { buildRequestTypedData, REST_AUTH_HEADERS as H, type RequestClaims } from '../src/rest/auth/signatures.js';
import { PostgresAccountStore } from '../src/rest/auth/postgres.js';
import { createRestAuth } from '../src/rest/auth/service.js';
import { PostgresWalletAppGrantStore } from '../src/rest/wallet/appGrantsPostgres.js';
import { walletAppPrincipalId, type WalletAppGrant } from '../src/rest/wallet/appGrants.js';
import { PostgresWalletPolicyStore } from '../src/rest/wallet/policyPostgres.js';
import { PostgresWalletAuthorityRefreshQueue } from '../src/rest/wallet/authorityRefreshPostgres.js';
import { PostgresSmartAccountRegistry } from '../src/rest/smartAccounts/postgres.js';
import { createWalletLoginSetup } from './fixtures/wallet-login-setup.js';

const connectionString = process.env.TEST_DATABASE_URL, suite = connectionString ? describe : describe.skip;
const schema = `wallet_app_refresh_${randomUUID().replaceAll('-', '')}`;
const audience = 'https://juicebox.center', origin = 'https://beep.example';
const appKey = privateKeyToAccount(`0x${'71'.repeat(32)}`), otherKey = privateKeyToAccount(`0x${'72'.repeat(32)}`);
const children = new Set<ChildProcess>();
let admin: Pool, pool: Pool, first: Worker, second: Worker, unknown: Worker;
type Worker = Awaited<ReturnType<typeof start>>;
const configuration = (enabled = true) => ({ version: 'center-wallet-policy-v1' as const,
  applications: enabled ? [{ origin, walletCallbacks: [`${origin}/callback`] }] : [] });
async function nowMs() { return Number((await pool.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now')).rows[0].now); }
async function waitPast(deadline: number) {
  const remaining = deadline - await nowMs(); if (remaining > 6000) throw new Error('Fixture deadline is not bounded');
  await pool.query('SELECT pg_sleep($1)', [Math.max(0, remaining + 30) / 1000]); expect(await nowMs()).toBeGreaterThan(deadline);
}
function message(child: ChildProcess, kind: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Refresh fixture did not emit ${kind}`)), 10_000);
    const receive = (value: unknown) => { if (value && typeof value === 'object' && 'kind' in value && value.kind === kind) finish(undefined, value as Record<string, unknown>); };
    const exited = () => finish(new Error('Refresh fixture exited')), failed = () => finish(new Error('Refresh fixture failed'));
    function finish(error?: Error, value?: Record<string, unknown>) {
      clearTimeout(timer); child.off('message', receive); child.off('exit', exited); child.off('error', failed);
      if (error) reject(error); else resolve(value!);
    }
    child.on('message', receive); child.once('exit', exited); child.once('error', failed);
  });
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) { children.delete(child); return; }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Refresh fixture did not terminate')), 5000);
    const exited = () => finish();
    function finish(error?: Error) { clearTimeout(timer); child.off('exit', exited); children.delete(child); if (error) reject(error); else resolve(); }
    child.once('exit', exited); child.kill('SIGKILL');
  });
}
async function start(mode: 'fresh' | 'unknown' | 'queue-error' = 'fresh', observeBarrier = false) {
  const child = fork(fileURLToPath(new URL('./fixtures/wallet-app-refresh-process.ts', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'], env: { ...process.env, WALLET_APP_REFRESH_TEST_SCHEMA: schema,
      WALLET_APP_REFRESH_TEST_MODE: mode, WALLET_APP_REFRESH_TEST_QUEUE_OPTIONS: JSON.stringify({ interestMs: 1000 }),
      ...(observeBarrier ? { WALLET_APP_REFRESH_TEST_BARRIER: 'observe' } : {}) }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  children.add(child); const ready = await message(child, 'ready');
  return { child, backendPid: Number(ready.backendPid), url: `http://127.0.0.1:${ready.port}` };
}
async function seed(options: { readyMs?: number; grantSeconds?: number } = {}) {
  // Genuine enrollment/credential/setup consent. Only canonical observation is synthetic;
  // the process uses the actual authority reducer/CAS and real scheduling queue.
  const login = await createWalletLoginSetup(pool, { lifetimeMs: options.readyMs ?? 30_000 });
  const authority = (await pool.query('SELECT authority_epoch,session_epoch FROM rest_wallet_authority WHERE account_id=$1', [login.accountId])).rows[0];
  const grant = await new PostgresWalletAppGrantStore(pool).insert({ accountId: login.accountId, signerAddress: appKey.address,
    origin, callbackUri: `${origin}/callback`, audience, expectedAppGeneration: 1,
    expectedAuthorityEpoch: authority.authority_epoch, expectedSessionEpoch: authority.session_epoch,
    expiresAt: Math.floor(await nowMs() / 1000) + (options.grantSeconds ?? 600) });
  return { ...login, grant };
}
async function signed(grant: WalletAppGrant, options: { changes?: Partial<RequestClaims>; key?: typeof appKey;
  browserOrigin?: string | null; claimId?: string; barrier?: string; target?: string } = {}) {
  const key = options.key ?? appKey, target = options.target ?? (options.claimId ? '/fixture/claim' : '/api/v1/accounts/me');
  const body = options.claimId ? Buffer.from(JSON.stringify({ id: options.claimId })) : Buffer.alloc(0);
  const current = Math.floor(await nowMs() / 1000);
  const claims: RequestClaims = { accountId: grant.accountId, signer: key.address, grantId: grant.id,
    method: options.claimId ? 'POST' : 'GET', requestTarget: target, contentType: options.claimId ? 'application/json' : '',
    bodyHash: keccak256(body), issuedAt: current, expiresAt: current + 60,
    nonce: `0x${randomUUID().replaceAll('-', '').repeat(2)}`, idempotencyKey: '', ...options.changes };
  const signature = await key.signTypedData(buildRequestTypedData(audience, claims));
  const headers = new Headers({ [H.account]: claims.accountId, [H.signer]: claims.signer, [H.grant]: claims.grantId,
    [H.issuedAt]: String(claims.issuedAt), [H.expiresAt]: String(claims.expiresAt), [H.nonce]: claims.nonce,
    [H.signature]: signature, 'content-type': claims.contentType });
  const browserOrigin = options.browserOrigin === undefined ? origin : options.browserOrigin;
  if (browserOrigin !== null) headers.set('origin', browserOrigin);
  if (options.barrier) headers.set('x-fixture-barrier', options.barrier);
  return { claims, target, init: { method: claims.method, headers, ...(body.length ? { body } : {}) } };
}
async function send(worker: Worker, request: Awaited<ReturnType<typeof signed>>) {
  const response = await fetch(worker.url + request.target, { ...request.init, credentials: 'omit', signal: AbortSignal.timeout(12_000) });
  return { status: response.status, body: await response.json() as any };
}
async function work() { return (await pool.query(`SELECT
  count(*) FILTER(WHERE kind='request')::int AS requests,count(*) FILTER(WHERE kind='observe')::int AS observations,
  (SELECT count(*)::int FROM wallet_app_refresh_claims) AS claims FROM wallet_app_refresh_events`)).rows[0]; }
// The observation an admitted request asks for runs after its response; wait for the worker's record.
async function untilWork(expected: { requests: number; observations: number; claims: number }) {
  for (let i = 0; i < 300; i++) {
    const current = await work();
    if (current.requests === expected.requests && current.observations === expected.observations && current.claims === expected.claims) return current;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  expect(await work()).toEqual(expected);
}
async function nonceCount(request: Awaited<ReturnType<typeof signed>>) {
  return Number((await pool.query('SELECT count(*)::int AS count FROM rest_request_nonces WHERE account_id=$1 AND nonce=$2',
    [request.claims.accountId, request.claims.nonce])).rows[0].count);
}
async function waitForLock(pid: number) {
  for (let i = 0; i < 200; i++) {
    const row = (await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
    if (row?.wait_event_type === 'Lock') return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Expected a real PostgreSQL request lock');
}

suite('signed app requests renew their own bounded authority refresh interest', () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 10_000 });
    expect(Math.floor(Number((await admin.query("SELECT current_setting('server_version_num') AS v")).rows[0].v) / 10_000)).toBe(16);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, max: 8, connectionTimeoutMillis: 5000, query_timeout: 10_000,
      options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=5000` });
    await migrate(pool);
    await pool.query('CREATE TABLE wallet_app_refresh_events(id serial PRIMARY KEY,kind text NOT NULL,account_id text NOT NULL)');
    await pool.query('CREATE TABLE wallet_app_refresh_claims(id text PRIMARY KEY,principal_id text NOT NULL)');
    [first, second, unknown] = await Promise.all([start(), start(), start('unknown')]);
  }, 20_000);
  beforeEach(async () => {
    await pool.query('TRUNCATE rest_accounts,rest_wallet_credentials,rest_wallet_enrollments,rest_wallet_ceremonies,rest_wallet_policy,wallet_app_refresh_events,wallet_app_refresh_claims CASCADE');
    await pool.query('UPDATE rest_wallet_authority_refresh_control SET configuration=NULL,window_start_ms=0,starts_in_window=0 WHERE id=1');
    await new PostgresWalletPolicyStore(pool).activate({ expectedRevision: 0, nextRevision: 1, configuration: configuration() });
  });
  afterAll(async () => {
    const results = await Promise.allSettled([...children].map(stop));
    try { await pool?.end(); } finally { if (admin) { try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await admin.end(); } } }
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }, 15_000);

  it('refreshes an idle expired interest and readiness window through a genuine signed app request', async () => {
    const value = await seed({ readyMs: 1000 });
    await new PostgresWalletAuthorityRefreshQueue(pool, { interestMs: 1000 }).request(value.accountId);
    const deadline = Number((await pool.query('SELECT interested_until_ms FROM rest_wallet_authority_refresh_jobs WHERE account_id=$1', [value.accountId])).rows[0].interested_until_ms);
    await waitPast(Math.max(deadline, value.observation.validUntilMs!));
    const request = await signed(value.grant), response = await send(first, request);
    // Admitted on the known identity at once; the observation it asked for lands afterwards.
    expect(response).toMatchObject({ status: 200, body: { kind: 'wallet-app', principalId: walletAppPrincipalId(value.grant) } });
    await untilWork({ requests: 1, observations: 1, claims: 0 }); expect(await nonceCount(request)).toBe(1);
    let current: any;
    for (let i = 0; i < 200; i++) {
      current = (await pool.query('SELECT ready_until_ms,authority_epoch,session_epoch FROM rest_wallet_authority WHERE account_id=$1', [value.accountId])).rows[0];
      if (Number(current.ready_until_ms) > await nowMs()) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(Number(current.ready_until_ms)).toBeGreaterThan(await nowMs());
    expect(current).toMatchObject({ authority_epoch: value.grant.authorityEpoch, session_epoch: value.grant.sessionEpoch });
  });

  it('extends active demand using new signed nonces without granting another identity', async () => {
    const value = await seed(), a = await signed(value.grant);
    expect((await send(first, a)).status).toBe(200);
    const before = (await pool.query('SELECT interested_until_ms FROM rest_wallet_authority_refresh_jobs WHERE account_id=$1', [value.accountId])).rows[0];
    await pool.query('SELECT pg_sleep(0.03)');
    const b = await signed(value.grant); expect((await send(second, b)).status).toBe(200);
    const after = (await pool.query('SELECT interested_until_ms FROM rest_wallet_authority_refresh_jobs WHERE account_id=$1', [value.accountId])).rows[0];
    expect(Number(after.interested_until_ms)).toBeGreaterThan(Number(before.interested_until_ms));
    expect((await work()).requests).toBe(2); expect(await nonceCount(a)).toBe(1); expect(await nonceCount(b)).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS count FROM rest_wallet_app_grants')).rows[0].count).toBe(1);
  });

  it.each(['signature', 'signer', 'origin', 'owner-only', 'grant-revoked', 'grant-expired', 'epoch', 'credential', 'binding', 'policy', 'policy-readded'] as const)(
    'does not schedule provider work for invalid %s', async invalidation => {
      // Whole-second expiry must leave a full second for admission before this
      // test intentionally waits past it. +1 could expire at the next tick.
      const value = await seed({ grantSeconds: invalidation === 'grant-expired' ? 2 : 600 });
      if (invalidation === 'grant-revoked') await pool.query('UPDATE rest_wallet_app_grants SET revoked_at=$2 WHERE id=$1', [value.grant.id, Math.floor(await nowMs() / 1000)]);
      if (invalidation === 'grant-expired') await waitPast(value.grant.expiresAt * 1000);
      if (invalidation === 'epoch') await new PostgresWalletAppGrantStore(pool).advanceEpochs({ accountId: value.accountId, kind: 'logout',
        expectedAuthorityEpoch: value.grant.authorityEpoch, expectedSessionEpoch: value.grant.sessionEpoch });
      if (invalidation === 'credential') await pool.query('UPDATE rest_wallet_credentials SET superseded_at=$2 WHERE account_id=$1', [value.accountId, await nowMs()]);
      if (invalidation === 'binding') await new PostgresSmartAccountRegistry(pool).revoke(value.accountId, value.binding.id);
      if (invalidation === 'policy' || invalidation === 'policy-readded') {
        const policies = new PostgresWalletPolicyStore(pool);
        await policies.activate({ expectedRevision: 1, nextRevision: 2, configuration: configuration(false) });
        if (invalidation === 'policy-readded') await policies.activate({ expectedRevision: 2, nextRevision: 3, configuration: configuration() });
      }
      const request = await signed(value.grant, { ...(invalidation === 'signer' ? { key: otherKey } : {}),
        ...(invalidation === 'owner-only' ? { target: '/fixture/owner' } : {}),
        ...(invalidation === 'origin' ? { browserOrigin: 'https://another.example' } : {}) });
      if (invalidation === 'signature') request.init.headers.set(H.nonce, `0x${'ff'.repeat(32)}`);
      expect([401, 403]).toContain((await send(first, request)).status);
      expect(await work()).toEqual({ requests: 0, observations: 0, claims: 0 }); expect(await nonceCount(request)).toBe(0);
    });

  it('rejects a foreign account grant without waiting on its owner lock or scheduling work', async () => {
    const value = await seed(), other = await seed();
    const request = await signed(value.grant, { changes: { accountId: other.accountId } });
    const lock = await pool.connect(); await lock.query('BEGIN');
    await lock.query('SELECT id FROM rest_accounts WHERE id=$1 FOR UPDATE', [value.accountId]);
    const response = send(first, request);
    let prompt: Awaited<typeof response> | null;
    try { prompt = await Promise.race([response, new Promise<null>(resolve => setTimeout(() => resolve(null), 500))]); }
    finally { await lock.query('ROLLBACK'); lock.release(); await response; }
    expect(prompt!).toMatchObject({ status: 403 });
    expect(await nonceCount(request)).toBe(0); expect(await work()).toEqual({ requests: 0, observations: 0, claims: 0 });
  });

  it('preserves legacy bot requests without requesting wallet readiness work', async () => {
    const value = await seed({ readyMs: 500 }), id = randomUUID(), current = Math.floor(await nowMs() / 1000);
    await new PostgresAccountStore(pool).registerBot({ id, accountId: value.accountId, botAddress: appKey.address,
      scopes: ['read'], label: 'legacy bot fixture', createdAt: current, expiresAt: current + 600, revokedAt: null });
    await waitPast(value.observation.validUntilMs!);
    const request = await signed({ ...value.grant, id }, { browserOrigin: null });
    expect(await send(first, request)).toMatchObject({ status: 200, body: { principalId: `bot:${id}`, isOwner: false } });
    expect(await nonceCount(request)).toBe(1); expect(await work()).toEqual({ requests: 0, observations: 0, claims: 0 });
  });

  it('consumes an identical request once across two HTTP processes before scheduling any work', async () => {
    const value = await seed({ readyMs: 500 }); await waitPast(value.observation.validUntilMs!);
    const request = await signed(value.grant, { barrier: 'after-nonce-commit' }), barrier = message(first.child, 'barrier');
    const accepted = send(first, request); expect((await barrier).boundary).toBe('after-nonce-commit');
    expect(await nonceCount(request)).toBe(1); expect(await work()).toEqual({ requests: 0, observations: 0, claims: 0 });
    const replay = await send(second, request); expect(replay).toMatchObject({ status: 409, body: { code: 'REPLAY' } });
    first.child.send('release'); expect((await accepted).status).toBe(200);
    await untilWork({ requests: 1, observations: 1, claims: 0 });
  });

  it('admits on the known identity while its observation is unavailable, spending the nonce once', async () => {
    const value = await seed({ readyMs: 500 }); await waitPast(value.observation.validUntilMs!);
    const claimId = randomUUID(), request = await signed(value.grant, { claimId });
    expect((await send(unknown, request)).status).toBe(200); expect(await nonceCount(request)).toBe(1);
    await untilWork({ requests: 1, observations: 1, claims: 1 });
    expect(await send(first, request)).toMatchObject({ status: 409, body: { code: 'REPLAY' } });
    expect(await work()).toEqual({ requests: 1, observations: 1, claims: 1 });
    // The unavailable observation left readiness unknown: identity is still the last verified one, and the next request is refused until a verified observation lands.
    let readiness = '';
    for (let i = 0; i < 200 && readiness !== 'unknown'; i++) {
      readiness = (await pool.query("SELECT snapshot->>'readiness' AS readiness FROM rest_wallet_authority WHERE account_id=$1", [value.accountId])).rows[0].readiness;
      if (readiness !== 'unknown') await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(readiness).toBe('unknown');
    expect((await send(first, await signed(value.grant, { claimId: randomUUID() }))).status).toBe(503);
  });

  it('admits on the known identity across a queue admission outage without running an observer', async () => {
    const value = await seed({ readyMs: 500 }), process = await start('queue-error'); await waitPast(value.observation.validUntilMs!);
    const request = await signed(value.grant, { claimId: randomUUID() });
    expect((await send(process, request)).status).toBe(200); expect(await nonceCount(request)).toBe(1);
    expect(await work()).toEqual({ requests: 1, observations: 0, claims: 1 });
    expect(await send(second, request)).toMatchObject({ status: 409, body: { code: 'REPLAY' } });
    expect(await work()).toEqual({ requests: 1, observations: 0, claims: 1 }); await stop(process.child);
  });

  it('admits still-fresh authority through a queue outage after the full final guard and spent nonce', async () => {
    const value = await seed(), process = await start('queue-error'), request = await signed(value.grant);
    try {
      expect(await send(process, request)).toMatchObject({ status: 200, body: { principalId: walletAppPrincipalId(value.grant) } });
      expect(await nonceCount(request)).toBe(1); expect(await work()).toEqual({ requests: 1, observations: 0, claims: 0 });
      expect(await send(second, request)).toMatchObject({ status: 409, body: { code: 'REPLAY' } });
      expect(await work()).toEqual({ requests: 1, observations: 0, claims: 0 });
    } finally { await stop(process.child); }
  });

  it('rejects a final admission resolving after the elapsed deadline before its timer callback runs', async () => {
    const value = await seed(), request = await signed(value.grant);
    const nativeNow = performance.now.bind(performance);
    let elapsedOffset = 0, delayedFinalCommit = false;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => nativeNow() + elapsedOffset);
    const connection = new Proxy(pool, { get(current, property) {
      if (property === 'connect') return async () => {
        const client = await current.connect(); let finalAdmission = false;
        return new Proxy(client, { get(value, key) {
          if (key === 'query') return async (...args: any[]) => {
            const result = await (value.query.bind(value) as any)(...args);
            const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
            if (sql.startsWith('SELECT expires_at FROM rest_request_nonces')) finalAdmission = true;
            if (sql === 'COMMIT' && finalAdmission) {
              // Model a delayed event-loop turn without sleeping ten real seconds. The full SQL
              // guard has succeeded, but its result reaches the caller after the monotonic budget.
              elapsedOffset = 10_001; delayedFinalCommit = true;
            }
            return result;
          };
          const item = Reflect.get(value, key); return typeof item === 'function' ? item.bind(value) : item;
        } });
      };
      const item = Reflect.get(current, property); return typeof item === 'function' ? item.bind(current) : item;
    } });
    const refresh = { request: vi.fn(async () => ({})), tick: vi.fn(async () => {}) };
    const auth = createRestAuth({ store: new PostgresAccountStore(connection, { walletRefresh: refresh }), audience });
    try {
      const outcome = await auth.authenticate({ headers: request.init.headers, body: new Uint8Array(), method: 'GET',
        requestTarget: request.target, contentType: '', signal: AbortSignal.timeout(12_000) }, ['read'])
        .then(() => ({ status: 200 }), error => ({ status: error.status, code: error.code }));
      expect(delayedFinalCommit).toBe(true);
      expect(outcome).toEqual({ status: 503, code: 'WALLET_AUTHORITY_CHECKING' });
      expect(refresh.request).toHaveBeenCalledExactlyOnceWith(value.accountId);
      expect(await nonceCount(request)).toBe(1);
    } finally { clock.mockRestore(); }
  });

  it('rejects request expiry behind an account lock before consuming or scheduling its nonce', async () => {
    const value = await seed(), request = await signed(value.grant, { changes: { expiresAt: Math.floor(await nowMs() / 1000) + 2 } });
    const lock = await pool.connect(); await lock.query('BEGIN');
    await lock.query('SELECT id FROM rest_accounts WHERE id=$1 FOR UPDATE', [value.accountId]);
    const response = send(first, request);
    try { await waitForLock(first.backendPid); await waitPast(request.claims.expiresAt * 1000); }
    finally { await lock.query('ROLLBACK'); lock.release(); }
    expect((await response).status).toBe(401); expect(await nonceCount(request)).toBe(0);
    expect(await work()).toEqual({ requests: 0, observations: 0, claims: 0 });
  });

  it.each(['request-expired', 'grant-revoked', 'logout', 'credential-superseded', 'binding-revoked', 'policy-readded'] as const)(
    'returns no principal when %s happens after its durable scheduling claim', async invalidation => {
      const value = await seed({ readyMs: 500 }), process = await start();
      await waitPast(value.observation.validUntilMs!);
      const request = await signed(value.grant, { claimId: randomUUID(), barrier: 'after-nonce-commit', ...(invalidation === 'request-expired'
        ? { changes: { expiresAt: Math.floor(await nowMs() / 1000) + 2 } } : {}) });
      const barrier = message(process.child, 'barrier'), response = send(process, request);
      expect((await barrier).boundary).toBe('after-nonce-commit'); expect(await nonceCount(request)).toBe(1);
      if (invalidation === 'request-expired') await waitPast(request.claims.expiresAt * 1000);
      if (invalidation === 'grant-revoked') await pool.query('UPDATE rest_wallet_app_grants SET revoked_at=$2 WHERE id=$1', [value.grant.id, Math.floor(await nowMs() / 1000)]);
      if (invalidation === 'logout') await new PostgresWalletAppGrantStore(pool).advanceEpochs({ accountId: value.accountId, kind: 'logout',
        expectedAuthorityEpoch: value.grant.authorityEpoch, expectedSessionEpoch: value.grant.sessionEpoch });
      if (invalidation === 'credential-superseded') await pool.query('UPDATE rest_wallet_credentials SET superseded_at=$2 WHERE account_id=$1',
        [value.accountId, await nowMs()]);
      if (invalidation === 'binding-revoked') await new PostgresSmartAccountRegistry(pool).revoke(value.accountId, value.binding.id);
      if (invalidation === 'policy-readded') {
        const policies = new PostgresWalletPolicyStore(pool);
        await policies.activate({ expectedRevision: 1, nextRevision: 2, configuration: configuration(false) });
        await policies.activate({ expectedRevision: 2, nextRevision: 3, configuration: configuration() });
      }
      process.child.send('release');
      expect((await response).status).toBe(invalidation === 'request-expired' ? 401 : 403);
      expect((await work()).claims).toBe(0); expect(await nonceCount(request)).toBe(1); await stop(process.child);
    });

  it('does not requeue an attempt lost after nonce commit when its process crashes', async () => {
    const value = await seed({ readyMs: 500 }), process = await start(); await waitPast(value.observation.validUntilMs!);
    const request = await signed(value.grant, { barrier: 'after-nonce-commit' }), barrier = message(process.child, 'barrier');
    const response = send(process, request).catch(() => null); expect((await barrier).boundary).toBe('after-nonce-commit');
    expect(await nonceCount(request)).toBe(1); await stop(process.child); await response;
    expect(await send(second, request)).toMatchObject({ status: 409, body: { code: 'REPLAY' } });
    expect(await work()).toEqual({ requests: 0, observations: 0, claims: 0 });
    expect((await send(second, await signed(value.grant))).status).toBe(200);
    await untilWork({ requests: 1, observations: 1, claims: 0 });
  });
});
