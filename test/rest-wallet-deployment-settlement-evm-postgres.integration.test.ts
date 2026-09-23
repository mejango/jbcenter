import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashTypedData, toHex, type Hex } from "viem";
import { PostgresWalletDeploymentStore } from "../src/rest/wallet/deploymentPostgres.js";
import { PostgresWalletEnrollmentStore } from "../src/rest/wallet/enrollmentPostgres.js";
import { createLocalAnvilWalletDeploymentSettlement } from "../src/rest/wallet/deploymentSettlementLocalAnvil.js";
import { walletDeploymentRemainingWei } from "../src/rest/wallet/deploymentSettlement.js";
import { createWalletEnrollmentIntent, walletEnrollmentDocument } from "../src/rest/wallet/enrollment.js";
import { prepareWalletDeploymentApproval, walletDeploymentDocument } from "../src/rest/wallet/deployment.js";
import { createRegistration, enrollmentBackupAccount, signBackupProof, signGet } from "./fixtures/wallet-enrollment-crypto.js";
import { startWalletDeploymentAnvil } from "./fixtures/wallet-deployment-anvil.js";

const connectionString = process.env.TEST_DATABASE_URL, suite = connectionString ? describe : describe.skip;
const schema = `rest_wallet_execution_${randomUUID().replaceAll("-", "")}`;
suite("real PostgreSQL and unforked Anvil sequential deployment settlement", () => {
  let fixture: Awaited<ReturnType<typeof startWalletDeploymentAnvil>>;
  let admin: Pool, pool: Pool, reader: Pool, store: PostgresWalletDeploymentStore, enrollments: PostgresWalletEnrollmentStore;
  const children: ChildProcess[] = [];
  const producer = () => createLocalAnvilWalletDeploymentSettlement(fixture);
  // Settlement needs a successfully acknowledged send. Half a second can expire
  // during local EVM RPC work; short-lease uncertainty has separate dispatch tests.
  const wire = (operationId: string, extra: Record<string, unknown> = {}) => ({ action: "recover", operationId, dispatchLeaseMs: 5000,
    localAnvil: { endpoint: fixture.endpoint, expectedGenesisHash: fixture.expectedGenesisHash, utility: fixture.utility }, ...extra });
  const dbNow = async () => Number((await pool.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now")).rows[0].now);
  function message(child: ChildProcess, kind: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Local worker did not reach ${kind}`)), 15000);
      const received = (value: any) => { if (value?.kind === kind) finish(undefined, value); };
      const exited = () => finish(new Error("Local worker exited before barrier"));
      function finish(error?: Error, value?: unknown) {
        clearTimeout(timer); child.off("message", received); child.off("exit", exited); child.off("error", exited);
        if (error) reject(error); else resolve(value);
      }
      child.on("message", received); child.on("exit", exited); child.on("error", exited);
    });
  }
  async function worker(kind: "execution" | "settlement" = "execution") {
    const child = fork(fileURLToPath(new URL(`./fixtures/wallet-deployment-${kind}-process.ts`, import.meta.url)), [], {
      execArgv: ["--import", "tsx"], env: { ...process.env, WALLET_DEPLOYMENT_EXECUTION_TEST_SCHEMA: schema,
        WALLET_DEPLOYMENT_SETTLEMENT_TEST_SCHEMA: schema }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    child.stderr?.resume(); children.push(child); const ready = await message(child, "ready");
    return { child, async request(body: unknown): Promise<{ status: number; body: any }> {
      const response = await fetch(`http://127.0.0.1:${ready.port}`, { method: "POST", body: JSON.stringify(body),
        headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15000) });
      return { status: response.status, body: await response.json() };
    } };
  }
  async function kill(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const done = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGKILL"); await done;
  }
  async function initialize() {
    await fixture.rpc("anvil_setBalance", [fixture.sender, toHex(BigInt(fixture.configuration.allocationWei))]);
    await store.configurePool(fixture.configuration);
    const context = await store.loadFundingContext(fixture.configuration.id), funding = await producer().observeFunding(context);
    // This fixture deploys exactly two test contracts from its public genesis sender. The host
    // fixes its initial nonce explicitly; the provider's observed nonce is never adopted.
    expect(funding.confirmedNonce).toBe("2");
    // The fixture host and its database can differ by milliseconds. Wait for real
    // database time without changing the original observation or expiry.
    await expect.poll(dbNow, { timeout: funding.expiresAt - funding.observedAt }).toBeGreaterThanOrEqual(funding.observedAt);
    const databaseNow = await dbNow(), timing = JSON.stringify({ databaseMinusObservedMs: databaseNow - funding.observedAt,
      expiresInMs: funding.expiresAt - databaseNow, hostMinusDatabaseMs: Date.now() - databaseNow,
      headMinusDatabaseMs: Number(funding.head.timestamp) * 1000 - databaseNow });
    expect(databaseNow, `Funding must be observed by the database clock: ${timing}`).toBeGreaterThanOrEqual(funding.observedAt);
    expect(databaseNow, `Funding must remain fresh at the database clock: ${timing}`).toBeLessThan(funding.expiresAt);
    await store.initializeAccounting(context, funding, "2");
  }
  async function prepared() {
    const initial = await enrollments.begin(createWalletEnrollmentIntent({ manifest: fixture.manifest,
      rpId: "wallet.juicebox.center", origin: "https://wallet.juicebox.center", recoveryOwner: enrollmentBackupAccount.address,
      expiresAt: await dbNow() + 120000 }));
    const credential = createRegistration({ challenge: `0x${Buffer.from(initial.intent.registration.challenge, "base64url").toString("hex")}`,
      rpId: initial.intent.rpId, origin: initial.intent.origin, userHandle: initial.intent.userHandle });
    const pending = await enrollments.acceptRegistration(initial.intent.id, credential.response), document = walletEnrollmentDocument(pending);
    const { record } = await enrollments.finalize(initial.intent.id, { assertion: signGet({ ...credential, challenge: hashTypedData(document),
      rpId: initial.intent.rpId, origin: initial.intent.origin }), backupSignature: await signBackupProof(document) });
    const issuedAt = await dbNow(), approval = prepareWalletDeploymentApproval(record, { issuedAt, expiresAt: issuedAt + 120000 });
    const operation = await store.prepare({ poolId: fixture.configuration.id, approval }), preflight = await fixture.chain().preflight(record, approval);
    expect(preflight.dispatchEligible).toBe(false); expect(preflight.feeModel.baseTotalAffordability).toBe("unknown");
    const assertion = signGet({ ...credential, challenge: hashTypedData(walletDeploymentDocument(record, approval)), rpId: record.intent.rpId, origin: record.intent.origin });
    return { operationId: operation.id, assertion, admission: preflight.admission };
  }
  async function claimed() {
    const next = await prepared(), fundingContext = await store.loadFundingContext(fixture.configuration.id);
    await store.claim({ ...next, funding: await producer().observeFunding(fundingContext) });
    return store.loadExecutionContext(next.operationId);
  }
  async function sent() {
    const context = await claimed(), process = await worker(), result = await process.request(wire(context.operation.id));
    expect(result.status, JSON.stringify(result.body)).toBe(200); expect(result.body.dispatch).toBe("accepted");
    expect((await store.getDispatch(context.operation.id))!.admission.version).toBe("center-wallet-deployment-local-admission-v2");
    return { context: await store.loadExecutionContext(context.operation.id), process };
  }
  /** The worker's next pass: the mined inclusion is observed with the sender nonce past it, and the lane is released. */
  async function release(operationId: string) {
    const context = await store.loadExecutionContext(operationId);
    const observation = await fixture.chain().observeSigned(structuredClone({ enrollment: context.enrollment, operation: context.operation }));
    expect(observation.transaction).toMatchObject({ state: "canonical-success", nonce: { confirmed: String(BigInt(context.operation.template!.transaction.nonce) + 1n) } });
    const saved = await store.saveObservation({ operationId, expectedRevision: context.operation.revision, signedHash: context.operation.signed!.hash, observation });
    const released = await store.release({ operationId, expectedRevision: saved.operation.revision });
    expect(released.pool.activeOperationId).toBeNull();
    return released;
  }
  async function settlement(operationId: string) {
    const dispatch = await store.getDispatch(operationId);
    if (dispatch) await expect.poll(dbNow).toBeGreaterThanOrEqual(dispatch.leaseUntil);
    await fixture.rpc("anvil_mine", ["0x41", "0x0"]);
    await release(operationId);
    const context = await store.loadSettlementContext(operationId), evidence = await producer().observeSettlement(context);
    return { context, evidence };
  }
  async function durable() {
    return (await reader.query(`SELECT p.active_operation_id,p.allocation_wei::text AS allocation,p.accounting,
      (SELECT count(*)::int FROM rest_wallet_deployment_settlements) AS receipts,
      (SELECT count(*)::int FROM rest_wallet_deployments WHERE settlement_id IS NOT NULL) AS markers
      FROM rest_wallet_deployment_pools p`)).rows[0];
  }
  beforeAll(async () => {
    admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 5 });
    reader = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 1, query_timeout: 3000 });
    for (const name of ["013_rest_wallet_ceremonies.sql", "015_rest_wallet_enrollment.sql", "046_wallet_signup_window.sql", "041_wallet_passkey_name.sql", "043_wallet_networks.sql", "044_wallet_devices.sql", "016_rest_wallet_deployments.sql", "036_wallet_deployment_approval_v2.sql",
      "018_rest_wallet_deployment_observations.sql", "021_rest_wallet_deployment_dispatch.sql", "026_wallet_deployment_settlement.sql", "034_wallet_deployment_base.sql", "054_wallet_deployment_inclusion_release.sql", "056_wallet_deployment_release_after_settled_dispatch.sql"])
      await pool.query(await readFile(new URL(`../src/db/migrations/${name}`, import.meta.url), "utf8"));
    store = new PostgresWalletDeploymentStore(pool); enrollments = new PostgresWalletEnrollmentStore(pool);
    fixture = await startWalletDeploymentAnvil();
  }, 30000);
  beforeEach(async () => {
    await fixture.reset();
    await pool.query("TRUNCATE rest_wallet_deployments,rest_wallet_deployment_pools,rest_wallet_credentials,rest_wallet_enrollments,rest_wallet_ceremonies CASCADE");
    await initialize();
  });
  afterEach(async () => { await Promise.all(children.splice(0).map(kill)); });
  afterAll(async () => {
    await fixture?.close(); await reader?.end(); await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  it("deploys two distinct real W3 users sequentially from exactly one allocation and immutable original bytes", async () => {
    const first = await sent(), firstProof = await settlement(first.context.operation.id), firstResult = await store.settle(firstProof.context, firstProof.evidence);
    const firstCost = BigInt(firstProof.evidence.fees.totalWei), allocation = BigInt(fixture.configuration.allocationWei);
    expect(firstResult.settlement).toMatchObject({ nonce: "2", nextNonce: "3", sequence: 1, spentWei: String(firstCost) });
    expect(firstProof.evidence.funding.balanceWei).toBe(String(allocation - firstCost));
    expect(walletDeploymentRemainingWei(firstResult.pool)).toBe(String(allocation - firstCost));
    const second = await sent();
    expect(second.process.child.pid).not.toBe(first.process.child.pid);
    expect(second.context.enrollment.intent.id).not.toBe(first.context.enrollment.intent.id);
    expect(second.context.enrollment.receipt!.credentialId).not.toBe(first.context.enrollment.receipt!.credentialId);
    expect(second.context.operation.template!.transaction.nonce).toBe("3");
    expect(second.context.pool.activeOperationId).toBe(second.context.operation.id);
    const replay = await store.settle(firstProof.context, firstProof.evidence);
    expect(replay.replayed).toBe(true); expect(replay.settlement).toEqual(firstResult.settlement);
    expect(replay.pool.activeOperationId).toBe(second.context.operation.id);
    expect((await store.listUnresolved()).items.map(row => row.id)).toEqual([second.context.operation.id]);
    const secondProof = await settlement(second.context.operation.id), secondResult = await store.settle(secondProof.context, secondProof.evidence);
    const total = firstCost + BigInt(secondProof.evidence.fees.totalWei);
    expect(secondResult.settlement).toMatchObject({ nonce: "3", nextNonce: "4", sequence: 2, spentWei: String(total) });
    expect(secondProof.evidence.funding.balanceWei).toBe(String(allocation - total));
    expect(BigInt(await fixture.rpc<Hex>("eth_getBalance", [fixture.sender, "latest"]))).toBe(allocation - total);
    expect(firstProof.evidence.observation.wallet.state).toBe("verified"); expect(secondProof.evidence.observation.wallet.state).toBe("verified");
    expect(firstProof.evidence.observation.wallet.address).not.toBe(secondProof.evidence.observation.wallet.address);
    for (const item of [first.context, second.context]) {
      const historical = await store.get(item.operation.id);
      expect(historical!.state).toBe("signed"); expect(historical!.signed).toEqual(item.operation.signed);
      expect(historical!.template).toEqual(item.operation.template); expect(await store.getSettlement(item.operation.id)).not.toBeNull();
      await expect(item === first.context ? first.process.request(wire(item.operation.id)) : second.process.request(wire(item.operation.id)))
        .resolves.toMatchObject({ status: 409 });
    }
    expect(secondResult.pool.configuration).toEqual(fixture.configuration);
    expect(await durable()).toMatchObject({ receipts: 2, markers: 2, active_operation_id: null, allocation: String(allocation),
      accounting: { spentWei: String(total), nextNonce: "4", sequence: 2 } });
    expect((await store.listUnresolved()).items).toEqual([]);
  }, 30000);

  it("latches an actual post-settlement branch replacement without refunds or replacing the old signed artifact", async () => {
    const before = await fixture.rpc<Hex>("evm_snapshot"), first = await sent(), proof = await settlement(first.context.operation.id);
    const settled = await store.settle(proof.context, proof.evidence);
    expect(await fixture.rpc("evm_revert", [before])).toBe(true); await fixture.rpc("anvil_mine", ["0x42", "0x0"]);
    const context = await store.loadFundingContext(fixture.configuration.id), funding = await producer().observeFunding(context);
    expect(funding.previousAnchor!.blockHash).not.toBe(proof.evidence.observation.finality.evidence!.blockHash);
    const fenced = await store.fenceAccounting(context, funding);
    expect(fenced.accounting!.fence!.reason).toBe("finalized-anchor-replaced");
    expect(fenced.accounting!.spentWei).toBe(settled.settlement!.spentWei); expect(fenced.accounting!.nextNonce).toBe("3");
    expect(await store.getSettlement(first.context.operation.id)).toEqual(settled.settlement);
    expect((await store.get(first.context.operation.id))!.signed).toEqual(first.context.operation.signed);
    const retry = await store.settle(proof.context, proof.evidence);
    expect(retry.replayed).toBe(true); expect(retry.pool.accounting!.fence).toEqual(fenced.accounting!.fence);
    const next = await prepared();
    await expect(store.claim({ ...next, funding: await producer().observeFunding(await store.loadFundingContext(fixture.configuration.id)) }))
      .rejects.toMatchObject({ status: 409 });
  }, 30000);

  it("settles the same actual finalized deployment through two processes with one receipt and one debit", async () => {
    const deployed = await sent(), first = await worker("settlement"), second = await worker("settlement");
    expect(first.child.pid).not.toBe(second.child.pid);
    const proof = await settlement(deployed.context.operation.id), input = { action: "settle", ...proof };
    const results = await Promise.all([first.request(input), second.request(input)]);
    expect(results.map(result => result.status)).toEqual([200, 200]);
    expect(results.map(result => result.body.replayed).sort()).toEqual([false, true]);
    expect(results[0]!.body.settlement).toEqual(results[1]!.body.settlement);
    expect(await durable()).toMatchObject({ receipts: 1, markers: 1, active_operation_id: null,
      accounting: { nextNonce: "3", spentWei: proof.evidence.fees.totalWei, sequence: 1 } });
    expect(BigInt(await fixture.rpc<Hex>("eth_getBalance", [fixture.sender, "latest"])))
      .toBe(BigInt(fixture.configuration.allocationWei) - BigInt(proof.evidence.fees.totalWei));
  }, 30000);

  it("rolls back a process killed after all settlement writes and recovers the same actual transaction", async () => {
    const deployed = await sent(), first = await worker("settlement"), second = await worker("settlement");
    const proof = await settlement(deployed.context.operation.id), reached = message(first.child, "barrier");
    const request = first.request({ action: "settle", ...proof, barrier: "after-debit" }).catch(() => null);
    await reached;
    expect(await durable()).toMatchObject({ receipts: 0, markers: 0, active_operation_id: null,
      accounting: { nextNonce: "3", spentWei: "0", sequence: 0 } });
    await kill(first.child); await request;
    expect(await store.getSettlement(deployed.context.operation.id)).toBeNull();
    expect((await store.get(deployed.context.operation.id))!.signed).toEqual(deployed.context.operation.signed);
    const recovered = await second.request({ ...wire(deployed.context.operation.id), action: "observe-settle" });
    expect(recovered.status).toBe(200); expect(recovered.body.replayed).toBe(false);
    expect(recovered.body.settlement.evidence.transactionHash).toBe(deployed.context.operation.signed!.hash);
    expect(await durable()).toMatchObject({ receipts: 1, markers: 1, active_operation_id: null,
      accounting: { nextNonce: "3", spentWei: proof.evidence.fees.totalWei, sequence: 1 } });
    expect(await fixture.rpc("eth_getTransactionCount", [fixture.sender, "latest"])).toBe("0x3");
  }, 30000);

  it("recovers a lost settlement COMMIT response after the original evidence expires without charging again", async () => {
    const deployed = await sent(), first = await worker("settlement"), second = await worker("settlement");
    const proof = await settlement(deployed.context.operation.id), reached = message(first.child, "barrier");
    const request = first.request({ action: "settle", ...proof, barrier: "after-commit" }).catch(() => null);
    await reached;
    const committed = await durable();
    expect(committed).toMatchObject({ receipts: 1, markers: 1, active_operation_id: null,
      accounting: { nextNonce: "3", spentWei: proof.evidence.fees.totalWei, sequence: 1 } });
    await kill(first.child); await request;
    await expect.poll(dbNow).toBeGreaterThanOrEqual(proof.evidence.funding.expiresAt);
    const recovered = await second.request({ action: "settle", ...proof });
    expect(recovered.status).toBe(200); expect(recovered.body.replayed).toBe(true);
    expect(recovered.body.settlement).toEqual(await store.getSettlement(deployed.context.operation.id));
    expect(await durable()).toEqual(committed);
    expect((await store.get(deployed.context.operation.id))!.signed).toEqual(deployed.context.operation.signed);
  }, 30000);
});
