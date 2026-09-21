import { randomUUID } from "node:crypto";
import { isProxy } from "node:util/types";
import type { Pool, PoolClient } from "pg";
import { getAddress, hashTypedData, isAddress, type Address, type Hex } from "viem";
import { RestError } from "../core.js";
import type { RelayPolicy } from "../transactions/types.js";
import { prepareWalletDeploymentTemplate, validateSignedWalletDeployment, verifyWalletDeploymentProof,
  walletDeploymentDocument, type WalletDeploymentApproval, type WalletDeploymentTemplate } from "./deployment.js";
import { enrollmentDigest, type WalletEnrollment } from "./enrollment.js";
import { currentWalletCredentialInTransaction, lockWalletEnrollmentInTransaction, PostgresWalletEnrollmentStore } from "./enrollmentPostgres.js";
import { lockWalletCeremonyAdmission, PostgresWalletCeremonyStore, walletCeremonyDatabaseNow } from "./ceremoniesPostgres.js";
import { walletCeremonyRetentionMs } from "./ceremonies.js";
import type { WalletAssertion, WalletCeremonyOptions } from "./webauthn.js";
import { assertWalletDeploymentObservation, type WalletDeploymentObservation } from "./deploymentObservation.js";
import { assertWalletDeploymentDispatchAdmission, walletDeploymentDispatchLimits } from "./deploymentDispatch.js";
import type { WalletDeploymentExecutionContext, WalletDeploymentDispatchClaim, WalletDeploymentDispatchJournal,
  WalletDeploymentDispatchSettlement } from "./deploymentDispatch.js";

export interface WalletDeploymentPoolConfiguration {
  id: string;
  chainId: 8453;
  sender: Address;
  allocationWei: string;
  globalAllocationLimitWei: string;
  policy: {
    maximumRawBytes: number;
    maximumGas: string;
    maximumFeePerGas: string;
    maximumTransactionCost: string;
    maximumObservationAgeMs: number;
  };
}
import { assertWalletDeploymentAccounting, assertWalletDeploymentFundingEvidence, assertWalletDeploymentSettlementEvidence,
  walletDeploymentFundingConflict, walletDeploymentReleasedCount, walletDeploymentRemainingWei, walletDeploymentSettlementLimits,
  walletDeploymentSettlementNonceConflict } from "./deploymentSettlement.js";
import type { WalletDeploymentAccounting, WalletDeploymentFundingContext, WalletDeploymentFundingEvidence,
  WalletDeploymentSettlementContext, WalletDeploymentSettlementEvidence, WalletDeploymentSettlementReceipt } from "./deploymentSettlement.js";

export interface WalletDeploymentPool {
  /** Absent/null preserves the original single unresolved lane; it cannot settle. */
  accounting?: WalletDeploymentAccounting | null;
  configuration: WalletDeploymentPoolConfiguration;
  configurationDigest: string;
  createdAt: number;
  state: "active" | "paused";
  /** The one operation not yet canonically included; null once released or settled. */
  activeOperationId: string | null;
  /** Sum of the released, unsettled operations' reserved maximum costs (derived from their rows). */
  reservedWei: string;
  revision: number;
}
/** Internal trusted chain-adapter output only. Shape validation cannot prove canonical chain facts. */
export interface WalletDeploymentAdmission {
  version: "center-wallet-deployment-admission-v1";
  chainId: 8453;
  sender: Address;
  blockNumber: string;
  blockHash: Hex;
  confirmedNonce: string;
  pendingNonce: string;
  observedAt: number;
  enrollmentCommitment: Hex;
  manifestRevision: Hex;
  initializerHash: Hex;
  gas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
}
export interface WalletDeploymentOperation {
  id: string;
  poolId: string;
  enrollmentId: string;
  poolConfigurationDigest: string;
  approval: WalletDeploymentApproval;
  state: "prepared" | "claimed" | "signed";
  createdAt: number;
  retainUntil: number;
  claimedAt: number | null;
  proofDigest: string | null;
  admission: WalletDeploymentAdmission | null;
  template: WalletDeploymentTemplate | null;
  templateCommitment: Hex | null;
  signingLease: { token: string; until: number } | null;
  signed: { rawTransaction: Hex; hash: Hex; maximumExecutionCost: string } | null;
  observation: WalletDeploymentObservation | null;
  observationSavedAt: number | null;
  /** Retained receipt evidence only; never a claim that it is still canonical or finalized. */
  historicalCanonicalObservation: WalletDeploymentObservation | null;
  /** Provider-head high watermark only; it does not establish current canonical chain truth. */
  highestObservedHead: string | null;
  /** Permanent one-way marker; phase and original signed artifact remain unchanged. */
  settlementId?: string;
  /** Set when the lane was released at this operation's canonical inclusion; its reserved maximum
   * cost stays committed against the allocation until the finalized settlement. */
  releasedAt: number | null;
  reservedWei: string | null;
  revision: number;
}
export interface WalletDeploymentObservationCommit {
  operationId: string;
  expectedRevision: number;
  signedHash: Hex;
  observation: WalletDeploymentObservation;
}
export interface WalletDeploymentRecoveryCursor { createdAt: number; operationId: string }
export interface WalletDeploymentRecoveryPage {
  items: { id: string; createdAt: number; revision: number; state: "claimed" | "signed"; signedHash: Hex | null; nonce: string | null; releasedAt: number | null }[];
  nextCursor: WalletDeploymentRecoveryCursor | null;
}
export interface WalletDeploymentClaim {
  operationId: string;
  assertion: WalletAssertion;
  /** The app admitted to frame the page the approval was made on, when it was. */
  topOrigin?: string;
  funding?: WalletDeploymentFundingEvidence;
  admission: WalletDeploymentAdmission;
}
export interface WalletDeploymentSignedCommit {
  operationId: string;
  leaseToken: string;
  revision: number;
  rawTransaction: Hex;
}
interface DispatchRow {
  operation_id: string; transaction_hash: Hex; template_commitment: Hex; revision: string; attempts: number;
  status: WalletDeploymentDispatchJournal["status"]; lease_token: string; lease_until: string;
  admission: WalletDeploymentDispatchJournal["admission"]; admission_digest: string; claimed_at: string;
  settled_at: string | null; next_attempt_at: string;
}
function dispatchOf(row: DispatchRow): WalletDeploymentDispatchJournal {
  return { operationId: row.operation_id, transactionHash: row.transaction_hash, templateCommitment: row.template_commitment,
    revision: Number(row.revision), attempts: row.attempts, status: row.status, leaseToken: row.lease_token,
    leaseUntil: Number(row.lease_until), admission: row.admission, admissionDigest: row.admission_digest,
    claimedAt: Number(row.claimed_at), settledAt: row.settled_at === null ? null : Number(row.settled_at), nextAttemptAt: Number(row.next_attempt_at) };
}

const nowSql = "floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const word = /^0x[0-9a-f]{64}$/;
const maxUint256 = (1n << 256n) - 1n;
const commitment = (value: unknown): Hex => `0x${enrollmentDigest(value)}`;
function invalid(): never { throw new RestError(400, "WALLET_DEPLOYMENT_INVALID", "Deployment storage fields or bounds are invalid."); }
function conflict(): never { throw new RestError(409, "WALLET_DEPLOYMENT_CONFLICT", "Deployment does not match its immutable allocation or operation."); }
function missing(): never { throw new RestError(404, "WALLET_DEPLOYMENT_NOT_FOUND", "Deployment or pool is unavailable."); }
function expired(): never { throw new RestError(410, "WALLET_DEPLOYMENT_EXPIRED", "Fresh deployment admission has expired."); }
function busy(lease = false): never { throw new RestError(409, lease ? "WALLET_DEPLOYMENT_LEASE_BUSY" : "WALLET_DEPLOYMENT_BUSY", "Deployment sender lane or signing lease is occupied."); }
function id(value: string): void { if (typeof value !== "string" || !uuid.test(value)) invalid(); }
function fields(value: unknown, names: readonly string[]): void {
  try { enrollmentDigest(value); } catch { invalid(); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== names.length ||
      Object.keys(value).some(key => !names.includes(key))) invalid();
}
function positiveTime(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
function ownFields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const keys = Reflect.ownKeys(value), output: Record<string, unknown> = {};
  if (required.some(key => !keys.includes(key)) || keys.some(key => typeof key !== "string" || ![...required, ...optional].includes(key))) invalid();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor) || !descriptor.enumerable) invalid();
    output[key as string] = descriptor.value;
  }
  return output;
}
function canonicalObservation(value: WalletDeploymentObservation): boolean {
  return value.transaction.state === "canonical-success" || value.transaction.state === "canonical-revert";
}
function advanceObservation(current: WalletDeploymentOperation, observation: WalletDeploymentObservation): {
  historical: WalletDeploymentObservation | null; highestHead: string | null;
} {
  if (current.observation && observation.observedAt < current.observation.observedAt) conflict();
  const canonical = canonicalObservation(observation);
  const positive = canonical || observation.wallet.state === "verified" || observation.finality.state === "finalized";
  if (positive && current.highestObservedHead !== null && (!observation.head ||
      BigInt(observation.head.blockNumber) < BigInt(current.highestObservedHead))) conflict();
  let historical = current.historicalCanonicalObservation;
  if (historical?.finality.state === "finalized" && observation.transaction.state === "nonce-conflict") conflict();
  if (canonical) {
    if (historical?.finality.state === "finalized") {
      // A finalized receipt cannot silently become a different inclusion, status or receipt body.
      // Reorg/unknown observations remain admissible as latest evidence while retaining history.
      if (enrollmentDigest(observation.transaction.receipt) !== enrollmentDigest(historical.transaction.receipt) ||
          observation.finality.state === "unfinalized") conflict();
      if (observation.finality.state === "finalized") {
        const next = observation.finality.evidence!, prior = historical.finality.evidence!;
        if (BigInt(next.blockNumber) < BigInt(prior.blockNumber) ||
            (next.blockNumber === prior.blockNumber && enrollmentDigest(next) !== enrollmentDigest(prior))) conflict();
        historical = observation;
      }
      // Missing finality does not erase the retained finalized receipt.
    } else historical = observation;
  }
  let highestHead = current.highestObservedHead;
  if (observation.head && (highestHead === null || BigInt(observation.head.blockNumber) > BigInt(highestHead)))
    highestHead = observation.head.blockNumber;
  return { historical, highestHead };
}
function quantity(value: string, positive = false, maximum = maxUint256): bigint {
  if (typeof value !== "string" || value.length > 78 || !/^(0|[1-9][0-9]*)$/.test(value)) invalid();
  const number = BigInt(value);
  if (number > maximum || (positive && number === 0n)) invalid();
  return number;
}
function configuration(input: WalletDeploymentPoolConfiguration): WalletDeploymentPoolConfiguration {
  fields(input, ["id", "chainId", "sender", "allocationWei", "globalAllocationLimitWei", "policy"]);
  id(input.id);
  fields(input.policy, ["maximumRawBytes", "maximumGas", "maximumFeePerGas", "maximumTransactionCost", "maximumObservationAgeMs"]);
  if (input.chainId !== 8453 || !isAddress(input.sender) || BigInt(input.sender) <= 1n ||
      !Number.isSafeInteger(input.policy.maximumRawBytes) || input.policy.maximumRawBytes < 1 || input.policy.maximumRawBytes > 131_072 ||
      !Number.isSafeInteger(input.policy.maximumObservationAgeMs) || input.policy.maximumObservationAgeMs < 1 ||
      input.policy.maximumObservationAgeMs > 60_000) invalid();
  const allocation = quantity(input.allocationWei, true);
  if (allocation > quantity(input.globalAllocationLimitWei, true) || quantity(input.policy.maximumTransactionCost, true) > allocation) invalid();
  quantity(input.policy.maximumGas, true); quantity(input.policy.maximumFeePerGas, true);
  return { ...structuredClone(input), sender: getAddress(input.sender).toLowerCase() as Address };
}
function relayPolicy(config: WalletDeploymentPoolConfiguration): RelayPolicy {
  return { planTtlMs: 300_000, maximumPlanTtlMs: 300_000, leaseMs: 15_000, rpcTimeoutMs: 1_000,
    maximumRawBytes: config.policy.maximumRawBytes, maximumGas: BigInt(config.policy.maximumGas),
    maximumFeePerGas: BigInt(config.policy.maximumFeePerGas), maximumTransactionCost: BigInt(config.policy.maximumTransactionCost),
    confirmations: 1, allowedChainIds: [8453] };
}
export { relayPolicy as walletDeploymentRelayPolicy };
function copyProof(input: WalletAssertion): WalletAssertion {
  const keys = ["credentialId", "userHandle", "authenticatorData", "clientDataJSON", "signature"];
  if (!input || typeof input !== "object" || Object.keys(input).length !== keys.length ||
      keys.some(key => !Object.hasOwn(input, key) || !("value" in Object.getOwnPropertyDescriptor(input, key)!)) ||
      typeof input.credentialId !== "string" || input.credentialId.length > 1364 ||
      (input.userHandle !== null && (typeof input.userHandle !== "string" || input.userHandle.length > 86))) invalid();
  const bytes = (value: Uint8Array, min: number, max: number): Uint8Array => {
    if (!(value instanceof Uint8Array) || value.byteLength < min || value.byteLength > max) invalid();
    return Uint8Array.from(value);
  };
  return { credentialId: input.credentialId, userHandle: input.userHandle, authenticatorData: bytes(input.authenticatorData, 37, 37),
    clientDataJSON: bytes(input.clientDataJSON, 1, 2048), signature: bytes(input.signature, 8, 72) };
}
function checkedAdmission(input: WalletDeploymentAdmission): WalletDeploymentAdmission {
  fields(input, ["version", "chainId", "sender", "blockNumber", "blockHash", "confirmedNonce", "pendingNonce", "observedAt",
    "enrollmentCommitment", "manifestRevision", "initializerHash", "gas", "maxFeePerGas", "maxPriorityFeePerGas"]);
  if (input.version !== "center-wallet-deployment-admission-v1" || input.chainId !== 8453 || !isAddress(input.sender) ||
      input.sender !== input.sender.toLowerCase() || !positiveTime(input.observedAt) ||
      [input.blockHash, input.enrollmentCommitment, input.manifestRevision, input.initializerHash].some(value => !word.test(value)) ||
      BigInt(input.blockHash) === 0n) invalid();
  quantity(input.blockNumber); quantity(input.confirmedNonce, false, BigInt(Number.MAX_SAFE_INTEGER));
  quantity(input.pendingNonce, false, BigInt(Number.MAX_SAFE_INTEGER));
  quantity(input.gas, true); quantity(input.maxFeePerGas, true); quantity(input.maxPriorityFeePerGas, true);
  if (input.pendingNonce !== input.confirmedNonce) conflict();
  return structuredClone(input);
}
function admissionTemplate(enrollment: WalletEnrollment, operation: WalletDeploymentOperation, pool: WalletDeploymentPool,
  admission: WalletDeploymentAdmission): WalletDeploymentTemplate {
  if (admission.sender !== pool.configuration.sender || admission.enrollmentCommitment !== operation.approval.enrollmentCommitment ||
      admission.manifestRevision !== enrollment.intent.manifest.revision || admission.initializerHash !== enrollment.creation!.initializerHash) conflict();
  return prepareWalletDeploymentTemplate(enrollment, operation.approval, { sender: admission.sender, nonce: admission.confirmedNonce,
    gas: admission.gas, maxFeePerGas: admission.maxFeePerGas, maxPriorityFeePerGas: admission.maxPriorityFeePerGas }, relayPolicy(pool.configuration));
}
function live(operation: WalletDeploymentOperation, now: number, admission?: WalletDeploymentAdmission, pool?: WalletDeploymentPool): void {
  if (now < operation.approval.issuedAt || now >= operation.approval.expiresAt) expired();
  if (admission && pool && (admission.observedAt > now || now - admission.observedAt > pool.configuration.policy.maximumObservationAgeMs))
    throw new RestError(410, "WALLET_DEPLOYMENT_OBSERVATION_EXPIRED", "Deployment chain admission must be refreshed.");
}
type PoolRow = { configuration: WalletDeploymentPoolConfiguration; configuration_digest: string; created_at: string;
  state: WalletDeploymentPool["state"]; active_operation_id: string | null; revision: string; accounting?: WalletDeploymentAccounting | null; reserved_wei: string };
const poolSelect = "SELECT p.*,rest_wallet_deployment_reserved_wei(p.id)::text AS reserved_wei FROM rest_wallet_deployment_pools p";
function poolOf(row: PoolRow): WalletDeploymentPool {
  const checked = configuration(row.configuration);
  if (enrollmentDigest(checked) !== row.configuration_digest) conflict();
  const result: WalletDeploymentPool = { configuration: checked, configurationDigest: row.configuration_digest, createdAt: Number(row.created_at),
    state: row.state, activeOperationId: row.active_operation_id, reservedWei: String(quantity(row.reserved_wei)), revision: Number(row.revision) };
  if (row.accounting) result.accounting = assertWalletDeploymentAccounting(row.accounting, result);
  return result;
}
type OperationRow = { id: string; pool_id: string; enrollment_id: string; pool_configuration_digest: string; approval: WalletDeploymentApproval;
  state: WalletDeploymentOperation["state"]; created_at: string; retain_until: string; claimed_at: string | null; proof_digest: string | null;
  admission: WalletDeploymentAdmission | null; template: WalletDeploymentTemplate | null; template_commitment: Hex | null;
  signing_lease_token: string | null; signing_lease_until: string | null; raw_transaction: Hex | null; transaction_hash: Hex | null;
  maximum_execution_cost: string | null; revision: string; observation: WalletDeploymentObservation | null;
  observation_saved_at: string | null; historical_canonical_observation: WalletDeploymentObservation | null; highest_observed_head: string | null; settlement_id?: string | null;
  released_at: string | null; reserved_wei: string | null };
function operationOf(row: OperationRow): WalletDeploymentOperation {
  return { id: row.id, poolId: row.pool_id, enrollmentId: row.enrollment_id, poolConfigurationDigest: row.pool_configuration_digest,
    approval: row.approval, state: row.state, createdAt: Number(row.created_at), retainUntil: Number(row.retain_until),
    claimedAt: row.claimed_at === null ? null : Number(row.claimed_at), proofDigest: row.proof_digest, admission: row.admission,
    template: row.template, templateCommitment: row.template_commitment,
    signingLease: row.signing_lease_token === null ? null : { token: row.signing_lease_token, until: Number(row.signing_lease_until) },
    signed: row.raw_transaction === null ? null : { rawTransaction: row.raw_transaction, hash: row.transaction_hash!, maximumExecutionCost: row.maximum_execution_cost! },
    observation: row.observation ?? null, observationSavedAt: row.observation_saved_at == null ? null : Number(row.observation_saved_at),
    historicalCanonicalObservation: row.historical_canonical_observation ?? null, highestObservedHead: row.highest_observed_head ?? null,
    ...(row.settlement_id ? { settlementId: row.settlement_id } : {}),
    releasedAt: row.released_at == null ? null : Number(row.released_at), reservedWei: row.reserved_wei == null ? null : String(quantity(row.reserved_wei)),
    revision: Number(row.revision) };
}

/** Internal durable store only. Admission observations must come from the configured trusted chain
 * adapter; this class cannot establish onchain truth, sign or publish. Only explicitly initialized
 * local accounting can release a lane after qualified finality and a permanent exact fee debit.
 * All public records here are internal: signed bytes must not be returned by a future status route. */
export class PostgresWalletDeploymentStore {
  private readonly ceremonies: PostgresWalletCeremonyStore;
  private readonly enrollments: PostgresWalletEnrollmentStore;
  constructor(private readonly pool: Pool) {
    this.ceremonies = new PostgresWalletCeremonyStore(pool);
    this.enrollments = new PostgresWalletEnrollmentStore(pool);
  }

  async loadFundingContext(poolId: string): Promise<WalletDeploymentFundingContext> {
    id(poolId);
    return this.transaction(async client => {
      const pool = await this.poolRecord(poolId, client);
      return { pool, lastSettlement: await this.lastSettlement(pool, client) };
    });
  }
  async initializeAccounting(contextInput: WalletDeploymentFundingContext, evidenceInput: WalletDeploymentFundingEvidence, expectedNonce: string): Promise<WalletDeploymentPool> {
    quantity(expectedNonce, false, BigInt(Number.MAX_SAFE_INTEGER));
    enrollmentDigest(contextInput); enrollmentDigest(evidenceInput);
    const context = structuredClone(contextInput), evidence = structuredClone(evidenceInput);
    return this.transaction(async client => {
      const pool = await this.poolRecord(context.pool.configuration.id, client);
      if (enrollmentDigest(pool) !== enrollmentDigest(context.pool) || pool.accounting || pool.activeOperationId || pool.state !== "active" || context.lastSettlement !== null) conflict();
      // Never initialize by adopting whatever nonce a provider happened to return. The host supplies
      // the expected first nonce for an unused explicitly local sender.
      const proof = assertWalletDeploymentFundingEvidence(evidence, context, await walletCeremonyDatabaseNow(client));
      if (walletDeploymentFundingConflict(context, proof, expectedNonce)) conflict();
      const accounting: WalletDeploymentAccounting = { version: "center-wallet-deployment-accounting-v1", environment: proof.environment,
        initialHead: proof.head, initialNonce: expectedNonce, nextNonce: expectedNonce, spentWei: "0", sequence: 0,
        lastSettlementId: null, lastSettlementAnchor: null, fence: null };
      const result = await this.writeAccounting(pool, accounting, client);
      assertWalletDeploymentFundingEvidence(proof, context, await walletCeremonyDatabaseNow(client));
      return result;
    });
  }
  /** Internal incident/restore boundary only. A field in this database cannot detect its own rollback. */
  async fenceAccounting(contextInput: WalletDeploymentFundingContext,
    evidenceInput: WalletDeploymentFundingEvidence | { reason: "restore-required" } | { reason: "inclusion-reorged"; operationId: string }): Promise<WalletDeploymentPool> {
    enrollmentDigest(contextInput); enrollmentDigest(evidenceInput);
    const context = structuredClone(contextInput), evidence = structuredClone(evidenceInput);
    return this.transaction(async client => {
      const pool = await this.poolRecord(context.pool.configuration.id, client);
      if (enrollmentDigest(pool) !== enrollmentDigest(context.pool) || !pool.accounting) conflict();
      if (pool.accounting.fence) return pool;
      const now = await walletCeremonyDatabaseNow(client);
      let reason: NonNullable<WalletDeploymentAccounting["fence"]>["reason"] | null;
      if ("reason" in evidence && evidence.reason === "inclusion-reorged") {
        // A released inclusion whose latest observation is positively not canonical any more.
        fields(evidence, ["reason", "operationId"]); id(evidence.operationId);
        const released = await this.required(evidence.operationId, client);
        if (released.poolId !== pool.configuration.id || released.releasedAt === null || released.settlementId !== undefined ||
            !released.observation || !["reorged", "nonce-conflict", "not-observed", "pending"].includes(released.observation.transaction.state)) conflict();
        reason = evidence.reason;
      } else if ("reason" in evidence) { fields(evidence, ["reason"]); if (evidence.reason !== "restore-required") invalid(); reason = evidence.reason; }
      else {
        const proof = assertWalletDeploymentFundingEvidence(evidence, context, now);
        reason = walletDeploymentFundingConflict(context, proof, pool.accounting.nextNonce, "0");
        // During an active lane, nonce+1 may be our own consumed transaction. Only settlement may
        // interpret that nonce. Environment/retained-finality contradictions are independent.
        if (pool.activeOperationId && reason === "nonce-conflict") conflict();
        if (!reason && !pool.activeOperationId) reason = walletDeploymentFundingConflict(context, proof);
      }
      if (!reason) conflict();
      const result = await this.writeAccounting(pool, { ...pool.accounting, fence: { reason, evidenceDigest: enrollmentDigest(evidence), recordedAt: now } }, client);
      if (!("reason" in evidence)) assertWalletDeploymentFundingEvidence(evidence, context, await walletCeremonyDatabaseNow(client));
      return result;
    });
  }
  async loadSettlementContext(operationId: string): Promise<WalletDeploymentSettlementContext> {
    id(operationId); const before = await this.required(operationId);
    return this.transaction(async client => {
      const pool = await this.poolRecord(before.poolId, client), enrollment = await lockWalletEnrollmentInTransaction(client, before.enrollmentId);
      const operation = await this.required(operationId, client); this.sameContext(before, operation, enrollment, pool);
      if (!pool.accounting || operation.state !== "signed" || !operation.signed || operation.settlementId !== undefined ||
          (pool.activeOperationId !== operation.id && operation.releasedAt === null)) conflict();
      const row = (await client.query<DispatchRow>("SELECT * FROM rest_wallet_deployment_dispatches WHERE operation_id=$1 FOR UPDATE", [operationId])).rows[0];
      return { pool, enrollment, operation, dispatch: row ? dispatchOf(row) : null, lastSettlement: await this.lastSettlement(pool, client) };
    });
  }
  async getSettlement(operationId: string): Promise<WalletDeploymentSettlementReceipt | null> {
    id(operationId);
    return (await this.pool.query<{ receipt: WalletDeploymentSettlementReceipt }>("SELECT receipt FROM rest_wallet_deployment_settlements WHERE id=$1", [operationId])).rows[0]?.receipt ?? null;
  }
  async settle(contextInput: WalletDeploymentSettlementContext, evidenceInput: WalletDeploymentSettlementEvidence): Promise<{
    settlement: WalletDeploymentSettlementReceipt | null; pool: WalletDeploymentPool; replayed: boolean;
  }> {
    enrollmentDigest(contextInput); enrollmentDigest(evidenceInput);
    const context = structuredClone(contextInput), evidence = structuredClone(evidenceInput);
    id(context.operation.id);
    // Validate shape/context outside locks, at the original capture time. Freshness at real DB time
    // follows replay lookup, so exact durable retries survive their original short evidence expiry.
    assertWalletDeploymentSettlementEvidence(evidence, context, evidence.funding.observedAt);
    const evidenceDigest = enrollmentDigest(evidence);
    return this.transaction(async client => {
      const pool = await this.poolRecord(context.pool.configuration.id, client);
      const enrollment = await lockWalletEnrollmentInTransaction(client, context.enrollment.intent.id);
      const operation = await this.required(context.operation.id, client);
      const existing = (await client.query<{ receipt: WalletDeploymentSettlementReceipt }>("SELECT receipt FROM rest_wallet_deployment_settlements WHERE id=$1", [operation.id])).rows[0]?.receipt;
      if (existing) {
        if (existing.evidenceDigest !== evidenceDigest || existing.evidence.transactionHash !== operation.signed?.hash) conflict();
        return { settlement: existing, pool, replayed: true };
      }
      const row = (await client.query<DispatchRow>("SELECT * FROM rest_wallet_deployment_dispatches WHERE operation_id=$1 FOR UPDATE", [operation.id])).rows[0];
      const actual: WalletDeploymentSettlementContext = { pool, enrollment, operation, dispatch: row ? dispatchOf(row) : null,
        lastSettlement: await this.lastSettlement(pool, client) };
      if (enrollmentDigest(actual) !== enrollmentDigest(context)) conflict();
      const now = await walletCeremonyDatabaseNow(client), proof = assertWalletDeploymentSettlementEvidence(evidence, actual, now);
      if (actual.dispatch && actual.dispatch.leaseUntil > now) busy();
      const nonce = operation.template!.transaction.nonce, nextNonce = String(BigInt(nonce) + 1n), cost = BigInt(proof.fees.totalWei);
      // The lane was released at inclusion; this operation's own reservation gives way to its debit
      // while the other released operations' reservations stay ahead of the balance floor, and so
      // does the active operation's: it may be included and paid before it is released.
      const allocation = BigInt(pool.configuration.allocationWei), spentWei = BigInt(pool.accounting!.spentWei) + cost;
      const others = BigInt(pool.reservedWei) - BigInt(operation.reservedWei ?? "0") + await this.activeReservation(pool, client);
      const floor = allocation - spentWei - others;
      const reason = walletDeploymentFundingConflict(actual, proof.funding, null, String(floor < 0n ? 0n : floor)) ??
        walletDeploymentSettlementNonceConflict(pool, nonce, proof.funding, proof.finalizedNonce);
      if (reason) {
        const fenced = await this.writeAccounting(pool, { ...pool.accounting!, fence: { reason, evidenceDigest, recordedAt: now } }, client);
        assertWalletDeploymentSettlementEvidence(proof, actual, await walletCeremonyDatabaseNow(client));
        return { settlement: null, pool: fenced, replayed: false };
      }
      const prior = pool.accounting!, sequence = prior.sequence + 1;
      const receipt: WalletDeploymentSettlementReceipt = { version: "center-wallet-deployment-settlement-receipt-v1", id: operation.id,
        operationId: operation.id, poolId: pool.configuration.id, evidenceDigest, evidence: proof, nonce,
        priorSequence: prior.sequence, sequence, spentWei: String(spentWei), nextNonce, settledAt: now };
      await client.query(`INSERT INTO rest_wallet_deployment_settlements(id,pool_id,sequence,evidence_digest,receipt)
        VALUES($1,$2,$3,$4,$5::jsonb)`, [operation.id, pool.configuration.id, sequence, evidenceDigest, JSON.stringify(receipt)]);
      await client.query("UPDATE rest_wallet_deployments SET settlement_id=$1 WHERE id=$1", [operation.id]);
      // A Base reservation is not a cap: the actual finalized debit is retained even above the
      // allocation, and the pool is fenced for operator review instead of admitting another user.
      const result = await this.writeAccounting(pool, { ...prior, sequence, spentWei: String(spentWei), lastSettlementId: operation.id,
        lastSettlementAnchor: proof.observation.finality.evidence!,
        fence: spentWei > allocation ? { reason: "allocation-exceeded", evidenceDigest, recordedAt: now } : null }, client);
      // Covers row/trigger/index/write waits. No bytes are broadcast and no RPC/crypto runs in SQL.
      assertWalletDeploymentSettlementEvidence(proof, actual, await walletCeremonyDatabaseNow(client));
      return { settlement: receipt, pool: result, replayed: false };
    });
  }
  /** The active operation's admitted maximum cost once signed: its Base reservation, else its execution ceiling. */
  private async activeReservation(pool: WalletDeploymentPool, client: PoolClient): Promise<bigint> {
    if (!pool.activeOperationId) return 0n;
    const row = (await client.query<{ reserved: string | null }>(`SELECT GREATEST(a.maximum_execution_cost,COALESCE((SELECT (admission->'reservation'->>'totalWei')::numeric
      FROM rest_wallet_deployment_dispatches WHERE operation_id=a.id),0))::text AS reserved FROM rest_wallet_deployments a WHERE a.id=$1 AND a.state='signed'`, [pool.activeOperationId])).rows[0];
    return row?.reserved ? BigInt(row.reserved) : 0n;
  }
  private async lastSettlement(pool: WalletDeploymentPool, client: PoolClient): Promise<WalletDeploymentSettlementReceipt | null> {
    if (!pool.accounting?.lastSettlementId) return null;
    const row = (await client.query<{ receipt: WalletDeploymentSettlementReceipt }>("SELECT receipt FROM rest_wallet_deployment_settlements WHERE id=$1", [pool.accounting.lastSettlementId])).rows[0];
    if (!row) conflict(); return row.receipt;
  }
  private async writeAccounting(pool: WalletDeploymentPool, accounting: WalletDeploymentAccounting, client: PoolClient, release = false): Promise<WalletDeploymentPool> {
    assertWalletDeploymentAccounting(accounting, pool);
    const row = (await client.query(`UPDATE rest_wallet_deployment_pools SET accounting=$2::jsonb,revision=revision+1${release ? ",active_operation_id=NULL" : ""}
      WHERE id=$1 AND revision=$3 RETURNING id`, [pool.configuration.id, JSON.stringify(accounting), pool.revision])).rows[0];
    if (!row) conflict(); return this.poolRecord(pool.configuration.id, client);
  }
  /** The lane leaves the active operation at its canonical inclusion, once the sender nonce has
   * moved past it: nextNonce advances, the operation joins the released queue with its admitted
   * maximum cost reserved, and the next user may claim while this one waits for finality. */
  async release(input: { operationId: string; expectedRevision: number }): Promise<{ operation: WalletDeploymentOperation; pool: WalletDeploymentPool; replayed: boolean }> {
    const v = ownFields(input, ["operationId", "expectedRevision"]);
    const operationId = v.operationId as string, expectedRevision = v.expectedRevision as number;
    id(operationId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) invalid();
    const before = await this.required(operationId);
    return this.transaction(async client => {
      const pool = await this.poolRecord(before.poolId, client);
      const enrollment = await lockWalletEnrollmentInTransaction(client, before.enrollmentId);
      const current = await this.required(operationId, client);
      this.sameContext(before, current, enrollment, pool);
      if (current.releasedAt !== null) return { operation: current, pool, replayed: true };
      if (current.revision !== expectedRevision || current.state !== "signed" || !current.signed || !current.template || current.settlementId !== undefined ||
          !pool.accounting || pool.accounting.fence || pool.state !== "active" || pool.activeOperationId !== current.id ||
          current.template.transaction.nonce !== pool.accounting.nextNonce) conflict();
      const observation = current.observation, next = String(BigInt(current.template.transaction.nonce) + 1n);
      if (!observation || !canonicalObservation(observation) || !observation.head || !observation.transaction.nonce || !current.historicalCanonicalObservation) conflict();
      const now = await walletCeremonyDatabaseNow(client);
      const dispatch = (await client.query<DispatchRow>("SELECT * FROM rest_wallet_deployment_dispatches WHERE operation_id=$1 FOR UPDATE", [operationId])).rows[0];
      // A settled attempt holds nothing more; only one still in flight keeps the lane.
      if (dispatch && dispatch.status === "in-flight" && Number(dispatch.lease_until) > now) busy();
      if (observation.transaction.nonce.confirmed !== next || observation.transaction.nonce.pending !== next) {
        // Our inclusion is canonical but the sender's nonce is not exactly past it: another sender
        // holds the key or the provider contradicts itself. Retain everything and stop for review.
        const fenced = await this.writeAccounting(pool, { ...pool.accounting, fence: { reason: "nonce-conflict", evidenceDigest: enrollmentDigest(observation), recordedAt: now } }, client);
        return { operation: current, pool: fenced, replayed: false };
      }
      if (walletDeploymentReleasedCount(pool.accounting) >= walletDeploymentSettlementLimits.maximumUnsettled) busy();
      const reservation = dispatch?.admission.reservation?.totalWei, maximum = BigInt(current.signed.maximumExecutionCost);
      const reservedWei = reservation && BigInt(reservation) > maximum ? reservation : String(maximum);
      const row = (await client.query<OperationRow>(`UPDATE rest_wallet_deployments SET released_at=$2,reserved_wei=$3
        WHERE id=$1 AND released_at IS NULL AND revision=$4 RETURNING *`, [operationId, now, reservedWei, expectedRevision])).rows[0];
      if (!row) conflict();
      const released = await this.writeAccounting(pool, { ...pool.accounting, nextNonce: next }, client, true);
      return { operation: operationOf(row), pool: released, replayed: false };
    });
  }

  async configurePool(input: WalletDeploymentPoolConfiguration): Promise<WalletDeploymentPool> {
    const config = configuration(input), digest = enrollmentDigest(config);
    return this.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':wallet-deployment-pool',0))");
      const prior = (await client.query<PoolRow>(`${poolSelect} FOR UPDATE`)).rows[0];
      if (prior) {
        if (prior.configuration_digest !== digest) conflict();
        return poolOf(prior);
      }
      const now = await walletCeremonyDatabaseNow(client);
      const row = (await client.query<PoolRow>(`INSERT INTO rest_wallet_deployment_pools
        (id,chain_id,sender,allocation_wei,global_allocation_limit_wei,configuration,configuration_digest,created_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING *`,
      [config.id, config.chainId, config.sender, config.allocationWei, config.globalAllocationLimitWei, JSON.stringify(config), digest, now])).rows[0]!;
      return poolOf({ ...row, reserved_wei: "0" });
    });
  }

  async prepare(input: { poolId: string; approval: WalletDeploymentApproval }): Promise<WalletDeploymentOperation> {
    fields(input, ["poolId", "approval"]); id(input.poolId);
    const request = structuredClone(input);
    const before = await this.enrollments.get(request.approval.enrollmentId);
    if (!before) missing();
    walletDeploymentDocument(before, request.approval);
    return this.transaction(async client => {
      // Issuance's global admission lock always precedes pool/enrollment/operation/ceremony rows.
      await lockWalletCeremonyAdmission(client);
      const pool = await this.poolRecord(request.poolId, client);
      const enrollment = await lockWalletEnrollmentInTransaction(client, request.approval.enrollmentId);
      walletDeploymentDocument(enrollment, request.approval);
      const existing = (await client.query<OperationRow>("SELECT * FROM rest_wallet_deployments WHERE id=$1 FOR UPDATE", [request.approval.id])).rows[0];
      if (existing) {
        const operation = operationOf(existing);
        if (operation.poolId !== request.poolId || operation.poolConfigurationDigest !== pool.configurationDigest ||
            enrollmentDigest(operation.approval) !== enrollmentDigest(request.approval)) conflict();
        if (operation.state === "prepared" && operation.retainUntil <= await walletCeremonyDatabaseNow(client)) expired();
        return operation;
      }
      if (pool.state !== "active") busy();
      await this.cleanupInTransaction(client, 100);
      const ceremony = await this.ceremonies.issueInTransaction(client, request.approval.ceremony, null);
      const inserted = (await client.query<OperationRow>(`INSERT INTO rest_wallet_deployments
        (id,pool_id,enrollment_id,pool_configuration_digest,approval,created_at,expires_at,retain_until)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8) RETURNING *`,
      [request.approval.id, request.poolId, request.approval.enrollmentId, pool.configurationDigest, JSON.stringify(request.approval),
        ceremony.createdAt, request.approval.expiresAt, request.approval.expiresAt + walletCeremonyRetentionMs])).rows[0]!;
      const result = operationOf(inserted);
      live(result, await walletCeremonyDatabaseNow(client));
      return result;
    });
  }

  async get(operationId: string): Promise<WalletDeploymentOperation | null> {
    id(operationId);
    const row = (await this.pool.query<OperationRow>("SELECT * FROM rest_wallet_deployments WHERE id=$1", [operationId])).rows[0];
    return row ? operationOf(row) : null;
  }

  /** Claimed enrollment receipt remains the authority for exact recovery after ceremony expiry or
   * current-credential replacement. It cannot authorize a new nonce, wallet or transaction. */
  async loadExecutionContext(operationId: string): Promise<WalletDeploymentExecutionContext> {
    id(operationId); const before = await this.required(operationId);
    return this.transaction(async client => {
      const pool = await this.poolRecord(before.poolId, client), enrollment = await lockWalletEnrollmentInTransaction(client, before.enrollmentId);
      const operation = await this.required(operationId, client);
      this.sameContext(before, operation, enrollment, pool);
      if (operation.state === "prepared" || !operation.template || !operation.claimedAt || pool.activeOperationId !== operation.id) conflict();
      return { pool, enrollment, operation };
    });
  }
  async getDispatch(operationId: string): Promise<WalletDeploymentDispatchJournal | null> {
    id(operationId);
    const row = (await this.pool.query<DispatchRow>("SELECT * FROM rest_wallet_deployment_dispatches WHERE operation_id=$1", [operationId])).rows[0];
    return row ? dispatchOf(row) : null;
  }
  async leaseDispatch(input: WalletDeploymentDispatchClaim): Promise<WalletDeploymentDispatchJournal> {
    const v = ownFields(input, ["operationId", "expectedRevision", "signedHash", "admission"], ["leaseMs"]);
    id(v.operationId as string);
    const operationId = v.operationId as string, expectedRevision = v.expectedRevision as number, signedHash = v.signedHash as Hex;
    const leaseMs = v.leaseMs === undefined ? walletDeploymentDispatchLimits.leaseMs : v.leaseMs as number;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || typeof signedHash !== "string" || !word.test(signedHash) ||
        !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > walletDeploymentDispatchLimits.leaseMs) invalid();
    enrollmentDigest(v.admission); const requestAdmission = structuredClone(v.admission);
    const before = await this.required(operationId);
    return this.transaction(async client => {
      const pool = await this.poolRecord(before.poolId, client), enrollment = await lockWalletEnrollmentInTransaction(client, before.enrollmentId);
      const operation = await this.required(operationId, client);
      this.sameContext(before, operation, enrollment, pool);
      if (operation.revision !== expectedRevision || operation.signed?.hash !== signedHash) conflict();
      const context = { pool, enrollment, operation }, now = await walletCeremonyDatabaseNow(client);
      const admission = assertWalletDeploymentDispatchAdmission(requestAdmission, context, now), digest = enrollmentDigest(admission);
      const prior = (await client.query<DispatchRow>("SELECT * FROM rest_wallet_deployment_dispatches WHERE operation_id=$1 FOR UPDATE", [operationId])).rows[0];
      if (prior && (Number(prior.next_attempt_at) > now || prior.attempts >= walletDeploymentDispatchLimits.maximumAttempts)) busy();
      const token = randomUUID(), until = Math.min(now + leaseMs, admission.expiresAt);
      const row = prior ? (await client.query<DispatchRow>(`UPDATE rest_wallet_deployment_dispatches SET revision=revision+1,
        attempts=attempts+1,status='in-flight',lease_token=$2,lease_until=$3,admission=$4::jsonb,admission_digest=$5,
        claimed_at=$6,settled_at=NULL,next_attempt_at=$7 WHERE operation_id=$1 RETURNING *`,
      [operationId, token, until, JSON.stringify(admission), digest, now, until + walletDeploymentDispatchLimits.cooldownMs])).rows[0]!
        : (await client.query<DispatchRow>(`INSERT INTO rest_wallet_deployment_dispatches
        (operation_id,transaction_hash,template_commitment,revision,attempts,status,lease_token,lease_until,admission,admission_digest,claimed_at,next_attempt_at)
        VALUES($1,$2,$3,1,1,'in-flight',$4,$5,$6::jsonb,$7,$8,$9) RETURNING *`,
        [operationId, signedHash, operation.templateCommitment, token, until, JSON.stringify(admission), digest, now,
          until + walletDeploymentDispatchLimits.cooldownMs])).rows[0]!;
      // Includes index/trigger/write waits. An expired admission or lease rolls the whole claim back.
      const after = await walletCeremonyDatabaseNow(client);
      assertWalletDeploymentDispatchAdmission(admission, context, after); if (until <= after) conflict();
      return dispatchOf(row);
    });
  }
  async settleDispatch(input: WalletDeploymentDispatchSettlement): Promise<{ journal: WalletDeploymentDispatchJournal; replayed: boolean }> {
    const v = ownFields(input, ["operationId", "expectedRevision", "leaseToken", "signedHash", "status"]);
    const request = { operationId: v.operationId as string, expectedRevision: v.expectedRevision as number,
      leaseToken: v.leaseToken as string, signedHash: v.signedHash as Hex, status: v.status as "accepted" | "unknown" };
    id(request.operationId); id(request.leaseToken);
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1 || typeof request.signedHash !== "string" ||
        !word.test(request.signedHash) || !["accepted", "unknown"].includes(request.status)) invalid();
    const before = await this.required(request.operationId);
    return this.transaction(async client => {
      const pool = await this.poolRecord(before.poolId, client), enrollment = await lockWalletEnrollmentInTransaction(client, before.enrollmentId);
      const operation = await this.required(request.operationId, client);
      this.sameContext(before, operation, enrollment, pool);
      if (operation.signed?.hash !== request.signedHash || pool.activeOperationId !== operation.id) conflict();
      const prior = (await client.query<DispatchRow>("SELECT * FROM rest_wallet_deployment_dispatches WHERE operation_id=$1 FOR UPDATE", [operation.id])).rows[0];
      if (!prior || prior.transaction_hash !== request.signedHash || prior.lease_token !== request.leaseToken) conflict();
      if (prior.status !== "in-flight") {
        if (Number(prior.revision) !== request.expectedRevision + 1 || prior.status !== request.status) conflict();
        return { journal: dispatchOf(prior), replayed: true };
      }
      const now = await walletCeremonyDatabaseNow(client);
      if (Number(prior.revision) !== request.expectedRevision || Number(prior.lease_until) <= now) conflict();
      const row = (await client.query<DispatchRow>(`UPDATE rest_wallet_deployment_dispatches SET revision=revision+1,status=$2,
        settled_at=$3 WHERE operation_id=$1 AND revision=$4 AND lease_token=$5 AND lease_until>${nowSql} RETURNING *`,
      [operation.id, request.status, now, request.expectedRevision, request.leaseToken])).rows[0];
      if (!row || Number(prior.lease_until) <= await walletCeremonyDatabaseNow(client)) conflict();
      return { journal: dispatchOf(row), replayed: false };
    });
  }

  async claim(input: WalletDeploymentClaim): Promise<{ operation: WalletDeploymentOperation; replayed: boolean }> {
    // Binary proofs are copied before the first await; arbitrary JSON/private key material is rejected.
    if (!input || ![3,4,5].includes(Object.keys(input).length) || Object.keys(input).some(key => !["operationId", "assertion", "admission", "funding", "topOrigin"].includes(key))) invalid();
    const funding = input.funding === undefined ? null : (enrollmentDigest(input.funding), structuredClone(input.funding));
    id(input.operationId);
    if (input.topOrigin !== undefined && (typeof input.topOrigin !== "string" || !/^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(input.topOrigin))) invalid();
    const ceremony: WalletCeremonyOptions = input.topOrigin ? { topOrigin: input.topOrigin } : {};
    const operationId = input.operationId, assertion = copyProof(input.assertion), admission = checkedAdmission(input.admission);
    const before = await this.required(operationId), beforePool = await this.poolRecord(before.poolId);
    const enrollment = await this.enrollments.get(before.enrollmentId);
    if (!enrollment) missing();
    const sampledNow = Number((await this.pool.query<{ now: string }>(`SELECT ${nowSql} AS now`)).rows[0]!.now);
    // Historical verification is available only after a durable claim receipt was loaded.
    const proof = verifyWalletDeploymentProof(enrollment, before.approval, assertion, before.claimedAt ?? sampledNow, ceremony);
    const template = before.state === "prepared" ? admissionTemplate(enrollment, before, beforePool, admission) : before.template!;
    return this.transaction(async client => {
      const pool = await this.poolRecord(before.poolId, client);
      const currentEnrollment = await lockWalletEnrollmentInTransaction(client, before.enrollmentId);
      const current = await this.required(operationId, client);
      this.sameContext(before, current, currentEnrollment, pool);
      if (current.state !== "prepared") {
        if (current.proofDigest !== proof.verificationDigest || !current.claimedAt || !current.template || !current.admission ||
            commitment(current.template) !== current.templateCommitment || pool.activeOperationId !== current.id) conflict();
        // Never renew/reconsume the ceremony or adopt a retry's nonce/fee quote. The original receipt
        // remains recoverable after expiry, current-key supersession and ceremony retention cleanup.
        verifyWalletDeploymentProof(currentEnrollment, current.approval, assertion, current.claimedAt, ceremony);
        return { operation: current, replayed: true };
      }
      // A v2 approval may have been prepared before possession was proved; the claim itself
      // still requires the verified enrollment (the orchestrator finalizes possession first).
      if (currentEnrollment.state !== "verified" || !currentEnrollment.receipt) conflict();
      await this.currentCredential(client, currentEnrollment);
      if (pool.state !== "active" || pool.activeOperationId !== null || pool.accounting?.fence) busy();
      if (pool.accounting) {
        // The released queue is bounded, and every member must still be known to be canonical.
        const queue = (await client.query<{ queued: string; stalled: boolean | null }>(`SELECT count(*)::text AS queued,
          bool_or(observation->'transaction'->>'state' NOT IN ('canonical-success','canonical-revert')) AS stalled
          FROM rest_wallet_deployments WHERE pool_id=$1 AND released_at IS NOT NULL AND settlement_id IS NULL`, [pool.configuration.id])).rows[0]!;
        if (Number(queue.queued) >= walletDeploymentSettlementLimits.maximumUnsettled || queue.stalled) busy();
      }
      const fundingContext = { pool, lastSettlement: await this.lastSettlement(pool, client) };
      const checkFunding = async () => {
        if (pool.accounting) {
          if (!funding) conflict();
          assertWalletDeploymentFundingEvidence(funding, fundingContext, await walletCeremonyDatabaseNow(client));
          if (walletDeploymentFundingConflict(fundingContext, funding) || admission.confirmedNonce !== pool.accounting.nextNonce ||
              admission.blockNumber !== funding.head.blockNumber || admission.blockHash !== funding.head.blockHash ||
              BigInt(template.transaction.gas) * BigInt(template.transaction.maxFeePerGas) > BigInt(walletDeploymentRemainingWei(pool))) conflict();
        } else if (funding) conflict();
      };
      await checkFunding();
      if (enrollmentDigest(template) !== enrollmentDigest(admissionTemplate(currentEnrollment, current, pool, admission))) conflict();
      live(current, await walletCeremonyDatabaseNow(client), admission, pool);
      const consumed = await this.ceremonies.consumeInTransaction(client, { ...current.approval.ceremony,
        proofDigest: proof.verificationDigest, resultId: current.id });
      if (consumed.replayed) conflict();
      const claimedAt = await walletCeremonyDatabaseNow(client);
      live(current, claimedAt, admission, pool);
      const row = (await client.query<OperationRow>(`UPDATE rest_wallet_deployments SET state='claimed',claimed_at=$2,proof_digest=$3,
        admission=$4::jsonb,chain_id=$5,sender=$6,nonce=$7,template=$8::jsonb,template_commitment=$9,claim_funding=$10::jsonb,revision=revision+1 WHERE id=$1 RETURNING *`,
      [current.id, claimedAt, proof.verificationDigest, JSON.stringify(admission), admission.chainId, admission.sender,
        admission.confirmedNonce, JSON.stringify(template), commitment(template), funding ? JSON.stringify(funding) : null])).rows[0]!;
      await client.query("UPDATE rest_wallet_deployment_pools SET active_operation_id=$2,revision=revision+1 WHERE id=$1", [current.poolId, current.id]);
      // Includes unique-index waits and all writes. Expiry rolls back ceremony, lane and nonce together.
      live(current, await walletCeremonyDatabaseNow(client), admission, pool);
      await checkFunding();
      return { operation: operationOf(row), replayed: false };
    });
  }

  async leaseSigning(operationId: string, durationMs = 15_000): Promise<{
    operation: WalletDeploymentOperation; leaseToken: string | null; leaseUntil: number | null; revision: number;
  }> {
    id(operationId);
    if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 120_000) invalid();
    const before = await this.required(operationId);
    return this.transaction(async client => {
      const pool = await this.poolRecord(before.poolId, client);
      const enrollment = await lockWalletEnrollmentInTransaction(client, before.enrollmentId);
      const current = await this.required(operationId, client);
      this.sameContext(before, current, enrollment, pool);
      if (current.state === "prepared" || pool.activeOperationId !== current.id) conflict();
      if (current.state === "signed") return { operation: current, leaseToken: null, leaseUntil: null, revision: current.revision };
      if (pool.state !== "active" || pool.accounting?.fence) busy();
      const now = await walletCeremonyDatabaseNow(client);
      if (current.signingLease && current.signingLease.until > now) busy(true);
      const token = randomUUID(), until = now + durationMs;
      const row = (await client.query<OperationRow>(`UPDATE rest_wallet_deployments SET signing_lease_token=$2,
        signing_lease_until=$3,revision=revision+1 WHERE id=$1 RETURNING *`, [operationId, token, until])).rows[0]!;
      return { operation: operationOf(row), leaseToken: token, leaseUntil: until, revision: Number(row.revision) };
    });
  }

  async persistSigned(input: WalletDeploymentSignedCommit): Promise<{ operation: WalletDeploymentOperation; replayed: boolean }> {
    // Exact plain scalar snapshot. Raw bytes have their own cap and must not accidentally inherit
    // enrollmentDigest's smaller per-string JSON cap. Reject accessors before reading any values.
    const keys = ["operationId", "leaseToken", "revision", "rawTransaction"];
    if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
        Reflect.ownKeys(input).length !== keys.length || keys.some(key => {
          const descriptor = Object.getOwnPropertyDescriptor(input, key);
          return !descriptor || !("value" in descriptor) || !descriptor.enumerable;
        })) invalid();
    if (typeof input.rawTransaction !== "string" || input.rawTransaction.length > 262_146) invalid();
    const request = { operationId: input.operationId, leaseToken: input.leaseToken, revision: input.revision, rawTransaction: input.rawTransaction };
    id(request.operationId); id(request.leaseToken);
    if (!Number.isSafeInteger(request.revision) || request.revision < 1) invalid();
    const before = await this.required(request.operationId), beforePool = await this.poolRecord(before.poolId);
    if (!before.template || before.state === "prepared") conflict();
    const enrollment = await this.enrollments.get(before.enrollmentId);
    if (!enrollment) missing();
    const validated = await validateSignedWalletDeployment({ enrollment, approval: before.approval, template: before.template,
      rawTransaction: request.rawTransaction, policy: relayPolicy(beforePool.configuration) });
    return this.transaction(async client => {
      const pool = await this.poolRecord(before.poolId, client);
      const currentEnrollment = await lockWalletEnrollmentInTransaction(client, before.enrollmentId);
      const current = await this.required(request.operationId, client);
      this.sameContext(before, current, currentEnrollment, pool);
      if (pool.accounting?.fence || pool.activeOperationId !== current.id || !current.template || current.templateCommitment !== validated.templateCommitment) conflict();
      if (current.signed) {
        if (current.signed.hash !== validated.hash || current.signed.rawTransaction !== request.rawTransaction) conflict();
        return { operation: current, replayed: true };
      }
      if (pool.state !== "active" || pool.accounting?.fence) busy();
      const now = await walletCeremonyDatabaseNow(client);
      if (current.state !== "claimed" || current.revision !== request.revision || current.signingLease?.token !== request.leaseToken ||
          current.signingLease.until <= now) conflict();
      const row = (await client.query<OperationRow>(`UPDATE rest_wallet_deployments SET state='signed',raw_transaction=$2,
        transaction_hash=$3,maximum_execution_cost=$4,signing_lease_token=NULL,signing_lease_until=NULL,revision=revision+1
        WHERE id=$1 AND revision=$5 AND signing_lease_token=$6 AND signing_lease_until>${nowSql} RETURNING *`,
      [current.id, validated.rawTransaction, validated.hash, validated.maximumExecutionCost, request.revision, request.leaseToken])).rows[0];
      if (!row || current.signingLease.until <= await walletCeremonyDatabaseNow(client)) conflict();
      return { operation: operationOf(row), replayed: false };
    });
  }

  async cleanup(limit = 1_000): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) invalid();
    return this.transaction(client => this.cleanupInTransaction(client, limit));
  }
  /** Trusted observer output only; observations are neither broadcast nor settlement authority.
   * RPC is completed by the caller before these bounded database locks are acquired. */
  async saveObservation(input: WalletDeploymentObservationCommit): Promise<{ operation: WalletDeploymentOperation; replayed: boolean }> {
    const v = ownFields(input, ["operationId", "expectedRevision", "signedHash", "observation"]);
    const operationId = v.operationId as string, expectedRevision = v.expectedRevision as number, signedHash = v.signedHash as Hex;
    id(operationId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || typeof signedHash !== "string" || !word.test(signedHash)) invalid();
    const observation = assertWalletDeploymentObservation(v.observation), digest = enrollmentDigest(observation);
    if (observation.operationId !== operationId || observation.transactionHash !== signedHash) conflict();
    const before = await this.required(operationId);
    if (before.state !== "signed" || before.signed?.hash !== signedHash) conflict();
    return this.transaction(async client => {
      const pool = await this.poolRecord(before.poolId, client);
      const enrollment = await lockWalletEnrollmentInTransaction(client, before.enrollmentId);
      const current = await this.required(operationId, client);
      this.sameContext(before, current, enrollment, pool);
      if (current.state !== "signed" || current.signed?.hash !== signedHash || current.settlementId !== undefined ||
          (pool.activeOperationId !== current.id && current.releasedAt === null) ||
          !current.template || commitment(current.template) !== current.templateCommitment ||
          observation.templateCommitment !== current.templateCommitment || observation.wallet.address !== current.template.predictedSafe.toLowerCase() ||
          observation.wallet.initializerHash !== current.template.initializerHash) conflict();
      // Lost-response retries read the exact durable winner without renewing time or revision.
      if (current.observation && enrollmentDigest(current.observation) === digest) return { operation: current, replayed: true };
      if (current.revision !== expectedRevision) conflict();
      const savedAt = await walletCeremonyDatabaseNow(client);
      if (observation.observedAt > savedAt) conflict();
      const { historical, highestHead } = advanceObservation(current, observation);
      const row = (await client.query<OperationRow>(`UPDATE rest_wallet_deployments SET observation=$4::jsonb,
        observation_digest=$5,observation_saved_at=$6,historical_canonical_observation=$7::jsonb,
        highest_observed_head=$8,revision=revision+1 WHERE id=$1 AND revision=$2 AND transaction_hash=$3 RETURNING *`,
      [operationId, expectedRevision, signedHash, JSON.stringify(observation), digest, savedAt,
        historical === null ? null : JSON.stringify(historical), highestHead])).rows[0];
      if (!row) conflict();
      return { operation: operationOf(row), replayed: false };
    });
  }
  /** Stable keyset sweep. Restart without a cursor after nextCursor=null; durable unresolved
   * work is never hidden by recent observations, expired approvals or a stale signing lease. */
  async listUnresolved(input: { cursor?: WalletDeploymentRecoveryCursor; limit?: number } = {}): Promise<WalletDeploymentRecoveryPage> {
    const v = ownFields(input, [], ["cursor", "limit"]);
    const limit = v.limit === undefined ? 10 : v.limit as number;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) invalid();
    let cursor: WalletDeploymentRecoveryCursor | null = null;
    if (v.cursor !== undefined) {
      const c = ownFields(v.cursor, ["createdAt", "operationId"]);
      id(c.operationId as string);
      if (!positiveTime(c.createdAt as number)) invalid();
      cursor = { createdAt: c.createdAt as number, operationId: c.operationId as string };
    }
    const rows = (await this.pool.query<Pick<OperationRow, "id" | "created_at" | "revision" | "state" | "transaction_hash" | "released_at"> & { nonce: string | null }>(
      `SELECT id,created_at,revision,state,transaction_hash,nonce::text AS nonce,released_at FROM rest_wallet_deployments
       WHERE state IN ('claimed','signed') AND settlement_id IS NULL${cursor ? " AND (created_at,id)>($2::bigint,$3::uuid)" : ""}
       ORDER BY created_at,id LIMIT $1`, cursor ? [limit + 1, cursor.createdAt, cursor.operationId] : [limit + 1])).rows;
    const items = rows.slice(0, limit).map(row => ({ id: row.id, createdAt: Number(row.created_at), revision: Number(row.revision),
      state: row.state as "claimed" | "signed", signedHash: row.transaction_hash, nonce: row.nonce,
      releasedAt: row.released_at == null ? null : Number(row.released_at) }));
    const last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? { createdAt: last.createdAt, operationId: last.id } : null };
  }
  private async cleanupInTransaction(client: PoolClient, limit: number): Promise<number> {
    const result = await client.query(`DELETE FROM rest_wallet_deployments WHERE id IN
      (SELECT id FROM rest_wallet_deployments WHERE state='prepared' AND retain_until<=${nowSql}
       ORDER BY retain_until,id LIMIT $1 FOR UPDATE SKIP LOCKED)`, [limit]);
    return result.rowCount ?? 0;
  }
  private async poolRecord(poolId: string, client?: PoolClient): Promise<WalletDeploymentPool> {
    id(poolId);
    const row = (await (client ?? this.pool).query<PoolRow>(`${poolSelect} WHERE p.id=$1${client ? " FOR UPDATE" : ""}`, [poolId])).rows[0];
    return row ? poolOf(row) : missing();
  }
  private async required(operationId: string, client?: PoolClient): Promise<WalletDeploymentOperation> {
    const row = (await (client ?? this.pool).query<OperationRow>(`SELECT * FROM rest_wallet_deployments WHERE id=$1${client ? " FOR UPDATE" : ""}`, [operationId])).rows[0];
    return row ? operationOf(row) : missing();
  }
  private sameContext(before: WalletDeploymentOperation, current: WalletDeploymentOperation,
    enrollment: WalletEnrollment, pool: WalletDeploymentPool): void {
    walletDeploymentDocument(enrollment, current.approval);
    if (current.poolId !== before.poolId || current.enrollmentId !== before.enrollmentId ||
        current.poolConfigurationDigest !== pool.configurationDigest || enrollmentDigest(current.approval) !== enrollmentDigest(before.approval) ||
        (before.template !== null && enrollmentDigest(before.template) !== enrollmentDigest(current.template))) conflict();
  }
  private async currentCredential(client: PoolClient, enrollment: WalletEnrollment): Promise<void> {
    if (!await currentWalletCredentialInTransaction(client, enrollment)) conflict();
  }
  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='10000ms'");
      await client.query("SET LOCAL statement_timeout='15000ms'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout='20000ms'");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if (error && typeof error === "object" && "code" in error && error.code === "23505") conflict();
      throw error;
    } finally { client.release(); }
  }
}
