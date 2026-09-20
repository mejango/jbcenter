import { toHex, type Hex } from "viem";
import { RestError, type RestBlockEvidence, type RestRpc } from "../core.js";
import type { ContractPin } from "../smartAccounts/types.js";
import { createWalletDeploymentChain } from "./deploymentChain.js";
import type { WalletDeploymentObservation } from "./deploymentObservation.js";
import { enrollmentDigest } from "./enrollment.js";
import { operationRpc } from "./operationRpc.js";
import { assertWalletDeploymentAccounting, assertWalletDeploymentFundingEvidence, walletDeploymentAccountingDigest,
  walletDeploymentSettlementLimits as bounds } from "./deploymentSettlement.js";
import type { WalletDeploymentFundingContext, WalletDeploymentFundingEvidence, WalletDeploymentSettlementContext,
  WalletDeploymentSettlementEvidence, WalletDeploymentSettlementFees } from "./deploymentSettlement.js";
import type { WalletDeploymentChainAdapter, WalletDeploymentRpcLimits, WalletDeploymentRpcScope } from "./deploymentTransport.js";

export interface WalletDeploymentSettlementAdapter extends Omit<WalletDeploymentChainAdapter, "send" | "reserve" | "limits"> {
  limits: WalletDeploymentRpcLimits;
  utility: ContractPin;
  /** Producer-specific validity window for one funding read, at most the shared bound. */
  evidenceLifetimeMs: number;
  /** Complete fees for the finalized canonical receipt. Throws rather than substituting zero. */
  fees(rpc: WalletDeploymentRpcScope, context: WalletDeploymentSettlementContext, observation: WalletDeploymentObservation): Promise<WalletDeploymentSettlementFees>;
}

/** Shared settlement producer: finalized exact receipt, complete fees, then a fresh funding read
 * anchored to the same head. It never releases a lane itself; the durable store settles. */
export function createWalletDeploymentSettlementObserver(adapter: WalletDeploymentSettlementAdapter) {
  const { reads, limits, kind } = adapter, now = adapter.now ?? Date.now, genesisHash = adapter.genesisHash.toLowerCase();
  enrollmentDigest(adapter.utility); const utility = structuredClone(adapter.utility);
  if (!Number.isSafeInteger(adapter.evidenceLifetimeMs) || adapter.evidenceLifetimeMs < 1 || adapter.evidenceLifetimeMs > bounds.evidenceLifetimeMs)
    throw new RestError(500, "WALLET_DEPLOYMENT_CONFIG_INVALID", "The settlement evidence lifetime exceeds the reviewed bound.");
  const lifetimeMs = adapter.evidenceLifetimeMs;
  function unavailable(): never { throw new RestError(502, "WALLET_DEPLOYMENT_SETTLEMENT_UNAVAILABLE", "The configured chain could not establish complete settlement evidence."); }
  function quantity(value: unknown): bigint {
    if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value)) unavailable();
    return BigInt(value);
  }
  function anchor(value: unknown): RestBlockEvidence {
    if (!value || typeof value !== "object" || Array.isArray(value)) unavailable();
    const raw = value as Record<string, unknown>;
    if (typeof raw.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(raw.hash) || BigInt(raw.hash) === 0n) unavailable();
    return { chainId: 8453, blockNumber: String(quantity(raw.number)), blockHash: raw.hash.toLowerCase() as Hex,
      timestamp: String(quantity(raw.timestamp)), source: "onchain" };
  }
  const same = (a: unknown, b: unknown) => enrollmentDigest(a) === enrollmentDigest(b);
  const tag = (head: RestBlockEvidence) => ({ blockHash: head.blockHash, requireCanonical: true as const });
  async function identity(rpc: WalletDeploymentRpcScope, at?: RestBlockEvidence) {
    const environment = await adapter.identity(rpc, at);
    if (environment.kind !== kind || environment.genesisHash.toLowerCase() !== genesisHash) unavailable();
    return environment;
  }
  async function funding(context: WalletDeploymentFundingContext, rpc: WalletDeploymentRpcScope, observedAt: number, expiresAt: number,
    expectedHead?: RestBlockEvidence): Promise<WalletDeploymentFundingEvidence> {
    const { pool } = context, accounting = pool.accounting ? assertWalletDeploymentAccounting(pool.accounting, pool) : null;
    if (pool.configurationDigest !== enrollmentDigest(pool.configuration) || pool.configuration.chainId !== 8453 ||
        (accounting && (accounting.environment.kind !== kind || accounting.environment.genesisHash !== genesisHash))) unavailable();
    // Initialized accounting retains a proved environment change as a fence, so a changed local
    // genesis is reported rather than hidden. An uninitialized pool must match the configured chain.
    const environment = await adapter.identity(rpc);
    if (environment.kind !== kind || (!accounting && environment.genesisHash.toLowerCase() !== genesisHash)) unavailable();
    // Settlement pairs the funding read with the observation's head by number: on a live chain
    // "latest" has moved on by the time the wallet inspection finishes.
    const head = anchor(await rpc.request("eth_getBlockByNumber", [expectedHead ? toHex(BigInt(expectedHead.blockNumber)) : "latest", false]));
    if (expectedHead && !same(head, expectedHead)) unavailable();
    let previousAnchor: RestBlockEvidence | null = null;
    if (accounting?.lastSettlementAnchor) {
      const previous = await rpc.request("eth_getBlockByNumber", [toHex(BigInt(accounting.lastSettlementAnchor.blockNumber)), false]);
      if (previous !== null) {
        previousAnchor = anchor(previous);
        if (previousAnchor.blockNumber !== accounting.lastSettlementAnchor.blockNumber) unavailable();
      } else if (same(environment, accounting.environment) && BigInt(head.blockNumber) >= BigInt(accounting.lastSettlementAnchor.blockNumber)) unavailable();
    }
    const [balance, confirmed, pending] = await Promise.all([
      rpc.request("eth_getBalance", [pool.configuration.sender, tag(head)]),
      rpc.request("eth_getTransactionCount", [pool.configuration.sender, tag(head)]),
      rpc.request("eth_getTransactionCount", [pool.configuration.sender, "pending"]),
    ]);
    const [canonical, pendingAgain, environmentAgain, previousAgain] = await Promise.all([
      rpc.request("eth_getBlockByNumber", [toHex(BigInt(head.blockNumber)), false]),
      rpc.request("eth_getTransactionCount", [pool.configuration.sender, "pending"]), adapter.identity(rpc),
      previousAnchor ? rpc.request("eth_getBlockByNumber", [toHex(BigInt(previousAnchor.blockNumber)), false]) : Promise.resolve(null),
    ]);
    if (!same(anchor(canonical), head) || quantity(pendingAgain) !== quantity(pending) || !same(environmentAgain, environment) ||
        (previousAnchor && !same(anchor(previousAgain), previousAnchor))) unavailable();
    const evidence: WalletDeploymentFundingEvidence = { version: "center-wallet-deployment-funding-v1", poolId: pool.configuration.id,
      configurationDigest: pool.configurationDigest, poolRevision: pool.revision,
      accountingDigest: accounting ? walletDeploymentAccountingDigest(accounting) : null, environment, head, observedAt,
      expiresAt: Math.min(expiresAt, Number(BigInt(head.timestamp) * 1000n) + bounds.maximumHeadAgeMs),
      confirmedNonce: String(quantity(confirmed)), pendingNonce: String(quantity(pending)), balanceWei: String(quantity(balance)), previousAnchor };
    rpc.check(); return assertWalletDeploymentFundingEvidence(evidence, context, now());
  }
  return {
    async observeFunding(input: WalletDeploymentFundingContext, signal?: AbortSignal): Promise<WalletDeploymentFundingEvidence> {
      enrollmentDigest(input); const context = structuredClone(input), observedAt = now(), rpc = operationRpc(reads, limits, signal);
      try { return await funding(context, rpc, observedAt, observedAt + lifetimeMs); }
      catch { return unavailable(); } finally { rpc.close(); }
    },
    async observeSettlement(input: WalletDeploymentSettlementContext, signal?: AbortSignal): Promise<WalletDeploymentSettlementEvidence> {
      enrollmentDigest(input); const context = structuredClone(input), startedAt = now(), rpc = operationRpc(reads, limits, signal, true);
      try {
        // Only a released operation settles: the lane left it at inclusion and finality debits it.
        if (!context.pool.accounting || context.pool.accounting.fence || context.pool.state !== "active" ||
            context.operation.releasedAt === null || context.operation.settlementId !== undefined) unavailable();
        const initialEnvironment = await identity(rpc);
        if (!same(initialEnvironment, context.pool.accounting.environment)) unavailable();
        const scoped: RestRpc = { request(chainId, method, params) { if (chainId !== 8453) unavailable(); return rpc.request(method, params); } };
        const chain = createWalletDeploymentChain({ rpc: scoped, configuration: context.pool.configuration,
          manifest: context.enrollment.intent.manifest, utility, now,
          observationLimits: { totalTimeoutMs: limits.totalTimeoutMs, rpcTimeoutMs: limits.rpcTimeoutMs } });
        const observation = await chain.observeSigned(context, signal), receipt = observation.transaction.receipt;
        if (!receipt || !observation.head || !["canonical-success", "canonical-revert"].includes(observation.transaction.state) ||
            observation.finality.state !== "finalized" || !observation.finality.evidence ||
            observation.fees.executionWei === null || BigInt(observation.fees.executionWei) <= 0n) unavailable();
        // The pricing rules in force at inclusion are part of the evidence, not only the current head.
        if (!same(await identity(rpc, receipt.block), initialEnvironment)) unavailable();
        const fees = await adapter.fees(rpc, context, observation);
        if (fees.executionWei !== observation.fees.executionWei || BigInt(fees.totalWei) < BigInt(fees.executionWei)) unavailable();
        const evidence = await funding(context, rpc, now(), Math.min(startedAt, observation.observedAt) + lifetimeMs, observation.head);
        const finalizedNonce = String(quantity(await rpc.request("eth_getTransactionCount", [context.pool.configuration.sender, tag(observation.finality.evidence)])));
        const [inclusion, finalized, currentFinalized, head, pending, environment] = await Promise.all([
          rpc.request("eth_getBlockByNumber", [toHex(BigInt(receipt.block.blockNumber)), false]),
          rpc.request("eth_getBlockByNumber", [toHex(BigInt(observation.finality.evidence.blockNumber)), false]),
          rpc.request("eth_getBlockByNumber", ["finalized", false]),
          rpc.request("eth_getBlockByNumber", [toHex(BigInt(observation.head.blockNumber)), false]),
          rpc.request("eth_getTransactionCount", [context.pool.configuration.sender, "pending"]), identity(rpc),
        ]);
        if (!same(anchor(inclusion), receipt.block) || !same(anchor(finalized), observation.finality.evidence) ||
            BigInt(anchor(currentFinalized).blockNumber) < BigInt(observation.finality.evidence.blockNumber) ||
            !same(anchor(head), observation.head) || String(quantity(pending)) !== evidence.pendingNonce || !same(environment, initialEnvironment)) unavailable();
        rpc.check(); assertWalletDeploymentFundingEvidence(evidence, context, now());
        return { version: "center-wallet-deployment-settlement-evidence-v1", funding: evidence, operationId: context.operation.id,
          operationRevision: context.operation.revision, transactionHash: context.operation.signed!.hash,
          templateCommitment: context.operation.templateCommitment!, observation, finalizedNonce, fees };
      } catch { return unavailable(); } finally { rpc.close(); }
    },
  };
}
