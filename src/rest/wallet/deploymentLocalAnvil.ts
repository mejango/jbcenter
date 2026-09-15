import type { Hex } from "viem";
import { createRpcGateway } from "../../rpc.js";
import { RestError, type RestRpc } from "../core.js";
import { walletDeploymentDispatchLimits as bounds } from "./deploymentDispatch.js";
import { createWalletDeploymentTransport, walletDeploymentQuantity, type WalletDeploymentRpcScope } from "./deploymentTransport.js";
import type { WalletDeploymentEnvironment } from "./deploymentSettlement.js";

const readMethods = new Set(["web3_clientVersion", "anvil_nodeInfo", "anvil_metadata", "eth_chainId", "eth_getBlockByNumber",
  "eth_getCode", "eth_getBalance", "eth_getTransactionCount", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_call", "eth_estimateGas",
  "eth_getBlockByHash", "eth_getStorageAt", "eth_getTransactionByBlockHashAndIndex", "eth_getRawTransactionByHash", "eth_getLogs", "debug_traceTransaction"]);
export const localAnvilWalletDeploymentLimits = Object.freeze({ rpcCalls: 64, rpcTimeoutMs: 2000, totalTimeoutMs: 5000, responseBytes: 1024 * 1024, admissionLifetimeMs: 5000 });
function invalid(): never { throw new RestError(403, "WALLET_DEPLOYMENT_LOCAL_INVALID", "A current exact local deployment capability is required."); }
function unavailable(): never { throw new RestError(502, "WALLET_DEPLOYMENT_LOCAL_UNAVAILABLE", "The configured local chain could not verify deployment admission."); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function word(value: unknown): value is Hex { return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) && BigInt(value) !== 0n; }
const quantity = (value: unknown) => walletDeploymentQuantity(value, unavailable);

function localEndpoint(options: { endpoint: string; expectedGenesisHash: Hex; now?: () => number }): URL {
  // Validate the literal spelling before URL normalization. No DNS or remote destinations.
  if (!options || typeof options.endpoint !== "string" ||
      !/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}\/?$/.test(options.endpoint) ||
      !word(options.expectedGenesisHash) || (options.now !== undefined && typeof options.now !== "function")) invalid();
  const endpoint = new URL(options.endpoint);
  if (!endpoint.port || Number(endpoint.port) > 65535) invalid();
  return endpoint;
}

/** Shared read-only local endpoint. Actual identity is returned so initialized accounting can
 * retain a proved environment change as a fence; an unavailable/malformed identity still fails. */
export function createLocalAnvilWalletDeploymentReader(options: { endpoint: string; expectedGenesisHash: Hex; now?: () => number }) {
  const endpoint = localEndpoint(options);
  // One endpoint only: the underlying gateway's generic URL failover must never repeat a send.
  // Resolve fetch per call so fixtures can inject lost replies around one physical send.
  const gateway = createRpcGateway(new Map([[8453, [endpoint.href]]]), (input, init) => globalThis.fetch(input, init), { timeoutMs: bounds.sendTimeoutMs, responseLimitBytes: 524288 });
  let sequence = 0;
  async function request(method: string, params: readonly unknown[], signal?: AbortSignal): Promise<unknown> {
    const answer = await gateway.request(8453, { jsonrpc: "2.0", id: ++sequence, method, params }, signal);
    if (!record(answer) || answer.error || !Object.hasOwn(answer, "result")) unavailable();
    return answer.result;
  }
  const reads: RestRpc = { request(chain, method, params, signal) {
    if (chain !== 8453 || !readMethods.has(method)) invalid();
    return request(method, params, signal);
  } };
  return { reads, send: (raw: Hex, signal: AbortSignal) => request("eth_sendRawTransaction", [raw], signal),
    async identity(rpc: WalletDeploymentRpcScope): Promise<WalletDeploymentEnvironment> {
    const [chain, client, node, metadata, genesis] = await Promise.all([
      rpc.request("eth_chainId", []), rpc.request("web3_clientVersion", []), rpc.request("anvil_nodeInfo", []),
      rpc.request("anvil_metadata", []), rpc.request("eth_getBlockByNumber", ["0x0", false]),
    ]);
    if (quantity(chain) !== 8453n || typeof client !== "string" || !/^anvil\/v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/.test(client) ||
        !record(node) || node.hardFork !== "Cancun" || !record(node.environment) || node.environment.chainId !== 8453 ||
        !record(node.forkConfig) || node.forkConfig.forkUrl !== null || node.forkConfig.forkBlockNumber !== null || node.forkConfig.forkRetryBackoff !== null ||
        !record(metadata) || metadata.clientVersion !== client || metadata.chainId !== 8453 || metadata.forkedNetwork !== null || !word(metadata.instanceId) ||
        !record(genesis) || quantity(genesis.number) !== 0n || !word(genesis.hash)) unavailable();
    return { kind: "unforked-anvil", genesisHash: genesis.hash.toLowerCase() as Hex, instanceId: metadata.instanceId.toLowerCase() as Hex };
  } };
}

/** Explicit host-created experimental capability. It has no app route, key, database, production
 * fee claim or configurable remote provider. Each admission authorizes at most one local attempt. */
export function createLocalAnvilWalletDeploymentTransport(options: { endpoint: string; expectedGenesisHash: Hex; now?: () => number }) {
  const local = createLocalAnvilWalletDeploymentReader(options);
  return createWalletDeploymentTransport({ kind: "unforked-anvil", genesisHash: options.expectedGenesisHash.toLowerCase() as Hex,
    reads: local.reads, limits: localAnvilWalletDeploymentLimits, identity: local.identity, send: local.send, ...(options.now ? { now: options.now } : {}) });
}
