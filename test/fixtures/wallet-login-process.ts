// Local-only internal-store fixture. Its commands and crash barriers have no production route.
import { createServer } from "node:http";
import { Pool } from "pg";
import { RestError } from "../../src/rest/core.js";
import { RestAuthError } from "../../src/rest/auth/store.js";
import { PostgresWalletLoginStore } from "../../src/rest/wallet/loginPostgres.js";

const schema = process.env.WALLET_LOGIN_TEST_SCHEMA;
if (!schema || !/^rest_wallet_login_[a-f0-9]+$/.test(schema)) throw new Error("A disposable login schema is required");
const prefix = process.env.WALLET_LOGIN_TEST_PREFIX_SCHEMA ?? "";
if (prefix && !/^rest_wallet_login_alias_[a-f0-9]+$/.test(prefix)) throw new Error("A disposable login schema alias is required");
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL,
  options: `-c search_path=${prefix ? `${prefix},` : ""}${schema}`, max: 1 });
const options = JSON.parse(process.env.WALLET_LOGIN_TEST_OPTIONS ?? "{}");
const backendPid = Number((await pool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);

const server = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) { raw += String(chunk); if (raw.length > 131072) throw new Error("Fixture request too large"); }
    const body = JSON.parse(raw), connection = Object.create(pool) as Pool;
    let wroteLogin = false;
    connection.query = pool.query.bind(pool);
    connection.connect = (async () => {
      const client = await pool.connect(), query = client.query.bind(client);
      return new Proxy(client, { get(target, property) {
        if (property !== "query") { const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; }
        return async (...args: any[]) => {
          const sql = (typeof args[0] === "string" ? args[0] : "").replace(/\s+/g, " ").trim();
          const result = await (query as any)(...args);
          // Explicitly simulated elapsed time for the one-hour session deadline only.
          // Genuine proofs and actual PostgreSQL rows remain untouched. Other expiry tests
          // use real database clocks and real blocked transactions.
          if (body.databaseTimeOffsetMs !== undefined && sql.includes("clock_timestamp()") && /\bAS now\b/i.test(sql)) {
            if (!Number.isSafeInteger(body.databaseTimeOffsetMs) || body.databaseTimeOffsetMs < 0 || body.databaseTimeOffsetMs > 3_600_001)
              throw new Error("Fixture time offset outside bound");
            if (result.rows[0]?.now === undefined) throw new Error("Fixture clock observation missing");
            result.rows[0].now = String(Number(result.rows[0].now) + body.databaseTimeOffsetMs);
          }
          if (/^(INSERT INTO|UPDATE) rest_wallet_logins\b/.test(sql)) wroteLogin = true;
          const stage = /FROM rest_accounts .*FOR UPDATE/.test(sql) ? "after-account"
            : /FROM rest_wallet_credentials .*FOR UPDATE/.test(sql) ? "after-credential"
            : /FROM rest_wallet_logins .*FOR UPDATE/.test(sql) ? "after-login-lock"
            : /^(INSERT INTO|UPDATE) rest_wallet_logins\b/.test(sql) ? "after-login-write"
            : sql === "SELECT count(*)::text AS count FROM rest_wallet_logins" ? "after-count"
            : sql === "COMMIT" && wroteLogin ? "after-commit" : null;
          if (body.barrier === stage) {
            process.send?.({ kind: "barrier", stage, pid: process.pid, backendPid });
            await new Promise<void>(resolve => {
              if (body.continueBarrier === true) {
                const resume = (message: any) => {
                  if (message?.kind === "continue") { process.off("message", resume); resolve(); }
                };
                process.on("message", resume);
              }
            });
          }
          return result;
        };
      } });
    }) as Pool["connect"];
    const store = new PostgresWalletLoginStore(connection, {
      rpId: "wallet.juicebox.center", origin: "https://wallet.juicebox.center", ...options,
    });
    const input = body.input?.assertion ? { ...body.input, assertion: { ...body.input.assertion,
      authenticatorData: Buffer.from(body.input.assertion.authenticatorData, "base64url"),
      clientDataJSON: Buffer.from(body.input.assertion.clientDataJSON, "base64url"),
      signature: Buffer.from(body.input.assertion.signature, "base64url") } } : body.input;
    const result = body.action === "begin" ? await store.begin()
      : body.action === "complete" ? await store.complete(input)
      : body.action === "identifyCompletion" ? await store.identifyCompletion(input)
      : body.action === "readSession" ? await store.readSession(body.token)
      : body.action === "identifySession" ? await store.identifySession(body.token)
      : body.action === "logout" ? await store.logout(body.token)
      : body.action === "cleanup" ? await store.cleanup(body.limit)
      : (() => { throw new Error("Unknown fixture action"); })();
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(result));
  } catch (error) {
    const expected = error instanceof RestError || error instanceof RestAuthError;
    const pg = error && typeof error === "object" ? error as { code?: unknown; constraint?: unknown } : {};
    const diagnostic = {
      ...(typeof pg.code === "string" && /^[0-9A-Z]{5}$/.test(pg.code) ? { databaseCode: pg.code } : {}),
      ...(typeof pg.constraint === "string" && /^[a-z0-9_]{1,128}$/.test(pg.constraint) ? { constraint: pg.constraint } : {}),
    };
    if (!expected) process.send?.({ kind: "fixture-error", ...diagnostic });
    response.writeHead(expected ? error.status : 500, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: expected ? error.code : "FIXTURE_ERROR", ...diagnostic }));
  }
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string") process.send?.({ kind: "ready", port: address.port, pid: process.pid, backendPid });
});
