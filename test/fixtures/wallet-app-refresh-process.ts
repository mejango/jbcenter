// Local signed-request integration only. Authority observations below are explicitly synthetic.
import { createServer } from "node:http";
import { Pool } from "pg";
import { keccak256, toHex } from "viem";
import { createRestAuth } from "../../src/rest/auth/service.js";
import { assertRestActorActive, PostgresAccountStore } from "../../src/rest/auth/postgres.js";
import { RestAuthError } from "../../src/rest/auth/store.js";
import { RestError } from "../../src/rest/core.js";
import { walletAuthorityContextDigest, walletAuthorityExpectedAnchor, walletAuthorityMaximumAgeMs,
  type WalletAuthorityContext, type WalletAuthorityObservation } from "../../src/rest/wallet/authority.js";
import { PostgresWalletAuthorityStore } from "../../src/rest/wallet/authorityPostgres.js";
import { createWalletAuthorityService } from "../../src/rest/wallet/authorityService.js";
import { createWalletAuthorityRefresh } from "../../src/rest/wallet/authorityRefresh.js";
import { PostgresWalletAuthorityRefreshQueue } from "../../src/rest/wallet/authorityRefreshPostgres.js";

async function barrier(boundary: string): Promise<void> {
  if (!process.connected || !process.send) throw new Error("Fixture parent is unavailable.");
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      process.off("message", release);
      process.off("disconnect", disconnected);
      if (error) reject(error); else resolve();
    };
    const release = (value: unknown) => { if (value === "release") finish(); };
    const disconnected = () => finish(new Error("Fixture parent disconnected."));
    const timer = setTimeout(() => finish(new Error("Fixture barrier timed out.")), 10_000);
    process.on("message", release);
    process.once("disconnect", disconnected);
    process.send!({ kind: "barrier", boundary }, error => { if (error) finish(new Error("Fixture IPC failed.")); });
  });
}

async function main(): Promise<void> {
  const schema = process.env.WALLET_APP_REFRESH_TEST_SCHEMA;
  const mode = process.env.WALLET_APP_REFRESH_TEST_MODE ?? "fresh";
  const observationBarrier = process.env.WALLET_APP_REFRESH_TEST_BARRIER;
  if (!schema || !/^wallet_app_refresh_[a-f0-9]+$/.test(schema) || !process.env.TEST_DATABASE_URL || !process.connected
    || !["fresh", "unknown", "queue-error"].includes(mode) || (observationBarrier !== undefined && observationBarrier !== "observe")) {
    throw new Error("Disposable fixture configuration is required.");
  }
  const queueOptions: unknown = JSON.parse(process.env.WALLET_APP_REFRESH_TEST_QUEUE_OPTIONS ?? "{}");
  if (!queueOptions || typeof queueOptions !== "object" || Array.isArray(queueOptions)) throw new Error("Invalid queue options.");
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1,
    connectionTimeoutMillis: 5_000, query_timeout: 10_000,
    options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=15000` });
  const queue = new PostgresWalletAuthorityRefreshQueue(pool, { interestMs: 1000, ...queueOptions });
  const event = async (kind: string, accountId: string) => {
    await pool.query("INSERT INTO wallet_app_refresh_events(kind,account_id) VALUES($1,$2)", [kind, accountId]);
  };
  const service = createWalletAuthorityService({ store: new PostgresWalletAuthorityStore(pool), chain: {
    async observe(context: WalletAuthorityContext): Promise<WalletAuthorityObservation> {
      await event("observe", context.accountId);
      if (observationBarrier === "observe") await barrier("observe");
      const latest = context.prior?.latestObservation;
      if (!latest || !context.prior?.identity) throw new Error("Synthetic observer requires initialized authority.");
      const observedAtMs = Number((await pool.query<{ now: string }>(
        "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now")).rows[0]!.now);
      const expected = walletAuthorityExpectedAnchor(context);
      const base = { ...structuredClone(latest), contextDigest: walletAuthorityContextDigest(context), observedAtMs };
      if (mode === "unknown") return { ...base, validUntilMs: null, head: null, identity: null, eligibility: null,
        priorAnchor: { status: expected ? "unavailable" : "none", expected, observed: null }, reason: "fixture-provider-unavailable" };
      const blockNumber = (BigInt(context.prior.highestObservedBlock ?? "0") + 1n).toString();
      return { ...base, validUntilMs: observedAtMs + walletAuthorityMaximumAgeMs,
        head: { chainId: 8453, blockNumber, blockHash: keccak256(toHex(`canonical-test-block-${blockNumber}`)),
          timestamp: String(Math.floor(observedAtMs / 1000)), source: "onchain" },
        priorAnchor: { status: expected ? "same" : "none", expected, observed: expected ? structuredClone(expected) : null },
        identity: structuredClone(context.prior.identity), eligibility: "matched", reason: null };
    },
  } });
  // Construct outside HTTP context and never start maintenance. Only the real auth hook requests/ticks work.
  const refresh = createWalletAuthorityRefresh({ service, concurrency: 1, attemptTimeoutMs: 10_000, shutdownTimeoutMs: 500,
    queue: {
      async request(accountId) {
        await event("request", accountId);
        if (mode === "queue-error") throw new RestError(503, "FIXTURE_QUEUE_UNAVAILABLE", "Fixture refresh queue is unavailable.");
        return queue.request(accountId);
      },
      claim: queue.claim.bind(queue), complete: queue.complete.bind(queue), stats: queue.stats.bind(queue),
    } });
  let stopping = false;
  const stop = (code = 0) => {
    if (stopping) return;
    stopping = true;
    server.closeAllConnections(); server.close();
    const deadline = setTimeout(() => process.exit(code), 1_000);
    void refresh.stop().then(() => pool.end()).catch(() => {}).finally(() => {
      clearTimeout(deadline); process.exitCode = code;
      if (process.connected) process.disconnect();
    });
  };
  pool.on("error", () => stop(1));
  const server = createServer(async (request, response) => {
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers))
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(",") : value);
      const requestedBarrier = headers.get("x-fixture-barrier");
      if (requestedBarrier !== null && requestedBarrier !== "after-nonce-commit")
        throw new RestError(400, "FIXTURE_BARRIER", "Unknown fixture barrier.");
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 8192) throw new RestError(413, "FIXTURE_TOO_LARGE", "Fixture request is too large.");
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks), target = request.url ?? "/";
      if (!["/api/v1/accounts/me", "/fixture/claim", "/fixture/owner"].includes(target))
        throw new RestError(404, "NOT_FOUND", "Unknown fixture route.");
      let paused = false;
      const connection = new Proxy(pool, { get(current, property) {
        if (property === "connect") return async () => {
          const client = await current.connect();
          let wroteNonce = false;
          return new Proxy(client, { get(value, key) {
            if (key === "query") return async (...args: any[]) => {
              const result = await (value.query.bind(value) as any)(...args);
              const sql = (typeof args[0] === "string" ? args[0] : args[0]?.text ?? "").trim();
              if (/^BEGIN;?$/i.test(sql) || /^ROLLBACK;?$/i.test(sql)) wroteNonce = false;
              if (/^INSERT\s+INTO\s+rest_request_nonces\b/i.test(sql) && result.rowCount) wroteNonce = true;
              if (/^COMMIT;?$/i.test(sql)) {
                const committedNonce = wroteNonce; wroteNonce = false;
                if (!paused && committedNonce && requestedBarrier === "after-nonce-commit") {
                  paused = true; await barrier("after-nonce-commit");
                }
              }
              return result;
            };
            const item = Reflect.get(value, key);
            return typeof item === "function" ? item.bind(value) : item;
          } });
        };
        const value = Reflect.get(current, property);
        return typeof value === "function" ? value.bind(current) : value;
      } });
      const auth = createRestAuth({ store: new PostgresAccountStore(connection,
        { maxNoncesPerAccount: 1000, ...{ walletRefresh: { request: refresh.request, tick: refresh.tick } } }), audience: "https://juicebox.center" });
      const principal = await auth.authenticate({ headers, body, method: request.method ?? "GET", requestTarget: target,
        contentType: headers.get("content-type") ?? "", signal: AbortSignal.timeout(15_000) },
      [target === "/fixture/claim" ? "plan" : "read"], target === "/fixture/owner");
      let result: unknown = { principalId: principal.principalId, grantId: principal.grantId, kind: principal.kind,
        isOwner: principal.isOwner, scopes: principal.scopes, walletApp: principal.walletApp };
      if (target === "/fixture/claim") {
        const input = JSON.parse(body.toString("utf8"));
        if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.id !== "string"
          || !/^[a-f0-9-]{36}$/.test(input.id) || Object.keys(input).length !== 1)
          throw new RestError(400, "INVALID_FIXTURE", "Invalid fixture claim.");
        const client = await pool.connect(), actor = { accountId: principal.account.id, principalId: principal.principalId };
        try {
          await client.query("BEGIN");
          await assertRestActorActive(client, actor, ["plan"], Math.floor(Date.now() / 1000));
          await client.query("INSERT INTO wallet_app_refresh_claims(id,principal_id) VALUES($1,$2)", [input.id, actor.principalId]);
          await assertRestActorActive(client, actor, ["plan"], Math.floor(Date.now() / 1000));
          await client.query("COMMIT"); result = { id: input.id, principalId: actor.principalId };
        } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
        finally { client.release(); }
      }
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(result));
    } catch (error) {
      const known = error instanceof RestAuthError || error instanceof RestError;
      const databaseCode = error && typeof error === "object" && "code" in error && typeof error.code === "string"
        && ["23505", "23514", "23503"].includes(error.code) ? error.code : null;
      response.writeHead(known ? error.status : databaseCode ? 409 : 500, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: known ? error.code : databaseCode ?? "FIXTURE_FAILURE" }));
    }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 5_000; server.keepAliveTimeout = 1_000;
  process.once("SIGTERM", () => stop()); process.once("SIGINT", () => stop()); process.once("disconnect", () => stop());
  try {
    const backendPid = (await pool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture listener unavailable.");
    process.send!({ kind: "ready", port: address.port, pid: process.pid, backendPid }, error => { if (error) stop(1); });
  } catch (error) { stop(1); throw error; }
}

void main().catch(() => {
  if (process.connected) process.send?.({ kind: "startup-error", code: "FIXTURE_STARTUP_ERROR" }, () => {});
  process.stderr.write("Wallet app refresh fixture failed to start.\n"); process.exitCode = 1;
});
