import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashTypedData, keccak256, serializeTransaction, toHex, type Hex, type TransactionSerializableEIP1559 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { secp256k1 } from "@noble/curves/secp256k1";
import { createWalletEnrollmentIntent, enrollmentDigest, walletEnrollmentDocument } from "../src/rest/wallet/enrollment.js";
import { PostgresWalletEnrollmentStore } from "../src/rest/wallet/enrollmentPostgres.js";
import { prepareWalletDeploymentApproval, prepareWalletDeploymentTemplate, verifyWalletDeploymentProof,
  walletDeploymentDocument } from "../src/rest/wallet/deployment.js";
import { PostgresWalletDeploymentStore, type WalletDeploymentAdmission, type WalletDeploymentOperation,
  type WalletDeploymentPoolConfiguration } from "../src/rest/wallet/deploymentPostgres.js";
import type { WalletAssertion } from "../src/rest/wallet/webauthn.js";
import type { RelayPolicy } from "../src/rest/transactions/types.js";
import { createRegistration, enrollmentBackupAccount, enrollmentManifest, signBackupProof, signGet } from "./fixtures/wallet-enrollment-crypto.js";

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const schema = `rest_wallet_deployment_${randomUUID().replaceAll("-", "")}`;
// Public deterministic fixture key only. No signer capability is installed in the store or child service.
const relay = privateKeyToAccount(`0x${"22".repeat(32)}`);
const children: ChildProcess[] = [];
let admin: Pool, pool: Pool, store: PostgresWalletDeploymentStore, enrollments: PostgresWalletEnrollmentStore;

function configuration(): WalletDeploymentPoolConfiguration {
  return { id: randomUUID(), chainId: 8453, sender: relay.address.toLowerCase() as Hex,
    allocationWei: "100000000000000000", globalAllocationLimitWei: "1000000000000000000",
    policy: { maximumRawBytes: 32768, maximumGas: "2000000", maximumFeePerGas: "10000000000",
      maximumTransactionCost: "20000000000000000", maximumObservationAgeMs: 5000 } };
}
function policyFor(config: WalletDeploymentPoolConfiguration): RelayPolicy {
  return { planTtlMs: 300000, maximumPlanTtlMs: 300000, leaseMs: 15000, rpcTimeoutMs: 1000, confirmations: 1,
    allowedChainIds: [8453], maximumRawBytes: config.policy.maximumRawBytes, maximumGas: BigInt(config.policy.maximumGas),
    maximumFeePerGas: BigInt(config.policy.maximumFeePerGas), maximumTransactionCost: BigInt(config.policy.maximumTransactionCost) };
}
const fromBase64 = (value: string): Hex => `0x${Buffer.from(value, "base64url").toString("hex")}`;
const assertionWire = (assertion: WalletAssertion) => ({ ...assertion,
  authenticatorData: Buffer.from(assertion.authenticatorData).toString("base64url"),
  clientDataJSON: Buffer.from(assertion.clientDataJSON).toString("base64url"), signature: Buffer.from(assertion.signature).toString("base64url") });
async function databaseNow(): Promise<number> {
  return Number((await pool.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now")).rows[0].now);
}
async function verifiedEnrollment() {
  const initial = await enrollments.begin(createWalletEnrollmentIntent({ manifest: enrollmentManifest,
    rpId: "wallet.juicebox.center", origin: "https://wallet.juicebox.center", recoveryOwner: enrollmentBackupAccount.address,
    expiresAt: await databaseNow() + 120000 }));
  const credential = createRegistration({ challenge: fromBase64(initial.intent.registration.challenge),
    rpId: initial.intent.rpId, origin: initial.intent.origin, userHandle: initial.intent.userHandle });
  const pending = await enrollments.acceptRegistration(initial.intent.id, credential.response);
  const document = walletEnrollmentDocument(pending);
  const proof = signGet({ ...credential, challenge: hashTypedData(document), rpId: pending.intent.rpId, origin: pending.intent.origin });
  const { record } = await enrollments.finalize(pending.intent.id, { assertion: proof, backupSignature: await signBackupProof(document) });
  return { record, credential };
}
async function prepared(config = configuration(), lifetimeMs = 120000) {
  await store.configurePool(config);
  const { record, credential } = await verifiedEnrollment(), issuedAt = await databaseNow();
  const approval = prepareWalletDeploymentApproval(record, { issuedAt, expiresAt: issuedAt + lifetimeMs });
  const operation = await store.prepare({ poolId: config.id, approval });
  const assertion = signGet({ ...credential, challenge: hashTypedData(walletDeploymentDocument(record, approval)),
    rpId: record.intent.rpId, origin: record.intent.origin });
  const admission: WalletDeploymentAdmission = { version: "center-wallet-deployment-admission-v1", chainId: 8453,
    sender: config.sender, blockNumber: "100", blockHash: `0x${"01".repeat(32)}`, confirmedNonce: "1", pendingNonce: "1",
    observedAt: await databaseNow(), enrollmentCommitment: approval.enrollmentCommitment,
    manifestRevision: record.intent.manifest.revision, initializerHash: record.creation!.initializerHash,
    gas: "1500000", maxFeePerGas: "2000000000", maxPriorityFeePerGas: "1000000" };
  return { config, record, credential, approval, operation, input: { operationId: operation.id, assertion, admission } };
}
function signableTransaction(operation: WalletDeploymentOperation, changes: Partial<TransactionSerializableEIP1559> = {}): TransactionSerializableEIP1559 {
  const tx = operation.template!.transaction;
  return { type: "eip1559", chainId: tx.chainId, to: tx.to, data: tx.data,
    value: BigInt(tx.value), nonce: Number(tx.nonce), gas: BigInt(tx.gas), maxFeePerGas: BigInt(tx.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas), accessList: [], ...changes };
}
function signedTransaction(operation: WalletDeploymentOperation, changes: Partial<TransactionSerializableEIP1559> = {}) {
  return relay.signTransaction(signableTransaction(operation, changes));
}
async function counts() {
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM rest_wallet_deployment_pools) AS pools,
    (SELECT count(*)::int FROM rest_wallet_deployments WHERE state<>'prepared') AS assigned,
    (SELECT count(*)::int FROM rest_wallet_ceremonies WHERE purpose='deploy' AND consumed_at IS NOT NULL) AS consumed,
    (SELECT count(*)::int FROM rest_wallet_deployment_pools WHERE active_operation_id IS NOT NULL) AS lanes`)).rows[0];
}
function message(child: ChildProcess, kind: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error(`Deployment child did not emit ${kind}`)), 10000);
    const received = (value: any) => { if (value?.kind === kind) done(undefined, value); };
    const exited = () => done(new Error(`Deployment child exited before ${kind}`));
    function done(error?: Error, value?: unknown) {
      clearTimeout(timer); child.off("message", received); child.off("exit", exited);
      if (error) reject(error); else resolve(value);
    }
    child.on("message", received); child.on("exit", exited);
  });
}
async function worker() {
  const child = fork(fileURLToPath(new URL("./fixtures/wallet-deployment-process.ts", import.meta.url)), [], {
    execArgv: ["--import", "tsx"], env: { ...process.env, WALLET_DEPLOYMENT_TEST_SCHEMA: schema },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  children.push(child);
  const ready = await message(child, "ready");
  return { child, request: async (body: unknown): Promise<{ status: number; body: any }> => {
    const response = await fetch(`http://127.0.0.1:${ready.port}`, { method: "POST", body: JSON.stringify(body),
      headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15000) });
    return { status: response.status, body: await response.json() };
  } };
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGKILL"); await exited;
}
const claimWire = (value: Awaited<ReturnType<typeof prepared>>) => ({ action: "claim", input: { ...value.input, assertion: assertionWire(value.input.assertion) } });

suite("PostgreSQL permanent wallet deployment admission without signing or dispatch capabilities", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 4 });
    for (const name of ["013_rest_wallet_ceremonies.sql", "015_rest_wallet_enrollment.sql", "016_rest_wallet_deployments.sql"])
      await pool.query(await readFile(new URL(`../src/db/migrations/${name}`, import.meta.url), "utf8"));
    store = new PostgresWalletDeploymentStore(pool); enrollments = new PostgresWalletEnrollmentStore(pool);
  });
  beforeEach(async () => { await pool.query("TRUNCATE rest_wallet_deployments,rest_wallet_deployment_pools,rest_wallet_credentials,rest_wallet_enrollments,rest_wallet_ceremonies"); });
  afterEach(async () => { await Promise.all(children.splice(0).map(kill)); });
  afterAll(async () => {
    await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  it("installs one immutable whole allocation and returns it unchanged on retry", async () => {
    const config = configuration(), original = await store.configurePool(config);
    expect(original.configuration).toEqual(config);
    expect(original.activeOperationId).toBeNull(); expect(original.state).toBe("active");
    expect(await store.configurePool(config)).toEqual(original);
    for (const replacement of [{ ...config, id: randomUUID() }, { ...config, allocationWei: "200000000000000000" },
      { ...config, sender: enrollmentBackupAccount.address }, { ...config, policy: { ...config.policy, maximumGas: "1900000" } }])
      await expect(store.configurePool(replacement)).rejects.toMatchObject({ status: 409 });
    expect(await counts()).toEqual({ pools: 1, assigned: 0, consumed: 0, lanes: 0 });
  });

  it("claims a real W3 enrollment with P256 approval and freezes one nonce and template", async () => {
    const value = await prepared();
    const result = await store.claim(value.input);
    expect(result.replayed).toBe(false);
    expect(result.operation).toMatchObject({ id: value.approval.id, state: "claimed", enrollmentId: value.record.intent.id,
      template: { predictedSafe: value.record.creation!.address, transaction: { nonce: "1", value: "0", accessList: [] } }, signed: null });
    expect(await counts()).toEqual({ pools: 1, assigned: 1, consumed: 1, lanes: 1 });
    expect(await store.get(result.operation.id)).toEqual(result.operation);
    const replay = await store.claim({ ...value.input, admission: { ...value.input.admission, gas: "1600000", maxFeePerGas: "2100000000" } });
    expect(replay).toEqual({ operation: result.operation, replayed: true });
    expect((await pool.query("SELECT allocation_wei::text FROM rest_wallet_deployment_pools")).rows[0].allocation_wei).toBe(value.config.allocationWei);
  });

  it("arbitrates identical singleton configuration across two actual processes", async () => {
    const config = configuration(), [a, b] = await Promise.all([worker(), worker()]);
    const results = await Promise.all([a.request({ action: "configure", configuration: config }), b.request({ action: "configure", configuration: config })]);
    expect(results.map(result => result.status)).toEqual([200, 200]); expect(results[0].body).toEqual(results[1].body);
    expect((await b.request({ action: "configure", configuration: { ...config, id: randomUUID() } })).status).toBe(409);
    expect(await counts()).toEqual({ pools: 1, assigned: 0, consumed: 0, lanes: 0 });
  });

  it.each([
    { allocationWei: "0" }, { allocationWei: "1000000000000000001" }, { allocationWei: "01" },
    { sender: "0x0000000000000000000000000000000000000000" }, { chainId: 1 },
  ])("rejects invalid whole-allocation configuration without creating a pool %#", async changes => {
    await expect(store.configurePool({ ...configuration(), ...changes } as WalletDeploymentPoolConfiguration)).rejects.toThrow();
    expect(await counts()).toEqual({ pools: 0, assigned: 0, consumed: 0, lanes: 0 });
  });

  it("prepares only from a durable verified enrollment and returns the original preparation", async () => {
    const value = await prepared();
    expect(await store.prepare({ poolId: value.config.id, approval: value.approval })).toEqual(value.operation);
    await expect(store.prepare({ poolId: value.config.id, approval: { ...value.approval, enrollmentId: randomUUID() } })).rejects.toThrow();
    expect(await counts()).toEqual({ pools: 1, assigned: 0, consumed: 0, lanes: 0 });
    expect((await pool.query("SELECT count(*)::int AS count FROM rest_wallet_ceremonies WHERE purpose='deploy'")).rows[0].count).toBe(1);
  });

  it("rejects a genuine assertion for another approval without consuming either ceremony", async () => {
    const value = await prepared(), issuedAt = await databaseNow();
    const other = prepareWalletDeploymentApproval(value.record, { issuedAt, expiresAt: issuedAt + 120000 });
    await store.prepare({ poolId: value.config.id, approval: other });
    await expect(store.claim({ ...value.input, operationId: other.id })).rejects.toThrow();
    expect(await counts()).toEqual({ pools: 1, assigned: 0, consumed: 0, lanes: 0 });
  });

  it.each([
    { pendingNonce: "2" }, { confirmedNonce: "01", pendingNonce: "01" }, { confirmedNonce: "9007199254740992", pendingNonce: "9007199254740992" },
    { blockHash: `0x${"11".repeat(31)}` }, { chainId: 1 }, { sender: enrollmentBackupAccount.address },
    { enrollmentCommitment: `0x${"ab".repeat(32)}` }, { manifestRevision: `0x${"ab".repeat(32)}` },
    { initializerHash: `0x${"ab".repeat(32)}` }, { gas: "2000001" }, { maxPriorityFeePerGas: "0" },
    { observedAt: 1 }, { observedAt: Number.MAX_SAFE_INTEGER }, { providerUrl: "https://untrusted.invalid" },
  ])("rejects malformed, mismatched or stale internal admission before mutation %#", async changes => {
    const value = await prepared();
    await expect(store.claim({ ...value.input, admission: { ...value.input.admission, ...changes } as WalletDeploymentAdmission })).rejects.toThrow();
    expect(await counts()).toEqual({ pools: 1, assigned: 0, consumed: 0, lanes: 0 });
    expect((await store.get(value.operation.id))?.state).toBe("prepared");
  });

  it("converges competing quotes to one claimed template across two one-connection processes", async () => {
    const value = await prepared(), [a, b] = await Promise.all([worker(), worker()]), request = claimWire(value);
    const alternate = { ...request, input: { ...request.input, admission: { ...request.input.admission, gas: "1600000", maxFeePerGas: "2100000000" } } };
    const results = await Promise.all([a.request(request), b.request(alternate)]);
    expect(results.map(result => result.status)).toEqual([200, 200]);
    expect(results.filter(result => result.body.replayed === false)).toHaveLength(1);
    expect(results[0].body.operation).toEqual(results[1].body.operation);
    expect(await counts()).toEqual({ pools: 1, assigned: 1, consumed: 1, lanes: 1 });
  });

  it("keeps the losing enrollment's approval unconsumed when two processes compete for the only lane", async () => {
    const config = configuration(), first = await prepared(config), second = await prepared(config);
    const [a, b] = await Promise.all([worker(), worker()]);
    const results = await Promise.all([a.request(claimWire(first)), b.request(claimWire(second))]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    const loser = results[0].status === 409 ? first : second;
    expect((await store.get(loser.operation.id))?.state).toBe("prepared");
    expect((await pool.query("SELECT consumed_at FROM rest_wallet_ceremonies WHERE id=$1", [loser.approval.id])).rows[0].consumed_at).toBeNull();
    expect(await counts()).toEqual({ pools: 1, assigned: 1, consumed: 1, lanes: 1 });
  });

  it("rejects a second fresh approval for an unresolved enrollment without changing its nonce", async () => {
    const value = await prepared(), claimed = await store.claim(value.input), issuedAt = await databaseNow();
    const approval = prepareWalletDeploymentApproval(value.record, { issuedAt, expiresAt: issuedAt + 120000 });
    await store.prepare({ poolId: value.config.id, approval });
    const assertion = signGet({ ...value.credential, challenge: hashTypedData(walletDeploymentDocument(value.record, approval)),
      rpId: value.record.intent.rpId, origin: value.record.intent.origin });
    await expect(store.claim({ operationId: approval.id, assertion, admission: { ...value.input.admission,
      confirmedNonce: "2", pendingNonce: "2", observedAt: await databaseNow() } })).rejects.toMatchObject({ status: 409 });
    expect(await store.get(value.operation.id)).toEqual(claimed.operation);
    expect(await counts()).toEqual({ pools: 1, assigned: 1, consumed: 1, lanes: 1 });
  });

  it("rolls back fresh admission when its pool lock waits beyond the approval deadline", async () => {
    const value = await prepared(configuration(), 1200), blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM rest_wallet_deployment_pools WHERE id=$1 FOR UPDATE", [value.config.id]);
      const pending = store.claim(value.input).then(result => ({ result }), error => ({ error }));
      await blocker.query("SELECT pg_sleep(GREATEST(0,($1-extract(epoch FROM clock_timestamp())*1000)/1000)+0.05)", [value.approval.expiresAt]);
      await blocker.query("COMMIT");
      expect(await pending).toHaveProperty("error");
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
    expect(await counts()).toEqual({ pools: 1, assigned: 0, consumed: 0, lanes: 0 });
    expect((await store.get(value.operation.id))?.template).toBeNull();
  });

  it("rolls back nonce, template and consumed approval when post-write work crosses the DB deadline", async () => {
    const value = await prepared(configuration(), 3000), child = await worker(), barrier = message(child.child, "barrier");
    const pending = child.request({ ...claimWire(value), barrier: "after-operation", continueBarrier: true });
    await barrier;
    await pool.query("SELECT pg_sleep(GREATEST(0,($1-extract(epoch FROM clock_timestamp())*1000)/1000)+0.05)", [value.approval.expiresAt]);
    child.child.send({ kind: "continue" });
    expect((await pending).status).toBe(410);
    expect(await counts()).toEqual({ pools: 1, assigned: 0, consumed: 0, lanes: 0 });
    expect((await store.get(value.operation.id))?.template).toBeNull();
  });

  it("rolls back admission after a proven global nonce uniqueness wait crosses expiry", async () => {
    const config = configuration(), collision = await prepared(config), target = await prepared(config, 5000);
    const blockAdmission = collision.input.admission, claimedAt = await databaseNow();
    const template = prepareWalletDeploymentTemplate(collision.record, collision.approval, {
      sender: config.sender, nonce: blockAdmission.confirmedNonce, gas: blockAdmission.gas,
      maxFeePerGas: blockAdmission.maxFeePerGas, maxPriorityFeePerGas: blockAdmission.maxPriorityFeePerGas,
    }, policyFor(config));
    const proof = verifyWalletDeploymentProof(collision.record, collision.approval, collision.input.assertion, claimedAt);
    const blocker = await pool.connect(), applicationName = `deployment_nonce_expiry_${randomUUID()}`;
    const waitingPool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 1, application_name: applicationName });
    try {
      await blocker.query("BEGIN");
      // The uncommitted row occupies the unique sender nonce, without acquiring the pool lane.
      // Its deferred lane constraint is never committed: rollback releases only this test collision.
      await blocker.query(`UPDATE rest_wallet_deployments SET state='claimed',claimed_at=$2,proof_digest=$3,
        admission=$4::jsonb,chain_id=8453,sender=$5,nonce=$6,template=$7::jsonb,template_commitment=$8 WHERE id=$1`,
        [collision.operation.id, claimedAt, proof.verificationDigest, JSON.stringify(blockAdmission), config.sender,
          blockAdmission.confirmedNonce, JSON.stringify(template), `0x${enrollmentDigest(template)}`]);
      const completion = new PostgresWalletDeploymentStore(waitingPool).claim(target.input)
        .then(result => ({ result }), error => ({ error }));
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        waiting = (await pool.query(`SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'
          AND query LIKE '%UPDATE rest_wallet_deployments SET state=%' AND $2=ANY(pg_blocking_pids(pid))`,
          [applicationName, (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid])).rowCount === 1;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await blocker.query("SELECT pg_sleep(GREATEST(0,($1-extract(epoch FROM clock_timestamp())*1000)/1000)+0.05)", [target.approval.expiresAt]);
      await blocker.query("ROLLBACK");
      expect(await completion).toMatchObject({ error: { status: 410 } });
      expect(await counts()).toEqual({ pools: 1, assigned: 0, consumed: 0, lanes: 0 });
      expect((await store.get(target.operation.id))?.template).toBeNull();
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await waitingPool.end(); }
  }, 15000);

  it("rechecks the verified current credential mapping before consuming deployment authority", async () => {
    const value = await prepared();
    await pool.query("UPDATE rest_wallet_credentials SET superseded_at=verified_at+1 WHERE enrollment_id=$1", [value.record.intent.id]);
    await expect(store.claim(value.input)).rejects.toThrow();
    expect(await counts()).toEqual({ pools: 1, assigned: 0, consumed: 0, lanes: 0 });
  });

  it("takes bounded proof and admission snapshots before caller buffers can change", async () => {
    const value = await prepared(), expectedAdmission = structuredClone(value.input.admission);
    const pending = store.claim(value.input);
    value.input.assertion.signature.fill(0); value.input.admission.gas = "1999999";
    expect((await pending).operation.admission).toEqual(expectedAdmission);
    expect(await counts()).toEqual({ pools: 1, assigned: 1, consumed: 1, lanes: 1 });
  });

  it("keeps a paused allocation from admitting a new deployment", async () => {
    const value = await prepared();
    await pool.query("UPDATE rest_wallet_deployment_pools SET state='paused'");
    await expect(store.claim(value.input)).rejects.toThrow();
    expect(await counts()).toEqual({ pools: 1, assigned: 0, consumed: 0, lanes: 0 });
  });

  it.each(["after-consume", "after-operation", "after-lane", "after-commit"])("recovers admission at the %s real process crash barrier", async barrierName => {
    const value = await prepared(), [a, b] = await Promise.all([worker(), worker()]), request = claimWire(value);
    const barrier = message(a.child, "barrier"), lost = a.request({ ...request, barrier: barrierName }).catch(() => null);
    await barrier; await kill(a.child); await lost;
    expect(await counts()).toEqual(barrierName === "after-commit"
      ? { pools: 1, assigned: 1, consumed: 1, lanes: 1 } : { pools: 1, assigned: 0, consumed: 0, lanes: 0 });
    const recovered = await b.request(request);
    expect(recovered.status).toBe(200); expect(recovered.body.replayed).toBe(barrierName === "after-commit");
    expect(recovered.body.operation.id).toBe(value.operation.id);
    expect(await counts()).toEqual({ pools: 1, assigned: 1, consumed: 1, lanes: 1 });
  });

  it("recovers the permanent claim after approval expiry and ceremony receipt cleanup", async () => {
    const value = await prepared(configuration(), 1000), claimed = await store.claim(value.input);
    await pool.query("DELETE FROM rest_wallet_ceremonies WHERE id=$1", [value.approval.id]);
    await pool.query("SELECT pg_sleep(GREATEST(0,($1-extract(epoch FROM clock_timestamp())*1000)/1000)+0.05)", [value.approval.expiresAt]);
    expect(await store.claim(value.input)).toEqual({ operation: claimed.operation, replayed: true });
    expect(await store.cleanup(100)).toBe(0);
    expect(await store.get(value.operation.id)).toEqual(claimed.operation);
    expect(await counts()).toEqual({ pools: 1, assigned: 1, consumed: 0, lanes: 1 });
  });

  it("rejects pool reset, nonce repricing and inconsistent lane release at the database boundary", async () => {
    const value = await prepared(), claimed = await store.claim(value.input);
    for (const sql of ["UPDATE rest_wallet_deployment_pools SET allocation_wei=allocation_wei+1",
      "DELETE FROM rest_wallet_deployment_pools", "UPDATE rest_wallet_deployments SET nonce=nonce+1",
      "UPDATE rest_wallet_deployments SET template=template-'sender'", "DELETE FROM rest_wallet_deployments",
      "UPDATE rest_wallet_deployment_pools SET active_operation_id=NULL"])
      await expect(pool.query(sql)).rejects.toMatchObject({ code: "23514" });
    expect(await store.get(value.operation.id)).toEqual(claimed.operation);
    expect(await counts()).toEqual({ pools: 1, assigned: 1, consumed: 1, lanes: 1 });
  });

  it("rejects an orphan prepared operation instead of trusting a supplied enrollment identifier", async () => {
    const value = await prepared(), id = randomUUID();
    const approval = { ...value.approval, id, enrollmentId: randomUUID(), ceremony: { ...value.approval.ceremony, id } };
    await expect(pool.query(`INSERT INTO rest_wallet_deployments
      (id,pool_id,enrollment_id,pool_configuration_digest,approval,created_at,expires_at,retain_until)
      SELECT $1,pool_id,$2,pool_configuration_digest,$3::jsonb,created_at,expires_at,retain_until FROM rest_wallet_deployments WHERE id=$4`,
      [id, approval.enrollmentId, JSON.stringify(approval), value.operation.id])).rejects.toMatchObject({ code: "23503" });
    expect((await pool.query("SELECT count(*)::int AS count FROM rest_wallet_deployments")).rows[0].count).toBe(1);
  });

  it("rejects missing required approval identity on INSERT rather than passing a SQL NULL check", async () => {
    const value = await prepared();
    for (const missingField of ["id", "enrollmentId", "ceremony-purpose"] as const) {
      const id = randomUUID(), malformed: any = { ...value.approval, id, ceremony: { ...value.approval.ceremony, id } };
      if (missingField === "ceremony-purpose") delete malformed.ceremony.purpose;
      else delete malformed[missingField];
      await expect(pool.query(`INSERT INTO rest_wallet_deployments
        (id,pool_id,enrollment_id,pool_configuration_digest,approval,created_at,expires_at,retain_until)
        SELECT $1,pool_id,enrollment_id,pool_configuration_digest,$2::jsonb,created_at,expires_at,retain_until
        FROM rest_wallet_deployments WHERE id=$3`, [id, JSON.stringify(malformed), value.operation.id])).rejects.toMatchObject({ code: "23514" });
    }
    expect((await pool.query("SELECT count(*)::int AS count FROM rest_wallet_deployments")).rows[0].count).toBe(1);
    expect(await counts()).toEqual({ pools: 1, assigned: 0, consumed: 0, lanes: 0 });
  });

  it("rejects SQL insertion of a claimed operation and a prepared-to-signed transition before deferred checks", async () => {
    const config = configuration(), source = await prepared(config), target = await prepared(config);
    await store.claim(source.input);
    const now = await databaseNow(), insertApproval = prepareWalletDeploymentApproval(target.record, { issuedAt: now, expiresAt: now + 120000 });
    const admission = { ...target.input.admission, confirmedNonce: "2", pendingNonce: "2", observedAt: now };
    const draft = (approval: typeof insertApproval) => {
      const template = prepareWalletDeploymentTemplate(target.record, approval, { sender: config.sender, nonce: "2",
        gas: admission.gas, maxFeePerGas: admission.maxFeePerGas, maxPriorityFeePerGas: admission.maxPriorityFeePerGas }, policyFor(config));
      const assertion = signGet({ ...target.credential, challenge: hashTypedData(walletDeploymentDocument(target.record, approval)),
        rpId: target.record.intent.rpId, origin: target.record.intent.origin });
      const proof = verifyWalletDeploymentProof(target.record, approval, assertion, now);
      return { template, row: { id: approval.id, enrollment_id: target.record.intent.id, approval, created_at: now,
        expires_at: approval.expiresAt, retain_until: approval.expiresAt + 86400000, state: "claimed", claimed_at: now,
        proof_digest: proof.verificationDigest, admission, chain_id: 8453, sender: config.sender, nonce: "2",
        template, template_commitment: `0x${enrollmentDigest(template)}` } };
    };
    const insert = draft(insertApproval), client = await pool.connect();
    try {
      await client.query("BEGIN");
      try {
        // Different enrollment and nonce avoid existing UNIQUE constraints. Never COMMIT the
        // intentionally missing lane: the transition must fail immediately, before deferred checks.
        await expect(client.query(`INSERT INTO rest_wallet_deployments
          SELECT (jsonb_populate_record(NULL::rest_wallet_deployments,to_jsonb(d)||$1::jsonb)).*
          FROM rest_wallet_deployments d WHERE id=$2`, [JSON.stringify(insert.row), source.operation.id]))
          .rejects.toMatchObject({ code: "23514" });
      } finally { await client.query("ROLLBACK"); }
      const skipped = draft(target.approval), rawTransaction = await signedTransaction({ ...target.operation, template: skipped.template });
      const signed = { ...skipped.row, state: "signed", raw_transaction: rawTransaction, transaction_hash: keccak256(rawTransaction),
        maximum_execution_cost: (BigInt(admission.gas) * BigInt(admission.maxFeePerGas)).toString() };
      await client.query("BEGIN");
      try {
        await expect(client.query(`UPDATE rest_wallet_deployments SET
          (state,claimed_at,proof_digest,admission,chain_id,sender,nonce,template,template_commitment,raw_transaction,transaction_hash,maximum_execution_cost)=
          (SELECT state,claimed_at,proof_digest,admission,chain_id,sender,nonce,template,template_commitment,raw_transaction,transaction_hash,maximum_execution_cost
           FROM jsonb_populate_record(NULL::rest_wallet_deployments,$1::jsonb)) WHERE id=$2`, [JSON.stringify(signed), target.operation.id]))
          .rejects.toMatchObject({ code: "23514" });
      } finally { await client.query("ROLLBACK"); }
    } finally { client.release(); }
    expect((await store.get(target.operation.id))?.state).toBe("prepared");
    expect(await counts()).toEqual({ pools: 1, assigned: 1, consumed: 1, lanes: 1 });
  });

  it("cleans only a bounded expired prepared set while preserving an assigned nonce", async () => {
    const value = await prepared(), claimed = await store.claim(value.input), now = await databaseNow();
    // Initially expired, never-claimed test rows. Their timestamps are not mutated through an immutable production record.
    for (let index = 0; index < 3; index++) {
      const id = randomUUID(), expiresAt = now - 86400001;
      const approval = { ...value.approval, id, issuedAt: expiresAt - 1000, expiresAt,
        ceremony: { ...value.approval.ceremony, id, expiresAt } };
      await pool.query(`INSERT INTO rest_wallet_deployments
        (id,pool_id,enrollment_id,pool_configuration_digest,approval,created_at,expires_at,retain_until)
        SELECT $1,pool_id,enrollment_id,pool_configuration_digest,$2::jsonb,$3,$4,$5 FROM rest_wallet_deployments WHERE id=$6`,
        [id, JSON.stringify(approval), expiresAt - 1000, expiresAt, expiresAt + 86400000, value.operation.id]);
    }
    expect(await store.cleanup(2)).toBe(2); expect(await store.cleanup(2)).toBe(1); expect(await store.cleanup(2)).toBe(0);
    expect(await store.get(value.operation.id)).toEqual(claimed.operation);
    expect(await counts()).toEqual({ pools: 1, assigned: 1, consumed: 1, lanes: 1 });
  });

  it("persists exact public-test-signed bytes and never changes the first winner", async () => {
    const value = await prepared(), claimed = await store.claim(value.input), lease = await store.leaseSigning(value.operation.id, 15000);
    const rawTransaction = await signedTransaction(claimed.operation);
    expect(lease.leaseToken).toBeTruthy();
    const input = { operationId: value.operation.id, leaseToken: lease.leaseToken!, revision: lease.revision, rawTransaction };
    const result = await store.persistSigned(input);
    expect(result.replayed).toBe(false); expect(result.operation.state).toBe("signed");
    expect(result.operation.signed).toMatchObject({ rawTransaction, hash: keccak256(rawTransaction) });
    expect(result.operation.signingLease).toBeNull();
    expect(await store.persistSigned(input)).toEqual({ operation: result.operation, replayed: true });
    expect(await store.get(value.operation.id)).toEqual(result.operation);
    expect(await counts()).toEqual({ pools: 1, assigned: 1, consumed: 1, lanes: 1 });
  });

  it.each([{ nonce: 2 }, { gas: 1500001n }, { maxFeePerGas: 2000000001n }, { maxPriorityFeePerGas: 1000001n },
    { data: "0x1234" as Hex }, { accessList: [{ address: relay.address, storageKeys: [] }] }])(
    "rejects correctly signed changed transaction fields before persistence %#", async changes => {
      const value = await prepared(), claimed = await store.claim(value.input), lease = await store.leaseSigning(value.operation.id, 15000);
      await expect(store.persistSigned({ operationId: value.operation.id, leaseToken: lease.leaseToken!, revision: lease.revision,
        rawTransaction: await signedTransaction(claimed.operation, changes) })).rejects.toThrow();
      expect((await store.get(value.operation.id))?.signed).toBeNull();
      expect(await counts()).toEqual({ pools: 1, assigned: 1, consumed: 1, lanes: 1 });
    });

  it("rejects an expired signing worker after a replacement lease wins", async () => {
    const value = await prepared(), claimed = await store.claim(value.input), old = await store.leaseSigning(value.operation.id, 100);
    const rawTransaction = await signedTransaction(claimed.operation);
    await pool.query("SELECT pg_sleep(GREATEST(0,($1-extract(epoch FROM clock_timestamp())*1000)/1000)+0.02)", [old.leaseUntil]);
    const current = await store.leaseSigning(value.operation.id, 15000);
    expect(current.leaseToken).not.toBe(old.leaseToken); expect(current.leaseToken).toBeTruthy();
    await expect(store.persistSigned({ operationId: value.operation.id, leaseToken: old.leaseToken!, revision: old.revision, rawTransaction })).rejects.toMatchObject({ status: 409 });
    expect((await store.get(value.operation.id))?.signed).toBeNull();
    expect((await store.persistSigned({ operationId: value.operation.id, leaseToken: current.leaseToken!, revision: current.revision, rawTransaction })).operation.state).toBe("signed");
  });

  it("grants only one live signing lease across two actual processes", async () => {
    const value = await prepared(); await store.claim(value.input);
    const [a, b] = await Promise.all([worker(), worker()]);
    const request = { action: "lease", operationId: value.operation.id, leaseDurationMs: 15000 };
    const results = await Promise.all([a.request(request), b.request(request)]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    const admitted = results.find(result => result.status === 200)!.body;
    expect(admitted.leaseToken).toBeTruthy(); expect(admitted.leaseUntil).toBeGreaterThan(await databaseNow());
    expect((await store.get(value.operation.id))?.signingLease?.token).toBe(admitted.leaseToken);
    expect(await counts()).toEqual({ pools: 1, assigned: 1, consumed: 1, lanes: 1 });
  });

  it("rolls back signed bytes when post-write work crosses the signing lease deadline", async () => {
    const value = await prepared(), claimed = await store.claim(value.input), lease = await store.leaseSigning(value.operation.id, 3000);
    const rawTransaction = await signedTransaction(claimed.operation), child = await worker(), barrier = message(child.child, "barrier");
    const pending = child.request({ action: "persist", input: { operationId: value.operation.id,
      leaseToken: lease.leaseToken!, revision: lease.revision, rawTransaction }, barrier: "after-signed", continueBarrier: true });
    await barrier;
    await pool.query("SELECT pg_sleep(GREATEST(0,($1-extract(epoch FROM clock_timestamp())*1000)/1000)+0.05)", [lease.leaseUntil]);
    child.child.send({ kind: "continue" });
    expect((await pending).status).toBe(409);
    expect(await store.get(value.operation.id)).toEqual(lease.operation);
    expect(lease.operation).toMatchObject({ state: "claimed", signed: null,
      signingLease: { token: lease.leaseToken, until: lease.leaseUntil } });
    expect(await counts()).toEqual({ pools: 1, assigned: 1, consumed: 1, lanes: 1 });
  });

  it("CAS-publishes one of two different valid signatures across two processes", async () => {
    const value = await prepared(), claimed = await store.claim(value.input), lease = await store.leaseSigning(value.operation.id, 15000);
    const original = await signedTransaction(claimed.operation), unsigned = signableTransaction(claimed.operation);
    const signature = secp256k1.sign(keccak256(serializeTransaction(unsigned)).slice(2), "22".repeat(32),
      { lowS: true, extraEntropy: new Uint8Array(32).fill(7) });
    if (signature.recovery !== 0 && signature.recovery !== 1) throw new Error("Fixture signature needs Ethereum parity");
    const alternate = serializeTransaction(unsigned, { r: toHex(signature.r, { size: 32 }), s: toHex(signature.s, { size: 32 }), yParity: signature.recovery });
    expect(alternate).not.toBe(original);
    const [a, b] = await Promise.all([worker(), worker()]);
    const input = { operationId: value.operation.id, leaseToken: lease.leaseToken!, revision: lease.revision };
    const results = await Promise.all([a.request({ action: "persist", input: { ...input, rawTransaction: original } }),
      b.request({ action: "persist", input: { ...input, rawTransaction: alternate } })]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    const winner = results.find(result => result.status === 200)!.body.operation;
    expect([original, alternate]).toContain(winner.signed.rawTransaction);
    expect(winner.signed.hash).toBe(keccak256(winner.signed.rawTransaction));
    expect(await store.get(value.operation.id)).toEqual(winner);
  });

  it.each(["after-signed", "after-commit"])("recovers exact signed bytes at the %s process crash barrier", async barrierName => {
    const value = await prepared(), claimed = await store.claim(value.input), lease = await store.leaseSigning(value.operation.id, 15000);
    const rawTransaction = await signedTransaction(claimed.operation), [a, b] = await Promise.all([worker(), worker()]);
    const input = { operationId: value.operation.id, leaseToken: lease.leaseToken!, revision: lease.revision, rawTransaction };
    const barrier = message(a.child, "barrier"), lost = a.request({ action: "persist", input, barrier: barrierName }).catch(() => null);
    await barrier; await kill(a.child); await lost;
    expect((await store.get(value.operation.id))?.state).toBe(barrierName === "after-commit" ? "signed" : "claimed");
    const recovered = await b.request({ action: "persist", input });
    expect(recovered.status).toBe(200); expect(recovered.body.replayed).toBe(barrierName === "after-commit");
    expect(recovered.body.operation.signed).toMatchObject({ rawTransaction, hash: keccak256(rawTransaction) });
  });
});
