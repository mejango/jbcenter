import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { hashTypedData, type Hex } from "viem";
import { RestError } from "../core.js";
import { walletAppAudience, walletAppFields, walletAppPrincipalId, validateWalletAppGrant,
  walletAppUuid, type WalletAppGrant } from "./appGrants.js";
import { assertWalletAppGrantActiveInTransaction, getWalletAppGrantInTransaction, lockWalletAppGrantAdmissionInTransaction,
  PostgresWalletAppGrantStore } from "./appGrantsPostgres.js";
import { assertWalletCentralSessionActiveInTransaction, assertWalletCentralSessionIdentityInTransaction } from "./loginPostgres.js";
import { validateWalletPolicyOrigin } from "./policy.js";
import { assertWalletPolicyCallbackInTransaction } from "./policyPostgres.js";
import { validateWalletHandoffRequest, validateWalletHandoffToken, verifyWalletHandoffRequestSignature,
  verifyWalletHandoffExchange, verifyWalletHandoffLaunchSignature, walletHandoffRequestDocument, walletHandoffCodeHash,
  walletHandoffFutureClockAllowanceMs, type WalletHandoffRequest, type WalletHandoffExchangeInput } from "./handoff.js";

export interface WalletHandoffIntent {
  id: string; request: WalletHandoffRequest; state: "prepared" | "issued" | "consumed";
  createdAtMs: number; expiresAtMs: number;
}
export interface WalletHandoffIssuedCode { code: string; state: string; issuer: string; callbackUri: string }
export interface WalletHandoffExchangeResult { grant: WalletAppGrant; replayed: boolean }
export interface WalletHandoffStoreOptions {
  issuer: string; audience: string; codeLifetimeMs?: number; receiptRetentionMs?: number;
  maxRecords?: number; maxOriginRecords?: number; grantStore?: PostgresWalletAppGrantStore;
}
interface HandoffRow {
  id: string; request_digest: Hex; request: WalletHandoffRequest; origin: string;
  state: "prepared" | "issued" | "consumed"; created_at_ms: string; expires_at_ms: string; retain_until_ms: string;
  session_id: string | null; code_hash: Hex | null; issued_at_ms: string | null; code_expires_at_ms: string | null;
  consumed_at_ms: string | null; exchange_digest: Hex | null; receipt_until_ms: string | null; grant_document: WalletAppGrant | null;
}
function invalid(): never { throw new RestError(400, "WALLET_HANDOFF_INVALID", "Wallet handoff input is invalid."); }
function inactive(): never { throw new RestError(403, "WALLET_HANDOFF_INACTIVE", "Wallet handoff authority is unavailable."); }
function conflict(): never { throw new RestError(409, "WALLET_HANDOFF_CONFLICT", "This handoff cannot be reused; begin a fresh request."); }
/** The app's public origin rides along so the account page can send the person back to it. */
function expired(origin?: string): never { throw new RestError(410, "WALLET_HANDOFF_EXPIRED", "Wallet handoff admission expired.", origin ? { origin } : undefined); }
function fields(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  try { return walletAppFields(value, required, optional); } catch { return invalid(); }
}
function handoffOrigin(value: unknown): string {
  try { return validateWalletPolicyOrigin(value); } catch { return invalid(); }
}
const nowSql = "floor(extract(epoch FROM clock_timestamp())*1000)::bigint";
async function now(client: PoolClient): Promise<number> {
  const value = Number((await client.query<{ now: string }>(`SELECT ${nowSql} AS now`)).rows[0]!.now);
  if (!Number.isSafeInteger(value) || value <= 0) inactive();
  return value;
}
function sameHash(a: Hex | null, b: Hex): boolean {
  return a !== null && /^0x[0-9a-f]{64}$/.test(a) && timingSafeEqual(Buffer.from(a.slice(2), "hex"), Buffer.from(b.slice(2), "hex"));
}
function intent(row: HandoffRow): WalletHandoffIntent {
  const request = validateWalletHandoffRequest(row.request);
  if (!["prepared", "issued", "consumed"].includes(row.state) || row.origin !== request.origin ||
    Number(row.expires_at_ms) !== request.expiresAtMs || !Number.isSafeInteger(Number(row.created_at_ms))) inactive();
  return { id: validateWalletHandoffToken(row.id), request, state: row.state,
    createdAtMs: Number(row.created_at_ms), expiresAtMs: Number(row.expires_at_ms) };
}
async function policy(client: PoolClient, request: WalletHandoffRequest, expiresAt: number) {
  return assertWalletPolicyCallbackInTransaction(client, { origin: request.origin, callbackUri: request.callbackUri,
    expectedGeneration: request.appGeneration, expiresAt });
}

/** Internal protocol composition only. Issue accepts an already authenticated central session.
 * Exchange resolves that originating session from storage and deliberately requires no cookie.
 * No RPC or signature recovery occurs while SQL locks are held. */
export class PostgresWalletHandoffStore {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly codeLifetimeMs: number;
  private readonly receiptRetentionMs: number;
  private readonly maxRecords: number;
  private readonly maxOriginRecords: number;
  private readonly grants: PostgresWalletAppGrantStore;
  constructor(private readonly pool: Pool, options: WalletHandoffStoreOptions) {
    const v = fields(options, ["issuer", "audience"], ["codeLifetimeMs", "receiptRetentionMs", "maxRecords", "maxOriginRecords", "grantStore"]);
    this.issuer = handoffOrigin(v.issuer);
    try { this.audience = walletAppAudience(v.audience); } catch { invalid(); }
    this.codeLifetimeMs = (v.codeLifetimeMs ?? 60_000) as number; this.receiptRetentionMs = (v.receiptRetentionMs ?? 86_400_000) as number;
    this.maxRecords = (v.maxRecords ?? 100_000) as number; this.maxOriginRecords = (v.maxOriginRecords ?? 1024) as number;
    for (const [key, minimum, maximum] of [["codeLifetimeMs", 100, 60_000], ["receiptRetentionMs", 100, 86_400_000],
      ["maxRecords", 1, 1_000_000], ["maxOriginRecords", 1, 10_000]] as const) {
      const value = this[key];
      if ((Object.hasOwn(v, key) && typeof v[key] !== "number") || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
    }
    if (v.grantStore !== undefined && !(v.grantStore instanceof PostgresWalletAppGrantStore)) invalid();
    this.grants = v.grantStore as PostgresWalletAppGrantStore | undefined ?? new PostgresWalletAppGrantStore(pool);
  }
  private configured(request: WalletHandoffRequest, origin?: string) {
    if (request.issuer !== this.issuer || request.audience !== this.audience || (origin !== undefined && origin !== request.origin)) inactive();
  }
  private liveRequest(request: WalletHandoffRequest, time: number) {
    if (request.expiresAtMs <= time) expired(request.origin);
    if (request.issuedAtMs > time + walletHandoffFutureClockAllowanceMs) invalid();
  }
  async prepare(input: { request: WalletHandoffRequest; signature: Hex }, origin: string): Promise<WalletHandoffIntent> {
    const v = fields(input, ["request", "signature"]), request = validateWalletHandoffRequest(v.request);
    if (typeof origin !== "string") invalid();
    this.configured(request, handoffOrigin(origin));
    await verifyWalletHandoffRequestSignature(request, v.signature as Hex);
    const requestDigest = hashTypedData(walletHandoffRequestDocument(request));
    const encoded = JSON.stringify(request), id = randomBytes(32).toString("base64url");
    return this.transaction(async client => {
      // Anonymous intent admission is independent of grant/account locks and is bounded globally.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('wallet-handoffs:' || 'rest_wallet_handoffs'::regclass::oid::text, 0))");
      const time = await now(client); this.liveRequest(request, time);
      const prior = (await client.query<HandoffRow>("SELECT * FROM rest_wallet_handoffs WHERE request_digest=$1", [requestDigest])).rows[0];
      if (prior && prior.state !== "prepared") conflict();
      await policy(client, request, request.expiresAtMs);
      if (prior) {
        if (JSON.stringify(intent(prior).request) !== encoded) conflict();
        this.liveRequest(request, await now(client)); return intent(prior);
      }
      const counts = (await client.query<{ total: string; origin: string }>(`SELECT count(*)::text AS total,
        count(*) FILTER (WHERE origin=$1)::text AS origin FROM rest_wallet_handoffs`, [request.origin])).rows[0]!;
      if (BigInt(counts.total) >= BigInt(this.maxRecords) || BigInt(counts.origin) >= BigInt(this.maxOriginRecords))
        throw new RestError(429, "WALLET_HANDOFF_LIMIT", "Wallet handoff intent storage limit reached.");
      const row = (await client.query<HandoffRow>(`INSERT INTO rest_wallet_handoffs
        (id,request_digest,request,origin,created_at_ms,expires_at_ms,retain_until_ms) VALUES($1,$2,$3::jsonb,$4,$5,$6,$7) RETURNING *`,
      [id, requestDigest, encoded, request.origin, time, request.expiresAtMs, request.expiresAtMs + this.receiptRetentionMs])).rows[0]!;
      await policy(client, request, request.expiresAtMs); this.liveRequest(request, await now(client));
      return intent(row);
    });
  }
  /** Public metadata contains neither a code, code hash, originating session nor account. */
  async getIntent(inputId: string): Promise<WalletHandoffIntent> {
    const id = validateWalletHandoffToken(inputId);
    return this.transaction(async client => {
      const row = (await client.query<HandoffRow>("SELECT * FROM rest_wallet_handoffs WHERE id=$1", [id])).rows[0];
      if (!row) inactive();
      const result = intent(row); this.configured(result.request); this.liveRequest(result.request, await now(client));
      await policy(client, result.request, result.expiresAtMs); return result;
    });
  }
  async issue(inputId: string, inputSessionId: string, launchSignature: Hex): Promise<WalletHandoffIssuedCode> {
    const id = validateWalletHandoffToken(inputId);
    if (typeof launchSignature !== 'string' || !/^0x[0-9a-f]{130}$/.test(launchSignature))
      throw new RestError(403, 'WALLET_HANDOFF_UNCLAIMED', 'Return to the app and start the wallet connection again.');
    const hinted = await this.getIntent(id);
    await verifyWalletHandoffLaunchSignature({ request: hinted.request, intentId: id }, launchSignature);
    const claimedDigest = hashTypedData(walletHandoffRequestDocument(hinted.request));
    if (!walletAppUuid(inputSessionId)) invalid();
    const sessionId = inputSessionId;
    const code = randomBytes(32).toString("base64url"), codeHash = walletHandoffCodeHash(code);
    return this.transaction(async client => {
      // Session guard owns account→enrollment→authority→credential→session before code/policy.
      const session = await assertWalletCentralSessionActiveInTransaction(client, sessionId);
      const row = (await client.query<HandoffRow>("SELECT * FROM rest_wallet_handoffs WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!row || row.request_digest !== claimedDigest) inactive();
      const request = intent(row).request; this.configured(request);
      const time = await now(client); this.liveRequest(request, time);
      if (row.state !== "prepared") conflict();
      const deadline = Math.min(request.expiresAtMs, session.expiresAtMs, time + this.codeLifetimeMs);
      if (deadline <= time) expired();
      await policy(client, request, deadline);
      await client.query(`UPDATE rest_wallet_handoffs SET state='issued',session_id=$2,code_hash=$3,
        issued_at_ms=$4,code_expires_at_ms=$5 WHERE id=$1 AND state='prepared'`, [id, sessionId, codeHash, time, deadline]);
      await assertWalletCentralSessionActiveInTransaction(client, sessionId);
      await policy(client, request, deadline); if (deadline <= await now(client)) expired();
      return { code, state: request.state, issuer: request.issuer, callbackUri: request.callbackUri };
    });
  }
  /** Internal proof-verified refresh identity only. Same immutable receipt/session/current-policy
   * checks as exchange, omitting readiness alone. No code consumption or grant issuance. */
  async identifyExchange(input: WalletHandoffExchangeInput, origin: string): Promise<{ accountId: string }> {
    const { proof, sessionId, requestDigest, encoded } = await this.exchangeContext(input, origin);
    return this.transaction(async client => {
      const session = await assertWalletCentralSessionIdentityInTransaction(client, sessionId);
      const row = (await client.query<HandoffRow>("SELECT * FROM rest_wallet_handoffs WHERE id=$1 FOR UPDATE", [proof.intentId])).rows[0];
      if (!row || row.session_id !== sessionId || !sameHash(row.code_hash, proof.codeHash) || row.request_digest !== requestDigest ||
        JSON.stringify(intent(row).request) !== encoded) inactive();
      const time = await now(client);
      let deadline: number;
      if (row.state === "consumed") {
        if (row.exchange_digest !== proof.exchangeDigest || !row.grant_document || row.receipt_until_ms === null) conflict();
        const grant = validateWalletAppGrant(row.grant_document);
        const current = await getWalletAppGrantInTransaction(client, grant.id);
        if (!current || JSON.stringify(current) !== JSON.stringify(grant) || grant.revokedAt !== null || grant.createdAt * 1000 > time ||
          grant.accountId !== session.accountId || grant.signerAddress !== proof.request.requestKey ||
          grant.authorityEpoch !== session.authorityEpoch || grant.sessionEpoch !== session.sessionEpoch ||
          grant.origin !== proof.request.origin || grant.callbackUri !== proof.request.callbackUri ||
          grant.audience !== proof.request.audience || grant.appGeneration !== proof.request.appGeneration) inactive();
        deadline = Math.min(Number(row.receipt_until_ms), grant.expiresAt * 1000);
      } else {
        if (row.state !== "issued" || row.code_expires_at_ms === null) conflict();
        deadline = Number(row.code_expires_at_ms);
      }
      if (deadline <= await now(client)) expired();
      await policy(client, proof.request, deadline);
      await assertWalletCentralSessionIdentityInTransaction(client, sessionId);
      if (deadline <= await now(client)) expired();
      return { accountId: session.accountId };
    });
  }
  private async exchangeContext(input: WalletHandoffExchangeInput, origin: string) {
    // Copy and recover the complete app request key proof before acquiring a connection/locks.
    const proof = await verifyWalletHandoffExchange(input);
    if (typeof origin !== "string") invalid();
    this.configured(proof.request, handoffOrigin(origin));
    const encoded = JSON.stringify(proof.request), requestDigest = hashTypedData(walletHandoffRequestDocument(proof.request));
    const hint = (await this.pool.query<HandoffRow>("SELECT * FROM rest_wallet_handoffs WHERE id=$1", [proof.intentId])).rows[0];
    if (!hint?.session_id || !sameHash(hint.code_hash, proof.codeHash) || hint.request_digest !== requestDigest ||
      JSON.stringify(intent(hint).request) !== encoded) inactive();
    return { proof, sessionId: hint.session_id, requestDigest, encoded };
  }
  async exchange(input: WalletHandoffExchangeInput, origin: string): Promise<WalletHandoffExchangeResult> {
    const { proof, sessionId, requestDigest, encoded } = await this.exchangeContext(input, origin);
    return this.transaction(async client => {
      await lockWalletAppGrantAdmissionInTransaction(client);
      const session = await assertWalletCentralSessionActiveInTransaction(client, sessionId);
      const row = (await client.query<HandoffRow>("SELECT * FROM rest_wallet_handoffs WHERE id=$1 FOR UPDATE", [proof.intentId])).rows[0];
      if (!row || row.session_id !== sessionId || !sameHash(row.code_hash, proof.codeHash) || row.request_digest !== requestDigest ||
        JSON.stringify(intent(row).request) !== encoded) inactive();
      const time = await now(client);
      if (row.state === "consumed") {
        if (row.exchange_digest !== proof.exchangeDigest || !row.grant_document || row.receipt_until_ms === null) conflict();
        if (Number(row.receipt_until_ms) <= time) expired();
        const grant = validateWalletAppGrant(row.grant_document);
        if (grant.accountId !== session.accountId || grant.signerAddress !== proof.request.requestKey ||
          grant.authorityEpoch !== session.authorityEpoch || grant.sessionEpoch !== session.sessionEpoch ||
          grant.origin !== proof.request.origin || grant.callbackUri !== proof.request.callbackUri || grant.audience !== proof.request.audience ||
          grant.appGeneration !== proof.request.appGeneration) inactive();
        await assertWalletAppGrantActiveInTransaction(client, grant, { kind: "actor", principalId: walletAppPrincipalId(grant), audience: this.audience });
        await assertWalletCentralSessionActiveInTransaction(client, sessionId);
        await policy(client, proof.request, Math.min(Number(row.receipt_until_ms), grant.expiresAt * 1000));
        if (Number(row.receipt_until_ms) <= await now(client)) expired();
        return { grant, replayed: true };
      }
      if (row.state !== "issued" || row.code_expires_at_ms === null) conflict();
      const deadline = Number(row.code_expires_at_ms);
      if (deadline <= time) expired();
      const app = await policy(client, proof.request, deadline);
      // The grant lives for the application's configured lifetime; the central session that signed
      // it in may end sooner (its epoch only changes on logout, which revokes the grant anyway).
      const grant = await this.grants.insertInTransaction(client, { accountId: session.accountId,
        signerAddress: proof.request.requestKey, origin: proof.request.origin, callbackUri: proof.request.callbackUri,
        audience: this.audience, expectedAppGeneration: proof.request.appGeneration,
        expectedAuthorityEpoch: session.authorityEpoch, expectedSessionEpoch: session.sessionEpoch,
        expiresAt: Math.floor((time + app.grantLifetimeSeconds * 1000) / 1000) });
      const receiptUntil = Math.min(Number(row.retain_until_ms), time + this.receiptRetentionMs, session.expiresAtMs, grant.expiresAt * 1000);
      if (receiptUntil <= time) expired();
      await client.query(`UPDATE rest_wallet_handoffs SET state='consumed',consumed_at_ms=$2,exchange_digest=$3,
        receipt_until_ms=$4,grant_document=$5::jsonb WHERE id=$1 AND state='issued'`,
      [row.id, time, proof.exchangeDigest, receiptUntil, JSON.stringify(grant)]);
      // Code/grant/receipt remain one transaction. Every later write wait spends original deadlines.
      await assertWalletCentralSessionActiveInTransaction(client, sessionId);
      await assertWalletAppGrantActiveInTransaction(client, grant, { kind: "actor", principalId: walletAppPrincipalId(grant), audience: this.audience });
      await policy(client, proof.request, deadline);
      if (deadline <= await now(client) || receiptUntil <= await now(client)) expired();
      return { grant, replayed: false };
    });
  }
  async cleanup(limit = 250): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) invalid();
    return this.transaction(async client => {
      // Only bounded protocol receipts are removed. No grant, credential, epoch or liability changes.
      return (await client.query(`WITH expired AS (SELECT id FROM rest_wallet_handoffs WHERE retain_until_ms<=${nowSql}
        ORDER BY retain_until_ms,id LIMIT $1 FOR UPDATE SKIP LOCKED)
        DELETE FROM rest_wallet_handoffs h USING expired e WHERE h.id=e.id`, [limit])).rowCount ?? 0;
    });
  }
  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN"); await client.query("SET LOCAL lock_timeout='5000ms'");
      await client.query("SET LOCAL statement_timeout='10000ms'"); await client.query("SET LOCAL idle_in_transaction_session_timeout='15000ms'");
      const value = await run(client); await client.query("COMMIT"); return value;
    } catch (error) {
      await client.query("ROLLBACK");
      if (error && typeof error === "object" && "code" in error && ["23505", "22003"].includes(String(error.code))) conflict();
      throw error;
    } finally { client.release(); }
  }
}
