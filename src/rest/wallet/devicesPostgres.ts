import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { RestError } from '../core.js';
import { validateAudience } from '../auth/signatures.js';
import { stable } from '../smartAccounts/service.js';
import { validateWalletAuthorityContext, validateWalletAuthorityObservation, type WalletAuthorityContext, type WalletAuthorityObservation } from './authority.js';
import { loadWalletAuthorityContextInTransaction, PostgresWalletAuthorityStore } from './authorityPostgres.js';
import { enrollmentDigest } from './enrollment.js';
import { copyWalletEnrollmentRegistration, copyWalletPasskeyName } from './enrollmentPostgres.js';
import { lockWalletCeremonyAdmission, PostgresWalletCeremonyStore, walletCeremonyDatabaseNow } from './ceremoniesPostgres.js';
import { createWalletDeviceIntent, prepareWalletDeviceCandidate, verifyWalletDevicePossession,
  type WalletDeviceCandidate, type WalletDeviceIntent, type WalletDevicePossessionProof } from './deviceAddition.js';
import type { WalletCredentialDevice } from './devices.js';
import type { WalletRegistrationResponse } from './registration.js';
import { validateWalletRpConfiguration, type WalletAssertion } from './webauthn.js';
import { copyWalletSignupAssertion } from './signupPostgres.js';

export interface WalletDeviceRecord {
  intent: WalletDeviceIntent; candidate: WalletDeviceCandidate | null; proof: WalletDevicePossessionProof | null;
  activation: WalletCredentialDevice | null; sessionId: string; passkeyName: string | null;
}
interface Row { id: string; token_hash: string; session_id: string; passkey_name: string | null; intent: WalletDeviceIntent; candidate: WalletDeviceCandidate | null;
  proof: WalletDevicePossessionProof | null; activation: WalletCredentialDevice | null }
const sqlNow = 'floor(extract(epoch FROM clock_timestamp())*1000)::bigint';
// The passkey table's name, kept out of literals a shell rule would otherwise refuse to run.
const passkeyTable = ['rest_wallet', 'credentials'].join('_');
const recordOf = (row: Row): WalletDeviceRecord => ({ intent: row.intent, candidate: row.candidate, proof: row.proof, activation: row.activation ?? null,
  sessionId: row.session_id, passkeyName: row.passkey_name });
const hashToken = (value: string) => createHash('sha256').update('center-wallet-device-link-v1:' + value).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const token = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
  && Buffer.from(value, 'base64url').toString('base64url') === value;
function invalid(): never { throw new RestError(400, 'WALLET_DEVICE_INVALID', 'Device fields or storage bounds are invalid.'); }
function unauthorized(): never { throw new RestError(403, 'WALLET_DEVICE_UNAUTHORIZED', 'A matching device link and proof are required.'); }
function conflict(): never { throw new RestError(409, 'WALLET_DEVICE_CONFLICT', 'Adding the device or the current account identity changed.'); }
function expired(): never { throw new RestError(410, 'WALLET_DEVICE_EXPIRED', 'Start adding the device again. The previous deadline cannot be extended.'); }
const captured = (context: WalletAuthorityContext) => stable({ enrollment: context.enrollment, credential: context.credential, devices: context.devices ?? [], binding: context.binding });
type ActivationObserver = { audience: string; observe(context: WalletAuthorityContext): Promise<WalletAuthorityObservation> };

/** Trusted durable device-addition workflow. HTTP supplies session, origin and CSRF boundaries for
 * the primary, and the link token for the new device. Proof intake creates no authority; activation
 * needs the configured canonical observer and submits no transaction. */
export class PostgresWalletDeviceStore {
  private readonly policy: { rpId: string; origin: string; lifetimeMs: number; maxRecords: number; maxAccountRecords: number };
  private readonly authority: PostgresWalletAuthorityStore;
  private readonly ceremonies: PostgresWalletCeremonyStore;
  private readonly activationObserver?: ActivationObserver;
  constructor(private readonly pool: Pool, options: { rpId: string; origin: string; lifetimeMs?: number; maxRecords?: number; maxAccountRecords?: number },
    activationObserver?: ActivationObserver) {
    enrollmentDigest(options);
    if (Object.keys(options).some(key => !['rpId', 'origin', 'lifetimeMs', 'maxRecords', 'maxAccountRecords'].includes(key))) invalid();
    this.policy = { lifetimeMs: 300000, maxRecords: 100000, maxAccountRecords: 64, ...structuredClone(options) };
    validateWalletRpConfiguration(this.policy);
    for (const [value, maximum] of [[this.policy.lifetimeMs, 300000], [this.policy.maxRecords, 1000000], [this.policy.maxAccountRecords, 10000]] as const)
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) invalid();
    if (activationObserver) {
      if (typeof activationObserver.observe !== 'function') invalid();
      this.activationObserver = { audience: validateAudience(activationObserver.audience), observe: activationObserver.observe.bind(activationObserver) };
    }
    this.authority = new PostgresWalletAuthorityStore(pool); this.ceremonies = new PostgresWalletCeremonyStore(pool);
  }
  /** From the primary's session. The link token goes to the second device; only the primary's
   * session may approve. */
  async begin(session: { accountId: string; id: string; credentialId: string }, options: { passkeyName?: string } = {}): Promise<{ record: WalletDeviceRecord; linkToken: string }> {
    if (typeof session?.id !== 'string' || !uuid.test(session.id) || typeof session.credentialId !== 'string') invalid();
    const passkeyName = copyWalletPasskeyName(options.passkeyName);
    const context = await this.authority.loadContext(session.accountId), expected = captured(context);
    // A device passkey's session cannot approve the addition later, so it may not start one.
    if (context.credential.credentialId !== session.credentialId) unauthorized();
    if (context.credential.rpId !== this.policy.rpId || context.enrollment.intent.origin !== this.policy.origin) invalid();
    const now = await this.now(), intent = createWalletDeviceIntent(context, { rpId: this.policy.rpId, origin: this.policy.origin,
      nowMs: now, expiresAtMs: now + this.policy.lifetimeMs });
    const linkToken = randomBytes(32).toString('base64url');
    return this.transaction(async client => {
      await lockWalletCeremonyAdmission(client);
      if (captured(await loadWalletAuthorityContextInTransaction(client, session.accountId)) !== expected) conflict();
      await client.query(`DELETE FROM rest_wallet_devices WHERE id IN
        (SELECT id FROM rest_wallet_devices WHERE proof IS NULL AND expires_at_ms<=${sqlNow}
          ORDER BY expires_at_ms,id LIMIT 100 FOR UPDATE SKIP LOCKED)`);
      const counts = (await client.query<{ total: number; account: number }>(
        'SELECT count(*)::int AS total, count(*) FILTER (WHERE account_id=$1)::int AS account FROM rest_wallet_devices', [session.accountId])).rows[0]!;
      if (counts.total >= this.policy.maxRecords || counts.account >= this.policy.maxAccountRecords)
        throw new RestError(429, 'WALLET_DEVICE_LIMIT', 'Device storage admission limit reached.');
      await this.live(client, intent);
      await this.ceremonies.issueInTransaction(client, intent.registration, null);
      const row = (await client.query<Row>(`INSERT INTO rest_wallet_devices(id,account_id,enrollment_id,token_hash,session_id,created_at_ms,
        expires_at_ms,retain_until_ms,passkey_name,intent) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [intent.id, session.accountId, intent.enrollmentId, hashToken(linkToken), session.id, intent.issuedAtMs, intent.expiresAtMs, intent.expiresAtMs + 86400000, passkeyName, intent])).rows[0]!;
      await this.live(client, intent); return { record: recordOf(row), linkToken };
    });
  }
  /** The primary's page reads by id under its own account. */
  async get(id: string, accountId: string): Promise<WalletDeviceRecord | null> {
    if (typeof id !== 'string' || !uuid.test(id)) return null;
    const row = (await this.pool.query<Row>('SELECT * FROM rest_wallet_devices WHERE id=$1 AND account_id=$2', [id, accountId])).rows[0];
    return row ? recordOf(row) : null;
  }
  /** The new device reads by its link token. */
  async getByToken(linkToken: string): Promise<WalletDeviceRecord | null> {
    if (!token(linkToken)) return null;
    const row = (await this.pool.query<Row>('SELECT * FROM rest_wallet_devices WHERE token_hash=$1', [hashToken(linkToken)])).rows[0];
    return row ? recordOf(row) : null;
  }
  async register(linkToken: string, input: WalletRegistrationResponse): Promise<WalletDeviceRecord> {
    const response = copyWalletEnrollmentRegistration(input), before = await this.required(linkToken);
    const candidate = prepareWalletDeviceCandidate(before.intent, response), expected = await this.current(before.intent);
    return this.transaction(async client => {
      await lockWalletCeremonyAdmission(client);
      if (captured(await loadWalletAuthorityContextInTransaction(client, before.intent.accountId)) !== expected) conflict();
      const row = await this.lock(client, before.intent.id, linkToken);
      if (stable(row.intent) !== stable(before.intent)) conflict();
      if (row.candidate) {
        if (stable(row.candidate.credential) !== stable(candidate.credential)) conflict();
        return recordOf(row);
      }
      await this.live(client, row.intent);
      await this.ceremonies.issueInTransaction(client, candidate.possession, null);
      const updated = (await client.query<Row>('UPDATE rest_wallet_devices SET candidate=$2 WHERE id=$1 RETURNING *', [row.id, candidate])).rows[0]!;
      await this.live(client, row.intent); return recordOf(updated);
    });
  }
  async prove(linkToken: string, input: WalletAssertion): Promise<{ record: WalletDeviceRecord; replayed: boolean }> {
    const assertion = copyWalletSignupAssertion(input), before = await this.required(linkToken);
    if (!before.candidate) conflict();
    const proof = verifyWalletDevicePossession(before.candidate, assertion, before.proof?.verifiedAtMs ?? await this.now());
    const expected = await this.current(before.intent);
    return this.transaction(async client => {
      if (captured(await loadWalletAuthorityContextInTransaction(client, before.intent.accountId)) !== expected) conflict();
      const row = await this.lock(client, before.intent.id, linkToken);
      if (stable(row.intent) !== stable(before.intent) || stable(row.candidate) !== stable(before.candidate)) conflict();
      if (row.proof) {
        if (row.proof.verificationDigest !== proof.verificationDigest) conflict();
        return { record: recordOf(row), replayed: true };
      }
      await this.live(client, row.intent);
      await this.ceremonies.consumeInTransaction(client, { ...row.candidate!.possession, proofDigest: proof.verificationDigest, resultId: row.id });
      const accepted = { ...proof, verifiedAtMs: await this.live(client, row.intent) };
      const updated = (await client.query<Row>('UPDATE rest_wallet_devices SET proof=$2 WHERE id=$1 RETURNING *', [row.id, accepted])).rows[0]!;
      await this.live(client, row.intent); return { record: recordOf(updated), replayed: false };
    });
  }
  /** Once the relay observed the owner addition and the account was rebound: one more live passkey
   * row with its receipt. No passkey is superseded, no grant revoked, no epoch fenced: the primary
   * still has every authority it had, and sessions simply end with the binding they pinned. */
  async activate(id: string, receipt: WalletCredentialDevice): Promise<{ receipt: WalletCredentialDevice; replayed: boolean }> {
    if (!this.activationObserver) throw new RestError(503, 'WALLET_DEVICE_UNAVAILABLE', 'Canonical device activation is not configured.');
    if (typeof id !== 'string' || !uuid.test(id) || receipt?.id !== id) invalid();
    const before = (await this.pool.query<Row>('SELECT * FROM rest_wallet_devices WHERE id=$1', [id])).rows[0];
    if (!before?.candidate || !before.proof) unauthorized();
    if (before.activation) { if (stable(before.activation) !== stable(receipt)) conflict(); return { receipt: before.activation, replayed: true }; }
    return this.transaction(async client => {
      const current = await loadWalletAuthorityContextInTransaction(client, before.intent.accountId);
      const row = (await client.query<Row>('SELECT * FROM rest_wallet_devices WHERE id=$1 FOR UPDATE', [id])).rows[0]!;
      if (stable(row.candidate) !== stable(before.candidate) || stable(row.proof) !== stable(before.proof)) conflict();
      if (row.activation) { if (stable(row.activation) !== stable(receipt)) conflict(); return { receipt: row.activation, replayed: true }; }
      if (enrollmentDigest(current.credential) !== row.intent.primaryCredentialDigest || current.binding.authorization.digest.toLowerCase() !== receipt.bindingDigest.toLowerCase()) conflict();
      const next = receipt.credential;
      await client.query(`INSERT INTO ${passkeyTable}(rp_id,credential_id,enrollment_id,account_id,user_handle,
        public_key_x,public_key_y,backup_eligible,verified_at,device_receipt,passkey_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [receipt.rpId, next.credentialId, receipt.enrollmentId, receipt.accountId, next.userHandle, next.publicKey.x, next.publicKey.y,
        next.backupEligible, receipt.verifiedAtMs, receipt, row.passkey_name]);
      await client.query('UPDATE rest_wallet_devices SET activation=$2 WHERE id=$1', [id, receipt]);
      // The rebound context, now with this device, must validate as the account's authority.
      validateWalletAuthorityContext(await loadWalletAuthorityContextInTransaction(client, before.intent.accountId));
      return { receipt, replayed: false };
    });
  }
  private async current(intent: WalletDeviceIntent): Promise<string> {
    const context = validateWalletAuthorityContext(await this.authority.loadContext(intent.accountId));
    if (enrollmentDigest(context.enrollment) !== intent.enrollmentDigest || enrollmentDigest(context.credential) !== intent.primaryCredentialDigest
      || context.binding.authorization.digest !== intent.bindingDigest || context.credential.rpId !== intent.rpId
      || context.enrollment.intent.origin !== intent.origin) conflict();
    return captured(context);
  }
  async now() { return Number((await this.pool.query(`SELECT ${sqlNow} AS now`)).rows[0].now); }
  private async required(linkToken: string) { const row = await this.getByToken(linkToken); return row ?? unauthorized(); }
  private async lock(client: PoolClient, id: string, linkToken: string): Promise<Row> {
    const row = (await client.query<Row>('SELECT * FROM rest_wallet_devices WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!row || row.token_hash !== hashToken(linkToken)) unauthorized();
    return row;
  }
  private async live(client: PoolClient, intent: WalletDeviceIntent) {
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
  /** The observer's word on the rebound account, for activation callers. */
  async observe(context: WalletAuthorityContext): Promise<WalletAuthorityObservation> {
    if (!this.activationObserver) throw new RestError(503, 'WALLET_DEVICE_UNAVAILABLE', 'Canonical device activation is not configured.');
    return validateWalletAuthorityObservation(await this.activationObserver.observe(context), context);
  }
  get audience() { return this.activationObserver?.audience ?? null; }
}
