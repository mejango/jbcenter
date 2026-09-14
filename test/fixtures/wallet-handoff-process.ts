// Disposable local test service. Trusted session setup and crash barriers are never production routes.
import { createServer, type IncomingMessage } from "node:http";
import { Pool, type PoolClient } from "pg";
import { RestAuthError } from "../../src/rest/auth/store.js";
import { RestError } from "../../src/rest/core.js";
import type { WalletAppGrant, WalletAppGrantAdmission } from "../../src/rest/wallet/appGrants.js";
import { PostgresWalletAppGrantStore } from "../../src/rest/wallet/appGrantsPostgres.js";
import { PostgresWalletHandoffStore, type WalletHandoffStoreOptions } from "../../src/rest/wallet/handoffPostgres.js";

// Shorten only the requested expiry. The real store still validates and persists the complete grant.
class ExpiringTestGrantStore extends PostgresWalletAppGrantStore {
  constructor(pool: Pool, private readonly lifetimeSeconds: number) { super(pool); }
  override async insertInTransaction(client: PoolClient, input: WalletAppGrantAdmission): Promise<WalletAppGrant> {
    const now = Number((await client.query<{ now: string }>(
      "SELECT floor(extract(epoch FROM clock_timestamp()))::bigint AS now")).rows[0]!.now);
    return super.insertInTransaction(client, { ...input, expiresAt: Math.min(input.expiresAt, now + this.lifetimeSeconds) });
  }
}

async function requestBody(request: IncomingMessage): Promise<Record<string, any>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > 32_768) throw new RestError(413, "FIXTURE_TOO_LARGE", "Fixture request is too large.");
    chunks.push(chunk);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new RestError(400, "FIXTURE_BODY", "Fixture request must be a JSON object."); }
}

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
  const schema = process.env.WALLET_HANDOFF_TEST_SCHEMA;
  if (!schema || !/^wallet_handoff_[a-f0-9]+$/.test(schema)) throw new Error("A disposable handoff schema is required.");
  if (!process.env.TEST_DATABASE_URL || !process.connected) throw new Error("Fixture database and parent IPC are required.");
  const configured: unknown = JSON.parse(process.env.WALLET_HANDOFF_TEST_OPTIONS ?? "{}");
  const allowedOptions = ["codeLifetimeMs", "receiptRetentionMs", "maxRecords", "maxOriginRecords", "grantLifetimeSeconds"];
  if (!configured || typeof configured !== "object" || Array.isArray(configured)
    || Object.entries(configured).some(([key, value]) => !allowedOptions.includes(key)
      || typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error("Invalid handoff fixture options.");
  }
  const { grantLifetimeSeconds, ...storeOptions } = configured as Record<string, number>;
  const options: WalletHandoffStoreOptions = {
    ...storeOptions, issuer: "https://wallet.juicebox.center", audience: "https://juicebox.center",
  };
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1,
    connectionTimeoutMillis: 5_000, query_timeout: 10_000,
    options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=10000 -c idle_in_transaction_session_timeout=15000` });
  let stopping = false;
  const stop = (code = 0) => {
    if (stopping) return;
    stopping = true;
    server.closeAllConnections();
    server.close();
    const deadline = setTimeout(() => process.exit(code), 1_000);
    void pool.end().catch(() => {}).finally(() => {
      clearTimeout(deadline);
      process.exitCode = code;
      if (process.connected) process.disconnect();
    });
  };
  pool.on("error", () => stop(1));
  const server = createServer(async (request, response) => {
    try {
      const body = await requestBody(request);
      if (body.barrier !== undefined && !["after-grant-write", "after-code-write", "after-receipt-write", "after-commit"].includes(body.barrier)) {
        throw new RestError(400, "FIXTURE_BARRIER", "Unknown fixture barrier.");
      }
      let paused = false;
      const wrapQuery = (query: (...args: any[]) => any) => async (...args: any[]) => {
        const result = await query(...args);
        const sql = (typeof args[0] === "string" ? args[0] : args[0]?.text ?? "").trim();
        if (!paused && ((body.barrier === "after-grant-write" && /^INSERT\s+INTO\s+rest_wallet_app_grants\b/i.test(sql))
          || (body.barrier === "after-code-write" && /^UPDATE\s+rest_wallet_handoffs\s+SET\b/i.test(sql) && /\bcode_hash\s*=/i.test(sql))
          || (body.barrier === "after-receipt-write" && /^UPDATE\s+rest_wallet_handoffs\s+SET\b/i.test(sql) && /\bgrant_document\s*=/i.test(sql))
          || (body.barrier === "after-commit" && /^COMMIT;?$/i.test(sql)))) {
          paused = true;
          await barrier(body.barrier);
        }
        return result;
      };
      const connection = new Proxy(pool, { get(target, property) {
        if (property === "query") return wrapQuery(target.query.bind(target));
        if (property === "connect") return async () => {
          const client = await target.connect();
          return new Proxy(client, { get(current, key) {
            if (key === "query") return wrapQuery(current.query.bind(current));
            const value = Reflect.get(current, key);
            return typeof value === "function" ? value.bind(current) : value;
          } });
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      const store = new PostgresWalletHandoffStore(connection, { ...options,
        ...(grantLifetimeSeconds === undefined ? {} : { grantStore: new ExpiringTestGrantStore(connection, grantLifetimeSeconds) }) });
      const origin = typeof request.headers.origin === "string" ? request.headers.origin : "";
      let result: unknown;
      if (body.action === "prepare") result = await store.prepare(body.input, origin);
      else if (body.action === "get") result = await store.getIntent(body.id);
      // The parent supplies a session created by a completed login, as the trusted central HTTP handler would.
      else if (body.action === "issue") result = await store.issue(body.intentId, body.sessionId);
      else if (body.action === "identify-exchange") result = await store.identifyExchange(body.input, origin);
      else if (body.action === "exchange") result = await store.exchange(body.input, origin);
      else if (body.action === "cleanup") result = await store.cleanup(body.limit);
      else throw new RestError(400, "FIXTURE_ACTION", "Unknown fixture action.");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result ?? null));
    } catch (error) {
      const typed = error instanceof RestError || error instanceof RestAuthError;
      const databaseCode = error && typeof error === "object" && "code" in error && typeof error.code === "string"
        && ["23505", "23514", "23503"].includes(error.code) ? error.code : null;
      response.writeHead(typed ? error.status : databaseCode ? 409 : 500, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: typed ? error.code : databaseCode ?? "FIXTURE_ERROR" }));
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  process.once("SIGTERM", () => stop());
  process.once("SIGINT", () => stop());
  process.once("disconnect", () => stop());
  try {
    const backendPid = (await pool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture listener did not start.");
    if (process.connected) process.send?.({ kind: "ready", port: address.port, pid: process.pid, backendPid }, error => { if (error) stop(1); });
  } catch (error) { stop(1); throw error; }
}

void main().catch(() => {
  if (process.connected) process.send?.({ kind: "startup-error", code: "FIXTURE_STARTUP_ERROR" }, () => {});
  process.stderr.write("Wallet handoff fixture failed to start.\n");
  process.exitCode = 1;
});
