import type { Pool, PoolClient } from "pg";
import { RestError } from "../core.js";
import {
  assertWalletEnrollmentIntent, enrollmentDigest, prepareWalletEnrollmentCandidate, verifyWalletEnrollmentProof, walletEnrollmentDocument,
  type WalletEnrollment, type WalletEnrollmentIntent, type WalletEnrollmentReceipt,
} from "./enrollment.js";
import { PostgresWalletCeremonyStore, lockWalletCeremonyAdmission, walletCeremonyDatabaseNow } from "./ceremoniesPostgres.js";
import { walletCeremonyRetentionMs } from "./ceremonies.js";
import type { WalletRegistrationResponse } from "./registration.js";
import type { WalletAssertion } from "./webauthn.js";
import type { Hex } from "viem";
import type { WalletCredentialRecovery } from "./credentialRecovery.js";

type EnrollmentRow = {
  state: WalletEnrollment["state"]; created_at: string; intent: WalletEnrollmentIntent;
  candidate: WalletEnrollment["candidate"]; candidate_digest: string | null; creation: WalletEnrollment["creation"];
  possession: WalletEnrollment["possession"]; receipt: WalletEnrollmentReceipt | null;
};
const nowSql = "floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint";
const recordOf = (row: EnrollmentRow): WalletEnrollment => ({ intent: row.intent, createdAt: Number(row.created_at), state: row.state,
  candidate: row.candidate, candidateDigest: row.candidate_digest, creation: row.creation, possession: row.possession, receipt: row.receipt });
function validId(id: string): void {
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))
    throw new RestError(400, "WALLET_ENROLLMENT_INVALID", "A valid enrollment identifier is required.");
}
function conflict(): never {
  throw new RestError(409, "WALLET_ENROLLMENT_CONFLICT", "Enrollment was already fixed to a different intent or credential.");
}
function missing(): never { throw new RestError(404, "WALLET_ENROLLMENT_NOT_FOUND", "Enrollment is unavailable."); }
function invalidInput(proof = false): never {
  throw new RestError(proof ? 403 : 400, proof ? "WALLET_ENROLLMENT_PROOF_INVALID" : "WALLET_ENROLLMENT_INVALID", "Enrollment input is invalid or exceeds its byte bounds.");
}
function inputFields(value: unknown, fields: string[], proof = false): void {
  if (!value || typeof value !== "object" || Object.keys(value).length !== fields.length
    || fields.some(field => !Object.hasOwn(value, field) || !("value" in Object.getOwnPropertyDescriptor(value, field)!))) invalidInput(proof);
}
function copyBytes(value: Uint8Array, minimum: number, maximum: number, proof = false): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < minimum || value.byteLength > maximum) invalidInput(proof);
  return Uint8Array.from(value);
}
export function copyWalletEnrollmentRegistration(value: WalletRegistrationResponse): WalletRegistrationResponse {
  inputFields(value, ["type", "credentialId", "rawId", "clientDataJSON", "attestationObject"]);
  if (value.type !== "public-key" || typeof value.credentialId !== "string" || value.credentialId.length > 1364) invalidInput();
  return { type: value.type, credentialId: value.credentialId, rawId: copyBytes(value.rawId, 1, 1023),
    clientDataJSON: copyBytes(value.clientDataJSON, 1, 2048), attestationObject: copyBytes(value.attestationObject, 1, 2048) };
}
export function copyWalletEnrollmentProof(value: { assertion: WalletAssertion; backupSignature: Hex }): { assertion: WalletAssertion; backupSignature: Hex } {
  inputFields(value, ["assertion", "backupSignature"], true);
  const assertion = value.assertion;
  inputFields(assertion, ["credentialId", "userHandle", "authenticatorData", "clientDataJSON", "signature"], true);
  if (typeof value.backupSignature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(value.backupSignature)
    || typeof assertion.credentialId !== "string" || assertion.credentialId.length > 1364
    || (assertion.userHandle !== null && (typeof assertion.userHandle !== "string" || assertion.userHandle.length > 86))) invalidInput(true);
  return { backupSignature: value.backupSignature, assertion: { credentialId: assertion.credentialId, userHandle: assertion.userHandle,
    authenticatorData: copyBytes(assertion.authenticatorData, 37, 37, true), clientDataJSON: copyBytes(assertion.clientDataJSON, 1, 2048, true),
    signature: copyBytes(assertion.signature, 8, 72, true) } };
}
async function assertLive(client: PoolClient, record: Pick<WalletEnrollment, "intent">): Promise<number> {
  const now = await walletCeremonyDatabaseNow(client);
  if (record.intent.expiresAt <= now) throw new RestError(410, "WALLET_ENROLLMENT_EXPIRED", "Enrollment expired; its existing verified receipt remains recoverable.");
  return now;
}
/** Internal compound-workflow loader; the caller owns transaction and parent lock ordering. */
export async function lockWalletEnrollmentInTransaction(client: PoolClient, id: string): Promise<WalletEnrollment> {
  validId(id);
  const row = (await client.query<EnrollmentRow>("SELECT * FROM rest_wallet_enrollments WHERE id=$1 FOR UPDATE", [id])).rows[0];
  return row ? recordOf(row) : missing();
}

export interface CurrentWalletCredentialRow {
  rp_id: string; credential_id: string; enrollment_id: string; account_id: string; user_handle: string;
  public_key_x: Hex; public_key_y: Hex; backup_eligible: boolean; verified_at: string; superseded_at: string | null;
  recovery_receipt?: WalletCredentialRecovery | null;
}
/** The caller owns transaction and lock order. This preserves W4's exact current-mapping check;
 * it acquires no account lock and performs no proof verification or external reads. */
export async function currentWalletCredentialInTransaction(client: PoolClient, enrollment: WalletEnrollment): Promise<CurrentWalletCredentialRow | null> {
  const candidate = enrollment.candidate!, receipt = enrollment.receipt!;
  const row = (await client.query<CurrentWalletCredentialRow>(
    "SELECT * FROM rest_wallet_credentials WHERE account_id=$1 AND superseded_at IS NULL FOR UPDATE", [receipt.accountId])).rows[0];
  if (!row || row.enrollment_id !== enrollment.intent.id || row.account_id !== receipt.accountId || row.user_handle !== candidate.userHandle || row.rp_id !== enrollment.intent.rpId) return null;
  // Bounded metadata only under locks. Full immutable lineage validation runs in the
  // authority loader after release; a receipt's JSON shape is never provenance.
  if (row.recovery_receipt) {
    const r = row.recovery_receipt;
    return r.accountId === row.account_id && r.enrollmentId === row.enrollment_id && r.rpId === row.rp_id
      && r.credential?.credentialId === row.credential_id && r.credential.userHandle === row.user_handle
      && r.credential.publicKey?.x === row.public_key_x && r.credential.publicKey.y === row.public_key_y
      && r.credential.backupEligible === row.backup_eligible && r.verifiedAtMs === Number(row.verified_at) ? row : null;
  }
  if (row.credential_id !== candidate.credentialId ||
      row.public_key_x !== candidate.publicKey.x || row.public_key_y !== candidate.publicKey.y || row.backup_eligible !== candidate.backupEligible ||
      row.superseded_at !== null) return null;
  return row;
}

/** Internal trusted service only. None of these methods create REST principals, login sessions,
 * deployment authority or onchain status. HTTP admission, cookies and CSRF are separate boundaries. */
export class PostgresWalletEnrollmentStore {
  private readonly ceremonies: PostgresWalletCeremonyStore;
  private readonly maxPendingEnrollments: number;
  constructor(private readonly pool: Pool, options: { maxPendingEnrollments?: number } = {}) {
    this.ceremonies = new PostgresWalletCeremonyStore(pool);
    this.maxPendingEnrollments = options.maxPendingEnrollments ?? 100_000;
    if (!Number.isSafeInteger(this.maxPendingEnrollments) || this.maxPendingEnrollments < 1 || this.maxPendingEnrollments > 1_000_000)
      throw new RestError(400, "WALLET_ENROLLMENT_INVALID", "Enrollment storage bound is invalid.");
  }

  async begin(input: WalletEnrollmentIntent): Promise<WalletEnrollment> {
    assertWalletEnrollmentIntent(input);
    const intent = structuredClone(input);
    return this.transaction(client => this.beginInTransaction(client, intent));
  }

  /** Internal compound signup helper. Caller owns the transaction and acquires its admission
   * lock before ceremony admission. Never acquire another connection while holding these locks. */
  async beginInTransaction(client: PoolClient, input: WalletEnrollmentIntent): Promise<WalletEnrollment> {
    assertWalletEnrollmentIntent(input);
    const intent = structuredClone(input);
    await lockWalletCeremonyAdmission(client);
    await this.cleanupInTransaction(client, 100);
    const row = (await client.query<EnrollmentRow>("SELECT * FROM rest_wallet_enrollments WHERE id=$1 FOR UPDATE", [intent.id])).rows[0];
    if (row) {
      const prior = recordOf(row);
      if (enrollmentDigest(prior.intent) !== enrollmentDigest(intent)) conflict();
      if (prior.state !== "verified" && intent.expiresAt + walletCeremonyRetentionMs <= await walletCeremonyDatabaseNow(client))
        throw new RestError(410, "WALLET_ENROLLMENT_EXPIRED", "Enrollment retention has ended.");
      return prior;
    }
    if ((await client.query<{ count: number }>("SELECT count(*)::int AS count FROM rest_wallet_enrollments WHERE state<>'verified'")).rows[0]!.count >= this.maxPendingEnrollments)
      throw new RestError(429, "WALLET_ENROLLMENT_LIMIT", "Enrollment storage admission limit reached.");
    const ceremony = await this.ceremonies.issueInTransaction(client, intent.registration, null);
    const inserted = (await client.query<EnrollmentRow>(
      `INSERT INTO rest_wallet_enrollments(id,user_handle,state,intent_digest,created_at,expires_at,retain_until,intent)
       VALUES($1,$2,'awaiting_registration',$3,$4,$5,$6,$7::jsonb) RETURNING *`,
      [intent.id, intent.userHandle, enrollmentDigest(intent), ceremony.createdAt, intent.expiresAt,
        intent.expiresAt + walletCeremonyRetentionMs, JSON.stringify(intent)],
    )).rows[0]!;
    await assertLive(client, { intent });
    return recordOf(inserted);
  }

  async get(id: string): Promise<WalletEnrollment | null> {
    validId(id);
    const row = (await this.pool.query<EnrollmentRow>(
      `SELECT * FROM rest_wallet_enrollments WHERE id=$1 AND (state='verified' OR retain_until > ${nowSql})`, [id],
    )).rows[0];
    return row ? recordOf(row) : null;
  }

  async acceptRegistration(id: string, response: WalletRegistrationResponse): Promise<WalletEnrollment> {
    const registration = copyWalletEnrollmentRegistration(response), before = await this.get(id);
    if (!before) missing();
    const prepared = prepareWalletEnrollmentCandidate(before, registration);
    return this.transaction(async client => {
      // Issuance admission always precedes enrollment and ceremony rows, including retries.
      await lockWalletCeremonyAdmission(client);
      const current = await lockWalletEnrollmentInTransaction(client, id);
      if (enrollmentDigest(current.intent) !== enrollmentDigest(before.intent)) conflict();
      if (current.candidateDigest !== null) {
        if (current.candidateDigest !== prepared.candidateDigest) conflict();
        return current;
      }
      if (current.state !== "awaiting_registration") conflict();
      await assertLive(client, current);
      const consumed = await this.ceremonies.consumeInTransaction(client, { ...current.intent.registration,
        proofDigest: prepared.candidateDigest, resultId: prepared.possession.ceremony.id });
      if (consumed.replayed) conflict();
      await this.ceremonies.issueInTransaction(client, prepared.possession.ceremony, null);
      const row = (await client.query<EnrollmentRow>(
        `UPDATE rest_wallet_enrollments SET state='awaiting_possession',candidate=$2::jsonb,candidate_digest=$3,
         creation=$4::jsonb,possession=$5::jsonb,safe_address=$6 WHERE id=$1 RETURNING *`,
        [id, JSON.stringify(prepared.candidate), prepared.candidateDigest, JSON.stringify(prepared.creation),
          JSON.stringify(prepared.possession), prepared.creation.address.toLowerCase()],
      )).rows[0]!;
      await assertLive(client, current);
      return recordOf(row);
    });
  }

  async finalize(id: string, input: { assertion: WalletAssertion; backupSignature: Hex },
    options: { passkeyChallenge?: Hex } = {}): Promise<{ record: WalletEnrollment; replayed: boolean }> {
    const proof = copyWalletEnrollmentProof(input), before = await this.get(id);
    if (!before) missing();
    if (!before.candidate || !before.creation || !before.possession)
      throw new RestError(409, "WALLET_ENROLLMENT_STATE", "Registration must precede possession verification.");
    // Expensive parsing/crypto precede row locks. The locked snapshot must remain byte-for-byte equal.
    const verified = await verifyWalletEnrollmentProof(before, proof, options);
    return this.transaction(async client => {
      const current = await lockWalletEnrollmentInTransaction(client, id);
      if (enrollmentDigest([current.intent, current.candidate, current.creation, current.possession])
        !== enrollmentDigest([before.intent, before.candidate, before.creation, before.possession])) conflict();
      if (current.state === "verified") {
        if (current.receipt?.verificationDigest !== verified.verificationDigest) conflict();
        return { record: current, replayed: true };
      }
      if (current.state !== "awaiting_possession" || !current.candidate || !current.creation || !current.possession) conflict();
      await assertLive(client, current);
      const consumed = await this.ceremonies.consumeInTransaction(client, { ...current.possession.ceremony,
        proofDigest: verified.verificationDigest, resultId: id });
      if (consumed.replayed) conflict();
      const verifiedAt = await assertLive(client, current);
      const accountId = `eip155:8453:${current.creation.address.toLowerCase()}`;
      await client.query(
        `INSERT INTO rest_wallet_credentials(rp_id,credential_id,enrollment_id,account_id,user_handle,public_key_x,public_key_y,backup_eligible,verified_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [current.intent.rpId, current.candidate.credentialId, id, accountId, current.intent.userHandle,
          current.candidate.publicKey.x, current.candidate.publicKey.y, current.candidate.backupEligible, verifiedAt],
      );
      const document = walletEnrollmentDocument(current);
      const receipt: WalletEnrollmentReceipt = { id, enrollmentId: id, accountId, credentialId: current.candidate.credentialId,
        initializerHash: current.creation.initializerHash, manifestCommitment: document.message.manifestCommitment,
        manifestRevision: current.intent.manifest.revision, creationCommitment: document.message.creationCommitment,
        verificationDigest: verified.verificationDigest, verifiedAt };
      const row = (await client.query<EnrollmentRow>(
        `UPDATE rest_wallet_enrollments SET state='verified',account_id=$2,verified_at=$3,receipt=$4::jsonb WHERE id=$1 RETURNING *`,
        [id, accountId, verifiedAt, JSON.stringify(receipt)],
      )).rows[0]!;
      // Unique-index waits and all writes can cross expiry; roll everything back if they did.
      await assertLive(client, current);
      return { record: recordOf(row), replayed: false };
    });
  }

  async cleanup(limit = 1_000): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)
      throw new RestError(400, "WALLET_ENROLLMENT_INVALID", "Cleanup bound is invalid.");
    return this.transaction(client => this.cleanupInTransaction(client, limit));
  }

  /** Internal bounded cleanup; caller owns the transaction. Verified identity is never deleted. */
  async cleanupInTransaction(client: PoolClient, limit: number): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) invalidInput();
    const result = await client.query(`DELETE FROM rest_wallet_enrollments WHERE id IN
      (SELECT id FROM rest_wallet_enrollments WHERE state<>'verified' AND expires_at <= ${nowSql}
       ORDER BY expires_at,id LIMIT $1 FOR UPDATE SKIP LOCKED)`, [limit]);
    return result.rowCount ?? 0;
  }

  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if (error && typeof error === "object" && "code" in error && error.code === "23505") {
        const constraint = "constraint" in error ? error.constraint : undefined;
        if (typeof constraint === "string" && ["rest_wallet_credentials_pkey", "rest_wallet_credential_current_primary",
          "rest_wallet_enrollment_verified_safe", "rest_wallet_enrollments_account_id_key"].includes(constraint))
          throw new RestError(409, "WALLET_ENROLLMENT_CREDENTIAL_CONFLICT", "Credential or wallet identity already belongs to a verified enrollment.");
        conflict();
      }
      throw error;
    } finally { client.release(); }
  }
}
