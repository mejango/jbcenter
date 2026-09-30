import { createHttpHandler, createMcpServer } from "@juicebox/mcp/host";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { keepUpstreamConnections } from "./keepAlive.js";
import { createApp, MCP_CLIENT } from "./app.js";
import { migrate } from "./db/migrate.js";
import { createPool, PostgresStore } from "./db/postgres.js";
import { canonicalDeploymentChains, PROJECTS, RpcDeploymentVerifier } from "./deploymentVerifier.js";
import { FilebaseRpcStorage, PIN_LIMITS, RedundantIpfsPinning } from "./ipfs.js";
import { IpfsDiskCache } from "./ipfsCache.js";
import { createRpcGateway, dwellirRpcUpstreams } from "./rpc.js";
import { createCenterMcp } from "./mcp.js";
import { createCenterServer } from "./server.js";
import { createRestRuntime } from "./rest/runtime.js";
import { readRestExecutionConfiguration } from "./rest/executionConfig.js";
import { Metrics } from "./observability.js";
import { SponsorshipChain } from "./rest/sponsorship/chain.js";
import { DEFAULT_SPONSORSHIP_POLICY } from "./rest/sponsorship/constants.js";
import { RelayrProvider } from "./rest/sponsorship/provider.js";
import { createRelayrLane } from "./sponsor/relayr.js";
import type { SponsorEvent } from "./sponsor/chain.js";
import { readSponsorPolicy, type SponsorRuntime } from "./sponsor/policy.js";
import { createSponsorWorker } from "./sponsor/worker.js";

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function requireStrongSecret(name: string, value: string | undefined): string {
  if (!value || value.length < 32) throw new Error(`${name} must contain at least 32 characters`);
  return value;
}

const keptAlive = keepUpstreamConnections();
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
const ipfsCache = process.env.IPFS_CACHE_DIR ? new IpfsDiskCache({
  directory: process.env.IPFS_CACHE_DIR,
  maxBytes: positiveInteger("IPFS_CACHE_MAX_BYTES", 4_294_967_296),
  maxEntryBytes: PIN_LIMITS.gateway,
}) : undefined;
await ipfsCache?.ready();

const sponsorSignerKey = process.env.SPONSOR_SIGNER_KEY;
if (sponsorSignerKey && !/^0x[0-9a-fA-F]{64}$/.test(sponsorSignerKey))
  throw new Error("SPONSOR_SIGNER_KEY must be a 32-byte hex private key");
// The deploying sender the verifier looks for behind the canonical forwarder.
const sponsorSigner = sponsorSignerKey ? privateKeyToAccount(sponsorSignerKey as Hex) : undefined;
const pool = createPool(connectionString);
await migrate(pool);
const deploymentVerifier = new RpcDeploymentVerifier(
  canonicalDeploymentChains(rpcUpstreams),
  sponsorSigner?.address,
);
const store = new PostgresStore(pool);
const rpc = createRpcGateway(rpcUpstreams);
const pinning = filebaseRpcToken && pinataJwt
  ? new RedundantIpfsPinning(new FilebaseRpcStorage(filebaseRpcToken), pinataJwt)
  : undefined;
const mcp = createCenterMcp(store, {
  rpc,
  rpcSiteLimitPerMinute,
  centerFetch: (request) => app.fetch(request, { internal: MCP_CLIENT }),
  ...(pinning ? { pinning } : {}),
});
const metrics = new Metrics();
const rest = await createRestRuntime({
  pool, store, services: mcp.services, config: mcp.config, upstreams: rpcUpstreams, rpcSiteLimitPerMinute, metrics,
  ...(process.env.REST_PUBLIC_ORIGIN ? { audience: process.env.REST_PUBLIC_ORIGIN } : {}),
  executionConfiguration: await readRestExecutionConfiguration(process.env),
});
let sponsor: (SponsorRuntime & { stop(): Promise<void> }) | undefined;
if (sponsorSigner) {
  const sponsorPolicy = readSponsorPolicy(process.env);
  const sponsorRpcUrls = new Map([...rpcUpstreams].map(([chainId, urls]) => [chainId, urls[0]!]));
  const onSponsorEvent = (event: SponsorEvent) => {
    metrics.observeSponsorEvent(event as { event: string; wei?: string });
    console.info(JSON.stringify({ level: "info", service: "sponsor", ...event }));
  };
  const lane = createRelayrLane({
    chain: () => new SponsorshipChain(rest.rpc, DEFAULT_SPONSORSHIP_POLICY),
    catalog: rest.catalog,
    provider: new RelayrProvider(),
    rpcUrls: sponsorRpcUrls,
    signer: sponsorSigner,
    policy: sponsorPolicy,
    projectsAddress: PROJECTS,
    onEvent: onSponsorEvent,
  });
  const worker = createSponsorWorker({
    store,
    verifier: deploymentVerifier,
    lane,
    policy: sponsorPolicy,
    onEvent: onSponsorEvent,
  });
  sponsor = { ...worker, relay: (intent, chainId) => lane.relay(intent, chainId) };
}
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
    mcpMaxIntents: positiveInteger("MCP_MAX_INTENTS", 100_000),
    mcpMaxStorageBytes: positiveInteger("MCP_MAX_STORAGE_BYTES", 10_737_418_240),
    rpcRequestLimitPerMinute: positiveInteger("RPC_REQUEST_LIMIT_PER_MINUTE", 600),
    rpcSiteLimitPerMinute,
    rpcPublicRequestLimitPerMinute: positiveInteger("RPC_PUBLIC_REQUEST_LIMIT_PER_MINUTE", 120),
    rpcPublicSiteLimitPerMinute: positiveInteger("RPC_PUBLIC_SITE_LIMIT_PER_MINUTE", 5_000),
    publishPerPublisherPerDay: positiveInteger("PUBLISH_PER_PUBLISHER_PER_DAY", 20),
    publishPerIpPerHour: positiveInteger("PUBLISH_PER_IP_PER_HOUR", 60),
    metricsToken,
    metrics,
    rpc,
    ...(ipfsCache ? { ipfsCache } : {}),
    ...(pinning ? { pinning } : {}),
    ...(sponsor ? { sponsor } : {}),
  });
const runtime = createCenterServer(app.fetch, handler, {
  port,
  ...(rest.site.walletOrigins ? { walletOrigins: rest.site.walletOrigins } : {}),
  shutdownGraceMs: positiveInteger("SHUTDOWN_GRACE_MS", 25_000),
});
await runtime.listen();
console.log(`JB Center listening on :${port}, including /mcp and /api/v1${keptAlive ? "" : " (upstream connections not kept: undici major differs)"}`);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await runtime.close();
  } finally {
    try { await sponsor?.stop(); }
    finally {
      try { await rest.stop(); }
      finally { await pool.end(); }
    }
  }
};
const stop = () => void shutdown().catch(() => {
  console.error("JB Center shutdown failed");
  process.exitCode = 1;
});
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
