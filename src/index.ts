import { createHttpHandler, createMcpServer } from "@juicebox/mcp/host";
import { createApp } from "./app.js";
import { migrate } from "./db/migrate.js";
import { createPool, PostgresStore } from "./db/postgres.js";
import { canonicalDeploymentChains, RpcDeploymentVerifier } from "./deploymentVerifier.js";
import { FilebaseRpcStorage, RedundantIpfsPinning } from "./ipfs.js";
import { createRpcGateway, dwellirRpcUpstreams } from "./rpc.js";
import { createCenterMcp } from "./mcp.js";
import { createCenterServer } from "./server.js";
import { createRestRuntime } from "./rest/runtime.js";
import { readRestExecutionConfiguration } from "./rest/executionConfig.js";
import { Metrics } from "./observability.js";

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function requireStrongSecret(name: string, value: string | undefined): string {
  if (!value || value.length < 32) throw new Error(`${name} must contain at least 32 characters`);
  return value;
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const metricsToken = requireStrongSecret("METRICS_TOKEN", process.env.METRICS_TOKEN);
const filebaseRpcToken = process.env.FILEBASE_RPC_TOKEN;
const pinataJwt = process.env.PINATA_JWT;
const pinningValues = [filebaseRpcToken, pinataJwt];
if (pinningValues.some(Boolean) && !pinningValues.every(Boolean)) {
  throw new Error("FILEBASE_RPC_TOKEN and PINATA_JWT must be configured together");
}
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT is invalid");
const rpcUpstreams = dwellirRpcUpstreams(process.env.DWELLIR_API_KEY);
const rpcSiteLimitPerMinute = positiveInteger("RPC_SITE_LIMIT_PER_MINUTE", 20_000);

const pool = createPool(connectionString);
await migrate(pool);
const deploymentVerifier = new RpcDeploymentVerifier(canonicalDeploymentChains(rpcUpstreams));
const store = new PostgresStore(pool);
const rpc = createRpcGateway(rpcUpstreams);
const pinning = filebaseRpcToken && pinataJwt
  ? new RedundantIpfsPinning(new FilebaseRpcStorage(filebaseRpcToken), pinataJwt)
  : undefined;
const mcp = createCenterMcp(store, { rpc, rpcSiteLimitPerMinute, ...(pinning ? { pinning } : {}) });
const metrics = new Metrics();
const paraEnvironment = process.env.PARA_ENVIRONMENT ?? "BETA";
if (paraEnvironment !== "BETA" && paraEnvironment !== "PROD") throw new Error("PARA_ENVIRONMENT must be BETA or PROD");
const rest = await createRestRuntime({
  ...(process.env.PARA_API_KEY ? { para: { apiKey: process.env.PARA_API_KEY, environment: paraEnvironment } } : {}),
  pool, store, services: mcp.services, config: mcp.config, upstreams: rpcUpstreams, rpcSiteLimitPerMinute, metrics,
  ...(process.env.REST_PUBLIC_ORIGIN ? { audience: process.env.REST_PUBLIC_ORIGIN } : {}),
  executionConfiguration: await readRestExecutionConfiguration(process.env),
});
const handler = createHttpHandler(mcp.config, () => createMcpServer(mcp.services), {
  healthPath: "/mcp/healthz",
  readinessPath: "/mcp/readyz",
  indexPath: false,
  logger: (message) => console.error(JSON.stringify({ level: "error", service: "mcp", message })),
});
const app = createApp(store, {
    rest: rest.site,
    deploymentVerifier,
    requestLimitPerMinute: positiveInteger("RATE_LIMIT_PER_MINUTE", 600),
    maxIntentsPerClient: positiveInteger("MAX_INTENTS_PER_CLIENT", 10_000),
    maxStorageBytesPerClient: positiveInteger("MAX_STORAGE_BYTES_PER_CLIENT", 1_073_741_824),
    rpcRequestLimitPerMinute: positiveInteger("RPC_REQUEST_LIMIT_PER_MINUTE", 600),
    rpcSiteLimitPerMinute,
    rpcPublicRequestLimitPerMinute: positiveInteger("RPC_PUBLIC_REQUEST_LIMIT_PER_MINUTE", 120),
    rpcPublicSiteLimitPerMinute: positiveInteger("RPC_PUBLIC_SITE_LIMIT_PER_MINUTE", 5_000),
    metricsToken,
    metrics,
    rpc,
    ...(pinning ? { pinning } : {}),
  });
const runtime = createCenterServer(app.fetch, handler, {
  port,
  shutdownGraceMs: positiveInteger("SHUTDOWN_GRACE_MS", 25_000),
});
await runtime.listen();
console.log(`JB Center listening on :${port}, including /mcp and /api/v1`);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await runtime.close();
  await rest.stop();
  await pool.end();
};
const stop = () => void shutdown().catch(() => {
  console.error("JB Center shutdown failed");
  process.exitCode = 1;
});
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
