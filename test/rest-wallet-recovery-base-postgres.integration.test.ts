// Migration 035: a Base recovery lane version beside the local one, and a monotonic actual spend.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const connectionString = process.env.TEST_DATABASE_URL, suite = connectionString ? describe : describe.skip;
suite("hosted Base recovery lane accounting", () => {
  const schema = `recovery_base_${randomUUID().replaceAll("-", "")}`, hash = `0x${"55".repeat(32)}`;
  const anchor = { chainId: 8453, blockNumber: "100", blockHash: hash, timestamp: "1700000000", source: "onchain" };
  let admin: Pool, pool: Pool;
  beforeAll(async () => {
    admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 3 });
    for (const name of ["004_rest_accounts.sql", "007_rest_smart_accounts.sql", "012_rest_smart_account_onboarding.sql",
      "013_rest_wallet_ceremonies.sql", "014_rest_passkey_onboarding.sql", "015_rest_wallet_enrollment.sql", "016_rest_wallet_deployments.sql", "036_wallet_deployment_approval_v2.sql",
      "017_rest_wallet_policy.sql", "019_rest_wallet_app_grants.sql", "020_rest_wallet_authority.sql", "039_wallet_authority_window.sql", "028_wallet_recovery.sql",
      "029_wallet_recovery_mapping.sql", "033_wallet_unproved_recovery_expiry.sql", "030_wallet_recovery_flow.sql", "031_wallet_recovery_dispatch.sql",
      "035_wallet_recovery_base.sql"])
      await pool.query(await readFile(new URL(`../src/db/migrations/${name}`, import.meta.url), "utf8"));
  });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } });
  const lane = (sender: string, version: string) => pool.query("INSERT INTO rest_wallet_recovery_lanes(sender,configuration,environment,next_nonce,anchor) VALUES($1,$2,$3,0,$4)",
    [sender, { version, sender, maximumOperations: 2, maximumCostWei: "1000000000000000000" }, { kind: "base-mainnet", genesisHash: hash }, anchor]);

  it("admits a Base lane version and keeps the local one, rejecting unknown versions", async () => {
    await lane(`0x${"a1".repeat(20)}`, "base-mainnet-recovery-v1");
    await lane(`0x${"a2".repeat(20)}`, "unforked-anvil-recovery-v1");
    await expect(lane(`0x${"a3".repeat(20)}`, "base-mainnet-recovery-v2")).rejects.toMatchObject({ code: "23514" });
  });
  it("records actual spend monotonically and never above what the fence explains", async () => {
    const sender = `0x${"b1".repeat(20)}`; await lane(sender, "base-mainnet-recovery-v1");
    await pool.query("UPDATE rest_wallet_recovery_lanes SET spent_wei=5 WHERE sender=$1", [sender]);
    await expect(pool.query("UPDATE rest_wallet_recovery_lanes SET spent_wei=4 WHERE sender=$1", [sender])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("UPDATE rest_wallet_recovery_lanes SET spent_wei=2000000000000000000 WHERE sender=$1", [sender])).rejects.toMatchObject({ code: "23514" });
    await pool.query("UPDATE rest_wallet_recovery_lanes SET spent_wei=2000000000000000000,fence='allocation-exceeded' WHERE sender=$1", [sender]);
    expect((await pool.query("SELECT spent_wei,fence FROM rest_wallet_recovery_lanes WHERE sender=$1", [sender])).rows[0]).toEqual({ spent_wei: "2000000000000000000", fence: "allocation-exceeded" });
  });
});
