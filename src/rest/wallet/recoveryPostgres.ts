import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { RestError } from '../core.js';
import { validateAudience } from '../auth/signatures.js';
import { stable } from '../smartAccounts/service.js';
import { validateWalletAuthorityContext, validateWalletAuthorityObservation, type WalletAuthorityContext, type WalletAuthorityObservation } from './authority.js';
import { loadWalletAuthorityContextInTransaction, PostgresWalletAuthorityStore } from './authorityPostgres.js';
import { enrollmentDigest } from './enrollment.js';
import { copyWalletEnrollmentProof, copyWalletEnrollmentRegistration } from './enrollmentPostgres.js';
import { lockWalletCeremonyAdmission, PostgresWalletCeremonyStore, walletCeremonyDatabaseNow } from './ceremoniesPostgres.js';
import { createWalletRecoveryIntent, createWalletRecoveryMapping, prepareWalletRecoveryCandidate, verifyWalletRecoveryProof,
  type WalletRecoveryIntent, type WalletRecoveryCandidate, type WalletRecoveryProof } from './recovery.js';
import type { WalletRegistrationResponse } from './registration.js';
import { validateWalletRpConfiguration, verifyWalletAssertion, type WalletAssertion } from './webauthn.js';
import { copyWalletSignupAssertion } from './signupPostgres.js';
import { passkeyOnboardingSigningPayload } from '../smartAccounts/passkeyOnboarding.js';
import type { WalletCredentialRecovery } from './credentialRecovery.js';
import { assertRecoveryContinuationInTransaction } from './recoveryFlowPostgres.js';

export interface WalletRecoveryRecord {
  intent: WalletRecoveryIntent; candidate: WalletRecoveryCandidate | null; proof: WalletRecoveryProof | null;
  activation: WalletCredentialRecovery | null;
}
interface Row { id: string; token_hash: string; intent: WalletRecoveryIntent; candidate: WalletRecoveryCandidate | null; proof: WalletRecoveryProof | null; activation?: WalletCredentialRecovery | null }
const sqlNow = 'floor(extract(epoch FROM clock_timestamp())*1000)::bigint';
const recordOf = (row: Row): WalletRecoveryRecord => ({ intent: row.intent, candidate: row.candidate, proof: row.proof, activation: row.activation ?? null });
const hashToken = (value: string) => createHash('sha256').update('center-wallet-recovery-flow-v1:' + value).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const token = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
  && Buffer.from(value, 'base64url').toString('base64url') === value;
function invalid(): never { throw new RestError(400, 'WALLET_RECOVERY_INVALID', 'Recovery fields or storage bounds are invalid.'); }
function unauthorized(): never { throw new RestError(403, 'WALLET_RECOVERY_UNAUTHORIZED', 'A matching recovery continuation and proof are required.'); }
function conflict(): never { throw new RestError(409, 'WALLET_RECOVERY_CONFLICT', 'Recovery or the current wallet identity changed.'); }
function expired(): never { throw new RestError(410, 'WALLET_RECOVERY_EXPIRED', 'Prepare a fresh recovery proof. The previous deadline cannot be extended.'); }
const captured = (context: WalletAuthorityContext) => stable({ enrollment: context.enrollment, credential: context.credential, binding: context.binding });
type ActivationObserver = { audience: string; observe(context: WalletAuthorityContext): Promise<WalletAuthorityObservation> };

/** Trusted durable recovery workflow. HTTP must supply origin/CSRF/cookie boundaries.
 * Proof intake creates no authority. Activation requires a configured canonical observer
 * and fresh replacement-key setup proof; it submits no transaction and creates no session. */
export class PostgresWalletRecoveryStore {
  private readonly policy: { rpId: string; origin: string; lifetimeMs: number; maxRecords: number; maxAccountRecords: number };
  private readonly authority: PostgresWalletAuthorityStore;
  private readonly ceremonies: PostgresWalletCeremonyStore;
  private readonly activationObserver?: ActivationObserver;
  constructor(private readonly pool: Pool, options: { rpId: string; origin: string; lifetimeMs?: number; maxRecords?: number; maxAccountRecords?: number },
    activationObserver?: ActivationObserver) {
    enrollmentDigest(options);
    if (Object.keys(options).some(key => !['rpId', 'origin', 'lifetimeMs', 'maxRecords', 'maxAccountRecords'].includes(key))) invalid();
    this.policy = { lifetimeMs: 300000, maxRecords: 100000, maxAccountRecords: 256, ...structuredClone(options) };
    validateWalletRpConfiguration(this.policy);
    for (const [value, maximum] of [[this.policy.lifetimeMs, 300000], [this.policy.maxRecords, 1000000], [this.policy.maxAccountRecords, 10000]] as const)
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) invalid();
    if (activationObserver) {
      if (typeof activationObserver.observe !== 'function') invalid();
      this.activationObserver = { audience: validateAudience(activationObserver.audience), observe: activationObserver.observe.bind(activationObserver) };
    }
    this.authority = new PostgresWalletAuthorityStore(pool); this.ceremonies = new PostgresWalletCeremonyStore(pool);
  }
  async begin(accountId: string): Promise<{ record: WalletRecoveryRecord; flowToken: string }> {
    const context = await this.authority.loadContext(accountId), expected = captured(context);
    if (context.credential.rpId !== this.policy.rpId || context.enrollment.intent.origin !== this.policy.origin) invalid();
    const now = await this.now(), intent = createWalletRecoveryIntent(context, { rpId: this.policy.rpId, origin: this.policy.origin,
      nowMs: now, expiresAtMs: now + this.policy.lifetimeMs });
    const flowToken = randomBytes(32).toString('base64url');
    return this.transaction(async client => {
      // Global admission precedes account → enrollment → authority → credential → recovery → ceremony.
      await lockWalletCeremonyAdmission(client);
      await client.query(`DELETE FROM rest_wallet_recoveries WHERE id IN
        (SELECT id FROM rest_wallet_recoveries WHERE proof IS NULL AND retain_until_ms<=${sqlNow}
          ORDER BY retain_until_ms,id LIMIT 100 FOR UPDATE SKIP LOCKED)`);
      const counts = (await client.query<{ total: number; account: number }>(
        'SELECT count(*)::int AS total,count(*) FILTER (WHERE account_id=$1)::int AS account FROM rest_wallet_recoveries', [accountId])).rows[0]!;
      if (counts.total >= this.policy.maxRecords || counts.account >= this.policy.maxAccountRecords)
        throw new RestError(429, 'WALLET_RECOVERY_LIMIT', 'Recovery storage admission limit reached.');
      if (captured(await loadWalletAuthorityContextInTransaction(client, accountId)) !== expected) conflict();
      await this.live(client, intent);
      await this.ceremonies.issueInTransaction(client, intent.registration, null);
      const row = (await client.query<Row>(`INSERT INTO rest_wallet_recoveries(id,account_id,enrollment_id,token_hash,created_at_ms,
        expires_at_ms,retain_until_ms,intent) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [intent.id, accountId, intent.enrollmentId, hashToken(flowToken), intent.issuedAtMs, intent.expiresAtMs, intent.expiresAtMs + 86400000, intent])).rows[0]!;
      await this.live(client, intent); return { record: recordOf(row), flowToken };
    });
  }
  async get(id: string, flowToken: string): Promise<WalletRecoveryRecord | null> {
    if (typeof id !== 'string' || !uuid.test(id) || !token(flowToken)) return null;
    const row = (await this.pool.query<Row>(`SELECT r.* FROM rest_wallet_recoveries r LEFT JOIN rest_wallet_recovery_flows f ON f.id=r.id
      WHERE r.id=$1 AND ((f.id IS NULL AND r.token_hash=$2) OR (f.token_hash=$2 AND f.expires_at_ms>${sqlNow}))`, [id, hashToken(flowToken)])).rows[0];
    return row ? recordOf(row) : null;
  }
  async getByToken(flowToken: string): Promise<WalletRecoveryRecord | null> {
    if (!token(flowToken)) return null;
    const row = (await this.pool.query<Row>(`SELECT r.* FROM rest_wallet_recoveries r LEFT JOIN rest_wallet_recovery_flows f ON f.id=r.id
      WHERE (f.id IS NULL AND r.token_hash=$1) OR (f.token_hash=$1 AND f.expires_at_ms>${sqlNow})`, [hashToken(flowToken)])).rows[0];
    return row ? recordOf(row) : null;
  }
  async isCurrentActivation(id: string, flowToken: string): Promise<boolean> {
    const before = await this.required(id, flowToken);
    if (!before.activation) return false;
    const current = await this.authority.loadContext(before.intent.accountId);
    return stable(current.credential.recovery) === stable(before.activation);
  }
  async register(id: string, flowToken: string, input: WalletRegistrationResponse): Promise<WalletRecoveryRecord> {
    const response = copyWalletEnrollmentRegistration(input), before = await this.required(id, flowToken);
    const candidate = prepareWalletRecoveryCandidate(before.intent, response), expected = await this.current(before.intent);
    return this.transaction(async client => {
      await lockWalletCeremonyAdmission(client);
      if (captured(await loadWalletAuthorityContextInTransaction(client, before.intent.accountId)) !== expected) conflict();
      const row = await this.lock(client, id, flowToken);
      if (stable(row.intent) !== stable(before.intent)) conflict();
      if (row.candidate) {
        if (stable(row.candidate.credential) !== stable(candidate.credential)) conflict();
        return recordOf(row);
      }
      await this.live(client, row.intent);
      await this.ceremonies.issueInTransaction(client, candidate.possession, null);
      const updated = (await client.query<Row>('UPDATE rest_wallet_recoveries SET candidate=$2 WHERE id=$1 RETURNING *', [id, candidate])).rows[0]!;
      await this.live(client, row.intent); return recordOf(updated);
    });
  }
  async prove(id: string, flowToken: string, input: Parameters<typeof verifyWalletRecoveryProof>[1]): Promise<{ record: WalletRecoveryRecord; replayed: boolean }> {
    const inputProof = copyWalletEnrollmentProof(input), before = await this.required(id, flowToken);
    if (!before.candidate) conflict();
    // A retained receipt retry verifies the same original challenge at its original accepted
    // time. It can only read that receipt; it never renews the proof or authorizes an effect.
    const proof = await verifyWalletRecoveryProof(before.candidate, inputProof, before.proof?.verifiedAtMs ?? await this.now());
    const expected = await this.current(before.intent);
    return this.transaction(async client => {
      if (captured(await loadWalletAuthorityContextInTransaction(client, before.intent.accountId)) !== expected) conflict();
      const row = await this.lock(client, id, flowToken);
      if (stable(row.intent) !== stable(before.intent) || stable(row.candidate) !== stable(before.candidate)) conflict();
      if (row.proof) {
        if (row.proof.verificationDigest !== proof.verificationDigest) conflict();
        return { record: recordOf(row), replayed: true };
      }
      await this.live(client, row.intent);
      await this.ceremonies.consumeInTransaction(client, { ...row.candidate!.possession, proofDigest: proof.verificationDigest, resultId: id });
      const accepted = { ...proof, verifiedAtMs: await this.live(client, row.intent) };
      const updated = (await client.query<Row>('UPDATE rest_wallet_recoveries SET proof=$2 WHERE id=$1 RETURNING *', [id, accepted])).rows[0]!;
      await this.live(client, row.intent); return { record: recordOf(updated), replayed: false };
    });
  }
  /** Internal capability boundary. The configured producer must verify complete canonical
   * history and the replacement setup anchor. HTTP must never supply an observation. */
  async activate(id: string, flowToken: string, input: WalletAssertion): Promise<{ receipt: WalletCredentialRecovery; replayed: boolean }> {
    if (!this.activationObserver) throw new RestError(503, 'WALLET_RECOVERY_UNAVAILABLE', 'Canonical recovery activation is not configured.');
    const assertion = copyWalletSignupAssertion(input), before = await this.required(id, flowToken);
    if (before.activation) return this.transaction(async client => {
      const current = await loadWalletAuthorityContextInTransaction(client, before.intent.accountId), row = await this.lock(client, id, flowToken);
      if (!row.activation || stable(row.activation) !== stable(before.activation) || stable(current.credential.recovery) !== stable(row.activation)) conflict();
      return { receipt: row.activation, replayed: true };
    });
    const raw = await this.transaction(client => loadWalletAuthorityContextInTransaction(client, before.intent.accountId));
    const prepared = createWalletRecoveryMapping(before, raw, await this.now(), this.activationObserver.audience), expected = stable(raw);
    verifyWalletAssertion(assertion, { purpose: 'session', challenge: passkeyOnboardingSigningPayload(prepared.setupDocument).digest,
      rpId: prepared.receipt.rpId, origin: prepared.receipt.origin, requireUserHandle: true,
      credential: { id: prepared.context.credential.credentialId, userHandle: prepared.context.credential.userHandle,
        publicKey: prepared.context.credential.publicKey, backupEligible: prepared.context.credential.backupEligible } });
    const observation = validateWalletAuthorityObservation(await this.activationObserver.observe(prepared.context), prepared.context);
    const fresh = (now: number) => {
      const head = observation.head, anchor = prepared.receipt.anchor;
      if (observation.eligibility !== 'matched' || !head || !observation.identity || observation.identity.stateHash !== prepared.context.binding.state.stateHash
        || observation.validUntilMs === null || BigInt(head.blockNumber) < BigInt(anchor.blockNumber)
        || (head.blockNumber === anchor.blockNumber && stable(head) !== stable(anchor)))
        throw new RestError(403, 'WALLET_RECOVERY_CANONICAL_REQUIRED', 'Complete canonical replacement-owner evidence is required.');
      if (now < observation.observedAtMs || now >= observation.validUntilMs || now >= prepared.context.binding.authorization.expiresAt * 1000
        || BigInt(now) >= BigInt(head.timestamp) * 1000n + 300000n)
        throw new RestError(410, 'WALLET_RECOVERY_OBSERVATION_EXPIRED', 'Refresh the original replacement setup and canonical observation.');
    };
    fresh(await this.now());
    return this.transaction(async client => {
      const current = await loadWalletAuthorityContextInTransaction(client, before.intent.accountId), row = await this.lock(client, id, flowToken);
      if (stable(row.candidate) !== stable(before.candidate) || stable(row.proof) !== stable(before.proof)) conflict();
      if (row.activation) {
        if (stable(current.credential.recovery) !== stable(row.activation)) conflict();
        return { receipt: row.activation, replayed: true };
      }
      if (stable(current) !== expected) conflict();
      const now = await walletCeremonyDatabaseNow(client), seconds = Math.floor(now / 1000), setup = prepared.context.binding.authorization.setup!;
      fresh(now);
      const grant = (await client.query<{ account_id: string; bot_address: string; scopes: string[]; expires_at: string; revoked_at: string | null }>(
        'SELECT account_id,bot_address,scopes,expires_at,revoked_at FROM rest_bot_grants WHERE id=$1 FOR UPDATE', [setup.grantId])).rows[0];
      if (!grant || grant.account_id !== current.accountId || grant.bot_address !== setup.botAddress.toLowerCase()
        || stable(grant.scopes) !== stable(setup.scopes) || Number(grant.expires_at) !== setup.grantExpiresAt
        || Number(grant.expires_at) <= seconds || grant.revoked_at !== null) conflict();
      // One account-locked commit switches identity and fences every old authority generation.
      const superseded = await client.query(`UPDATE rest_wallet_credentials SET superseded_at=$3
        WHERE rp_id=$1 AND credential_id=$2 AND superseded_at IS NULL`, [current.credential.rpId, current.credential.credentialId, now]);
      if (superseded.rowCount !== 1) conflict();
      const next = prepared.context.credential;
      await client.query(`INSERT INTO rest_wallet_credentials(rp_id,credential_id,enrollment_id,account_id,user_handle,
        public_key_x,public_key_y,backup_eligible,verified_at,recovery_receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [next.rpId, next.credentialId, next.enrollmentId, next.accountId, next.userHandle, next.publicKey.x, next.publicKey.y,
        next.backupEligible, next.verifiedAtMs, prepared.receipt]);
      await client.query('UPDATE rest_bot_grants SET revoked_at=GREATEST(created_at,$3) WHERE account_id=$1 AND id<>$2 AND revoked_at IS NULL',
        [next.accountId, setup.grantId, seconds]);
      await client.query('UPDATE rest_wallet_app_grants SET revoked_at=GREATEST(created_at,$2) WHERE account_id=$1 AND revoked_at IS NULL', [next.accountId, seconds]);
      if (current.prior) {
        const fenced = await client.query(`UPDATE rest_wallet_authority SET authority_epoch=authority_epoch+1,session_epoch=session_epoch+1,
          updated_at=GREATEST(updated_at,$2) WHERE account_id=$1 AND authority_epoch=$3 AND session_epoch=$4 AND revision=$5`,
        [next.accountId, seconds, current.prior.authorityEpoch, current.prior.sessionEpoch, current.prior.revision]);
        if (fenced.rowCount !== 1) conflict();
      } else await client.query('INSERT INTO rest_wallet_authority(account_id,authority_epoch,session_epoch,updated_at) VALUES($1,1,1,$2)', [next.accountId, seconds]);
      await client.query('UPDATE rest_wallet_recoveries SET activation=$2 WHERE id=$1', [id, prepared.receipt]);
      fresh(await walletCeremonyDatabaseNow(client));
      return { receipt: prepared.receipt, replayed: false };
    });
  }
  private async current(intent: WalletRecoveryIntent): Promise<string> {
    const context = validateWalletAuthorityContext(await this.authority.loadContext(intent.accountId));
    if (enrollmentDigest(context.enrollment) !== intent.enrollmentDigest || enrollmentDigest(context.credential) !== intent.priorCredentialDigest
      || context.binding.authorization.digest !== intent.priorBindingDigest || context.credential.rpId !== intent.rpId
      || context.enrollment.intent.origin !== intent.origin) conflict();
    return captured(context);
  }
  private async now() { return Number((await this.pool.query(`SELECT ${sqlNow} AS now`)).rows[0].now); }
  private async required(id: string, flowToken: string) { const row = await this.get(id, flowToken); return row ?? unauthorized(); }
  private async lock(client: PoolClient, id: string, flowToken: string): Promise<Row> {
    const row = (await client.query<Row>('SELECT * FROM rest_wallet_recoveries WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!row) unauthorized();
    await assertRecoveryContinuationInTransaction(client, row, flowToken);
    return row;
  }
  private async live(client: PoolClient, intent: WalletRecoveryIntent) {
    const now = await walletCeremonyDatabaseNow(client); if (now < intent.issuedAtMs || now >= intent.expiresAtMs) expired(); return now;
  }
  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN'); await client.query("SET LOCAL lock_timeout='5000ms'");
      await client.query("SET LOCAL statement_timeout='10000ms'"); await client.query("SET LOCAL idle_in_transaction_session_timeout='15000ms'");
      const result = await run(client); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
}
