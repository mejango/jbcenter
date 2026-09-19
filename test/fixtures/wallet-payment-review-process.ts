// Disposable local internal-store service; test IPC barriers are never production routes.
import { createServer, type IncomingMessage } from "node:http";
import { Pool } from "pg";
import { RestError } from "../../src/rest/core.js";
import { RestAuthError } from "../../src/rest/auth/store.js";
import { PostgresWalletPaymentReviewStore } from "../../src/rest/wallet/paymentReviewsPostgres.js";
import { walletPaymentFixtureManifest as manifest } from "./wallet-payment-setup.js";

async function bodyOf(request: IncomingMessage): Promise<Record<string, any>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const input of request) {
    const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input);
    size += chunk.length;
    if (size > 65_536) throw new RestError(413, "FIXTURE_TOO_LARGE", "Fixture request exceeds its bound.");
    chunks.push(chunk);
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RestError(400, "FIXTURE_BODY", "Invalid fixture body.");
  return body as Record<string, any>;
}
async function barrier(stage: string, backendPid: number): Promise<void> {
  if (!process.connected || !process.send) throw new Error("Fixture parent is unavailable.");
  await new Promise<void>((resolve, reject) => {
    let done = false;
    function finish(error?: Error) {
      if (done) return; done = true;
      clearTimeout(timer); process.off("message", release); process.off("disconnect", disconnected);
      if (error) reject(error); else resolve();
    }
    const release = (value: unknown) => { if (value === "release") finish(); };
    const disconnected = () => finish(new Error("Fixture parent disconnected."));
    const timer = setTimeout(() => finish(new Error("Fixture barrier timed out.")), 10_000);
    process.on("message", release); process.once("disconnect", disconnected);
    process.send!({ kind: "barrier", stage, backendPid }, error => { if (error) finish(new Error("Fixture IPC failed.")); });
  });
}
async function main() {
  const schema = process.env.WALLET_PAYMENT_TEST_SCHEMA;
  const prefix = process.env.WALLET_PAYMENT_TEST_PREFIX_SCHEMA ?? "";
  if (!schema || !/^wallet_payment_review_[a-f0-9]+$/.test(schema) ||
      (prefix && !/^wallet_payment_alias_[a-f0-9]+$/.test(prefix)) || !process.env.TEST_DATABASE_URL || !process.connected)
    throw new Error("Disposable payment schema, database and IPC are required.");
  const configured: unknown = JSON.parse(process.env.WALLET_PAYMENT_TEST_OPTIONS ?? "{}");
  if (!configured || typeof configured !== "object" || Array.isArray(configured) ||
      Object.entries(configured).some(([key, value]) => !["maxRecords", "maxAccountRecords", "receiptRetentionMs"].includes(key) ||
        !Number.isSafeInteger(value) || Number(value) <= 0)) throw new Error("Invalid fixture options.");
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1,
    connectionTimeoutMillis: 5000, query_timeout: 10_000,
    options: `-c search_path=${prefix ? `${prefix},` : ""}${schema} -c statement_timeout=10000 -c lock_timeout=10000 -c idle_in_transaction_session_timeout=15000` });
  const backendPid = Number((await pool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
  const stages = ["after-account", "after-review-lock", "after-review-write", "after-ceremony-write", "after-count", "after-commit"];
  const server = createServer(async (request, response) => {
    try {
      const body = await bodyOf(request);
      if (body.barrier !== undefined && !stages.includes(body.barrier)) throw new RestError(400, "FIXTURE_BARRIER", "Invalid barrier.");
      const connection = Object.create(pool) as Pool;
      connection.query = pool.query.bind(pool);
      let paused = false, wroteReview = false;
      connection.connect = (async () => {
        const client = await pool.connect(), query = client.query.bind(client);
        return new Proxy(client, { get(target, property) {
          if (property !== "query") { const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; }
          return async (...args: any[]) => {
            const sql = (typeof args[0] === "string" ? args[0] : args[0]?.text ?? "").replace(/\s+/g, " ").trim();
            const result = await (query as any)(...args);
            const reviewWrite = /^(INSERT INTO|UPDATE) rest_wallet_payment_reviews\b/i.test(sql);
            if (reviewWrite) wroteReview = true;
            const stage = /FROM rest_accounts .*FOR UPDATE/i.test(sql) ? "after-account"
              : /FROM rest_wallet_payment_reviews .*FOR UPDATE/i.test(sql) ? "after-review-lock"
              : reviewWrite ? "after-review-write"
              : /UPDATE rest_wallet_ceremonies\b/i.test(sql) ? "after-ceremony-write"
              : /SELECT count\(\*\).*FROM rest_wallet_payment_reviews/i.test(sql) ? "after-count"
              : /^COMMIT;?$/i.test(sql) && wroteReview ? "after-commit" : null;
            if (!paused && stage !== null && body.barrier === stage) {
              paused = true; await barrier(stage, backendPid);
            }
            return result;
          };
        } });
      }) as Pool["connect"];
      const store = new PostgresWalletPaymentReviewStore(connection, {
        issuer: "https://wallet.juicebox.center", audience: "https://juicebox.center",
        token: "0x1111111111111111111111111111111111111111",
        directV6Terminal: "0x4444444444444444444444444444444444444444",
        manifestFor: () => manifest, ...configured,
      });
      const assertion = body.assertion ? { ...body.assertion,
        authenticatorData: Buffer.from(body.assertion.authenticatorData, "base64url"),
        clientDataJSON: Buffer.from(body.assertion.clientDataJSON, "base64url"),
        signature: Buffer.from(body.assertion.signature, "base64url") } : undefined;
      const result = body.action === "prepare" ? await store.prepare(body.actor, body.input, body.key)
        : body.action === "getForApp" ? await store.getForApp(body.actor, body.id)
        : body.action === "get" ? await store.get(body.id)
        : body.action === "approve" ? await store.approve(body.id, assertion!)
        : body.action === "cancel" ? await store.cancel(body.id)
        : body.action === "cleanup" ? await store.cleanup(body.limit)
        : (() => { throw new RestError(400, "FIXTURE_ACTION", "Invalid fixture action."); })();
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(result ?? null));
    } catch (error) {
      const expected = error instanceof RestError || error instanceof RestAuthError;
      const pg = error && typeof error === "object" ? error as { code?: unknown; constraint?: unknown } : {};
      const diagnostic = { ...(typeof pg.code === "string" && /^[0-9A-Z]{5}$/.test(pg.code) ? { databaseCode: pg.code } : {}),
        ...(typeof pg.constraint === "string" && /^[a-z0-9_]{1,128}$/.test(pg.constraint) ? { constraint: pg.constraint } : {}) };
      if (!expected) process.send?.({ kind: "fixture-error", ...diagnostic });
      response.writeHead(expected ? error.status : 500, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: expected ? error.code : "FIXTURE_ERROR", ...diagnostic }));
    }
  });
  let stopping = false;
  function stop(code = 0) {
    if (stopping) return; stopping = true;
    server.closeAllConnections(); server.close();
    const timer = setTimeout(() => process.exit(code), 1000);
    void pool.end().catch(() => {}).finally(() => {
      clearTimeout(timer); process.exitCode = code; if (process.connected) process.disconnect();
    });
  }
  pool.on("error", () => stop(1));
  server.requestTimeout = 15_000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000;
  process.once("SIGTERM", () => stop()); process.once("SIGINT", () => stop()); process.once("disconnect", () => stop());
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture listener failed.");
  process.send?.({ kind: "ready", port: address.port, backendPid }, error => { if (error) stop(1); });
}
void main().catch(() => {
  process.send?.({ kind: "startup-error", code: "FIXTURE_STARTUP_ERROR" }, () => {});
  process.stderr.write("Wallet payment review fixture failed to start.\n"); process.exitCode = 1;
});
