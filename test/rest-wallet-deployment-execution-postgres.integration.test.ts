import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashTypedData, type Hex } from "viem";
import { PostgresWalletDeploymentStore, type WalletDeploymentAdmission } from "../src/rest/wallet/deploymentPostgres.js";
import { PostgresWalletEnrollmentStore } from "../src/rest/wallet/enrollmentPostgres.js";
import { createWalletEnrollmentIntent, walletEnrollmentDocument } from "../src/rest/wallet/enrollment.js";
import { prepareWalletDeploymentApproval, walletDeploymentDocument } from "../src/rest/wallet/deployment.js";
import { createRegistration, enrollmentBackupAccount, enrollmentManifest, signBackupProof, signGet } from "./fixtures/wallet-enrollment-crypto.js";
import { deploymentFixtureConfiguration, deploymentFixtureSigner, deploymentFixtureTransaction, syntheticDeploymentAdmission,
  syntheticDeploymentObservation } from "./fixtures/wallet-deployment-execution.js";
import type { WalletDeploymentDispatchJournal, WalletDeploymentExecutionContext } from "../src/rest/wallet/deploymentDispatch.js";

const connectionString = process.env.TEST_DATABASE_URL, suite = connectionString ? describe : describe.skip;
const schema = `rest_wallet_execution_${randomUUID().replaceAll("-", "")}`;
const children: ChildProcess[] = [];
let admin: Pool, pool: Pool, store: PostgresWalletDeploymentStore, enrollments: PostgresWalletEnrollmentStore;
const fromBase64 = (value: string): Hex => `0x${Buffer.from(value, "base64url").toString("hex")}`;
async function now() { return Number((await pool.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now")).rows[0].now); }
async function waitUntil(time: number) { const delay = Math.max(1, time - await now()); await new Promise(resolve => setTimeout(resolve, delay)); }
async function signedContext(): Promise<WalletDeploymentExecutionContext> {
  const config = deploymentFixtureConfiguration(), poolRecord = await store.configurePool(config);
  const initial = await enrollments.begin(createWalletEnrollmentIntent({ manifest: enrollmentManifest,
    rpId: "wallet.juicebox.center", origin: "https://wallet.juicebox.center", recoveryOwner: enrollmentBackupAccount.address,
    expiresAt: await now() + 120000 }));
  const credential = createRegistration({ challenge: fromBase64(initial.intent.registration.challenge), rpId: initial.intent.rpId,
    origin: initial.intent.origin, userHandle: initial.intent.userHandle });
  const pending = await enrollments.acceptRegistration(initial.intent.id, credential.response), document = walletEnrollmentDocument(pending);
  const { record } = await enrollments.finalize(initial.intent.id, { assertion: signGet({ ...credential, challenge: hashTypedData(document),
    rpId: pending.intent.rpId, origin: pending.intent.origin }), backupSignature: await signBackupProof(document) });
  const issuedAt = await now(), approval = prepareWalletDeploymentApproval(record, { issuedAt, expiresAt: issuedAt + 120000 });
  let operation = await store.prepare({ poolId: config.id, approval });
  const admission: WalletDeploymentAdmission = { version: "center-wallet-deployment-admission-v1", chainId: 8453, sender: config.sender,
    blockNumber: "100", blockHash: `0x${"ab".repeat(32)}`, confirmedNonce: "1", pendingNonce: "1", observedAt: await now(),
    enrollmentCommitment: approval.enrollmentCommitment, manifestRevision: record.intent.manifest.revision,
    initializerHash: record.creation!.initializerHash, gas: "1500000", maxFeePerGas: "2000000000", maxPriorityFeePerGas: "1000000" };
  operation = (await store.claim({ operationId: operation.id, admission, assertion: signGet({ ...credential,
    challenge: hashTypedData(walletDeploymentDocument(record, approval)), rpId: record.intent.rpId, origin: record.intent.origin }) })).operation;
  const lease = await store.leaseSigning(operation.id);
  operation = (await store.persistSigned({ operationId: operation.id, leaseToken: lease.leaseToken!, revision: lease.revision,
    rawTransaction: await deploymentFixtureSigner.signTransaction(deploymentFixtureTransaction(operation.template!)) })).operation;
  const context = { enrollment: record, pool: { ...poolRecord, activeOperationId: operation.id, revision: 1 }, operation };
  operation = (await store.saveObservation({ operationId: operation.id, expectedRevision: operation.revision,
    signedHash: operation.signed!.hash, observation: syntheticDeploymentObservation(context, await now()) })).operation;
  return { ...context, operation };
}
async function claim(context: WalletDeploymentExecutionContext, leaseMs = 2000) {
  return { operationId: context.operation.id, signedHash: context.operation.signed!.hash, expectedRevision: context.operation.revision,
    admission: syntheticDeploymentAdmission(context, await now()), leaseMs };
}
function settlement(journal: WalletDeploymentDispatchJournal, status: "accepted" | "unknown" = "unknown") {
  return { operationId: journal.operationId, expectedRevision: journal.revision, leaseToken: journal.leaseToken,
    signedHash: journal.transactionHash, status };
}
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
  const child = fork(fileURLToPath(new URL("./fixtures/wallet-deployment-execution-process.ts", import.meta.url)), [], {
    execArgv: ["--import", "tsx"], env: { ...process.env, WALLET_DEPLOYMENT_EXECUTION_TEST_SCHEMA: schema }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
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
suite("PostgreSQL exact-byte deployment dispatch fencing", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 5 });
    for (const name of ["013_rest_wallet_ceremonies.sql", "015_rest_wallet_enrollment.sql", "041_wallet_passkey_name.sql", "043_wallet_networks.sql", "044_wallet_devices.sql", "016_rest_wallet_deployments.sql", "036_wallet_deployment_approval_v2.sql",
      "018_rest_wallet_deployment_observations.sql", "021_rest_wallet_deployment_dispatch.sql", "026_wallet_deployment_settlement.sql"])
      await pool.query(await readFile(new URL(`../src/db/migrations/${name}`, import.meta.url), "utf8"));
    store = new PostgresWalletDeploymentStore(pool); enrollments = new PostgresWalletEnrollmentStore(pool);
  });
  beforeEach(async () => { await pool.query("TRUNCATE rest_wallet_deployments,rest_wallet_deployment_pools,rest_wallet_credentials,rest_wallet_enrollments,rest_wallet_ceremonies CASCADE"); });
  afterEach(async () => { await Promise.all(children.splice(0).map(kill)); });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } });

  it("loads the durable internal enrollment, pool and signed winner without caller-supplied authority", async () => {
    const context = await signedContext();
    expect(await store.loadExecutionContext(context.operation.id)).toEqual(context);
  });
  it("commits one fenced attempt across two actual competing processes without changing signed or observation revisions", async () => {
    const [a, b] = await Promise.all([worker(), worker()]);
    const context = await signedContext(), input = await claim(context);
    const results = await Promise.all([a.request({ action: "lease-dispatch", input }), b.request({ action: "lease-dispatch", input })]);
    expect(results.map(value => value.status).sort()).toEqual([200, 409]);
    const journal = await store.getDispatch(context.operation.id);
    expect(journal).toMatchObject({ attempts: 1, revision: 1, status: "in-flight", transactionHash: context.operation.signed!.hash });
    expect(await store.get(context.operation.id)).toEqual(context.operation);
  });
  it("settles only the current token and replays exactly without extending any deadline", async () => {
    const context = await signedContext(), journal = await store.leaseDispatch(await claim(context));
    const result = await store.settleDispatch(settlement(journal));
    expect(result.replayed).toBe(false); expect(result.journal).toMatchObject({ revision: 2, status: "unknown", attempts: 1 });
    expect(await store.settleDispatch(settlement(journal))).toEqual({ ...result, replayed: true });
    await expect(store.settleDispatch(settlement(journal, "accepted"))).rejects.toMatchObject({ status: 409 });
  });
  it("replaces only an expired lease after cooldown and rejects the old process's late response", async () => {
    // Start the processes before observing: module loading is not part of a live
    // admission, whose deadline must remain inside the observation freshness bound.
    const [a, b] = await Promise.all([worker(), worker()]);
    const context = await signedContext();
    // This first attempt must commit successfully before testing lease takeover.
    // Use the fixture's normal lease; subsecond expiry is tested separately below.
    const first = await a.request({ action: "lease-dispatch", input: await claim(context) });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const old = first.body as WalletDeploymentDispatchJournal;
    await waitUntil(old.nextAttemptAt + 10);
    // A retry obtains a fresh observation, just as the production coordinator does after cooldown.
    context.operation = (await store.saveObservation({ operationId: context.operation.id, expectedRevision: context.operation.revision,
      signedHash: context.operation.signed!.hash, observation: syntheticDeploymentObservation(context, await now()) })).operation;
    const next = await b.request({ action: "lease-dispatch", input: await claim(context) });
    expect(next.status).toBe(200); expect(next.body).toMatchObject({ attempts: 2, revision: 2 });
    expect((await a.request({ action: "settle-dispatch", input: settlement(old, "accepted") })).status).toBe(409);
    expect(await store.getDispatch(context.operation.id)).toEqual(next.body);
    expect(await store.get(context.operation.id)).toEqual(context.operation);
  }, 15_000);
  it.each(["after-dispatch", "after-commit"])("recovers a process killed at %s without losing signed bytes or allocation", async barrier => {
    const child = await worker(), context = await signedContext(), reached = message(child.child, "barrier");
    const request = child.request({ action: "lease-dispatch", input: await claim(context), barrier }).catch(() => null);
    await reached; await kill(child.child); await request;
    const journal = await store.getDispatch(context.operation.id);
    if (barrier === "after-dispatch") expect(journal).toBeNull();
    else expect(journal).toMatchObject({ attempts: 1, revision: 1, status: "in-flight" });
    expect(await store.loadExecutionContext(context.operation.id)).toEqual(context);
  });
  it("rolls back an attempt whose lease expires behind an actual process post-write barrier", async () => {
    const child = await worker(), context = await signedContext(), reached = message(child.child, "barrier");
    const input = await claim(context, 120), request = child.request({ action: "lease-dispatch", input, barrier: "after-dispatch", continueBarrier: true });
    await reached; await new Promise(resolve => setTimeout(resolve, 180)); child.child.send({ kind: "continue" });
    expect((await request).status).toBe(409); expect(await store.getDispatch(context.operation.id)).toBeNull();
    expect(await store.get(context.operation.id)).toEqual(context.operation);
  });
  it("rejects an admission which expires while waiting for the sender pool lock", async () => {
    const child = await worker(), context = await signedContext(), input = await claim(context);
    input.admission.expiresAt = input.admission.observedAt + 150;
    const locked = await pool.connect(); await locked.query("BEGIN");
    await locked.query("SELECT id FROM rest_wallet_deployment_pools FOR UPDATE");
    const request = child.request({ action: "lease-dispatch", input });
    await new Promise(resolve => setTimeout(resolve, 220)); await locked.query("COMMIT"); locked.release();
    expect((await request).status).toBe(403); expect(await store.getDispatch(context.operation.id)).toBeNull();
  });
  it("keeps the permanent eight-attempt limit across worker recovery", async () => {
    const process = await worker();
    let context = await signedContext();
    for (let i = 1; i <= 8; i++) {
      // This case tests the durable attempt cap, not an unrealistically small success deadline.
      const journal = await store.leaseDispatch(await claim(context, 200));
      expect(journal.attempts).toBe(i);
      await waitUntil(journal.nextAttemptAt + 5);
      context.operation = (await store.saveObservation({ operationId: context.operation.id, expectedRevision: context.operation.revision,
        signedHash: context.operation.signed!.hash, observation: syntheticDeploymentObservation(context, await now()) })).operation;
    }
    expect((await process.request({ action: "lease-dispatch", input: await claim(context) })).status).toBe(409);
    expect((await store.getDispatch(context.operation.id))!.attempts).toBe(8);
    expect((await store.loadExecutionContext(context.operation.id)).pool.activeOperationId).toBe(context.operation.id);
  }, 15000);
  it.each(["revision=0", "revision=revision+1", "attempts=0", "attempts=9", "status='accepted',settled_at=NULL,revision=revision+1",
    "transaction_hash='0x" + "ab".repeat(32) + "'", "admission=jsonb_set(admission,'{environment,genesisHash}','null'::jsonb)",
    "admission=jsonb_set(admission,'{baseTotalAffordability}','\"covered\"'::jsonb)", "lease_until=lease_until+1", "next_attempt_at=0"])
    ("SQL rejects accidental dispatch invariant mutation: %s", async expression => {
      const context = await signedContext(), journal = await store.leaseDispatch(await claim(context));
      await expect(pool.query(`UPDATE rest_wallet_deployment_dispatches SET ${expression} WHERE operation_id=$1`, [context.operation.id])).rejects.toMatchObject({ code: "23514" });
      expect(await store.getDispatch(context.operation.id)).toEqual(journal);
    });
  it("SQL cannot delete dispatch liability", async () => {
    const context = await signedContext(), journal = await store.leaseDispatch(await claim(context));
    await expect(pool.query("DELETE FROM rest_wallet_deployment_dispatches WHERE operation_id=$1", [context.operation.id])).rejects.toMatchObject({ code: "23514" });
    expect(await store.getDispatch(context.operation.id)).toEqual(journal);
  });
  it("rejects a stale observation revision and any paused allocation before reserving an attempt", async () => {
    const context = await signedContext(), stale = await claim(context);
    context.operation = (await store.saveObservation({ operationId: context.operation.id, expectedRevision: context.operation.revision,
      signedHash: context.operation.signed!.hash, observation: syntheticDeploymentObservation(context, await now()) })).operation;
    await expect(store.leaseDispatch(stale)).rejects.toMatchObject({ status: 409 });
    await pool.query("UPDATE rest_wallet_deployment_pools SET state='paused',revision=revision+1");
    await expect(store.leaseDispatch(await claim(context))).rejects.toMatchObject({ status: 403 });
    expect(await store.getDispatch(context.operation.id)).toBeNull();
  });
  it("store and SQL reject dispatch from a head below retained observation history", async () => {
    const context = await signedContext(), higher = syntheticDeploymentObservation(context, await now());
    higher.head!.blockNumber = "102"; higher.wallet.evidence!.blockNumber = "102";
    context.operation = (await store.saveObservation({ operationId: context.operation.id, expectedRevision: context.operation.revision,
      signedHash: context.operation.signed!.hash, observation: higher })).operation;
    context.operation = (await store.saveObservation({ operationId: context.operation.id, expectedRevision: context.operation.revision,
      signedHash: context.operation.signed!.hash, observation: syntheticDeploymentObservation(context, await now()) })).operation;
    const input = await claim(context);
    await expect(store.leaseDispatch(input)).rejects.toMatchObject({ status: 403 });
    const claimedAt = await now(), until = claimedAt + 500;
    await expect(pool.query(`INSERT INTO rest_wallet_deployment_dispatches
      (operation_id,transaction_hash,template_commitment,revision,attempts,status,lease_token,lease_until,admission,admission_digest,claimed_at,next_attempt_at)
      VALUES($1,$2,$3,1,1,'in-flight',$4,$5,$6::jsonb,$7,$8,$9)`, [context.operation.id, input.signedHash, context.operation.templateCommitment,
      randomUUID(), until, JSON.stringify(input.admission), "a".repeat(64), claimedAt, until + 1000])).rejects.toMatchObject({ code: "23514" });
    expect(await store.getDispatch(context.operation.id)).toBeNull();
  });
});
