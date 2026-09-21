import type { Pool } from "pg";
import type { Hex } from "viem";
import { RestError } from "../core.js";

/** Trusted inspector output only. A checkpoint is rechecked against canonical chain state on every use. */
export interface Safe7579HistoryCheckpoint {
  schemaVersion: 2;
  key: string;
  creationBlock: string;
  creationHash: Hex;
  creationTransaction: Hex;
  initializerHash: Hex;
  lastBlock: string;
  lastHash: Hex;
  authorityHash: Hex;
  lifecycleChanges: number;
  sessionAdministration: { epoch: string; hash: Hex; lastInitialization?: { epoch: string; permissionIds: Hex[] } };
}
export interface Safe7579CheckpointStore {
  get(key: string): Promise<readonly Safe7579HistoryCheckpoint[]>;
  put(checkpoint: Safe7579HistoryCheckpoint): Promise<void>;
}
export interface Safe7579CheckpointOptions { maxKeys?: number; historyBuckets?: number }
const keyPattern = /^[1-9][0-9]{0,15}:0x[0-9a-f]{40}:0x[0-9a-f]{64}:0x[0-9a-f]{64}$/;
const hexHash = /^0x[0-9a-fA-F]{64}$/;
const decimal = /^(0|[1-9][0-9]{0,77})$/;
const fields = ["schemaVersion", "key", "creationBlock", "creationHash", "creationTransaction", "initializerHash", "lastBlock", "lastHash", "authorityHash", "lifecycleChanges", "sessionAdministration"].sort();
function invalid(message: string): never { throw new RestError(503, "SMART_CHECKPOINT_INVALID", message); }
function assertKey(key: string) {
  if (typeof key !== "string" || !keyPattern.test(key) || !Number.isSafeInteger(Number(key.split(":", 1)[0])))
    invalid("The checkpoint requires an exact chain, wallet, manifest and utility runtime identity.");
}
function validate(value: Safe7579HistoryCheckpoint): Safe7579HistoryCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== fields.join(","))
    invalid("The checkpoint has an unsupported shape.");
  assertKey(value.key);
  const admin = value.sessionAdministration;
  const uint = (item: unknown): item is string => typeof item === "string" && decimal.test(item) && BigInt(item) < 2n ** 256n;
  if (!admin || typeof admin !== "object" || Array.isArray(admin) || !uint(admin.epoch) || typeof admin.hash !== "string" || !hexHash.test(admin.hash)
    || Object.keys(admin).some(key => !["epoch", "hash", "lastInitialization"].includes(key))) invalid("The session administration checkpoint is missing or malformed.");
  if (admin.lastInitialization !== undefined && (!admin.lastInitialization || typeof admin.lastInitialization !== "object" || Array.isArray(admin.lastInitialization)
    || !uint(admin.lastInitialization.epoch) || BigInt(admin.lastInitialization.epoch) > BigInt(admin.epoch)
    || Object.keys(admin.lastInitialization).sort().join(",") !== "epoch,permissionIds"
    || !Array.isArray(admin.lastInitialization.permissionIds) || admin.lastInitialization.permissionIds.length > 64
    || !admin.lastInitialization.permissionIds.every(id => typeof id === "string" && hexHash.test(id))))
    invalid("The session initialization checkpoint is malformed or oversized.");
  if (value.schemaVersion !== 2 || typeof value.creationBlock !== "string" || typeof value.lastBlock !== "string" || !decimal.test(value.creationBlock) || !decimal.test(value.lastBlock)
    || BigInt(value.lastBlock) >= 2n ** 256n || BigInt(value.creationBlock) > BigInt(value.lastBlock)
    || ![value.creationHash, value.creationTransaction, value.initializerHash, value.lastHash, value.authorityHash].every(item => typeof item === "string" && hexHash.test(item))
    || !Number.isSafeInteger(value.lifecycleChanges) || value.lifecycleChanges < 0
    || Buffer.byteLength(JSON.stringify(value)) > 8192)
    invalid("The checkpoint requires bounded exact block and source evidence.");
  return structuredClone(value);
}
function limits(options: Safe7579CheckpointOptions) {
  const maxKeys = options.maxKeys ?? 10_000, historyBuckets = options.historyBuckets ?? 32;
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 1 || maxKeys > 100_000 || !Number.isSafeInteger(historyBuckets) || historyBuckets < 2 || historyBuckets > 64)
    throw new TypeError("Use bounded checkpoint capacity and 2–64 retained history buckets.");
  return { maxKeys, historyBuckets };
}
const bucketOf = (checkpoint: Safe7579HistoryCheckpoint) => BigInt(checkpoint.lastBlock) / 128n;
function sameCreation(a: Safe7579HistoryCheckpoint, b: Safe7579HistoryCheckpoint) {
  return a.creationBlock === b.creationBlock && a.creationHash.toLowerCase() === b.creationHash.toLowerCase()
    && a.creationTransaction.toLowerCase() === b.creationTransaction.toLowerCase() && a.initializerHash.toLowerCase() === b.initializerHash.toLowerCase();
}
function assertCreation(existing: Safe7579HistoryCheckpoint, next: Safe7579HistoryCheckpoint) {
  if (!sameCreation(existing, next)) throw new RestError(409, "SMART_CHECKPOINT_CREATION_CHANGED", "The checkpoint namespace already binds another verified account creation. Review and retire the prior checkpoint namespace.");
}

/** Production checkpoint persistence. No caller URL or HTTP proof is accepted by this adapter. */
export class PostgresSafe7579CheckpointStore implements Safe7579CheckpointStore {
  private readonly limits;
  constructor(private readonly pool: Pool, options: Safe7579CheckpointOptions = {}) { this.limits = limits(options); }
  async get(key: string): Promise<readonly Safe7579HistoryCheckpoint[]> {
    assertKey(key);
    const result = await this.pool.query<{ document: Safe7579HistoryCheckpoint }>(
      "SELECT document FROM rest_smart_account_checkpoints WHERE key=$1 ORDER BY last_block DESC LIMIT $2",
      [key, this.limits.historyBuckets]);
    return result.rows.map(row => {
      const checkpoint = validate(row.document);
      if (checkpoint.key !== key) invalid("Stored checkpoint does not match its namespace.");
      return checkpoint;
    });
  }
  async put(input: Safe7579HistoryCheckpoint): Promise<void> {
    const checkpoint = validate(input), client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`rest-smart-checkpoint:${checkpoint.key}`]);
      const existing = await client.query<{ document: Safe7579HistoryCheckpoint }>(
        "SELECT document FROM rest_smart_account_checkpoints WHERE key=$1 ORDER BY last_block DESC LIMIT 1", [checkpoint.key]);
      if (existing.rows[0]) assertCreation(validate(existing.rows[0].document), checkpoint);
      else {
        // New namespaces share a capacity lock; existing wallets never wait behind the count.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('rest-smart-checkpoint-capacity',0))");
        const count = await client.query<{ count: string }>("SELECT count(DISTINCT key)::text AS count FROM rest_smart_account_checkpoints");
        if (Number(count.rows[0]!.count) >= this.limits.maxKeys)
          throw new RestError(503, "SMART_CHECKPOINT_CAPACITY", "The durable verified-account checkpoint capacity is reached.");
      }
      await client.query(
        `INSERT INTO rest_smart_account_checkpoints(key,bucket,last_block,document) VALUES($1,$2,$3,$4::jsonb)
         ON CONFLICT(key,bucket) DO UPDATE SET last_block=EXCLUDED.last_block,document=EXCLUDED.document,updated_at=clock_timestamp()
         WHERE EXCLUDED.last_block>=rest_smart_account_checkpoints.last_block`,
        [checkpoint.key, bucketOf(checkpoint).toString(), checkpoint.lastBlock, JSON.stringify(checkpoint)]);
      await client.query(
        `DELETE FROM rest_smart_account_checkpoints WHERE key=$1 AND bucket NOT IN
         (SELECT bucket FROM rest_smart_account_checkpoints WHERE key=$1 ORDER BY bucket DESC LIMIT $2)`,
        [checkpoint.key, this.limits.historyBuckets]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }
}

/** Bounded development adapter with the same history and creation-binding rules. */
export class MemorySafe7579CheckpointStore implements Safe7579CheckpointStore {
  private readonly records = new Map<string, Map<bigint, Safe7579HistoryCheckpoint>>();
  private readonly limits;
  constructor(options: Safe7579CheckpointOptions = {}) { this.limits = limits(options); }
  async get(key: string): Promise<readonly Safe7579HistoryCheckpoint[]> {
    assertKey(key);
    return [...(this.records.get(key)?.values() ?? [])].sort((a, b) => BigInt(a.lastBlock) > BigInt(b.lastBlock) ? -1 : 1).map(value => structuredClone(value));
  }
  async put(input: Safe7579HistoryCheckpoint): Promise<void> {
    const checkpoint = validate(input), records = this.records.get(checkpoint.key) ?? new Map<bigint, Safe7579HistoryCheckpoint>();
    const existing = records.values().next().value;
    if (existing) assertCreation(existing, checkpoint);
    else if (this.records.size >= this.limits.maxKeys) throw new RestError(503, "SMART_CHECKPOINT_CAPACITY", "The verified-account checkpoint capacity is reached.");
    const bucket = bucketOf(checkpoint), prior = records.get(bucket);
    if (!prior || BigInt(prior.lastBlock) <= BigInt(checkpoint.lastBlock)) records.set(bucket, checkpoint);
    const buckets = [...records.keys()].sort((a, b) => a > b ? -1 : 1);
    for (const removed of buckets.slice(this.limits.historyBuckets)) records.delete(removed);
    this.records.set(checkpoint.key, records);
  }
}
