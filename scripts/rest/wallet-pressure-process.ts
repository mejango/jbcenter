// Isolated diagnostic HTTP service. No RPC transport or production routes are exposed.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Pool } from 'pg';
import { keccak256, toHex } from 'viem';
import { PostgresStore } from '../../src/db/postgres.js';
import { createRestAuth } from '../../src/rest/auth/service.js';
import { assertRestActorActive, PostgresAccountStore } from '../../src/rest/auth/postgres.js';
import { RestAuthError } from '../../src/rest/auth/store.js';
import { RestError } from '../../src/rest/core.js';
import { REST_LIMITS } from '../../src/rest/http.js';
import { walletAuthorityContextDigest, walletAuthorityExpectedAnchor, walletAuthorityMaximumAgeMs,
  type WalletAuthorityContext, type WalletAuthorityObservation } from '../../src/rest/wallet/authority.js';
import { PostgresWalletAuthorityStore } from '../../src/rest/wallet/authorityPostgres.js';
import { createWalletAuthorityService } from '../../src/rest/wallet/authorityService.js';
import { createWalletAuthorityRefresh } from '../../src/rest/wallet/authorityRefresh.js';
import { PostgresWalletAuthorityRefreshQueue } from '../../src/rest/wallet/authorityRefreshPostgres.js';
import { createHistogram } from './wallet-pressure-schedule.js';

const audience = 'https://wallet-pressure.example';
const origins = ['https://pressure-one.example', 'https://pressure-two.example'];
async function main() {
  const schema = process.env.WALLET_PRESSURE_SCHEMA, poolMax = Number(process.env.WALLET_PRESSURE_POOL_MAX);
  const lifetime = Number(process.env.WALLET_PRESSURE_LIFETIME_MS);
  if (!schema || !/^wallet_pressure_[a-f0-9]+$/.test(schema) || !process.connected || !process.env.TEST_DATABASE_URL
    || !Number.isInteger(poolMax) || poolMax < 1 || poolMax > 10 || !Number.isInteger(lifetime) || lifetime < 1000 || lifetime > 7_290_000)
    throw new Error('Invalid isolated pressure fixture configuration.');
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: poolMax,
    connectionTimeoutMillis: 5000, query_timeout: 12_000,
    options: `-c search_path=${schema} -c application_name=${schema} -c statement_timeout=10000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=10000` });
  const routeContext = new AsyncLocalStorage<string>(), metrics = new Map<string, ReturnType<typeof metric>>();
  function metric() { return { requests: 0, admitted: 0, completed: 0, queries: 0,
    poolWait: createHistogram(), queryTime: createHistogram(), lockingStatement: createHistogram() }; }
  function currentMetric() { const key = routeContext.getStore() ?? 'worker'; let value = metrics.get(key); if (!value) metrics.set(key, value = metric()); return value; }
  let maxWaiting = 0, active = 0, maxActive = 0;
  const measuredPool = new Proxy(pool, { get(target, property) {
    if (property === 'query') return async (...args: any[]) => {
      const client = await measuredPool.connect();
      try { return await (client.query.bind(client) as any)(...args); } finally { client.release(); }
    };
    if (property === 'connect') return async () => {
      const value = currentMetric(), started = performance.now();
      maxWaiting = Math.max(maxWaiting, pool.waitingCount + (pool.idleCount ? 0 : 1));
      const client = await target.connect().finally(() => value.poolWait.record(performance.now() - started));
      return new Proxy(client, { get(connection, key) {
        if (key === 'query') return async (...args: any[]) => {
          const began = performance.now(); value.queries++;
          try { return await (connection.query.bind(connection) as any)(...args); }
          finally {
            value.queryTime.record(performance.now() - began);
            const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
            if (/FOR (?:UPDATE|SHARE)/i.test(sql)) value.lockingStatement.record(performance.now() - began);
          }
        };
        const item = Reflect.get(connection, key); return typeof item === 'function' ? item.bind(connection) : item;
      } });
    };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  let observations = 0;
  const queue = new PostgresWalletAuthorityRefreshQueue(measuredPool);
  const service = createWalletAuthorityService({ store: new PostgresWalletAuthorityStore(measuredPool), chain: {
    async observe(context: WalletAuthorityContext): Promise<WalletAuthorityObservation> {
      observations++;
      const prior = context.prior, latest = prior?.latestObservation;
      if (!latest || !prior.identity) throw new Error('Synthetic fixture requires initialized authority.');
      const observedAtMs = Number((await measuredPool.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now')).rows[0].now);
      const expected = walletAuthorityExpectedAnchor(context), blockNumber = (BigInt(prior.highestObservedBlock ?? '0') + 1n).toString();
      return { ...structuredClone(latest), contextDigest: walletAuthorityContextDigest(context), observedAtMs,
        validUntilMs: observedAtMs + walletAuthorityMaximumAgeMs,
        head: { chainId: 8453, blockNumber, blockHash: keccak256(toHex(`pressure-synthetic-block-${blockNumber}`)),
          timestamp: String(Math.floor(observedAtMs / 1000)), source: 'onchain' },
        priorAnchor: { status: expected ? 'same' : 'none', expected, observed: expected ? structuredClone(expected) : null },
        identity: structuredClone(prior.identity), eligibility: 'matched', reason: null };
    },
  } });
  const refresh = createWalletAuthorityRefresh({ queue, service, attemptTimeoutMs: 10_000 });
  const accounts = new PostgresAccountStore(measuredPool, { walletRefresh: refresh });
  const auth = createRestAuth({ store: accounts, audience }), quota = new PostgresStore(measuredPool);
  const loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable();
  let stopping = false, host = '';
  const server = createServer((request, response) => {
    const origin = request.headers.origin, app = origins.indexOf(origin ?? '');
    const route = request.url === '/read' ? 'read' : request.url === '/diagnostic-claim' ? 'diagnostic-claim' : 'invalid';
    void routeContext.run(`${app}:${route}`, async () => {
      const value = currentMetric(); value.requests++;
      const deadline = setTimeout(() => request.destroy(), 15_000); deadline.unref();
      let counted = false;
      try {
        if (request.headers.host !== host || app < 0 || route === 'invalid') throw new RestError(400, 'PRESSURE_BOUNDARY', 'Invalid local fixture request.');
        if (active >= REST_LIMITS.maxConcurrentRequests) throw new RestError(429, 'SERVICE_BUSY', 'Diagnostic service is busy.');
        active++; counted = true; maxActive = Math.max(maxActive, active);
        if (!(await quota.consumeRequest('rest:site', REST_LIMITS.siteRequestsPerMinute, 60)).allowed)
          throw new RestError(429, 'RATE_LIMITED', 'Site budget is spent.');
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of request) {
          size += chunk.length; if (size > 8192) throw new RestError(413, 'PRESSURE_BODY_LIMIT', 'Diagnostic body is too large.');
          chunks.push(Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks), headers = new Headers();
        for (const [key, item] of Object.entries(request.headers)) if (item !== undefined) headers.set(key, Array.isArray(item) ? item.join(',') : item);
        if (request.method !== (route === 'read' ? 'GET' : 'POST') || (route === 'read' && body.length))
          throw new RestError(400, 'PRESSURE_METHOD', 'Invalid diagnostic method.');
        const principal = await auth.authenticate({ headers, body, method: request.method, requestTarget: request.url!,
          contentType: headers.get('content-type') ?? '', signal: AbortSignal.timeout(12_000) }, [route === 'read' ? 'read' : 'plan']);
        if (principal.kind !== 'wallet-app') throw new RestError(403, 'PRESSURE_IDENTITY', 'Expected an app fixture identity.');
        value.admitted++; response.setHeader('x-wallet-pressure-admitted', '1');
        if (!(await quota.consumeRequest(`rest:account:${principal.account.id}:app:${principal.walletApp.origin}`, REST_LIMITS.requestsPerMinute, 60)).allowed)
          throw new RestError(429, 'RATE_LIMITED', 'Account application budget is spent.');
        if (route === 'read') {
          const account = await accounts.getAccount(principal.account.id);
          if (!account || account.id !== principal.account.id) throw new Error('Account read failed.');
          response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true, kind: 'read', accountId: account.id }));
        } else {
          const input = JSON.parse(body.toString('utf8'));
          if (!input || typeof input !== 'object' || Object.keys(input).length !== 1 || !/^[a-f0-9-]{36}$/.test(input.id)
            || principal.idempotencyKey !== input.id) throw new RestError(400, 'PRESSURE_CLAIM', 'Invalid diagnostic claim.');
          const client = await measuredPool.connect(), actor = { accountId: principal.account.id, principalId: principal.principalId };
          try {
            await client.query('BEGIN'); await assertRestActorActive(client, actor, ['plan'], Math.floor(Date.now() / 1000));
            await client.query('INSERT INTO wallet_pressure_claims(id,account_id,principal_id,app) VALUES($1,$2,$3,$4)',
              [input.id, actor.accountId, actor.principalId, app]);
            await assertRestActorActive(client, actor, ['plan'], Math.floor(Date.now() / 1000)); await client.query('COMMIT');
          } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
          response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true, kind: 'diagnostic-claim', id: input.id }));
        }
        value.completed++;
      } catch (error) {
        const known = error instanceof RestAuthError || error instanceof RestError;
        if (!response.headersSent) response.writeHead(known ? error.status : 503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ code: known ? error.code : 'PRESSURE_UNAVAILABLE' }));
      } finally { clearTimeout(deadline); if (counted) active--; }
    }).catch(() => response.destroy());
  });
  server.requestTimeout = 15_000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000;
  const hardStop = setTimeout(() => stop(), lifetime); hardStop.unref();
  function stop() {
    if (stopping) return; stopping = true; clearTimeout(hardStop); loop.disable();
    server.closeAllConnections(); server.close();
    const kill = setTimeout(() => process.exit(1), 7000); kill.unref();
    void refresh.stop().then(() => pool.end()).catch(() => { process.exitCode = 1; }).finally(() => {
      clearTimeout(kill); if (process.connected) process.disconnect();
    });
  }
  pool.on('error', stop); process.once('SIGTERM', stop); process.once('SIGINT', stop); process.once('disconnect', stop);
  process.on('message', message => {
    if (message === 'stop') stop();
    if (message === 'snapshot' && process.connected) process.send?.({ kind: 'snapshot', pid: process.pid,
      cumulativeSinceStartup: true,
      memory: process.memoryUsage(), cpu: process.cpuUsage(), active, maxActive, maxWaiting, observations,
      eventLoopDelayMs: { p95: loop.percentile(95) / 1e6, p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 },
      metrics: Object.fromEntries([...metrics].map(([key, value]) => [key, { requests: value.requests, admitted: value.admitted,
        completed: value.completed, queries: value.queries, poolWaitMs: value.poolWait.snapshot(), queryMs: value.queryTime.snapshot(),
        lockingStatementMs: value.lockingStatement.snapshot() }])) });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture listener.');
  host = `127.0.0.1:${address.port}`; refresh.start();
  process.send?.({ kind: 'ready', port: address.port, pid: process.pid });
}
void main().catch(() => { process.stderr.write('Local wallet pressure service startup failed.\n'); process.exit(1); });
