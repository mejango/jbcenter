import type { Pool, PoolClient } from "pg";
import type { Address, Hex } from "viem";
import { assertRestActorActive } from "../auth/postgres.js";
import type { BotGrant } from "../auth/store.js";
import type { StoredPlan } from "../transactions/types.js";
import { RestError, type RestActor } from "../core.js";
import type { CompiledSession } from "../smartAccounts/compiler/types.js";
import { assertActor } from "../transactions/store.js";
import {
  SESSION_LIMITS, applySessionClaim, applySessionInvalidation, applySessionObservation,
  assertCompiledSessionIntegrity, assertIdempotencyMatch, assertNewSession, assertSessionActor, assertSessionGrant,
  assertSessionId, assertSessionIdempotency, assertSessionList, assertSessionUserOperation,
  canReadSession, cloneSession, localSessionAllocations, sessionQuota,
  assertSessionLifecyclePlan, assertSessionPlanSupersedable, sessionLifecycleId, type SessionStore,
} from "./store.js";
import type {
  SessionClaim, SessionIdempotency, SessionInvalidationUpdate, SessionListOptions,
  SessionObservationUpdate, StoredSession, UserOperationSessionBinding,
} from "./types.js";

type Idempotency = { operation: string; sessionId: string; requestHash: string };
const failure = (code: string, message: string, status = 409): never => {
  throw new RestError(status, code, message);
};
const missing = (): never => failure("SESSION_NOT_FOUND", "Session was not found for this principal.", 404);
const conflict = (): never => failure("SESSION_CONFLICT", "This session identity or authorization is already reserved.");

async function databaseNow(client: PoolClient): Promise<number> {
  const result = await client.query<{ now: string }>(
    "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now",
  );
  return Number(result.rows[0]!.now);
}

async function lockAccount(client: PoolClient, actor: RestActor): Promise<void> {
  assertActor(actor);
  const account = await client.query("SELECT id FROM rest_accounts WHERE id=$1 FOR UPDATE", [actor.accountId]);
  if (!account.rowCount) missing();
}

/** Physical-wallet namespace deliberately excludes API-account, binding and grant identities. */
async function lockWallet(client: PoolClient, record: StoredSession): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `rest-session-wallet:${record.compiled.chainId}:${record.compiled.wallet.toLowerCase()}`,
  ]);
}

async function grantFor(client: PoolClient, record: StoredSession): Promise<BotGrant | null> {
  const rows = await client.query<{
    id: string; account_id: string; bot_address: Address; scopes: BotGrant["scopes"];
    label: string; created_at: string; expires_at: string; revoked_at: string | null;
  }>("SELECT * FROM rest_bot_grants WHERE id=$1 AND account_id=$2", [record.compiled.grantId, record.actor.accountId]);
  const row = rows.rows[0];
  return row ? {
    id: row.id, accountId: row.account_id, botAddress: row.bot_address, scopes: row.scopes,
    label: row.label, createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
  } : null;
}

async function assertBinding(client: PoolClient, record: StoredSession): Promise<void> {
  const rows = await client.query(
    `SELECT id FROM rest_smart_account_bindings WHERE account_id=$1 AND id=$2
     AND chain_id=$3 AND wallet_address=$4 AND revoked_at IS NULL`,
    [record.actor.accountId, record.compiled.bindingId.toLowerCase(), record.compiled.chainId, record.compiled.wallet.toLowerCase()],
  );
  if (!rows.rowCount) failure("SESSION_BINDING_INACTIVE", "The linked smart account is absent, changed, or unlinked.");
}

async function selectSession(client: PoolClient, actor: RestActor, id: string, lock = false): Promise<StoredSession> {
  assertActor(actor);
  assertSessionId(id);
  const result = await client.query<{ document: StoredSession }>(
    `SELECT document FROM rest_sessions WHERE id=$1 AND account_id=$2${lock ? " FOR UPDATE" : ""}`,
    [id, actor.accountId],
  );
  const record = result.rows[0]?.document;
  if (!record || !canReadSession(record, actor)) return missing();
  return cloneSession(record);
}

/**
 * Caller is inside a transaction and already holds the API-account authority lock.
 * The row lock serializes admission against observation invalidation and revocation.
 * This is a DB admission check, never a substitute for current onchain verification.
 */
export async function assertUserOperationSession(
  client: PoolClient, actor: RestActor, binding: UserOperationSessionBinding,
  accountBindingId: string, chainId: number, sender: Address, nowSeconds: number,
): Promise<void> {
  if (!binding) failure("SESSION_INPUT_INVALID", "An exact session binding is required.", 400);
  const record = await selectSession(client, actor, binding.id, true);
  await assertBinding(client, record);
  const grant = await grantFor(client, record);
  // Locks or pool contention may have outlived the caller's clock sample.
  const now = Math.floor((await databaseNow(client)) / 1000);
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0)
    failure("SESSION_INVALID", "Invalid session admission time.", 400);
  assertSessionGrant(record, grant, now);
  assertSessionUserOperation(record, actor, binding, accountBindingId, chainId, sender, now);
}
/** Caller holds the API-account lock and this exact transaction-plan row lock. */
export async function assertUserOperationLifecyclePlan(client: PoolClient, actor: RestActor, plan: StoredPlan, nowSeconds: number): Promise<void> {
  const id = sessionLifecycleId(plan);
  if (id) assertSessionLifecyclePlan(await selectSession(client, actor, id, true), actor, plan, Math.floor((await databaseNow(client)) / 1000));
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) failure("SESSION_INVALID", "Invalid lifecycle admission time.", 400);
}

/** Durable cross-process session coordination. No network work occurs in transactions. */
export class PostgresSessionStore implements SessionStore {
  constructor(private readonly pool: Pool) {}

  /** Trusted inspector lookup only. A stored compiler document conveys no execution authority. */
  async findCompiled(chainId: number, account: Address, permissionId: Hex): Promise<CompiledSession | undefined> {
    if (!Number.isSafeInteger(chainId) || chainId < 1 || !/^0x[0-9a-fA-F]{40}$/.test(account)
      || !/^0x[0-9a-fA-F]{64}$/.test(permissionId))
      failure("SESSION_INPUT_INVALID", "Use an exact chain, wallet and permission identity.", 400);
    const rows = await this.pool.query<{ compiled: CompiledSession }>(
      "SELECT document->'compiled' AS compiled FROM rest_sessions WHERE chain_id=$1 AND wallet_address=$2 AND permission_id=$3",
      [chainId, account.toLowerCase(), permissionId.toLowerCase()],
    );
    const compiled = rows.rows[0]?.compiled;
    if (!compiled) return undefined;
    assertCompiledSessionIntegrity(compiled);
    return cloneSession(compiled);
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") conflict();
      throw error;
    } finally { client.release(); }
  }

  private async idem(client: PoolClient, actor: RestActor, key: string): Promise<Idempotency | undefined> {
    const result = await client.query<{ operation: string; session_id: string; request_hash: string }>(
      "SELECT operation,session_id,request_hash FROM rest_session_idempotency WHERE account_id=$1 AND principal_id=$2 AND key=$3",
      [actor.accountId, actor.principalId, key],
    );
    const row = result.rows[0];
    return row ? { operation: row.operation, sessionId: row.session_id, requestHash: row.request_hash } : undefined;
  }

  private async reserveIdempotency(client: PoolClient, actor: RestActor, claim: SessionIdempotency, operation: string, sessionId: string) {
    const count = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM rest_session_idempotency WHERE account_id=$1", [actor.accountId],
    );
    if (Number(count.rows[0]!.count) >= SESSION_LIMITS.idempotencyPerAccount)
      failure("SESSION_STORAGE_LIMIT", "The account session idempotency limit is reached.", 429);
    await client.query(
      "INSERT INTO rest_session_idempotency(account_id,principal_id,key,request_hash,operation,session_id) VALUES($1,$2,$3,$4,$5,$6)",
      [actor.accountId, actor.principalId, claim.key, claim.requestHash, operation, sessionId],
    );
  }

  private async save(client: PoolClient, record: StoredSession): Promise<StoredSession> {
    const copy = cloneSession(record);
    await client.query(
      "UPDATE rest_sessions SET updated_at=$2,revision=$3,state=$4,reservations_released=$5,document=$6::jsonb WHERE id=$1",
      [copy.id, copy.updatedAt, copy.revision, copy.state, copy.reservationsReleased, JSON.stringify(copy)],
    );
    return copy;
  }

  async create(input: StoredSession, idempotency: SessionIdempotency, now: number): Promise<StoredSession> {
    assertNewSession(input, now);
    assertSessionIdempotency(idempotency);
    const record = cloneSession(input), claim = cloneSession(idempotency);
    return this.transaction(async client => {
      await assertRestActorActive(client, record.actor, ["plan"], Math.floor(now / 1000));
      const existing = await this.idem(client, record.actor, claim.key);
      assertIdempotencyMatch(existing, claim, "create");
      if (existing) return selectSession(client, record.actor, existing.sessionId);
      await lockWallet(client, record);
      assertSessionActor(record, record.actor);
      await assertBinding(client, record);
      const grant = await grantFor(client, record);
      const checkedAt = await databaseNow(client);
      assertNewSession(record, checkedAt);
      assertSessionGrant(record, grant, Math.floor(checkedAt / 1000));
      const count = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM rest_sessions WHERE account_id=$1", [record.actor.accountId]);
      if (Number(count.rows[0]!.count) >= SESSION_LIMITS.sessionsPerAccount)
        failure("SESSION_STORAGE_LIMIT", "The account session record limit is reached.", 429);
      const c = record.compiled;
      await client.query(
        `INSERT INTO rest_sessions(id,account_id,principal_id,binding_id,grant_id,chain_id,wallet_address,session_key,generation,
         permission_id,salt,policy_nonce,policy_hash,compiled_hash,allocation_manifest_hash,valid_after,valid_until,
         created_at,updated_at,revision,state,reservations_released,document)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb)`,
        [record.id, record.actor.accountId, record.actor.principalId, c.bindingId.toLowerCase(), c.grantId, c.chainId,
          c.wallet.toLowerCase(), c.sessionKey.toLowerCase(), c.generation, c.permissionId.toLowerCase(), c.salt.toLowerCase(),
          c.nonce.toLowerCase(), c.policyHash.toLowerCase(), c.compiledHash.toLowerCase(), record.allocationManifestHash.toLowerCase(),
          c.validAfter, c.validUntil, record.createdAt, record.updatedAt, record.revision, record.state, record.reservationsReleased, JSON.stringify(record)],
      );
      await this.reserveIdempotency(client, record.actor, claim, "create", record.id);
      await assertRestActorActive(client, record.actor, ["plan"], Math.floor(now / 1000));
      const committedAt = await databaseNow(client);
      assertNewSession(record, committedAt);
      assertSessionGrant(record, grant, Math.floor(committedAt / 1000));
      return cloneSession(record);
    });
  }

  async find(actor: RestActor, claim: SessionIdempotency): Promise<StoredSession | undefined> {
    assertActor(actor); assertSessionIdempotency(claim);
    const client = await this.pool.connect();
    try {
      const existing = await this.idem(client, actor, claim.key);
      assertIdempotencyMatch(existing, claim, "create");
      return existing ? await selectSession(client, actor, existing.sessionId) : undefined;
    } finally { client.release(); }
  }

  async get(actor: RestActor, id: string): Promise<StoredSession | undefined> {
    assertActor(actor); assertSessionId(id);
    const result = await this.pool.query<{ document: StoredSession }>("SELECT document FROM rest_sessions WHERE id=$1 AND account_id=$2", [id, actor.accountId]);
    const record = result.rows[0]?.document;
    return record && canReadSession(record, actor) ? cloneSession(record) : undefined;
  }

  async list(actor: RestActor, options: SessionListOptions): Promise<{ items: StoredSession[]; nextCursor?: string }> {
    assertActor(actor); assertSessionList(options);
    const owner = actor.principalId === `owner:${actor.accountId}`;
    const grantId = actor.principalId.startsWith("bot:") ? actor.principalId.slice(4) : "";
    const result = await this.pool.query<{ document: StoredSession }>(
      `SELECT document FROM rest_sessions WHERE account_id=$1 AND ($2::boolean OR grant_id=$3)
       AND ($4::text IS NULL OR id COLLATE "C">$4::text COLLATE "C") ORDER BY id COLLATE "C" LIMIT $5`,
      [actor.accountId, owner, grantId, options.cursor ?? null, options.limit + 1],
    );
    const items = result.rows.slice(0, options.limit).map(row => cloneSession(row.document));
    return { items, ...(result.rows.length > options.limit && items.length ? { nextCursor: items.at(-1)!.id } : {}) };
  }

  private async reserveAuthority(client: PoolClient, record: StoredSession): Promise<void> {
    const c = record.compiled;
    // Counter/configuration namespaces can outlive time windows and cross actions.
    // Admit one generation per physical wallet until finalized disabled retirement.
    const overlap = await client.query(
      `SELECT session_id FROM rest_session_reservations WHERE chain_id=$1 AND wallet_address=$2
       AND released_at IS NULL AND session_id<>$3 LIMIT 1`,
      [c.chainId, c.wallet.toLowerCase(), record.id],
    );
    if (overlap.rowCount) failure("SESSION_ALLOCATION_CONFLICT", "Another session still reserves this wallet pending finalized onchain retirement.");
    const coordinates = [{ kind: "key", address: c.sessionKey.toLowerCase() },
      ...localSessionAllocations(record).map(a => ({ kind: "asset", address: a.asset.toLowerCase() }))]
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.address.localeCompare(b.address));
    for (const coordinate of coordinates) {
      await client.query(
        `INSERT INTO rest_session_reservations(session_id,chain_id,wallet_address,kind,coordinate,valid_after,valid_until)
         VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(session_id,kind,coordinate) DO NOTHING`,
        [record.id, c.chainId, c.wallet.toLowerCase(), coordinate.kind, coordinate.address, c.validAfter, c.validUntil],
      );
    }
  }

  private async claim(input: SessionClaim, kind: "activation" | "revocation") {
    const claim = cloneSession(input);
    assertActor(claim.actor); assertSessionIdempotency(claim.idempotency);
    const operation = kind === "activation" ? "activate" : "revoke";
    return this.transaction(async client => {
      await assertRestActorActive(client, claim.actor, ["plan"], Math.floor(claim.now / 1000));
      const snapshot = await selectSession(client, claim.actor, claim.id);
      await lockWallet(client, snapshot);
      const current = await selectSession(client, claim.actor, claim.id, true);
      const existing = await this.idem(client, claim.actor, claim.idempotency.key);
      assertIdempotencyMatch(existing, claim.idempotency, operation, current.id);
      if (existing) return { record: current, claimed: false };
      if (kind === "activation") await assertBinding(client, current);
      const grant = await grantFor(client, current);
      let now = await databaseNow(client);
      if (kind === "activation") assertSessionGrant(current, grant, Math.floor(now / 1000));
      const prior = kind === "activation" ? current.activation : current.revocation;
      const replacement = Boolean(prior && prior.planId !== claim.approval.planId);
      if (replacement) {
        const plans = await client.query<{ document: StoredPlan }>("SELECT document FROM rest_transaction_plans WHERE id=$1 AND account_id=$2 FOR UPDATE", [prior!.planId, current.compiled.ownerAccountId]);
        if (!plans.rows[0]) failure("SESSION_PLAN_NOT_SUPERSEDABLE", "The prior exact lifecycle plan is missing.");
        const transports = await client.query("SELECT 1 FROM rest_transaction_transports WHERE plan_id=$1 LIMIT 1", [prior!.planId]);
        if (transports.rowCount) failure("SESSION_PLAN_NOT_SUPERSEDABLE", "The prior plan already has a permanent execution transport reservation.");
        now = await databaseNow(client);
        assertSessionPlanSupersedable(current, prior!, plans.rows[0]!.document, now);
      }
      let result = applySessionClaim(current, claim, kind, now, replacement);
      if (result.claimed && kind === "activation") await this.reserveAuthority(client, current);
      await this.reserveIdempotency(client, claim.actor, claim.idempotency, operation, current.id);
      await assertRestActorActive(client, claim.actor, ["plan"], Math.floor(claim.now / 1000));
      now = await databaseNow(client);
      if (kind === "activation") assertSessionGrant(current, grant, Math.floor(now / 1000));
      result = applySessionClaim(current, claim, kind, now, replacement);
      if (result.claimed) result.record = await this.save(client, result.record);
      return result;
    });
  }

  claimActivation(claim: SessionClaim) { return this.claim(claim, "activation"); }
  claimRevocation(claim: SessionClaim) { return this.claim(claim, "revocation"); }

  async observe(input: SessionObservationUpdate) {
    const update = cloneSession(input);
    return this.transaction(async client => {
      await lockAccount(client, update.actor);
      const snapshot = await selectSession(client, update.actor, update.id);
      await lockWallet(client, snapshot);
      const current = await selectSession(client, update.actor, update.id, true);
      let active = true;
      try { await assertBinding(client, current); }
      catch (error) { if (!(error instanceof RestError)) throw error; active = false; }
      const grant = await grantFor(client, current);
      const now = await databaseNow(client);
      try { assertSessionGrant(current, grant, Math.floor(now / 1000)); }
      catch (error) { if (!(error instanceof RestError)) throw error; active = false; }
      const result = applySessionObservation(current, update, active, now);
      if (result.applied) {
        if (result.record.observation?.installed.enabled && !result.record.reservationsReleased)
          await this.reserveAuthority(client, result.record);
        if (!current.reservationsReleased && result.record.reservationsReleased)
          await client.query("UPDATE rest_session_reservations SET released_at=$2 WHERE session_id=$1 AND released_at IS NULL", [current.id, now]);
        result.record = await this.save(client, result.record);
      }
      return result;
    });
  }

  async markStale(input: SessionInvalidationUpdate) {
    const update = cloneSession(input);
    return this.transaction(async client => {
      await lockAccount(client, update.actor);
      const snapshot = await selectSession(client, update.actor, update.id);
      await lockWallet(client, snapshot);
      const current = await selectSession(client, update.actor, update.id, true);
      const result = applySessionInvalidation(current, update, await databaseNow(client));
      if (result.applied) result.record = await this.save(client, result.record);
      return result;
    });
  }

  async quota(actor: RestActor, id: string) {
    const record = await this.get(actor, id);
    return sessionQuota(record ?? missing());
  }
}
