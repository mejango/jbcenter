import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { zeroAddress, type Hex } from "viem";
import { migrate } from "../src/db/migrate.js";
import { createPool, PostgresStore } from "../src/db/postgres.js";
import type { NewIntent } from "../src/store.js";

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const schema = `jbcenter_test_${randomUUID().replaceAll("-", "")}`;
const HASH: Hex = `0x${"aa".repeat(32)}`;

function newIntent(overrides: { name?: string; chainIds?: number[] } = {}): NewIntent {
  const chainIds = overrides.chainIds ?? [1];
  const name = overrides.name ?? "fixture";
  return {
    contentHash: `0x${randomBytes(32).toString("hex")}`,
    envelope: {
      format: "juicebox.money/v1",
      deploymentVersion: "6",
      chainIds,
      deploymentCalls: chainIds.map((chainId) => ({
        chainId,
        to: "0x3333333333333333333333333333333333333333",
        data: "0x12345678",
      })),
      jb: { name, chains: chainIds },
    },
    publisher: zeroAddress,
    signature: `0x${"22".repeat(65)}`,
    submittedBy: "integration",
    jbBytes: 100,
    name,
    description: null,
    tagline: null,
    tags: [],
    logoUri: null,
    owner: zeroAddress,
  };
}
const adminPool = connectionString ? createPool(connectionString) : null;
const reservedWei = async (intentId: string, chainId: number): Promise<string> =>
  (
    await pool!.query<{ wei: string }>(
      "SELECT reserved_wei::text AS wei FROM intent_deploys WHERE intent_id = $1 AND chain_id = $2",
      [intentId, chainId],
    )
  ).rows[0]!.wei;
const expire = async (intentId: string): Promise<void> => {
  await pool!.query(
    "UPDATE intent_deploys SET lease_until = now() - interval '1 second' WHERE intent_id = $1",
    [intentId],
  );
};
let pool: Pool | null = null;
let store: PostgresStore | null = null;

suite("PostgreSQL store", () => {
  beforeAll(async () => {
    await adminPool!.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    store = new PostgresStore(pool);
    await Promise.all([migrate(pool!), migrate(pool!)]);
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool!.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool!.end();
  });

  it("persists, searches, and retires an intent", async () => {
    const created = await store!.createIntent({
      contentHash: `0x${"11".repeat(32)}`,
      envelope: {
        format: "juicebox.money/v1",
        deploymentVersion: "6",
        chainIds: [1],
        deploymentCalls: [
          {
            chainId: 1,
            to: "0x3333333333333333333333333333333333333333",
            data: "0x12345678",
          },
        ],
        jb: { name: "Climate garden", chains: [1] },
      },
      publisher: zeroAddress,
      signature: `0x${"22".repeat(65)}`,
      submittedBy: "integration",
      jbBytes: 100,
      name: "Climate garden",
      description: "Public goods",
      tagline: null,
      tags: ["climate"],
      logoUri: null,
      owner: zeroAddress,
    }, { maxIntents: 100, maxBytes: 1_000_000 });
    expect(created.created).toBe(true);
    expect(created.usage).toEqual({ intents: 1, bytes: 100 });
    expect((await store!.getIntent(created.intent.id))?.envelope).toEqual(created.intent.envelope);
    expect((await store!.search("climate", 20, 0, {})).items).toHaveLength(1);

    await store!.recordDeployment(created.intent.id, {
      chainId: 1,
      projectId: "42",
      transactionHash: `0x${"33".repeat(32)}`,
    });
    expect((await store!.search("climate", 20, 0, {})).items).toHaveLength(0);
    expect((await store!.getIntent(created.intent.id))?.deployments[0]?.projectId).toBe("42");

    const duplicates = await Promise.all(
      Array.from({ length: 20 }, () =>
        store!.createIntent(
          {
            contentHash: created.intent.contentHash,
            envelope: created.intent.envelope,
            publisher: created.intent.publisher,
            signature: created.intent.signature,
            submittedBy: "integration",
            jbBytes: 100,
            name: created.intent.name,
            description: created.intent.description,
            tagline: created.intent.tagline,
            tags: created.intent.tags,
            logoUri: created.intent.logoUri,
            owner: created.intent.owner,
          },
          { maxIntents: 100, maxBytes: 1_000_000 },
        ),
      ),
    );
    expect(duplicates.every(({ created: wasCreated }) => !wasCreated)).toBe(true);
    expect(duplicates[0]?.intent.status).toBe("deployed");

    const rateResults = await Promise.all(
      Array.from({ length: 20 }, () => store!.consumeRequest("integration", 10)),
    );
    expect(rateResults.filter(({ allowed }) => allowed)).toHaveLength(10);
    // The cleanup drops only spent windows; the quota write no longer carries it.
    await pool!.query(
      "INSERT INTO rate_limits (client_name, window_start, request_count) VALUES ('stale', now() - interval '3 days', 1)",
    );
    expect(await store!.cleanupRateLimits()).toBe(1);
    expect((await store!.consumeRequest("integration", 10)).remaining).toBe(0);

    await expect(
      store!.createIntent(
        {
          contentHash: `0x${"44".repeat(32)}`,
          envelope: { ...created.intent.envelope, jb: { name: "Second" } },
          publisher: zeroAddress,
          signature: `0x${"55".repeat(65)}`,
          submittedBy: "integration",
          jbBytes: 100,
          name: "Second",
          description: null,
          tagline: null,
          tags: [],
          logoUri: null,
          owner: zeroAddress,
        },
        { maxIntents: 1, maxBytes: 1_000_000 },
      ),
    ).rejects.toThrow("quota");
  });

  it("filters search by owner and publisher without regard to address casing", async () => {
    const owner = "0x5555555555555555555555555555555555555555";
    const publisher = "0x6666666666666666666666666666666666666666";
    const value = newIntent({ name: "filterable" });
    await store!.createIntent(
      { ...value, owner, publisher },
      { maxIntents: 100, maxBytes: 10_000_000 },
    );

    expect((await store!.search("", 20, 0, { owner: owner.toUpperCase() as `0x${string}` })).items)
      .toHaveLength(1);
    expect((await store!.search("filterable", 20, 0, { owner })).totalCount).toBe(1);
    expect((await store!.search("", 20, 0, { publisher })).items).toHaveLength(1);
    expect((await store!.search("", 20, 0, { owner, publisher: owner as `0x${string}` })).items)
      .toHaveLength(0);
    expect(
      (await store!.search("", 20, 0, { owner: "0x7777777777777777777777777777777777777777" }))
        .totalCount,
    ).toBe(0);
  });

  it("deploy queue is idempotent, leases rows, and sums wei", async () => {
    const { intent } = await store!.createIntent(
      newIntent({ name: "one", chainIds: [84532, 421614] }),
      { maxIntents: 100, maxBytes: 1_000_000 },
    );
    const rows = await store!.queueDeploys(intent.id, [84532, 421614], "browser:x", 1000n);
    expect(rows.map((r) => r.status)).toEqual(["queued", "queued"]);
    expect(await store!.queueDeploys(intent.id, [84532, 421614], "browser:x", 1000n)).toHaveLength(2);
    expect(await store!.sponsoredWeiSince(new Date(Date.now() - 60_000))).toBe(2000n);
    // The same sum, narrowed to one requester: the MCP's own slice is measured this way.
    expect(await store!.sponsoredWeiSince(new Date(Date.now() - 60_000), "browser:x")).toBe(2000n);
    expect(await store!.sponsoredWeiSince(new Date(Date.now() - 60_000), "mcp")).toBe(0n);
    const claimed = await store!.claimQueuedDeploys(30, 10);
    expect(claimed).toEqual([{ intentId: intent.id, chainIds: [84532, 421614] }]);
    expect(await store!.claimQueuedDeploys(30, 10)).toEqual([]);
    // A released claim costs neither the lease nor the attempt.
    await store!.releaseClaim(intent.id, [84532, 421614]);
    expect(
      (
        await pool!.query<{ attempts: number }>(
          "SELECT attempts FROM intent_deploys WHERE intent_id = $1 ORDER BY chain_id",
          [intent.id],
        )
      ).rows.map((row) => row.attempts),
    ).toEqual([0, 0]);
    // The release backs off five minutes before the rows are eligible again.
    expect(await store!.claimQueuedDeploys(30, 10)).toEqual([]);
    await pool!.query("UPDATE intent_deploys SET lease_until = now() - interval '1 second' WHERE intent_id = $1", [intent.id]);
    expect(await store!.claimQueuedDeploys(30, 10)).toEqual([
      { intentId: intent.id, chainIds: [84532, 421614] },
    ]);
    await store!.updateDeploy(intent.id, 84532, { status: "confirmed", transactionHash: HASH, spentWei: 700n });
    expect(await store!.sponsoredWeiSince(new Date(Date.now() - 60_000))).toBe(1700n);
    expect((await store!.getIntent(intent.id))?.deploys[0]).toMatchObject({ chainId: 84532, status: "confirmed" });
  });

  it("resumes a sent row whose lease expired, and keeps a paid reservation on a dead end", async () => {
    const { intent } = await store!.createIntent(
      newIntent({ name: "four", chainIds: [11155420] }),
      { maxIntents: 100, maxBytes: 1_000_000 },
    );
    await store!.queueDeploys(intent.id, [11155420], "browser:y", 900n);
    expect(await store!.claimQueuedDeploys(0, 10)).toEqual([
      { intentId: intent.id, chainIds: [11155420] },
    ]);
    await store!.updateDeploy(intent.id, 11155420, {
      status: "sent",
      transactionHash: HASH,
      bundleUuid: "bundle-1",
    });
    await expire(intent.id);
    // A sent row that outlived its lease is claimed again so the worker resumes its bundle.
    expect(await store!.claimQueuedDeploys(0, 10)).toEqual([
      { intentId: intent.id, chainIds: [11155420] },
    ]);

    // The same sweep retires a sent row that ran out of attempts.
    await pool!.query("UPDATE intent_deploys SET attempts = 3 WHERE intent_id = $1", [intent.id]);
    await expire(intent.id);
    expect(await store!.claimQueuedDeploys(0, 10)).toEqual([]);
    expect((await store!.getIntent(intent.id))?.deploys[0]).toMatchObject({
      status: "failed",
      error: "attempts exhausted",
    });
    // The bundle was submitted, so the reservation keeps counting against the budget.
    expect(await reservedWei(intent.id, 11155420)).toBe("900");
  });

  it("retires a bundle left unresolved for a day and keeps its reservation", async () => {
    const { intent } = await store!.createIntent(
      newIntent({ name: "seven", chainIds: [11155420] }),
      { maxIntents: 100, maxBytes: 1_000_000 },
    );
    await store!.queueDeploys(intent.id, [11155420], "browser:y", 700n);
    await store!.updateDeploy(intent.id, 11155420, {
      status: "sent",
      transactionHash: HASH,
      bundleUuid: "bundle-3",
    });
    await pool!.query(
      "UPDATE intent_deploys SET created_at = now() - interval '25 hours' WHERE intent_id = $1",
      [intent.id],
    );
    expect(await store!.claimQueuedDeploys(0, 10)).toEqual([]);
    expect((await store!.getIntent(intent.id))?.deploys[0]).toMatchObject({
      status: "failed",
      error: "bundle unresolved",
    });
    // An operator reconciles the row; the prepayment keeps counting against the budget.
    expect(await reservedWei(intent.id, 11155420)).toBe("700");
  });

  it("retires a row that waited a day without a bundle and releases its reservation", async () => {
    const { intent } = await store!.createIntent(
      newIntent({ name: "eight", chainIds: [421614] }),
      { maxIntents: 100, maxBytes: 1_000_000 },
    );
    await store!.queueDeploys(intent.id, [421614], "browser:y", 600n);
    await store!.updateDeploy(intent.id, 421614, { error: "SPONSOR_UNFUNDED" });
    await pool!.query(
      "UPDATE intent_deploys SET created_at = now() - interval '25 hours' WHERE intent_id = $1",
      [intent.id],
    );
    expect(await store!.claimQueuedDeploys(0, 10)).toEqual([]);
    expect((await store!.getIntent(intent.id))?.deploys[0]).toMatchObject({
      status: "failed",
      error: "retries exhausted",
    });
    expect(await reservedWei(intent.id, 421614)).toBe("0");
  });

  it("still claims a row queued for a day that was never attempted", async () => {
    const { intent } = await store!.createIntent(
      newIntent({ name: "nine", chainIds: [421614] }),
      { maxIntents: 100, maxBytes: 1_000_000 },
    );
    await store!.queueDeploys(intent.id, [421614], "browser:y", 600n);
    await pool!.query(
      "UPDATE intent_deploys SET created_at = now() - interval '25 hours' WHERE intent_id = $1",
      [intent.id],
    );
    expect(await store!.claimQueuedDeploys(60, 50)).toContainEqual({
      intentId: intent.id,
      chainIds: [421614],
    });
    expect((await store!.getIntent(intent.id))?.deploys[0]).toMatchObject({ status: "queued" });
  });

  it("caps a stored error and keeps a paid reservation when a chain fails", async () => {
    const { intent } = await store!.createIntent(
      newIntent({ name: "five", chainIds: [421614] }),
      { maxIntents: 100, maxBytes: 1_000_000 },
    );
    await store!.queueDeploys(intent.id, [421614], "browser:y", 800n);
    await store!.updateDeploy(intent.id, 421614, {
      status: "failed",
      bundleUuid: "bundle-2",
      error: "z".repeat(900),
    });
    expect((await store!.getIntent(intent.id))?.deploys[0]?.error).toHaveLength(300);
    expect(await reservedWei(intent.id, 421614)).toBe("800");

    const { intent: unpaid } = await store!.createIntent(
      newIntent({ name: "six", chainIds: [421614] }),
      { maxIntents: 100, maxBytes: 1_000_000 },
    );
    await store!.queueDeploys(unpaid.id, [421614], "browser:y", 800n);
    await store!.updateDeploy(unpaid.id, 421614, { status: "failed", error: "chain not configured" });
    expect(await reservedWei(unpaid.id, 421614)).toBe("0");
  });

  it("reclaims an expired lease, stops once attempts reach the cap, and leaves a sibling chain's live lease alone", async () => {
    const { intent } = await store!.createIntent(
      newIntent({ name: "two", chainIds: [11155111] }),
      { maxIntents: 100, maxBytes: 1_000_000 },
    );
    await store!.queueDeploys(intent.id, [11155111], "browser:y", 500n);

    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await store!.claimQueuedDeploys(0, 10)).toEqual([
        { intentId: intent.id, chainIds: [11155111] },
      ]);
      await pool!.query(
        "UPDATE intent_deploys SET lease_until = now() - interval '1 second' WHERE intent_id = $1",
        [intent.id],
      );
    }
    expect(await store!.claimQueuedDeploys(0, 10)).toEqual([]);
    // A row that can no longer be retried is retired, and its reservation released.
    expect((await store!.getIntent(intent.id))?.deploys[0]).toMatchObject({
      status: "failed",
      error: "attempts exhausted",
    });
    expect(await reservedWei(intent.id, 11155111)).toBe("0");

    const { intent: sibling } = await store!.createIntent(
      newIntent({ name: "three", chainIds: [84532, 11155420] }),
      { maxIntents: 100, maxBytes: 1_000_000 },
    );
    await store!.queueDeploys(sibling.id, [84532, 11155420], "browser:z", 500n);
    expect(await store!.claimQueuedDeploys(1000, 10)).toEqual([
      { intentId: sibling.id, chainIds: [84532, 11155420] },
    ]);
    // Only chain 84532's lease expires; chain 11155420 keeps the live 1000s lease from above.
    await pool!.query(
      "UPDATE intent_deploys SET lease_until = now() - interval '1 second' WHERE intent_id = $1 AND chain_id = $2",
      [sibling.id, 84532],
    );
    expect(await store!.claimQueuedDeploys(1000, 10)).toEqual([
      { intentId: sibling.id, chainIds: [84532] },
    ]);
  });
});
