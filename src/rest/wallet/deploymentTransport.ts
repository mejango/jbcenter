import { encodeAbiParameters, keccak256, toHex, type Hex } from "viem";
import { RestError, type RestBlockEvidence, type RestRpc } from "../core.js";
import { inspectPasskeyCreationSigner } from "../smartAccounts/passkeyProfile.js";
import { walletDeploymentRelayPolicy } from "./deploymentPostgres.js";
import { validateSignedWalletDeployment } from "./deployment.js";
import { enrollmentDigest } from "./enrollment.js";
import { assertWalletDeploymentObservation } from "./deploymentObservation.js";
import { walletDeploymentDispatchLimits as bounds, walletDeploymentBaseReservationMargin, type WalletDeploymentBaseReservation,
  type WalletDeploymentDispatchAdmission, type WalletDeploymentExecutionContext } from "./deploymentDispatch.js";
import { operationRpc } from "./operationRpc.js";
import { assertWalletDeploymentAccounting, walletDeploymentAccountingDigest, walletDeploymentRemainingWei,
  type WalletDeploymentEnvironment } from "./deploymentSettlement.js";

export type WalletDeploymentRpcScope = ReturnType<typeof operationRpc>;
export interface WalletDeploymentRpcLimits { rpcCalls: number; rpcTimeoutMs: number; totalTimeoutMs: number; responseBytes: number }
export interface WalletDeploymentTransportLimits extends WalletDeploymentRpcLimits { admissionLifetimeMs: number }
/** One explicit chain behind the shared durable boundaries. The host constructs it; no request
 * field, environment flag or database row can supply an endpoint, key or identity. */
export interface WalletDeploymentChainAdapter {
  kind: WalletDeploymentEnvironment["kind"];
  genesisHash: Hex;
  /** Read-only bounded transport. Every request is charged to the caller's operation budget. */
  reads: RestRpc;
  limits: WalletDeploymentTransportLimits;
  /** Chain identity and, for Base, the pinned fee runtimes. Throws when anything differs. */
  identity(rpc: WalletDeploymentRpcScope, at?: RestBlockEvidence): Promise<WalletDeploymentEnvironment>;
  /** One physical eth_sendRawTransaction, no failover or retry. Returns the provider result. */
  send(rawTransaction: Hex, signal: AbortSignal): Promise<unknown>;
  /** Base only: price the complete envelope at the admission head. */
  reserve?(rpc: WalletDeploymentRpcScope, head: RestBlockEvidence, rawTransaction: Hex): Promise<Omit<WalletDeploymentBaseReservation, "totalWei">>;
  now?: () => number;
}

const same = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const time = (value: number) => Number.isSafeInteger(value) && value > 0;
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function word(value: unknown): value is Hex { return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) && BigInt(value) !== 0n; }
export function walletDeploymentQuantity(value: unknown, fail: () => never): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value)) fail();
  return BigInt(value);
}
export function walletDeploymentBlock(value: unknown, now: number, fail: () => never) {
  if (!record(value) || !word(value.hash)) fail();
  const quantity = (v: unknown) => walletDeploymentQuantity(v, fail);
  const number = quantity(value.number), timestamp = quantity(value.timestamp), baseFee = quantity(value.baseFeePerGas);
  if (timestamp * 1000n > BigInt(now + 30_000) || timestamp * 1000n + 300_000n <= BigInt(now)) fail();
  const head: RestBlockEvidence = { chainId: 8453, blockNumber: String(number), blockHash: value.hash.toLowerCase() as Hex,
    timestamp: String(timestamp), source: "onchain" };
  return { head, baseFee };
}

/** Each admission authorizes at most one physical send of the exact durable winner. It never
 * reprices, replaces a nonce or claims a fee ceiling; a Base reservation is estimate plus margin. */
export function createWalletDeploymentTransport(adapter: WalletDeploymentChainAdapter) {
  const { reads, limits, kind } = adapter, genesisHash = adapter.genesisHash.toLowerCase() as Hex, now = adapter.now ?? Date.now;
  if (!Number.isSafeInteger(limits.admissionLifetimeMs) || limits.admissionLifetimeMs < 1 || limits.admissionLifetimeMs > bounds.admissionLifetimeMs)
    throw new RestError(500, "WALLET_DEPLOYMENT_CONFIG_INVALID", "The admission lifetime exceeds the reviewed bound.");
  function invalid(check?: string): never {
    throw new RestError(403, "WALLET_DEPLOYMENT_TRANSPORT_INVALID", "A current exact deployment capability is required.", check ? { check } : undefined);
  }
  function unavailable(check?: string | Record<string, unknown>): never {
    throw new RestError(502, "WALLET_DEPLOYMENT_TRANSPORT_UNAVAILABLE", "The configured chain could not verify deployment admission.",
      typeof check === "string" ? { check } : check);
  }
  /** The outer 502 keeps the inner failure's code and bounded scalar details, so the worker log names it. */
  function cause(error: unknown): Record<string, unknown> {
    if (error instanceof RestError) {
      const scalars = error.details && typeof error.details === "object"
        ? Object.entries(error.details as Record<string, unknown>).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value)).slice(0, 8) : [];
      return { cause: error.code, ...Object.fromEntries(scalars) };
    }
    return { cause: (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).replace(/https?:\/\/\S+/g, "<url>").slice(0, 120) };
  }
  const quantity = (value: unknown) => walletDeploymentQuantity(value, unavailable), block = (value: unknown, at: number) => walletDeploymentBlock(value, at, unavailable);
  function decimal(value: unknown): bigint {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) >= 1n << 256n) invalid("decimal");
    return BigInt(value);
  }
  async function identity(rpc: WalletDeploymentRpcScope): Promise<WalletDeploymentEnvironment> {
    const environment = await adapter.identity(rpc);
    if (environment.kind !== kind || !same(environment.genesisHash, genesisHash)) unavailable("environment");
    return environment;
  }
  const capabilities = new WeakMap<WalletDeploymentDispatchAdmission, { digest: string; raw: Hex; hash: Hex; environment: string; deadline: number }>();
  return {
    async admit(input: WalletDeploymentExecutionContext, signal?: AbortSignal): Promise<WalletDeploymentDispatchAdmission> {
      // The context is loaded by the coordinator. Its shape cannot establish database provenance.
      enrollmentDigest(input); const context = structuredClone(input), observedAt = now(), deadline = performance.now() + limits.totalTimeoutMs;
      if (!time(observedAt)) invalid("clock");
      const { pool, enrollment, operation } = context, config = pool.configuration;
      const accounting = pool.accounting ? assertWalletDeploymentAccounting(pool.accounting, pool) : null;
      const remainingWei = walletDeploymentRemainingWei(pool);
      if (accounting && (accounting.fence || accounting.nextNonce !== operation.template?.transaction.nonce ||
          accounting.environment.kind !== kind || accounting.environment.genesisHash !== genesisHash)) invalid("accounting");
      if (kind === "base-mainnet" && (!accounting || !adapter.reserve)) invalid("base-accounting");
      const observation = assertWalletDeploymentObservation(operation.observation);
      // The log names the first failed rule; every failure is the same refusal.
      const rule = ([
        ["pool", () => pool.state !== "active" || pool.activeOperationId !== operation.id || config.chainId !== 8453 ||
          pool.configurationDigest !== enrollmentDigest(config) || operation.poolConfigurationDigest !== pool.configurationDigest || operation.poolId !== config.id],
        ["operation", () => operation.enrollmentId !== enrollment.intent.id || operation.id !== operation.approval.id ||
          operation.state !== "signed" || !operation.signed || !operation.template || !operation.admission ||
          !Number.isSafeInteger(operation.revision) || operation.revision < 1 || !same(operation.template!.sender, config.sender)],
        ["observation", () => observation.operationId !== operation.id || observation.transactionHash !== operation.signed!.hash ||
          observation.templateCommitment !== operation.templateCommitment || observation.transaction.state !== "not-observed" ||
          observation.wallet.state !== "undeployed" || !observation.head ||
          !same(observation.wallet.address, enrollment.creation!.address) || observation.wallet.initializerHash !== enrollment.creation!.initializerHash],
        ["observation-age", () => observation.observedAt > observedAt || observedAt - observation.observedAt >= config.policy.maximumObservationAgeMs],
        ["observation-nonce", () => observation.transaction.nonce?.confirmed !== operation.template!.transaction.nonce ||
          observation.transaction.nonce?.pending !== operation.template!.transaction.nonce],
        ["finalized-history", () => operation.historicalCanonicalObservation?.finality.state === "finalized"],
      ] satisfies [string, () => boolean][]).find(([, failed]) => failed());
      if (rule) invalid(rule[0]);
      const policy = walletDeploymentRelayPolicy(config);
      const signed = await validateSignedWalletDeployment({ enrollment, approval: operation.approval, template: operation.template!,
        rawTransaction: operation.signed!.rawTransaction, policy });
      if (signed.hash !== operation.signed!.hash || signed.templateCommitment !== operation.templateCommitment ||
          signed.maximumExecutionCost !== operation.signed!.maximumExecutionCost) invalid("signed");
      if (decimal(remainingWei) < BigInt(signed.maximumExecutionCost)) invalid("allocation");
      const expiresAt = Math.min(observedAt + limits.admissionLifetimeMs, observation.observedAt + config.policy.maximumObservationAgeMs,
        Number((BigInt(observation.head!.timestamp) + 300n) * 1000n));
      function fresh() { const current = now(); if (!time(current) || current < observedAt || current >= expiresAt || performance.now() >= deadline) invalid("expired"); }
      const rpc = operationRpc(reads, limits, signal);
      try {
        fresh();
        // Base mines every two seconds, so the observed head is rarely still "latest" by the time the
        // identity reads return. The admission is pinned to the observed head by hash: it must still
        // be canonical (the by-number read below) and latest must be at or past it, within the
        // observation-age window; the fee ceiling is checked against latest's base fee.
        const head = observation.head!;
        if (operation.highestObservedHead !== null && BigInt(head.blockNumber) < decimal(operation.highestObservedHead)) invalid("head-rewound");
        async function settlementAnchor() {
          if (!accounting?.lastSettlementAnchor) return;
          const prior = accounting.lastSettlementAnchor, current = await rpc.request("eth_getBlockByNumber", [toHex(BigInt(prior.blockNumber)), false]);
          if (!record(current) || !same(current.hash, prior.blockHash) || quantity(current.number) !== BigInt(prior.blockNumber) ||
              quantity(current.timestamp) !== BigInt(prior.timestamp)) unavailable("settlement-anchor");
        }
        // Every provider round trip is ~400 ms on Base: independent reads go out together, and the
        // pinned state reads do not wait for the pin and signer checks they do not depend on.
        const [environment, latest, observedBlock] = await Promise.all([
          identity(rpc),
          rpc.request("eth_getBlockByNumber", ["latest", false]).then(value => block(value, observedAt)),
          rpc.request("eth_getBlockByNumber", [toHex(BigInt(head.blockNumber)), false]).then(value => block(value, observedAt)),
          settlementAnchor(),
        ]);
        const environmentDigest = enrollmentDigest(environment);
        if (accounting && environmentDigest !== enrollmentDigest(accounting.environment)) unavailable("accounting-environment");
        if (enrollmentDigest(observedBlock.head) !== enrollmentDigest(head)) unavailable("observed-block");
        if (BigInt(latest.head.blockNumber) < BigInt(head.blockNumber)) unavailable("latest-behind");
        const tag = { blockHash: head.blockHash, requireCanonical: true as const }, tx = operation.template!.transaction;
        const snapshot = { evidence: head, tag, request: (method: string, params: readonly unknown[]) => rpc.request(method, [...params, tag]) };
        const manifest = enrollment.intent.manifest;
        const pins = [manifest.singleton, manifest.factory, manifest.safe7579, manifest.launchpad, manifest.entryPoint!, manifest.smartSessions,
          manifest.creationProfile!.multiSend, ...manifest.policies];
        async function pinned() {
          for (let start = 0; start < pins.length; start += 16) await Promise.all(pins.slice(start, start + 16).map(async pin => {
            const code = await snapshot.request("eth_getCode", [pin.address]);
            if (typeof code !== "string" || !/^0x(?:[0-9a-fA-F]{2}){1,49152}$/.test(code) || !same(keccak256(code as Hex), pin.runtimeCodeHash)) unavailable("pin");
          }));
        }
        const [, signer, balanceRaw, confirmedRaw, pendingRaw, receipt, transaction, ...codes] = await Promise.all([
          pinned(), inspectPasskeyCreationSigner({ manifest, publicKey: enrollment.candidate!.publicKey, snapshot }),
          snapshot.request("eth_getBalance", [config.sender]), snapshot.request("eth_getTransactionCount", [config.sender]),
          rpc.request("eth_getTransactionCount", [config.sender, "pending"]), rpc.request("eth_getTransactionReceipt", [signed.hash]),
          rpc.request("eth_getTransactionByHash", [signed.hash]), ...[config.sender, enrollment.intent.recoveryOwner, enrollment.creation!.address]
            .map(address => snapshot.request("eth_getCode", [address])),
        ]);
        if (!same(signer.address, enrollment.creation!.bootstrap.signerAddress)) unavailable("signer");
        const balance = quantity(balanceRaw), nonce = BigInt(tx.nonce);
        // The log names the first failed check; the outcome is the same bounded "not now".
        const blocked = receipt !== null ? "receipt" : transaction !== null ? "transaction" : codes.some(code => code !== "0x") ? "code"
          : quantity(confirmedRaw) !== nonce ? "confirmed-nonce" : quantity(pendingRaw) !== nonce ? "pending-nonce"
          : balance < decimal(remainingWei) || balance < BigInt(signed.maximumExecutionCost) ? "balance"
          : BigInt(tx.maxFeePerGas) < latest.baseFee + BigInt(tx.maxPriorityFeePerGas) ? "fee-ceiling" : null;
        if (blocked) unavailable(blocked);
        const call = { type: "0x2", from: config.sender, to: tx.to, data: tx.data, value: "0x0", nonce: toHex(nonce),
          gas: toHex(BigInt(tx.gas)), maxFeePerGas: toHex(BigInt(tx.maxFeePerGas)), maxPriorityFeePerGas: toHex(BigInt(tx.maxPriorityFeePerGas)), accessList: [] };
        // The simulation and the Base reservation pricing are independent reads at the same head.
        const [simulation, estimated, priced] = await Promise.all([snapshot.request("eth_call", [call]),
          rpc.request("eth_estimateGas", [call, toHex(BigInt(head.blockNumber))]), adapter.reserve ? adapter.reserve(rpc, head, signed.rawTransaction) : null]);
        if (!same(simulation, encodeAbiParameters([{ type: "address" }], [enrollment.creation!.address])) ||
            quantity(estimated) === 0n || quantity(estimated) > BigInt(tx.gas)) unavailable("simulation");
        let reservation: WalletDeploymentBaseReservation | null = null;
        if (priced) {
          const totalWei = BigInt(signed.maximumExecutionCost) + walletDeploymentBaseReservationMargin * (BigInt(priced.l1WeiAtParameters) + BigInt(priced.operatorMaximumWei));
          // ponytail: fixed 2x margin on the uncapped L1/operator portion; a reservation is not a fee ceiling.
          if (totalWei > decimal(remainingWei) || balance < totalWei) unavailable("reservation");
          reservation = { ...priced, totalWei: String(totalWei) };
        }
        const [canonical, pendingAgain, environmentAgain] = await Promise.all([
          rpc.request("eth_getBlockByNumber", [toHex(BigInt(head.blockNumber)), false]), rpc.request("eth_getTransactionCount", [config.sender, "pending"]), identity(rpc),
          settlementAnchor(),
        ]);
        const finalBlock = block(canonical, now());
        if (enrollmentDigest(finalBlock.head) !== enrollmentDigest(head) || finalBlock.baseFee !== observedBlock.baseFee ||
            quantity(pendingAgain) !== nonce || enrollmentDigest(environmentAgain) !== environmentDigest) unavailable("recheck");
        fresh(); rpc.check();
        const common = { operationId: operation.id, poolConfigurationDigest: pool.configurationDigest, templateCommitment: signed.templateCommitment,
          transactionHash: signed.hash, operationRevision: operation.revision, observationDigest: enrollmentDigest(observation),
          observedAt, expiresAt, balanceWei: String(balance), maximumExecutionCost: signed.maximumExecutionCost };
        const accounted = accounting ? { digest: walletDeploymentAccountingDigest(accounting), remainingWei, nextNonce: accounting.nextNonce } : null;
        const admission: WalletDeploymentDispatchAdmission = reservation && accounted
          ? { ...common, version: "center-wallet-deployment-base-admission-v1", accounting: accounted, reservation,
              environment: { kind: "base-mainnet", genesisHash, head }, feeScope: "base-execution-l1-operator-reserved", baseTotalAffordability: "reserved" }
          : { ...common, ...(accounted ? { version: "center-wallet-deployment-local-admission-v2" as const, accounting: accounted }
              : { version: "center-wallet-deployment-local-admission-v1" as const }),
              environment: { kind: "unforked-anvil", genesisHash, head }, feeScope: "local-execution-only", baseTotalAffordability: "unknown" };
        capabilities.set(admission, { digest: enrollmentDigest(admission), raw: signed.rawTransaction, hash: signed.hash, environment: environmentDigest, deadline });
        return admission;
      } catch (error) { return unavailable(cause(error)); } finally { rpc.close(); }
    },
    async broadcast(admission: WalletDeploymentDispatchAdmission, signal?: AbortSignal, dispatchLeaseUntil?: number): Promise<"accepted" | "unknown"> {
      const capability = capabilities.get(admission);
      if (!capability) invalid("capability");
      capabilities.delete(admission); // Consume before any await, including a refused attempt.
      let frozen: WalletDeploymentDispatchAdmission;
      try { if (enrollmentDigest(admission) !== capability.digest) invalid("capability"); frozen = structuredClone(admission); } catch { return invalid("capability"); }
      if (dispatchLeaseUntil !== undefined && !time(dispatchLeaseUntil)) invalid("lease");
      const expiresAt = Math.min(frozen.expiresAt, dispatchLeaseUntil ?? frozen.expiresAt);
      const startedAt = now(); if (!time(startedAt)) invalid("clock");
      const deadline = Math.min(capability.deadline, performance.now() + expiresAt - startedAt);
      function fresh() {
        const current = now();
        if (!time(current) || current < frozen.observedAt || current >= expiresAt || performance.now() >= deadline) invalid("expired");
      }
      try { if (enrollmentDigest(admission) !== capability.digest) invalid("capability"); fresh(); } catch { return invalid("expired"); }
      const rpc = operationRpc(reads, limits, signal);
      try {
        if (enrollmentDigest(await identity(rpc)) !== capability.environment) return "unknown";
        const canonical = block(await rpc.request("eth_getBlockByNumber", [toHex(BigInt(frozen.environment.head.blockNumber)), false]), now());
        if (enrollmentDigest(canonical.head) !== enrollmentDigest(frozen.environment.head)) return "unknown";
        // The caller's admission object may have been mutated during those reads; only the frozen digest sends.
        if (enrollmentDigest(admission) !== capability.digest) return "unknown";
        fresh(); rpc.check(); signal?.throwIfAborted();
        const controller = new AbortController(), timeoutMs = Math.min(bounds.sendTimeoutMs, Math.max(1, deadline - performance.now()));
        const abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const interrupted = new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error("Send interrupted")), { once: true });
          timer = setTimeout(abort, timeoutMs);
        });
        try {
          const answer = await Promise.race([adapter.send(capability.raw, controller.signal), interrupted]);
          return !controller.signal.aborted && performance.now() < deadline && same(answer, capability.hash) ? "accepted" : "unknown";
        } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); controller.abort(); }
      } catch { return "unknown"; } finally { rpc.close(); }
    },
  };
}
