import type { Pool, PoolClient } from "pg";
import { passkeyBindingMethods } from "../smartAccounts/passkeyOnboarding.js";
import { RestError } from "../core.js";
import type { SmartAccountBinding } from "../smartAccounts/types.js";
import { stable } from "../smartAccounts/service.js";
import { walletAuthorityIdentityDigest, walletAuthorityMaximumAgeMs, type WalletAuthorityContext, type WalletAuthorityIdentity, type WalletAuthoritySnapshot } from "./authority.js";
import { PostgresWalletAuthorityStore } from "./authorityPostgres.js";
import { currentWalletCredentialInTransaction, lockWalletEnrollmentInTransaction } from "./enrollmentPostgres.js";
import { PostgresWalletCeremonyStore, lockWalletCeremonyAdmission, walletCeremonyDatabaseNow } from "./ceremoniesPostgres.js";
import { copyWalletLoginCompletion, createWalletLoginDraft, deriveWalletCentralSessionToken, validateWalletCentralSession,
  validateWalletLoginDraft, verifyWalletLoginProof, walletCentralSessionLifetimeMs, walletCentralSessionTokenHash,
  walletLoginChallenge, walletLoginFlowTokenHash, type WalletCentralSession, type WalletLoginChallenge,
  type WalletLoginCompletion, type WalletLoginDraft } from "./login.js";

interface LoginRow {
  id: string; session_id: string; ceremony_id: string; rp_id: string; flow_token_hash: string; draft: WalletLoginDraft;
  issued_at_ms: string; expires_at_ms: string; retain_until_ms: string; completed_at_ms: string | null;
  proof_digest: string | null; session_token_hash: string | null; account_id: string | null; enrollment_id: string | null;
  authority_identity: WalletAuthorityIdentity | null; session_document: WalletCentralSession | null;
  revoked_at_ms: string | null;
}
interface AuthorityRow {
  account_id: string; authority_epoch: string; session_epoch: string; snapshot: WalletAuthoritySnapshot | null;
  ready_until_ms: string | null; binding_id: string | null; binding_authorization_digest: string | null;
}
const nowSql = "floor(extract(epoch FROM clock_timestamp())*1000)::bigint";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function invalid(): never { throw new RestError(400, "WALLET_LOGIN_INVALID", "Wallet login fields or bounds are invalid."); }
function unauthorized(): never { throw new RestError(403, "WALLET_LOGIN_UNAUTHORIZED", "Wallet login proof does not match its trusted intent."); }
function inactive(): never { throw new RestError(403, "WALLET_LOGIN_INACTIVE", "Wallet central session or current authority is unavailable."); }
function expired(): never { throw new RestError(410, "WALLET_LOGIN_EXPIRED", "Wallet login expired; create a fresh challenge."); }
function conflict(): never { throw new RestError(409, "WALLET_LOGIN_CONFLICT", "Wallet login was completed with a different context."); }
function limit(): never { throw new RestError(429, "WALLET_LOGIN_LIMIT", "Wallet login storage admission limit reached."); }

async function lockedContext(client: PoolClient, accountId: string, enrollmentId: string) {
  const account = (await client.query<{ owner_address: string; authority_chain_id: string }>(
    "SELECT owner_address,authority_chain_id FROM rest_accounts WHERE id=$1 FOR UPDATE", [accountId])).rows[0];
  if (!account || String(account.authority_chain_id) !== "8453" || `eip155:8453:${account.owner_address.toLowerCase()}` !== accountId) inactive();
  const enrollment = await lockWalletEnrollmentInTransaction(client, enrollmentId);
  const authority = (await client.query<AuthorityRow>("SELECT * FROM rest_wallet_authority WHERE account_id=$1 FOR UPDATE", [accountId])).rows[0];
  const credential = await currentWalletCredentialInTransaction(client, enrollment);
  const binding = (await client.query<{ id: string; document: SmartAccountBinding; authorization_digest: string }>(
    `SELECT id,document,authorization_digest FROM rest_smart_account_bindings
      WHERE account_id=$1 AND chain_id=8453 AND wallet_address=$2 AND revoked_at IS NULL`,
    [accountId, accountId.slice("eip155:8453:".length)])).rows[0];
  if (!credential || credential.account_id !== accountId || !binding ||
      !passkeyBindingMethods.includes(binding.document.authorization.method as typeof passkeyBindingMethods[number]) ||
      binding.document.authorization.digest !== binding.authorization_digest || binding.document.id !== binding.id) inactive();
  return { accountId, enrollment, authority, credential, binding };
}
type LockedContext = Awaited<ReturnType<typeof lockedContext>>;
function sameCaptured(locked: LockedContext, expected: WalletAuthorityContext): void {
  const c = locked.credential;
  if (stable(locked.enrollment) !== stable(expected.enrollment) || stable(locked.binding.document) !== stable(expected.binding) ||
      c.account_id !== expected.credential.accountId || c.enrollment_id !== expected.credential.enrollmentId ||
      c.rp_id !== expected.credential.rpId || c.credential_id !== expected.credential.credentialId || c.user_handle !== expected.credential.userHandle ||
      c.public_key_x !== expected.credential.publicKey.x || c.public_key_y !== expected.credential.publicKey.y ||
      c.backup_eligible !== expected.credential.backupEligible || Number(c.verified_at) !== expected.credential.verifiedAtMs ||
      stable(c.recovery_receipt ?? null) !== stable(expected.credential.recovery ?? null) ||
      (locked.authority?.authority_epoch ?? null) !== (expected.prior?.authorityEpoch ?? null) ||
      (locked.authority?.session_epoch ?? null) !== (expected.prior?.sessionEpoch ?? null)) inactive();
}
function ready(context: LockedContext, now: number): void {
  const a = context.authority, snapshot = a?.snapshot;
  if (!a || !snapshot || snapshot.readiness !== "verified" || snapshot.bootstrapRequired || snapshot.activeFence !== null ||
      !snapshot.identity || !snapshot.latestObservation || snapshot.latestObservation.observedAtMs > now ||
      a.ready_until_ms === null || Number(a.ready_until_ms) <= now || Number(a.ready_until_ms) > snapshot.latestObservation.observedAtMs + walletAuthorityMaximumAgeMs ||
      snapshot.identity.bindingId !== context.binding.id || a.binding_id !== context.binding.id ||
      snapshot.identity.bindingAuthorizationDigest !== context.binding.authorization_digest ||
      a.binding_authorization_digest !== context.binding.authorization_digest) inactive();
}
function active(row: LoginRow, context: LockedContext, now: number, requireReady: boolean): WalletCentralSession {
  if (!row.session_document || !row.completed_at_ms || row.revoked_at_ms !== null) inactive();
  const session = validateWalletCentralSession(row.session_document), a = context.authority;
  if (!a || !a.snapshot || a.snapshot.bootstrapRequired || a.snapshot.activeFence !== null ||
      session.id !== row.session_id || session.accountId !== context.accountId || session.enrollmentId !== context.enrollment.intent.id ||
      session.credentialId !== context.credential.credential_id || session.userHandle !== context.credential.user_handle || session.rpId !== context.credential.rp_id ||
      session.authorityEpoch !== a.authority_epoch || session.sessionEpoch !== a.session_epoch || session.createdAtMs > now || session.expiresAtMs <= now ||
      session.revokedAtMs !== null || session.bindingId !== context.binding.id || session.bindingAuthorizationDigest !== context.binding.authorization_digest ||
      !row.authority_identity || stable(row.authority_identity) !== stable(a.snapshot.identity)) inactive();
  if (requireReady) ready(context, now);
  return session;
}
async function lockSession(client: PoolClient, sessionId: string, requireReady: boolean) {
  if (typeof sessionId !== "string" || !uuid.test(sessionId)) invalid();
  const hint = (await client.query<LoginRow>("SELECT * FROM rest_wallet_logins WHERE session_id=$1", [sessionId])).rows[0];
  if (!hint?.account_id || !hint.enrollment_id) inactive();
  const context = await lockedContext(client, hint.account_id, hint.enrollment_id);
  const row = (await client.query<LoginRow>("SELECT * FROM rest_wallet_logins WHERE session_id=$1 FOR UPDATE", [sessionId])).rows[0];
  if (!row) inactive();
  return { row, context, session: active(row, context, await walletCeremonyDatabaseNow(client), requireReady) };
}

/** Caller owns the transaction and has authenticated the cookie or server-held handoff context.
 * An untrusted session identifier alone is not authentication. Lock order is account → enrollment
 * → authority → credential → session/login row. Repeat after blocking writes before COMMIT.
 * No RPC, proof verification, new pool acquisition, grant issuance or spending authority. */
export async function assertWalletCentralSessionActiveInTransaction(client: PoolClient, sessionId: string): Promise<WalletCentralSession> {
  return (await lockSession(client, sessionId, true)).session;
}

/** Internal refresh identity only. Never use this weaker guard to issue a grant, exchange a code,
 * authenticate a public session response, or authorize spending. */
export async function assertWalletCentralSessionIdentityInTransaction(client: PoolClient, sessionId: string): Promise<WalletCentralSession> {
  return (await lockSession(client, sessionId, false)).session;
}

/** Internal service storage. The HTTP owner authenticates flow cookies and enforces CSRF/origin;
 * this service independently verifies each genuine discoverable assertion and every durable guard.
 * All replicas must use identical admission bounds. No cookie can act as an app/spending principal. */
export class PostgresWalletLoginStore {
  private readonly ceremonies: PostgresWalletCeremonyStore;
  private readonly authority: PostgresWalletAuthorityStore;
  private readonly options: { rpId: string; origin: string; maxRecords: number; maxAccountSessions: number; loginLifetimeMs: number };
  constructor(private readonly pool: Pool, options: { rpId: string; origin: string; maxRecords?: number; maxAccountSessions?: number; loginLifetimeMs?: number }) {
    this.options = { rpId: options.rpId, origin: options.origin, maxRecords: options.maxRecords ?? 100_000,
      maxAccountSessions: options.maxAccountSessions ?? 256, loginLifetimeMs: options.loginLifetimeMs ?? 180_000 };
    if (![this.options.maxRecords, this.options.maxAccountSessions].every(v => Number.isSafeInteger(v) && v >= 1 && v <= 1_000_000)) invalid();
    createWalletLoginDraft({ rpId: this.options.rpId, origin: this.options.origin, nowMs: 1_800_000_000_000, lifetimeMs: this.options.loginLifetimeMs });
    this.ceremonies = new PostgresWalletCeremonyStore(pool); this.authority = new PostgresWalletAuthorityStore(pool);
  }
  async begin(): Promise<{ login: WalletLoginChallenge; flowToken: string }> {
    return this.transaction(async client => {
      // Both bounds follow their actual tables, including mixed search-path layouts. Login
      // admission precedes ceremony admission; neither is acquired by a completion/guard.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('wallet-logins:' || 'rest_wallet_logins'::regclass::oid::text, 0))");
      await lockWalletCeremonyAdmission(client);
      await this.cleanupInTransaction(client, 100);
      const count = Number((await client.query("SELECT count(*)::text AS count FROM rest_wallet_logins")).rows[0].count);
      if (count >= this.options.maxRecords) limit();
      const { draft, flowToken } = createWalletLoginDraft({ rpId: this.options.rpId, origin: this.options.origin,
        nowMs: await walletCeremonyDatabaseNow(client), lifetimeMs: this.options.loginLifetimeMs });
      await this.ceremonies.issueInTransaction(client, draft.ceremony, null);
      await client.query(`INSERT INTO rest_wallet_logins(id,session_id,ceremony_id,rp_id,flow_token_hash,issued_at_ms,expires_at_ms,retain_until_ms,draft)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`, [draft.id, draft.sessionId, draft.ceremony.id, draft.rpId, draft.flowTokenHash,
        draft.issuedAtMs, draft.expiresAtMs, draft.retainUntilMs, JSON.stringify(draft)]);
      if (draft.expiresAtMs <= await walletCeremonyDatabaseNow(client)) expired();
      return { login: walletLoginChallenge(draft), flowToken };
    });
  }
  /** Internal proof-verified refresh identity only; this neither consumes nor creates a session. */
  async identifyCompletion(input: WalletLoginCompletion): Promise<{ accountId: string }> {
    const proof = await this.proof(input);
    return this.transaction(async client => {
      const locked = await lockedContext(client, proof.context.accountId, proof.context.enrollment.intent.id);
      sameCaptured(locked, proof.context);
      const row = await this.lockLogin(client, proof.draft.id);
      if (stable(row.draft) !== stable(proof.draft)) conflict();
      const now = await walletCeremonyDatabaseNow(client);
      if (row.completed_at_ms) {
        if (row.proof_digest !== proof.proof.verificationDigest) conflict();
        active(row, locked, now, false);
      } else if (proof.draft.expiresAtMs <= now) expired();
      return { accountId: proof.context.accountId };
    });
  }
  async complete(input: WalletLoginCompletion): Promise<{ session: WalletCentralSession; sessionToken: string; replayed: boolean }> {
    const proof = await this.proof(input), identity = proof.context.prior?.identity;
    if (!identity) inactive();
    const identityDigest = walletAuthorityIdentityDigest(identity);
    const sessionToken = deriveWalletCentralSessionToken(proof.input.flowToken, proof.draft.id);
    const sessionTokenHash = walletCentralSessionTokenHash(sessionToken);
    return this.transaction(async client => {
      const locked = await lockedContext(client, proof.context.accountId, proof.context.enrollment.intent.id);
      sameCaptured(locked, proof.context);
      const row = await this.lockLogin(client, proof.draft.id);
      if (stable(row.draft) !== stable(proof.draft)) conflict();
      if (row.completed_at_ms) {
        if (row.proof_digest !== proof.proof.verificationDigest || row.session_token_hash !== sessionTokenHash) conflict();
        return { session: active(row, locked, await walletCeremonyDatabaseNow(client), true), sessionToken, replayed: true };
      }
      const now = await walletCeremonyDatabaseNow(client);
      if (proof.draft.expiresAtMs <= now) expired();
      ready(locked, now);
      if (stable(locked.authority!.snapshot!.identity) !== stable(identity)) inactive();
      const count = Number((await client.query("SELECT count(*)::text AS count FROM rest_wallet_logins WHERE account_id=$1", [proof.context.accountId])).rows[0].count);
      if (count >= this.options.maxAccountSessions) limit();
      await this.ceremonies.consumeInTransaction(client, { ...proof.draft.ceremony,
        proofDigest: proof.proof.verificationDigest, resultId: proof.draft.sessionId });
      const createdAtMs = await walletCeremonyDatabaseNow(client);
      const session = validateWalletCentralSession({ id: proof.draft.sessionId, loginId: proof.draft.id,
        accountId: proof.context.accountId, enrollmentId: proof.context.enrollment.intent.id,
        rpId: proof.context.credential.rpId, credentialId: proof.context.credential.credentialId, userHandle: proof.context.credential.userHandle,
        authorityEpoch: locked.authority!.authority_epoch, sessionEpoch: locked.authority!.session_epoch,
        bindingId: identity.bindingId, bindingAuthorizationDigest: identity.bindingAuthorizationDigest, authorityIdentityDigest: identityDigest,
        createdAtMs, expiresAtMs: createdAtMs + walletCentralSessionLifetimeMs, revokedAtMs: null });
      const updated = (await client.query<LoginRow>(`UPDATE rest_wallet_logins SET completed_at_ms=$2,proof_digest=$3,proof=$4::jsonb,
        session_token_hash=$5,account_id=$6,enrollment_id=$7,credential_id=$8,user_handle=$9,authority_epoch=$10,session_epoch=$11,
        binding_id=$12,binding_authorization_digest=$13,authority_identity_digest=$14,authority_identity=$15::jsonb,
        session_expires_at_ms=$16,session_document=$17::jsonb WHERE id=$1 AND completed_at_ms IS NULL RETURNING *`,
      [proof.draft.id, session.createdAtMs, proof.proof.verificationDigest, JSON.stringify(proof.proof), sessionTokenHash,
        session.accountId, session.enrollmentId, session.credentialId, session.userHandle, session.authorityEpoch, session.sessionEpoch,
        session.bindingId, session.bindingAuthorizationDigest, session.authorityIdentityDigest, JSON.stringify(identity),
        session.expiresAtMs, JSON.stringify(session)])).rows[0];
      if (!updated) conflict();
      // The original ceremony and readiness deadlines include unique-index waits and all writes.
      // This is a last DB-clock check before COMMIT, not a claim of a zero-time commit interval.
      const finalNow = await walletCeremonyDatabaseNow(client);
      if (proof.draft.expiresAtMs <= finalNow) expired();
      active(updated, locked, finalNow, true);
      return { session, sessionToken, replayed: false };
    });
  }
  /** Internal refresh identity; requires live cookie/mapping/epochs/binding, omits readiness only. */
  async identifySession(token: string): Promise<{ accountId: string } | null> {
    const session = await this.session(token, false); return session ? { accountId: session.accountId } : null;
  }
  async readSession(token: string): Promise<WalletCentralSession | null> { return this.session(token, true); }
  /** The name given to the session's passkey at enrollment or recovery; display only, never authority. */
  async passkeyName(session: Pick<WalletCentralSession, "rpId" | "credentialId">): Promise<string | null> {
    const row = (await this.pool.query<{ passkey_name: string | null }>(
      "SELECT passkey_name FROM rest_wallet_credentials WHERE rp_id=$1 AND credential_id=$2 AND superseded_at IS NULL",
      [session.rpId, session.credentialId])).rows[0];
    return row?.passkey_name ?? null;
  }
  async logout(token: string): Promise<{ loggedOut: true; replayed: boolean }> {
    const hash = walletCentralSessionTokenHash(token);
    const hint = (await this.pool.query<LoginRow>("SELECT * FROM rest_wallet_logins WHERE session_token_hash=$1", [hash])).rows[0];
    if (!hint?.account_id || !hint.enrollment_id) inactive();
    return this.transaction(async client => {
      const context = await lockedContext(client, hint.account_id!, hint.enrollment_id!);
      const row = await this.lockLogin(client, hint.id);
      if (row.session_token_hash !== hash || row.draft.rpId !== this.options.rpId || row.draft.origin !== this.options.origin) inactive();
      // An exact completed logout only reports its original revocation; it never advances again.
      if (row.revoked_at_ms !== null) return { loggedOut: true, replayed: true };
      active(row, context, await walletCeremonyDatabaseNow(client), false);
      const a = context.authority!;
      if (BigInt(a.session_epoch) >= 9223372036854775807n) inactive();
      const updated = await client.query(`UPDATE rest_wallet_authority SET session_epoch=session_epoch+1,
        updated_at=GREATEST(updated_at,floor(extract(epoch FROM clock_timestamp()))::bigint)
        WHERE account_id=$1 AND authority_epoch=$2 AND session_epoch=$3`, [hint.account_id, a.authority_epoch, a.session_epoch]);
      if (updated.rowCount !== 1) inactive();
      const revokedAt = await walletCeremonyDatabaseNow(client);
      await client.query(`UPDATE rest_wallet_logins SET revoked_at_ms=$2,
        session_document=jsonb_set(session_document,'{revokedAtMs}',to_jsonb($2::bigint)) WHERE id=$1`, [hint.id, revokedAt]);
      // Logout also has a finite validity window: a wait cannot revive an expired old cookie.
      active(row, context, await walletCeremonyDatabaseNow(client), false);
      return { loggedOut: true, replayed: false };
    });
  }
  async cleanup(limitValue = 250): Promise<number> {
    if (!Number.isSafeInteger(limitValue) || limitValue < 1 || limitValue > 1000) invalid();
    return this.transaction(client => this.cleanupInTransaction(client, limitValue));
  }
  private async proof(raw: WalletLoginCompletion) {
    // Copy mutable request bytes before the first await. Cryptography and expensive W3/context
    // validation happen outside the completion transaction, followed by exact locked comparisons.
    const input = copyWalletLoginCompletion(raw);
    const row = (await this.pool.query<LoginRow>("SELECT * FROM rest_wallet_logins WHERE id=$1", [input.loginId])).rows[0];
    if (!row || row.flow_token_hash !== walletLoginFlowTokenHash(input.flowToken)) unauthorized();
    const draft = validateWalletLoginDraft(row.draft);
    if (draft.rpId !== this.options.rpId || draft.origin !== this.options.origin) unauthorized();
    const mapping = (await this.pool.query<{ account_id: string; enrollment_id: string }>(
      "SELECT account_id,enrollment_id FROM rest_wallet_credentials WHERE rp_id=$1 AND credential_id=$2 AND superseded_at IS NULL",
      [draft.rpId, input.assertion.credentialId])).rows[0];
    if (!mapping) unauthorized();
    const context = await this.authority.loadContext(mapping.account_id);
    if (context.credential.credentialId !== input.assertion.credentialId || context.enrollment.intent.id !== mapping.enrollment_id) unauthorized();
    // The full context above validates immutable lineage; the possession verifier needs
    // only the current key. Keep the existing proof format and compare lineage under locks.
    const { recovery: _recovery, ...proofCredential } = context.credential;
    return { input, draft, context, proof: verifyWalletLoginProof(draft, input.flowToken, proofCredential, input.assertion) };
  }
  private async lockLogin(client: PoolClient, id: string): Promise<LoginRow> {
    const row = (await client.query<LoginRow>("SELECT * FROM rest_wallet_logins WHERE id=$1 FOR UPDATE", [id])).rows[0];
    if (!row) unauthorized(); return row;
  }
  private async session(token: string, requireReady: boolean): Promise<WalletCentralSession | null> {
    let hash: string;
    try { hash = walletCentralSessionTokenHash(token); } catch { return null; }
    const hint = (await this.pool.query<{ session_id: string }>("SELECT session_id FROM rest_wallet_logins WHERE session_token_hash=$1", [hash])).rows[0];
    if (!hint) return null;
    try {
      return await this.transaction(async client => {
        const locked = await lockSession(client, hint.session_id, requireReady);
        if (locked.row.session_token_hash !== hash || locked.row.draft.rpId !== this.options.rpId || locked.row.draft.origin !== this.options.origin) inactive();
        return locked.session;
      });
    } catch (error) { if (error instanceof RestError && [400, 403, 404, 410].includes(error.status)) return null; throw error; }
  }
  private async cleanupInTransaction(client: PoolClient, count: number): Promise<number> {
    const result = await client.query(`DELETE FROM rest_wallet_logins WHERE id IN (SELECT id FROM rest_wallet_logins
      WHERE retain_until_ms<=${nowSql} OR (completed_at_ms IS NULL AND expires_at_ms<=${nowSql}) ORDER BY expires_at_ms,id LIMIT $1 FOR UPDATE SKIP LOCKED)`, [count]);
    return result.rowCount ?? 0;
  }
  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN"); await client.query("SET LOCAL lock_timeout='5000ms'");
      await client.query("SET LOCAL statement_timeout='10000ms'"); await client.query("SET LOCAL idle_in_transaction_session_timeout='15000ms'");
      const result = await run(client); await client.query("COMMIT"); return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof RestError && error.code === "WALLET_CEREMONY_EXPIRED") expired();
      if (error && typeof error === "object" && "code" in error && ["23505", "22003"].includes(String(error.code))) conflict();
      throw error;
    } finally { client.release(); }
  }
}
