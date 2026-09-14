// Disposable two-process settlement/crash harness. No runtime route exposes these actions.
import { createServer } from "node:http";
import { Pool } from "pg";
import { RestError } from "../../src/rest/core.js";
import { PostgresWalletDeploymentStore } from "../../src/rest/wallet/deploymentPostgres.js";
import { createLocalAnvilWalletDeploymentSettlement } from "../../src/rest/wallet/deploymentSettlementLocalAnvil.js";
const schema = process.env.WALLET_DEPLOYMENT_SETTLEMENT_TEST_SCHEMA;
if (!schema || !/^rest_wallet_(?:settlement|execution)_[a-f0-9]+$/.test(schema)) throw new Error("Disposable settlement schema required");
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 1 });
const server = createServer(async (request, response) => {
  try {
    let text = "";
    for await (const chunk of request) { text += String(chunk); if (text.length > 262144) throw new Error("Fixture request too large"); }
    const body = JSON.parse(text), connection = Object.create(pool) as Pool;
    connection.query = pool.query.bind(pool);
    connection.connect = (async () => {
      const client = await pool.connect(), query = client.query.bind(client);
      let wrote = false;
      return new Proxy(client, { get(target, property) {
        if (property !== "query") { const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; }
        return async (...args: any[]) => {
          const result = await (query as any)(...args), sql = (typeof args[0] === "string" ? args[0] : "").replace(/\s+/g, " ").trim();
          if (/^INSERT INTO rest_wallet_deployment_settlements/.test(sql)) wrote = true;
          const stage = /^INSERT INTO rest_wallet_deployment_settlements/.test(sql) ? "after-receipt"
            : /^UPDATE rest_wallet_deployments SET settlement_id/.test(sql) ? "after-marker"
            : /^UPDATE rest_wallet_deployment_pools SET accounting/.test(sql) && wrote ? "after-debit"
            : sql === "COMMIT" && wrote ? "after-commit" : null;
          if (stage && body.barrier === stage) {
            process.send?.({ kind: "barrier", stage });
            await new Promise<void>(resolve => { if (body.continueBarrier) process.once("message", () => resolve()); });
          }
          return result;
        };
      } });
    }) as Pool["connect"];
    const store = new PostgresWalletDeploymentStore(connection);
    let result: unknown;
    if (body.action === "settle") result = await store.settle(body.context, body.evidence);
    else if (body.action === "observe-settle") {
      const context = await store.loadSettlementContext(body.operationId);
      const producer = createLocalAnvilWalletDeploymentSettlement(body.localAnvil);
      result = await store.settle(context, await producer.observeSettlement(context));
    } else if (body.action === "claim") {
      const input = body.input;
      for (const name of ["authenticatorData", "clientDataJSON", "signature"]) input.assertion[name] = Uint8Array.from(input.assertion[name].data ?? Object.values(input.assertion[name]));
      result = await store.claim(input);
    } else if (body.action === "get-settlement") result = await store.getSettlement(body.operationId);
    else if (body.action === "load") result = await store.loadSettlementContext(body.operationId);
    else throw new Error("Unknown fixture action");
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(result));
  } catch (error) {
    response.writeHead(error instanceof RestError ? error.status : 500, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: error instanceof RestError ? error.code : "FIXTURE_ERROR" }));
  }
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address(); if (address && typeof address !== "string") process.send?.({ kind: "ready", port: address.port });
});
