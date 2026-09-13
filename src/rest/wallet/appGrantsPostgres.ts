import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { RestAuthError } from "../auth/store.js";
import { RestError } from "../core.js";
import { inactiveWalletAppGrant, invalidWalletAppGrant, validateWalletAppGrant, validateWalletAppGrantAdmission,
  walletAppAccount, walletAppAudience, walletAppBigint, walletAppBigintMaximum, walletAppFields,
  walletAppGrantMaximumLifetimeSeconds, walletAppGrantRetentionSeconds, walletAppPrincipalId, walletAppTime,
  walletAppUuid, type WalletAppGrant, type WalletAppGrantAdmission, type WalletAppAuthorityContext,
  type WalletAuthority, type WalletAuthorityAdvance } from "./appGrants.js";
import { assertWalletPolicyCallbackInTransaction } from "./policyPostgres.js";

interface GrantRow {
  id: string; incarnation: string; account_id: string; signer_address: string; origin: string;
  callback_uri: string; audience: string; app_generation: string; authority_epoch: string; session_epoch: string;
  created_at: string; expires_at: string; revoked_at: string | null; retain_until: string;
}
interface AuthorityRow { account_id: string; authority_epoch: string; session_epoch: string; updated_at: string }
const nowSql = "floor(extract(epoch FROM clock_timestamp()))::bigint";
function grantOf(row: GrantRow): WalletAppGrant {
  return validateWalletAppGrant({ kind: "wallet-app", id: row.id, incarnation: row.incarnation, accountId: row.account_id,
    signerAddress: row.signer_address, scopes: ["read", "plan", "relay"], origin: row.origin, callbackUri: row.callback_uri,
    audience: row.audience, appGeneration: Number(row.app_generation), authorityEpoch: row.authority_epoch,
    sessionEpoch: row.session_epoch, createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at), retainUntil: Number(row.retain_until) });
}
function authorityOf(row: AuthorityRow): WalletAuthority {
  const updatedAt = Number(row.updated_at);
  if (!walletAppAccount(row.account_id) || !walletAppBigint(row.authority_epoch) || !walletAppBigint(row.session_epoch)
    || !walletAppTime(updatedAt)) inactiveWalletAppGrant();
  return { accountId: row.account_id, authorityEpoch: row.authority_epoch, sessionEpoch: row.session_epoch, updatedAt };
}
async function now(client: PoolClient): Promise<number> {
  const value = Number((await client.query<{ now: string }>(`SELECT ${nowSql} AS now`)).rows[0]!.now);
  if (!walletAppTime(value)) inactiveWalletAppGrant();
  return value;
}
async function lockAccount(client: PoolClient, accountId: string): Promise<void> {
  const row = (await client.query<{ owner_address: string; authority_chain_id: number }>(
    "SELECT owner_address,authority_chain_id FROM rest_accounts WHERE id=$1 FOR UPDATE", [accountId])).rows[0];
  if (!row || Number(row.authority_chain_id) !== 8453 || `eip155:8453:${row.owner_address.toLowerCase()}` !== accountId)
    inactiveWalletAppGrant();
}
async function readAuthority(client: PoolClient, accountId: string, update = false): Promise<WalletAuthority> {
  const row = (await client.query<AuthorityRow>(
    `SELECT * FROM rest_wallet_authority WHERE account_id=$1 FOR ${update ? "UPDATE" : "SHARE"}`, [accountId])).rows[0];
  if (!row) inactiveWalletAppGrant();
  return authorityOf(row);
}
async function nowMs(client: PoolClient): Promise<number> {
  return Number((await client.query<{ now: string }>(
    "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now")).rows[0]!.now);
}
async function readyUntil(client: PoolClient, accountId: string): Promise<number> {
  // Binding writers hold the same account lock. Epoch checks alone cannot revoke a still-live
  // readiness deadline after explicit setup is revoked or replaced.
  const row = (await client.query<{ ready_until_ms: string }>(`SELECT a.ready_until_ms FROM rest_wallet_authority a
    JOIN rest_smart_account_bindings b ON b.account_id=a.account_id AND b.id=a.binding_id
      AND b.authorization_digest=a.binding_authorization_digest AND b.revoked_at IS NULL
    WHERE a.account_id=$1 AND a.snapshot->>'readiness'='verified' AND a.snapshot->'bootstrapRequired'='false'::jsonb
      AND a.snapshot->'activeFence'='null'::jsonb AND a.ready_until_ms IS NOT NULL
      AND b.chain_id=8453 AND 'eip155:8453:' || b.wallet_address=a.account_id
      AND b.document->'authorization'->>'method'='safe-passkey-owner-threshold-and-api-grant'
      AND b.document->'authorization'->>'digest'=a.binding_authorization_digest`, [accountId])).rows[0];
  if (!row) inactiveWalletAppGrant();
  const deadline = Number(row.ready_until_ms);
  if (!Number.isSafeInteger(deadline) || deadline <= await nowMs(client)) inactiveWalletAppGrant();
  return deadline;
}
async function policyGuard(client: PoolClient, grant: Pick<WalletAppGrant, "origin" | "callbackUri" | "appGeneration" | "expiresAt">): Promise<void> {
  try {
    await assertWalletPolicyCallbackInTransaction(client, { origin: grant.origin, callbackUri: grant.callbackUri,
      expectedGeneration: grant.appGeneration, expiresAt: grant.expiresAt * 1000 });
  } catch (error) { if (error instanceof RestError) inactiveWalletAppGrant(); throw error; }
}
function contextOf(input: WalletAppAuthorityContext): WalletAppAuthorityContext {
  const value = walletAppFields(input, ["kind"], ["audience", "origin", "expiresAt", "principalId"]);
  if (value.kind === "request") {
    const v = walletAppFields(input, ["kind", "audience", "origin", "expiresAt"]);
    if (!walletAppTime(v.expiresAt) || (v.origin !== null && typeof v.origin !== "string")) invalidWalletAppGrant();
    return { kind: "request", audience: walletAppAudience(v.audience), origin: v.origin, expiresAt: v.expiresAt };
  }
  if (value.kind === "actor") {
    const v = walletAppFields(input, ["kind", "principalId"], ["audience"]);
    if (typeof v.principalId !== "string" || v.principalId.length > 60) inactiveWalletAppGrant();
    return { kind: "actor", principalId: v.principalId,
      ...(Object.hasOwn(v, "audience") ? { audience: walletAppAudience(v.audience) } : {}) };
  }
  invalidWalletAppGrant();
}
function conflict(): never { throw new RestAuthError("WALLET_AUTHORITY_CONFLICT", 409, "Wallet authority generations changed or reached their bound."); }
function databaseError(error: unknown): never {
  if (error && typeof error === "object" && "code" in error && error.code === "23505")
    throw new RestAuthError("REPLAY", 409, "The grant identifier is already reserved.");
  throw error;
}

/** Typed metadata only. Call the guard inside the transaction that commits an authorized effect. */
export async function getWalletAppGrantInTransaction(client: PoolClient, id: string): Promise<WalletAppGrant | null> {
  if (!walletAppUuid(id)) invalidWalletAppGrant();
  const row = (await client.query<GrantRow>("SELECT * FROM rest_wallet_app_grants WHERE id=$1", [id])).rows[0];
  return row ? grantOf(row) : null;
}

/** Caller owns BEGIN/COMMIT. Locks account, grant, authority and app policy until commit. Repeat after
 * subsequent blocking writes immediately before COMMIT. No pool acquisition, RPC or spending authority.
 * Request context binds audience + Origin; a retained actor must match the exact database incarnation.
 * sessionEpoch is account-wide logout only. External owner changes revoke only after trusted observation. */
export async function assertWalletAppGrantActiveInTransaction(client: PoolClient, input: WalletAppGrant, inputContext: WalletAppAuthorityContext): Promise<void> {
  const grant = validateWalletAppGrant(input), context = contextOf(inputContext);
  await lockAccount(client, grant.accountId);
  const row = (await client.query<GrantRow>("SELECT * FROM rest_wallet_app_grants WHERE id=$1 FOR SHARE", [grant.id])).rows[0];
  if (!row) inactiveWalletAppGrant();
  const current = grantOf(row);
  if (current.revokedAt !== null || JSON.stringify(current) !== JSON.stringify(grant)) inactiveWalletAppGrant();
  const authority = await readAuthority(client, grant.accountId);
  if (authority.authorityEpoch !== grant.authorityEpoch || authority.sessionEpoch !== grant.sessionEpoch) inactiveWalletAppGrant();
  const authorityDeadline = await readyUntil(client, grant.accountId);
  if (context.kind === "request") {
    if (context.audience !== grant.audience || context.origin !== grant.origin) inactiveWalletAppGrant();
  } else if (context.principalId !== walletAppPrincipalId(grant)
    || (context.audience !== undefined && context.audience !== grant.audience)) inactiveWalletAppGrant();
  const expiresAt = context.kind === "request" ? Math.min(grant.expiresAt, context.expiresAt) : grant.expiresAt;
  const before = await now(client);
  if (grant.createdAt > before || expiresAt <= before) inactiveWalletAppGrant();
  await policyGuard(client, { ...grant, expiresAt });
  if (expiresAt <= await now(client) || authorityDeadline <= await nowMs(client)) inactiveWalletAppGrant();
}

/** Internal storage admission only: no public issuance, login, code exchange or canonical epoch producer.
 * A future caller must authenticate enrollment/session authority before constructing admission input.
 * Retained expired/revoked rows count toward quotas; all replicas must configure identical limits. */
export class PostgresWalletAppGrantStore {
  private readonly maxRecords: number;
  private readonly maxAccountRecords: number;
  private readonly maxOriginRecords: number;
  constructor(private readonly pool: Pool, options: { maxRecords?: number; maxAccountRecords?: number; maxOriginRecords?: number } = {}) {
    const v = walletAppFields(options, [], ["maxRecords", "maxAccountRecords", "maxOriginRecords"]);
    this.maxRecords = (v.maxRecords ?? 100000) as number;
    this.maxAccountRecords = (v.maxAccountRecords ?? 256) as number;
    this.maxOriginRecords = (v.maxOriginRecords ?? 32) as number;
    for (const [value, maximum] of [[this.maxRecords, 1000000], [this.maxAccountRecords, 4096], [this.maxOriginRecords, 256]])
      if (!Number.isSafeInteger(value) || value! <= 0 || value! > maximum!) invalidWalletAppGrant();
  }
  async insert(input: WalletAppGrantAdmission): Promise<WalletAppGrant> {
    const request = validateWalletAppGrantAdmission(input), client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Global admission precedes account locks. Identity follows the resolved table across search paths.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('wallet-app-grants:' || 'rest_wallet_app_grants'::regclass::oid::text, 0))");
      await lockAccount(client, request.accountId);
      const authority = await readAuthority(client, request.accountId);
      if (authority.authorityEpoch !== request.expectedAuthorityEpoch || authority.sessionEpoch !== request.expectedSessionEpoch)
        inactiveWalletAppGrant();
      const createdAt = await now(client);
      if (request.expiresAt <= createdAt || request.expiresAt - createdAt > walletAppGrantMaximumLifetimeSeconds) invalidWalletAppGrant();
      await policyGuard(client, { ...request, appGeneration: request.expectedAppGeneration });
      const count = (await client.query<{ total: string; account: string; origin: string }>(`SELECT count(*)::text AS total,
        count(*) FILTER (WHERE account_id=$1)::text AS account,
        count(*) FILTER (WHERE account_id=$1 AND origin=$2)::text AS origin FROM rest_wallet_app_grants`, [request.accountId, request.origin])).rows[0]!;
      if (BigInt(count.total) >= BigInt(this.maxRecords) || BigInt(count.account) >= BigInt(this.maxAccountRecords)
        || BigInt(count.origin) >= BigInt(this.maxOriginRecords))
        throw new RestAuthError("STORAGE_LIMIT", 429, "Wallet application grant storage limit reached.");
      const row = (await client.query<GrantRow>(`INSERT INTO rest_wallet_app_grants(id,account_id,signer_address,origin,callback_uri,audience,
        app_generation,authority_epoch,session_epoch,created_at,expires_at,retain_until)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [randomUUID(), request.accountId, request.signerAddress,
        request.origin, request.callbackUri, request.audience, request.expectedAppGeneration, request.expectedAuthorityEpoch,
        request.expectedSessionEpoch, createdAt, request.expiresAt, request.expiresAt + walletAppGrantRetentionSeconds])).rows[0]!;
      const grant = grantOf(row);
      await assertWalletAppGrantActiveInTransaction(client, grant, { kind: "actor", principalId: walletAppPrincipalId(grant), audience: grant.audience });
      await client.query("COMMIT"); return grant;
    } catch (error) { await client.query("ROLLBACK"); databaseError(error); }
    finally { client.release(); }
  }
  /** Trusted internal revocation primitive; the caller must establish any canonical owner change.
   * No initialization or client-supplied owner observation. Authority changes also invalidate logout generation. */
  async advanceEpochs(input: WalletAuthorityAdvance): Promise<WalletAuthority> {
    const v = walletAppFields(input, ["accountId", "expectedAuthorityEpoch", "expectedSessionEpoch", "kind"]);
    if (!walletAppAccount(v.accountId) || !walletAppBigint(v.expectedAuthorityEpoch) || !walletAppBigint(v.expectedSessionEpoch)
      || (v.kind !== "logout" && v.kind !== "authority")) invalidWalletAppGrant();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN"); await lockAccount(client, v.accountId);
      const prior = await readAuthority(client, v.accountId, true);
      if (prior.authorityEpoch !== v.expectedAuthorityEpoch || prior.sessionEpoch !== v.expectedSessionEpoch) conflict();
      const authorityEpoch = BigInt(prior.authorityEpoch) + (v.kind === "authority" ? 1n : 0n), sessionEpoch = BigInt(prior.sessionEpoch) + 1n;
      if (authorityEpoch > walletAppBigintMaximum || sessionEpoch > walletAppBigintMaximum) conflict();
      const row = (await client.query<AuthorityRow>(`UPDATE rest_wallet_authority SET authority_epoch=$2,session_epoch=$3,
        updated_at=GREATEST(updated_at,${nowSql}) WHERE account_id=$1 RETURNING *`, [v.accountId, authorityEpoch.toString(), sessionEpoch.toString()])).rows[0]!;
      const result = authorityOf(row); await client.query("COMMIT"); return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  /** App-only bounded cleanup. A 24-hour replay grace precedes UUID reuse, which receives a fresh incarnation.
   * Does not reset sequences or delete bot IDs, nonces, operation history or budget reservations.
   * Database restore still requires an explicit epoch/reconciliation fence. */
  async cleanup(limit = 250): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) invalidWalletAppGrant();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const accounts = (await client.query<{ id: string }>(`SELECT id FROM rest_accounts a WHERE EXISTS
        (SELECT 1 FROM rest_wallet_app_grants g WHERE g.account_id=a.id AND g.retain_until<=${nowSql})
        ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit])).rows.map(row => row.id);
      const deleted = (await client.query<{ id: string }>(`WITH eligible AS (SELECT id FROM rest_wallet_app_grants
        WHERE account_id=ANY($1::text[]) AND retain_until<=${nowSql} ORDER BY retain_until,id LIMIT $2 FOR UPDATE SKIP LOCKED)
        DELETE FROM rest_wallet_app_grants g USING eligible e WHERE g.id=e.id RETURNING g.id`, [accounts, limit])).rows.map(row => row.id);
      if (deleted.length) await client.query("DELETE FROM rest_grant_ids WHERE kind='wallet-app' AND id=ANY($1::text[])", [deleted]);
      await client.query("COMMIT"); return deleted.length;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}
