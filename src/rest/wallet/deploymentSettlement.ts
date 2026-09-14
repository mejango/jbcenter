import type { Hex } from "viem";
import { RestError, type RestBlockEvidence } from "../core.js";
import type { WalletDeploymentExecutionContext, WalletDeploymentDispatchJournal } from "./deploymentDispatch.js";
import type { WalletDeploymentPool } from "./deploymentPostgres.js";
import { assertWalletDeploymentObservation, type WalletDeploymentObservation } from "./deploymentObservation.js";
import { enrollmentDigest } from "./enrollment.js";

export interface WalletDeploymentLocalEnvironment {
  kind: "unforked-anvil";
  genesisHash: Hex;
  instanceId: Hex;
}
export interface WalletDeploymentAccountingFence {
  reason: "restore-required" | "environment-changed" | "finalized-anchor-replaced" | "nonce-conflict" | "balance-deficit";
  evidenceDigest: string;
  recordedAt: number;
}
export interface WalletDeploymentAccounting {
  version: "center-wallet-deployment-accounting-v1";
  environment: WalletDeploymentLocalEnvironment;
  initialHead: RestBlockEvidence;
  initialNonce: string;
  spentWei: string;
  sequence: number;
  nextNonce: string;
  lastSettlementId: string | null;
  lastSettlementAnchor: RestBlockEvidence | null;
  fence: WalletDeploymentAccountingFence | null;
}
export interface WalletDeploymentFundingContext {
  pool: WalletDeploymentPool;
  lastSettlement: WalletDeploymentSettlementReceipt | null;
}
/** Trusted local adapter output. JSON coherence never establishes RPC or database provenance. */
export interface WalletDeploymentFundingEvidence {
  version: "center-wallet-deployment-funding-v1";
  poolId: string;
  configurationDigest: string;
  poolRevision: number;
  accountingDigest: string | null;
  environment: WalletDeploymentLocalEnvironment;
  head: RestBlockEvidence;
  observedAt: number;
  expiresAt: number;
  confirmedNonce: string;
  pendingNonce: string;
  balanceWei: string;
  /** Canonical read at the retained settlement height. Null only before the first settlement. */
  previousAnchor: RestBlockEvidence | null;
}
export interface WalletDeploymentSettlementContext extends WalletDeploymentExecutionContext {
  dispatch: WalletDeploymentDispatchJournal | null;
  lastSettlement: WalletDeploymentSettlementReceipt | null;
}
export interface WalletDeploymentSettlementEvidence {
  version: "center-wallet-deployment-settlement-evidence-v1";
  funding: WalletDeploymentFundingEvidence;
  operationId: string;
  operationRevision: number;
  transactionHash: Hex;
  templateCommitment: Hex;
  observation: WalletDeploymentObservation;
  finalizedNonce: string;
  fees: { profile: "unforked-anvil-execution-fees-v1"; executionWei: string; totalWei: string };
}
export interface WalletDeploymentSettlementReceipt {
  version: "center-wallet-deployment-settlement-receipt-v1";
  id: string;
  poolId: string;
  operationId: string;
  evidenceDigest: string;
  evidence: WalletDeploymentSettlementEvidence;
  nonce: string;
  priorSequence: number;
  sequence: number;
  spentWei: string;
  nextNonce: string;
  settledAt: number;
}
export const walletDeploymentSettlementLimits = Object.freeze({ evidenceLifetimeMs: 5000, maximumHeadAgeMs: 300000 });
function invalid(): never { throw new RestError(409, "WALLET_DEPLOYMENT_SETTLEMENT_INVALID", "Qualified local accounting evidence does not match the durable context."); }
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      keys.some(key => !Object.hasOwn(value, key))) invalid();
}
function snapshot<T>(value: unknown): T {
  try { enrollmentDigest(value); return structuredClone(value) as T; } catch { return invalid(); }
}
function uint(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) >= 1n << 256n) invalid();
  return BigInt(value);
}
function integer(value: number, positive = false): void { if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) invalid(); }
function digest(value: unknown): void { if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) invalid(); }
function word(value: unknown): void { if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value) || BigInt(value) === 0n) invalid(); }
function uuid(value: unknown): void { if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) invalid(); }
function block(value: RestBlockEvidence): void {
  exact(value, ["chainId", "blockNumber", "blockHash", "timestamp", "source"]);
  if (value.chainId !== 8453 || value.source !== "onchain") invalid();
  uint(value.blockNumber); uint(value.timestamp); word(value.blockHash);
}
function environment(value: WalletDeploymentLocalEnvironment): void {
  exact(value, ["kind", "genesisHash", "instanceId"]); if (value.kind !== "unforked-anvil") invalid();
  word(value.genesisHash); word(value.instanceId);
}
export function walletDeploymentAccountingDigest(value: WalletDeploymentAccounting): string { return enrollmentDigest(value); }
export function walletDeploymentRemainingWei(pool: WalletDeploymentPool): string {
  const spent = pool.accounting ? uint(assertWalletDeploymentAccounting(pool.accounting, pool).spentWei) : 0n;
  return String(uint(pool.configuration.allocationWei) - spent);
}
export function assertWalletDeploymentAccounting(input: unknown, pool: WalletDeploymentPool): WalletDeploymentAccounting {
  const value = snapshot<WalletDeploymentAccounting>(input);
  exact(value, ["version", "environment", "initialHead", "initialNonce", "spentWei", "sequence", "nextNonce", "lastSettlementId", "lastSettlementAnchor", "fence"]);
  if (value.version !== "center-wallet-deployment-accounting-v1") invalid();
  environment(value.environment); block(value.initialHead); integer(value.sequence);
  const initial = uint(value.initialNonce), nonce = uint(value.nextNonce), spent = uint(value.spentWei);
  if (nonce !== initial + BigInt(value.sequence) || nonce > BigInt(Number.MAX_SAFE_INTEGER) || spent > uint(pool.configuration.allocationWei)) invalid();
  if (value.sequence === 0) {
    if (spent !== 0n || value.lastSettlementId !== null || value.lastSettlementAnchor !== null) invalid();
  } else {
    if (spent === 0n || value.lastSettlementAnchor === null) invalid();
    uuid(value.lastSettlementId); block(value.lastSettlementAnchor);
    if (uint(value.lastSettlementAnchor.blockNumber) < uint(value.initialHead.blockNumber)) invalid();
  }
  if (value.fence !== null) {
    exact(value.fence, ["reason", "evidenceDigest", "recordedAt"]);
    if (!["restore-required", "environment-changed", "finalized-anchor-replaced", "nonce-conflict", "balance-deficit"].includes(value.fence.reason)) invalid();
    digest(value.fence.evidenceDigest); integer(value.fence.recordedAt, true);
  }
  return value;
}
export function assertWalletDeploymentFundingEvidence(input: unknown, context: WalletDeploymentFundingContext, now: number): WalletDeploymentFundingEvidence {
  const value = snapshot<WalletDeploymentFundingEvidence>(input), pool = snapshot<WalletDeploymentPool>(context.pool);
  exact(value, ["version", "poolId", "configurationDigest", "poolRevision", "accountingDigest", "environment", "head", "observedAt", "expiresAt", "confirmedNonce", "pendingNonce", "balanceWei", "previousAnchor"]);
  if (value.version !== "center-wallet-deployment-funding-v1" || value.poolId !== pool.configuration.id ||
      value.configurationDigest !== pool.configurationDigest || value.configurationDigest !== enrollmentDigest(pool.configuration) ||
      value.poolRevision !== pool.revision) invalid();
  uuid(value.poolId); digest(value.configurationDigest); integer(value.poolRevision); environment(value.environment); block(value.head);
  const accounting = pool.accounting ? assertWalletDeploymentAccounting(pool.accounting, pool) : null;
  if (value.accountingDigest !== (accounting ? walletDeploymentAccountingDigest(accounting) : null)) invalid();
  if (accounting?.lastSettlementAnchor) {
    if (!value.previousAnchor) {
      if (enrollmentDigest(value.environment) === enrollmentDigest(accounting.environment) &&
          uint(value.head.blockNumber) >= uint(accounting.lastSettlementAnchor.blockNumber)) invalid();
    } else { block(value.previousAnchor); if (value.previousAnchor.blockNumber !== accounting.lastSettlementAnchor.blockNumber) invalid(); }
  } else if (value.previousAnchor !== null) invalid();
  integer(now, true); integer(value.observedAt, true); integer(value.expiresAt, true);
  if (value.observedAt > now || value.expiresAt <= now || value.expiresAt <= value.observedAt ||
      value.expiresAt > value.observedAt + walletDeploymentSettlementLimits.evidenceLifetimeMs ||
      BigInt(value.expiresAt) > uint(value.head.timestamp) * 1000n + BigInt(walletDeploymentSettlementLimits.maximumHeadAgeMs) ||
      uint(value.head.timestamp) * 1000n > BigInt(now + 30000)) invalid();
  if (uint(value.confirmedNonce) > BigInt(Number.MAX_SAFE_INTEGER) || uint(value.pendingNonce) > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
  uint(value.balanceWei);
  return value;
}
export function walletDeploymentFundingConflict(context: WalletDeploymentFundingContext, evidence: WalletDeploymentFundingEvidence,
  expectedNonce?: string, requiredBalance?: string): WalletDeploymentAccountingFence["reason"] | null {
  const accounting = context.pool.accounting;
  if (accounting && enrollmentDigest(accounting.environment) !== enrollmentDigest(evidence.environment)) return "environment-changed";
  if (accounting?.lastSettlementAnchor && enrollmentDigest(accounting.lastSettlementAnchor) !== enrollmentDigest(evidence.previousAnchor)) return "finalized-anchor-replaced";
  const nonce = expectedNonce ?? accounting?.nextNonce;
  if (nonce !== undefined && (evidence.confirmedNonce !== nonce || evidence.pendingNonce !== nonce)) return "nonce-conflict";
  if (uint(evidence.balanceWei) < uint(requiredBalance ?? walletDeploymentRemainingWei(context.pool))) return "balance-deficit";
  return null;
}
export function assertWalletDeploymentSettlementEvidence(input: unknown, context: WalletDeploymentSettlementContext, now: number): WalletDeploymentSettlementEvidence {
  const value = snapshot<WalletDeploymentSettlementEvidence>(input), { pool, operation } = snapshot<WalletDeploymentSettlementContext>(context);
  exact(value, ["version", "funding", "operationId", "operationRevision", "transactionHash", "templateCommitment", "observation", "finalizedNonce", "fees"]);
  const funding = assertWalletDeploymentFundingEvidence(value.funding, context, now);
  if (!pool.accounting || pool.accounting.fence || pool.state !== "active" || pool.activeOperationId !== operation.id ||
      operation.state !== "signed" || !operation.signed || !operation.template || operation.poolId !== pool.configuration.id ||
      value.version !== "center-wallet-deployment-settlement-evidence-v1" || value.operationId !== operation.id ||
      value.operationRevision !== operation.revision || value.transactionHash !== operation.signed.hash || value.templateCommitment !== operation.templateCommitment ||
      operation.templateCommitment !== `0x${enrollmentDigest(operation.template)}` ||
      operation.template.transaction.nonce !== pool.accounting.nextNonce) invalid();
  const observation = assertWalletDeploymentObservation(value.observation), receipt = observation.transaction.receipt;
  if (observation.operationId !== operation.id || observation.transactionHash !== operation.signed.hash || observation.templateCommitment !== operation.templateCommitment ||
      !receipt || !["canonical-success", "canonical-revert"].includes(observation.transaction.state) ||
      observation.finality.state !== "finalized" || !observation.finality.evidence || !observation.head ||
      enrollmentDigest(observation.head) !== enrollmentDigest(funding.head) || observation.observedAt > funding.observedAt ||
      funding.expiresAt > observation.observedAt + walletDeploymentSettlementLimits.evidenceLifetimeMs ||
      (operation.highestObservedHead !== null && uint(observation.head.blockNumber) < uint(operation.highestObservedHead)) ||
      observation.wallet.address.toLowerCase() !== operation.template.predictedSafe.toLowerCase() || observation.wallet.initializerHash !== operation.template.initializerHash) invalid();
  if (operation.historicalCanonicalObservation?.finality.state === "finalized" &&
      enrollmentDigest(operation.historicalCanonicalObservation.transaction.receipt) !== enrollmentDigest(receipt)) invalid();
  exact(value.fees, ["profile", "executionWei", "totalWei"]);
  const cost = uint(value.fees.totalWei), actual = uint(receipt.gasUsed) * uint(receipt.effectiveGasPrice);
  if (value.fees.profile !== "unforked-anvil-execution-fees-v1" || cost === 0n || cost !== actual ||
      value.fees.executionWei !== value.fees.totalWei || observation.fees.executionWei !== value.fees.executionWei ||
      cost > uint(operation.signed.maximumExecutionCost) || uint(receipt.gasUsed) > uint(operation.template.transaction.gas) ||
      uint(receipt.effectiveGasPrice) > uint(operation.template.transaction.maxFeePerGas)) invalid();
  if (uint(value.finalizedNonce) > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
  return { ...value, funding, observation };
}
