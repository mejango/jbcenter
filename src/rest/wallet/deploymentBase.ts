import { keccak256, padHex, toHex, type Address, type Hex } from "viem";
import { createRpcGateway, DWELLIR_RPC_HOSTS } from "../../rpc.js";
import { RestError, type RestBlockEvidence, type RestRpc } from "../core.js";
import { PRIVATE_TRACE_RESPONSE_LIMIT, PRIVATE_TRACE_TIMEOUT_MS } from "../rpc.js";
import type { ContractPin } from "../smartAccounts/types.js";
import { baseL1AttributesParameters } from "./baseReceiptFees.js";
import { observeBaseReceiptFees } from "./baseFeeObservation.js";
import { calculateBaseSignedFees } from "./deploymentFees.js";
import { walletDeploymentDispatchLimits as bounds } from "./deploymentDispatch.js";
import { enrollmentDigest } from "./enrollment.js";
import { createWalletDeploymentSettlementObserver } from "./deploymentSettlementObserver.js";
import { createWalletDeploymentTransport, walletDeploymentQuantity, type WalletDeploymentRpcScope } from "./deploymentTransport.js";
import type { WalletDeploymentEnvironment } from "./deploymentSettlement.js";

/** Base mainnet identity and the fee predeploy runtimes reproduced byte for byte from public
 * source (base/base 9469da27403d6836634639b4899a6e4a0964720f; Sourcify records and observations in
 * docs/rest/evidence/wallet-delivery-2026-09-15). A later Base upgrade that replaces an
 * implementation makes every observation fail closed until the new runtime is reviewed and pinned. */
export const baseWalletChainPins = Object.freeze({
  chainId: 8453 as const,
  genesisHash: "0xf712aa9241cc24369b143cf6dce85f0902a9731e70d66818a3a5845b296c73dd" as Hex,
  implementationSlot: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex,
  proxyRuntimeCodeHash: "0x1f958654ab06a152993e7a0ae7b6dbb0d4b19265cc9337b8789fe1353bd9dc35" as Hex,
  predeploys: [
    { name: "L1Block", address: "0x4200000000000000000000000000000000000015" as Address,
      implementation: "0x3ba4007f5c922fbb33c454b41ea7a1f11e83df2c" as Address,
      implementationRuntimeCodeHash: "0x5f885ca815d2cf27a203123e50b8ae204fdca910b6995d90b2d7700cbb9240d1" as Hex },
    { name: "GasPriceOracle", address: "0x420000000000000000000000000000000000000f" as Address,
      implementation: "0x4f1db3c6abd250ba86e0928471a8f7db3afd88f1" as Address,
      implementationRuntimeCodeHash: "0xe9fc7c96c4db0d6078e3d359d7e8c982c350a513cb2c31121adf5e1e8a446614" as Hex },
  ],
});
export const baseWalletDeploymentLimits = Object.freeze({
  // Measured 2026-09-15 against Center's Dwellir archive: identity 1.7 s, reservation 0.8 s, funding 3.1 s.
  transport: { rpcCalls: 64, rpcTimeoutMs: 5000, totalTimeoutMs: 20_000, responseBytes: 1024 * 1024, admissionLifetimeMs: 20_000 },
  settlement: { rpcCalls: 320, rpcTimeoutMs: 3000, totalTimeoutMs: 30_000, responseBytes: 8 * 1024 * 1024 },
  evidenceLifetimeMs: 60_000,
});
const readMethods = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getCode", "eth_getStorageAt", "eth_getBalance",
  "eth_getTransactionCount", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_call", "eth_estimateGas",
  "eth_getTransactionByBlockHashAndIndex", "eth_getRawTransactionByHash", "eth_getLogs", "debug_traceTransaction"]);
function invalid(): never { throw new RestError(500, "WALLET_DEPLOYMENT_BASE_INVALID", "The Base deployment adapter requires Center's Dwellir endpoint and reviewed pins."); }
function unavailable(detail?: Record<string, string | number>): never {
  throw new RestError(502, "WALLET_DEPLOYMENT_BASE_UNAVAILABLE", "The configured Base provider could not prove the pinned chain and fee runtimes.", detail);
}
/** A bounded, URL-free description of an upstream failure for the log: never the provider's payload. */
function upstreamReason(error: unknown): string {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  const text = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  return text.replace(/https?:\/\/\S+/g, "<url>").slice(0, 120);
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function word(value: unknown): value is Hex { return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) && BigInt(value) !== 0n; }
const quantity = (value: unknown) => walletDeploymentQuantity(value, unavailable);
const same = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

export interface BaseWalletDeploymentOptions {
  /** Center's Dwellir Base archive URL, or a loopback fixture. Never a public fallback. */
  url: string;
  /** Test fixtures pin their own genesis; production uses the reviewed Base genesis. */
  genesisHash?: Hex;
  now?: () => number;
}

export function createBaseWalletDeploymentReader(options: BaseWalletDeploymentOptions) {
  if (!options || typeof options.url !== "string" || (options.now !== undefined && typeof options.now !== "function") ||
      (options.genesisHash !== undefined && !word(options.genesisHash))) invalid();
  let endpoint: URL;
  try { endpoint = new URL(options.url); } catch { return invalid(); }
  const loopback = endpoint.protocol === "http:" && /^127\.0\.0\.1$/.test(endpoint.hostname) && /^[1-9][0-9]{0,4}$/.test(endpoint.port);
  const dwellir = endpoint.protocol === "https:" && endpoint.hostname === DWELLIR_RPC_HOSTS[8453] && !endpoint.username && !endpoint.password;
  if (!(loopback || dwellir) || endpoint.search || endpoint.hash) invalid();
  const genesisHash = (options.genesisHash ?? baseWalletChainPins.genesisHash).toLowerCase() as Hex;
  // One URL only. The shared gateway list would fail over to a public provider for reads and could repeat a send.
  const upstream = new Map([[8453, [endpoint.href]]]), fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init);
  const gateways = { reads: createRpcGateway(upstream, fetcher, { timeoutMs: 5000, responseLimitBytes: 8 * 1024 * 1024 }),
    traces: createRpcGateway(upstream, fetcher, { timeoutMs: PRIVATE_TRACE_TIMEOUT_MS, responseLimitBytes: PRIVATE_TRACE_RESPONSE_LIMIT }),
    send: createRpcGateway(upstream, fetcher, { timeoutMs: bounds.sendTimeoutMs, responseLimitBytes: 65536 }) };
  let sequence = 0;
  async function request(method: string, params: readonly unknown[], signal?: AbortSignal): Promise<unknown> {
    const gateway = method === "eth_sendRawTransaction" ? gateways.send : method === "debug_traceTransaction" ? gateways.traces : gateways.reads;
    let answer: unknown;
    try { answer = await gateway.request(8453, { jsonrpc: "2.0", id: ++sequence, method, params }, signal); }
    catch (error) { if (signal?.aborted) throw error; unavailable({ method, upstream: upstreamReason(error) }); }
    if (!record(answer) || !Object.hasOwn(answer, "result") || answer.error) {
      const failure = record(answer) && record(answer.error) ? answer.error : null;
      // The gateway already replaces the provider's error message; its code is the useful part.
      unavailable({ method, ...(failure ? { rpcCode: Number(failure.code) } : { envelope: "invalid" }) });
    }
    return answer.result;
  }
  const reads: RestRpc = { request(chain, method, params, signal) {
    if (chain !== 8453 || !readMethods.has(method)) invalid();
    return request(method, params, signal);
  } };
  async function identity(rpc: WalletDeploymentRpcScope, at?: RestBlockEvidence): Promise<WalletDeploymentEnvironment> {
    const tag = at ? { blockHash: at.blockHash, requireCanonical: true as const } : "latest";
    const [chain, genesis] = await Promise.all([rpc.request("eth_chainId", []), rpc.request("eth_getBlockByNumber", ["0x0", false])]);
    if (quantity(chain) !== 8453n || !record(genesis) || quantity(genesis.number) !== 0n || !same(genesis.hash, genesisHash)) unavailable({ check: "chain-identity" });
    await Promise.all(baseWalletChainPins.predeploys.map(async pin => {
      const [proxyCode, implementation, implementationCode] = await Promise.all([
        rpc.request("eth_getCode", [pin.address, tag]), rpc.request("eth_getStorageAt", [pin.address, baseWalletChainPins.implementationSlot, tag]),
        rpc.request("eth_getCode", [pin.implementation, tag]),
      ]);
      if (typeof proxyCode !== "string" || !/^0x(?:[0-9a-fA-F]{2}){1,49152}$/.test(proxyCode) || keccak256(proxyCode as Hex) !== baseWalletChainPins.proxyRuntimeCodeHash ||
          typeof implementation !== "string" || !same(implementation, padHex(pin.implementation, { size: 32 })) ||
          typeof implementationCode !== "string" || !/^0x(?:[0-9a-fA-F]{2}){1,49152}$/.test(implementationCode) ||
          keccak256(implementationCode as Hex) !== pin.implementationRuntimeCodeHash) unavailable({ check: "predeploy", address: pin.address });
    }));
    return { kind: "base-mainnet", genesisHash };
  }
  /** L1 and operator pricing from the head block's own attributes deposit, for the exact signed bytes. */
  async function reserve(rpc: WalletDeploymentRpcScope, head: RestBlockEvidence, rawTransaction: Hex) {
    const block = await rpc.request("eth_getBlockByNumber", [toHex(BigInt(head.blockNumber)), false]);
    if (!record(block) || !same(block.hash, head.blockHash) || !Array.isArray(block.transactions) || !word(block.transactions[0])) unavailable({ check: "head-block" });
    const attributes = await rpc.request("eth_getTransactionByHash", [block.transactions[0]]);
    if (!record(attributes) || !same(attributes.hash, block.transactions[0]) || !same(attributes.blockHash, head.blockHash) ||
        quantity(attributes.blockNumber) !== BigInt(head.blockNumber) || quantity(attributes.transactionIndex) !== 0n) unavailable({ check: "l1-attributes" });
    const { parameters } = baseL1AttributesParameters(attributes);
    const priced = calculateBaseSignedFees({ rawTransaction, parameters });
    const digest = enrollmentDigest(Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, String(value)])));
    return { attributesTransaction: block.transactions[0].toLowerCase() as Hex, parametersDigest: digest,
      l1WeiAtParameters: String(priced.l1FeeAtParameters), operatorMaximumWei: String(priced.operatorMaximumAtParameters) };
  }
  return { genesisHash, reads, identity, reserve, send: (raw: Hex, signal: AbortSignal) => request("eth_sendRawTransaction", [raw], signal) };
}

/** Hosted Base creation transport. Sends once through Center's Dwellir endpoint after a fresh
 * pinned-runtime identity check and a complete-fee reservation against the remaining allocation. */
export function createBaseWalletDeploymentTransport(options: BaseWalletDeploymentOptions) {
  const reader = createBaseWalletDeploymentReader(options);
  return createWalletDeploymentTransport({ kind: "base-mainnet", genesisHash: reader.genesisHash, reads: reader.reads,
    limits: baseWalletDeploymentLimits.transport, identity: reader.identity, send: reader.send, reserve: reader.reserve,
    ...(options.now ? { now: options.now } : {}) });
}

/** Hosted Base settlement producer: finalized exact receipt, verified Fjord/Jovian fees at the
 * inclusion block and a fresh funding read. It cannot release a lane; the durable store settles. */
export function createBaseWalletDeploymentSettlement(options: BaseWalletDeploymentOptions & { utility: ContractPin }) {
  const reader = createBaseWalletDeploymentReader(options);
  return createWalletDeploymentSettlementObserver({ kind: "base-mainnet", genesisHash: reader.genesisHash, reads: reader.reads,
    limits: baseWalletDeploymentLimits.settlement, identity: reader.identity, utility: options.utility,
    evidenceLifetimeMs: baseWalletDeploymentLimits.evidenceLifetimeMs, ...(options.now ? { now: options.now } : {}),
    fees: async (rpc, context, observation) => {
      const receipt = observation.transaction.receipt!;
      const fees = await observeBaseReceiptFees(rpc, context.operation.signed!.rawTransaction, receipt.block);
      if (fees.transactionHash !== context.operation.signed!.hash || fees.transactionIndex !== BigInt(receipt.transactionIndex) ||
          fees.gasUsed !== BigInt(receipt.gasUsed) || fees.effectiveGasPrice !== BigInt(receipt.effectiveGasPrice) ||
          fees.status !== receipt.status || fees.executionWei !== BigInt(observation.fees.executionWei!)) unavailable({ check: "settlement-fees" });
      return { profile: "base-fjord-jovian-receipt-v1", executionWei: String(fees.executionWei), l1Wei: String(fees.l1Wei),
        operatorWei: String(fees.operatorWei), totalWei: String(fees.totalWei) };
    } });
}
