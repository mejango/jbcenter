import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { createApp } from "./app.js";
import { migrate } from "./db/migrate.js";
import { createPool, PostgresStore } from "./db/postgres.js";
import { canonicalDeploymentChains, RpcDeploymentVerifier } from "./deploymentVerifier.js";
import { FilebaseRpcStorage, RedundantIpfsPinning } from "./ipfs.js";
import { createRpcGateway, dwellirRpcUpstreams } from "./rpc.js";

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

const pool = createPool(connectionString);
await migrate(pool);
const deploymentVerifier = new RpcDeploymentVerifier(canonicalDeploymentChains(rpcUpstreams));
const server = serve({
  fetch: createApp(new PostgresStore(pool), {
    deploymentVerifier,
    requestLimitPerMinute: positiveInteger("RATE_LIMIT_PER_MINUTE", 600),
    maxIntentsPerClient: positiveInteger("MAX_INTENTS_PER_CLIENT", 10_000),
    maxStorageBytesPerClient: positiveInteger("MAX_STORAGE_BYTES_PER_CLIENT", 1_073_741_824),
    rpcRequestLimitPerMinute: positiveInteger("RPC_REQUEST_LIMIT_PER_MINUTE", 600),
    rpcSiteLimitPerMinute: positiveInteger("RPC_SITE_LIMIT_PER_MINUTE", 20_000),
    rpcPublicRequestLimitPerMinute: positiveInteger("RPC_PUBLIC_REQUEST_LIMIT_PER_MINUTE", 120),
    rpcPublicSiteLimitPerMinute: positiveInteger("RPC_PUBLIC_SITE_LIMIT_PER_MINUTE", 5_000),
    metricsToken,
    ...(rpcUpstreams.size ? { rpc: createRpcGateway(rpcUpstreams) } : {}),
    ...(filebaseRpcToken && pinataJwt
      ? {
          pinning: new RedundantIpfsPinning(
            new FilebaseRpcStorage(filebaseRpcToken),
            pinataJwt,
          ),
        }
      : {}),
  }).fetch,
  port,
}) as Server;
server.headersTimeout = 10_000;
server.requestTimeout = 300_000;
server.keepAliveTimeout = 5_000;
console.log(`JB Center listening on :${port}`);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await pool.end();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
