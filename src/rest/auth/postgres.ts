import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { Address } from "viem";
import {
  accountStoreLimits,
  actorGrantId,
  assertAccount,
  assertActorAuthority,
  assertGrant,
  assertIdentifier,
  assertProfile,
  assertRequest,
  assertTime,
  authorityRequest,
  cleanupLimit,
  nonceCapacity,
  principalFor,
  RestAuthError,
  type Account,
  type AccountStore,
  type AccountStoreLimits,
  type AccountStoreOptions,
  type ActiveAuthority,
  type BotGrant,
  type BotScope,
  type Profile,
  type RestActor,
  type RestPrincipal,
  type VerifiedRequest,
} from "./store.js";

type AccountRow = QueryResultRow & {
  id: string; owner_address: Address; authority_chain_id: string;
  display_name: string; bio: string; avatar_uri: string | null;
  created_at: string; updated_at: string;
};
type GrantRow = QueryResultRow & {
  id: string; account_id: string; bot_address: Address; scopes: BotScope[]; label: string;
  created_at: string; expires_at: string; revoked_at: string | null;
};
const selectAccount = `SELECT id, owner_address, authority_chain_id, display_name, bio,
  avatar_uri, created_at, updated_at FROM rest_accounts`;
const selectGrant = `SELECT id, account_id, bot_address, scopes, label,
  created_at, expires_at, revoked_at FROM rest_bot_grants`;

function accountFromRow(row: AccountRow): Account {
  return {
    id: row.id, ownerAddress: row.owner_address, authorityChainId: Number(row.authority_chain_id),
    profile: { displayName: row.display_name, bio: row.bio, avatarUri: row.avatar_uri },
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

function grantFromRow(row: GrantRow): BotGrant {
  return {
    id: row.id, accountId: row.account_id, botAddress: row.bot_address, scopes: row.scopes,
    label: row.label, createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
  };
}

async function lockedAccount(client: PoolClient, id: string): Promise<Account> {
  assertIdentifier(id);
  const result = await client.query<AccountRow>(`${selectAccount} WHERE id = $1 FOR UPDATE`, [id]);
  if (!result.rows[0]) throw new RestAuthError("ACCOUNT_NOT_FOUND", 404, "Account not found");
  return accountFromRow(result.rows[0]);
}

async function getGrant(client: PoolClient, id: string | null): Promise<BotGrant | null> {
  if (id === null) return null;
  const result = await client.query<GrantRow>(`${selectGrant} WHERE id = $1`, [id]);
  return result.rows[0] ? grantFromRow(result.rows[0]) : null;
}

/** A shared database clock prevents application instances from disagreeing on replay expiry. */
async function databaseNow(client: Pool | PoolClient): Promise<number> {
  const result = await client.query<{ now: string }>("SELECT floor(extract(epoch FROM clock_timestamp()))::text AS now");
  return Number(result.rows[0]!.now);
}

/**
 * The caller must already have begun a transaction. This retains the account row
 * lock for the caller's atomic durable job claim, and never commits or releases it.
 * The actor must come from an authenticated server-side principal or stored job.
 */
export async function assertRestActorActive(client: PoolClient, actor: RestActor, scopes: BotScope[], now: number): Promise<void> {
  const grantId = actorGrantId(actor);
  assertTime(now);
  const account = await lockedAccount(client, actor.accountId);
  const grant = await getGrant(client, grantId);
  assertActorAuthority(account, grant, actor, scopes, await databaseNow(client));
}

export class PostgresAccountStore implements AccountStore {
  private readonly limits: AccountStoreLimits;

  constructor(readonly pool: Pool, options: AccountStoreOptions = {}) {
    this.limits = accountStoreLimits(options);
  }

  async getAccount(id: string): Promise<Account | null> {
    assertIdentifier(id);
    const result = await this.pool.query<AccountRow>(`${selectAccount} WHERE id = $1`, [id]);
    return result.rows[0] ? accountFromRow(result.rows[0]) : null;
  }

  async enroll(account: Account, request: VerifiedRequest): Promise<RestPrincipal> {
    assertAccount(account);
    assertRequest(request);
    return this.transaction(async (client) => {
      // A shared, bounded enrollment lock also makes the global account quota atomic.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('rest-account-enrollment'))");
      if (request.accountId !== account.id || request.grantId !== null
        || request.signer.toLowerCase() !== account.ownerAddress.toLowerCase()) {
        throw new RestAuthError("FORBIDDEN", 403, "Only the owner can enroll an account");
      }
      const existing = await client.query<AccountRow>(`${selectAccount} WHERE id = $1 FOR UPDATE`, [account.id]);
      let value: Account;
      if (existing.rows[0]) {
        value = accountFromRow(existing.rows[0]);
        if (value.ownerAddress.toLowerCase() !== account.ownerAddress.toLowerCase()
          || value.authorityChainId !== account.authorityChainId) {
          throw new RestAuthError("FORBIDDEN", 403, "Account identity does not match its owner");
        }
      } else {
        const owner = await client.query("SELECT 1 FROM rest_accounts WHERE authority_chain_id = $1 AND owner_address = $2", [
          account.authorityChainId, account.ownerAddress.toLowerCase(),
        ]);
        if (owner.rowCount) throw new RestAuthError("FORBIDDEN", 403, "Account identity does not match its owner");
        const usage = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM (SELECT 1 FROM rest_accounts LIMIT $1) bounded", [this.limits.maxAccounts],
        );
        if (Number(usage.rows[0]!.count) >= this.limits.maxAccounts) {
          throw new RestAuthError("STORAGE_LIMIT", 429, "Account storage limit exceeded");
        }
        const createdAt = await databaseNow(client);
        const inserted = await client.query<AccountRow>(
          `INSERT INTO rest_accounts (id, owner_address, authority_chain_id, display_name, bio, avatar_uri, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [account.id, account.ownerAddress.toLowerCase(), account.authorityChainId, account.profile.displayName,
            account.profile.bio, account.profile.avatarUri, createdAt, createdAt],
        );
        value = accountFromRow(inserted.rows[0]!);
      }
      const currentRequest = { ...request, now: await databaseNow(client) };
      assertRequest(currentRequest);
      principalFor(value, null, currentRequest);
      await this.consumeNonce(client, currentRequest);
      // Cleanup may run while the nonce queries await I/O. A request that expired
      // in that interval must roll back, even if its old replay record was removed.
      const completedRequest = { ...request, now: await databaseNow(client) };
      assertRequest(completedRequest);
      return principalFor(value, null, completedRequest);
    });
  }

  async authorizeAndConsume(request: VerifiedRequest): Promise<RestPrincipal> {
    assertRequest(request);
    return this.transaction(async (client) => {
      const account = await lockedAccount(client, request.accountId);
      const grant = await getGrant(client, request.grantId);
      const currentRequest = { ...request, now: await databaseNow(client) };
      assertRequest(currentRequest);
      principalFor(account, grant, currentRequest);
      await this.consumeNonce(client, currentRequest);
      const completedRequest = { ...request, now: await databaseNow(client) };
      assertRequest(completedRequest);
      return principalFor(account, grant, completedRequest);
    });
  }

  async assertActive(authority: ActiveAuthority): Promise<void> {
    const request = authorityRequest(authority);
    await this.transaction(async (client) => {
      const account = await lockedAccount(client, authority.accountId);
      const grant = await getGrant(client, authority.grantId);
      principalFor(account, grant, { ...request, now: await databaseNow(client) });
    });
  }

  async withActiveActor<T>(actor: RestActor, scopes: BotScope[], now: number, operation: () => Promise<T>): Promise<T> {
    return this.transaction(async (client) => {
      await assertRestActorActive(client, actor, scopes, now);
      return operation();
    });
  }

  async updateProfile(accountId: string, profile: Profile, now: number): Promise<Account> {
    assertIdentifier(accountId);
    assertProfile(profile);
    assertTime(now);
    return this.transaction(async (client) => {
      await lockedAccount(client, accountId);
      const updatedAt = await databaseNow(client);
      const result = await client.query<AccountRow>(
        `UPDATE rest_accounts SET display_name = $2, bio = $3, avatar_uri = $4, updated_at = greatest(updated_at, $5)
         WHERE id = $1 RETURNING *`, [accountId, profile.displayName, profile.bio, profile.avatarUri, updatedAt],
      );
      return accountFromRow(result.rows[0]!);
    });
  }

  async listBots(accountId: string): Promise<BotGrant[]> {
    assertIdentifier(accountId);
    if (!await this.getAccount(accountId)) throw new RestAuthError("ACCOUNT_NOT_FOUND", 404, "Account not found");
    const result = await this.pool.query<GrantRow>(`${selectGrant} WHERE account_id = $1 ORDER BY created_at, id`, [accountId]);
    return result.rows.map(grantFromRow);
  }

  async registerBot(grant: BotGrant): Promise<BotGrant> {
    assertGrant(grant);
    return this.transaction(async (client) => {
      await lockedAccount(client, grant.accountId);
      const existing = await getGrant(client, grant.id);
      if (existing) throw new RestAuthError("REPLAY", 409, "Bot grant identifier already exists");
      const usage = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM rest_bot_grants WHERE account_id = $1", [grant.accountId],
      );
      if (Number(usage.rows[0]!.count) >= this.limits.maxGrantsPerAccount) {
        throw new RestAuthError("STORAGE_LIMIT", 429, "Account bot grant storage limit exceeded");
      }
      const createdAt = await databaseNow(client);
      if (grant.expiresAt <= createdAt || grant.expiresAt - createdAt > 365 * 86_400) {
        throw new RestAuthError("FORBIDDEN", 403, "Bot grant expiry must be within one year");
      }
      const result = await client.query<GrantRow>(
        `INSERT INTO rest_bot_grants (id, account_id, bot_address, scopes, label, created_at, expires_at, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL) ON CONFLICT (id) DO NOTHING RETURNING *`,
        [grant.id, grant.accountId, grant.botAddress.toLowerCase(), grant.scopes, grant.label, createdAt, grant.expiresAt],
      );
      if (!result.rows[0]) throw new RestAuthError("REPLAY", 409, "Bot grant identifier already exists");
      return grantFromRow(result.rows[0]);
    });
  }

  async revokeBot(accountId: string, grantId: string, now: number): Promise<BotGrant> {
    assertIdentifier(accountId);
    assertIdentifier(grantId);
    assertTime(now);
    return this.transaction(async (client) => {
      await lockedAccount(client, accountId);
      const revokedAt = await databaseNow(client);
      const result = await client.query<GrantRow>(
        `UPDATE rest_bot_grants SET revoked_at = coalesce(revoked_at, greatest(created_at, $3))
         WHERE id = $1 AND account_id = $2 RETURNING *`, [grantId, accountId, revokedAt],
      );
      if (!result.rows[0]) throw new RestAuthError("GRANT_NOT_FOUND", 404, "Bot grant not found");
      return grantFromRow(result.rows[0]);
    });
  }

  async cleanupExpiredNonces(now: number, limit?: number): Promise<number> {
    assertTime(now);
    const maximum = cleanupLimit(limit);
    const currentTime = await databaseNow(this.pool);
    const result = await this.pool.query(
      `WITH expired AS (
         SELECT account_id, nonce FROM rest_request_nonces WHERE expires_at <= $1
         ORDER BY expires_at, account_id, nonce LIMIT $2 FOR UPDATE SKIP LOCKED
       ) DELETE FROM rest_request_nonces stored USING expired
       WHERE stored.account_id = expired.account_id AND stored.nonce = expired.nonce`, [currentTime, maximum],
    );
    return result.rowCount ?? 0;
  }

  private async consumeNonce(client: PoolClient, request: VerifiedRequest): Promise<void> {
    await client.query(
      `DELETE FROM rest_request_nonces WHERE (account_id, nonce) IN (
         SELECT account_id, nonce FROM rest_request_nonces WHERE account_id = $1 AND expires_at <= $2 LIMIT 1000
       )`, [request.accountId, request.now],
    );
    const nonce = request.nonce.toLowerCase();
    const existing = await client.query("SELECT 1 FROM rest_request_nonces WHERE account_id = $1 AND nonce = $2", [request.accountId, nonce]);
    if (existing.rowCount) throw new RestAuthError("REPLAY", 409, "Authenticated request nonce was already used");
    const usage = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM rest_request_nonces WHERE account_id = $1", [request.accountId],
    );
    if (Number(usage.rows[0]!.count) >= nonceCapacity(this.limits.maxNoncesPerAccount, request.grantId)) {
      throw new RestAuthError("STORAGE_LIMIT", 429, "Account request nonce storage limit exceeded");
    }
    const result = await client.query(
      `INSERT INTO rest_request_nonces (account_id, nonce, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (account_id, nonce) DO NOTHING RETURNING nonce`, [request.accountId, nonce, request.expiresAt],
    );
    if (!result.rowCount) throw new RestAuthError("REPLAY", 409, "Authenticated request nonce was already used");
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      try {
        const value = await operation(client);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    } finally {
      client.release();
    }
  }
}
