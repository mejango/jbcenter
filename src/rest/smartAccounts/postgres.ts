import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { Hex } from "viem";
import { RestError } from "../core.js";
import { fingerprint, stable } from "./service.js";
import type {
  SmartAccountBinding,
  VerifiedSmartAccountRegistry,
} from "./types.js";

type Row = QueryResultRow & {
  document: SmartAccountBinding;
  revoked_at: string | null;
};
const error = (code: string, message: string, status = 409) =>
  new RestError(status, code, message);
/** Durable owner-isolated registry. Account row locks serialize nonce claims, binding changes and revocation. */
export class PostgresSmartAccountRegistry
  implements VerifiedSmartAccountRegistry
{
  constructor(private readonly pool: Pool) {}
  private async transaction<T>(operation: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  private async lock(client: PoolClient, accountId: string) {
    const account = await client.query<{ owner_address: string }>(
      "SELECT owner_address FROM rest_accounts WHERE id=$1 FOR UPDATE",
      [accountId],
    );
    if (!account.rows[0])
      throw error(
        "SMART_ACCOUNT_NOT_FOUND",
        "The authenticated API account is absent.",
        404,
      );
    const clock = await client.query<{ now: string }>(
      "SELECT floor(extract(epoch FROM clock_timestamp()))::text AS now",
    );
    return {
      owner: account.rows[0].owner_address,
      now: Number(clock.rows[0]!.now),
    };
  }
  async bind(record: SmartAccountBinding): Promise<SmartAccountBinding> {
    const encoded = stable(record);
    if (
      Buffer.byteLength(encoded) > 60000 ||
      record.id !==
        fingerprint({
          ownerAccountId: record.ownerAccountId,
          wallet: record.wallet.address,
          chainId: record.wallet.chainId,
        }) ||
      record.authorization.method !== "safe-current-owner-threshold" ||
      record.state.address !== record.wallet.address ||
      record.state.chainId !== record.wallet.chainId ||
      record.manifestId !== record.state.manifestId
    )
      throw error(
        "SMART_BINDING_INVALID",
        "The verified account record is inconsistent or exceeds its storage bound.",
        400,
      );
    return this.transaction(async (client) => {
      const locked = await this.lock(client, record.ownerAccountId);
      if (locked.owner.toLowerCase() !== record.ownerAddress.toLowerCase())
        throw error(
          "SMART_OWNER_MISMATCH",
          "Binding owner differs from its API account.",
          403,
        );
      if (
        record.authorization.expiresAt <= locked.now ||
        record.authorization.expiresAt > locked.now + 900
      )
        throw error(
          "SMART_BINDING_EXPIRED",
          "Owner account binding authorization expired or exceeds fifteen minutes.",
        );
      await client.query(
        "DELETE FROM rest_smart_account_binding_nonces WHERE account_id=$1 AND expires_at<=$2",
        [record.ownerAccountId, locked.now],
      );
      const used = await client.query<{ digest: string }>(
        "SELECT digest FROM rest_smart_account_binding_nonces WHERE account_id=$1 AND nonce=$2",
        [record.ownerAccountId, record.authorization.nonce.toLowerCase()],
      );
      const existing = await client.query<Row>(
        "SELECT document,revoked_at FROM rest_smart_account_bindings WHERE account_id=$1 AND id=$2",
        [record.ownerAccountId, record.id],
      );
      if (used.rows[0]) {
        if (used.rows[0].digest !== record.authorization.digest)
          throw error(
            "SMART_BINDING_NONCE_REPLAY",
            "The binding nonce was used for another authorization.",
          );
        const row = existing.rows[0];
        if (
          !row ||
          row.revoked_at !== null ||
          row.document.authorization.digest !== record.authorization.digest
        )
          throw error(
            "SMART_BINDING_REVOKED",
            "A revoked or superseded signature cannot restore the wallet binding.",
          );
        return row.document;
      }
      const counts = await client.query<{ bindings: string; nonces: string }>(
        "SELECT (SELECT count(*) FROM rest_smart_account_bindings WHERE account_id=$1)::text AS bindings,(SELECT count(*) FROM rest_smart_account_binding_nonces WHERE account_id=$1)::text AS nonces",
        [record.ownerAccountId],
      );
      if (
        (!existing.rows[0] && Number(counts.rows[0]!.bindings) >= 16) ||
        Number(counts.rows[0]!.nonces) >= 256
      )
        throw error(
          "SMART_REGISTRY_CAPACITY",
          "The account exceeds its bounded wallet or live binding-authorization limit.",
          429,
        );
      await client.query(
        "INSERT INTO rest_smart_account_binding_nonces(account_id,nonce,digest,expires_at) VALUES($1,$2,$3,$4)",
        [
          record.ownerAccountId,
          record.authorization.nonce.toLowerCase(),
          record.authorization.digest,
          record.authorization.expiresAt,
        ],
      );
      await client.query(
        `INSERT INTO rest_smart_account_bindings(account_id,id,chain_id,wallet_address,authorization_digest,created_at,updated_at,document)
        VALUES($1,$2,$3,$4,$5,$6,$6,$7::jsonb)
        ON CONFLICT(account_id,id) DO UPDATE SET authorization_digest=EXCLUDED.authorization_digest,updated_at=EXCLUDED.updated_at,document=EXCLUDED.document,revoked_at=NULL`,
        [
          record.ownerAccountId,
          record.id,
          record.wallet.chainId,
          record.wallet.address.toLowerCase(),
          record.authorization.digest,
          locked.now,
          encoded,
        ],
      );
      return structuredClone(record);
    });
  }
  async get(ownerAccountId: string, id: Hex) {
    const row = await this.pool.query<Row>(
      "SELECT document,revoked_at FROM rest_smart_account_bindings WHERE account_id=$1 AND id=$2 AND revoked_at IS NULL",
      [ownerAccountId, id],
    );
    return row.rows[0]?.document;
  }
  async list(ownerAccountId: string) {
    const rows = await this.pool.query<Row>(
      'SELECT document,revoked_at FROM rest_smart_account_bindings WHERE account_id=$1 AND revoked_at IS NULL ORDER BY id COLLATE "C" LIMIT 16',
      [ownerAccountId],
    );
    return rows.rows.map((row) => row.document);
  }
  async revoke(ownerAccountId: string, id: Hex) {
    await this.transaction(async (client) => {
      const locked = await this.lock(client, ownerAccountId);
      await client.query(
        "UPDATE rest_smart_account_bindings SET revoked_at=COALESCE(revoked_at,$3),updated_at=$3 WHERE account_id=$1 AND id=$2",
        [ownerAccountId, id, locked.now],
      );
    });
  }
}
