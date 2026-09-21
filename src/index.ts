import { createHttpHandler, createMcpServer } from "@juicebox/mcp/host";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { keepUpstreamConnections } from "./keepAlive.js";
import { createApp } from "./app.js";
import { migrate } from "./db/migrate.js";
import { createPool, PostgresStore } from "./db/postgres.js";
import { canonicalDeploymentChains, PROJECTS, RpcDeploymentVerifier } from "./deploymentVerifier.js";
import { FilebaseRpcStorage, PIN_LIMITS, RedundantIpfsPinning } from "./ipfs.js";
import { IpfsDiskCache } from "./ipfsCache.js";
import { createRpcGateway, dwellirRpcUpstreams } from "./rpc.js";
import { createCenterMcp } from "./mcp.js";
import { createCenterServer } from "./server.js";
import { createRestRuntime, type RestWalletConfiguration } from "./rest/runtime.js";
import { createBaseWalletProductionStack } from "./rest/wallet/productionStack.js";
import { createBaseWalletDeviceHost, createBaseWalletRecoveryHost, createBaseWalletSignupHost } from "./rest/wallet/baseHost.js";
import { DWELLIR_RPC_HOSTS } from "./rpc.js";
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
// Hosted wallet: mounted only with an explicit origin. Creation additionally needs every treasury
// setting; a partial configuration fails startup rather than exposing an incomplete journey.
const walletOrigin = process.env.WALLET_ORIGIN;
const creationSettings = ["WALLET_CREATION_SIGNER_KEY", "WALLET_CREATION_POOL_ID", "WALLET_CREATION_ALLOCATION_WEI", "WALLET_CREATION_INITIAL_NONCE"] as const;
const creationConfigured = creationSettings.filter(name => process.env[name]);
if (creationConfigured.length && (creationConfigured.length !== creationSettings.length || !walletOrigin))
  throw new Error("Hosted wallet creation requires WALLET_ORIGIN and every WALLET_CREATION_* setting together");
const recoverySettings = ["WALLET_RECOVERY_SIGNER_KEY", "WALLET_RECOVERY_MAX_OPERATIONS", "WALLET_RECOVERY_MAX_COST_WEI"] as const;
const recoveryConfigured = recoverySettings.filter(name => process.env[name]);
if (recoveryConfigured.length && (recoveryConfigured.length !== recoverySettings.length || !walletOrigin))
  throw new Error("Hosted wallet recovery requires WALLET_ORIGIN and every WALLET_RECOVERY_* setting together");
const walletStack = walletOrigin ? await createBaseWalletProductionStack() : undefined;
const dwellirBaseUrl = `https://${DWELLIR_RPC_HOSTS[8453]}/${process.env.DWELLIR_API_KEY}`;
// WALLET_LEGACY_ORIGINS: comma-separated former wallet origins that now redirect to WALLET_ORIGIN.
const walletLegacyOrigins = (process.env.WALLET_LEGACY_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean);
// WALLET_FRAMEABLE_APP_ORIGINS: comma-separated app origins admitted to frame their own payment reviews.
const walletFrameableAppOrigins = (process.env.WALLET_FRAMEABLE_APP_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean);
const wallet: RestWalletConfiguration | undefined = walletOrigin && walletStack
  ? { origin: walletOrigin, manifest: walletStack.manifest, utility: walletStack.utility, ...(walletLegacyOrigins.length ? { legacyOrigins: walletLegacyOrigins } : {}),
      ...(walletFrameableAppOrigins.length ? { frameableAppOrigins: walletFrameableAppOrigins } : {}),
      basePath: "",
      // Payment reviews: Base USDC through the catalog-pinned V6 terminal.
      payments: walletStack.payments,
      // WALLET_NETWORKS_PAYER_KEY funds Relayr bundles that deploy the account on more chains (Base
      // for Optimism/Arbitrum, Base Sepolia for testnets). Absent, "Add more" stays off.
      ...(process.env.WALLET_NETWORKS_PAYER_KEY ? { networksPayerKey: process.env.WALLET_NETWORKS_PAYER_KEY as `0x${string}` } : {}) } : undefined;
if (process.env.WALLET_NETWORKS_PAYER_KEY && !/^0x[0-9a-fA-F]{64}$/.test(process.env.WALLET_NETWORKS_PAYER_KEY))
  throw new Error("WALLET_NETWORKS_PAYER_KEY must be a 32-byte hex private key");
const rest = await createRestRuntime({
  ...(process.env.PARA_API_KEY ? { para: { apiKey: process.env.PARA_API_KEY, environment: paraEnvironment } } : {}),
  ...(wallet ? { wallet } : {}),
  ...(wallet && walletStack && creationConfigured.length ? { walletSignup: (context: Parameters<typeof createBaseWalletSignupHost>[0]) =>
    createBaseWalletSignupHost(context, { url: dwellirBaseUrl,
      signerKey: process.env.WALLET_CREATION_SIGNER_KEY as `0x${string}`, poolId: process.env.WALLET_CREATION_POOL_ID!,
      allocationWei: process.env.WALLET_CREATION_ALLOCATION_WEI!, initialNonce: process.env.WALLET_CREATION_INITIAL_NONCE!,
      manifest: walletStack.manifest, utility: walletStack.utility,
      // Idle worker passes happen every second; only work and failures are worth a log line.
      onEvent: event => { if (event.stage !== "worker" || event.outcome !== "pass") console.info(JSON.stringify({ service: "wallet", action: "creation", ...event })); } }) } : {}),
  ...(wallet && walletStack && recoveryConfigured.length ? { walletDevices: (context: Parameters<typeof createBaseWalletDeviceHost>[0]) =>
    createBaseWalletDeviceHost(context, { url: dwellirBaseUrl, signerKey: process.env.WALLET_RECOVERY_SIGNER_KEY as `0x${string}`,
      maximumOperations: positiveInteger("WALLET_RECOVERY_MAX_OPERATIONS", 1), maximumCostWei: process.env.WALLET_RECOVERY_MAX_COST_WEI!,
      manifest: walletStack.manifest, utility: walletStack.utility,
      onDeviceEvent: event => console.info(JSON.stringify({ service: "wallet", action: "device", ...event })) }) } : {}),
  ...(wallet && walletStack && recoveryConfigured.length ? { walletRecovery: (context: Parameters<typeof createBaseWalletRecoveryHost>[0]) =>
    createBaseWalletRecoveryHost(context, { url: dwellirBaseUrl, signerKey: process.env.WALLET_RECOVERY_SIGNER_KEY as `0x${string}`,
      maximumOperations: positiveInteger("WALLET_RECOVERY_MAX_OPERATIONS", 1), maximumCostWei: process.env.WALLET_RECOVERY_MAX_COST_WEI!,
      manifest: walletStack.manifest, utility: walletStack.utility,
      onEvent: event => console.info(JSON.stringify({ service: "wallet", action: "recovery", ...event })) }) } : {}),
  pool, store, services: mcp.services, config: mcp.config, upstreams: rpcUpstreams, rpcSiteLimitPerMinute, metrics,
  ...(process.env.REST_PUBLIC_ORIGIN ? { audience: process.env.REST_PUBLIC_ORIGIN } : {}),
  executionConfiguration: await readRestExecutionConfiguration(process.env),
});
const sponsorSignerKey = process.env.SPONSOR_SIGNER_KEY;
let sponsor: (SponsorRuntime & { stop(): Promise<void> }) | undefined;
if (sponsorSignerKey) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(sponsorSignerKey)) throw new Error("SPONSOR_SIGNER_KEY must be a 32-byte hex private key");
  const signer = privateKeyToAccount(sponsorSignerKey as Hex);
  const sponsorPolicy = readSponsorPolicy(process.env);
  const sponsorRpcUrls = new Map([...rpcUpstreams].map(([chainId, urls]) => [chainId, urls[0]!]));
  const onSponsorEvent = (event: SponsorEvent) => {
    metrics.observeSponsorEvent(event as { event: string; wei?: string });
    console.info(JSON.stringify({ level: "info", service: "sponsor", ...event }));
  };
  const lane = createRelayrLane({
    chain: new SponsorshipChain(rest.rpc, DEFAULT_SPONSORSHIP_POLICY),
    catalog: rest.catalog,
    provider: new RelayrProvider(),
    rpcUrls: sponsorRpcUrls,
    signer,
    policy: sponsorPolicy,
    projectsAddress: PROJECTS,
    onEvent: onSponsorEvent,
  });
  sponsor = createSponsorWorker({
    store,
    verifier: deploymentVerifier,
    lane,
    policy: sponsorPolicy,
    onEvent: onSponsorEvent,
  });
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
    rpcRequestLimitPerMinute: positiveInteger("RPC_REQUEST_LIMIT_PER_MINUTE", 600),
    rpcSiteLimitPerMinute,
    rpcPublicRequestLimitPerMinute: positiveInteger("RPC_PUBLIC_REQUEST_LIMIT_PER_MINUTE", 120),
    rpcPublicSiteLimitPerMinute: positiveInteger("RPC_PUBLIC_SITE_LIMIT_PER_MINUTE", 5_000),
    metricsToken,
    metrics,
    rpc,
    ...(ipfsCache ? { ipfsCache } : {}),
    ...(pinning ? { pinning } : {}),
    ...(sponsor ? { sponsor } : {}),
  });
const runtime = createCenterServer(app.fetch, handler, {
  port,
  shutdownGraceMs: positiveInteger("SHUTDOWN_GRACE_MS", 25_000),
});
await runtime.listen();
console.log(`JB Center listening on :${port}, including /mcp and /api/v1${keptAlive ? "" : " (upstream connections not kept: undici major differs)"}`);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await runtime.close();
  await sponsor?.stop();
  await rest.stop();
  await pool.end();
};
const stop = () => void shutdown().catch(() => {
  console.error("JB Center shutdown failed");
  process.exitCode = 1;
});
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
