import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { zeroHash, type Address, type Hex } from "viem";
import { migrate } from "../src/db/migrate.js";
import { PostgresSmartAccountRegistry } from "../src/rest/smartAccounts/postgres.js";
import { fingerprint } from "../src/rest/smartAccounts/service.js";
import type { SmartAccountBinding } from "../src/rest/smartAccounts/types.js";

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const schema = `smart_account_test_${randomUUID().replaceAll("-", "")}`;
let admin: Pool, pool: Pool, registry: PostgresSmartAccountRegistry;
const owner = "0x1111111111111111111111111111111111111111" as const;
const accountId = `eip155:1:${owner}`;
const nonce = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const wallet = (n: number) =>
  `0x${(100 + n).toString(16).padStart(40, "0")}` as Address;
function record(n: number): SmartAccountBinding {
  const address = wallet(n),
    stateHash = nonce(n + 100),
    digest = nonce(n + 200);
  return {
    id: fingerprint({ ownerAccountId: accountId, wallet: address, chainId: 1 }),
    ownerAccountId: accountId,
    ownerAddress: owner,
    wallet: { chainId: 1, address },
    manifestId: "fixture",
    authorization: {
      digest,
      nonce: nonce(n),
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      method: "safe-current-owner-threshold",
    },
    state: {
      chainId: 1,
      address,
      manifestId: "fixture",
      manifestRevision: zeroHash,
      owners: [owner],
      threshold: 1,
      safeNonce: "0",
      stateHash,
      evidence: {
        chainId: 1,
        blockNumber: "100",
        blockHash: zeroHash,
        timestamp: "1",
        source: "onchain",
      },
      codeHashes: [],
      modules: null,
      moduleConfigurationVerified: false,
      executionVerified: false,
    },
  };
}
suite("durable smart account bindings", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    await migrate(pool);
    await pool.query(
      "INSERT INTO rest_accounts(id,owner_address,authority_chain_id,display_name,bio,created_at,updated_at) VALUES($1,$2,1,'','',1,1)",
      [accountId, owner],
    );
    registry = new PostgresSmartAccountRegistry(pool);
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
  it("serializes competing binding nonce claims and preserves owner isolation", async () => {
    const a = record(1),
      b = record(2);
    b.authorization.nonce = a.authorization.nonce;
    const result = await Promise.allSettled([
      registry.bind(a),
      registry.bind(b),
    ]);
    expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(result.filter((item) => item.status === "rejected")).toHaveLength(1);
    const saved = result.find(
      (item) => item.status === "fulfilled",
    ) as PromiseFulfilledResult<SmartAccountBinding>;
    expect(
      await registry.get("different-owner", saved.value.id),
    ).toBeUndefined();
    expect(await registry.get(accountId, saved.value.id)).toMatchObject({
      id: saved.value.id,
    });
  });
  it("keeps duplicate binds idempotent but never lets a revoked signature restore authority", async () => {
    const value = record(3);
    await registry.bind(value);
    expect(await registry.bind(value)).toEqual(value);
    await Promise.allSettled([
      registry.bind(value),
      registry.revoke(accountId, value.id),
    ]);
    expect(await registry.get(accountId, value.id)).toBeUndefined();
    await expect(registry.bind(value)).rejects.toMatchObject({
      code: "SMART_BINDING_REVOKED",
    });
    const renewed = {
      ...value,
      authorization: {
        ...value.authorization,
        nonce: nonce(30),
        digest: nonce(300),
      },
    };
    await registry.bind(renewed);
    expect(
      (await registry.get(accountId, value.id))?.authorization.digest,
    ).toBe(renewed.authorization.digest);
    await expect(registry.bind(value)).rejects.toMatchObject({
      code: "SMART_BINDING_REVOKED",
    });
  });
  it("uses database expiry and rejects mismatched owner or duplicated document identity", async () => {
    const value = record(4);
    await expect(
      registry.bind({
        ...value,
        authorization: { ...value.authorization, expiresAt: 1 },
      }),
    ).rejects.toMatchObject({ code: "SMART_BINDING_EXPIRED" });
    await expect(
      registry.bind({ ...value, ownerAddress: wallet(99) }),
    ).rejects.toMatchObject({ code: "SMART_OWNER_MISMATCH" });
    await registry.bind(value);
    await expect(
      pool.query(
        "UPDATE rest_smart_account_bindings SET document=jsonb_set(document,'{wallet,address}',to_jsonb($3::text)) WHERE account_id=$1 AND id=$2",
        [accountId, value.id, wallet(99)],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    expect((await registry.get(accountId, value.id))?.wallet.address).toBe(
      value.wallet.address,
    );
    expect(
      (await registry.list(accountId)).every(
        (entry) => entry.ownerAccountId === accountId,
      ),
    ).toBe(true);
  });
});
