import type { Address, Hex } from "viem";
import type { BotGrant } from "../auth/store.js";
import type { StoredPlan } from "../transactions/types.js";
import { RestError, type RestActor } from "../core.js";
import { assertActor, type ActiveActorGuard } from "../transactions/store.js";
import { SESSION_LIMITS, applySessionClaim, applySessionInvalidation, applySessionObservation, assertIdempotencyMatch,
  assertCompiledSessionIntegrity, assertNewSession, assertSessionGrant, assertSessionId, assertSessionIdempotency, assertSessionList, assertSessionUserOperation,
  canReadSession, cloneSession, identityConflicts, missingSession, reservationConflicts, sessionError, sessionQuota, assertSessionLifecyclePlan, sessionLifecycleId,
  type SessionStore, type SynchronousSessionGuard } from "./store.js";
import type { SessionClaim, SessionIdempotency, SessionInvalidationUpdate, SessionListOptions, SessionObservationUpdate,
  StoredSession, UserOperationSessionBinding, SessionOwnerApproval } from "./types.js";

export interface MemorySessionOptions {
  /** Both callbacks must read current local state synchronously, inside the account authority mutex. */
  assertBinding(record: StoredSession): void;
  grant(record: StoredSession): BotGrant | null;
  /** Prove exact prior plan expiry and absence of every shared transport reservation under the account mutex. */
  assertSupersedablePlan?(record: StoredSession, prior: SessionOwnerApproval, now: number): void;
  now?: () => number;
}
type Idempotency = { operation: string; sessionId: string; requestHash: string };
/** Bounded local/test adapter. All mutation callbacks are synchronous after acquiring account authority. */
export class MemorySessionStore implements SessionStore, SynchronousSessionGuard {
  private readonly records = new Map<string, StoredSession>();
  private readonly idempotency = new Map<string, Idempotency>();
  constructor(private readonly authority: ActiveActorGuard, private readonly options: MemorySessionOptions) {
    if (typeof options?.assertBinding !== "function" || typeof options?.grant !== "function")
      sessionError("SESSION_AUTHORITY_NOT_CONFIGURED", "Current synchronous binding and grant guards are required.", 503);
  }
  private clock() { return (this.options.now ?? Date.now)(); }
  async findCompiled(chainId: number, account: Address, permissionId: Hex) {
    const record = [...this.records.values()].find(value => value.compiled.chainId === chainId
      && value.compiled.wallet.toLowerCase() === account.toLowerCase() && value.compiled.permissionId.toLowerCase() === permissionId.toLowerCase());
    if (!record) return undefined;
    assertCompiledSessionIntegrity(record.compiled);
    return cloneSession(record.compiled);
  }
  private key(actor: RestActor, key: string) { return `${actor.accountId}|${actor.principalId}|${key}`; }
  private required(actor: RestActor, id: string) {
    assertActor(actor); assertSessionId(id);
    const record = this.records.get(id);
    return record && canReadSession(record, actor) ? record : missingSession();
  }
  private checkAuthority(record: StoredSession, now: number) {
    this.options.assertBinding(record);
    assertSessionGrant(record, this.options.grant(record), Math.floor(now / 1000));
  }
  private checkReservation(record: StoredSession) {
    if ([...this.records.values()].some(other => reservationConflicts(record, other)))
      sessionError("SESSION_ALLOCATION_CONFLICT", "Another admitted session reserves this physical wallet until finalized revocation.");
  }
  private reserve(actor: RestActor, claim: SessionIdempotency, operation: string, id: string) {
    const prefix = `${actor.accountId}|`;
    if ([...this.idempotency.keys()].filter(key => key.startsWith(prefix)).length >= SESSION_LIMITS.idempotencyPerAccount)
      sessionError("SESSION_STORAGE_LIMIT", "Account session idempotency capacity reached.", 429);
    this.idempotency.set(this.key(actor, claim.key), { operation, sessionId: id, requestHash: claim.requestHash });
  }
  async create(input: StoredSession, idempotency: SessionIdempotency, now: number) {
    assertNewSession(input, now); assertSessionIdempotency(idempotency);
    const record = cloneSession(input), claim = cloneSession(idempotency);
    return this.authority.withActiveActor(record.actor, ["plan"], Math.floor(this.clock() / 1000), async () => {
      const existing = this.idempotency.get(this.key(record.actor, claim.key));
      assertIdempotencyMatch(existing, claim, "create");
      if (existing) return cloneSession(this.required(record.actor, existing.sessionId));
      const checkedAt = this.clock();
      assertNewSession(record, checkedAt); this.checkAuthority(record, checkedAt);
      if (this.records.has(record.id) || [...this.records.values()].some(other => identityConflicts(record, other)))
        sessionError("SESSION_CONFLICT", "The immutable permission, salt, nonce or key generation is already recorded.");
      if ([...this.records.values()].filter(other => other.compiled.ownerAccountId === record.compiled.ownerAccountId).length >= SESSION_LIMITS.sessionsPerAccount)
        sessionError("SESSION_STORAGE_LIMIT", "Account session record capacity reached.", 429);
      this.reserve(record.actor, claim, "create", record.id);
      this.records.set(record.id, record);
      return cloneSession(record);
    });
  }
  async find(actor: RestActor, claim: SessionIdempotency) {
    assertActor(actor); assertSessionIdempotency(claim);
    const existing = this.idempotency.get(this.key(actor, claim.key));
    assertIdempotencyMatch(existing, claim, "create");
    return existing ? cloneSession(this.required(actor, existing.sessionId)) : undefined;
  }
  async get(actor: RestActor, id: string) {
    assertActor(actor); assertSessionId(id);
    const record = this.records.get(id);
    return record && canReadSession(record, actor) ? cloneSession(record) : undefined;
  }
  async list(actor: RestActor, options: SessionListOptions) {
    assertActor(actor); assertSessionList(options);
    const records = [...this.records.values()].filter(record => canReadSession(record, actor) && (!options.cursor || record.id > options.cursor))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const items = records.slice(0, options.limit).map(cloneSession);
    return { items, ...(records.length > options.limit && items.length ? { nextCursor: items.at(-1)!.id } : {}) };
  }
  private async claim(input: SessionClaim, kind: "activation" | "revocation") {
    const claim = cloneSession(input);
    assertActor(claim.actor); assertSessionIdempotency(claim.idempotency);
    return this.authority.withActiveActor(claim.actor, ["plan"], Math.floor(this.clock() / 1000), async () => {
      const current = this.required(claim.actor, claim.id), operation = kind === "activation" ? "activate" : "revoke";
      const existing = this.idempotency.get(this.key(claim.actor, claim.idempotency.key));
      assertIdempotencyMatch(existing, claim.idempotency, operation, current.id);
      if (existing) return { record: cloneSession(current), claimed: false };
      const now = this.clock();
      if (kind === "activation") this.checkAuthority(current, now);
      const prior = kind === "activation" ? current.activation : current.revocation;
      const replacement = Boolean(prior && prior.planId !== claim.approval.planId);
      if (replacement) {
        if (!this.options.assertSupersedablePlan) sessionError("SESSION_PLAN_REPLACEMENT_UNAVAILABLE", "A synchronous prior-plan and transport guard is required for replacement.", 503);
        this.options.assertSupersedablePlan(current, prior!, now);
      }
      const result = applySessionClaim(current, claim, kind, now, replacement);
      if (result.claimed && kind === "activation") this.checkReservation(current);
      this.reserve(claim.actor, claim.idempotency, operation, current.id);
      if (result.claimed) this.records.set(current.id, result.record);
      return cloneSession(result);
    });
  }
  claimActivation(claim: SessionClaim) { return this.claim(claim, "activation"); }
  claimRevocation(claim: SessionClaim) { return this.claim(claim, "revocation"); }
  async observe(input: SessionObservationUpdate) {
    // Trusted background observations also need to retire authority after a grant
    // revocation. This entire method has no await and cannot interleave with admission.
    const update = cloneSession(input), current = this.required(update.actor, update.id), now = this.clock();
    let grantActive = true;
    try { this.checkAuthority(current, now); } catch (error) { if (!(error instanceof RestError)) throw error; grantActive = false; }
    const result = applySessionObservation(current, update, grantActive, now);
    if (result.applied) {
      if (result.record.observation?.installed.enabled && !result.record.reservationsReleased) this.checkReservation(current);
      this.records.set(current.id, result.record);
    }
    return cloneSession(result);
  }
  async markStale(input: SessionInvalidationUpdate) {
    const update = cloneSession(input), current = this.required(update.actor, update.id);
    const result = applySessionInvalidation(current, update, this.clock());
    if (result.applied) this.records.set(current.id, result.record);
    return cloneSession(result);
  }
  async quota(actor: RestActor, id: string) { return sessionQuota(this.required(actor, id)); }
  assertUserOperationSession(actor: RestActor, binding: UserOperationSessionBinding, accountBindingId: string,
    chainId: number, sender: Address, nowSeconds: number): void {
    const record = this.required(actor, binding.id);
    this.checkAuthority(record, nowSeconds * 1000);
    assertSessionUserOperation(record, actor, binding, accountBindingId, chainId, sender, nowSeconds);
  }
  assertUserOperationLifecyclePlan(actor: RestActor, plan: StoredPlan, nowSeconds: number): void {
    const id = sessionLifecycleId(plan);
    if (id) assertSessionLifecyclePlan(this.required(actor, id), actor, plan, nowSeconds);
  }
}
