import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { parseApiKeys } from "./auth.js";
import { createApp } from "./app.js";
import { migrate } from "./db/migrate.js";
import { createPool, PostgresStore } from "./db/postgres.js";
import { parseChainRpcConfig, RpcDeploymentVerifier } from "./deploymentVerifier.js";
import { FilebaseS3Storage, RedundantIpfsPinning } from "./ipfs.js";
import { createRpcGateway, parseRpcUpstreams } from "./rpc.js";

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function requireStrongSecret(name: string, value: string | undefined): string {
  if (!value || value.length < 32) throw new Error(`${name} must contain at least 32 characters`);
  return value;
}

function renamedEnv(name: string, legacyName: string): string | undefined {
  return process.env[name] ?? process.env[legacyName];
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const clientKeys = parseApiKeys(renamedEnv("JBCENTER_API_KEYS", "JUICE_CENTRAL_API_KEYS"), "client");
const reconcilerKeys = parseApiKeys(
  renamedEnv("JBCENTER_RECONCILER_KEYS", "JUICE_CENTRAL_RECONCILER_KEYS"),
  "reconciler",
);
if (!clientKeys.length) throw new Error("JBCENTER_API_KEYS must configure a client");
if (!reconcilerKeys.length) throw new Error("JBCENTER_RECONCILER_KEYS must configure a reconciler");
const keys = [...clientKeys, ...reconcilerKeys];
for (const key of keys) requireStrongSecret(`${key.name} API key`, key.secret);
if (new Set(keys.map(({ name }) => name)).size !== keys.length) {
  throw new Error("API key client names must be unique");
}
if (new Set(keys.map(({ secret }) => secret)).size !== keys.length) {
  throw new Error("API key secrets must be unique");
}
const metricsToken = requireStrongSecret("METRICS_TOKEN", process.env.METRICS_TOKEN);
const filebaseAccessKey = process.env.FILEBASE_ACCESS_KEY_ID;
const filebaseSecretKey = process.env.FILEBASE_SECRET_ACCESS_KEY;
const filebaseBucket = process.env.FILEBASE_BUCKET;
const pinataJwt = process.env.PINATA_JWT;
const pinningValues = [filebaseAccessKey, filebaseSecretKey, filebaseBucket, pinataJwt];
if (pinningValues.some(Boolean) && !pinningValues.every(Boolean)) {
  throw new Error(
    "FILEBASE_ACCESS_KEY_ID, FILEBASE_SECRET_ACCESS_KEY, FILEBASE_BUCKET, and PINATA_JWT must be configured together",
  );
}
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT is invalid");
const rpcUpstreams = parseRpcUpstreams(process.env.JBCENTER_RPC_URLS);

const pool = createPool(connectionString);
await migrate(pool);
const deploymentVerifier = new RpcDeploymentVerifier(
  parseChainRpcConfig(renamedEnv("JBCENTER_CHAINS", "JUICE_CENTRAL_CHAINS")),
);
const server = serve({
  fetch: createApp(new PostgresStore(pool), keys, {
    deploymentVerifier,
    requestLimitPerMinute: positiveInteger("RATE_LIMIT_PER_MINUTE", 600),
    maxIntentsPerClient: positiveInteger("MAX_INTENTS_PER_CLIENT", 10_000),
    maxStorageBytesPerClient: positiveInteger("MAX_STORAGE_BYTES_PER_CLIENT", 1_073_741_824),
    rpcRequestLimitPerMinute: positiveInteger("RPC_REQUEST_LIMIT_PER_MINUTE", 600),
    rpcSiteLimitPerMinute: positiveInteger("RPC_SITE_LIMIT_PER_MINUTE", 20_000),
    metricsToken,
    ...(rpcUpstreams.size ? { rpc: createRpcGateway(rpcUpstreams) } : {}),
    ...(filebaseAccessKey && filebaseSecretKey && filebaseBucket && pinataJwt
      ? {
          pinning: new RedundantIpfsPinning(
            new FilebaseS3Storage(filebaseAccessKey, filebaseSecretKey, filebaseBucket),
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
