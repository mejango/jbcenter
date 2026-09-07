import { randomUUID } from "node:crypto";
import type { Address, Hex } from "viem";
import { parseAccountId } from "../auth/signatures.js";
import type { BotGrant } from "../auth/store.js";
import { RestError, type RestActor } from "../core.js";
import type { CompiledSession, InstalledSessionObservation } from "../smartAccounts/compiler/types.js";
import { fingerprint, stable } from "../smartAccounts/service.js";
import type { StoredPlan } from "../transactions/types.js";
import type { StoredSession, SessionIdempotency, SessionClaim, SessionClaimResult, SessionMutationResult,
  SessionObservationUpdate, SessionInvalidationUpdate, SessionListOptions, SessionQuota, UserOperationSessionBinding,
  SessionAllocationGroup, SessionCanonicalObservation } from "./types.js";
import type { SessionOwnerApproval } from "./types.js";

export interface SessionStore {
  /** Internal verifier lookup only, never a route that accepts policy documents. */
  findCompiled(chainId: number, account: Address, permissionId: Hex): Promise<CompiledSession | undefined>;
  create(record: StoredSession, idempotency: SessionIdempotency, now: number): Promise<StoredSession>;
  find(actor: RestActor, idempotency: SessionIdempotency): Promise<StoredSession | undefined>;
  get(actor: RestActor, id: string): Promise<StoredSession | undefined>;
  list(actor: RestActor, options: SessionListOptions): Promise<{ items: StoredSession[]; nextCursor?: string }>;
  claimActivation(claim: SessionClaim): Promise<SessionClaimResult>;
  claimRevocation(claim: SessionClaim): Promise<SessionClaimResult>;
  observe(update: SessionObservationUpdate): Promise<SessionMutationResult>;
  markStale(update: SessionInvalidationUpdate): Promise<SessionMutationResult>;
  quota(actor: RestActor, id: string): Promise<SessionQuota>;
}
export interface SynchronousSessionGuard {
  /** Caller holds the same account authority lock; this method performs no asynchronous work. */
  assertUserOperationSession(actor: RestActor, binding: UserOperationSessionBinding, accountBindingId: string,
    chainId: number, sender: Address, nowSeconds: number): void;
}

export const SESSION_LIMITS = Object.freeze({ maximumBytes: 524288, sessionsPerAccount: 1000,
  idempotencyPerAccount: 4000, maximumObservationAgeSeconds: 60 });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const address = (value: unknown): value is Address => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) && BigInt(value) !== 0n;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const nonzeroHash = (value: unknown): value is Hex => hash(value) && BigInt(value) !== 0n;
const integer = (value: unknown, positive = false): value is string => typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value)
  && BigInt(value) < 2n ** 256n && (!positive || BigInt(value) > 0n);
const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const recordObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export function sessionError(code: string, message: string, status = 409): never { throw new RestError(status, code, message); }
const invalid = (message: string): never => sessionError("SESSION_INPUT_INVALID", message, 400);
export const missingSession = (): never => sessionError("SESSION_NOT_FOUND", "The session is absent or belongs to another principal.", 404);
export function cloneSession<T>(value: T): T {
  let serialized: string;
  try { serialized = stable(value); } catch { return invalid("Session records require bounded canonical JSON values."); }
  if (Buffer.byteLength(serialized) > SESSION_LIMITS.maximumBytes) sessionError("SESSION_STORAGE_LIMIT", "The session exceeds its bounded storage limit.", 429);
  return structuredClone(value);
}
export function assertSessionId(id: string): void { if (!uuid.test(id)) invalid("Use a canonical session UUID."); }
export function assertSessionList(options: SessionListOptions): void {
  if (!options || !Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) invalid("Session page limit must be 1–100.");
  if (options.cursor !== undefined) assertSessionId(options.cursor);
}
export function assertSessionIdempotency(claim: SessionIdempotency): void {
  if (!claim || !/^[A-Za-z0-9._:-]{1,128}$/.test(claim.key) || typeof claim.requestHash !== "string"
    || !/^[A-Za-z0-9:_-]{1,192}$/.test(claim.requestHash)) invalid("Use a bounded exact idempotency key and request hash.");
}
export function assertIdempotencyMatch(existing: { operation: string; sessionId: string; requestHash: string } | undefined,
  claim: SessionIdempotency, operation: string, sessionId?: string): void {
  assertSessionIdempotency(claim);
  if (existing && (existing.operation !== operation || existing.requestHash !== claim.requestHash || sessionId !== undefined && existing.sessionId !== sessionId))
    sessionError("SESSION_IDEMPOTENCY_CONFLICT", "The idempotency key already binds another exact session request.");
}
export function canReadSession(record: StoredSession, actor: RestActor): boolean {
  return actor.accountId === record.compiled.ownerAccountId && (actor.principalId === `owner:${actor.accountId}` || actor.principalId === `bot:${record.compiled.grantId}`);
}
export function assertSessionActor(record: StoredSession, actor: RestActor, ownerOnly = false): void {
  if (!canReadSession(record, actor) || ownerOnly && actor.principalId !== `owner:${actor.accountId}`)
    sessionError("SESSION_PRINCIPAL_MISMATCH", "Only the owner or this session's exact authorized grant can access it.", 403);
}
function allocationGroups(compiled: CompiledSession): SessionAllocationGroup[] {
  const policy = compiled.reviewedPolicy;
  if (!recordObject(policy) || !Array.isArray(policy.allocations) || policy.allocations.length > 16) return invalid("Compiled policy allocation groups are missing or oversized.");
  const groupIds = new Set<string>(), allocationIds = new Set<string>(), coordinates = new Set<string>();
  return policy.allocations.map((item): SessionAllocationGroup => {
    if (!recordObject(item) || !identifier(item.id) || groupIds.has(item.id) || typeof item.assetIdentity !== "string" || item.assetIdentity.length < 1 || item.assetIdentity.length > 256
      || !Number.isInteger(item.decimals) || Number(item.decimals) < 0 || Number(item.decimals) > 255 || !integer(item.total, true)
      || !Array.isArray(item.allocations) || item.allocations.length < 1 || item.allocations.length > 8) return invalid("Use exact reviewed asset identities, units and bounded allocation groups.");
    groupIds.add(item.id);
    let sum = 0n;
    const allocations = item.allocations.map((entry) => {
      if (!recordObject(entry) || !identifier(entry.id) || allocationIds.has(entry.id) || !Number.isSafeInteger(entry.chainId) || Number(entry.chainId) < 1
        || !address(entry.asset) || !integer(entry.limit, true) || typeof entry.assetReviewId !== "string" || entry.assetReviewId.length < 1 || entry.assetReviewId.length > 256)
        return invalid("Use distinct reviewed chain/asset allocations and positive exact limits.");
      const coordinate = `${entry.chainId}:${entry.asset.toLowerCase()}`;
      if (coordinates.has(coordinate)) return invalid("A chain/asset allocation cannot occur in two approved groups.");
      coordinates.add(coordinate); allocationIds.add(entry.id); sum += BigInt(entry.limit);
      return { id: entry.id, chainId: Number(entry.chainId), asset: entry.asset, limit: entry.limit, assetReviewId: entry.assetReviewId };
    });
    if (sum > BigInt(item.total)) return invalid("Per-chain allocations exceed their explicit approved group total.");
    return { id: item.id, assetIdentity: item.assetIdentity, decimals: Number(item.decimals), total: item.total, allocations };
  });
}
export function createSessionRecord(input: { id?: string; actor: RestActor; compiled: CompiledSession; preparedAdministration: StoredSession["preparedAdministration"]; now: number }): StoredSession {
  const groups = allocationGroups(input.compiled);
  const record: StoredSession = { id: input.id ?? randomUUID(), actor: cloneSession(input.actor), compiled: cloneSession(input.compiled), preparedAdministration: cloneSession(input.preparedAdministration),
    allocationGroups: groups, allocationManifestHash: fingerprint(groups), createdAt: input.now, updatedAt: input.now,
    revision: 0, state: "prepared", reservationsReleased: false };
  assertNewSession(record, input.now);
  return record;
}
export function assertNewSession(record: StoredSession, now: number): void {
  if (!recordObject(record) || !recordObject(record.compiled)) return invalid("Session and compiled policy are required.");
  assertSessionId(record.id);
  const c = record.compiled;
  if (!record.preparedAdministration || !integer(record.preparedAdministration.epoch) || !hash(record.preparedAdministration.hash)
    || Object.keys(record.preparedAdministration).some(key => !["epoch", "hash"].includes(key))) return invalid("A session requires its exact verified administration baseline.");
  try { parseAccountId(c.ownerAccountId); } catch { return invalid("Invalid session owner account identity."); }
  if (!record.actor || record.actor.accountId !== c.ownerAccountId || !canReadSession(record, record.actor)) return invalid("Session creator must be the owner or exact bound grant.");
  if (c.schemaVersion !== 1 || c.stack !== "legacy-f24dddf-safe7579-f22a194" || !hash(c.bindingId) || !uuid.test(c.grantId)
    || !address(c.sessionKey) || !address(c.wallet) || !Number.isSafeInteger(c.chainId) || c.chainId < 1 || !integer(c.generation, true)
    || !nonzeroHash(c.salt) || !nonzeroHash(c.nonce) || !hash(c.permissionId) || !hash(c.manifestRevision) || !hash(c.policyHash) || !hash(c.compiledHash)
    || !integer(c.activationEnableNonce) || !time(c.validAfter) || !time(c.validUntil) || ![7 * 86400, 30 * 86400].includes(c.validUntil - c.validAfter))
    return invalid("Compiled session identity requires an exact seven- or thirty-day immutable policy.");
  assertCompiledSessionIntegrity(c);
  const policy = c.reviewedPolicy;
  if (!recordObject(policy)) return invalid("The reviewed policy is missing.");
  for (const key of ["ownerAccountId", "bindingId", "grantId", "sessionKey", "chainId", "wallet", "generation", "nonce", "validAfter", "validUntil", "salt"] as const) {
    const actual = policy[key], expected = c[key];
    if (typeof actual === "string" && typeof expected === "string" ? !same(actual, expected) : actual !== expected) return invalid(`Compiled ${key} differs from its reviewed policy.`);
  }
  if (!time(now) || !time(record.createdAt) || record.createdAt > now || record.updatedAt !== record.createdAt
    || c.validUntil <= Math.floor(now / 1000) || c.validAfter > Math.floor(now / 1000) + 86400
    || record.state !== "prepared" || record.revision !== 0 || record.reservationsReleased !== false
    || record.activation || record.revocation || record.observation || record.invalidation || record.supersededApprovals) return invalid("Invalid initial session lifecycle or expired policy window.");
  const groups = allocationGroups(c);
  if (stable(record.allocationGroups) !== stable(groups) || !same(record.allocationManifestHash, fingerprint(groups))) return invalid("Allocation grouping differs from the owner-reviewed policy.");
  cloneSession(record);
}
export function assertCompiledSessionIntegrity(compiled: CompiledSession): void {
  const { compiledHash: _hash, ...unhashed } = compiled;
  if (!hash(compiled.compiledHash) || !hash(compiled.policyHash) || !same(fingerprint(unhashed), compiled.compiledHash)
    || !same(fingerprint(compiled.reviewedPolicy), compiled.policyHash))
    return invalid("Compiled or reviewed policy hash does not match its full immutable document.");
}
export function assertSessionGrant(record: StoredSession, grant: BotGrant | null, nowSeconds: number): void {
  const c = record.compiled;
  if (!grant || grant.id !== c.grantId || grant.accountId !== c.ownerAccountId || !same(grant.botAddress, c.sessionKey)
    || grant.revokedAt !== null || grant.expiresAt <= nowSeconds || grant.expiresAt < c.validUntil
    || !["read", "plan", "relay"].every((scope) => grant.scopes.includes(scope as "read" | "plan" | "relay")))
    sessionError("SESSION_GRANT_INACTIVE", "The immutable session key requires its exact active grant through the complete policy expiry.", 403);
}
function sameWallet(a: StoredSession, b: StoredSession): boolean { return a.compiled.chainId === b.compiled.chainId && same(a.compiled.wallet, b.compiled.wallet); }
export function identityConflicts(a: StoredSession, b: StoredSession): boolean {
  if (a.id === b.id || !sameWallet(a, b)) return false;
  return same(a.compiled.permissionId, b.compiled.permissionId) || same(a.compiled.salt, b.compiled.salt) || same(a.compiled.nonce, b.compiled.nonce)
    || same(a.compiled.sessionKey, b.compiled.sessionKey) && a.compiled.generation === b.compiled.generation;
}
export function localSessionAllocations(record: StoredSession) {
  return record.allocationGroups.flatMap((group) => group.allocations).filter((entry) => entry.chainId === record.compiled.chainId);
}
export function reservationConflicts(candidate: StoredSession, existing: StoredSession): boolean {
  // Legacy signatures do not commit the permissionId. Empty-only activation therefore
  // reserves the entire physical wallet until finalized removal AND nonce advancement.
  return candidate.id !== existing.id && sameWallet(candidate, existing) && !existing.reservationsReleased
    && Boolean(existing.activation || existing.observation?.installed.enabled);
}
function revision(value: number): void { if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) invalid("Invalid session revision."); }
export function applySessionClaim(record: StoredSession, claim: SessionClaim, kind: "activation" | "revocation", now: number, allowSupersession = false): SessionClaimResult {
  assertSessionActor(record, claim.actor); assertSessionIdempotency(claim.idempotency); revision(claim.expectedRevision);
  const approval = claim.approval;
  if (!approval || approval.kind !== kind || approval.accountId !== record.compiled.ownerAccountId || approval.sessionId !== record.id
    || !hash(approval.policyHash) || !same(approval.policyHash, record.compiled.policyHash) || !hash(approval.compiledHash) || !same(approval.compiledHash, record.compiled.compiledHash)
    || !uuid.test(approval.planId) || !hash(approval.planCommitment) || !hash(approval.digest)) return invalid("Owner approval must bind this exact session, policy and setup/revocation plan.");
  const prior = kind === "activation" ? record.activation : record.revocation;
  if (prior) {
    if (prior.planId === approval.planId && same(prior.planCommitment, approval.planCommitment)) return { record: cloneSession(record), claimed: false };
    if (!allowSupersession) sessionError("SESSION_PLAN_CONFLICT", "This lifecycle action already binds another owner-approved plan.");
    if ((record.supersededApprovals?.length ?? 0) >= 32) sessionError("SESSION_STORAGE_LIMIT", "Session plan replacement history capacity reached.", 429);
    if (kind === "activation" && (record.state !== "installing" && record.state !== "stale" || record.observation?.installed.enabled))
      sessionError("SESSION_ACTIVATION_UNAVAILABLE", "A previously active policy cannot be reinitialized through plan replacement.");
    if (kind === "revocation" && record.state !== "revoking" && record.state !== "stale")
      sessionError("SESSION_REVOCATION_UNAVAILABLE", "Only an unfinished revocation can replace its expired unsubmitted plan.");
  }
  if (record.revision !== claim.expectedRevision) sessionError("SESSION_REVISION_CONFLICT", "Session changed; review its current state before retrying.");
  const seconds = Math.floor(now / 1000);
  if (!time(now) || !time(approval.issuedAt) || !time(approval.expiresAt) || approval.issuedAt < 1 || approval.expiresAt <= seconds
    || approval.issuedAt > seconds + 30 || approval.expiresAt <= approval.issuedAt || approval.expiresAt - approval.issuedAt > 300)
    sessionError("SESSION_OWNER_APPROVAL_EXPIRED", "Fresh owner consent expired while the lifecycle action waited for admission.", 403);
  if (kind === "activation" && (record.reservationsReleased || record.revocation || ["revoking", "revoked", "expired"].includes(record.state) || record.compiled.validUntil <= seconds))
    sessionError("SESSION_ACTIVATION_UNAVAILABLE", "A retired or expired policy cannot be installed or reset.");
  const next = cloneSession(record);
  if (prior) next.supersededApprovals = [...(next.supersededApprovals ?? []), { approval: cloneSession(prior), supersededAt: now }];
  next[kind === "activation" ? "activation" : "revocation"] = cloneSession(approval);
  next.state = kind === "activation" ? "installing" : "revoking";
  next.revision++; next.updatedAt = now;
  return { record: next, claimed: true };
}
export function sessionLifecycleKind(plan: StoredPlan): "activation" | "revocation" | undefined {
  return plan.draft.operation === "activate_smart_account_session" ? "activation"
    : plan.draft.operation === "revoke_smart_account_session" ? "revocation" : undefined;
}
export function sessionLifecycleId(plan: StoredPlan): string | undefined {
  if (!sessionLifecycleKind(plan)) return undefined;
  const summary = plan.draft.summary;
  if (!recordObject(summary) || typeof summary.sessionId !== "string" || !uuid.test(summary.sessionId) || !hash(summary.compiledHash))
    sessionError("SESSION_LIFECYCLE_PLAN_INVALID", "The lifecycle plan lacks its exact immutable session identity.");
  return summary.sessionId;
}
export function assertSessionLifecyclePlan(record: StoredSession, actor: RestActor, plan: StoredPlan, nowSeconds: number): void {
  const kind = sessionLifecycleKind(plan);
  if (!kind) return;
  assertSessionActor(record, actor, true);
  const approval = kind === "activation" ? record.activation : record.revocation;
  const summary = plan.draft.summary as Record<string, unknown>;
  if (sessionLifecycleId(plan) !== record.id || !approval || approval.planId !== plan.id || !same(approval.planCommitment, plan.commitment)
    || summary.compiledHash !== record.compiled.compiledHash || plan.actor.accountId !== actor.accountId || plan.actor.principalId !== actor.principalId
    || !plan.smartAccount || !same(plan.smartAccount.bindingId, record.compiled.bindingId) || plan.smartAccount.chainId !== record.compiled.chainId
    || !same(plan.smartAccount.address, record.compiled.wallet) || !same(plan.draft.account, record.compiled.wallet)
    || record.state !== (kind === "activation" ? "installing" : "revoking") || record.reservationsReleased
    || kind === "activation" && (record.revocation || record.compiled.validUntil <= nowSeconds))
    sessionError("SESSION_LIFECYCLE_PLAN_UNADMITTED", "This exact lifecycle plan has not been admitted or was superseded, activated, or revoked.", 403);
}
/** Caller additionally proves no durable transport reservation while holding the same account/plan lock. */
export function assertSessionPlanSupersedable(record: StoredSession, prior: SessionOwnerApproval, plan: StoredPlan, now: number): void {
  if (plan.id !== prior.planId || !same(plan.commitment, prior.planCommitment) || plan.actor.accountId !== record.compiled.ownerAccountId
    || plan.actor.principalId !== `owner:${record.compiled.ownerAccountId}` || sessionLifecycleId(plan) !== record.id
    || sessionLifecycleKind(plan) !== prior.kind || (plan.draft.summary as Record<string, unknown>).compiledHash !== record.compiled.compiledHash
    || !time(now) || plan.expiresAt > now || plan.steps.some(step => step.state !== "waiting" || step.attempt || step.externalExecution))
    sessionError("SESSION_PLAN_NOT_SUPERSEDABLE", "Only an expired, never-admitted exact lifecycle plan can be replaced.");
}
export function createSessionObservation(installed: InstalledSessionObservation, observedAt: number, finalized = false): SessionCanonicalObservation {
  const body = { installed: cloneSession(installed), observedAt, finalized };
  return { ...body, proofHash: fingerprint(body) };
}
function assertObservation(record: StoredSession, observation: SessionCanonicalObservation, now: number): void {
  const o = observation?.installed, c = record.compiled;
  if (!o || !hash(observation.proofHash) || !same(observation.proofHash, fingerprint({ installed: o, observedAt: observation.observedAt, finalized: observation.finalized }))
    || !time(observation.observedAt) || observation.observedAt > now || typeof observation.finalized !== "boolean"
    || o.chainId !== c.chainId || !address(o.account) || !same(o.account, c.wallet) || !hash(o.compiledHash) || !same(o.compiledHash, c.compiledHash)
    || !hash(o.permissionId) || !same(o.permissionId, c.permissionId) || !hash(o.configurationHash) || !integer(o.enableNonce) || typeof o.enabled !== "boolean"
    || !o.evidence || o.evidence.source !== "onchain" || o.evidence.chainId !== c.chainId || !hash(o.evidence.blockHash)
    || !integer(o.evidence.blockNumber) || !integer(o.evidence.timestamp) || !Array.isArray(o.counters) || o.counters.length > 256)
    return invalid("Canonical observation does not bind this exact compiled session and chain.");
  const keys = new Set<string>();
  const admin = o.administration;
  if (o.enabled && (!admin || !integer(admin.epoch) || !hash(admin.hash) || !admin.lastInitialization
    || !integer(admin.lastInitialization.epoch) || !Array.isArray(admin.lastInitialization.permissionIds)
    || admin.lastInitialization.permissionIds.length > 16 || !admin.lastInitialization.permissionIds.every(hash)))
    return invalid("Enabled session observations require complete canonical administration history.");
  for (const counter of o.counters) {
    if (!address(counter.policy) || !hash(counter.configId) || typeof counter.name !== "string" || counter.name.length < 1 || counter.name.length > 128
      || !integer(counter.used) || !integer(counter.limit) || BigInt(counter.used) > BigInt(counter.limit)) return invalid("Invalid exact onchain policy counter observation.");
    const key = `${counter.policy.toLowerCase()}:${counter.configId.toLowerCase()}:${counter.name}`;
    if (keys.has(key)) return invalid("Duplicate onchain policy counter.");
    keys.add(key);
  }
  const previous = record.observation;
  if (previous && !record.invalidation && (BigInt(o.evidence.blockNumber) < BigInt(previous.installed.evidence.blockNumber)
    || o.evidence.blockNumber === previous.installed.evidence.blockNumber && !same(o.evidence.blockHash, previous.installed.evidence.blockHash)))
    sessionError("SESSION_OBSERVATION_STALE", "An older or reorganized block cannot overwrite the current proof without explicit invalidation.");
}
export function applySessionObservation(record: StoredSession, update: SessionObservationUpdate, grantActive: boolean, now: number): SessionMutationResult {
  assertSessionActor(record, update.actor); revision(update.expectedRevision);
  if (record.revision !== update.expectedRevision || (record.observation?.proofHash ?? null) !== update.expectedObservationHash) return { record: cloneSession(record), applied: false };
  assertObservation(record, update.observation, now);
  const next = cloneSession(record), o = update.observation.installed, c = record.compiled;
  const retired = !o.enabled && BigInt(o.enableNonce) > BigInt(c.activationEnableNonce);
  const expired = BigInt(o.evidence.timestamp) >= BigInt(c.validUntil);
  // A finalized retirement is permanent. If its assumption breaks, fail closed instead of reusing old authority.
  if (record.reservationsReleased && o.enabled && !expired) sessionError("SESSION_FINALITY_CONTRADICTION", "A finalized retired policy appears enabled; stop execution and inspect chain finality.");
  next.observation = cloneSession(update.observation);
  delete next.invalidation;
  next.reservationsReleased = record.reservationsReleased || update.observation.finalized && retired;
  if (retired) next.state = "revoked";
  else if (expired) next.state = "expired";
  else if (record.revocation) next.state = "revoking";
  else if (o.enabled && o.enableNonce === c.activationEnableNonce && record.activation && grantActive) next.state = "active";
  else if (!o.enabled && o.enableNonce === c.activationEnableNonce && record.activation && grantActive) next.state = "installing";
  else next.state = "stale";
  // The verifier proves current configuration, while this history detects a reset
  // to an identical configuration. Such a reset cannot refresh the owner's budget.
  const previous = record.observation?.installed;
  const counterKey = (counter: InstalledSessionObservation["counters"][number]) => `${counter.policy.toLowerCase()}:${counter.configId.toLowerCase()}:${counter.name}`;
  const priorCounters = new Map(previous?.counters.map(counter => [counterKey(counter), counter]));
  const hadEnabledObservation = previous?.enabled === true;
  const admin = o.administration, baseline = record.preparedAdministration;
  const initialAdministrationInvalid = o.enabled && (!admin || BigInt(admin.epoch) !== BigInt(baseline.epoch) + 1n
    || admin.lastInitialization?.epoch !== admin.epoch || admin.lastInitialization.permissionIds.length !== 1
    || !same(admin.lastInitialization.permissionIds[0]!, c.permissionId));
  const administrationChanged = hadEnabledObservation && o.enabled && (previous.administration?.epoch !== admin?.epoch
    || previous.administration?.hash !== admin?.hash);
  const countersChanged = hadEnabledObservation && (previous.counters.length !== o.counters.length || o.counters.some(counter => {
    const prior = priorCounters.get(counterKey(counter));
    return !prior || prior.limit !== counter.limit || BigInt(counter.used) < BigInt(prior.used);
  }));
  const firstUseAlreadySpent = !hadEnabledObservation && o.enabled && o.counters.some(counter => counter.used !== "0");
  const poisoned = record.invalidation?.reason === "configuration-changed" || record.invalidation?.reason === "counter-reset"
    || record.invalidation?.reason === "reorg";
  const awaitingNonceRevocation = !o.enabled && Boolean(record.revocation);
  if (!retired && !expired && !awaitingNonceRevocation && (poisoned || countersChanged || firstUseAlreadySpent || initialAdministrationInvalid || administrationChanged
    || hadEnabledObservation && (!o.enabled || !same(previous.configurationHash, o.configurationHash)))) {
    next.state = "stale";
    next.invalidation = { reason: poisoned ? record.invalidation!.reason : countersChanged || firstUseAlreadySpent ? "counter-reset" : "configuration-changed",
      priorProofHash: record.observation?.proofHash ?? null, observedAt: now };
  }
  if (!grantActive && !["revoked", "expired", "revoking"].includes(next.state)) {
    next.state = "stale"; next.invalidation ??= { reason: "grant-inactive", priorProofHash: next.observation.proofHash, observedAt: now };
  }
  next.revision++; next.updatedAt = now;
  return { record: cloneSession(next), applied: true };
}
export function applySessionInvalidation(record: StoredSession, update: SessionInvalidationUpdate, now: number): SessionMutationResult {
  assertSessionActor(record, update.actor); revision(update.expectedRevision);
  if (record.revision !== update.expectedRevision) return { record: cloneSession(record), applied: false };
  if (!["reorg", "configuration-changed", "counter-reset", "grant-inactive", "binding-unlinked", "verification-unavailable"].includes(update.reason) || !time(now)) return invalid("Invalid session invalidation.");
  const next = cloneSession(record);
  const permanent = record.invalidation && ["reorg", "configuration-changed", "counter-reset"].includes(record.invalidation.reason);
  next.invalidation = permanent ? cloneSession(record.invalidation!) : { reason: update.reason, priorProofHash: record.observation?.proofHash ?? null, observedAt: now };
  next.state = "stale"; next.revision++; next.updatedAt = now;
  return { record: next, applied: true };
}
export function sessionQuota(record: StoredSession): SessionQuota {
  return cloneSession({ sessionId: record.id, state: record.state, allocationManifestHash: record.allocationManifestHash,
    approvedGroups: record.allocationGroups, localAllocations: localSessionAllocations(record), counters: record.observation?.installed.counters ?? null,
    observation: record.observation ?? null, reservationsReleased: record.reservationsReleased, executionAuthority: false as const,
    balanceSource: "onchain-only" as const, atomicAcrossChains: false as const });
}
export function assertSessionUserOperation(record: StoredSession, actor: RestActor, binding: UserOperationSessionBinding,
  accountBindingId: string, chainId: number, sender: Address, nowSeconds: number): void {
  assertSessionActor(record, actor);
  const c = record.compiled, observation = record.observation;
  if (!binding || record.id !== binding.id || !hash(binding.policyHash) || !same(binding.policyHash, c.policyHash)
    || !hash(binding.compiledHash) || !same(binding.compiledHash, c.compiledHash) || binding.generation !== c.generation
    || binding.grantId !== c.grantId || !hash(binding.permissionId) || !same(binding.permissionId, c.permissionId)
    || !address(binding.sessionKey) || !same(binding.sessionKey, c.sessionKey) || !hash(binding.observationHash)
    || !same(accountBindingId, c.bindingId) || chainId !== c.chainId || !same(sender, c.wallet))
    sessionError("SESSION_OPERATION_BINDING_MISMATCH", "The UserOperation differs from its exact wallet, grant, generation and compiled policy.");
  if (!time(nowSeconds) || record.state !== "active" || record.reservationsReleased || record.invalidation || !record.activation || record.revocation
    || nowSeconds < c.validAfter || nowSeconds >= c.validUntil || !observation || !same(observation.proofHash, binding.observationHash)
    || observation.observedAt > nowSeconds * 1000 + 999 || nowSeconds * 1000 - observation.observedAt > SESSION_LIMITS.maximumObservationAgeSeconds * 1000
    || !observation.installed.enabled || observation.installed.enableNonce !== c.activationEnableNonce)
    sessionError("SESSION_EXECUTION_UNAVAILABLE", "The exact session is not active with a current canonical installed-policy observation.", 403);
}
