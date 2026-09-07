import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemorySafe7579CheckpointStore, PostgresSafe7579CheckpointStore,
  type Safe7579CheckpointOptions, type Safe7579CheckpointStore, type Safe7579HistoryCheckpoint } from "../src/rest/smartAccounts/checkpoints.js";
import { fingerprint } from "../src/rest/smartAccounts/service.js";

const connectionString = process.env.TEST_DATABASE_URL;
const schema = `rest_checkpoint_test_${randomUUID().replaceAll("-", "")}`;
let admin: Pool | undefined, pool: Pool | undefined;
const key = (name: string) => `1:0x${"11".repeat(20)}:${fingerprint(name)}:${fingerprint("utility-runtime")}`;
function fixture(block = 100, name = "fixture"): Safe7579HistoryCheckpoint {
  return { schemaVersion: 2, key: key(name), creationBlock: "1", creationHash: fingerprint("creation"),
    creationTransaction: fingerprint("creation-tx"), initializerHash: fingerprint("initializer"),
    lastBlock: String(block), lastHash: fingerprint(block), authorityHash: fingerprint("authority"), lifecycleChanges: 1,
    sessionAdministration: { epoch: "0", hash: fingerprint("empty-session-administration") } };
}

beforeAll(async () => {
  if (!connectionString) return;
  admin = new Pool({ connectionString });
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 12 });
  await pool.query(await readFile(new URL("../src/db/migrations/010_rest_smart_account_checkpoints.sql", import.meta.url), "utf8"));
});
afterAll(async () => {
  await pool?.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
});

for (const kind of ["memory", "postgres"] as const) {
  const suite = kind === "postgres" && !connectionString ? describe.skip : describe;
  suite(`${kind} canonical inspector checkpoint persistence`, () => {
    const create = (options: Safe7579CheckpointOptions = {}): Safe7579CheckpointStore => kind === "memory"
      ? new MemorySafe7579CheckpointStore(options) : new PostgresSafe7579CheckpointStore(pool!, options);
    beforeEach(async () => { if (kind === "postgres") await pool!.query("TRUNCATE rest_smart_account_checkpoints"); });
    it("retains source-bound evidence without exposing mutable stored references", async () => {
      const store = create(), value = fixture();
      expect(await store.get(value.key)).toEqual([]);
      await store.put(value); value.lastHash = fingerprint("changed");
      const first = await store.get(value.key);
      expect(first[0]!.lastHash).toBe(fixture().lastHash);
      first[0]!.authorityHash = fingerprint("tampered");
      expect((await store.get(value.key))[0]!.authorityHash).toBe(fixture().authorityHash);
      expect(await store.get(key("another-manifest"))).toEqual([]);
    });
    it("retains newest bounded buckets and never overwrites a newer checkpoint with a late writer", async () => {
      const store = create({ historyBuckets: 3 });
      for (const block of [128, 256, 384, 512, 520, 515]) await store.put(fixture(block));
      expect((await store.get(key("fixture"))).map(value => value.lastBlock)).toEqual(["520", "384", "256"]);
    });
    it("allows a fully reverified same-height canonical replacement and retains an older reorg fallback", async () => {
      const store = create();
      await store.put(fixture(128)); await store.put(fixture(256));
      await store.put({ ...fixture(256), lastHash: fingerprint("new-canonical-block") });
      const checkpoints = await store.get(key("fixture"));
      expect(checkpoints).toHaveLength(2);
      expect(checkpoints[0]!.lastHash).toBe(fingerprint("new-canonical-block"));
      expect(checkpoints[1]!.lastBlock).toBe("128");
    });
    it("never mixes another creation or initializer into the same history namespace", async () => {
      const store = create(); await store.put(fixture());
      for (const field of ["creationHash", "creationTransaction", "initializerHash"] as const)
        await expect(store.put({ ...fixture(200), [field]: fingerprint("different") })).rejects.toMatchObject({ code: "SMART_CHECKPOINT_CREATION_CHANGED" });
      await expect(store.put({ ...fixture(200), creationBlock: "2" })).rejects.toMatchObject({ code: "SMART_CHECKPOINT_CREATION_CHANGED" });
    });
    it("rejects unknown fields, malformed coordinates and oversized evidence", async () => {
      const store = create();
      await expect(store.get("https://untrusted.example/checkpoint")).rejects.toMatchObject({ code: "SMART_CHECKPOINT_INVALID" });
      await expect(store.put({ ...fixture(), proofUrl: "https://untrusted.example" } as Safe7579HistoryCheckpoint)).rejects.toMatchObject({ code: "SMART_CHECKPOINT_INVALID" });
      await expect(store.put({ ...fixture(), lastBlock: "0" })).rejects.toMatchObject({ code: "SMART_CHECKPOINT_INVALID" });
      await expect(store.put({ ...fixture(), lifecycleChanges: Number.MAX_SAFE_INTEGER + 1 })).rejects.toMatchObject({ code: "SMART_CHECKPOINT_INVALID" });
      await expect(store.put({ ...fixture(), lastHash: `0x${"11".repeat(5000)}` })).rejects.toMatchObject({ code: "SMART_CHECKPOINT_INVALID" });
    });
    it("bounds namespaces while preserving updates to already admitted accounts", async () => {
      const store = create({ maxKeys: 2 });
      await store.put(fixture(100, "one")); await store.put(fixture(100, "two"));
      await expect(store.put(fixture(100, "three"))).rejects.toMatchObject({ code: "SMART_CHECKPOINT_CAPACITY" });
      await store.put(fixture(200, "one"));
      expect((await store.get(key("one")))[0]!.lastBlock).toBe("200");
    });
    it("serializes duplicate and out-of-order writers with deterministic newest evidence", async () => {
      const store = create();
      await Promise.all(Array.from({ length: 12 }, (_, i) => store.put(fixture(200 - i))));
      expect((await store.get(key("fixture"))).map(value => value.lastBlock)).toEqual(["200"]);
      if (kind === "postgres") expect(await create().get(key("fixture"))).toEqual(await store.get(key("fixture")));
    });
  });
}
