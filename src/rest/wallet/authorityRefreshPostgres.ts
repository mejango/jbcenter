import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { RestError } from "../core.js";
import { walletAppAccount, walletAppFields, walletAppUuid } from "./appGrants.js";
import { walletAuthorityMaximumAgeMs } from "./authority.js";
import type { AuthorityRefreshLease, AuthorityRefreshQueue, AuthorityRefreshRequest,
  AuthorityRefreshResult, AuthorityRefreshStats } from "./authorityRefresh.js";

export interface WalletAuthorityRefreshQueueOptions {
  maxTracked?: number; maxConcurrent?: number; maxStartsPerMinute?: number;
  interestMs?: number; leaseMs?: number; refreshLeadMs?: number;
  verifiedMinRetryMs?: number; backoffBaseMs?: number; backoffMaxMs?: number;
}
const defaults = Object.freeze({ maxTracked: 32, maxConcurrent: 2, maxStartsPerMinute: 30,
  // A lease outlives one hosted observation (~25 s measured, 90 s budget) and its store round trips.
  interestMs: 120_000, leaseMs: 120_000, refreshLeadMs: 60_000,
  verifiedMinRetryMs: 1_000, backoffBaseMs: 2_000, backoffMaxMs: 30_000 });
type Settings = typeof defaults;
type Job = { account_id: string; interested_until_ms: string; due_at_ms: string;
  lease_token: string | null; lease_until_ms: string | null; failures: number };
type Control = { window_start_ms: string; starts_in_window: number; configuration: Record<string, unknown> | null };
const windowMs = 60_000;
const nowSql = "floor(extract(epoch FROM clock_timestamp())*1000)::bigint";
const eligible = (account: string) => `EXISTS (SELECT 1 FROM rest_accounts a
  JOIN rest_wallet_enrollments e ON e.account_id=a.id AND e.state='verified'
  JOIN rest_wallet_credentials c ON c.account_id=a.id AND c.enrollment_id=e.id
    AND c.user_handle=e.user_handle AND c.superseded_at IS NULL
  JOIN rest_smart_account_bindings b ON b.account_id=a.id AND b.chain_id=8453
    AND b.wallet_address=a.owner_address AND b.revoked_at IS NULL
  WHERE a.id=${account} AND a.authority_chain_id=8453
    AND a.id='eip155:8453:' || a.owner_address
    AND b.document->'authorization'->>'method'='safe-passkey-owner-threshold-and-api-grant'
    AND b.document->'authorization'->>'digest'=b.authorization_digest)`;
function invalid(): never {
  throw new RestError(400, "WALLET_AUTHORITY_REFRESH_INVALID", "Authority refresh fields or bounds are invalid.");
}
function fields(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  try { return walletAppFields(value, required, optional); } catch { return invalid(); }
}
function milliseconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
async function databaseNow(client: PoolClient): Promise<number> {
  const value = Number((await client.query<{ now: string }>(`SELECT ${nowSql} AS now`)).rows[0]!.now);
  if (!milliseconds(value) || value > Number.MAX_SAFE_INTEGER - 300_000)
    throw new RestError(503, "WALLET_AUTHORITY_REFRESH_CLOCK_INVALID", "Authority refresh database time is unavailable.");
  return value;
}
class ExpiredLease extends Error {}
class ExpiredInterest extends Error {
  constructor(readonly retryAtMs: number) { super("Authority refresh admission expired."); }
}

/** A bounded internal scheduling queue, never an authority/grant issuer. Leases fence queue
 * completion only; canonical context CAS and original readiness TTL still fence authority writes.
 * All replicas share one persisted configuration and start budget. No RPC occurs in this store. */
export class PostgresWalletAuthorityRefreshQueue implements AuthorityRefreshQueue {
  private readonly settings: Settings;
  constructor(private readonly pool: Pool, options: WalletAuthorityRefreshQueueOptions = {}) {
    const values = fields(options, [], Object.keys(defaults));
    const settings = { ...defaults, ...values } as Settings;
    for (const key of Object.keys(defaults) as Array<keyof Settings>)
      if (!Number.isSafeInteger(settings[key]) || settings[key] < 1 || settings[key] > defaults[key]) invalid();
    if (settings.backoffBaseMs > settings.backoffMaxMs) invalid();
    this.settings = Object.freeze(settings);
  }

  async request(accountId: string): Promise<AuthorityRefreshRequest> {
    if (!walletAppAccount(accountId)) invalid();
    return this.transaction<AuthorityRefreshRequest>(async client => {
      const control = await this.control(client), now = await databaseNow(client);
      if (!(await client.query<{ eligible: boolean }>(`SELECT ${eligible("$1")} AS eligible`, [accountId])).rows[0]!.eligible)
        throw new RestError(403, "WALLET_AUTHORITY_REFRESH_INELIGIBLE", "An enrolled Base wallet with a live passkey binding is required.");
      await this.cleanup(client, now);
      const job = (await client.query<Job>("SELECT * FROM rest_wallet_authority_refresh_jobs WHERE account_id=$1 FOR UPDATE", [accountId])).rows[0];
      if (job) {
        // Demand extends interest but cannot jump the queue or reset failure backoff.
        await this.extendInterest(client, accountId);
        return { status: "coalesced", retryAtMs: this.retryAt(job, control) };
      }
      const capacity = (await client.query<{ total: string; retry_at: string | null }>(`SELECT count(*)::text AS total,
        min(GREATEST(interested_until_ms,COALESCE(lease_until_ms,0)))::text AS retry_at FROM rest_wallet_authority_refresh_jobs`)).rows[0]!;
      if (Number(capacity.total) >= this.settings.maxTracked)
        return { status: "overloaded", retryAtMs: capacity.retry_at === null ? null : Number(capacity.retry_at) };
      await client.query(`INSERT INTO rest_wallet_authority_refresh_jobs(account_id,interested_until_ms,due_at_ms)
        VALUES($1,$2,$3)`, [accountId, now + this.settings.interestMs, now]);
      // The account FK may have waited behind a canonical authority transaction. Queue demand
      // starts its finite interest after that wait; this never changes authority freshness.
      await this.extendInterest(client, accountId);
      return { status: "queued", retryAtMs: control.starts_in_window >= this.settings.maxStartsPerMinute
        ? Number(control.window_start_ms) + windowMs : now };
    }).catch(error => {
      if (error instanceof ExpiredInterest) return { status: "overloaded", retryAtMs: error.retryAtMs };
      throw error;
    });
  }

  async claim(): Promise<AuthorityRefreshLease | null> {
    return this.transaction(async client => {
      const control = await this.control(client), now = await databaseNow(client);
      await this.cleanup(client, now);
      if (control.starts_in_window >= this.settings.maxStartsPerMinute) return null;
      const running = Number((await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM rest_wallet_authority_refresh_jobs WHERE lease_until_ms>$1", [now])).rows[0]!.count);
      if (running >= this.settings.maxConcurrent) return null;
      const job = (await client.query<Job>(`SELECT * FROM rest_wallet_authority_refresh_jobs j
        WHERE interested_until_ms>$1 AND due_at_ms<=$1 AND (lease_until_ms IS NULL OR lease_until_ms<=$1)
          AND ${eligible("j.account_id")}
        ORDER BY due_at_ms,account_id LIMIT 1 FOR UPDATE SKIP LOCKED`, [now])).rows[0];
      if (!job) return null;
      const startedAt = await databaseNow(client);
      if (Number(job.interested_until_ms) <= startedAt) return null;
      const lease = { accountId: job.account_id, token: randomUUID(), untilMs: startedAt + this.settings.leaseMs };
      // Expired crashed jobs rejoin at their lease deadline instead of retaining oldest priority.
      await client.query(`UPDATE rest_wallet_authority_refresh_jobs SET lease_token=$2,lease_until_ms=$3,due_at_ms=$3 WHERE account_id=$1`,
        [lease.accountId, lease.token, lease.untilMs]);
      await client.query("UPDATE rest_wallet_authority_refresh_control SET starts_in_window=starts_in_window+1 WHERE id=1");
      if (lease.untilMs <= await databaseNow(client)) throw new ExpiredLease();
      return lease;
    }).catch(error => { if (error instanceof ExpiredLease) return null; throw error; });
  }

  async complete(inputLease: AuthorityRefreshLease, inputResult: AuthorityRefreshResult): Promise<boolean> {
    const lease = fields(inputLease, ["accountId", "token", "untilMs"]);
    const result = fields(inputResult, ["outcome", "readyUntilMs"]);
    if (!walletAppAccount(lease.accountId) || !walletAppUuid(lease.token) || !milliseconds(lease.untilMs)
      || !["verified", "unready", "conflict", "failed"].includes(result.outcome as string)
      || (result.outcome === "verified" ? !milliseconds(result.readyUntilMs) : result.readyUntilMs !== null)) invalid();
    const until = lease.untilMs, readyUntil = result.readyUntilMs as number | null;
    try {
      return await this.transaction(async client => {
        await this.control(client);
        const job = (await client.query<Job>(`SELECT * FROM rest_wallet_authority_refresh_jobs
          WHERE account_id=$1 AND lease_token=$2 AND lease_until_ms=$3 FOR UPDATE`,
        [lease.accountId, lease.token, until])).rows[0];
        const now = await databaseNow(client);
        if (!job || until <= now) return false;
        const verified = result.outcome === "verified" && readyUntil! > now;
        const failures = verified ? 0 : Math.min(16, job.failures + 1);
        const delay = verified
          ? Math.max(this.settings.verifiedMinRetryMs, Math.min(readyUntil!, now + walletAuthorityMaximumAgeMs) - now - this.settings.refreshLeadMs)
          : Math.min(this.settings.backoffMaxMs, this.settings.backoffBaseMs * 2 ** (failures - 1));
        const changed = await client.query(`UPDATE rest_wallet_authority_refresh_jobs
          SET lease_token=NULL,lease_until_ms=NULL,due_at_ms=$4,failures=$5
          WHERE account_id=$1 AND lease_token=$2 AND lease_until_ms=$3 AND lease_until_ms>${nowSql}
          RETURNING account_id`, [lease.accountId, lease.token, until, now + delay, failures]);
        if (!changed.rowCount) return false;
        // Account/job lock waits and post-write work may consume the original lease.
        if (until <= await databaseNow(client)) throw new ExpiredLease();
        await this.cleanup(client, await databaseNow(client));
        if (until <= await databaseNow(client)) throw new ExpiredLease();
        return true;
      });
    } catch (error) { if (error instanceof ExpiredLease) return false; throw error; }
  }

  async stats(): Promise<AuthorityRefreshStats> {
    return this.transaction(async client => {
      const control = await this.control(client), now = await databaseNow(client);
      await this.cleanup(client, now);
      const row = (await client.query<{ tracked: string; interested: string; due: string; in_flight: string; oldest_due: string | null }>(`SELECT
        count(*)::text AS tracked, count(*) FILTER (WHERE interested_until_ms>$1)::text AS interested,
        count(*) FILTER (WHERE interested_until_ms>$1 AND due_at_ms<=$1 AND (lease_until_ms IS NULL OR lease_until_ms<=$1))::text AS due,
        count(*) FILTER (WHERE lease_until_ms>$1)::text AS in_flight,
        min(due_at_ms) FILTER (WHERE interested_until_ms>$1 AND due_at_ms<=$1 AND (lease_until_ms IS NULL OR lease_until_ms<=$1))::text AS oldest_due
        FROM rest_wallet_authority_refresh_jobs`, [now])).rows[0]!;
      return { tracked: Number(row.tracked), interested: Number(row.interested), due: Number(row.due), inFlight: Number(row.in_flight),
        oldestDueAtMs: row.oldest_due === null ? null : Number(row.oldest_due),
        startsInWindow: control.starts_in_window, maxStartsPerMinute: this.settings.maxStartsPerMinute };
    });
  }

  private retryAt(job: Job, control: Control): number {
    return Math.max(Number(job.due_at_ms), Number(job.lease_until_ms ?? 0),
      control.starts_in_window >= this.settings.maxStartsPerMinute ? Number(control.window_start_ms) + windowMs : 0);
  }
  private async extendInterest(client: PoolClient, accountId: string): Promise<void> {
    const row = (await client.query<{ interested_until_ms: string }>(`UPDATE rest_wallet_authority_refresh_jobs
      SET interested_until_ms=GREATEST(interested_until_ms,${nowSql}+$2) WHERE account_id=$1
      RETURNING interested_until_ms`, [accountId, this.settings.interestMs])).rows[0];
    const after = await databaseNow(client);
    if (!row || Number(row.interested_until_ms) <= after) throw new ExpiredInterest(after);
  }
  private async cleanup(client: PoolClient, now: number): Promise<void> {
    // At most the conservative tracked-account cap is inspected/deleted per operation.
    // In-flight work retains its slot even after interest expires.
    await client.query(`DELETE FROM rest_wallet_authority_refresh_jobs WHERE account_id IN
      (SELECT j.account_id FROM rest_wallet_authority_refresh_jobs j
        WHERE (j.lease_until_ms IS NULL OR j.lease_until_ms<=$1)
          AND (j.interested_until_ms<=$1 OR NOT ${eligible("j.account_id")})
        ORDER BY j.interested_until_ms,j.account_id LIMIT $2 FOR UPDATE SKIP LOCKED)`, [now, this.settings.maxTracked]);
  }
  private async control(client: PoolClient): Promise<Control> {
    // Every queue mutation locks this same persisted coordinator before any job row.
    // No account/authority lock may be held by a caller awaiting this queue.
    const row = (await client.query<Control>("SELECT * FROM rest_wallet_authority_refresh_control WHERE id=1 FOR UPDATE")).rows[0];
    if (!row) throw new RestError(503, "WALLET_AUTHORITY_REFRESH_UNAVAILABLE", "Authority refresh scheduling is unavailable.");
    const now = await databaseNow(client);
    if (row.configuration === null) {
      await client.query("UPDATE rest_wallet_authority_refresh_control SET configuration=$1::jsonb WHERE id=1", [JSON.stringify(this.settings)]);
      row.configuration = this.settings;
    } else if (Object.keys(row.configuration).length !== Object.keys(this.settings).length
      || Object.entries(this.settings).some(([key, value]) => row.configuration![key] !== value)) {
      throw new RestError(409, "WALLET_AUTHORITY_REFRESH_CONFIG_CONFLICT", "Authority refresh replicas must share one bounded configuration.");
    }
    if (Number(row.window_start_ms) > now)
      throw new RestError(503, "WALLET_AUTHORITY_REFRESH_CLOCK_INVALID", "Authority refresh database time moved backwards.");
    if (Number(row.window_start_ms) === 0 || Number(row.window_start_ms) + windowMs <= now) {
      row.window_start_ms = String(now); row.starts_in_window = 0;
      await client.query("UPDATE rest_wallet_authority_refresh_control SET window_start_ms=$1,starts_in_window=0 WHERE id=1", [now]);
    }
    return row;
  }
  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='5000ms'");
      await client.query("SET LOCAL statement_timeout='10000ms'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout='15000ms'");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}
