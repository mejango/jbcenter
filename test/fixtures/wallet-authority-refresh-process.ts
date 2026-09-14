// Local-only refresh-queue fixture. It has no RPC, signer or public authority route.
import { createServer } from "node:http";
import { Pool } from "pg";
import { RestError } from "../../src/rest/core.js";
import { RestAuthError } from "../../src/rest/auth/store.js";
import { PostgresWalletAuthorityRefreshQueue } from "../../src/rest/wallet/authorityRefreshPostgres.js";

const schema = process.env.WALLET_AUTHORITY_REFRESH_TEST_SCHEMA;
if (!schema || !/^rest_wallet_authority_refresh_[a-f0-9]+$/.test(schema)) {
  throw new Error("A disposable authority refresh schema is required");
}
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 1 });
const backendPid = Number((await pool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);

const server = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) {
      raw += String(chunk);
      if (raw.length > 262144) throw new Error("Fixture request too large");
    }
    const body = JSON.parse(raw);
    const queue = new PostgresWalletAuthorityRefreshQueue(pool, body.options);
    let result: unknown;
    switch (body.action) {
      case "request": result = await queue.request(body.accountId); break;
      case "claim": {
        result = await queue.claim();
        if (body.barrier === "after-claim") {
          await new Promise<void>(resolve => {
            const resume = (message: unknown) => {
              if (message && typeof message === "object" && "kind" in message && message.kind === "continue") {
                process.off("message", resume);
                resolve();
              }
            };
            process.on("message", resume);
            process.send?.({ kind: "barrier", lease: result, backendPid, pid: process.pid });
          });
        }
        break;
      }
      case "complete": result = await queue.complete(body.lease, body.result); break;
      case "stats": result = await queue.stats(); break;
      default: throw new Error("Unknown fixture action");
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  } catch (error) {
    const expected = error instanceof RestError || error instanceof RestAuthError;
    response.writeHead(expected ? error.status : 500, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: expected ? error.code : "FIXTURE_ERROR" }));
  }
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string") {
    process.send?.({ kind: "ready", port: address.port, pid: process.pid, backendPid });
  }
});
