import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { zeroAddress } from "viem";
import { migrate } from "../src/db/migrate.js";
import { createPool, PostgresStore } from "../src/db/postgres.js";

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const schema = `jbcenter_test_${randomUUID().replaceAll("-", "")}`;
const adminPool = connectionString ? createPool(connectionString) : null;
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
    expect((await store!.getIntent(created.intent.id))?.envelope).toEqual(created.intent.envelope);
    expect((await store!.search("climate", 20, 0)).items).toHaveLength(1);

    await store!.recordDeployment(created.intent.id, {
      chainId: 1,
      projectId: "42",
      transactionHash: `0x${"33".repeat(32)}`,
    });
    expect((await store!.search("climate", 20, 0)).items).toHaveLength(0);
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
});
