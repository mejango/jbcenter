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
import { initializedSettlementPool, releasedSettlementUser, signedSettlementUser, syntheticSettlement, settlementDatabaseNow, preparedSettlementUser,
  syntheticFunding } from "./fixtures/wallet-deployment-settlement.js";
import { deploymentFixtureConfiguration } from "./fixtures/wallet-deployment-execution.js";
import type { WalletDeploymentSettlementContext } from "../src/rest/wallet/deploymentSettlement.js";
/** The active user's inclusion is canonical (sender nonce one past it) but not final. */
function canonicalInclusion(context: WalletDeploymentSettlementContext, now: number) {
  const observation = syntheticDeploymentObservation(context, now), next = String(BigInt(context.operation.template!.transaction.nonce) + 1n);
  const head = syntheticFunding(context, now).head;
  observation.head = head; observation.wallet.evidence = head;
  observation.transaction = { state: "canonical-success", reason: null, conflict: null, nonce: { confirmed: next, pending: next },
    receipt: { block: head, transactionIndex: "0", status: "success", gasUsed: "500000", effectiveGasPrice: "1000000", logCount: 1, logsHash: `0x${"12".repeat(32)}` } };
  observation.finality = { state: "unfinalized", evidence: { ...head, blockNumber: "90", blockHash: `0x${"5a".repeat(32)}` } };
  observation.fees.executionWei = "500000000000";
  return observation;
}
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
    for (const name of ["013_rest_wallet_ceremonies.sql", "015_rest_wallet_enrollment.sql", "046_wallet_signup_window.sql", "041_wallet_passkey_name.sql", "043_wallet_networks.sql", "044_wallet_devices.sql", "016_rest_wallet_deployments.sql", "036_wallet_deployment_approval_v2.sql",
      "018_rest_wallet_deployment_observations.sql", "021_rest_wallet_deployment_dispatch.sql", "026_wallet_deployment_settlement.sql", "034_wallet_deployment_base.sql", "054_wallet_deployment_inclusion_release.sql", "056_wallet_deployment_release_after_settled_dispatch.sql"])
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
  it("releases the lane at canonical inclusion and admits the next user before finality", async () => {
    await initializedSettlementPool(pool, store); const signed = await signedSettlementUser(pool, store);
    // Not canonical yet: nothing to release.
    await expect(store.release({ operationId: signed.operation.id, expectedRevision: signed.operation.revision })).rejects.toMatchObject({ status: 409 });
    const saved = await store.saveObservation({ operationId: signed.operation.id, expectedRevision: signed.operation.revision,
      signedHash: signed.operation.signed!.hash, observation: canonicalInclusion(signed, await settlementDatabaseNow(pool)) });
    const released = await store.release({ operationId: signed.operation.id, expectedRevision: saved.operation.revision });
    expect(released.replayed).toBe(false);
    expect(released.operation).toMatchObject({ reservedWei: signed.operation.signed!.maximumExecutionCost, revision: saved.operation.revision });
    expect(released.operation.releasedAt).toBeGreaterThan(0);
    expect(released.pool).toMatchObject({ activeOperationId: null, reservedWei: signed.operation.signed!.maximumExecutionCost,
      accounting: { nextNonce: "2", sequence: 0, spentWei: "0", fence: null } });
    expect(await store.release({ operationId: signed.operation.id, expectedRevision: saved.operation.revision })).toEqual({ ...released, replayed: true });
    expect(await store.getSettlement(signed.operation.id)).toBeNull();
    // The next user claims nonce 2 while nonce 1 waits for finality; the reservation is not spendable.
    const next = await preparedSettlementUser(pool, store);
    expect(next.input.admission.confirmedNonce).toBe("2");
    const claimed = await store.claim(next.input);
    expect(claimed.operation.template!.transaction.nonce).toBe("2");
    expect((await store.loadFundingContext(signed.pool.configuration.id)).pool).toMatchObject({ activeOperationId: claimed.operation.id, reservedWei: released.operation.reservedWei });
    // Finality settles nonce 1 behind the active nonce 2: sequence and the debit advance, the lane and nextNonce do not.
    const context = await store.loadSettlementContext(signed.operation.id);
    const evidence = syntheticSettlement(context, await settlementDatabaseNow(pool)), result = await store.settle(context, evidence);
    expect(result.settlement).toMatchObject({ nonce: "1", nextNonce: "2", sequence: 1, spentWei: evidence.fees.totalWei });
    expect(result.pool).toMatchObject({ activeOperationId: claimed.operation.id, reservedWei: "0",
      accounting: { nextNonce: "2", sequence: 1, spentWei: evidence.fees.totalWei, lastSettlementId: signed.operation.id } });
    expect((await store.listUnresolved()).items.map(item => [item.id, item.releasedAt])).toEqual([[claimed.operation.id, null]]);
  });
  it("settles a verified exact winner once while retaining raw bytes and the original allocation", async () => {
    await initializedSettlementPool(pool, store); const context = await releasedSettlementUser(pool, store);
    const evidence = syntheticSettlement(context, await settlementDatabaseNow(pool)), result = await store.settle(context, evidence);
    expect(result.settlement).toMatchObject({ nonce: "1", nextNonce: "2", sequence: 1, spentWei: evidence.fees.totalWei });
    expect(result.pool.activeOperationId).toBeNull();
    expect(result.pool.accounting).toMatchObject({ nextNonce: "2", sequence: 1 });
    expect(result.pool.configuration).toEqual(context.pool.configuration);
    expect((await store.get(context.operation.id))!.signed).toEqual(context.operation.signed);
    expect(await store.settle(context, evidence)).toEqual({ ...result, replayed: true });
  });
  it("debits once across two actual settlement processes and admits only one of two distinct next users", async () => {
    await initializedSettlementPool(pool, store); const context = await releasedSettlementUser(pool, store), a = await worker(), b = await worker();
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
    await initializedSettlementPool(pool, store); const context = await releasedSettlementUser(pool, store), child = await worker();
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
    await initializedSettlementPool(pool, store); const context = await releasedSettlementUser(pool, store), child = await worker();
    const evidence = syntheticSettlement(context, await settlementDatabaseNow(pool)); evidence.funding.expiresAt = evidence.funding.observedAt + 2_000;
    const reached = message(child.child, "barrier"), request = child.request({ action: "settle", context, evidence, barrier: "after-debit", continueBarrier: true });
    // The window has to survive the request that reaches the barrier; the database clock ends it.
    await reached;
    await pool.query("SELECT pg_sleep(greatest(0, $1::bigint + 50 - floor(extract(epoch FROM clock_timestamp())*1000)) / 1000.0)",
      [String(evidence.funding.expiresAt)]);
    child.child.send({ kind: "continue" });
    expect((await request).status).toBe(409); expect(await store.getSettlement(context.operation.id)).toBeNull();
    expect(await store.loadSettlementContext(context.operation.id)).toEqual(context);
  });
  it.each(["confirmed", "pending", "finalized", "balance"])("latches a durable %s contradiction without refund, cursor adoption or receipt", async field => {
    await initializedSettlementPool(pool, store); const context = await releasedSettlementUser(pool, store);
    const evidence = syntheticSettlement(context, await settlementDatabaseNow(pool));
    if (field === "confirmed") evidence.funding.confirmedNonce = "3";
    if (field === "pending") evidence.funding.pendingNonce = "3";
    if (field === "finalized") evidence.finalizedNonce = "3";
    if (field === "balance") evidence.funding.balanceWei = "0";
    const result = await store.settle(context, evidence);
    expect(result.settlement).toBeNull();
    expect(result.pool.accounting).toMatchObject({ sequence: 0, nextNonce: "2", spentWei: "0", fence: { reason: field === "balance" ? "balance-deficit" : "nonce-conflict" } });
    expect(result.pool.activeOperationId).toBeNull();
    expect((await store.get(context.operation.id))!).toMatchObject({ signed: context.operation.signed, releasedAt: context.operation.releasedAt });
    await expect(store.claim((await preparedSettlementUser(pool, store)).input)).rejects.toMatchObject({ status: 409 });
  });
  it("reserves a released inclusion's admitted maximum cost against the allocation until its settlement", async () => {
    const configuration = deploymentFixtureConfiguration();
    configuration.allocationWei = "5000000000000000"; configuration.policy.maximumTransactionCost = "5000000000000000";
    await initializedSettlementPool(pool, store, undefined, configuration);
    const first = await releasedSettlementUser(pool, store), second = await preparedSettlementUser(pool, store);
    expect(BigInt(first.pool.reservedWei)).toBe(BigInt(first.operation.signed!.maximumExecutionCost));
    // 5e15 allocation, 3e15 reserved: the second user's 3e15 ceiling does not fit until nonce 1 settles.
    await expect(store.claim(second.input)).rejects.toMatchObject({ code: "WALLET_DEPLOYMENT_CONFLICT" });
    await store.settle(first, syntheticSettlement(first, await settlementDatabaseNow(pool)));
    const retry = await preparedSettlementUser(pool, store);
    expect((await store.claim(retry.input)).operation.template!.transaction.nonce).toBe("2");
  });
  it("settles behind an active operation that is already included and paid but not yet released", async () => {
    await initializedSettlementPool(pool, store);
    const first = await releasedSettlementUser(pool, store), second = await signedSettlementUser(pool, store);
    expect(second.pool).toMatchObject({ activeOperationId: second.operation.id, accounting: { nextNonce: "2" } });
    const context = await store.loadSettlementContext(first.operation.id);
    const evidence = syntheticSettlement(context, await settlementDatabaseNow(pool));
    // The chain already holds nonce 2 and its fee left the balance; the accounting has not released it.
    evidence.funding.confirmedNonce = evidence.funding.pendingNonce = "3";
    evidence.funding.balanceWei = String(BigInt(evidence.funding.balanceWei) - BigInt(second.operation.signed!.maximumExecutionCost));
    const short = structuredClone(evidence); short.funding.balanceWei = String(BigInt(short.funding.balanceWei) - 1n);
    expect((await store.settle(context, short)).pool.accounting!.fence).toMatchObject({ reason: "balance-deficit" });
    await pool.query("UPDATE rest_wallet_deployment_pools SET accounting=jsonb_set(accounting,'{fence}','null'),revision=revision+1").catch(() => undefined);
  });
  it("settles behind an included, unreleased active operation without a false balance fence", async () => {
    await initializedSettlementPool(pool, store);
    const first = await releasedSettlementUser(pool, store), second = await signedSettlementUser(pool, store);
    const context = await store.loadSettlementContext(first.operation.id);
    const evidence = syntheticSettlement(context, await settlementDatabaseNow(pool));
    evidence.funding.confirmedNonce = evidence.funding.pendingNonce = "3";
    evidence.funding.balanceWei = String(BigInt(evidence.funding.balanceWei) - BigInt(second.operation.signed!.maximumExecutionCost));
    const result = await store.settle(context, evidence);
    expect(result.settlement).toMatchObject({ nonce: "1", sequence: 1 });
    expect(result.pool).toMatchObject({ activeOperationId: second.operation.id, accounting: { nextNonce: "2", sequence: 1, fence: null } });
  });
  it("settles released inclusions in nonce order", async () => {
    await initializedSettlementPool(pool, store);
    const first = await releasedSettlementUser(pool, store), second = await releasedSettlementUser(pool, store);
    expect([first.operation.template!.transaction.nonce, second.operation.template!.transaction.nonce]).toEqual(["1", "2"]);
    expect(second.pool).toMatchObject({ activeOperationId: null, accounting: { nextNonce: "3", sequence: 0 } });
    expect(BigInt(second.pool.reservedWei)).toBe(BigInt(first.operation.reservedWei!) + BigInt(second.operation.reservedWei!));
    await expect(store.settle(second, syntheticSettlement(second, await settlementDatabaseNow(pool)))).rejects.toMatchObject({ code: "WALLET_DEPLOYMENT_SETTLEMENT_INVALID" });
    const settledFirst = await store.settle(await store.loadSettlementContext(first.operation.id), syntheticSettlement(await store.loadSettlementContext(first.operation.id), await settlementDatabaseNow(pool)));
    expect(settledFirst.settlement).toMatchObject({ nonce: "1", sequence: 1 });
    const context = await store.loadSettlementContext(second.operation.id);
    const settledSecond = await store.settle(context, syntheticSettlement(context, await settlementDatabaseNow(pool)));
    expect(settledSecond.settlement).toMatchObject({ nonce: "2", sequence: 2 });
    expect(settledSecond.pool).toMatchObject({ reservedWei: "0", accounting: { nextNonce: "3", sequence: 2 } });
    expect((await store.listUnresolved()).items).toEqual([]);
  });
  it("fences the pool when a released inclusion leaves the canonical chain, retaining bytes and history", async () => {
    await initializedSettlementPool(pool, store); const context = await releasedSettlementUser(pool, store);
    const funding = await store.loadFundingContext(context.pool.configuration.id);
    // Still canonical: nothing to fence.
    await expect(store.fenceAccounting(funding, { reason: "inclusion-reorged", operationId: context.operation.id })).rejects.toMatchObject({ status: 409 });
    const reorged = syntheticDeploymentObservation(context, await settlementDatabaseNow(pool));
    reorged.head = null; reorged.transaction = { state: "reorged", reason: "provider-before-reserved-nonce", receipt: null, conflict: null, nonce: { confirmed: "1", pending: "1" } };
    reorged.wallet = { ...reorged.wallet, state: "unknown", evidence: null, reason: "full-wallet-history-unavailable" };
    const saved = await store.saveObservation({ operationId: context.operation.id, expectedRevision: context.operation.revision, signedHash: context.operation.signed!.hash, observation: reorged });
    expect(saved.operation.historicalCanonicalObservation!.transaction.state).toBe("canonical-success");
    await expect(store.claim((await preparedSettlementUser(pool, store)).input)).rejects.toMatchObject({ code: "WALLET_DEPLOYMENT_BUSY" });
    const fenced = await store.fenceAccounting(funding, { reason: "inclusion-reorged", operationId: context.operation.id });
    expect(fenced.accounting!.fence!.reason).toBe("inclusion-reorged");
    expect(fenced).toMatchObject({ activeOperationId: null, reservedWei: context.pool.reservedWei, accounting: { nextNonce: "2", sequence: 0 } });
    expect((await store.get(context.operation.id))!).toMatchObject({ signed: context.operation.signed, releasedAt: context.operation.releasedAt });
    await expect(store.settle(await store.loadSettlementContext(context.operation.id), syntheticSettlement(context, await settlementDatabaseNow(pool)))).rejects.toMatchObject({ status: 409 });
    await expect(pool.query("UPDATE rest_wallet_deployment_pools SET accounting=jsonb_set(accounting,'{fence}','null'),revision=revision+1")).rejects.toMatchObject({ code: "23514" });
  });
  it("releases exactly once across two processes and atomically with the lane", async () => {
    await initializedSettlementPool(pool, store); const signed = await signedSettlementUser(pool, store);
    const saved = await store.saveObservation({ operationId: signed.operation.id, expectedRevision: signed.operation.revision,
      signedHash: signed.operation.signed!.hash, observation: canonicalInclusion(signed, await settlementDatabaseNow(pool)) });
    const child = await worker(), reached = message(child.child, "barrier");
    const request = child.request({ action: "release", operationId: signed.operation.id, expectedRevision: saved.operation.revision, barrier: "after-release" }).catch(() => null);
    await reached;
    expect((await store.get(signed.operation.id))!.releasedAt).toBeNull();
    await kill(child.child); await request;
    expect((await store.loadFundingContext(signed.pool.configuration.id)).pool).toMatchObject({ activeOperationId: signed.operation.id, accounting: { nextNonce: "1" } });
    const a = await worker(), b = await worker();
    const results = await Promise.all([a.request({ action: "release", operationId: signed.operation.id, expectedRevision: saved.operation.revision }),
      b.request({ action: "release", operationId: signed.operation.id, expectedRevision: saved.operation.revision })]);
    expect(results.map(result => result.status)).toEqual([200, 200]);
    expect(results.map(result => result.body.replayed).sort()).toEqual([false, true]);
    expect((await store.loadFundingContext(signed.pool.configuration.id)).pool).toMatchObject({ activeOperationId: null, revision: signed.pool.revision + 1, accounting: { nextNonce: "2" } });
  });
  it("bounds the released queue at eight and refuses the ninth claim", async () => {
    await initializedSettlementPool(pool, store);
    for (let index = 0; index < 8; index++) await releasedSettlementUser(pool, store);
    expect((await store.loadFundingContext((await preparedSettlementUser(pool, store)).operation.poolId)).pool.accounting).toMatchObject({ nextNonce: "9", sequence: 0 });
    await expect(store.claim((await preparedSettlementUser(pool, store)).input)).rejects.toMatchObject({ code: "WALLET_DEPLOYMENT_BUSY" });
  });
  it("SQL rejects a release without canonical evidence, without the lane, or beyond the bound", async () => {
    await initializedSettlementPool(pool, store); const signed = await signedSettlementUser(pool, store), now = await settlementDatabaseNow(pool);
    const release = (id: string) => pool.query("UPDATE rest_wallet_deployments SET released_at=$2,reserved_wei=maximum_execution_cost WHERE id=$1", [id, now]);
    const lane = (id: string) => pool.query(`UPDATE rest_wallet_deployment_pools SET accounting=jsonb_set(accounting,'{nextNonce}','"2"'),active_operation_id=NULL,revision=revision+1 WHERE active_operation_id=$1`, [id]);
    // No observation at all, then a not-observed one.
    await expect(release(signed.operation.id)).rejects.toMatchObject({ code: "23514" });
    await store.saveObservation({ operationId: signed.operation.id, expectedRevision: signed.operation.revision, signedHash: signed.operation.signed!.hash,
      observation: syntheticDeploymentObservation(signed, now) });
    await expect(release(signed.operation.id)).rejects.toMatchObject({ code: "23514" });
    // Canonical, but the sender nonce has not moved past it.
    const stale = canonicalInclusion(signed, now + 1), observed = syntheticDeploymentObservation(signed, now).head;
    stale.head = observed; stale.wallet.evidence = observed; stale.transaction.receipt!.block = observed!; stale.transaction.nonce = { confirmed: "1", pending: "1" };
    const revision = (await store.get(signed.operation.id))!.revision;
    await store.saveObservation({ operationId: signed.operation.id, expectedRevision: revision, signedHash: signed.operation.signed!.hash, observation: stale });
    await expect(release(signed.operation.id)).rejects.toMatchObject({ code: "23514" });
    await expect(store.release({ operationId: signed.operation.id, expectedRevision: revision + 1 })).resolves.toMatchObject({ pool: { accounting: { fence: { reason: "nonce-conflict" } } } });
    expect((await store.get(signed.operation.id))!.releasedAt).toBeNull();
    // The lane cannot move on its own, before or without the released marker.
    await expect(lane(signed.operation.id)).rejects.toMatchObject({ code: "23514" });
  });
  it("retains a post-settlement contradiction and explicit restore fence without rewriting receipts", async () => {
    await initializedSettlementPool(pool, store); const context = await releasedSettlementUser(pool, store);
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
    "accounting=jsonb_set(accounting,'{nextNonce}','\"3\"')", "accounting=jsonb_set(accounting,'{sequence}','0')", "accounting=jsonb_set(accounting,'{lastSettlementId}','null')"])("SQL rejects settlement accounting reset: %s", async expression => {
    await initializedSettlementPool(pool, store); const context = await releasedSettlementUser(pool, store);
    await store.settle(context, syntheticSettlement(context, await settlementDatabaseNow(pool)));
    await expect(pool.query(`UPDATE rest_wallet_deployment_pools SET ${expression},revision=revision+1`)).rejects.toMatchObject({ code: "23514" });
  });
  it("SQL rejects receipt deletion/rewrite, marker clearing, signed-history changes and fence clearing", async () => {
    await initializedSettlementPool(pool, store); const context = await releasedSettlementUser(pool, store);
    await store.settle(context, syntheticSettlement(context, await settlementDatabaseNow(pool)));
    for (const sql of ["DELETE FROM rest_wallet_deployment_settlements", "UPDATE rest_wallet_deployment_settlements SET sequence=sequence+1",
      "UPDATE rest_wallet_deployments SET settlement_id=NULL", "UPDATE rest_wallet_deployments SET observation_saved_at=1",
      "UPDATE rest_wallet_deployments SET revision=revision+1", "UPDATE rest_wallet_deployments SET raw_transaction='0x00'",
      "UPDATE rest_wallet_deployments SET released_at=NULL,reserved_wei=NULL", "UPDATE rest_wallet_deployments SET reserved_wei=reserved_wei+1"])
      await expect(pool.query(sql)).rejects.toMatchObject({ code: "23514" });
    const funding = await store.loadFundingContext(context.pool.configuration.id); await store.fenceAccounting(funding, { reason: "restore-required" });
    await expect(pool.query("UPDATE rest_wallet_deployment_pools SET accounting=jsonb_set(accounting,'{fence}','null'),revision=revision+1")).rejects.toMatchObject({ code: "23514" });
  });

  it("SQL rejects resetting a live accounting CAS revision without an accounting transition", async () => {
    const context = await initializedSettlementPool(pool, store);
    await expect(pool.query("UPDATE rest_wallet_deployment_pools SET revision=0")).rejects.toMatchObject({ code: "23514" });
    expect((await store.loadFundingContext(context.pool.configuration.id)).pool).toEqual(context.pool);
  });
  it("releases the lane as soon as the attempt is settled, without waiting out its lease", async () => {
    await initializedSettlementPool(pool, store); let context = await signedSettlementUser(pool, store);
    const observed = syntheticDeploymentObservation(context, await settlementDatabaseNow(pool));
    await store.saveObservation({ operationId: context.operation.id, signedHash: context.operation.signed!.hash, expectedRevision: context.operation.revision, observation: observed });
    context = await store.loadSettlementContext(context.operation.id);
    const legacy = syntheticDeploymentAdmission(context, await settlementDatabaseNow(pool));
    const admission = { ...legacy, version: "center-wallet-deployment-local-admission-v2" as const,
      environment: { kind: "unforked-anvil" as const, genesisHash: context.pool.accounting!.environment.genesisHash, head: legacy.environment.head },
      accounting: { digest: enrollmentDigest(context.pool.accounting), remainingWei: walletDeploymentRemainingWei(context.pool), nextNonce: context.pool.accounting!.nextNonce } };
    const lease = await store.leaseDispatch({ operationId: context.operation.id, expectedRevision: context.operation.revision, signedHash: context.operation.signed!.hash, admission, leaseMs: 15_000 });
    const settled = await store.settleDispatch({ operationId: context.operation.id, expectedRevision: lease.revision, leaseToken: lease.leaseToken, signedHash: context.operation.signed!.hash, status: "accepted" });
    expect(settled.journal.status).toBe("accepted"); expect(settled.journal.leaseUntil).toBeGreaterThan(Date.now());
    const included = canonicalInclusion(context, await settlementDatabaseNow(pool));
    included.head = observed.head; included.wallet.evidence = observed.head; included.transaction.receipt!.block = observed.head!;
    const saved = await store.saveObservation({ operationId: context.operation.id, signedHash: context.operation.signed!.hash, expectedRevision: context.operation.revision, observation: included });
    // The provider answered; that attempt sends nothing more. The lease's remaining 15 s hold nothing.
    const released = await store.release({ operationId: context.operation.id, expectedRevision: saved.operation.revision });
    expect(released.operation.releasedAt).not.toBeNull();
    expect(released.operation.reservedWei).toBe(context.operation.signed!.maximumExecutionCost);
  });
  it("retains the lane while a dispatch lease is live, then releases and settles after expiry", async () => {
    await initializedSettlementPool(pool, store); let context = await signedSettlementUser(pool, store);
    const observed = syntheticDeploymentObservation(context, await settlementDatabaseNow(pool));
    await store.saveObservation({ operationId: context.operation.id, signedHash: context.operation.signed!.hash, expectedRevision: context.operation.revision, observation: observed });
    context = await store.loadSettlementContext(context.operation.id);
    const legacy = syntheticDeploymentAdmission(context, await settlementDatabaseNow(pool));
    const admission = { ...legacy, version: "center-wallet-deployment-local-admission-v2" as const,
      environment: { kind: "unforked-anvil" as const, genesisHash: context.pool.accounting!.environment.genesisHash, head: legacy.environment.head },
      accounting: { digest: enrollmentDigest(context.pool.accounting), remainingWei: walletDeploymentRemainingWei(context.pool), nextNonce: context.pool.accounting!.nextNonce } };
    const lease = await store.leaseDispatch({ operationId: context.operation.id, expectedRevision: context.operation.revision, signedHash: context.operation.signed!.hash, admission, leaseMs: 400 });
    // The send is out and included; the lane stays claimed by the live lease until it expires.
    const included = canonicalInclusion(context, await settlementDatabaseNow(pool));
    included.head = observed.head; included.wallet.evidence = observed.head; included.transaction.receipt!.block = observed.head!;
    const saved = await store.saveObservation({ operationId: context.operation.id, signedHash: context.operation.signed!.hash, expectedRevision: context.operation.revision, observation: included });
    await expect(store.release({ operationId: context.operation.id, expectedRevision: saved.operation.revision })).rejects.toMatchObject({ code: "WALLET_DEPLOYMENT_BUSY" });
    await new Promise(resolve => setTimeout(resolve, Math.max(1, lease.leaseUntil - Date.now() + 15)));
    const released = await store.release({ operationId: context.operation.id, expectedRevision: saved.operation.revision });
    expect(released.operation.reservedWei).toBe(context.operation.signed!.maximumExecutionCost);
    context = await store.loadSettlementContext(context.operation.id);
    const evidence = syntheticSettlement(context, await settlementDatabaseNow(pool));
    evidence.funding.head = observed.head!; evidence.observation.head = observed.head; evidence.observation.wallet.evidence = observed.head;
    evidence.observation.transaction.receipt!.block = observed.head!; evidence.observation.finality.evidence = observed.head;
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

  it.each(["before-insert", "before-commit", "head-before-commit"])("SQL cannot settle when proof expires %s", async stage => {
    await initializedSettlementPool(pool, store); const context = await releasedSettlementUser(pool, store), now = await settlementDatabaseNow(pool);
    const evidence = syntheticSettlement(context, stage === "before-insert" ? now - 1000 : now); evidence.funding.expiresAt = stage === "before-insert" ? now - 500 : now + 200;
    if (stage === "head-before-commit") {
      evidence.funding.expiresAt = now + 5000;
      Object.assign(evidence.funding.head, { blockNumber: "101", blockHash: `0x${"bc".repeat(32)}`,
        timestamp: String(Math.floor(now / 1000) - 298) });
    }
    const receipt = { version: "center-wallet-deployment-settlement-receipt-v1", id: context.operation.id, poolId: context.pool.configuration.id,
      operationId: context.operation.id, evidenceDigest: enrollmentDigest(evidence), evidence, nonce: "1", priorSequence: 0, sequence: 1,
      spentWei: evidence.fees.totalWei, nextNonce: "2", settledAt: stage === "before-insert" ? now - 800 : now };
    const accounting = { ...context.pool.accounting!, sequence: 1, spentWei: receipt.spentWei,
      lastSettlementId: context.operation.id, lastSettlementAnchor: evidence.observation.finality.evidence };
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await expect((async () => {
        await client.query("INSERT INTO rest_wallet_deployment_settlements(id,pool_id,sequence,evidence_digest,receipt) VALUES($1,$2,1,$3,$4::jsonb)",
          [receipt.id, receipt.poolId, receipt.evidenceDigest, JSON.stringify(receipt)]);
        await client.query("UPDATE rest_wallet_deployments SET settlement_id=id WHERE id=$1", [receipt.id]);
        await client.query("UPDATE rest_wallet_deployment_pools SET accounting=$2::jsonb,revision=revision+1 WHERE id=$1",
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
