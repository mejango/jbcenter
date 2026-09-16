import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isAddress, type Address, type Hex } from "viem";
import { RestError, type RestActor } from "../core.js";
import { stable } from "../smartAccounts/service.js";
import type { SmartAccountBinding, SmartAccountManifest } from "../smartAccounts/types.js";
import type { StoredPlan } from "../transactions/types.js";
import { getPostgresTransports } from "../transactions/transport-reservations.js";
import { assertPlan, digest, type UserOperationRecord } from "../userOperations/store.js";
import type { WalletAssertion } from "./webauthn.js";
import { assertWalletPaymentReviewContext, copyWalletPaymentReviewAssertion, createWalletPaymentReviewDraft, validateWalletPaymentReviewDraft,
  verifyWalletPaymentReviewProof, type WalletPaymentReviewApprover, type WalletPaymentReviewContext, type WalletPaymentReviewDraft } from "./paymentReviews.js";
import { walletSessionCredential } from "./loginPostgres.js";
import type { WalletAuthorityDevice } from "./devices.js";
import { parseWalletAppPrincipalId, walletAppAccount, walletAppAudience, walletAppFields,
  walletAppPrincipalId, walletAppUuid } from "./appGrants.js";
import { assertWalletAppGrantActiveInTransaction, getWalletAppGrantInTransaction } from "./appGrantsPostgres.js";
import type { WalletAuthorityContext } from "./authority.js";
import { loadWalletAuthorityContextInTransaction, PostgresWalletAuthorityStore } from "./authorityPostgres.js";
import { PostgresWalletCeremonyStore, lockWalletCeremonyAdmission, walletCeremonyDatabaseNow } from "./ceremoniesPostgres.js";
import { assertWalletCentralSessionActiveInTransaction } from "./loginPostgres.js";
import { validateWalletPolicyOrigin } from "./policy.js";
import { validateWalletHandoffToken } from "./handoff.js";

export interface WalletPaymentReviewView {
  draft: WalletPaymentReviewDraft;
  status: "pending" | "approved" | "cancelled";
  approvedAtMs: number | null;
  cancelledAtMs: number | null;
  operationState: UserOperationRecord["state"];
}
export interface WalletPaymentReviewAppView extends WalletPaymentReviewView {
  approval: { signature: Hex; signedCommitment: Hex } | null;
}
export interface WalletPaymentReviewStoreOptions {
  issuer: string;
  audience: string;
  token: Address;
  directV6Terminal: Address;
  manifestFor(binding: SmartAccountBinding): SmartAccountManifest;
  maxRecords?: number;
  maxAccountRecords?: number;
  receiptRetentionMs?: number;
}
interface ReviewRow {
  id: string; account_id: string; principal_id: string; operation_id: string; preparation_key: string;
  input_digest: string; ceremony_id: string; created_at_ms: string; expires_at_ms: string; retain_until_ms: string;
  draft: WalletPaymentReviewDraft; status: WalletPaymentReviewView["status"]; session_id: string | null;
  proof_digest: string | null; signature: Hex | null; signed_commitment: Hex | null;
  approved_at_ms: string | null; cancelled_at_ms: string | null;
}
interface Captured {
  context: WalletPaymentReviewContext;
  authority: string;
  operation: string;
  plan: string;
}
function invalid(): never { throw new RestError(400, "WALLET_PAYMENT_REVIEW_INVALID", "Wallet payment review input is invalid."); }
function inactive(): never { throw new RestError(403, "WALLET_PAYMENT_REVIEW_INACTIVE", "Wallet payment review authority is unavailable."); }
function conflict(): never { throw new RestError(409, "WALLET_PAYMENT_REVIEW_CONFLICT", "The original payment review cannot be replaced or reused."); }
function expired(): never { throw new RestError(410, "WALLET_PAYMENT_REVIEW_EXPIRED", "The original payment review expired."); }
function missing(): never { throw new RestError(404, "WALLET_PAYMENT_REVIEW_NOT_FOUND", "Wallet payment review is unavailable."); }
function fields(value: unknown, required: string[], optional: string[] = []) {
  try { return walletAppFields(value, required, optional); } catch { return invalid(); }
}
function uuid(value: unknown): string { return walletAppUuid(value) ? value : invalid(); }
function actorOf(value: RestActor): RestActor {
  const actor = fields(value, ["accountId", "principalId"]);
  if (!walletAppAccount(actor.accountId) || !parseWalletAppPrincipalId(actor.principalId)) invalid();
  return { accountId: actor.accountId, principalId: actor.principalId as string };
}
function actorMatches(actor: RestActor, draft: WalletPaymentReviewDraft): void {
  if (actor.accountId !== draft.grant.accountId || actor.principalId !== walletAppPrincipalId(draft.grant)) inactive();
}
function authorityIdentity(context: WalletAuthorityContext): string {
  // Routine observations may refresh readiness without replacing this owner/credential identity.
  return stable({ accountId: context.accountId, enrollment: context.enrollment, credential: context.credential,
    binding: context.binding, identity: context.prior?.identity ?? null,
    authorityEpoch: context.prior?.authorityEpoch ?? null, sessionEpoch: context.prior?.sessionEpoch ?? null });
}
function operationIdentity(record: UserOperationRecord): string {
  const { state: _state, revision: _revision, submission: _submission, observation: _observation, ...immutable } = record;
  return stable(immutable);
}
function planIdentity(plan: StoredPlan): string {
  const { steps: _steps, revision: _revision, ...immutable } = plan; return stable(immutable);
}
function draftIdentity(draft: WalletPaymentReviewDraft): string {
  const { id: _id, createdAtMs: _created, expiresAtMs: _expires, ceremony: _ceremony, ...immutable } = draft;
  return stable(immutable);
}
function live(row: ReviewRow, time: number): void {
  if (Number(row.created_at_ms) > time) inactive();
  if (Number(row.expires_at_ms) <= time) expired();
}
function view(row: ReviewRow, operation: UserOperationRecord): WalletPaymentReviewView {
  return { draft: row.draft, status: row.status,
    approvedAtMs: row.approved_at_ms === null ? null : Number(row.approved_at_ms),
    cancelledAtMs: row.cancelled_at_ms === null ? null : Number(row.cancelled_at_ms), operationState: operation.state };
}
const nowSql = "floor(extract(epoch FROM clock_timestamp())*1000)::bigint";
/** Internal composition. App actors come only from real signed REST authentication; session
 * handles come only from the authenticated central cookie. Neither alone approves a payment.
 * Proof/plan/profile verification occurs before SQL; locked metadata is compared afterwards.
 * Reviews do not reserve a nonce, dispatch, or release execution liability. All replicas must
 * use the same retained-row limits; global admission is bounded, not a capacity guarantee. */
export class PostgresWalletPaymentReviewStore {
  private readonly options: Required<WalletPaymentReviewStoreOptions>;
  private readonly authority: PostgresWalletAuthorityStore;
  private readonly ceremonies: PostgresWalletCeremonyStore;
  constructor(private readonly pool: Pool, input: WalletPaymentReviewStoreOptions) {
    const v = fields(input, ["issuer", "audience", "token", "directV6Terminal", "manifestFor"],
      ["maxRecords", "maxAccountRecords", "receiptRetentionMs"]);
    let issuer: string, audience: string;
    try { issuer = validateWalletPolicyOrigin(v.issuer); audience = walletAppAudience(v.audience); } catch { invalid(); }
    if (typeof v.manifestFor !== "function") invalid();
    for (const key of ["token", "directV6Terminal"] as const)
      if (typeof v[key] !== "string" || !isAddress(v[key]) || BigInt(v[key]) <= 1n) invalid();
    const maxRecords = (v.maxRecords ?? 100_000) as number, maxAccountRecords = (v.maxAccountRecords ?? 128) as number;
    const receiptRetentionMs = (v.receiptRetentionMs ?? 86_400_000) as number;
    for (const [name, value, minimum, maximum] of [["maxRecords", maxRecords, 1, 1_000_000],
      ["maxAccountRecords", maxAccountRecords, 1, 10_000], ["receiptRetentionMs", receiptRetentionMs, 100, 86_400_000]] as const)
      if ((Object.hasOwn(v, name) && typeof v[name] !== "number") || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
    this.options = { issuer, audience, token: (v.token as string).toLowerCase() as Address,
      directV6Terminal: (v.directV6Terminal as string).toLowerCase() as Address,
      manifestFor: v.manifestFor as WalletPaymentReviewStoreOptions["manifestFor"], maxRecords, maxAccountRecords, receiptRetentionMs };
    this.authority = new PostgresWalletAuthorityStore(pool); this.ceremonies = new PostgresWalletCeremonyStore(pool);
  }
  async prepare(inputActor: RestActor, input: { operationId: string; state: string }, inputKey: string): Promise<WalletPaymentReviewView> {
    const actor = actorOf(inputActor), v = fields(input, ["operationId", "state"]), operationId = uuid(v.operationId);
    let state: string; try { state = validateWalletHandoffToken(v.state); } catch { return invalid(); }
    if (typeof inputKey !== "string" || !/^[!-~]{1,128}$/.test(inputKey)) invalid();
    const key = inputKey, inputDigest = digest({ actor, operationId, state }).slice(2);
    const hint = (await this.pool.query<ReviewRow>(`SELECT * FROM rest_wallet_payment_reviews
      WHERE account_id=$1 AND principal_id=$2 AND preparation_key=$3`, [actor.accountId, actor.principalId, key])).rows[0];
    if (hint && (hint.input_digest !== inputDigest || hint.operation_id !== operationId)) conflict();
    const captured = await this.capture(actor, operationId);
    const draft = hint ? this.assertHint(hint, captured) : createWalletPaymentReviewDraft(captured.context,
      { id: randomUUID(), state, createdAtMs: await this.databaseNow() });
    const expectedDraft = draftIdentity(draft), encoded = JSON.stringify(draft);
    const result = await this.transaction(async client => {
      // Each retained table owns its admission lock: schemas may share reviews while
      // resolving distinct ceremony tables. Acquire both before account/session rows.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('wallet-payment-reviews:' || 'rest_wallet_payment_reviews'::regclass::oid::text, 0))");
      await lockWalletCeremonyAdmission(client);
      await this.guard(client, captured, draft, hint?.session_id ?? null);
      const { operation, plan } = await this.lockExecution(client, captured);
      const prior = (await client.query<ReviewRow>(`SELECT * FROM rest_wallet_payment_reviews
        WHERE operation_id=$1 OR (account_id=$2 AND principal_id=$3 AND preparation_key=$4) FOR UPDATE`,
      [operationId, actor.accountId, actor.principalId, key])).rows;
      if (prior.length) {
        if (prior.length !== 1) conflict();
        const row = prior[0]!;
        if (row.account_id !== actor.accountId || row.principal_id !== actor.principalId || row.preparation_key !== key ||
          row.operation_id !== operationId || row.input_digest !== inputDigest || draftIdentity(row.draft) !== expectedDraft) conflict();
        await this.finish(client, captured, row, operation); return view(row, operation);
      }
      await this.unspent(client, operation, plan);
      const counts = (await client.query<{ total: string; account: string }>(`SELECT count(*)::text AS total,
        count(*) FILTER (WHERE account_id=$1)::text AS account FROM rest_wallet_payment_reviews`, [actor.accountId])).rows[0]!;
      if (BigInt(counts.total) >= BigInt(this.options.maxRecords) || BigInt(counts.account) >= BigInt(this.options.maxAccountRecords))
        throw new RestError(429, "WALLET_PAYMENT_REVIEW_LIMIT", "Wallet payment review retention limit reached.");
      await this.ceremonies.issueInTransaction(client, draft.ceremony, null);
      const row = (await client.query<ReviewRow>(`INSERT INTO rest_wallet_payment_reviews
        (id,account_id,principal_id,operation_id,preparation_key,input_digest,ceremony_id,created_at_ms,expires_at_ms,retain_until_ms,draft)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING *`,
      [draft.id, actor.accountId, actor.principalId, operationId, key, inputDigest, draft.ceremony.id,
        draft.createdAtMs, draft.expiresAtMs, draft.expiresAtMs + this.options.receiptRetentionMs, encoded])).rows[0]!;
      await this.finish(client, captured, row, operation); return view(row, operation);
    });
    return { ...result, draft: validateWalletPaymentReviewDraft(result.draft) };
  }
  async getForApp(inputActor: RestActor, inputId: string): Promise<WalletPaymentReviewAppView> {
    const actor = actorOf(inputActor), hint = await this.hint(inputId); actorMatches(actor, hint.draft);
    const captured = await this.capture(actor, hint.operation_id), draft = this.assertHint(hint, captured);
    return this.transaction(async client => {
      await this.guard(client, captured, draft, hint.session_id);
      const { operation } = await this.lockExecution(client, captured), row = await this.lockReview(client, hint);
      await this.finish(client, captured, row, operation);
      return { ...view(row, operation), approval: row.status === "approved" ? { signature: row.signature!, signedCommitment: row.signed_commitment! } : null };
    });
  }
  async getForSession(inputId: string, inputSessionId: string): Promise<WalletPaymentReviewView> {
    const sessionId = uuid(inputSessionId), hint = await this.hint(inputId), captured = await this.capture(this.rowActor(hint), hint.operation_id);
    const draft = this.assertHint(hint, captured);
    return this.transaction(async client => {
      await this.guard(client, captured, draft, sessionId);
      const { operation } = await this.lockExecution(client, captured), row = await this.lockReview(client, hint);
      await this.finish(client, captured, row, operation, sessionId); return view(row, operation);
    });
  }
  async approve(inputId: string, inputSessionId: string, assertion: WalletAssertion): Promise<{ view: WalletPaymentReviewView; replayed: boolean }> {
    const id = uuid(inputId), sessionId = uuid(inputSessionId), ownedAssertion = copyWalletPaymentReviewAssertion(assertion);
    const hint = await this.hint(id);
    const captured = await this.capture(this.rowActor(hint), hint.operation_id), draft = this.assertHint(hint, captured);
    // Local WebAuthn/P256/ABI verification is complete before transactional lock acquisition. The
    // session names the approving passkey: the primary, or one of the account's devices.
    const proof = verifyWalletPaymentReviewProof(draft, ownedAssertion, await this.approver(captured, draft, sessionId));
    return this.transaction(async client => {
      await this.guard(client, captured, draft, sessionId);
      const { operation, plan } = await this.lockExecution(client, captured), row = await this.lockReview(client, hint);
      live(row, await walletCeremonyDatabaseNow(client));
      if (row.status === "cancelled") conflict();
      if (row.status === "approved") {
        if (row.session_id !== sessionId || row.proof_digest !== proof.proofDigest) conflict();
        await this.finish(client, captured, row, operation, sessionId); return { view: view(row, operation), replayed: true };
      }
      await this.unspent(client, operation, plan);
      const consumed = await this.ceremonies.consumeInTransaction(client, { ...draft.ceremony,
        proofDigest: proof.proofDigest, resultId: draft.operationId });
      if (consumed.replayed) conflict();
      const updated = (await client.query<ReviewRow>(`UPDATE rest_wallet_payment_reviews SET status='approved',session_id=$2,
        proof_digest=$3,signature=$4,signed_commitment=$5,approved_at_ms=${nowSql}
        WHERE id=$1 AND status='pending' AND expires_at_ms>${nowSql} RETURNING *`,
      [row.id, sessionId, proof.proofDigest, proof.signature, proof.signedCommitment])).rows[0];
      if (!updated) expired();
      await this.finish(client, captured, updated, operation, sessionId); return { view: view(updated, operation), replayed: false };
    });
  }
  async cancel(inputId: string, inputSessionId: string): Promise<WalletPaymentReviewView> {
    const sessionId = uuid(inputSessionId), hint = await this.hint(inputId), captured = await this.capture(this.rowActor(hint), hint.operation_id);
    const draft = this.assertHint(hint, captured);
    return this.transaction(async client => {
      await this.guard(client, captured, draft, sessionId);
      const { operation } = await this.lockExecution(client, captured), row = await this.lockReview(client, hint);
      live(row, await walletCeremonyDatabaseNow(client));
      if (row.status === "approved") conflict();
      const updated = row.status === "cancelled" ? row : (await client.query<ReviewRow>(`UPDATE rest_wallet_payment_reviews
        SET status='cancelled',cancelled_at_ms=${nowSql} WHERE id=$1 AND status='pending' AND expires_at_ms>${nowSql} RETURNING *`, [row.id])).rows[0];
      if (!updated) expired();
      await this.finish(client, captured, updated, operation, sessionId); return view(updated, operation);
    });
  }
  async cleanup(limit = 250): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) invalid();
    return this.transaction(async client => (await client.query(`WITH expired AS (SELECT id FROM rest_wallet_payment_reviews
      WHERE retain_until_ms<=${nowSql} ORDER BY retain_until_ms,id LIMIT $1 FOR UPDATE SKIP LOCKED)
      DELETE FROM rest_wallet_payment_reviews r USING expired e WHERE r.id=e.id`, [limit])).rowCount ?? 0);
  }
  private rowActor(row: ReviewRow): RestActor { return { accountId: row.account_id, principalId: row.principal_id }; }
  private async hint(inputId: string): Promise<ReviewRow> {
    const row = (await this.pool.query<ReviewRow>("SELECT * FROM rest_wallet_payment_reviews WHERE id=$1", [uuid(inputId)])).rows[0];
    if (!row) missing();
    row.draft = validateWalletPaymentReviewDraft(row.draft); live(row, await this.databaseNow()); return row;
  }
  private async databaseNow(): Promise<number> {
    const time = Number((await this.pool.query<{ now: string }>(`SELECT ${nowSql} AS now`)).rows[0]!.now);
    if (!Number.isSafeInteger(time) || time <= 0) inactive(); return time;
  }
  private async capture(actor: RestActor, operationId: string): Promise<Captured> {
    const principal = parseWalletAppPrincipalId(actor.principalId); if (!principal) inactive();
    const client = await this.pool.connect();
    let grant;
    try { grant = await getWalletAppGrantInTransaction(client, principal.id); } finally { client.release(); }
    if (!grant || walletAppPrincipalId(grant) !== actor.principalId || grant.accountId !== actor.accountId || grant.audience !== this.options.audience) inactive();
    const operation = (await this.pool.query<{ document: UserOperationRecord }>(`SELECT document FROM rest_user_operations
      WHERE id=$1 AND account_id=$2 AND principal_id=$3`, [operationId, actor.accountId, actor.principalId])).rows[0]?.document;
    if (!operation) missing();
    const plan = (await this.pool.query<{ document: StoredPlan }>(`SELECT document FROM rest_transaction_plans
      WHERE id=$1 AND account_id=$2 AND principal_id=$3`, [operation.planId, actor.accountId, actor.principalId])).rows[0]?.document;
    if (!plan) missing();
    const authority = await this.authority.loadContext(actor.accountId);
    const manifest = this.options.manifestFor(structuredClone(authority.binding));
    const context: WalletPaymentReviewContext = { issuer: this.options.issuer, token: this.options.token,
      directV6Terminal: this.options.directV6Terminal, grant, authority, plan, operation, manifest: structuredClone(manifest) };
    return { context, authority: authorityIdentity(authority), operation: operationIdentity(operation), plan: planIdentity(plan) };
  }
  private assertHint(row: ReviewRow, captured: Captured): WalletPaymentReviewDraft {
    const draft = validateWalletPaymentReviewDraft(row.draft);
    if (draft.id !== row.id || draft.operationId !== row.operation_id || draft.ceremony.id !== row.ceremony_id ||
      draft.createdAtMs !== Number(row.created_at_ms) || draft.expiresAtMs !== Number(row.expires_at_ms)) inactive();
    actorMatches(this.rowActor(row), draft);
    try { assertWalletPaymentReviewContext(draft, captured.context); } catch { return inactive(); }
    return draft;
  }
  /** The session's passkey and its own Safe owner; a device signs as its device signer. */
  private async approver(captured: Captured, draft: WalletPaymentReviewDraft, sessionId: string): Promise<WalletPaymentReviewApprover> {
    const row = (await this.pool.query<{ credential_id: string | null }>("SELECT credential_id FROM rest_wallet_logins WHERE session_id=$1 AND revoked_at_ms IS NULL", [sessionId])).rows[0];
    const passkey = row?.credential_id ? walletSessionCredential(captured.context.authority, row.credential_id) : null;
    if (!passkey) inactive();
    if (!("device" in passkey)) return { credential: draft.authority.credential, signer: draft.authority.signer };
    const { recovery: _recovery, device, ...credential } = passkey as WalletAuthorityDevice & { recovery?: unknown };
    return { credential, signer: device.signerAddress };
  }
  private async guard(client: PoolClient, captured: Captured, draft: WalletPaymentReviewDraft, sessionId: string | null): Promise<void> {
    if (sessionId) {
      const session = await assertWalletCentralSessionActiveInTransaction(client, sessionId), a = draft.authority;
      const passkey = walletSessionCredential(captured.context.authority, session.credentialId);
      if (session.accountId !== a.accountId || session.enrollmentId !== a.enrollmentId || !passkey ||
        session.rpId !== passkey.rpId || session.userHandle !== passkey.userHandle || session.authorityEpoch !== a.authorityEpoch ||
        session.sessionEpoch !== a.sessionEpoch || session.bindingId !== a.bindingId ||
        session.bindingAuthorizationDigest !== a.bindingAuthorizationDigest || session.authorityIdentityDigest !== a.authorityIdentityDigest) inactive();
    }
    const current = await loadWalletAuthorityContextInTransaction(client, draft.authority.accountId);
    if (authorityIdentity(current) !== captured.authority) inactive();
    await assertWalletAppGrantActiveInTransaction(client, draft.grant,
      { kind: "actor", principalId: walletAppPrincipalId(draft.grant), audience: this.options.audience });
    if (draft.expiresAtMs <= await walletCeremonyDatabaseNow(client)) expired();
  }
  private async lockExecution(client: PoolClient, captured: Captured): Promise<{ operation: UserOperationRecord; plan: StoredPlan }> {
    const expected = captured.context.operation, actor = expected.actor;
    const operation = (await client.query<{ document: UserOperationRecord }>(`SELECT document FROM rest_user_operations
      WHERE id=$1 AND account_id=$2 AND principal_id=$3 FOR UPDATE`, [expected.id, actor.accountId, actor.principalId])).rows[0]?.document;
    const plan = (await client.query<{ document: StoredPlan }>(`SELECT document FROM rest_transaction_plans
      WHERE id=$1 AND account_id=$2 AND principal_id=$3 FOR UPDATE`, [expected.planId, actor.accountId, actor.principalId])).rows[0]?.document;
    if (!operation || !plan || operationIdentity(operation) !== captured.operation || planIdentity(plan) !== captured.plan) conflict();
    return { operation, plan };
  }
  private async lockReview(client: PoolClient, hint: ReviewRow): Promise<ReviewRow> {
    const row = (await client.query<ReviewRow>("SELECT * FROM rest_wallet_payment_reviews WHERE id=$1 FOR UPDATE", [hint.id])).rows[0];
    if (!row || row.account_id !== hint.account_id || row.principal_id !== hint.principal_id || row.input_digest !== hint.input_digest ||
      stable(row.draft) !== stable(hint.draft)) conflict();
    return row;
  }
  private async unspent(client: PoolClient, operation: UserOperationRecord, plan: StoredPlan): Promise<void> {
    if (operation.state !== "prepared" || operation.submission) conflict();
    try { assertPlan(operation, plan, await walletCeremonyDatabaseNow(client)); } catch { return conflict(); }
    const selected = new Set(operation.stepIndexes);
    if ((await getPostgresTransports(client, plan.id)).some(row => selected.has(row.stepIndex))) conflict();
    const nonce = await client.query(`SELECT user_operation_id FROM rest_user_operation_nonces WHERE chain_id=$1 AND sender=$2 AND nonce=$3`,
      [operation.chainId, operation.sender, operation.operation.nonce]);
    if (nonce.rows.length) conflict();
  }
  private async finish(client: PoolClient, captured: Captured, row: ReviewRow, operation: UserOperationRecord, sessionId: string | null = null): Promise<void> {
    if (row.status === "approved") {
      if (!row.session_id || !row.signature || !row.signed_commitment || !row.proof_digest) inactive();
      if (operation.submission && (operation.submission.commitment !== row.signed_commitment ||
        stable(operation.submission.operation) !== stable({ ...row.draft.operation, signature: row.signature }))) conflict();
      await this.guard(client, captured, row.draft, row.session_id);
    }
    await this.guard(client, captured, row.draft, sessionId);
    live(row, await walletCeremonyDatabaseNow(client));
  }
  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN"); await client.query("SET LOCAL lock_timeout='5000ms'");
      await client.query("SET LOCAL statement_timeout='10000ms'"); await client.query("SET LOCAL idle_in_transaction_session_timeout='15000ms'");
      const result = await run(client); await client.query("COMMIT"); return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if (error && typeof error === "object" && "code" in error && ["23505", "22003"].includes(String(error.code))) conflict();
      throw error;
    } finally { client.release(); }
  }
}
