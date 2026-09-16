import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decodeEventLog, hashTypedData, keccak256, toHex, type Hex } from "viem";
import { SAFE_CREATION_ABI } from "../src/rest/smartAccounts/creation.js";
import { PostgresWalletDeploymentStore } from "../src/rest/wallet/deploymentPostgres.js";
import { PostgresWalletEnrollmentStore } from "../src/rest/wallet/enrollmentPostgres.js";
import { createWalletEnrollmentIntent, walletEnrollmentDocument } from "../src/rest/wallet/enrollment.js";
import { prepareWalletDeploymentApproval, walletDeploymentDocument } from "../src/rest/wallet/deployment.js";
import { createRegistration, enrollmentBackupAccount, signBackupProof, signGet } from "./fixtures/wallet-enrollment-crypto.js";
import { startWalletDeploymentAnvil } from "./fixtures/wallet-deployment-anvil.js";

const connectionString = process.env.TEST_DATABASE_URL, suite = connectionString ? describe : describe.skip;
const schema = `rest_wallet_execution_${randomUUID().replaceAll("-", "")}`;
type Receipt = { transactionHash: Hex; blockHash: Hex; blockNumber: Hex; status: Hex };

suite("real PostgreSQL workers and unforked Anvil exact deployment recovery", () => {
  let fixture: Awaited<ReturnType<typeof startWalletDeploymentAnvil>>, proxy: Server, endpoint: string;
  let admin: Pool, pool: Pool, deliveryReader: Pool, store: PostgresWalletDeploymentStore, enrollments: PostgresWalletEnrollmentStore;
  const children: ChildProcess[] = [];
  const forwarded: { raw: Hex; hash: Hex; operationId: string; nonce: string; attempts: number; databasePid: number }[] = [];
  const rejectedDeliveries: string[] = [];
  let loseReply = false;
  let afterAcceptance: ((hash: Hex) => Promise<void>) | null = null;
  const wire = (operationId: string, action: "sign" | "recover" = "recover", extra: Record<string, unknown> = {}) => ({ action, operationId,
    localAnvil: { endpoint, expectedGenesisHash: fixture.expectedGenesisHash, utility: fixture.utility }, ...extra });
  async function dbNow(): Promise<number> { return Number((await pool.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now")).rows[0].now); }
  async function waitUntil(timestamp: number) { await new Promise(resolve => setTimeout(resolve, Math.max(1, timestamp - Date.now() + 15))); }
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
  async function worker() {
    const child = fork(fileURLToPath(new URL("./fixtures/wallet-deployment-execution-process.ts", import.meta.url)), [], {
      execArgv: ["--import", "tsx"], env: { ...process.env, WALLET_DEPLOYMENT_EXECUTION_TEST_SCHEMA: schema },
      stdio: ["ignore", "ignore", "pipe", "ipc"] });
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
  async function claimed() {
    await store.configurePool(fixture.configuration);
    const initial = await enrollments.begin(createWalletEnrollmentIntent({ manifest: fixture.manifest,
      rpId: "wallet.juicebox.center", origin: "https://wallet.juicebox.center", recoveryOwner: enrollmentBackupAccount.address,
      expiresAt: await dbNow() + 120000 }));
    const credential = createRegistration({ challenge: `0x${Buffer.from(initial.intent.registration.challenge, "base64url").toString("hex")}`,
      rpId: initial.intent.rpId, origin: initial.intent.origin, userHandle: initial.intent.userHandle });
    const pending = await enrollments.acceptRegistration(initial.intent.id, credential.response), document = walletEnrollmentDocument(pending);
    const { record } = await enrollments.finalize(initial.intent.id, { assertion: signGet({ ...credential,
      challenge: hashTypedData(document), rpId: initial.intent.rpId, origin: initial.intent.origin }), backupSignature: await signBackupProof(document) });
    const issuedAt = await dbNow(), approval = prepareWalletDeploymentApproval(record, { issuedAt, expiresAt: issuedAt + 120000 });
    const operation = await store.prepare({ poolId: fixture.configuration.id, approval });
    const preflight = await fixture.chain().preflight(record, approval);
    expect(preflight.dispatchEligible).toBe(false); expect(preflight.feeModel.baseTotalAffordability).toBe("unknown");
    const assertion = signGet({ ...credential, challenge: hashTypedData(walletDeploymentDocument(record, approval)), rpId: record.intent.rpId, origin: record.intent.origin });
    await store.claim({ operationId: operation.id, assertion, admission: preflight.admission });
    expect(forwarded).toHaveLength(0); return store.loadExecutionContext(operation.id);
  }
  async function receipt(hash: Hex): Promise<Receipt> {
    for (let i = 0; i < 100; i++) {
      const value = await fixture.rpc<Receipt | null>("eth_getTransactionReceipt", [hash]);
      if (value) return value; await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Actual local transaction was not mined within its fixture bound");
  }
  async function assertRetained(operationId: string, expectedHash: Hex, expectedNonce: string) {
    const context = await store.loadExecutionContext(operationId);
    expect(context.operation.signed!.hash).toBe(expectedHash); expect(context.operation.template!.transaction.nonce).toBe(expectedNonce);
    expect(context.operation.state).toBe("signed"); expect(context.pool.activeOperationId).toBe(operationId);
    expect(context.pool.configuration.allocationWei).toBe(fixture.configuration.allocationWei);
    const counts = (await pool.query(`SELECT (SELECT count(*)::int FROM rest_wallet_deployments WHERE state<>'prepared') AS assigned,
      (SELECT count(*)::int FROM rest_wallet_ceremonies WHERE purpose='deploy' AND consumed_at IS NOT NULL) AS approvals`)).rows[0];
    expect(counts).toEqual({ assigned: 1, approvals: 1 }); return context;
  }
  async function assertOneCanonicalCreation(operationId: string) {
    const context = await store.loadExecutionContext(operationId), hash = context.operation.signed!.hash;
    const mined = await receipt(hash); expect(mined.status).toBe("0x1");
    const logs = await fixture.rpc<{ topics: [Hex, ...Hex[]]; data: Hex; transactionHash: Hex }[]>("eth_getLogs",
      [{ address: fixture.manifest.factory.address, fromBlock: "0x0", toBlock: "latest" }]);
    const creations = logs.map(log => ({ ...decodeEventLog({ abi: SAFE_CREATION_ABI, topics: log.topics, data: log.data }), hash: log.transactionHash }));
    expect(creations).toHaveLength(1);
    expect(creations[0]!.args.proxy.toLowerCase()).toBe(context.enrollment.creation!.address.toLowerCase());
    expect(creations[0]!.hash).toBe(hash);
    expect(await fixture.rpc("eth_getTransactionCount", [fixture.sender, "latest"])).toBe(toHex(BigInt(context.operation.template!.transaction.nonce) + 1n));
    const observed = await fixture.chain().observeSigned(context);
    expect(observed.transaction.state).toBe("canonical-success"); expect(observed.wallet.state).toBe("verified");
    expect(observed.wallet.creationTransaction).toBe(hash); return { context, observed, mined };
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 4 });
    // Distinct connection pool: visibility here proves the worker's journal and bytes committed.
    deliveryReader = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 1, query_timeout: 3000 });
    for (const name of ["013_rest_wallet_ceremonies.sql", "015_rest_wallet_enrollment.sql", "041_wallet_passkey_name.sql", "043_wallet_networks.sql", "044_wallet_devices.sql", "016_rest_wallet_deployments.sql", "036_wallet_deployment_approval_v2.sql",
      "018_rest_wallet_deployment_observations.sql", "021_rest_wallet_deployment_dispatch.sql", "026_wallet_deployment_settlement.sql"])
      await pool.query(await readFile(new URL(`../src/db/migrations/${name}`, import.meta.url), "utf8"));
    store = new PostgresWalletDeploymentStore(pool); enrollments = new PostgresWalletEnrollmentStore(pool);
    fixture = await startWalletDeploymentAnvil();
    proxy = createServer(async (request, response) => {
      try {
        let bytes = "";
        for await (const chunk of request) { bytes += String(chunk); if (bytes.length > 262144) throw new Error("Local proxy request bound"); }
        const body = JSON.parse(bytes) as { id: number; method: string; params: any[] };
        if (body.method === "eth_sendRawTransaction") {
          const raw = body.params[0] as Hex, hash = keccak256(raw);
          const result = await deliveryReader.query(`SELECT d.id,d.raw_transaction,d.transaction_hash,d.nonce::text AS nonce,
            p.active_operation_id,p.allocation_wei::text AS allocation,j.status,j.transaction_hash AS journal_hash,j.attempts,
            j.lease_until::text AS lease_until,pg_backend_pid() AS database_pid FROM rest_wallet_deployments d
            JOIN rest_wallet_deployment_pools p ON p.id=d.pool_id
            JOIN rest_wallet_deployment_dispatches j ON j.operation_id=d.id WHERE d.transaction_hash=$1`, [hash]);
          const row = result.rows[0];
          if (result.rowCount !== 1 || row.raw_transaction !== raw || row.transaction_hash !== hash || row.journal_hash !== hash ||
              row.status !== "in-flight" || row.active_operation_id !== row.id || row.allocation !== fixture.configuration.allocationWei ||
              Number(row.lease_until) <= Date.now()) {
            rejectedDeliveries.push("Send lacked a visible committed exact winner and live dispatch journal");
            throw new Error("Local durability assertion failed");
          }
          forwarded.push({ raw, hash, operationId: row.id, nonce: row.nonce, attempts: row.attempts, databasePid: row.database_pid });
        }
        const result = await fixture.rpc(body.method, body.params);
        if (body.method === "eth_sendRawTransaction" && afterAcceptance) await afterAcceptance(result as Hex);
        if (body.method === "eth_sendRawTransaction" && loseReply) { response.destroy(); return; }
        response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
      } catch { if (!response.destroyed) { response.writeHead(502); response.end('{"error":"LOCAL_PROXY_UNAVAILABLE"}'); } }
    });
    await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
    endpoint = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  }, 30000);
  beforeEach(async () => {
    await fixture.reset(); forwarded.length = 0; rejectedDeliveries.length = 0; loseReply = false; afterAcceptance = null;
    await pool.query("TRUNCATE rest_wallet_deployments,rest_wallet_deployment_pools,rest_wallet_credentials,rest_wallet_enrollments,rest_wallet_ceremonies CASCADE");
  });
  afterEach(async () => { await Promise.all(children.splice(0).map(kill)); expect(rejectedDeliveries).toEqual([]); });
  afterAll(async () => {
    proxy?.closeAllConnections(); if (proxy) await new Promise<void>(resolve => proxy.close(() => resolve()));
    await fixture?.close(); await deliveryReader?.end(); await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  it("requires committed real W3 approval, signed bytes and dispatch journal before one actual Safe creation and finality", async () => {
    const context = await claimed(), child = await worker(), result = await child.request(wire(context.operation.id));
    expect(result.status).toBe(200); expect(result.body.dispatch).toBe("accepted"); expect(forwarded).toHaveLength(1);
    const { mined } = await assertOneCanonicalCreation(context.operation.id);
    // Mine empty local blocks with a zero interval; no timestamp fabrication or finality response stub.
    await fixture.rpc("anvil_mine", ["0x41", "0x0"]);
    const finalized = await fixture.rpc<{ number: Hex; hash: Hex }>("eth_getBlockByNumber", ["finalized", false]);
    expect(BigInt(finalized.number)).toBeGreaterThanOrEqual(BigInt(mined.blockNumber));
    const observed = await child.request(wire(context.operation.id));
    expect(observed.status).toBe(200); expect(observed.body.dispatch).toBe("observed");
    expect(observed.body.operation.observation.finality.state).toBe("finalized"); expect(forwarded).toHaveLength(1);
    await assertRetained(context.operation.id, forwarded[0]!.hash, context.operation.template!.transaction.nonce);
  }, 30000);

  it("recovers after a process dies immediately after signed-byte commit with zero earlier sends", async () => {
    const context = await claimed(), first = await worker(), reached = message(first.child, "barrier");
    const request = first.request(wire(context.operation.id, "sign", { barrier: "after-signed-commit" })).catch(() => null);
    await reached; await kill(first.child); await request;
    const signed = await store.loadExecutionContext(context.operation.id);
    expect(signed.operation.state).toBe("signed"); expect(signed.operation.signed).not.toBeNull(); expect(forwarded).toHaveLength(0);
    expect(await store.getDispatch(context.operation.id)).toBeNull();
    const second = await worker(), result = await second.request(wire(context.operation.id));
    expect(second.child.pid).not.toBe(first.child.pid); expect(result.status).toBe(200); expect(result.body.dispatch).toBe("accepted");
    expect(forwarded.map(value => value.raw)).toEqual([signed.operation.signed!.rawTransaction]);
    await assertOneCanonicalCreation(context.operation.id);
    await assertRetained(context.operation.id, signed.operation.signed!.hash, context.operation.template!.transaction.nonce);
  }, 30000);

  it("recovers a committed dispatch lease after process death before send without choosing new bytes or nonce", async () => {
    const context = await claimed(), first = await worker(), reached = message(first.child, "barrier");
    const request = first.request(wire(context.operation.id, "recover", { barrier: "after-dispatch-commit", dispatchLeaseMs: 500 })).catch(() => null);
    await reached; await kill(first.child); await request;
    const signed = await store.loadExecutionContext(context.operation.id), old = (await store.getDispatch(context.operation.id))!;
    expect(old).toMatchObject({ attempts: 1, status: "in-flight" }); expect(forwarded).toHaveLength(0);
    await waitUntil(old.nextAttemptAt);
    const second = await worker(), result = await second.request(wire(context.operation.id));
    expect(result.status).toBe(200); expect(result.body.dispatch).toBe("accepted");
    expect(forwarded.map(value => ({ raw: value.raw, attempts: value.attempts }))).toEqual([{ raw: signed.operation.signed!.rawTransaction, attempts: 2 }]);
    expect((await store.getDispatch(context.operation.id))!.leaseToken).not.toBe(old.leaseToken);
    await assertOneCanonicalCreation(context.operation.id);
    await assertRetained(context.operation.id, signed.operation.signed!.hash, context.operation.template!.transaction.nonce);
  }, 30000);

  it("keeps provider-accepted lost reply unknown, then a fresh process observes the same transaction without resigning or sending", async () => {
    const context = await claimed(), first = await worker(); loseReply = true;
    const result = await first.request(wire(context.operation.id));
    expect(result.status).toBe(200); expect(result.body.dispatch).toBe("unknown"); expect(forwarded).toHaveLength(1);
    const original = (await store.get(context.operation.id))!.signed!;
    expect((await store.getDispatch(context.operation.id))!.status).toBe("unknown"); await receipt(original.hash);
    await kill(first.child); loseReply = false;
    const second = await worker(), recovered = await second.request(wire(context.operation.id));
    expect(recovered.status).toBe(200); expect(recovered.body.dispatch).toBe("observed");
    expect(recovered.body.operation.signed).toEqual(original); expect(forwarded).toHaveLength(1);
    expect((await store.getDispatch(context.operation.id))!.attempts).toBe(1);
    await assertOneCanonicalCreation(context.operation.id);
    await assertRetained(context.operation.id, original.hash, context.operation.template!.transaction.nonce);
  }, 30000);

  it("recovers after actual provider acceptance and process death before any reply settlement", async () => {
    const context = await claimed(), first = await worker();
    let accepted!: (hash: Hex) => void, failed!: (error: Error) => void, release!: () => void;
    const acceptance = new Promise<Hex>((resolve, reject) => { accepted = resolve; failed = reject; });
    const held = new Promise<void>(resolve => { release = resolve; });
    // Always release a stuck proxy, including test failures. Only the test process observes this signal.
    const watchdog = setTimeout(() => { failed(new Error("No actual local provider acceptance before deadline")); release(); }, 10000);
    afterAcceptance = async hash => { accepted(hash); await held; };
    const request = first.request(wire(context.operation.id)).catch(() => null);
    try {
      const acceptedHash = await acceptance;
      const signed = (await store.get(context.operation.id))!.signed!, before = (await store.getDispatch(context.operation.id))!;
      expect(acceptedHash).toBe(signed.hash); expect(forwarded).toHaveLength(1);
      expect(before).toMatchObject({ status: "in-flight", revision: 1, attempts: 1, settledAt: null, transactionHash: signed.hash });
      expect(forwarded[0]!.raw).toBe(signed.rawTransaction);
      await kill(first.child); await request;
      // The provider accepted, but this worker never received a response or recorded a settlement.
      expect(await store.getDispatch(context.operation.id)).toEqual(before);
      clearTimeout(watchdog); afterAcceptance = null; release(); await receipt(signed.hash);
      const second = await worker(), recovered = await second.request(wire(context.operation.id));
      expect(second.child.pid).not.toBe(first.child.pid); expect(recovered.status).toBe(200);
      expect(recovered.body.dispatch).toBe("observed"); expect(recovered.body.operation.signed).toEqual(signed);
      expect(recovered.body.operation.observation.transaction.state).toBe("canonical-success");
      expect(forwarded).toHaveLength(1); expect(await store.getDispatch(context.operation.id)).toEqual(before);
      await assertOneCanonicalCreation(context.operation.id);
      await assertRetained(context.operation.id, signed.hash, context.operation.template!.transaction.nonce);
    } finally { clearTimeout(watchdog); afterAcceptance = null; release(); }
  }, 30000);

  it("observes actual pending bytes without another send, then exactly rebroadcasts after a local mempool drop", async () => {
    const context = await claimed(), first = await worker(); await fixture.rpc("evm_setAutomine", [false]);
    const sent = await first.request(wire(context.operation.id, "recover", { dispatchLeaseMs: 500 }));
    expect(sent.status).toBe(200); expect(sent.body.dispatch).toBe("accepted"); expect(forwarded).toHaveLength(1);
    const original = (await store.get(context.operation.id))!.signed!, prior = (await store.getDispatch(context.operation.id))!;
    expect(await fixture.rpc("eth_getTransactionReceipt", [original.hash])).toBeNull();
    const second = await worker(), pending = await second.request(wire(context.operation.id));
    expect(pending.status).toBe(200); expect(pending.body.dispatch).toBe("observed");
    expect(pending.body.operation.observation.transaction.state).toBe("pending"); expect(forwarded).toHaveLength(1);
    await fixture.rpc("anvil_dropTransaction", [original.hash]); await fixture.rpc("evm_setAutomine", [true]);
    await waitUntil(prior.nextAttemptAt);
    const recovered = await second.request(wire(context.operation.id));
    expect(recovered.status).toBe(200); expect(recovered.body.dispatch).toBe("accepted");
    expect(forwarded.map(value => value.raw)).toEqual([original.rawTransaction, original.rawTransaction]);
    await assertOneCanonicalCreation(context.operation.id);
    await assertRetained(context.operation.id, original.hash, context.operation.template!.transaction.nonce);
  }, 30000);

  it("recovers a real mined reorg before finality with the identical persisted transaction", async () => {
    const context = await claimed(), baseline = await fixture.rpc<Hex>("evm_snapshot"), first = await worker();
    const sent = await first.request(wire(context.operation.id, "recover", { dispatchLeaseMs: 500 }));
    expect(sent.status).toBe(200); expect(sent.body.dispatch).toBe("accepted");
    const original = (await store.get(context.operation.id))!.signed!, mined = await receipt(original.hash);
    const observed = await first.request(wire(context.operation.id));
    expect(observed.status).toBe(200); expect(observed.body.operation.observation.transaction.state).toBe("canonical-success");
    expect(observed.body.operation.observation.finality.state).toBe("unfinalized");
    const prior = (await store.getDispatch(context.operation.id))!;
    expect(await fixture.rpc("evm_revert", [baseline])).toBe(true);
    // Reach the old height on a replacement empty branch while retaining the same sender nonce.
    await fixture.rpc("evm_setNextBlockTimestamp", [Number(BigInt(mined.blockNumber)) + Math.floor(Date.now() / 1000) + 1]);
    await fixture.rpc("evm_mine");
    expect(await fixture.rpc("eth_getTransactionReceipt", [original.hash])).toBeNull();
    expect(await fixture.rpc("eth_getCode", [context.enrollment.creation!.address, "latest"])).toBe("0x");
    await waitUntil(prior.nextAttemptAt); await kill(first.child);
    const second = await worker(), recovered = await second.request(wire(context.operation.id));
    expect(recovered.status).toBe(200); expect(recovered.body.dispatch).toBe("accepted");
    expect(forwarded.map(value => value.raw)).toEqual([original.rawTransaction, original.rawTransaction]);
    const canonical = await assertOneCanonicalCreation(context.operation.id);
    expect(canonical.mined.blockHash).not.toBe(mined.blockHash);
    await assertRetained(context.operation.id, original.hash, context.operation.template!.transaction.nonce);
  }, 30000);
});
