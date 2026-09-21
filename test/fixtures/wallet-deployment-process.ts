// Local-only PostgreSQL fixture. These unauthenticated commands and crash barriers have no production route.
import { createServer } from "node:http";
import { Pool } from "pg";
import { RestError } from "../../src/rest/core.js";
import { PostgresWalletDeploymentStore } from "../../src/rest/wallet/deploymentPostgres.js";

const schema = process.env.WALLET_DEPLOYMENT_TEST_SCHEMA;
if (!schema || !/^rest_wallet_deployment_[a-f0-9]+$/.test(schema)) throw new Error("A disposable deployment schema is required");
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 1 });

const server = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) { raw += String(chunk); if (raw.length > 262_144) throw new Error("Fixture request too large"); }
    const body = JSON.parse(raw), connection = Object.create(pool) as Pool;
    connection.query = pool.query.bind(pool);
    connection.connect = (async () => {
      const client = await pool.connect(), query = client.query.bind(client);
      return new Proxy(client, { get(target, property) {
        if (property !== "query") { const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; }
        return async (...args: any[]) => {
          const result = await (query as any)(...args);
          const sql = (typeof args[0] === "string" ? args[0] : "").replace(/\s+/g, " ").trim();
          const matched = (body.barrier === "after-consume" && /^UPDATE rest_wallet_ceremonies SET consumed_at=/.test(sql))
            || (body.barrier === "after-operation" && /^UPDATE rest_wallet_deployments SET /.test(sql) && /template/.test(sql))
            || (body.barrier === "after-lane" && /^UPDATE rest_wallet_deployment_pools SET /.test(sql) && /active_operation_id/.test(sql))
            || (body.barrier === "after-signed" && /^UPDATE rest_wallet_deployments SET /.test(sql) && /raw_transaction/.test(sql))
            || (body.barrier === "after-observation" && /^UPDATE rest_wallet_deployments SET /.test(sql) && /observation/.test(sql))
            || (body.barrier === "after-commit" && sql === "COMMIT");
          if (matched) {
            process.send?.({ kind: "barrier", pid: process.pid });
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
    const store = new PostgresWalletDeploymentStore(connection);
    const decode = (value: string) => Buffer.from(value, "base64url");
    const result = body.action === "configure" ? await store.configurePool(body.configuration)
      : body.action === "prepare" ? await store.prepare(body.input)
      : body.action === "claim" ? await store.claim({ ...body.input, assertion: { ...body.input.assertion,
        authenticatorData: decode(body.input.assertion.authenticatorData), clientDataJSON: decode(body.input.assertion.clientDataJSON),
        signature: decode(body.input.assertion.signature) } })
      : body.action === "lease" ? await store.leaseSigning(body.operationId, body.leaseDurationMs)
      : body.action === "persist" ? await store.persistSigned(body.input)
      : body.action === "observe" ? await store.saveObservation(body.input)
      : body.action === "unresolved" ? await store.listUnresolved(body.input)
      : body.action === "cleanup" ? await store.cleanup(body.limit)
      : body.action === "get" ? await store.get(body.operationId) : null;
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(result));
  } catch (error) {
    const pg = error && typeof error === "object" ? error as { code?: unknown; constraint?: unknown } : {};
    const diagnostic = {
      ...(typeof pg.code === "string" && /^[0-9A-Z]{5}$/.test(pg.code) ? { databaseCode: pg.code } : {}),
      ...(typeof pg.constraint === "string" && /^[a-z0-9_]{1,128}$/.test(pg.constraint) ? { constraint: pg.constraint } : {}),
    };
    if (!(error instanceof RestError)) process.send?.({ kind: "fixture-error", ...diagnostic });
    response.writeHead(error instanceof RestError ? error.status : 500, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: error instanceof RestError ? error.code : "FIXTURE_ERROR", ...diagnostic }));
  }
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string") process.send?.({ kind: "ready", port: address.port, pid: process.pid });
});
