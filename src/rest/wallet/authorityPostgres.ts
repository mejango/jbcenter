import type { Pool, PoolClient } from "pg";
import { RestError } from "../core.js";
import type { SmartAccountBinding } from "../smartAccounts/types.js";
import { stable } from "../smartAccounts/service.js";
import { walletAppAccount } from "./appGrants.js";
import { reconcileWalletAuthority, validateWalletAuthorityContext, validateWalletAuthorityObservation, validateWalletAuthoritySnapshot,
  walletAuthorityMaximumAgeMs, walletAuthorityMaximumHeadAgeMs,
  type WalletAuthorityContext, type WalletAuthorityCredential, type WalletAuthorityObservation, type WalletAuthoritySnapshot } from "./authority.js";
import { enrollmentDigest } from "./enrollment.js";
import { currentWalletCredentialInTransaction, lockWalletEnrollmentInTransaction,
  type CurrentWalletCredentialRow } from "./enrollmentPostgres.js";

interface AuthorityRow {
  account_id: string; authority_epoch: string; session_epoch: string; updated_at: string; revision: string;
  snapshot: WalletAuthoritySnapshot | null; observation_digest: string | null; ready_until_ms: string | null;
  binding_id: string | null; binding_authorization_digest: string | null;
}
interface BindingRow { document: SmartAccountBinding; revoked_at: string | null; authorization_digest: string }

function unavailable(): never {
  throw new RestError(403, "WALLET_AUTHORITY_UNAVAILABLE", "Wallet authority is not ready for admission.");
}
function account(value: string): void {
  if (!walletAppAccount(value)) throw new RestError(400, "WALLET_AUTHORITY_INVALID", "A stable Base Safe account is required.");
}
function conflict(): never {
  throw new RestError(409, "WALLET_AUTHORITY_CONFLICT", "Wallet authority context or generations require fresh reconciliation.");
}
function fresh(observation: WalletAuthorityObservation, candidate: WalletAuthoritySnapshot, nowMs: number): void {
  if (nowMs < observation.observedAtMs || nowMs < candidate.updatedAtMs) conflict();
  if (observation.head && (nowMs >= (observation.validUntilMs ?? observation.observedAtMs + walletAuthorityMaximumAgeMs) ||
      BigInt(nowMs) >= BigInt(observation.head.timestamp) * 1000n + BigInt(walletAuthorityMaximumHeadAgeMs)))
    throw new RestError(410, "WALLET_AUTHORITY_EXPIRED", "Wallet authority observation expired before admission.");
}
async function databaseNow(client: Pool | PoolClient): Promise<number> {
  const nowMs = Number((await client.query<{ now: string }>(
    "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now")).rows[0]!.now);
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) unavailable();
  return nowMs;
}
function snapshotOf(row: AuthorityRow): WalletAuthoritySnapshot {
  return row.snapshot ?? { version: "center-wallet-authority-snapshot-v1", accountId: row.account_id,
    revision: row.revision, authorityEpoch: row.authority_epoch, sessionEpoch: row.session_epoch,
    bootstrapRequired: true, readiness: "unknown", identity: null, historicalVerifiedIdentity: null,
    acceptedAnchor: null, highestObservedBlock: null, activeFence: null, lastClosedFence: null,
    latestObservation: null, validUntilMs: null, updatedAtMs: Number(row.updated_at) * 1000 };
}
function credentialOf(row: CurrentWalletCredentialRow): WalletAuthorityCredential {
  return { accountId: row.account_id, enrollmentId: row.enrollment_id, rpId: row.rp_id,
    credentialId: row.credential_id, userHandle: row.user_handle,
    publicKey: { x: row.public_key_x, y: row.public_key_y }, backupEligible: row.backup_eligible,
    verifiedAtMs: Number(row.verified_at), supersededAtMs: null, ...(row.recovery_receipt ? { recovery: row.recovery_receipt } : {}) };
}

async function lockAccount(client: PoolClient, accountId: string): Promise<void> {
  const row = (await client.query<{ owner_address: string; authority_chain_id: string }>(
    "SELECT owner_address,authority_chain_id FROM rest_accounts WHERE id=$1 FOR UPDATE", [accountId])).rows[0];
  if (!row || String(row.authority_chain_id) !== "8453" || `eip155:8453:${row.owner_address.toLowerCase()}` !== accountId) unavailable();
}
async function readBinding(client: PoolClient, accountId: string): Promise<BindingRow> {
  // Existing binding writers hold the same account row lock. This does not create or un-revoke one.
  const row = (await client.query<BindingRow>(`SELECT document,revoked_at,authorization_digest FROM rest_smart_account_bindings
    WHERE account_id=$1 AND chain_id=8453 AND wallet_address=$2 AND revoked_at IS NULL`, [accountId, accountId.slice("eip155:8453:".length)])).rows[0];
  if (!row || row.document.authorization.method !== "safe-passkey-owner-threshold-and-api-grant" ||
      row.document.authorization.digest !== row.authorization_digest) unavailable();
  return row;
}
async function readAuthority(client: Pool | PoolClient, accountId: string, lock = false): Promise<AuthorityRow | null> {
  return (await client.query<AuthorityRow>(`SELECT * FROM rest_wallet_authority WHERE account_id=$1${lock ? " FOR UPDATE" : ""}`, [accountId])).rows[0] ?? null;
}

/** Internal locked metadata only. Caller owns BEGIN/COMMIT and validates a captured context
 * outside SQL before comparing its immutable fields here. Account → enrollment → authority
 * → credential locks; no proof validation, RPC, pool acquisition or authority admission. */
export async function loadWalletAuthorityContextInTransaction(client: PoolClient, accountId: string): Promise<WalletAuthorityContext> {
  account(accountId);
  await lockAccount(client, accountId);
  const currentBinding = await readBinding(client, accountId);
  const row = (await client.query<{ id: string }>("SELECT id FROM rest_wallet_enrollments WHERE account_id=$1 AND state='verified'", [accountId])).rows[0];
  if (!row) unavailable();
  const enrollment = await lockWalletEnrollmentInTransaction(client, row.id);
  const authority = await readAuthority(client, accountId, true);
  const credential = await currentWalletCredentialInTransaction(client, enrollment);
  if (!credential) unavailable();
  return { version: "center-wallet-authority-context-v1", accountId, enrollment,
    credential: credentialOf(credential), binding: currentBinding.document, prior: authority ? snapshotOf(authority) : null };
}

/** Internal trusted storage composition only. No chain transport or public grant issuance. */
export class PostgresWalletAuthorityStore {
  constructor(private readonly pool: Pool) {}
  async loadContext(accountId: string): Promise<WalletAuthorityContext> {
    const context = await this.transaction(client => loadWalletAuthorityContextInTransaction(client, accountId));
    // Expensive context/creation/profile validation occurs only after every row lock is released.
    return validateWalletAuthorityContext(context);
  }
  async get(accountId: string): Promise<WalletAuthoritySnapshot | null> {
    account(accountId);
    const row = await readAuthority(this.pool, accountId);
    return row ? validateWalletAuthoritySnapshot(snapshotOf(row)) : null;
  }
  async reconcile(inputContext: WalletAuthorityContext, inputObservation: WalletAuthorityObservation): Promise<{
    snapshot: WalletAuthoritySnapshot; replayed: boolean;
  }> {
    // Snapshot and fully validate the captured producer boundary before any await or row locks.
    // The configured observer, not this JSON shape, establishes canonical chain provenance.
    const context = validateWalletAuthorityContext(inputContext);
    const observation = validateWalletAuthorityObservation(inputObservation, context);
    const digest = enrollmentDigest(observation);
    const resultRevision = (BigInt(context.prior?.revision ?? "0") + 1n).toString();
    const expected = { enrollment: stable(context.enrollment), binding: stable(context.binding),
      credential: stable(context.credential), prior: stable(context.prior) };
    const hint = await readAuthority(this.pool, context.accountId);
    // A known lost-response retry may outlive the observation TTL; it can only read the exact
    // still-durable result. All distinct writes must pass the reducer's original-time deadline.
    const candidate = hint?.observation_digest === digest ? null
      : reconcileWalletAuthority(context, observation, await databaseNow(this.pool));
    const result = await this.transaction(async client => {
      await lockAccount(client, context.accountId);
      const enrollment = await lockWalletEnrollmentInTransaction(client, context.enrollment.intent.id);
      const current = await readAuthority(client, context.accountId, true);
      const credential = await currentWalletCredentialInTransaction(client, enrollment);
      if (!credential) unavailable();
      const binding = await readBinding(client, context.accountId);
      // Bounded structural comparisons only. No digest computation, proof verification, external
      // call or second pool acquisition is performed while account/enrollment/authority/key lock.
      if (stable(enrollment) !== expected.enrollment || stable(binding.document) !== expected.binding ||
          stable(credentialOf(credential)) !== expected.credential) conflict();
      if (current?.observation_digest === digest) {
        // Logout or another durable transition changes the result, even when its observation is
        // unchanged. Such a caller must reload; an exact replay never returns a different receipt.
        if (current.revision !== resultRevision) conflict();
        return { snapshot: snapshotOf(current), replayed: true };
      }
      if (!candidate || stable(current ? snapshotOf(current) : null) !== expected.prior) conflict();
      fresh(observation, candidate, await databaseNow(client));
      const values = [context.accountId, candidate.authorityEpoch, candidate.sessionEpoch, Math.floor(candidate.updatedAtMs / 1000),
        candidate.revision, JSON.stringify(candidate), digest, candidate.validUntilMs,
        candidate.identity?.bindingId ?? null, candidate.identity?.bindingAuthorizationDigest ?? null];
      const row = current ? (await client.query<AuthorityRow>(`UPDATE rest_wallet_authority SET authority_epoch=$2,session_epoch=$3,
        updated_at=GREATEST(updated_at,$4),revision=$5,snapshot=$6::jsonb,observation_digest=$7,
        ready_until_ms=$8,binding_id=$9,binding_authorization_digest=$10
        WHERE account_id=$1 AND revision=$11 AND authority_epoch=$12 AND session_epoch=$13 RETURNING *`,
      [...values, current.revision, current.authority_epoch, current.session_epoch])).rows[0]
        : (await client.query<AuthorityRow>(`INSERT INTO rest_wallet_authority(account_id,authority_epoch,session_epoch,updated_at,
          revision,snapshot,observation_digest,ready_until_ms,binding_id,binding_authorization_digest)
          VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10) RETURNING *`, values)).rows[0];
      if (!row) conflict();
      // Unique-index waits and post-write work consume the same original readiness lifetime.
      fresh(observation, candidate, await databaseNow(client));
      return { snapshot: snapshotOf(row), replayed: false };
    });
    return { snapshot: validateWalletAuthoritySnapshot(result.snapshot), replayed: result.replayed };
  }
  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    // Production supplies the shared pool's bounded acquisition/query deadlines; never acquire
    // another pool connection or call a chain/proof service while holding these row locks.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='5000ms'");
      await client.query("SET LOCAL statement_timeout='10000ms'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout='15000ms'");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if (error && typeof error === "object" && "code" in error && ["23505", "22003"].includes(String(error.code))) conflict();
      throw error;
    }
    finally { client.release(); }
  }
}
