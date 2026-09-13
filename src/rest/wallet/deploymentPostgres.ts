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
import type { WalletAssertion } from "./webauthn.js";
import { assertWalletDeploymentObservation, type WalletDeploymentObservation } from "./deploymentObservation.js";

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
export interface WalletDeploymentPool {
  configuration: WalletDeploymentPoolConfiguration;
  configurationDigest: string;
  createdAt: number;
  state: "active" | "paused";
  activeOperationId: string | null;
  revision: number;
}
/** Internal future chain-adapter output only. Shape validation cannot prove canonical chain facts. */
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
  items: { id: string; createdAt: number; revision: number; state: "claimed" | "signed"; signedHash: Hex | null }[];
  nextCursor: WalletDeploymentRecoveryCursor | null;
}
export interface WalletDeploymentClaim {
  operationId: string;
  assertion: WalletAssertion;
  admission: WalletDeploymentAdmission;
}
export interface WalletDeploymentSignedCommit {
  operationId: string;
  leaseToken: string;
  revision: number;
  rawTransaction: Hex;
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
  state: WalletDeploymentPool["state"]; active_operation_id: string | null; revision: string };
function poolOf(row: PoolRow): WalletDeploymentPool {
  const checked = configuration(row.configuration);
  if (enrollmentDigest(checked) !== row.configuration_digest) conflict();
  return { configuration: checked, configurationDigest: row.configuration_digest, createdAt: Number(row.created_at),
    state: row.state, activeOperationId: row.active_operation_id, revision: Number(row.revision) };
}
type OperationRow = { id: string; pool_id: string; enrollment_id: string; pool_configuration_digest: string; approval: WalletDeploymentApproval;
  state: WalletDeploymentOperation["state"]; created_at: string; retain_until: string; claimed_at: string | null; proof_digest: string | null;
  admission: WalletDeploymentAdmission | null; template: WalletDeploymentTemplate | null; template_commitment: Hex | null;
  signing_lease_token: string | null; signing_lease_until: string | null; raw_transaction: Hex | null; transaction_hash: Hex | null;
  maximum_execution_cost: string | null; revision: string; observation: WalletDeploymentObservation | null;
  observation_saved_at: string | null; historical_canonical_observation: WalletDeploymentObservation | null; highest_observed_head: string | null };
function operationOf(row: OperationRow): WalletDeploymentOperation {
  return { id: row.id, poolId: row.pool_id, enrollmentId: row.enrollment_id, poolConfigurationDigest: row.pool_configuration_digest,
    approval: row.approval, state: row.state, createdAt: Number(row.created_at), retainUntil: Number(row.retain_until),
    claimedAt: row.claimed_at === null ? null : Number(row.claimed_at), proofDigest: row.proof_digest, admission: row.admission,
    template: row.template, templateCommitment: row.template_commitment,
    signingLease: row.signing_lease_token === null ? null : { token: row.signing_lease_token, until: Number(row.signing_lease_until) },
    signed: row.raw_transaction === null ? null : { rawTransaction: row.raw_transaction, hash: row.transaction_hash!, maximumExecutionCost: row.maximum_execution_cost! },
    observation: row.observation ?? null, observationSavedAt: row.observation_saved_at == null ? null : Number(row.observation_saved_at),
    historicalCanonicalObservation: row.historical_canonical_observation ?? null, highestObservedHead: row.highest_observed_head ?? null,
    revision: Number(row.revision) };
}

/** Internal durable store only. Admission observations must come from the future trusted chain
 * adapter; this class cannot establish onchain truth, sign, publish or release a sender lane.
 * All public records here are internal: signed bytes must not be returned by a future status route. */
export class PostgresWalletDeploymentStore {
  private readonly ceremonies: PostgresWalletCeremonyStore;
  private readonly enrollments: PostgresWalletEnrollmentStore;
  constructor(private readonly pool: Pool) {
    this.ceremonies = new PostgresWalletCeremonyStore(pool);
    this.enrollments = new PostgresWalletEnrollmentStore(pool);
  }

  async configurePool(input: WalletDeploymentPoolConfiguration): Promise<WalletDeploymentPool> {
    const config = configuration(input), digest = enrollmentDigest(config);
    return this.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':wallet-deployment-pool',0))");
      const prior = (await client.query<PoolRow>("SELECT * FROM rest_wallet_deployment_pools FOR UPDATE")).rows[0];
      if (prior) {
        if (prior.configuration_digest !== digest) conflict();
        return poolOf(prior);
      }
      const now = await walletCeremonyDatabaseNow(client);
      const row = (await client.query<PoolRow>(`INSERT INTO rest_wallet_deployment_pools
        (id,chain_id,sender,allocation_wei,global_allocation_limit_wei,configuration,configuration_digest,created_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING *`,
      [config.id, config.chainId, config.sender, config.allocationWei, config.globalAllocationLimitWei, JSON.stringify(config), digest, now])).rows[0]!;
      return poolOf(row);
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

  async claim(input: WalletDeploymentClaim): Promise<{ operation: WalletDeploymentOperation; replayed: boolean }> {
    // Binary proofs are copied before the first await; arbitrary JSON/private key material is rejected.
    if (!input || Object.keys(input).length !== 3 || Object.keys(input).some(key => !["operationId", "assertion", "admission"].includes(key))) invalid();
    id(input.operationId);
    const operationId = input.operationId, assertion = copyProof(input.assertion), admission = checkedAdmission(input.admission);
    const before = await this.required(operationId), beforePool = await this.poolRecord(before.poolId);
    const enrollment = await this.enrollments.get(before.enrollmentId);
    if (!enrollment) missing();
    const sampledNow = Number((await this.pool.query<{ now: string }>(`SELECT ${nowSql} AS now`)).rows[0]!.now);
    // Historical verification is available only after a durable claim receipt was loaded.
    const proof = verifyWalletDeploymentProof(enrollment, before.approval, assertion, before.claimedAt ?? sampledNow);
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
        verifyWalletDeploymentProof(currentEnrollment, current.approval, assertion, current.claimedAt);
        return { operation: current, replayed: true };
      }
      await this.currentCredential(client, currentEnrollment);
      if (pool.state !== "active" || pool.activeOperationId !== null) busy();
      if (enrollmentDigest(template) !== enrollmentDigest(admissionTemplate(currentEnrollment, current, pool, admission))) conflict();
      live(current, await walletCeremonyDatabaseNow(client), admission, pool);
      const consumed = await this.ceremonies.consumeInTransaction(client, { ...current.approval.ceremony,
        proofDigest: proof.verificationDigest, resultId: current.id });
      if (consumed.replayed) conflict();
      const claimedAt = await walletCeremonyDatabaseNow(client);
      live(current, claimedAt, admission, pool);
      const row = (await client.query<OperationRow>(`UPDATE rest_wallet_deployments SET state='claimed',claimed_at=$2,proof_digest=$3,
        admission=$4::jsonb,chain_id=$5,sender=$6,nonce=$7,template=$8::jsonb,template_commitment=$9,revision=revision+1 WHERE id=$1 RETURNING *`,
      [current.id, claimedAt, proof.verificationDigest, JSON.stringify(admission), admission.chainId, admission.sender,
        admission.confirmedNonce, JSON.stringify(template), commitment(template)])).rows[0]!;
      await client.query("UPDATE rest_wallet_deployment_pools SET active_operation_id=$2,revision=revision+1 WHERE id=$1", [current.poolId, current.id]);
      // Includes unique-index waits and all writes. Expiry rolls back ceremony, lane and nonce together.
      live(current, await walletCeremonyDatabaseNow(client), admission, pool);
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
      if (pool.state !== "active") busy();
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
      if (pool.activeOperationId !== current.id || !current.template || current.templateCommitment !== validated.templateCommitment) conflict();
      if (current.signed) {
        if (current.signed.hash !== validated.hash || current.signed.rawTransaction !== request.rawTransaction) conflict();
        return { operation: current, replayed: true };
      }
      if (pool.state !== "active") busy();
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
      if (current.state !== "signed" || current.signed?.hash !== signedHash || pool.activeOperationId !== current.id ||
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
    const rows = (await this.pool.query<Pick<OperationRow, "id" | "created_at" | "revision" | "state" | "transaction_hash">>(
      `SELECT id,created_at,revision,state,transaction_hash FROM rest_wallet_deployments
       WHERE state IN ('claimed','signed')${cursor ? " AND (created_at,id)>($2::bigint,$3::uuid)" : ""}
       ORDER BY created_at,id LIMIT $1`, cursor ? [limit + 1, cursor.createdAt, cursor.operationId] : [limit + 1])).rows;
    const items = rows.slice(0, limit).map(row => ({ id: row.id, createdAt: Number(row.created_at), revision: Number(row.revision),
      state: row.state as "claimed" | "signed", signedHash: row.transaction_hash }));
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
    const row = (await (client ?? this.pool).query<PoolRow>(`SELECT * FROM rest_wallet_deployment_pools WHERE id=$1${client ? " FOR UPDATE" : ""}`, [poolId])).rows[0];
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
