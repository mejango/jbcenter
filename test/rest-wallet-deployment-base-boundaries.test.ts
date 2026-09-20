// Shared boundary types for hosted Base creation. Complete fees and a reservation are evidence
// shapes only; they never establish RPC provenance or dispatch authority by themselves.
import { describe, expect, it } from "vitest";
import { syntheticFunding, syntheticSettlement } from "./fixtures/wallet-deployment-settlement.js";
import { syntheticDeploymentAdmission, syntheticDeploymentContext, syntheticDeploymentObservation } from "./fixtures/wallet-deployment-execution.js";
import { assertWalletDeploymentAccounting, assertWalletDeploymentFundingEvidence, assertWalletDeploymentSettlementEvidence,
  walletDeploymentAccountingDigest, walletDeploymentRemainingWei, type WalletDeploymentAccounting, type WalletDeploymentEnvironment,
  type WalletDeploymentSettlementContext } from "../src/rest/wallet/deploymentSettlement.js";
import { assertWalletDeploymentDispatchAdmission, type WalletDeploymentDispatchAdmission } from "../src/rest/wallet/deploymentDispatch.js";
import { enrollmentDigest } from "../src/rest/wallet/enrollment.js";
import { localAnvilWalletDeploymentLimits } from "../src/rest/wallet/deploymentLocalAnvil.js";
import { createBaseWalletDeploymentReader } from "../src/rest/wallet/deploymentBase.js";
import { RestError } from "../src/rest/core.js";

const base: WalletDeploymentEnvironment = { kind: "base-mainnet", genesisHash: `0x${"11".repeat(32)}` };
const baseFees = { profile: "base-fjord-jovian-receipt-v1" as const, executionWei: "500000000000", l1Wei: "16289011957", operatorWei: "7", totalWei: "516289011964" };

async function fixture(now = Date.now()) {
  const execution = await syntheticDeploymentContext(now);
  const funding = syntheticFunding({ pool: execution.pool, lastSettlement: null }, now, structuredClone(base));
  const accounting: WalletDeploymentAccounting = { version: "center-wallet-deployment-accounting-v1", environment: structuredClone(base), initialHead: funding.head,
    initialNonce: "1", nextNonce: "1", spentWei: "0", sequence: 0, lastSettlementId: null, lastSettlementAnchor: null, fence: null };
  const context: WalletDeploymentSettlementContext = { ...execution, pool: { ...execution.pool, accounting }, dispatch: null, lastSettlement: null };
  const evidence = syntheticSettlement(context, now, baseFees);
  return { context, evidence, now };
}

describe("hosted Base deployment boundary shapes", () => {
  it("accepts a base-mainnet environment for funding evidence and accounting", async () => {
    const { context, now } = await fixture();
    const funding = syntheticFunding({ pool: context.pool, lastSettlement: null }, now);
    expect(funding.environment).toEqual(base);
    expect(assertWalletDeploymentFundingEvidence(funding, { pool: context.pool, lastSettlement: null }, now)).toEqual(funding);
    expect(assertWalletDeploymentAccounting(context.pool.accounting, context.pool)).toEqual(context.pool.accounting);
  });
  it.each([
    (e: any) => { e.instanceId = "0x" + "22".repeat(32); }, (e: any) => { delete e.genesisHash; }, (e: any) => { e.kind = "base"; },
    (e: any) => { e.runtimeProfile = "0x" + "22".repeat(32); },
  ])("rejects an incoherent base environment %#", async mutate => {
    const { context } = await fixture(); mutate(context.pool.accounting!.environment);
    expect(() => assertWalletDeploymentAccounting(context.pool.accounting, context.pool)).toThrow();
  });
  it("records actual cost above the allocation only behind an allocation-exceeded fence", async () => {
    const { context, evidence } = await fixture();
    const over = String(BigInt(context.pool.configuration.allocationWei) + 1n);
    const settled: WalletDeploymentAccounting = { ...context.pool.accounting!, sequence: 1, spentWei: over, nextNonce: "2",
      lastSettlementId: context.operation.id, lastSettlementAnchor: evidence.observation.finality.evidence, fence: null };
    expect(() => assertWalletDeploymentAccounting(settled, context.pool)).toThrow();
    const fenced = { ...settled, fence: { reason: "allocation-exceeded" as const, evidenceDigest: enrollmentDigest(evidence), recordedAt: 1 } };
    expect(assertWalletDeploymentAccounting(fenced, context.pool)).toEqual(fenced);
    expect(walletDeploymentRemainingWei({ ...context.pool, accounting: fenced })).toBe("0");
    expect(() => assertWalletDeploymentAccounting({ ...settled, fence: { ...fenced.fence, reason: "balance-deficit" } }, context.pool)).toThrow();
  });
  it("accepts complete Base receipt fees whose total is execution plus L1 plus operator", async () => {
    const { context, evidence, now } = await fixture();
    expect(evidence.fees).toEqual(baseFees);
    expect(assertWalletDeploymentSettlementEvidence(evidence, context, now)).toEqual(evidence);
  });
  it.each([
    (v: any) => { v.fees.totalWei = "516289011965"; }, (v: any) => { v.fees.executionWei = "500000000001"; },
    (v: any) => { v.fees = { profile: "unforked-anvil-execution-fees-v1", executionWei: "500000000000", totalWei: "500000000000" }; },
    (v: any) => { delete v.fees.operatorWei; }, (v: any) => { v.fees.l1Wei = "-1"; }, (v: any) => { v.fees.extra = "1"; },
    (v: any) => { v.fees.operatorWei = "8"; }, (v: any) => { v.fees.l1Wei = "016289011957"; },
  ])("rejects inconsistent Base fee evidence %#", async mutate => {
    const { context, evidence, now } = await fixture(); mutate(evidence);
    expect(() => assertWalletDeploymentSettlementEvidence(evidence, context, now)).toThrow();
  });
  it("allows a Base total above the execution envelope while bounding execution itself", async () => {
    const { context, evidence, now } = await fixture();
    const maximum = BigInt(context.operation.signed!.maximumExecutionCost);
    evidence.fees = { ...baseFees, l1Wei: String(maximum), totalWei: String(500000000000n + maximum + 7n) };
    expect(assertWalletDeploymentSettlementEvidence(evidence, context, now).fees).toEqual(evidence.fees);
    evidence.observation.transaction.receipt!.gasUsed = "1500000"; evidence.observation.transaction.receipt!.effectiveGasPrice = "2000000001";
    const execution = 1500000n * 2000000001n; evidence.observation.fees.executionWei = String(execution);
    evidence.fees = { ...baseFees, executionWei: String(execution), totalWei: String(execution + 16289011957n + 7n) };
    expect(() => assertWalletDeploymentSettlementEvidence(evidence, context, now)).toThrow();
  });
  it("rejects local execution fees under a Base environment and Base fees under a local environment", async () => {
    const { context, evidence, now } = await fixture();
    const local = { ...context, pool: { ...context.pool, accounting: { ...context.pool.accounting!,
      environment: { kind: "unforked-anvil" as const, genesisHash: base.genesisHash, instanceId: `0x${"33".repeat(32)}` as const } } } };
    const localEvidence = syntheticSettlement(local, now);
    expect(assertWalletDeploymentSettlementEvidence(localEvidence, local, now)).toEqual(localEvidence);
    expect(() => assertWalletDeploymentSettlementEvidence({ ...localEvidence, fees: baseFees }, local, now)).toThrow();
    expect(() => assertWalletDeploymentSettlementEvidence({ ...evidence, fees: localEvidence.fees }, context, now)).toThrow();
  });

  function admission(context: WalletDeploymentSettlementContext, now: number): WalletDeploymentDispatchAdmission {
    const operation = context.operation, execution = BigInt(operation.signed!.maximumExecutionCost);
    return { version: "center-wallet-deployment-base-admission-v1", operationId: operation.id, poolConfigurationDigest: operation.poolConfigurationDigest,
      templateCommitment: operation.templateCommitment!, transactionHash: operation.signed!.hash, operationRevision: operation.revision,
      observationDigest: enrollmentDigest(operation.observation), environment: { kind: "base-mainnet", genesisHash: base.genesisHash, head: operation.observation!.head! },
      observedAt: now, expiresAt: now + 3000, balanceWei: context.pool.configuration.allocationWei, maximumExecutionCost: operation.signed!.maximumExecutionCost,
      feeScope: "base-execution-l1-operator-reserved", baseTotalAffordability: "reserved",
      accounting: { digest: walletDeploymentAccountingDigest(context.pool.accounting!), remainingWei: walletDeploymentRemainingWei(context.pool), nextNonce: "1" },
      reservation: { attributesTransaction: `0x${"44".repeat(32)}`, parametersDigest: "a".repeat(64), l1WeiAtParameters: "16289011957",
        operatorMaximumWei: "100", totalWei: String(execution + 2n * (16289011957n + 100n)) } };
  }
  it("accepts a Base admission that reserves execution plus twice the current L1 and operator estimate", async () => {
    const { context, now } = await fixture();
    context.operation.observation = syntheticDeploymentObservation(context, now - 100);
    const value = admission(context, now);
    expect(assertWalletDeploymentDispatchAdmission(value, context, now)).toEqual(value);
  });
  it("accepts a hosted admission window of up to twenty seconds while local windows stay at five", async () => {
    const { context, now } = await fixture();
    context.operation.observation = syntheticDeploymentObservation(context, now - 100);
    context.pool.configuration.policy.maximumObservationAgeMs = 30_000; context.pool.configurationDigest = enrollmentDigest(context.pool.configuration);
    context.operation.poolConfigurationDigest = context.pool.configurationDigest;
    const value = { ...admission(context, now), expiresAt: now + 15_000, poolConfigurationDigest: context.pool.configurationDigest };
    expect(assertWalletDeploymentDispatchAdmission(value, context, now)).toEqual(value);
    expect(() => assertWalletDeploymentDispatchAdmission({ ...value, expiresAt: now + 20_001 }, context, now)).toThrow();
    expect(localAnvilWalletDeploymentLimits.admissionLifetimeMs).toBe(5000);
    const local = await syntheticDeploymentContext(now); local.operation.observation = syntheticDeploymentObservation(local, now - 100);
    local.pool.configuration.policy.maximumObservationAgeMs = 30_000; local.pool.configurationDigest = enrollmentDigest(local.pool.configuration);
    local.operation.poolConfigurationDigest = local.pool.configurationDigest;
    const legacy = { ...syntheticDeploymentAdmission(local, now), poolConfigurationDigest: local.pool.configurationDigest };
    expect(assertWalletDeploymentDispatchAdmission({ ...legacy, expiresAt: now + 5000 }, local, now)).toBeDefined();
    expect(() => assertWalletDeploymentDispatchAdmission({ ...legacy, expiresAt: now + 5001 }, local, now)).toThrow();
  });
  it.each([
    (a: any) => { a.reservation.totalWei = String(BigInt(a.reservation.totalWei) - 1n); },
    (a: any, c: any) => { a.reservation.l1WeiAtParameters = c.pool.configuration.allocationWei;
      a.reservation.totalWei = String(BigInt(a.maximumExecutionCost) + 2n * (BigInt(a.reservation.l1WeiAtParameters) + BigInt(a.reservation.operatorMaximumWei))); },
    (a: any) => { delete a.reservation; }, (a: any) => { a.feeScope = "local-execution-only"; }, (a: any) => { a.baseTotalAffordability = "unknown"; },
    (a: any) => { a.environment.kind = "unforked-anvil"; }, (a: any) => { a.version = "center-wallet-deployment-local-admission-v2"; },
    (a: any) => { a.reservation.attributesTransaction = "0x" + "00".repeat(32); }, (a: any) => { a.reservation.extra = 1; },
    (a: any, c: any) => { a.balanceWei = String(BigInt(a.reservation.totalWei) - 1n); },
  ])("rejects a Base admission with a drifted or unaffordable reservation %#", async mutate => {
    const { context, now } = await fixture();
    context.operation.observation = syntheticDeploymentObservation(context, now - 100);
    const value = admission(context, now); mutate(value, context);
    expect(() => assertWalletDeploymentDispatchAdmission(value, context, now)).toThrow();
  });
  it("rejects a local admission version against Base accounting", async () => {
    const { context, now } = await fixture();
    context.operation.observation = syntheticDeploymentObservation(context, now - 100);
    const value: any = admission(context, now);
    delete value.reservation; value.version = "center-wallet-deployment-local-admission-v2"; value.feeScope = "local-execution-only";
    value.baseTotalAffordability = "unknown"; value.environment.kind = "unforked-anvil";
    expect(() => assertWalletDeploymentDispatchAdmission(value, context, now)).toThrow();
  });
});

describe("Base provider failures name the method and a bounded reason for the log", () => {
  const url = "http://127.0.0.1:18545";
  async function failing(answer: () => Response, method = "eth_chainId") {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => answer()) as typeof fetch;
    try {
      const reader = createBaseWalletDeploymentReader({ url, genesisHash: base.genesisHash });
      return await reader.reads.request(8453, method, []).then(() => null, (error: unknown) => error as RestError);
    } finally { globalThis.fetch = original; }
  }
  it("keeps an upstream HTTP status as the cause", async () => {
    const error = await failing(() => new Response("slow down", { status: 429 }));
    expect(error?.code).toBe("WALLET_DEPLOYMENT_BASE_UNAVAILABLE");
    expect(error?.details).toEqual({ method: "eth_chainId", upstream: "Error: upstream status 429" });
  });
  it("keeps a JSON-RPC error code, never the provider's message", async () => {
    const error = await failing(() => Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: `rate limited, see ${url}/docs` } }), "eth_getBalance");
    expect(error?.details).toEqual({ method: "eth_getBalance", rpcCode: -32005 });
  });
});
