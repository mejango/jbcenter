// Local-only internal-store fixture. It has no RPC, signer, public login or grant issuance route.
import { createServer } from "node:http";
import { Pool } from "pg";
import { RestError } from "../../src/rest/core.js";
import { RestAuthError } from "../../src/rest/auth/store.js";
import { PostgresWalletAuthorityStore } from "../../src/rest/wallet/authorityPostgres.js";
import { PostgresWalletAppGrantStore } from "../../src/rest/wallet/appGrantsPostgres.js";

const schema = process.env.WALLET_AUTHORITY_TEST_SCHEMA;
if (!schema || !/^rest_wallet_authority_[a-f0-9]+$/.test(schema)) throw new Error("A disposable authority schema is required");
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 1 });
const backendPid = Number((await pool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);

const server = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) { raw += String(chunk); if (raw.length > 262144) throw new Error("Fixture request too large"); }
    const body = JSON.parse(raw), connection = Object.create(pool) as Pool, lockTrace: string[] = [];
    connection.query = pool.query.bind(pool);
    connection.connect = (async () => {
      const client = await pool.connect(), query = client.query.bind(client);
      return new Proxy(client, { get(target, property) {
        if (property !== "query") { const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; }
        return async (...args: any[]) => {
          const result = await (query as any)(...args);
          const sql = (typeof args[0] === "string" ? args[0] : "").replace(/\s+/g, " ").trim();
          const stage = /FROM rest_accounts .*FOR UPDATE/.test(sql) ? "after-account"
            : /FROM rest_wallet_enrollments .*FOR UPDATE/.test(sql) ? "after-enrollment"
            : /FROM rest_wallet_authority .*FOR UPDATE/.test(sql) ? "after-authority-lock"
            : /FROM rest_wallet_credentials .*FOR UPDATE/.test(sql) ? "after-credential"
            : /^(INSERT INTO|UPDATE) rest_wallet_authority\b/.test(sql) ? "after-authority-write"
            : sql === "COMMIT" ? "after-commit" : null;
          if (stage) lockTrace.push(stage);
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
    const store = new PostgresWalletAuthorityStore(connection);
    const result = body.action === "context" ? await store.loadContext(body.accountId)
      : body.action === "get" ? await store.get(body.accountId)
      : body.action === "reconcile" ? await store.reconcile(body.context, body.observation)
      : body.action === "logout" ? await new PostgresWalletAppGrantStore(connection).advanceEpochs(body.input) : null;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body.trace === true ? { result, lockTrace } : result));
  } catch (error) {
    const pg = error && typeof error === "object" ? error as { code?: unknown; constraint?: unknown } : {};
    const diagnostic = {
      ...(typeof pg.code === "string" && /^[0-9A-Z]{5}$/.test(pg.code) ? { databaseCode: pg.code } : {}),
      ...(typeof pg.constraint === "string" && /^[a-z0-9_]{1,128}$/.test(pg.constraint) ? { constraint: pg.constraint } : {}),
    };
    const expected = error instanceof RestError || error instanceof RestAuthError;
    if (!expected) process.send?.({ kind: "fixture-error", ...diagnostic });
    response.writeHead(expected ? error.status : 500, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: expected ? error.code : "FIXTURE_ERROR", ...diagnostic }));
  }
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string") process.send?.({ kind: "ready", port: address.port, pid: process.pid, backendPid });
});
