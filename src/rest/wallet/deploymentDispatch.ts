import type { Hex } from "viem";
import { RestError, type RestBlockEvidence } from "../core.js";
import type { WalletEnrollment } from "./enrollment.js";
import { enrollmentDigest } from "./enrollment.js";
import { assertWalletDeploymentObservation } from "./deploymentObservation.js";
import type { WalletDeploymentOperation, WalletDeploymentPool } from "./deploymentPostgres.js";
import { assertWalletDeploymentAccounting, walletDeploymentAccountingDigest, walletDeploymentRemainingWei } from "./deploymentSettlement.js";

/** Internal database-loaded context. A matching JSON shape does not establish its provenance. */
export interface WalletDeploymentExecutionContext {
  pool: WalletDeploymentPool;
  enrollment: WalletEnrollment;
  operation: WalletDeploymentOperation;
}
/** Only the explicit local Anvil adapter may produce this experimental admission. It grants no
 * Base affordability claim and is not accepted from a public request or a deployment proof. */
interface WalletDeploymentDispatchAdmissionFields {
  operationId: string;
  poolConfigurationDigest: string;
  templateCommitment: Hex;
  transactionHash: Hex;
  operationRevision: number;
  observationDigest: string;
  environment: { kind: "unforked-anvil"; genesisHash: Hex; head: RestBlockEvidence };
  observedAt: number;
  expiresAt: number;
  balanceWei: string;
  maximumExecutionCost: string;
  feeScope: "local-execution-only";
  baseTotalAffordability: "unknown";
}
export type WalletDeploymentDispatchAdmission = WalletDeploymentDispatchAdmissionFields & (
  { version: "center-wallet-deployment-local-admission-v1"; accounting?: never } |
  { version: "center-wallet-deployment-local-admission-v2"; accounting: { digest: string; remainingWei: string; nextNonce: string } }
);
export const walletDeploymentDispatchLimits = Object.freeze({ maximumAttempts: 8, leaseMs: 15_000,
  cooldownMs: 1_000, admissionLifetimeMs: 5_000, sendTimeoutMs: 3_000 });
export interface WalletDeploymentDispatchJournal {
  operationId: string;
  transactionHash: Hex;
  templateCommitment: Hex;
  revision: number;
  attempts: number;
  status: "in-flight" | "accepted" | "unknown";
  leaseToken: string;
  leaseUntil: number;
  admission: WalletDeploymentDispatchAdmission;
  admissionDigest: string;
  claimedAt: number;
  settledAt: number | null;
  nextAttemptAt: number;
}
export interface WalletDeploymentDispatchClaim {
  operationId: string;
  expectedRevision: number;
  signedHash: Hex;
  admission: WalletDeploymentDispatchAdmission;
  leaseMs?: number;
}
export interface WalletDeploymentDispatchSettlement {
  operationId: string;
  expectedRevision: number;
  leaseToken: string;
  signedHash: Hex;
  status: "accepted" | "unknown";
}
/** Shape and immutable-context binding only. The configured local producer supplies evidence. */
export function assertWalletDeploymentDispatchAdmission(input: unknown,
  context: WalletDeploymentExecutionContext, now: number): WalletDeploymentDispatchAdmission {
  const fail = (): never => { throw new RestError(403, "WALLET_DEPLOYMENT_DISPATCH_DISABLED", "Fresh verified local deployment admission is required."); };
  const exact = (value: unknown, fields: string[]): void => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length ||
      Object.keys(value).some(key => !fields.includes(key))) fail();
  };
  try {
    enrollmentDigest(input);
    const initialized = !!context.pool.accounting;
    exact(input, ["version", "operationId", "poolConfigurationDigest", "templateCommitment", "transactionHash", "operationRevision",
      "observationDigest", "environment", "observedAt", "expiresAt", "balanceWei", "maximumExecutionCost", "feeScope", "baseTotalAffordability",
      ...(initialized ? ["accounting"] : [])]);
    const value = structuredClone(input) as WalletDeploymentDispatchAdmission;
    exact(value.environment, ["kind", "genesisHash", "head"]);
    const { operation, pool } = context, observation = assertWalletDeploymentObservation(operation.observation);
    const integer = (v: number): boolean => Number.isSafeInteger(v) && v > 0;
    const amount = (v: string): bigint => {
      if (typeof v !== "string" || v.length > 78 || !/^(0|[1-9][0-9]*)$/.test(v) || BigInt(v) >= 1n << 256n) fail();
      return BigInt(v);
    };
    const remaining = walletDeploymentRemainingWei(pool);
    if (initialized) {
      const accounting = assertWalletDeploymentAccounting(pool.accounting, pool);
      if (value.version !== "center-wallet-deployment-local-admission-v2") return fail();
      exact(value.accounting, ["digest", "remainingWei", "nextNonce"]);
      if (accounting.fence || value.accounting.digest !== walletDeploymentAccountingDigest(accounting) ||
          value.accounting.remainingWei !== remaining || value.accounting.nextNonce !== accounting.nextNonce ||
          accounting.nextNonce !== operation.template?.transaction.nonce || value.environment.genesisHash !== accounting.environment.genesisHash) fail();
    } else if (value.version !== "center-wallet-deployment-local-admission-v1") fail();
    if (value.environment.kind !== "unforked-anvil" ||
      value.feeScope !== "local-execution-only" || value.baseTotalAffordability !== "unknown" ||
      !/^0x[0-9a-f]{64}$/.test(value.environment.genesisHash) || BigInt(value.environment.genesisHash) === 0n ||
      operation.state !== "signed" || !operation.signed || !operation.template || pool.state !== "active" || pool.activeOperationId !== operation.id ||
      operation.poolId !== pool.configuration.id || operation.poolConfigurationDigest !== pool.configurationDigest ||
      operation.poolConfigurationDigest !== enrollmentDigest(pool.configuration) ||
      value.operationId !== operation.id || value.transactionHash !== operation.signed.hash ||
      value.templateCommitment !== operation.templateCommitment || value.templateCommitment !== `0x${enrollmentDigest(operation.template)}` ||
      value.poolConfigurationDigest !== pool.configurationDigest || value.operationRevision !== operation.revision ||
      value.observationDigest !== enrollmentDigest(observation) || !observation.head ||
      observation.operationId !== operation.id || observation.transactionHash !== operation.signed.hash ||
      observation.templateCommitment !== operation.templateCommitment ||
      observation.wallet.address.toLowerCase() !== operation.template.predictedSafe.toLowerCase() ||
      observation.wallet.initializerHash !== operation.template.initializerHash ||
      (operation.highestObservedHead !== null && BigInt(observation.head.blockNumber) < BigInt(operation.highestObservedHead)) ||
      observation.transaction.state !== "not-observed" || observation.wallet.state !== "undeployed" ||
      observation.transaction.nonce?.confirmed !== operation.template.transaction.nonce ||
      observation.transaction.nonce.pending !== operation.template.transaction.nonce ||
      observation.finality.state !== "unknown" || operation.historicalCanonicalObservation?.finality.state === "finalized" ||
      enrollmentDigest(value.environment.head) !== enrollmentDigest(observation.head) ||
      !integer(now) || !integer(value.observedAt) || !integer(value.expiresAt) || value.observedAt > now || value.expiresAt <= now ||
      value.observedAt < observation.observedAt || value.expiresAt - value.observedAt > walletDeploymentDispatchLimits.admissionLifetimeMs ||
      value.expiresAt > observation.observedAt + pool.configuration.policy.maximumObservationAgeMs ||
      BigInt(value.expiresAt) > (BigInt(observation.head.timestamp) + 300n) * 1000n ||
      value.maximumExecutionCost !== operation.signed.maximumExecutionCost ||
      amount(value.maximumExecutionCost) !== amount(operation.template.transaction.gas) * amount(operation.template.transaction.maxFeePerGas) ||
      amount(value.balanceWei) < amount(remaining) ||
      amount(value.maximumExecutionCost) > amount(remaining)) fail();
    return value;
  } catch { return fail(); }
}
