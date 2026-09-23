// Disposable loopback test worker only. No runtime route exposes these actions or crash barriers.
import { createServer } from "node:http";
import { Pool } from "pg";
import { RestError } from "../../src/rest/core.js";
import { PostgresWalletDeploymentStore } from "../../src/rest/wallet/deploymentPostgres.js";
import { createWalletDeploymentExecution } from "../../src/rest/wallet/deploymentExecution.js";
import { createWalletDeploymentChain } from "../../src/rest/wallet/deploymentChain.js";
import { createLocalAnvilWalletDeploymentTransport } from "../../src/rest/wallet/deploymentLocalAnvil.js";
import { createWalletDeploymentAnvilRpc } from "./wallet-deployment-anvil.js";
import { mnemonicToAccount } from "viem/accounts";

const schema = process.env.WALLET_DEPLOYMENT_EXECUTION_TEST_SCHEMA;
if (!schema || !/^rest_wallet_execution_[a-f0-9]+$/.test(schema)) throw new Error("Disposable execution schema required");
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 1 });
const server = createServer(async (request, response) => {
  try {
    let text = "";
    for await (const chunk of request) { text += String(chunk); if (text.length > 262144) throw new Error("Fixture request too large"); }
    const body = JSON.parse(text), connection = Object.create(pool) as Pool;
    connection.query = pool.query.bind(pool);
    connection.connect = (async () => {
      const client = await pool.connect(), query = client.query.bind(client);
      let mutation: "signed" | "dispatch" | null = null;
      return new Proxy(client, { get(target, property) {
        if (property !== "query") { const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; }
        return async (...args: any[]) => {
          const result = await (query as any)(...args), sql = (typeof args[0] === "string" ? args[0] : "").replace(/\s+/g, " ").trim();
          if (/^UPDATE rest_wallet_deployments SET state='signed'/.test(sql)) mutation = "signed";
          if (/^(INSERT INTO|UPDATE) rest_wallet_deployment_dispatches/.test(sql)) mutation = "dispatch";
          if ((body.barrier === "after-dispatch" && /^(INSERT INTO|UPDATE) rest_wallet_deployment_dispatches/.test(sql)) ||
              (body.barrier === "after-commit" && sql === "COMMIT") ||
              (body.barrier === "after-signed-commit" && sql === "COMMIT" && mutation === "signed") ||
              (body.barrier === "after-dispatch-commit" && sql === "COMMIT" && mutation === "dispatch")) {
            process.send?.({ kind: "barrier", pid: process.pid, leaseUntil: result.rows?.[0]?.lease_until });
            await new Promise<void>(resolve => {
              if (body.continueBarrier) process.once("message", () => resolve());
            });
          }
          return result;
        };
      } });
    }) as Pool["connect"];
    const store = new PostgresWalletDeploymentStore(connection);
    async function execute() {
      const context = await store.loadExecutionContext(body.operationId), local = body.localAnvil;
      if (!local || typeof local.endpoint !== "string" || !/^http:\/\/127\.0\.0\.1:[0-9]+\/?$/.test(local.endpoint)) throw new Error("Local Anvil fixture required");
      const service = createWalletDeploymentExecution({ store,
        signer: mnemonicToAccount("test test test test test test test test test test test junk"),
        chain: createWalletDeploymentChain({ rpc: createWalletDeploymentAnvilRpc(local.endpoint), configuration: context.pool.configuration,
          manifest: context.enrollment.intent.manifest, utility: local.utility }),
        experimentalTransport: createLocalAnvilWalletDeploymentTransport({ endpoint: local.endpoint, expectedGenesisHash: local.expectedGenesisHash }),
        ...(body.dispatchLeaseMs ? { dispatchLeaseMs: body.dispatchLeaseMs } : {}) });
      return body.action === "sign" ? service.sign(body.operationId) : service.recover(body.operationId);
    }
    const result = body.action === "sign" || body.action === "recover" ? await execute()
      : body.action === "lease-dispatch" ? await store.leaseDispatch(body.input)
      : body.action === "settle-dispatch" ? await store.settleDispatch(body.input)
      : body.action === "get-dispatch" ? await store.getDispatch(body.operationId)
      : body.action === "load" ? await store.loadExecutionContext(body.operationId) : null;
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(result));
  } catch (error) {
    response.writeHead(error instanceof RestError ? error.status : 500, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: error instanceof RestError ? error.code : "FIXTURE_ERROR" }));
  }
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address(); if (address && typeof address !== "string") process.send?.({ kind: "ready", port: address.port });
});
