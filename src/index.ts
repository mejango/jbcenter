import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { parseApiKeys } from "./auth.js";
import { createApp } from "./app.js";
import { migrate } from "./db/migrate.js";
import { createPool, PostgresStore } from "./db/postgres.js";
import { parseChainRpcConfig, RpcDeploymentVerifier } from "./deploymentVerifier.js";
import { RedundantIpfsPinning } from "./ipfs.js";

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
const clientKeys = parseApiKeys(process.env.JUICE_CENTRAL_API_KEYS, "client");
const reconcilerKeys = parseApiKeys(process.env.JUICE_CENTRAL_RECONCILER_KEYS, "reconciler");
if (!clientKeys.length) throw new Error("JUICE_CENTRAL_API_KEYS must configure a client");
if (!reconcilerKeys.length) throw new Error("JUICE_CENTRAL_RECONCILER_KEYS must configure a reconciler");
const keys = [...clientKeys, ...reconcilerKeys];
for (const key of keys) requireStrongSecret(`${key.name} API key`, key.secret);
if (new Set(keys.map(({ name }) => name)).size !== keys.length) {
  throw new Error("API key client names must be unique");
}
if (new Set(keys.map(({ secret }) => secret)).size !== keys.length) {
  throw new Error("API key secrets must be unique");
}
const metricsToken = requireStrongSecret("METRICS_TOKEN", process.env.METRICS_TOKEN);
const filebaseToken = process.env.FILEBASE_IPFS_RPC_TOKEN;
const pinataJwt = process.env.PINATA_JWT;
if (!!filebaseToken !== !!pinataJwt) {
  throw new Error("FILEBASE_IPFS_RPC_TOKEN and PINATA_JWT must be configured together");
}
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT is invalid");

const pool = createPool(connectionString);
await migrate(pool);
const deploymentVerifier = new RpcDeploymentVerifier(
  parseChainRpcConfig(process.env.JUICE_CENTRAL_CHAINS),
);
const server = serve({
  fetch: createApp(new PostgresStore(pool), keys, {
    deploymentVerifier,
    requestLimitPerMinute: positiveInteger("RATE_LIMIT_PER_MINUTE", 600),
    maxIntentsPerClient: positiveInteger("MAX_INTENTS_PER_CLIENT", 10_000),
    maxStorageBytesPerClient: positiveInteger("MAX_STORAGE_BYTES_PER_CLIENT", 1_073_741_824),
    metricsToken,
    ...(filebaseToken && pinataJwt
      ? { pinning: new RedundantIpfsPinning(filebaseToken, pinataJwt) }
      : {}),
  }).fetch,
  port,
}) as Server;
server.headersTimeout = 10_000;
server.requestTimeout = 180_000;
server.keepAliveTimeout = 5_000;
console.log(`Juice Central listening on :${port}`);

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
