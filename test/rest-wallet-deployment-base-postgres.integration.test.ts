// Durable Base accounting: complete receipt fees, a reserved admission and an overspend fence.
// Synthetic evidence exercises the SQL and store boundaries; it is not chain provenance.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { enrollmentDigest } from "../src/rest/wallet/enrollment.js";
import { PostgresWalletDeploymentStore } from "../src/rest/wallet/deploymentPostgres.js";
import { walletDeploymentAccountingDigest, walletDeploymentRemainingWei, type WalletDeploymentEnvironment,
  type WalletDeploymentSettlementContext } from "../src/rest/wallet/deploymentSettlement.js";
import type { WalletDeploymentDispatchAdmission } from "../src/rest/wallet/deploymentDispatch.js";
import { deploymentFixtureConfiguration, syntheticDeploymentObservation } from "./fixtures/wallet-deployment-execution.js";
import { initializedSettlementPool, preparedSettlementUser, settlementDatabaseNow, signedSettlementUser, syntheticSettlement } from "./fixtures/wallet-deployment-settlement.js";

const connectionString = process.env.TEST_DATABASE_URL, suite = connectionString ? describe : describe.skip;
const schema = `rest_wallet_base_${randomUUID().replaceAll("-", "")}`;
const base: WalletDeploymentEnvironment = { kind: "base-mainnet", genesisHash: `0x${"11".repeat(32)}` };
const fees = (l1Wei: string) => ({ profile: "base-fjord-jovian-receipt-v1" as const, executionWei: "500000000000", l1Wei, operatorWei: "7",
  totalWei: String(500000000000n + BigInt(l1Wei) + 7n) });
let admin: Pool, pool: Pool, store: PostgresWalletDeploymentStore;

function baseAdmission(context: WalletDeploymentSettlementContext, now: number): WalletDeploymentDispatchAdmission {
  const operation = context.operation, execution = BigInt(operation.signed!.maximumExecutionCost);
  return { version: "center-wallet-deployment-base-admission-v1", operationId: operation.id, poolConfigurationDigest: operation.poolConfigurationDigest,
    templateCommitment: operation.templateCommitment!, transactionHash: operation.signed!.hash, operationRevision: operation.revision,
    observationDigest: enrollmentDigest(operation.observation), environment: { kind: "base-mainnet", genesisHash: base.genesisHash, head: operation.observation!.head! },
    observedAt: now, expiresAt: now + 3000, balanceWei: context.pool.configuration.allocationWei, maximumExecutionCost: operation.signed!.maximumExecutionCost,
    feeScope: "base-execution-l1-operator-reserved", baseTotalAffordability: "reserved",
    accounting: { digest: walletDeploymentAccountingDigest(context.pool.accounting!), remainingWei: walletDeploymentRemainingWei(context.pool), nextNonce: context.pool.accounting!.nextNonce },
    reservation: { attributesTransaction: `0x${"44".repeat(32)}`, parametersDigest: "a".repeat(64), l1WeiAtParameters: "16289011957",
      operatorMaximumWei: "100", totalWei: String(execution + 2n * (16289011957n + 100n)) } };
}
async function observed(context: WalletDeploymentSettlementContext) {
  const observation = syntheticDeploymentObservation(context, await settlementDatabaseNow(pool));
  await store.saveObservation({ operationId: context.operation.id, signedHash: context.operation.signed!.hash, expectedRevision: context.operation.revision, observation });
  return store.loadSettlementContext(context.operation.id);
}
function settlementAt(context: WalletDeploymentSettlementContext, now: number, l1Wei: string) {
  const evidence = syntheticSettlement(context, now, fees(l1Wei)), head = context.operation.observation!.head!;
  evidence.funding.head = head; evidence.observation.head = head; evidence.observation.wallet.evidence = head;
  evidence.observation.transaction.receipt!.block = head; evidence.observation.finality.evidence = head;
  return evidence;
}

suite("durable hosted Base deployment accounting", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 5 });
    for (const name of ["013_rest_wallet_ceremonies.sql", "015_rest_wallet_enrollment.sql", "041_wallet_passkey_name.sql", "043_wallet_networks.sql", "044_wallet_devices.sql", "016_rest_wallet_deployments.sql", "036_wallet_deployment_approval_v2.sql",
      "018_rest_wallet_deployment_observations.sql", "021_rest_wallet_deployment_dispatch.sql", "026_wallet_deployment_settlement.sql",
      "034_wallet_deployment_base.sql"])
      await pool.query(await readFile(new URL(`../src/db/migrations/${name}`, import.meta.url), "utf8"));
    store = new PostgresWalletDeploymentStore(pool);
  });
  beforeEach(async () => { await pool.query("TRUNCATE rest_wallet_deployments,rest_wallet_deployment_pools,rest_wallet_credentials,rest_wallet_enrollments,rest_wallet_ceremonies CASCADE"); });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } });

  it("initializes a Base pool, leases a reserved admission and settles complete receipt fees", async () => {
    const initial = await initializedSettlementPool(pool, store, base);
    expect(initial.pool.accounting!.environment).toEqual(base);
    let context = await observed(await signedSettlementUser(pool, store));
    const admission = baseAdmission(context, await settlementDatabaseNow(pool));
    const lease = await store.leaseDispatch({ operationId: context.operation.id, expectedRevision: context.operation.revision,
      signedHash: context.operation.signed!.hash, admission, leaseMs: 300 });
    expect(lease.admission).toEqual(admission);
    await store.settleDispatch({ operationId: context.operation.id, expectedRevision: lease.revision, leaseToken: lease.leaseToken,
      signedHash: context.operation.signed!.hash, status: "accepted" });
    await new Promise(resolve => setTimeout(resolve, Math.max(1, lease.leaseUntil - Date.now() + 15)));
    context = await store.loadSettlementContext(context.operation.id);
    const evidence = settlementAt(context, await settlementDatabaseNow(pool), "16289011957");
    const result = await store.settle(context, evidence);
    expect(result.settlement).toMatchObject({ spentWei: evidence.fees.totalWei, nextNonce: "2", sequence: 1 });
    expect(result.pool.accounting).toMatchObject({ spentWei: evidence.fees.totalWei, nextNonce: "2", fence: null });
    expect(result.pool.activeOperationId).toBeNull();
    expect((await store.getSettlement(context.operation.id))!.evidence.fees).toEqual(evidence.fees);
  });
  it("SQL refuses a local admission version, an unaffordable reservation and local fees under Base accounting", async () => {
    const hosted = deploymentFixtureConfiguration(); hosted.policy.maximumObservationAgeMs = 30_000;
    await initializedSettlementPool(pool, store, base, hosted);
    const context = await observed(await signedSettlementUser(pool, store)), now = await settlementDatabaseNow(pool);
    const admission: any = baseAdmission(context, now);
    const lease = (value: unknown) => pool.query(`INSERT INTO rest_wallet_deployment_dispatches
      (operation_id,transaction_hash,template_commitment,revision,attempts,status,lease_token,lease_until,admission,admission_digest,claimed_at,next_attempt_at)
      VALUES($1,$2,$3,1,1,'in-flight',$4,$5,$6::jsonb,$7,$8,$9)`, [context.operation.id, context.operation.signed!.hash, context.operation.templateCommitment,
      randomUUID(), now + 3000, JSON.stringify(value), enrollmentDigest(value), now, now + 4000]).then(async result => {
        await pool.query("DELETE FROM rest_wallet_deployment_dispatches WHERE operation_id=$1", [context.operation.id]).catch(() => undefined); return result; });
    const local = { ...admission, version: "center-wallet-deployment-local-admission-v2", feeScope: "local-execution-only", baseTotalAffordability: "unknown",
      environment: { ...admission.environment, kind: "unforked-anvil" } }; delete local.reservation;
    await expect(lease(local)).rejects.toMatchObject({ code: "23514" });
    const unaffordable = { ...admission.reservation, l1WeiAtParameters: context.pool.configuration.allocationWei };
    unaffordable.totalWei = String(BigInt(admission.maximumExecutionCost) + 2n * (BigInt(unaffordable.l1WeiAtParameters) + BigInt(unaffordable.operatorMaximumWei)));
    await expect(lease({ ...admission, reservation: unaffordable })).rejects.toMatchObject({ code: "23514" });
    const { reservation: _omitted, ...late } = { ...admission, version: "center-wallet-deployment-local-admission-v2", feeScope: "local-execution-only",
      baseTotalAffordability: "unknown", environment: { ...admission.environment, kind: "unforked-anvil" }, expiresAt: now + 5001 };
    await expect(lease(late)).rejects.toMatchObject({ code: "23514" });
    await expect(lease({ ...admission, feeScope: "local-execution-only" })).rejects.toMatchObject({ code: "23514" });
    await expect(lease({ ...admission, expiresAt: now + 20_001 })).rejects.toMatchObject({ code: "23514" });
    await expect(lease({ ...admission, expiresAt: now + 15_000 })).resolves.toBeDefined();
    const evidence = settlementAt(context, now, "16289011957");
    const localFees = { ...evidence, fees: { profile: "unforked-anvil-execution-fees-v1", executionWei: "500000000000", totalWei: "500000000000" } };
    await expect(store.settle(context, localFees as never)).rejects.toBeDefined();
  });
  it("records an actual cost above the remaining allocation as a permanent debit behind an allocation-exceeded fence", async () => {
    await initializedSettlementPool(pool, store, base);
    const context = await observed(await signedSettlementUser(pool, store));
    const allocation = BigInt(context.pool.configuration.allocationWei);
    const evidence = settlementAt(context, await settlementDatabaseNow(pool), String(allocation));
    const result = await store.settle(context, evidence);
    expect(result.settlement).toMatchObject({ spentWei: evidence.fees.totalWei, nextNonce: "2", sequence: 1 });
    expect(BigInt(result.settlement!.spentWei)).toBeGreaterThan(allocation);
    expect(result.pool.accounting).toMatchObject({ spentWei: evidence.fees.totalWei, nextNonce: "2", sequence: 1, fence: { reason: "allocation-exceeded" } });
    expect(result.pool.activeOperationId).toBeNull();
    expect(walletDeploymentRemainingWei(result.pool)).toBe("0");
    expect(await store.settle(context, evidence)).toEqual({ ...result, replayed: true });
    await expect(store.claim((await preparedSettlementUser(pool, store)).input)).rejects.toMatchObject({ status: 409 });
    await expect(pool.query("UPDATE rest_wallet_deployment_pools SET accounting=jsonb_set(accounting,'{fence}','null'),revision=revision+1")).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("UPDATE rest_wallet_deployment_pools SET accounting=jsonb_set(accounting,'{spentWei}','\"1\"'),revision=revision+1")).rejects.toMatchObject({ code: "23514" });
  });
  it("SQL rejects an overspent debit without its fence and a fence that also drops the liability", async () => {
    await initializedSettlementPool(pool, store, base);
    const context = await observed(await signedSettlementUser(pool, store)), now = await settlementDatabaseNow(pool);
    const evidence = settlementAt(context, now, String(BigInt(context.pool.configuration.allocationWei)));
    const receipt = { version: "center-wallet-deployment-settlement-receipt-v1", id: context.operation.id, poolId: context.pool.configuration.id,
      operationId: context.operation.id, evidenceDigest: enrollmentDigest(evidence), evidence, nonce: "1", priorSequence: 0, sequence: 1,
      spentWei: evidence.fees.totalWei, nextNonce: "2", settledAt: now };
    const settled = { ...context.pool.accounting!, sequence: 1, spentWei: receipt.spentWei, nextNonce: "2",
      lastSettlementId: context.operation.id, lastSettlementAnchor: evidence.observation.finality.evidence };
    for (const accounting of [settled, { ...settled, fence: { reason: "balance-deficit", evidenceDigest: receipt.evidenceDigest, recordedAt: now } }]) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("INSERT INTO rest_wallet_deployment_settlements(id,pool_id,sequence,evidence_digest,receipt) VALUES($1,$2,1,$3,$4::jsonb)",
          [context.operation.id, context.pool.configuration.id, receipt.evidenceDigest, JSON.stringify(receipt)]);
        await client.query("UPDATE rest_wallet_deployments SET settlement_id=$1 WHERE id=$1", [context.operation.id]);
        await expect(client.query("UPDATE rest_wallet_deployment_pools SET accounting=$2::jsonb,revision=revision+1,active_operation_id=NULL WHERE id=$1",
          [context.pool.configuration.id, JSON.stringify(accounting)])).rejects.toMatchObject({ code: "23514" });
      } finally { await client.query("ROLLBACK"); client.release(); }
    }
    expect(await store.getSettlement(context.operation.id)).toBeNull();
  });
});
