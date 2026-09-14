import { toHex, type Hex } from "viem";
import { RestError, type RestBlockEvidence, type RestRpc } from "../core.js";
import type { ContractPin } from "../smartAccounts/types.js";
import { createWalletDeploymentChain } from "./deploymentChain.js";
import { createLocalAnvilWalletDeploymentReader } from "./deploymentLocalAnvil.js";
import { enrollmentDigest } from "./enrollment.js";
import { operationRpc } from "./operationRpc.js";
import { assertWalletDeploymentAccounting, assertWalletDeploymentFundingEvidence, walletDeploymentAccountingDigest,
  walletDeploymentSettlementLimits as bounds } from "./deploymentSettlement.js";
import type { WalletDeploymentFundingContext, WalletDeploymentFundingEvidence,
  WalletDeploymentSettlementContext, WalletDeploymentSettlementEvidence } from "./deploymentSettlement.js";

/** Explicit local test-chain accounting. This capability never authorizes Base dispatch. */
export function createLocalAnvilWalletDeploymentSettlement(options: {
  endpoint: string; expectedGenesisHash: Hex; utility: ContractPin; now?: () => number;
}) {
  const local = createLocalAnvilWalletDeploymentReader(options), now = options.now ?? Date.now;
  enrollmentDigest(options.utility); const utility = structuredClone(options.utility);
  const genesisHash = options.expectedGenesisHash.toLowerCase();
  const limits = { rpcCalls: 320, rpcTimeoutMs: 2000, totalTimeoutMs: 5000, responseBytes: 8 * 1024 * 1024 };
  function unavailable(): never { throw new RestError(502, "WALLET_DEPLOYMENT_SETTLEMENT_LOCAL_UNAVAILABLE", "The local chain could not establish complete settlement evidence."); }
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
  type Scope = ReturnType<typeof operationRpc>;
  async function funding(context: WalletDeploymentFundingContext, rpc: Scope, observedAt: number, expiresAt: number,
    expectedHead?: RestBlockEvidence): Promise<WalletDeploymentFundingEvidence> {
    const { pool } = context, accounting = pool.accounting ? assertWalletDeploymentAccounting(pool.accounting, pool) : null;
    if (pool.configurationDigest !== enrollmentDigest(pool.configuration) || pool.configuration.chainId !== 8453 ||
        (accounting && accounting.environment.genesisHash !== genesisHash)) unavailable();
    const environment = await local.identity(rpc);
    if (!accounting && environment.genesisHash !== genesisHash) unavailable();
    const head = anchor(await rpc.request("eth_getBlockByNumber", ["latest", false]));
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
      rpc.request("eth_getTransactionCount", [pool.configuration.sender, "pending"]), local.identity(rpc),
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
      enrollmentDigest(input); const context = structuredClone(input), observedAt = now(), rpc = operationRpc(local.reads, limits, signal);
      try { return await funding(context, rpc, observedAt, observedAt + bounds.evidenceLifetimeMs); }
      catch { return unavailable(); } finally { rpc.close(); }
    },
    async observeSettlement(input: WalletDeploymentSettlementContext, signal?: AbortSignal): Promise<WalletDeploymentSettlementEvidence> {
      enrollmentDigest(input); const context = structuredClone(input), startedAt = now(), rpc = operationRpc(local.reads, limits, signal, true);
      try {
        if (!context.pool.accounting || context.pool.accounting.fence || context.pool.state !== "active" ||
            context.pool.activeOperationId !== context.operation.id) unavailable();
        const initialEnvironment = await local.identity(rpc);
        if (!same(initialEnvironment, context.pool.accounting.environment)) unavailable();
        const scoped: RestRpc = { request(chainId, method, params) { if (chainId !== 8453) unavailable(); return rpc.request(method, params); } };
        const chain = createWalletDeploymentChain({ rpc: scoped, configuration: context.pool.configuration,
          manifest: context.enrollment.intent.manifest, utility, now,
          observationLimits: { totalTimeoutMs: limits.totalTimeoutMs, rpcTimeoutMs: limits.rpcTimeoutMs } });
        const observation = await chain.observeSigned(context, signal), receipt = observation.transaction.receipt;
        if (!receipt || !observation.head || !["canonical-success", "canonical-revert"].includes(observation.transaction.state) ||
            observation.finality.state !== "finalized" || !observation.finality.evidence ||
            observation.fees.executionWei === null || BigInt(observation.fees.executionWei) <= 0n) unavailable();
        const evidence = await funding(context, rpc, now(), Math.min(startedAt, observation.observedAt) + bounds.evidenceLifetimeMs, observation.head);
        const finalizedNonce = String(quantity(await rpc.request("eth_getTransactionCount", [context.pool.configuration.sender, tag(observation.finality.evidence)])));
        const [inclusion, finalized, currentFinalized, head, pending, environment] = await Promise.all([
          rpc.request("eth_getBlockByNumber", [toHex(BigInt(receipt.block.blockNumber)), false]),
          rpc.request("eth_getBlockByNumber", [toHex(BigInt(observation.finality.evidence.blockNumber)), false]),
          rpc.request("eth_getBlockByNumber", ["finalized", false]),
          rpc.request("eth_getBlockByNumber", [toHex(BigInt(observation.head.blockNumber)), false]),
          rpc.request("eth_getTransactionCount", [context.pool.configuration.sender, "pending"]), local.identity(rpc),
        ]);
        if (!same(anchor(inclusion), receipt.block) || !same(anchor(finalized), observation.finality.evidence) ||
            !same(anchor(currentFinalized), observation.finality.evidence) ||
            !same(anchor(head), observation.head) || String(quantity(pending)) !== evidence.pendingNonce || !same(environment, initialEnvironment)) unavailable();
        rpc.check(); assertWalletDeploymentFundingEvidence(evidence, context, now());
        return { version: "center-wallet-deployment-settlement-evidence-v1", funding: evidence, operationId: context.operation.id,
          operationRevision: context.operation.revision, transactionHash: context.operation.signed!.hash,
          templateCommitment: context.operation.templateCommitment!, observation, finalizedNonce,
          fees: { profile: "unforked-anvil-execution-fees-v1", executionWei: observation.fees.executionWei, totalWei: observation.fees.executionWei } };
      } catch { return unavailable(); } finally { rpc.close(); }
    },
  };
}
