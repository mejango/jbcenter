import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { RestError } from '../core.js';
import { stable } from '../smartAccounts/service.js';
import { validateWalletAuthorityContext, type WalletAuthorityContext } from './authority.js';
import { loadWalletAuthorityContextInTransaction, PostgresWalletAuthorityStore } from './authorityPostgres.js';
import { enrollmentDigest } from './enrollment.js';
import { copyWalletEnrollmentProof, copyWalletEnrollmentRegistration } from './enrollmentPostgres.js';
import { lockWalletCeremonyAdmission, PostgresWalletCeremonyStore, walletCeremonyDatabaseNow } from './ceremoniesPostgres.js';
import { createWalletRecoveryIntent, prepareWalletRecoveryCandidate, verifyWalletRecoveryProof,
  type WalletRecoveryIntent, type WalletRecoveryCandidate, type WalletRecoveryProof } from './recovery.js';
import type { WalletRegistrationResponse } from './registration.js';
import { validateWalletRpConfiguration } from './webauthn.js';

export interface WalletRecoveryRecord {
  intent: WalletRecoveryIntent; candidate: WalletRecoveryCandidate | null; proof: WalletRecoveryProof | null;
}
interface Row { id: string; token_hash: string; intent: WalletRecoveryIntent; candidate: WalletRecoveryCandidate | null; proof: WalletRecoveryProof | null }
const sqlNow = 'floor(extract(epoch FROM clock_timestamp())*1000)::bigint';
const recordOf = (row: Row): WalletRecoveryRecord => ({ intent: row.intent, candidate: row.candidate, proof: row.proof });
const hashToken = (value: string) => createHash('sha256').update('center-wallet-recovery-flow-v1:' + value).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const token = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
  && Buffer.from(value, 'base64url').toString('base64url') === value;
function invalid(): never { throw new RestError(400, 'WALLET_RECOVERY_INVALID', 'Recovery fields or storage bounds are invalid.'); }
function unauthorized(): never { throw new RestError(403, 'WALLET_RECOVERY_UNAUTHORIZED', 'A matching recovery continuation and proof are required.'); }
function conflict(): never { throw new RestError(409, 'WALLET_RECOVERY_CONFLICT', 'Recovery or the current wallet identity changed.'); }
function expired(): never { throw new RestError(410, 'WALLET_RECOVERY_EXPIRED', 'Prepare a fresh recovery proof. The previous deadline cannot be extended.'); }
const captured = (context: WalletAuthorityContext) => stable({ enrollment: context.enrollment, credential: context.credential, binding: context.binding });

/** Trusted durable proof intake only. HTTP must supply origin/CSRF/cookie boundaries.
 * Accepted proof does not change owners, replace a credential, issue access or submit a transaction. */
export class PostgresWalletRecoveryStore {
  private readonly policy: { rpId: string; origin: string; lifetimeMs: number; maxRecords: number; maxAccountRecords: number };
  private readonly authority: PostgresWalletAuthorityStore;
  private readonly ceremonies: PostgresWalletCeremonyStore;
  constructor(private readonly pool: Pool, options: { rpId: string; origin: string; lifetimeMs?: number; maxRecords?: number; maxAccountRecords?: number }) {
    enrollmentDigest(options);
    if (Object.keys(options).some(key => !['rpId', 'origin', 'lifetimeMs', 'maxRecords', 'maxAccountRecords'].includes(key))) invalid();
    this.policy = { lifetimeMs: 300000, maxRecords: 100000, maxAccountRecords: 256, ...structuredClone(options) };
    validateWalletRpConfiguration(this.policy);
    for (const [value, maximum] of [[this.policy.lifetimeMs, 300000], [this.policy.maxRecords, 1000000], [this.policy.maxAccountRecords, 10000]])
      if (!Number.isSafeInteger(value) || value! < 1 || value! > maximum!) invalid();
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
    const row = (await this.pool.query<Row>('SELECT * FROM rest_wallet_recoveries WHERE id=$1 AND token_hash=$2', [id, hashToken(flowToken)])).rows[0];
    return row ? recordOf(row) : null;
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
    const row = (await client.query<Row>('SELECT * FROM rest_wallet_recoveries WHERE id=$1 AND token_hash=$2 FOR UPDATE', [id, hashToken(flowToken)])).rows[0];
    return row ?? unauthorized();
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
