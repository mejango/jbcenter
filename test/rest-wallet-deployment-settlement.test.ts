import { describe, expect, it } from "vitest";
import { syntheticSettlement } from "./fixtures/wallet-deployment-settlement.js";
import { syntheticDeploymentContext } from "./fixtures/wallet-deployment-execution.js";
import { walletDeploymentRemainingWei, assertWalletDeploymentFundingEvidence, walletDeploymentFundingConflict,
  assertWalletDeploymentAccounting, assertWalletDeploymentSettlementEvidence, walletDeploymentAccountingDigest, type WalletDeploymentAccounting, type WalletDeploymentFundingContext,
  type WalletDeploymentFundingEvidence } from "../src/rest/wallet/deploymentSettlement.js";

async function fixture() {
  const execution = await syntheticDeploymentContext(), now = Date.now();
  const head = { chainId: 8453 as const, blockNumber: "100", blockHash: `0x${"ab".repeat(32)}` as const,
    timestamp: String(Math.floor(now / 1000)), source: "onchain" as const };
  const environment = { kind: "unforked-anvil" as const, genesisHash: `0x${"cd".repeat(32)}` as const, instanceId: `0x${"ef".repeat(32)}` as const };
  const accounting: WalletDeploymentAccounting = { version: "center-wallet-deployment-accounting-v1", environment, initialHead: head,
    initialNonce: "1", nextNonce: "1", spentWei: "0", sequence: 0, lastSettlementId: null, lastSettlementAnchor: null, fence: null };
  const context: WalletDeploymentFundingContext = { pool: { ...execution.pool, activeOperationId: null, accounting }, lastSettlement: null };
  const evidence: WalletDeploymentFundingEvidence = { version: "center-wallet-deployment-funding-v1", poolId: context.pool.configuration.id,
    configurationDigest: context.pool.configurationDigest, poolRevision: context.pool.revision, accountingDigest: walletDeploymentAccountingDigest(accounting),
    environment, head, observedAt: now, expiresAt: now + 5000, confirmedNonce: "1", pendingNonce: "1",
    balanceWei: context.pool.configuration.allocationWei, previousAnchor: null };
  return { context, evidence, now, execution };
}
describe("qualified local sequential deployment accounting", () => {
  it("retains the original allocation while deriving remaining capital after a debit", async () => {
    const { context } = await fixture();
    expect(walletDeploymentRemainingWei(context.pool)).toBe(context.pool.configuration.allocationWei);
  });
  it("accepts bounded evidence tied to the exact loaded pool and accounting", async () => {
    const { context, evidence, now } = await fixture();
    expect(assertWalletDeploymentFundingEvidence(evidence, context, now)).toEqual(evidence);
  });
  it("identifies a proven unexpected nonce instead of adopting it", async () => {
    const { context, evidence } = await fixture(); evidence.confirmedNonce = evidence.pendingNonce = "2";
    expect(walletDeploymentFundingConflict(context, evidence)).toBe("nonce-conflict");
  });
  it.each([
    (v: any) => { v.extra = true; }, (v: any) => { delete v.accountingDigest; }, (v: any) => { v.accountingDigest = null; },
    (v: any) => { v.poolRevision++; }, (v: any) => { v.version = "base-fees-complete"; },
    (v: any) => { v.environment.instanceId = "0x" + "00".repeat(32); }, (v: any) => { v.environment.kind = "base"; },
    (v: any) => { v.expiresAt = v.observedAt; }, (v: any) => { v.expiresAt = v.observedAt + 60001; },
    (v: any) => { v.observedAt++; }, (v: any) => { v.balanceWei = "01"; }, (v: any) => { v.balanceWei = String(1n << 256n); },
    (v: any) => { v.confirmedNonce = "9007199254740992"; }, (v: any) => { v.head.timestamp = "0"; },
    (v: any) => { v.previousAnchor = { ...v.head }; },
  ])("rejects funding shape, context and original freshness drift %#", async mutate => {
    const { context, evidence, now } = await fixture(); mutate(evidence);
    expect(() => assertWalletDeploymentFundingEvidence(evidence, context, now)).toThrow();
  });
  it.each([
    (v: any) => { v.spentWei = "1"; }, (v: any) => { v.nextNonce = "2"; }, (v: any) => { v.lastSettlementId = "invalid"; },
    (v: any) => { v.sequence = -1; }, (v: any) => { v.environment.kind = "base"; }, (v: any) => { v.fence = {}; },
    (v: any) => { delete v.fence; },
  ])("rejects incoherent persisted accounting %#", async mutate => {
    const { context } = await fixture(); mutate(context.pool.accounting);
    expect(() => assertWalletDeploymentAccounting(context.pool.accounting, context.pool)).toThrow();
  });
  it("snapshots only plain bounded data and rejects accessors without evaluating them", async () => {
    const { context, evidence, now } = await fixture(); let accessed = false;
    Object.defineProperty(evidence, "balanceWei", { enumerable: true, get() { accessed = true; return "0"; } });
    expect(() => assertWalletDeploymentFundingEvidence(evidence, context, now)).toThrow(); expect(accessed).toBe(false);
  });
  it("accepts complete local execution fees separately from unchanged Base fee unknowns", async () => {
    const { context, execution, now } = await fixture();
    const settlementContext = { ...execution, pool: { ...context.pool, activeOperationId: execution.operation.id }, dispatch: null, lastSettlement: null };
    const evidence = syntheticSettlement(settlementContext, now);
    expect(assertWalletDeploymentSettlementEvidence(evidence, settlementContext, now)).toEqual(evidence);
    expect(evidence.observation.fees).toMatchObject({ l1Wei: null, operatorWei: null, totalWei: null });
  });
  it.each([
    (v: any) => { v.fees.totalWei = "0"; }, (v: any) => { v.fees.totalWei = "500000000001"; },
    (v: any) => { v.fees.executionWei = "0"; }, (v: any) => { v.fees.profile = "base-complete"; },
    (v: any) => { v.observation.finality.state = "unknown"; v.observation.finality.evidence = null; },
    (v: any) => { v.operationRevision++; }, (v: any) => { v.transactionHash = "0x" + "cd".repeat(32); },
    (v: any) => { v.observation.fees.totalWei = v.fees.totalWei; }, (v: any) => { v.observation.observedAt -= 60000; },
    (v: any) => { v.observation.transaction.receipt.gasUsed = "1500001"; },
  ])("rejects settlement authority, fee, original clock or exact receipt drift %#", async mutate => {
    const { context, execution, now } = await fixture();
    const settlementContext = { ...execution, pool: { ...context.pool, activeOperationId: execution.operation.id }, dispatch: null, lastSettlement: null };
    const evidence = syntheticSettlement(settlementContext, now); mutate(evidence);
    expect(() => assertWalletDeploymentSettlementEvidence(evidence, settlementContext, now)).toThrow();
  });

});
