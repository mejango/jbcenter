import { randomUUID } from "node:crypto";
import { passkeyBindingMethodsSql } from "../smartAccounts/passkeyOnboarding.js";
import type { Pool, PoolClient } from "pg";
import { RestAuthError } from "../auth/store.js";
import { RestError } from "../core.js";
import { inactiveWalletAppGrant, invalidWalletAppGrant, validateWalletAppGrant, validateWalletAppGrantAdmission,
  walletAppAccount, walletAppAudience, walletAppBigint, walletAppBigintMaximum, walletAppFields,
  walletAppGrantMaximumLifetimeSeconds, walletAppGrantRetentionSeconds, walletAppPrincipalId, walletAppTime,
  walletAppUuid, type WalletAppGrant, type WalletAppGrantAdmission, type WalletAppAuthorityContext,
  type WalletAuthority, type WalletAuthorityAdvance } from "./appGrants.js";
import { stable } from "../smartAccounts/service.js";
import type { WalletAuthorityContext, WalletAuthoritySnapshot } from "./authority.js";
import { readWalletAuthorityContextRows, walletAuthorityContextOf, type WalletAuthorityContextRows } from "./authorityPostgres.js";
import { admitWalletPolicyCallback, assertWalletPolicyCallbackInTransaction } from "./policyPostgres.js";

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
async function settledAuthority(client: PoolClient, accountId: string): Promise<void> {
  // Binding writers hold the same account lock. Epoch checks alone cannot revoke a grant after
  // explicit setup is revoked or replaced. The verified identity's age is not a condition here: a
  // grant acts on the account only through steps that verify it at a fresh block.
  const row = (await client.query<{ account_id: string }>(`SELECT a.account_id FROM rest_wallet_authority a
    JOIN rest_smart_account_bindings b ON b.account_id=a.account_id AND b.id=a.binding_id
      AND b.authorization_digest=a.binding_authorization_digest AND b.revoked_at IS NULL
    WHERE a.account_id=$1 AND a.snapshot->>'readiness'='verified' AND jsonb_typeof(a.snapshot->'identity')='object'
      AND a.snapshot->'bootstrapRequired'='false'::jsonb AND a.snapshot->'activeFence'='null'::jsonb
      AND b.chain_id=8453 AND 'eip155:8453:' || b.wallet_address=a.account_id
      AND b.document->'authorization'->>'method' IN (${passkeyBindingMethodsSql})
      AND b.document->'authorization'->>'digest'=a.binding_authorization_digest`, [accountId])).rows[0];
  if (!row) inactiveWalletAppGrant();
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

/** Global admission must precede every account/session/code lock in a composing transaction. */
export async function lockWalletAppGrantAdmissionInTransaction(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('wallet-app-grants:' || 'rest_wallet_app_grants'::regclass::oid::text, 0))");
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
  await settledAuthority(client, grant.accountId);
  if (context.kind === "request") {
    if (context.audience !== grant.audience || context.origin !== grant.origin) inactiveWalletAppGrant();
  } else if (context.principalId !== walletAppPrincipalId(grant)
    || (context.audience !== undefined && context.audience !== grant.audience)) inactiveWalletAppGrant();
  const expiresAt = context.kind === "request" ? Math.min(grant.expiresAt, context.expiresAt) : grant.expiresAt;
  const before = await now(client);
  if (grant.createdAt > before || expiresAt <= before) inactiveWalletAppGrant();
  await policyGuard(client, { ...grant, expiresAt });
  if (expiresAt <= await now(client)) inactiveWalletAppGrant();
}

/** The grant's own clock checks, at a time read after every row the check locked: the grant was
 * issued by then and neither it nor the request has expired. Repeated on its own after a blocking
 * write in the same transaction, since the rows behind the account lock cannot have moved but
 * the clock has. */
export function assertWalletAppGrantTimely(grant: WalletAppGrant, request: { expiresAt: number }, nowSeconds: number): void {
  if (!walletAppTime(nowSeconds)) inactiveWalletAppGrant();
  const expiresAt = Math.min(request.expiresAt, grant.expiresAt);
  if (grant.createdAt > nowSeconds || expiresAt <= nowSeconds) inactiveWalletAppGrant();
}
/** Scheduling identity only, after an exact request signature was verified. The caller captures and
 * validates its complete authority context outside SQL, then claims its nonce in this transaction.
 * Unknown/expired readiness may request observation; known changed, fenced or bootstrap state may
 * not. This never returns a principal, renews readiness, or replaces the full admission guard.
 * Three statements: the account row lock, every other row (share-locking the grant and its policy
 * row) in one, then the clock. The rows are returned for the final guard to check without re-reading. */
export async function assertWalletAppRefreshIdentityInTransaction(client: PoolClient, input: WalletAppGrant,
  inputContext: WalletAppAuthorityContext, expected: WalletAuthorityContext): Promise<{ authority: WalletAuthoritySnapshot; rows: WalletAuthorityContextRows }> {
  const grant = validateWalletAppGrant(input), request = contextOf(inputContext);
  if (request.kind !== "request" || expected.accountId !== grant.accountId) inactiveWalletAppGrant();
  await lockAccount(client, grant.accountId);
  const rows = await readWalletAuthorityContextRows(client, grant.accountId, { grantId: grant.id, origin: grant.origin });
  const current = walletAuthorityContextOf(grant.accountId, rows), authority = current.prior;
  if (!authority || !expected.prior || !authority.identity || authority.bootstrapRequired || authority.activeFence !== null
    || !["verified", "unknown"].includes(authority.readiness)
    || authority.authorityEpoch !== grant.authorityEpoch || authority.sessionEpoch !== grant.sessionEpoch
    || authority.authorityEpoch !== expected.prior.authorityEpoch || authority.sessionEpoch !== expected.prior.sessionEpoch
    || stable(authority.identity) !== stable(expected.prior.identity)
    || stable(authority.historicalVerifiedIdentity) !== stable(authority.identity)
    || stable(current.enrollment) !== stable(expected.enrollment) || stable(current.credential) !== stable(expected.credential)
    || stable(current.binding) !== stable(expected.binding)) inactiveWalletAppGrant();
  const row = rows.grant as GrantRow | undefined;
  if (!row || stable(grantOf(row)) !== stable(grant) || grant.revokedAt !== null
    || request.audience !== grant.audience || request.origin !== grant.origin) inactiveWalletAppGrant();
  const expiresAt = Math.min(request.expiresAt, grant.expiresAt), clock = await nowMs(client);
  assertWalletAppGrantTimely(grant, request, Math.floor(clock / 1000));
  policyOverRow(rows, { ...grant, expiresAt }, clock);
  return { authority, rows };
}
/** The full admission guard's own predicates over rows the identity check just read and locked in
 * this transaction (nothing behind the account lock can have moved), plus the settled-authority
 * join and one clock read after it. */
export async function assertWalletAppGrantActiveOverRows(client: PoolClient, rows: WalletAuthorityContextRows, input: WalletAppGrant,
  inputContext: WalletAppAuthorityContext): Promise<void> {
  const grant = validateWalletAppGrant(input), context = contextOf(inputContext);
  const row = rows.grant as GrantRow | undefined;
  if (!row) inactiveWalletAppGrant();
  const current = grantOf(row);
  if (current.revokedAt !== null || JSON.stringify(current) !== JSON.stringify(grant)) inactiveWalletAppGrant();
  if (!rows.authority) inactiveWalletAppGrant();
  const authority = authorityOf(rows.authority);
  if (authority.authorityEpoch !== grant.authorityEpoch || authority.sessionEpoch !== grant.sessionEpoch) inactiveWalletAppGrant();
  await settledAuthority(client, grant.accountId);
  if (context.kind === "request") {
    if (context.audience !== grant.audience || context.origin !== grant.origin) inactiveWalletAppGrant();
  } else if (context.principalId !== walletAppPrincipalId(grant)
    || (context.audience !== undefined && context.audience !== grant.audience)) inactiveWalletAppGrant();
  const expiresAt = context.kind === "request" ? Math.min(grant.expiresAt, context.expiresAt) : grant.expiresAt;
  const clock = await nowMs(client);
  assertWalletAppGrantTimely(grant, { expiresAt }, Math.floor(clock / 1000));
  policyOverRow(rows, { ...grant, expiresAt }, clock);
}
function policyOverRow(rows: WalletAuthorityContextRows, grant: Pick<WalletAppGrant, "origin" | "callbackUri" | "appGeneration" | "expiresAt">, nowMs: number): void {
  try {
    admitWalletPolicyCallback(rows.policyApp, { origin: grant.origin, callback: grant.callbackUri, generation: grant.appGeneration, expiresAt: grant.expiresAt * 1000 }, nowMs);
  } catch (error) { if (error instanceof RestError) inactiveWalletAppGrant(); throw error; }
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
      await lockWalletAppGrantAdmissionInTransaction(client);
      const grant = await this.insertInTransaction(client, request);
      await client.query("COMMIT"); return grant;
    } catch (error) { await client.query("ROLLBACK"); databaseError(error); }
    finally { client.release(); }
  }
  /** Caller owns BEGIN/COMMIT and must acquire lockWalletAppGrantAdmissionInTransaction
   * before account/session/code locks. Preserves the ordinary insertion's authority, policy,
   * quota and post-write checks without acquiring another pool connection. */
  async insertInTransaction(client: PoolClient, input: WalletAppGrantAdmission): Promise<WalletAppGrant> {
    const request = validateWalletAppGrantAdmission(input);
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
    return grant;
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
