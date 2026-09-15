import { encodeAbiParameters, keccak256, toHex, type Hex } from "viem";
import { createRpcGateway } from "../../rpc.js";
import { RestError, type RestBlockEvidence, type RestRpc } from "../core.js";
import { inspectPasskeyCreationSigner } from "../smartAccounts/passkeyProfile.js";
import { walletDeploymentRelayPolicy } from "./deploymentPostgres.js";
import { validateSignedWalletDeployment } from "./deployment.js";
import { enrollmentDigest } from "./enrollment.js";
import { assertWalletDeploymentObservation } from "./deploymentObservation.js";
import { walletDeploymentDispatchLimits as bounds, type WalletDeploymentDispatchAdmission, type WalletDeploymentExecutionContext } from "./deploymentDispatch.js";
import { operationRpc } from "./operationRpc.js";
import { assertWalletDeploymentAccounting, walletDeploymentAccountingDigest, walletDeploymentRemainingWei,
  type WalletDeploymentLocalEnvironment } from "./deploymentSettlement.js";

const readMethods = new Set(["web3_clientVersion", "anvil_nodeInfo", "anvil_metadata", "eth_chainId", "eth_getBlockByNumber",
  "eth_getCode", "eth_getBalance", "eth_getTransactionCount", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_call", "eth_estimateGas",
  "eth_getBlockByHash", "eth_getStorageAt", "eth_getTransactionByBlockHashAndIndex", "eth_getRawTransactionByHash", "eth_getLogs", "debug_traceTransaction"]);
const limits = Object.freeze({ rpcCalls: 64, rpcTimeoutMs: 2000, totalTimeoutMs: 5000, responseBytes: 1024 * 1024 });
function invalid(): never { throw new RestError(403, "WALLET_DEPLOYMENT_LOCAL_INVALID", "A current exact local deployment capability is required."); }
function unavailable(): never { throw new RestError(502, "WALLET_DEPLOYMENT_LOCAL_UNAVAILABLE", "The configured local chain could not verify deployment admission."); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function word(value: unknown): value is Hex { return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) && BigInt(value) !== 0n; }
function quantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value)) unavailable();
  return BigInt(value);
}
function decimal(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) >= 1n << 256n) invalid();
  return BigInt(value);
}
function same(a: unknown, b: unknown): boolean { return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase(); }
function time(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
function block(value: unknown, now: number) {
  if (!record(value) || !word(value.hash)) unavailable();
  const number = quantity(value.number), timestamp = quantity(value.timestamp), baseFee = quantity(value.baseFeePerGas);
  if (timestamp * 1000n > BigInt(now + 30_000) || timestamp * 1000n + 300_000n <= BigInt(now)) unavailable();
  const head: RestBlockEvidence = { chainId: 8453, blockNumber: String(number), blockHash: value.hash.toLowerCase() as Hex,
    timestamp: String(timestamp), source: "onchain" };
  return { head, baseFee };
}

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
  const gateway = createRpcGateway(new Map([[8453, [endpoint.href]]]), fetch, { timeoutMs: bounds.sendTimeoutMs, responseLimitBytes: 524288 });
  let sequence = 0;
  const reads: RestRpc = { async request(chain, method, params, signal) {
    if (chain !== 8453 || !readMethods.has(method)) invalid();
    const answer = await gateway.request(8453, { jsonrpc: "2.0", id: ++sequence, method, params }, signal);
    if (!record(answer) || answer.error || !Object.hasOwn(answer, "result")) unavailable();
    return answer.result;
  } };
  return { reads, async identity(rpc: ReturnType<typeof operationRpc>): Promise<WalletDeploymentLocalEnvironment> {
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
export function createLocalAnvilWalletDeploymentTransport(options: {
  endpoint: string; expectedGenesisHash: Hex; now?: () => number;
}) {
  const endpoint = localEndpoint(options), local = createLocalAnvilWalletDeploymentReader(options);
  const genesisHash = options.expectedGenesisHash.toLowerCase() as Hex, now = options.now ?? Date.now;
  // One endpoint only: the underlying gateway's generic URL failover must never repeat a send.
  const gateway = createRpcGateway(new Map([[8453, [endpoint.href]]]), fetch, { timeoutMs: bounds.sendTimeoutMs, responseLimitBytes: 524288 });
  let sequence = 0;
  async function request(method: string, params: readonly unknown[], signal?: AbortSignal): Promise<unknown> {
    const answer = await gateway.request(8453, { jsonrpc: "2.0", id: ++sequence, method, params }, signal);
    if (!record(answer) || answer.error || !Object.hasOwn(answer, "result")) unavailable();
    return answer.result;
  }
  const reads = local.reads;
  type Scope = ReturnType<typeof operationRpc>;
  async function identity(rpc: Scope): Promise<Hex> {
    const environment = await local.identity(rpc);
    if (environment.kind !== "unforked-anvil" || !same(environment.genesisHash, genesisHash)) unavailable();
    return environment.instanceId;
  }
  const capabilities = new WeakMap<WalletDeploymentDispatchAdmission, { digest: string; raw: Hex; hash: Hex; instance: Hex; deadline: number }>();
  return {
    async admit(input: WalletDeploymentExecutionContext, signal?: AbortSignal): Promise<WalletDeploymentDispatchAdmission> {
      // The context is loaded by the coordinator. Its shape cannot establish database provenance.
      enrollmentDigest(input); const context = structuredClone(input), observedAt = now(), deadline = performance.now() + limits.totalTimeoutMs;
      if (!time(observedAt)) invalid();
      const { pool, enrollment, operation } = context, config = pool.configuration;
      const accounting = pool.accounting ? assertWalletDeploymentAccounting(pool.accounting, pool) : null;
      const remainingWei = walletDeploymentRemainingWei(pool);
      if (accounting && (accounting.fence || accounting.nextNonce !== operation.template?.transaction.nonce ||
          accounting.environment.kind !== "unforked-anvil" || accounting.environment.genesisHash !== genesisHash)) invalid();
      const observation = assertWalletDeploymentObservation(operation.observation);
      if (pool.state !== "active" || pool.activeOperationId !== operation.id || config.chainId !== 8453 ||
          pool.configurationDigest !== enrollmentDigest(config) || operation.poolConfigurationDigest !== pool.configurationDigest ||
          operation.poolId !== config.id || operation.enrollmentId !== enrollment.intent.id || operation.id !== operation.approval.id ||
          operation.state !== "signed" || !operation.signed || !operation.template || !operation.admission ||
          !Number.isSafeInteger(operation.revision) || operation.revision < 1 || !same(operation.template.sender, config.sender) ||
          observation.operationId !== operation.id || observation.transactionHash !== operation.signed.hash || observation.templateCommitment !== operation.templateCommitment ||
          observation.transaction.state !== "not-observed" || observation.wallet.state !== "undeployed" || !observation.head ||
          !same(observation.wallet.address, enrollment.creation!.address) || observation.wallet.initializerHash !== enrollment.creation!.initializerHash ||
          observation.observedAt > observedAt || observedAt - observation.observedAt >= config.policy.maximumObservationAgeMs ||
          !Number.isSafeInteger(config.policy.maximumObservationAgeMs) || config.policy.maximumObservationAgeMs < 1 || config.policy.maximumObservationAgeMs > 30000 ||
          observation.transaction.nonce?.confirmed !== operation.template.transaction.nonce || observation.transaction.nonce.pending !== operation.template.transaction.nonce ||
          operation.historicalCanonicalObservation?.finality.state === "finalized") invalid();
      const policy = walletDeploymentRelayPolicy(config);
      const signed = await validateSignedWalletDeployment({ enrollment, approval: operation.approval, template: operation.template,
        rawTransaction: operation.signed.rawTransaction, policy });
      if (signed.hash !== operation.signed.hash || signed.templateCommitment !== operation.templateCommitment ||
          signed.maximumExecutionCost !== operation.signed.maximumExecutionCost || decimal(remainingWei) < BigInt(signed.maximumExecutionCost)) invalid();
      const expiresAt = Math.min(observedAt + bounds.admissionLifetimeMs, observation.observedAt + config.policy.maximumObservationAgeMs,
        Number((BigInt(observation.head.timestamp) + 300n) * 1000n));
      function fresh() { const current = now(); if (!time(current) || current < observedAt || current >= expiresAt || performance.now() >= deadline) invalid(); }
      const rpc = operationRpc(reads, limits, signal);
      try {
        fresh(); const instance = await identity(rpc);
        if (accounting && (accounting.environment.kind !== "unforked-anvil" || instance !== accounting.environment.instanceId)) unavailable();
        const latest = block(await rpc.request("eth_getBlockByNumber", ["latest", false]), observedAt), head = latest.head;
        if (enrollmentDigest(head) !== enrollmentDigest(observation.head) ||
            (operation.highestObservedHead !== null && BigInt(head.blockNumber) < decimal(operation.highestObservedHead))) invalid();
        const observedBlock = block(await rpc.request("eth_getBlockByNumber", [toHex(BigInt(observation.head.blockNumber)), false]), observedAt);
        if (enrollmentDigest(observedBlock.head) !== enrollmentDigest(observation.head)) unavailable();
        async function settlementAnchor() {
          if (!accounting?.lastSettlementAnchor) return;
          const prior = accounting.lastSettlementAnchor, current = await rpc.request("eth_getBlockByNumber", [toHex(BigInt(prior.blockNumber)), false]);
          if (!record(current) || !same(current.hash, prior.blockHash) || quantity(current.number) !== BigInt(prior.blockNumber) ||
              quantity(current.timestamp) !== BigInt(prior.timestamp)) unavailable();
        }
        await settlementAnchor();
        const tag = { blockHash: head.blockHash, requireCanonical: true as const }, tx = operation.template.transaction;
        const snapshot = { evidence: head, tag, request: (method: string, params: readonly unknown[]) => rpc.request(method, [...params, tag]) };
        const manifest = enrollment.intent.manifest;
        const pins = [manifest.singleton, manifest.factory, manifest.safe7579, manifest.launchpad, manifest.entryPoint!, manifest.smartSessions,
          manifest.creationProfile!.multiSend, ...manifest.policies];
        for (let start = 0; start < pins.length; start += 8) await Promise.all(pins.slice(start, start + 8).map(async pin => {
          const code = await snapshot.request("eth_getCode", [pin.address]);
          if (typeof code !== "string" || !/^0x(?:[0-9a-fA-F]{2}){1,49152}$/.test(code) || !same(keccak256(code as Hex), pin.runtimeCodeHash)) unavailable();
        }));
        const signer = await inspectPasskeyCreationSigner({ manifest, publicKey: enrollment.candidate!.publicKey, snapshot });
        if (!same(signer.address, enrollment.creation!.bootstrap.signerAddress)) unavailable();
        const [balanceRaw, confirmedRaw, pendingRaw, receipt, transaction, ...codes] = await Promise.all([
          snapshot.request("eth_getBalance", [config.sender]), snapshot.request("eth_getTransactionCount", [config.sender]),
          rpc.request("eth_getTransactionCount", [config.sender, "pending"]), rpc.request("eth_getTransactionReceipt", [signed.hash]),
          rpc.request("eth_getTransactionByHash", [signed.hash]), ...[config.sender, enrollment.intent.recoveryOwner, enrollment.creation!.address]
            .map(address => snapshot.request("eth_getCode", [address])),
        ]);
        const balance = quantity(balanceRaw), nonce = BigInt(tx.nonce);
        if (receipt !== null || transaction !== null || codes.some(code => code !== "0x") || quantity(confirmedRaw) !== nonce || quantity(pendingRaw) !== nonce ||
            balance < decimal(remainingWei) || balance < BigInt(signed.maximumExecutionCost) ||
            BigInt(tx.maxFeePerGas) < latest.baseFee + BigInt(tx.maxPriorityFeePerGas)) unavailable();
        const call = { type: "0x2", from: config.sender, to: tx.to, data: tx.data, value: "0x0", nonce: toHex(nonce),
          gas: toHex(BigInt(tx.gas)), maxFeePerGas: toHex(BigInt(tx.maxFeePerGas)), maxPriorityFeePerGas: toHex(BigInt(tx.maxPriorityFeePerGas)), accessList: [] };
        const [simulation, estimated] = await Promise.all([snapshot.request("eth_call", [call]), rpc.request("eth_estimateGas", [call, toHex(BigInt(head.blockNumber))])]);
        if (!same(simulation, encodeAbiParameters([{ type: "address" }], [enrollment.creation!.address])) ||
            quantity(estimated) === 0n || quantity(estimated) > BigInt(tx.gas)) unavailable();
        const [canonical, pendingAgain, instanceAgain] = await Promise.all([
          rpc.request("eth_getBlockByNumber", [toHex(BigInt(head.blockNumber)), false]), rpc.request("eth_getTransactionCount", [config.sender, "pending"]), identity(rpc),
        ]);
        const finalBlock = block(canonical, now());
        if (enrollmentDigest(finalBlock.head) !== enrollmentDigest(head) || finalBlock.baseFee !== latest.baseFee ||
            quantity(pendingAgain) !== nonce || instanceAgain !== instance) unavailable();
        await settlementAnchor();
        fresh(); rpc.check();
        const admission: WalletDeploymentDispatchAdmission = { ...(accounting ? { version: "center-wallet-deployment-local-admission-v2" as const,
          accounting: { digest: walletDeploymentAccountingDigest(accounting), remainingWei, nextNonce: accounting.nextNonce } } :
          { version: "center-wallet-deployment-local-admission-v1" as const }), operationId: operation.id,
          poolConfigurationDigest: pool.configurationDigest, templateCommitment: signed.templateCommitment, transactionHash: signed.hash,
          operationRevision: operation.revision, observationDigest: enrollmentDigest(observation), environment: { kind: "unforked-anvil", genesisHash, head },
          observedAt, expiresAt, balanceWei: String(balance), maximumExecutionCost: signed.maximumExecutionCost,
          feeScope: "local-execution-only", baseTotalAffordability: "unknown" };
        capabilities.set(admission, { digest: enrollmentDigest(admission), raw: signed.rawTransaction, hash: signed.hash, instance, deadline });
        return admission;
      } catch { return unavailable(); } finally { rpc.close(); }
    },
    async broadcast(admission: WalletDeploymentDispatchAdmission, signal?: AbortSignal, dispatchLeaseUntil?: number): Promise<"accepted" | "unknown"> {
      const capability = capabilities.get(admission);
      if (!capability) invalid();
      capabilities.delete(admission); // Consume before any await, including a refused attempt.
      let frozen: WalletDeploymentDispatchAdmission;
      try { if (enrollmentDigest(admission) !== capability.digest) invalid(); frozen = structuredClone(admission); } catch { return invalid(); }
      if (dispatchLeaseUntil !== undefined && !time(dispatchLeaseUntil)) invalid();
      const expiresAt = Math.min(frozen.expiresAt, dispatchLeaseUntil ?? frozen.expiresAt);
      const startedAt = now(); if (!time(startedAt)) invalid();
      const deadline = Math.min(capability.deadline, performance.now() + expiresAt - startedAt);
      function fresh() {
        const current = now();
        if (!time(current) || current < frozen.observedAt || current >= expiresAt || performance.now() >= deadline) invalid();
      }
      try { if (enrollmentDigest(admission) !== capability.digest) invalid(); fresh(); } catch { return invalid(); }
      const rpc = operationRpc(reads, limits, signal);
      try {
        if (await identity(rpc) !== capability.instance) return "unknown";
        const canonical = block(await rpc.request("eth_getBlockByNumber", [toHex(BigInt(frozen.environment.head.blockNumber)), false]), now());
        if (enrollmentDigest(canonical.head) !== enrollmentDigest(frozen.environment.head)) return "unknown";
        if (enrollmentDigest(admission) !== capability.digest) return "unknown";
        fresh(); rpc.check(); signal?.throwIfAborted();
        const controller = new AbortController(), timeoutMs = Math.min(bounds.sendTimeoutMs, Math.max(1, deadline - performance.now()));
        const abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const interrupted = new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error("Local send interrupted")), { once: true });
          timer = setTimeout(abort, timeoutMs);
        });
        try {
          const answer = await Promise.race([request("eth_sendRawTransaction", [capability.raw], controller.signal), interrupted]);
          return !controller.signal.aborted && performance.now() < deadline && same(answer, capability.hash) ? "accepted" : "unknown";
        } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); controller.abort(); }
      } catch { return "unknown"; } finally { rpc.close(); }
    },
  };
}
