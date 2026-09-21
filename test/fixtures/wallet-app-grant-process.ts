// Disposable local test service. These trusted setup commands and barriers are never production routes.
import { createServer, type IncomingMessage } from "node:http";
import { Pool, type PoolClient } from "pg";
import { RestAuthError } from "../../src/rest/auth/store.js";
import { RestError } from "../../src/rest/core.js";
import { walletAppPrincipalId, type WalletAppGrant } from "../../src/rest/wallet/appGrants.js";
import { assertWalletAppGrantActiveInTransaction, getWalletAppGrantInTransaction,
  PostgresWalletAppGrantStore } from "../../src/rest/wallet/appGrantsPostgres.js";
import { PostgresWalletPolicyStore } from "../../src/rest/wallet/policyPostgres.js";

function forbidden(): never { throw new RestAuthError("FORBIDDEN", 403, "Fixture app authority is unavailable."); }

async function requestBody(request: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > 32_768) throw new RestError(413, "FIXTURE_TOO_LARGE", "Fixture request is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function barrier(boundary: string): Promise<void> {
  if (!process.connected || !process.send) throw new Error("Fixture parent is unavailable.");
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
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
  const schema = process.env.WALLET_APP_TEST_SCHEMA;
  if (!schema || !/^rest_wallet_apps_[a-f0-9]+$/.test(schema)) throw new Error("A disposable app schema is required.");
  const prefix = process.env.WALLET_APP_TEST_PREFIX_SCHEMA;
  if (prefix && prefix !== `${schema}_a` && prefix !== `${schema}_b`) throw new Error("Invalid disposable prefix schema.");
  if (!process.env.TEST_DATABASE_URL || !process.connected) throw new Error("Fixture database and parent IPC are required.");
  const options = JSON.parse(process.env.WALLET_APP_TEST_OPTIONS ?? "{}");
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1,
    connectionTimeoutMillis: 5_000, query_timeout: 10_000,
    options: `-c search_path=${prefix ? `${prefix},` : ""}${schema} -c statement_timeout=10000 -c lock_timeout=10000 -c idle_in_transaction_session_timeout=15000` });
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
      const connection = Object.create(pool) as Pool;
      let paused = false;
      connection.connect = (async () => {
        const client = await pool.connect(), query = client.query.bind(client);
        return new Proxy(client, { get(target, property) {
          if (property !== "query") { const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; }
          return async (...args: any[]) => {
            const result = await (query as any)(...args);
            const sql = typeof args[0] === "string" ? args[0].trim() : "";
            if (!paused && ((body.barrier === "after-grant-write" && /^INSERT\s+INTO\s+rest_wallet_app_grants\b/i.test(sql))
              || (body.barrier === "after-epoch-write" && /^(?:INSERT\s+INTO|UPDATE)\s+rest_wallet_authority\b/i.test(sql))
              || (body.barrier === "after-commit" && /^COMMIT;?$/i.test(sql)))) {
              paused = true;
              await barrier(body.barrier);
            }
            return result;
          };
        } });
      }) as Pool["connect"];
      const store = new PostgresWalletAppGrantStore(connection, options);
      let result: unknown;
      if (body.action === "insert") result = await store.insert(body.input);
      else if (body.action === "epochs") result = await store.advanceEpochs(body.input);
      else if (body.action === "cleanup") result = await store.cleanup(body.limit);
      else if (body.action === "policy") result = await new PostgresWalletPolicyStore(connection).activate(body.input);
      else if (body.action === "read") {
        const client = await connection.connect();
        try { result = await getWalletAppGrantInTransaction(client, body.id); }
        finally { client.release(); }
      } else if (["guard", "claim", "raw-app", "raw-bot"].includes(body.action)) {
        const client: PoolClient = await connection.connect();
        try {
          await client.query("BEGIN");
          if (body.action === "guard" || body.action === "claim") {
            const first = await getWalletAppGrantInTransaction(client, body.id);
            if (!first) forbidden();
            const account = await client.query("SELECT id FROM rest_accounts WHERE id=$1 FOR UPDATE", [first.accountId]);
            if (!account.rows[0]) forbidden();
            const reload = async (): Promise<WalletAppGrant> => {
              const grant = await getWalletAppGrantInTransaction(client, body.id);
              if (!grant || grant.accountId !== first.accountId || walletAppPrincipalId(grant) !== walletAppPrincipalId(first)) forbidden();
              await assertWalletAppGrantActiveInTransaction(client, grant, body.context);
              return grant;
            };
            result = await reload();
            if (body.barrier === "after-guard") await barrier("after-guard");
            if (body.action === "claim") await client.query(
              "INSERT INTO wallet_app_claims(id,principal_id) VALUES($1,$2)", [body.claimId, walletAppPrincipalId(first)],
            );
            // Match compound production callers: validate live authority again after every later wait.
            result = await reload();
          } else if (body.action === "raw-app") {
            const v = body.rawValues;
            await client.query(`INSERT INTO rest_wallet_app_grants
              (id,account_id,signer_address,origin,callback_uri,audience,app_generation,authority_epoch,session_epoch,created_at,expires_at,revoked_at,retain_until)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [v.id, v.accountId, v.signerAddress, v.origin, v.callbackUri, v.audience, v.appGeneration,
              v.authorityEpoch, v.sessionEpoch, v.createdAt, v.expiresAt, v.revokedAt ?? null, v.retainUntil]);
            result = await getWalletAppGrantInTransaction(client, v.id);
          } else {
            const v = body.rawValues;
            result = (await client.query(`INSERT INTO rest_bot_grants
              (id,account_id,bot_address,scopes,label,created_at,expires_at,revoked_at)
              VALUES($1,$2,$3,$4,$5,$6,$7,NULL) ${body.onConflict ? "ON CONFLICT (id) DO NOTHING" : ""} RETURNING *`,
            [v.id, v.accountId, v.botAddress, v.scopes, v.label, v.createdAt, v.expiresAt])).rows[0] ?? null;
          }
          await client.query(body.rollback ? "ROLLBACK" : "COMMIT");
        } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
        finally { client.release(); }
      } else throw new RestError(400, "FIXTURE_ACTION", "Unknown fixture action.");
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
    if (process.connected) process.send?.({ kind: "ready", port: address.port, pid: process.pid, backendPid }, () => {});
  } catch (error) { stop(1); throw error; }
}

void main().catch(() => {
  if (process.connected) process.send?.({ kind: "startup-error", code: "FIXTURE_STARTUP_ERROR" }, () => {});
  process.stderr.write("Wallet app fixture failed to start.\n");
  process.exitCode = 1;
});
