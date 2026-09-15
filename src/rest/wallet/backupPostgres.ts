import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isAddress, type Hex } from "viem";
import { RestError } from "../core.js";
import { walletCeremonyDatabaseNow } from "./ceremoniesPostgres.js";
import { walletBackupKdf, type WalletBackupEnvelope } from "../web/walletBackupPassword.js";

/** Server-side wrap of a browser-sealed envelope: AES-256-GCM under WALLET_BACKUP_WRAP_KEY, bound
 * to the enrollment it belongs to. A database copy alone therefore reveals nothing, and a row
 * moved to another enrollment fails to open. */
export interface WalletBackupWrapped { version: "center-wallet-backup-wrap-v1"; wrapIv: string; wrapped: string }
export interface WalletBackupRead { walletAddress: string; recoveryOwner: string; initializerHash: string; envelope: WalletBackupEnvelope }

const wrapVersion = "center-wallet-backup-wrap-v1";
const base64url = /^[A-Za-z0-9_-]+$/;
function invalid(status = 400): never { throw new RestError(status, "WALLET_BACKUP_INVALID", "The backup envelope is invalid."); }
function keyBytes(key: Hex): Buffer {
  if (typeof key !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new RestError(500, "WALLET_BACKUP_CONFIG_INVALID", "The backup wrap key must be 32 bytes of hex.");
  return Buffer.from(key.slice(2), "hex");
}
const bytes = (value: string, length?: number) => {
  if (typeof value !== "string" || !base64url.test(value) || value.length > 4096) invalid();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value || (length !== undefined && decoded.length !== length)) invalid();
  return decoded;
};

/** Bounded copy of a browser-sealed envelope; the shape is fixed so nothing else is stored. */
export function copyWalletBackupEnvelope(value: unknown): WalletBackupEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const input = value as Record<string, unknown>, keys = Object.keys(input).sort();
  if (keys.join(",") !== "ciphertext,iv,kdf,salt,version" || input.version !== "center-wallet-backup-v1") invalid();
  const kdf = input.kdf as Record<string, unknown> | null;
  if (!kdf || typeof kdf !== "object" || Object.keys(kdf).sort().join(",") !== "n,name,p,r" || kdf.name !== "scrypt"
    || kdf.n !== walletBackupKdf.n || kdf.r !== walletBackupKdf.r || kdf.p !== walletBackupKdf.p) invalid();
  const salt = bytes(input.salt as string, 16), iv = bytes(input.iv as string, 12), ciphertext = bytes(input.ciphertext as string);
  if (ciphertext.length < 16 || ciphertext.length > 1024) invalid();
  return { version: "center-wallet-backup-v1", kdf: { name: "scrypt", n: walletBackupKdf.n, r: walletBackupKdf.r, p: walletBackupKdf.p },
    salt: salt.toString("base64url"), iv: iv.toString("base64url"), ciphertext: ciphertext.toString("base64url") };
}
export function wrapWalletBackup(envelope: WalletBackupEnvelope, key: Hex, enrollmentId: string): WalletBackupWrapped {
  const copy = copyWalletBackupEnvelope(envelope), iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", keyBytes(key), iv);
  cipher.setAAD(Buffer.from(`${wrapVersion}:${enrollmentId}`));
  const body = Buffer.concat([cipher.update(JSON.stringify(copy), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { version: wrapVersion, wrapIv: iv.toString("base64url"), wrapped: body.toString("base64url") };
}
export function unwrapWalletBackup(value: WalletBackupWrapped, key: Hex, enrollmentId: string): WalletBackupEnvelope {
  if (!value || value.version !== wrapVersion) invalid(500);
  const iv = bytes(value.wrapIv, 12), body = bytes(value.wrapped);
  if (body.length < 17) invalid(500);
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyBytes(key), iv);
    decipher.setAAD(Buffer.from(`${wrapVersion}:${enrollmentId}`)); decipher.setAuthTag(body.subarray(body.length - 16));
    const plain = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString("utf8");
    return copyWalletBackupEnvelope(JSON.parse(plain));
  } catch { throw new RestError(500, "WALLET_BACKUP_UNAVAILABLE", "The stored backup could not be opened with the configured key."); }
}

interface Row { enrollment_id: string; version: string; wrap_iv: string; wrapped: string; reads: number; window_started_at: string;
  wallet_address: string | null; recovery_owner: string | null; initializer_hash: string | null }

// ponytail: five reads per wallet per hour, counted on the row; per-client limits if abuse appears.
export const walletBackupReadLimit = Object.freeze({ reads: 5, windowMs: 3_600_000 });

export class PostgresWalletBackupStore {
  private readonly key: Hex;
  constructor(private readonly pool: Pool, options: { wrapKey: Hex }) { keyBytes(options.wrapKey); this.key = options.wrapKey; }

  /** Caller owns the transaction that also creates the enrollment. */
  async saveInTransaction(client: PoolClient, enrollmentId: string, envelope: unknown): Promise<void> {
    const wrapped = wrapWalletBackup(copyWalletBackupEnvelope(envelope), this.key, enrollmentId);
    await client.query(`INSERT INTO rest_wallet_backup_envelopes(enrollment_id,version,wrap_iv,wrapped,created_at) VALUES($1,$2,$3,$4,$5)`,
      [enrollmentId, wrapped.version, wrapped.wrapIv, wrapped.wrapped, await walletCeremonyDatabaseNow(client)]);
  }

  /** The envelope for a verified wallet, or null. Reads are rate-limited per wallet so the sealed
   * words cannot be pulled at will for offline guessing. */
  async read(walletAddress: string): Promise<WalletBackupRead | null> {
    if (typeof walletAddress !== "string" || !isAddress(walletAddress)) invalid();
    const address = walletAddress.toLowerCase(), client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = (await client.query<Row>(
        `SELECT b.*, lower(e.creation->>'address') AS wallet_address, lower(e.intent->>'recoveryOwner') AS recovery_owner,
                e.creation->>'initializerHash' AS initializer_hash
         FROM rest_wallet_backup_envelopes b JOIN rest_wallet_enrollments e ON e.id=b.enrollment_id
         WHERE e.state='verified' AND lower(e.creation->>'address')=$1 FOR UPDATE OF b`, [address])).rows[0];
      if (!row) { await client.query("ROLLBACK"); return null; }
      const now = await walletCeremonyDatabaseNow(client);
      const fresh = now - Number(row.window_started_at) >= walletBackupReadLimit.windowMs, reads = fresh ? 0 : row.reads;
      if (reads >= walletBackupReadLimit.reads) {
        await client.query("ROLLBACK");
        throw new RestError(429, "WALLET_BACKUP_READ_LIMIT", "Too many backup reads for this wallet. Try again later.");
      }
      await client.query(`UPDATE rest_wallet_backup_envelopes SET reads=$2, window_started_at=$3 WHERE enrollment_id=$1`,
        [row.enrollment_id, reads + 1, fresh ? now : Number(row.window_started_at)]);
      await client.query("COMMIT");
      const envelope = unwrapWalletBackup({ version: row.version as WalletBackupWrapped["version"], wrapIv: row.wrap_iv, wrapped: row.wrapped }, this.key, row.enrollment_id);
      return { walletAddress: row.wallet_address!, recoveryOwner: row.recovery_owner!, initializerHash: row.initializer_hash!, envelope };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* already rolled back */ }
      throw error;
    } finally { client.release(); }
  }
}
