// Local-only disposable service fixture. No production route accepts these commands or barriers.
import { createServer } from "node:http";
import { Pool } from "pg";
import { RestError } from "../../src/rest/core.js";
import { PostgresWalletCeremonyStore } from "../../src/rest/wallet/ceremoniesPostgres.js";

const schema = process.env.WALLET_TEST_SCHEMA;
if (!schema || !/^rest_wallet_ceremonies_[a-f0-9]+$/.test(schema)) throw new Error("A disposable test schema is required");
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 4 });
const options = JSON.parse(process.env.WALLET_TEST_OPTIONS ?? "{}");
const server = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) { raw += String(chunk); if (raw.length > 16_384) throw new Error("Fixture request too large"); }
    const body = JSON.parse(raw);
    const connection = Object.create(pool) as Pool;
    connection.connect = (async () => {
      const client = await pool.connect(), query = client.query.bind(client);
      return new Proxy(client, { get(target, property) {
        if (property !== "query") { const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; }
        return async (...args: any[]) => {
          const result = await (query as any)(...args);
          const sql = typeof args[0] === "string" ? args[0] : "";
          if ((body.barrier === "after-write" && sql.includes("UPDATE rest_wallet_ceremonies SET consumed_at"))
            || (body.barrier === "after-commit" && sql === "COMMIT")) {
            process.send?.({ kind: "barrier", pid: process.pid });
            await new Promise<void>(() => {}); // Parent kills the service at this deterministic boundary.
          }
          return result;
        };
      } });
    }) as Pool["connect"];
    const store = new PostgresWalletCeremonyStore(connection, options);
    // Synthetic, fixed verified-wallet fixtures stand in for a future service's prior verification.
    // Never copy a privilege flag, proof, or admission context from the fixture request.
    const fixtureWallets = new Set(["wallet:fixture", "owner:one", "owner:two", "owner:three", "owner:four"]);
    const admission = fixtureWallets.has(body.input?.accountId) ? {
      accountId: body.input.accountId, contextDigest: "a".repeat(64), verifiedProofDigest: "c".repeat(64),
    } : null;
    const result = body.action === "issue" ? await store.issue(body.input)
      : body.action === "issueControl" && admission ? await store.issueControl(body.input, admission)
      : body.action === "consume" ? await store.consume(body.input)
      : body.action === "get" ? await store.get(body.input) : null;
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(result));
  } catch (error) {
    response.writeHead(error instanceof RestError ? error.status : 500, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: error instanceof RestError ? error.code : "FIXTURE_ERROR" }));
  }
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string") process.send?.({ kind: "ready", port: address.port, pid: process.pid });
});
