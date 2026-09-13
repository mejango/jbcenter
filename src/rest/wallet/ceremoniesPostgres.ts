import type { Pool, PoolClient } from "pg";
import { RestError } from "../core.js";
import {
  assertWalletCeremonyDraft, invalidWalletCeremony, sameWalletCeremony, walletCeremonyMaxLifetimeMs, walletCeremonyRetentionMs,
  type TrustedWalletControlAdmission, type WalletCeremony, type WalletCeremonyConsume, type WalletCeremonyDraft,
  type WalletCeremonyPurpose, type WalletControlCeremonyDraft,
} from "./ceremonies.js";

interface CeremonyRow {
  id: string; account_id: string; purpose: WalletCeremonyPurpose; context_digest: string; challenge: string;
  created_at: string; expires_at: string; retain_until: string; consumed_at: string | null; proof_digest: string | null; result_id: string | null;
}
const nowSql = "floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint";
const recordOf = (row: CeremonyRow): WalletCeremony => ({
  id: row.id, accountId: row.account_id, purpose: row.purpose, contextDigest: row.context_digest, challenge: row.challenge,
  createdAt: Number(row.created_at), expiresAt: Number(row.expires_at), retainUntil: Number(row.retain_until),
  consumedAt: row.consumed_at === null ? null : Number(row.consumed_at), proofDigest: row.proof_digest, resultId: row.result_id,
});
export async function walletCeremonyDatabaseNow(client: PoolClient) {
  return Number((await client.query<{ now: string }>(`SELECT ${nowSql} AS now`)).rows[0]!.now);
}
/** Compound workflows acquire admission before their own rows and then ceremony rows. */
export async function lockWalletCeremonyAdmission(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':wallet-ceremonies', 0))");
}

function conflict(): never {
  throw new RestError(409, "WALLET_CEREMONY_CONFLICT", "Wallet ceremony does not match the trusted context.");
}
function expired(): never {
  throw new RestError(410, "WALLET_CEREMONY_EXPIRED", "Wallet ceremony has expired; create a fresh challenge.");
}

/**
 * Durable one-use storage only: the caller must verify the loaded trusted challenge and fresh
 * canonical authority before consume. No method returns authentication or spending authority.
 * A replay is a recovery receipt, never fresh authorization. Referenced operations and budgets
 * have their own durable lifecycle; challenge cleanup must not release or retry them.
 * Ordinary issue never uses reserved capacity, including registration and anonymous login.
 * Only a trusted internal existing-wallet workflow may call issueControl after prior verification.
 * Slot reservation does not guarantee pool/lock fairness or protection from every denial of service.
 * All replicas must use the same admission limits.
 */
export class PostgresWalletCeremonyStore {
  private readonly maxRecords: number;
  private readonly maxAccountRecords: number;
  private readonly reservedControlRecords: number;
  private readonly reservedControlAccountRecords: number;

  constructor(private readonly pool: Pool, options: {
    maxRecords?: number; maxAccountRecords?: number; reservedControlRecords?: number; reservedControlAccountRecords?: number;
  } = {}) {
    this.maxRecords = options.maxRecords ?? 100_000;
    this.maxAccountRecords = options.maxAccountRecords ?? 256;
    this.reservedControlRecords = options.reservedControlRecords ?? Math.min(10_000, Math.floor(this.maxRecords / 2));
    this.reservedControlAccountRecords = options.reservedControlAccountRecords ?? Math.min(32, Math.floor(this.maxAccountRecords / 2));
    if (![this.maxRecords, this.maxAccountRecords].every(value => Number.isSafeInteger(value) && value > 1 && value <= 1_000_000)
      || !Number.isSafeInteger(this.reservedControlRecords) || this.reservedControlRecords <= 0 || this.reservedControlRecords >= this.maxRecords
      || !Number.isSafeInteger(this.reservedControlAccountRecords) || this.reservedControlAccountRecords <= 0
      || this.reservedControlAccountRecords >= this.maxAccountRecords)
      invalidWalletCeremony();
  }

  issue(input: WalletCeremonyDraft): Promise<WalletCeremony> {
    return this.issueAdmitted(input, null);
  }

  /** Internal admission only. Verifying the existing wallet and fresh authority is the caller's job;
   * a client-supplied purpose/account ID or anonymous discoverable login cannot establish this context. */
  issueControl(input: WalletControlCeremonyDraft, trustedExistingWallet: TrustedWalletControlAdmission): Promise<WalletCeremony> {
    return this.issueAdmitted(input, trustedExistingWallet);
  }

  private issueAdmitted(input: WalletCeremonyDraft, trustedExistingWallet: TrustedWalletControlAdmission | null): Promise<WalletCeremony> {
    const request = structuredClone(input), admission = structuredClone(trustedExistingWallet);
    return this.transaction(client => this.issueInTransaction(client, request, admission));
  }

  /** Internal SQL helper: caller owns BEGIN/COMMIT and must acquire admission before other rows.
   * Never call ordinary issue() inside another transaction: it obtains another pool connection. */
  async issueInTransaction(client: PoolClient, input: WalletCeremonyDraft, trustedExistingWallet: TrustedWalletControlAdmission | null): Promise<WalletCeremony> {
    const request = structuredClone(input);
    const admission = structuredClone(trustedExistingWallet);
    assertWalletCeremonyDraft(request);
    if (admission !== null && (!admission || Object.keys(admission).length !== 3
      || admission.accountId !== request.accountId || admission.contextDigest !== request.contextDigest
      || typeof admission.verifiedProofDigest !== "string" || !/^[0-9a-f]{64}$/.test(admission.verifiedProofDigest)
      || !["login", "rotate"].includes(request.purpose))) invalidWalletCeremony();
    try {
      // ponytail: a global issuance lock caps unauthenticated storage; shard admission counters if measured contention warrants it.
      await lockWalletCeremonyAdmission(client);
      await this.cleanupInTransaction(client, 100);
      const prior = (await client.query<CeremonyRow>("SELECT * FROM rest_wallet_ceremonies WHERE id=$1 FOR UPDATE", [request.id])).rows[0];
      if (prior) {
        const record = recordOf(prior);
        if (!sameWalletCeremony(record, request)) conflict();
        if (record.retainUntil <= await walletCeremonyDatabaseNow(client)) expired();
        return record;
      }
      const now = await walletCeremonyDatabaseNow(client);
      if (request.expiresAt <= now) expired();
      if (request.expiresAt > now + walletCeremonyMaxLifetimeMs) invalidWalletCeremony();
      const counts = (await client.query<{ total: number; account: number }>(
        "SELECT count(*)::int AS total, count(*) FILTER (WHERE account_id=$1)::int AS account FROM rest_wallet_ceremonies", [request.accountId],
      )).rows[0]!;
      const control = admission !== null;
      const totalLimit = this.maxRecords - (control ? 0 : this.reservedControlRecords);
      const accountLimit = this.maxAccountRecords - (control ? 0 : this.reservedControlAccountRecords);
      if (counts.total >= totalLimit || counts.account >= accountLimit)
        throw new RestError(429, "WALLET_CEREMONY_LIMIT", "Wallet ceremony storage admission limit reached.");
      const row = (await client.query<CeremonyRow>(
        `INSERT INTO rest_wallet_ceremonies(id,account_id,purpose,context_digest,challenge,created_at,expires_at,retain_until)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [request.id, request.accountId, request.purpose, request.contextDigest, request.challenge, now, request.expiresAt, request.expiresAt + walletCeremonyRetentionMs],
      )).rows[0]!;
      if (request.expiresAt <= await walletCeremonyDatabaseNow(client)) expired();
      return recordOf(row);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "23505") conflict();
      throw error;
    }
  }

  async get(input: Pick<WalletCeremonyDraft, "id" | "accountId">): Promise<WalletCeremony | null> {
    if (!input || Object.keys(input).length !== 2 || typeof input.id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.id)
      || typeof input.accountId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/.test(input.accountId)) invalidWalletCeremony();
    const row = (await this.pool.query<CeremonyRow>(
      `SELECT * FROM rest_wallet_ceremonies WHERE id=$1 AND account_id=$2 AND retain_until > ${nowSql}`, [input.id, input.accountId],
    )).rows[0];
    return row ? recordOf(row) : null;
  }

  consume(input: WalletCeremonyConsume): Promise<{ record: WalletCeremony; replayed: boolean }> {
    const request = structuredClone(input);
    return this.transaction(client => this.consumeInTransaction(client, request));
  }

  /** Internal SQL helper. No transaction boundary, pool acquisition, authentication or external effect. */
  async consumeInTransaction(client: PoolClient, input: WalletCeremonyConsume): Promise<{ record: WalletCeremony; replayed: boolean }> {
    const request = structuredClone(input);
    assertWalletCeremonyDraft(request, true);
    const row = (await client.query<CeremonyRow>("SELECT * FROM rest_wallet_ceremonies WHERE id=$1 FOR UPDATE", [request.id])).rows[0];
    if (!row || Number(row.retain_until) <= await walletCeremonyDatabaseNow(client))
      throw new RestError(404, "WALLET_CEREMONY_NOT_FOUND", "Wallet ceremony receipt is unavailable.");
    const record = recordOf(row);
    if (!sameWalletCeremony(record, request)) conflict();
    if (record.consumedAt !== null) {
      if (record.proofDigest !== request.proofDigest || record.resultId !== request.resultId)
        throw new RestError(409, "WALLET_CEREMONY_REPLAY", "Wallet ceremony was consumed by a different proof or operation.");
      return { record, replayed: true };
    }
    const updated = (await client.query<CeremonyRow>(
      `UPDATE rest_wallet_ceremonies SET consumed_at=${nowSql}, proof_digest=$2, result_id=$3
       WHERE id=$1 AND expires_at > ${nowSql} RETURNING *`, [request.id, request.proofDigest, request.resultId],
    )).rows[0];
    if (!updated || request.expiresAt <= await walletCeremonyDatabaseNow(client)) expired();
    // The compound caller repeats the DB live check after its remaining writes and before COMMIT.
    return { record: recordOf(updated), replayed: false };
  }

  async cleanup(limit = 1_000): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) invalidWalletCeremony();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const deleted = await this.cleanupInTransaction(client, limit);
      await client.query("COMMIT");
      return deleted;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      // Helpers check the DB wall clock just before returning; no application I/O precedes COMMIT.
      // PostgreSQL cannot make that finite commit interval zero or establish later execution freshness.
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  private async cleanupInTransaction(client: PoolClient, limit: number): Promise<number> {
    const result = await client.query(
      `DELETE FROM rest_wallet_ceremonies WHERE id IN
       (SELECT id FROM rest_wallet_ceremonies WHERE retain_until <= ${nowSql} ORDER BY retain_until,id LIMIT $1 FOR UPDATE SKIP LOCKED)`, [limit],
    );
    return result.rowCount ?? 0;
  }
}
