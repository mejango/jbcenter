// Disposable local test service. No production route exposes policy activation or these barriers.
import { createServer } from "node:http";
import { Pool, type PoolClient } from "pg";
import { RestError } from "../../src/rest/core.js";
import { assertWalletPolicyCallbackInTransaction, PostgresWalletPolicyStore } from "../../src/rest/wallet/policyPostgres.js";

const schema = process.env.WALLET_TEST_SCHEMA;
if (!schema || !/^rest_wallet_policy_[a-f0-9]+$/.test(schema)) throw new Error("A disposable policy schema is required");
const prefix = process.env.WALLET_TEST_PREFIX_SCHEMA;
if (prefix && !/^rest_wallet_policy_[a-f0-9]+_[ab]$/.test(prefix)) throw new Error("Invalid disposable prefix schema");
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${prefix ? `${prefix},` : ""}${schema}`, max: 1 });
const options = JSON.parse(process.env.WALLET_TEST_OPTIONS ?? "{}");
const backendPid = (await pool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
async function barrier(kind: string) {
  process.send?.({ kind: "barrier", boundary: kind });
  await new Promise<void>(resolve => {
    const release = (value: unknown) => {
      if (value === "release") { process.off("message", release); resolve(); }
    };
    process.on("message", release);
  });
}
const server = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) { raw += String(chunk); if (raw.length > 40_000) throw new Error("Fixture request too large"); }
    const body = JSON.parse(raw);
    const connection = Object.create(pool) as Pool;
    let paused = false;
    connection.connect = (async () => {
      const client = await pool.connect(), query = client.query.bind(client);
      return new Proxy(client, { get(target, property) {
        if (property !== "query") { const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; }
        return async (...args: any[]) => {
          const result = await (query as any)(...args), sql = typeof args[0] === "string" ? args[0] : "";
          if (!paused && ((body.barrier === "after-app-write" && /^(INSERT INTO|UPDATE) rest_wallet_policy_apps/.test(sql.trim()))
            || (body.barrier === "after-policy-write" && sql.includes("UPDATE rest_wallet_policy SET"))
            || (body.barrier === "after-commit" && sql === "COMMIT"))) {
            paused = true; await barrier(body.barrier);
          }
          return result;
        };
      } });
    }) as Pool["connect"];
    const store = new PostgresWalletPolicyStore(connection, options);
    let result: unknown;
    if (body.action === "activate") result = await store.activate(body.input);
    else if (body.action === "read") result = await new PostgresWalletPolicyStore(pool, options).readActivePolicy();
    else if (body.action === "guard" || body.action === "claim") {
      const client: PoolClient = await connection.connect();
      try {
        await client.query("BEGIN");
        result = await assertWalletPolicyCallbackInTransaction(client, body.input);
        if (body.barrier === "after-guard") await barrier("after-guard");
        if (body.action === "claim") {
          await client.query("INSERT INTO wallet_policy_claims(id,origin) VALUES($1,$2)", [body.claimId, body.input.origin]);
          // A compound caller must recheck freshness after any later blocking writes, immediately before COMMIT.
          await assertWalletPolicyCallbackInTransaction(client, body.input);
        }
        await client.query(body.rollback ? "ROLLBACK" : "COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    } else throw new Error("Unknown test action");
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(result));
  } catch (error) {
    response.writeHead(error instanceof RestError ? error.status : 500, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: error instanceof RestError ? error.code : "FIXTURE_ERROR" }));
  }
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string") process.send?.({ kind: "ready", port: address.port, pid: process.pid, backendPid });
});
