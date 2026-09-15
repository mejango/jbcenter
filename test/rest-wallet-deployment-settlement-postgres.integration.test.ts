import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { enrollmentDigest } from "../src/rest/wallet/enrollment.js";
import { syntheticDeploymentObservation, syntheticDeploymentAdmission } from "./fixtures/wallet-deployment-execution.js";
import { walletDeploymentRemainingWei } from "../src/rest/wallet/deploymentSettlement.js";
import { PostgresWalletDeploymentStore } from "../src/rest/wallet/deploymentPostgres.js";
import { initializedSettlementPool, signedSettlementUser, syntheticSettlement, settlementDatabaseNow, preparedSettlementUser, syntheticFunding } from "./fixtures/wallet-deployment-settlement.js";
const connectionString = process.env.TEST_DATABASE_URL, suite = connectionString ? describe : describe.skip;
const schema = `rest_wallet_settlement_${randomUUID().replaceAll("-", "")}`;
let admin: Pool, pool: Pool, store: PostgresWalletDeploymentStore;
const children: ChildProcess[] = [];
function message(child: ChildProcess, kind: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`No ${kind} from worker`)); }, 15000);
    const received = (value: any) => { if (value?.kind === kind) { cleanup(); resolve(value); } };
    const exited = () => { cleanup(); reject(new Error("Worker exited")); };
    const cleanup = () => { clearTimeout(timer); child.off("message", received); child.off("exit", exited); };
    child.on("message", received); child.on("exit", exited);
  });
}
async function worker() {
  const child = fork(fileURLToPath(new URL("./fixtures/wallet-deployment-settlement-process.ts", import.meta.url)), [], {
    execArgv: ["--import", "tsx"], env: { ...process.env, WALLET_DEPLOYMENT_SETTLEMENT_TEST_SCHEMA: schema }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  children.push(child); const ready = await message(child, "ready");
  return { child, request: async (body: unknown): Promise<{ status: number; body: any }> => {
    const result = await fetch(`http://127.0.0.1:${ready.port}`, { method: "POST", body: JSON.stringify(body),
      headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15000) });
    return { status: result.status, body: await result.json() };
  } };
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise<void>(resolve => child.once("exit", resolve)); child.kill("SIGKILL"); await done;
}
suite("durable sequential local deployment settlement", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 5 });
    for (const name of ["013_rest_wallet_ceremonies.sql", "015_rest_wallet_enrollment.sql", "016_rest_wallet_deployments.sql",
      "018_rest_wallet_deployment_observations.sql", "021_rest_wallet_deployment_dispatch.sql", "026_wallet_deployment_settlement.sql"])
      await pool.query(await readFile(new URL(`../src/db/migrations/${name}`, import.meta.url), "utf8"));
    store = new PostgresWalletDeploymentStore(pool);
  });
  beforeEach(async () => { await pool.query("TRUNCATE rest_wallet_deployments,rest_wallet_deployment_pools,rest_wallet_credentials,rest_wallet_enrollments,rest_wallet_ceremonies CASCADE"); });
  afterEach(async () => { await Promise.all(children.splice(0).map(kill)); });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } });
  it("initializes a previously unused local allocation with an explicit immutable nonce", async () => {
    const context = await initializedSettlementPool(pool, store);
    expect(context.pool.accounting).toMatchObject({ initialNonce: "1", nextNonce: "1", spentWei: "0", sequence: 0 });
  });
  it("settles a verified exact winner once while retaining raw bytes and the original allocation", async () => {
    await initializedSettlementPool(pool, store); const context = await signedSettlementUser(pool, store);
    const evidence = syntheticSettlement(context, await settlementDatabaseNow(pool)), result = await store.settle(context, evidence);
    expect(result.settlement).toMatchObject({ nonce: "1", nextNonce: "2", sequence: 1, spentWei: evidence.fees.totalWei });
    expect(result.pool.activeOperationId).toBeNull();
    expect(result.pool.configuration).toEqual(context.pool.configuration);
    expect((await store.get(context.operation.id))!.signed).toEqual(context.operation.signed);
    expect(await store.settle(context, evidence)).toEqual({ ...result, replayed: true });
  });
  it("debits once across two actual settlement processes and admits only one of two distinct next users", async () => {
    await initializedSettlementPool(pool, store); const context = await signedSettlementUser(pool, store), a = await worker(), b = await worker();
    const evidence = syntheticSettlement(context, await settlementDatabaseNow(pool));
    const results = await Promise.all([a.request({ action: "settle", context, evidence }), b.request({ action: "settle", context, evidence })]);
    expect(results.map(result => result.status)).toEqual([200,200]);
    expect(results.map(result => result.body.replayed).sort()).toEqual([false,true]);
    const first = results[0]!.body.settlement;
    const users = await Promise.all([preparedSettlementUser(pool, store), preparedSettlementUser(pool, store)]);
    const claims = await Promise.all([a.request({ action: "claim", input: users[0]!.input }), b.request({ action: "claim", input: users[1]!.input })]);
    expect(claims.map(result => result.status).sort()).toEqual([200,409]);
    const current = await store.loadFundingContext(context.pool.configuration.id);
    expect(current.pool.accounting).toMatchObject({ spentWei: evidence.fees.totalWei, sequence: 1, nextNonce: "2" });
    expect(current.pool.activeOperationId).not.toBe(context.operation.id);
    expect(await store.getSettlement(context.operation.id)).toEqual(first);
    const replay = await store.settle(context, evidence);
    expect(replay.replayed).toBe(true); expect(replay.settlement).toEqual(first); expect(replay.pool).toEqual(current.pool);
    expect((await store.listUnresolved()).items.map(item => item.id)).toEqual([current.pool.activeOperationId]);
  });
  it.each(["after-receipt", "after-marker", "after-debit", "after-commit"])("recovers process death at %s with one atomic receipt/debit/lane transition", async barrier => {
    await initializedSettlementPool(pool, store); const context = await signedSettlementUser(pool, store), child = await worker();
    const evidence = syntheticSettlement(context, await settlementDatabaseNow(pool)), reached = message(child.child, "barrier");
    const request = child.request({ action: "settle", context, evidence, barrier }).catch(() => null);
    await reached;
    const receipt = await store.getSettlement(context.operation.id);
    expect(receipt === null).toBe(barrier !== "after-commit");
    await kill(child.child); await request;
    if (barrier !== "after-commit") expect(await store.loadSettlementContext(context.operation.id)).toEqual(context);
    const result = await store.settle(context, evidence);
    expect(result.replayed).toBe(barrier === "after-commit");
    expect(result.pool.accounting).toMatchObject({ sequence: 1, spentWei: evidence.fees.totalWei });
    expect((await pool.query("SELECT count(*)::int AS count FROM rest_wallet_deployment_settlements")).rows[0].count).toBe(1);
  });
  it("rolls back all settlement writes when evidence expires behind a process barrier", async () => {
    await initializedSettlementPool(pool, store); const context = await signedSettlementUser(pool, store), child = await worker();
    const evidence = syntheticSettlement(context, await settlementDatabaseNow(pool)); evidence.funding.expiresAt = evidence.funding.observedAt + 300;
    const reached = message(child.child, "barrier"), request = child.request({ action: "settle", context, evidence, barrier: "after-debit", continueBarrier: true });
    await reached; await new Promise(resolve => setTimeout(resolve, 350)); child.child.send({ kind: "continue" });
    expect((await request).status).toBe(409); expect(await store.getSettlement(context.operation.id)).toBeNull();
    expect(await store.loadSettlementContext(context.operation.id)).toEqual(context);
  });
  it.each(["confirmed", "pending", "finalized", "balance"])("latches a durable %s contradiction without refund, cursor adoption or receipt", async field => {
    await initializedSettlementPool(pool, store); const context = await signedSettlementUser(pool, store);
    const evidence = syntheticSettlement(context, await settlementDatabaseNow(pool));
    if (field === "confirmed") evidence.funding.confirmedNonce = "3";
    if (field === "pending") evidence.funding.pendingNonce = "3";
    if (field === "finalized") evidence.finalizedNonce = "3";
    if (field === "balance") evidence.funding.balanceWei = "0";
    const result = await store.settle(context, evidence);
    expect(result.settlement).toBeNull();
    expect(result.pool.accounting).toMatchObject({ sequence: 0, nextNonce: "1", spentWei: "0", fence: { reason: field === "balance" ? "balance-deficit" : "nonce-conflict" } });
    expect(result.pool.activeOperationId).toBe(context.operation.id);
    expect((await store.get(context.operation.id))!.signed).toEqual(context.operation.signed);
  });
  it("retains a post-settlement contradiction and explicit restore fence without rewriting receipts", async () => {
    await initializedSettlementPool(pool, store); const context = await signedSettlementUser(pool, store);
    const first = await store.settle(context, syntheticSettlement(context, await settlementDatabaseNow(pool)));
    const funding = await store.loadFundingContext(context.pool.configuration.id), proof = syntheticFunding(funding, await settlementDatabaseNow(pool));
    proof.previousAnchor = { ...proof.previousAnchor!, blockHash: `0x${"ff".repeat(32)}` };
    const fenced = await store.fenceAccounting(funding, proof);
    expect(fenced.accounting!.fence!.reason).toBe("finalized-anchor-replaced");
    expect(fenced.accounting!.spentWei).toBe(first.settlement!.spentWei);
    expect(await store.getSettlement(context.operation.id)).toEqual(first.settlement);
    await expect(store.claim((await preparedSettlementUser(pool, store)).input)).rejects.toMatchObject({ status: 409 });
  });
  it("fails closed on an explicit restore incident while retaining the occupied liability", async () => {
    await initializedSettlementPool(pool, store); const context = await signedSettlementUser(pool, store);
    const fenced = await store.fenceAccounting(context, { reason: "restore-required" });
    expect(fenced.accounting!.fence!.reason).toBe("restore-required");
    expect(fenced.activeOperationId).toBe(context.operation.id);
    expect((await store.get(context.operation.id))!.signed).toEqual(context.operation.signed);
  });
  it.each(["accounting=NULL", "accounting=jsonb_set(accounting,'{spentWei}','\"0\"')", "accounting=jsonb_set(accounting,'{nextNonce}','\"1\"')",
    "accounting=jsonb_set(accounting,'{sequence}','0')", "accounting=jsonb_set(accounting,'{lastSettlementId}','null')"])("SQL rejects settlement accounting reset: %s", async expression => {
    await initializedSettlementPool(pool, store); const context = await signedSettlementUser(pool, store);
    await store.settle(context, syntheticSettlement(context, await settlementDatabaseNow(pool)));
    await expect(pool.query(`UPDATE rest_wallet_deployment_pools SET ${expression},revision=revision+1`)).rejects.toMatchObject({ code: "23514" });
  });
  it("SQL rejects receipt deletion/rewrite, marker clearing, signed-history changes and fence clearing", async () => {
    await initializedSettlementPool(pool, store); const context = await signedSettlementUser(pool, store);
    await store.settle(context, syntheticSettlement(context, await settlementDatabaseNow(pool)));
    for (const sql of ["DELETE FROM rest_wallet_deployment_settlements", "UPDATE rest_wallet_deployment_settlements SET sequence=sequence+1",
      "UPDATE rest_wallet_deployments SET settlement_id=NULL", "UPDATE rest_wallet_deployments SET observation_saved_at=1",
      "UPDATE rest_wallet_deployments SET revision=revision+1", "UPDATE rest_wallet_deployments SET raw_transaction='0x00'"])
      await expect(pool.query(sql)).rejects.toMatchObject({ code: "23514" });
    const funding = await store.loadFundingContext(context.pool.configuration.id); await store.fenceAccounting(funding, { reason: "restore-required" });
    await expect(pool.query("UPDATE rest_wallet_deployment_pools SET accounting=jsonb_set(accounting,'{fence}','null'),revision=revision+1")).rejects.toMatchObject({ code: "23514" });
  });

  it("SQL rejects resetting a live accounting CAS revision without an accounting transition", async () => {
    const context = await initializedSettlementPool(pool, store);
    await expect(pool.query("UPDATE rest_wallet_deployment_pools SET revision=0")).rejects.toMatchObject({ code: "23514" });
    expect((await store.loadFundingContext(context.pool.configuration.id)).pool).toEqual(context.pool);
  });
  it("retains the lane while a dispatch lease is live, then settles the same evidence after expiry", async () => {
    await initializedSettlementPool(pool, store); let context = await signedSettlementUser(pool, store);
    const observed = syntheticDeploymentObservation(context, await settlementDatabaseNow(pool));
    await store.saveObservation({ operationId: context.operation.id, signedHash: context.operation.signed!.hash, expectedRevision: context.operation.revision, observation: observed });
    context = await store.loadSettlementContext(context.operation.id);
    const legacy = syntheticDeploymentAdmission(context, await settlementDatabaseNow(pool));
    const admission = { ...legacy, version: "center-wallet-deployment-local-admission-v2" as const,
      environment: { kind: "unforked-anvil" as const, genesisHash: context.pool.accounting!.environment.genesisHash, head: legacy.environment.head },
      accounting: { digest: enrollmentDigest(context.pool.accounting), remainingWei: walletDeploymentRemainingWei(context.pool), nextNonce: context.pool.accounting!.nextNonce } };
    const lease = await store.leaseDispatch({ operationId: context.operation.id, expectedRevision: context.operation.revision, signedHash: context.operation.signed!.hash, admission, leaseMs: 400 });
    context = await store.loadSettlementContext(context.operation.id);
    const evidence = syntheticSettlement(context, await settlementDatabaseNow(pool));
    evidence.funding.head = observed.head!; evidence.observation.head = observed.head; evidence.observation.wallet.evidence = observed.head;
    evidence.observation.transaction.receipt!.block = observed.head!; evidence.observation.finality.evidence = observed.head;
    await expect(store.settle(context, evidence)).rejects.toMatchObject({ code: "WALLET_DEPLOYMENT_BUSY" });
    expect(await store.getSettlement(context.operation.id)).toBeNull();
    await new Promise(resolve => setTimeout(resolve, Math.max(1, lease.leaseUntil - Date.now() + 15)));
    expect((await store.settle(context, evidence)).settlement).not.toBeNull();
    await expect(store.leaseDispatch({ operationId: context.operation.id, expectedRevision: context.operation.revision, signedHash: context.operation.signed!.hash, admission })).rejects.toBeDefined();
  });
  it("requires fresh accounting evidence after pool lock waits and rolls back ceremony consumption", async () => {
    await initializedSettlementPool(pool, store); const prepared = await preparedSettlementUser(pool, store), child = await worker();
    prepared.input.funding.expiresAt = prepared.input.funding.observedAt + 200;
    const locked = await pool.connect(); await locked.query("BEGIN"); await locked.query("SELECT id FROM rest_wallet_deployment_pools FOR UPDATE");
    const request = child.request({ action: "claim", input: prepared.input });
    await new Promise(resolve => setTimeout(resolve, 260)); await locked.query("COMMIT"); locked.release();
    expect((await request).status).toBe(409);
    expect((await store.get(prepared.operation.id))!.state).toBe("prepared");
    expect((await store.loadFundingContext(prepared.operation.poolId)).pool.activeOperationId).toBeNull();
  });

  it.each(["before-insert", "before-commit", "head-before-commit"])("SQL cannot release a lane when proof expires %s", async stage => {
    await initializedSettlementPool(pool, store); const context = await signedSettlementUser(pool, store), now = await settlementDatabaseNow(pool);
    const evidence = syntheticSettlement(context, stage === "before-insert" ? now - 1000 : now); evidence.funding.expiresAt = stage === "before-insert" ? now - 500 : now + 200;
    if (stage === "head-before-commit") {
      evidence.funding.expiresAt = now + 5000;
      Object.assign(evidence.funding.head, { blockNumber: "101", blockHash: `0x${"bc".repeat(32)}`,
        timestamp: String(Math.floor(now / 1000) - 298) });
    }
    const receipt = { version: "center-wallet-deployment-settlement-receipt-v1", id: context.operation.id, poolId: context.pool.configuration.id,
      operationId: context.operation.id, evidenceDigest: enrollmentDigest(evidence), evidence, nonce: "1", priorSequence: 0, sequence: 1,
      spentWei: evidence.fees.totalWei, nextNonce: "2", settledAt: stage === "before-insert" ? now - 800 : now };
    const accounting = { ...context.pool.accounting!, sequence: 1, spentWei: receipt.spentWei, nextNonce: "2",
      lastSettlementId: context.operation.id, lastSettlementAnchor: evidence.observation.finality.evidence };
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await expect((async () => {
        await client.query("INSERT INTO rest_wallet_deployment_settlements(id,pool_id,sequence,evidence_digest,receipt) VALUES($1,$2,1,$3,$4::jsonb)",
          [receipt.id, receipt.poolId, receipt.evidenceDigest, JSON.stringify(receipt)]);
        await client.query("UPDATE rest_wallet_deployments SET settlement_id=id WHERE id=$1", [receipt.id]);
        await client.query("UPDATE rest_wallet_deployment_pools SET accounting=$2::jsonb,active_operation_id=NULL,revision=revision+1 WHERE id=$1",
          [receipt.poolId, JSON.stringify(accounting)]);
        if (stage === "before-commit") await client.query("SELECT pg_sleep(0.25)");
        if (stage === "head-before-commit") {
          const deadline = Number(BigInt(evidence.funding.head.timestamp) * 1000n) + 300000;
          await client.query("SELECT pg_sleep($1)", [Math.max(0.05, (deadline - Date.now() + 50) / 1000)]);
        }
        await client.query("COMMIT");
      })()).rejects.toMatchObject({ code: "23514" });
    } finally { await client.query("ROLLBACK"); client.release(); }
    expect(await store.getSettlement(context.operation.id)).toBeNull();
  });

});
