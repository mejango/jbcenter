import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { hashTypedData, type Hex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createWalletEnrollmentIntent, walletEnrollmentDocument, type WalletEnrollment } from "../src/rest/wallet/enrollment.js";
import { PostgresWalletEnrollmentStore } from "../src/rest/wallet/enrollmentPostgres.js";
import { createRegistration, enrollmentBackupAccount, enrollmentManifest, signBackupProof, signGet } from "./fixtures/wallet-enrollment-crypto.js";

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const schema = `rest_wallet_enrollment_${randomUUID().replaceAll("-", "")}`;
const output = new URL("../.generated/wallet-observations/enrollment-races/", import.meta.url);
const encode = (value: Uint8Array) => Buffer.from(value).toString("base64url");
const challengeHex = (value: string): Hex => `0x${Buffer.from(value, "base64url").toString("hex")}`;

suite("bounded enrollment races across two actual HTTP processes", () => {
  let admin: Pool | undefined, pool: Pool | undefined, store: PostgresWalletEnrollmentStore;
  const children: ChildProcess[] = [], replicas: string[] = [];

  async function worker() {
    const child = fork(fileURLToPath(new URL("./fixtures/wallet-enrollment-process.ts", import.meta.url)), [], {
      execArgv: ["--import", "tsx"], env: { ...process.env, WALLET_ENROLLMENT_TEST_SCHEMA: schema, WALLET_ENROLLMENT_TEST_OPTIONS: "{}" },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    children.push(child); child.stderr?.resume();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => done(new Error("Enrollment race replica startup timed out.")), 10_000);
      const failed = () => done(new Error("Enrollment race replica startup failed."));
      const ready = (value: any) => { if (value?.kind === "ready" && Number.isInteger(value.port)) done(undefined, `http://127.0.0.1:${value.port}`); };
      function done(error?: Error, url?: string) {
        clearTimeout(timer); child.off("message", ready); child.off("exit", failed); child.off("error", failed);
        if (error) reject(error); else resolve(url!);
      }
      child.on("message", ready); child.on("exit", failed); child.on("error", failed);
    });
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString, connectionTimeoutMillis: 3_000, query_timeout: 10_000 });
    expect(Math.floor(Number((await admin.query("SELECT current_setting('server_version_num') AS version")).rows[0].version) / 10_000)).toBe(16);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 2, connectionTimeoutMillis: 3_000, query_timeout: 10_000 });
    for (const migration of ["013_rest_wallet_ceremonies.sql", "015_rest_wallet_enrollment.sql", "041_wallet_passkey_name.sql", "043_wallet_networks.sql"])
      await pool.query(await readFile(new URL(`../src/db/migrations/${migration}`, import.meta.url), "utf8"));
    store = new PostgresWalletEnrollmentStore(pool);
    replicas.push(...await Promise.all([worker(), worker()]));
    expect(new Set(children.map(child => child.pid)).size).toBe(2);
  }, 30_000);
  beforeEach(async () => { await pool!.query("TRUNCATE rest_wallet_credentials,rest_wallet_enrollments,rest_wallet_ceremonies"); });
  afterAll(async () => {
    const results = await Promise.allSettled(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    }));
    results.push(...await Promise.allSettled([pool?.end()]));
    if (admin) {
      results.push(...await Promise.allSettled([admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).then(() => {})]));
      results.push(...await Promise.allSettled([admin.end()]));
    }
    const failures = results.filter(result => result.status === "rejected");
    if (failures.length) throw new Error(`Enrollment race cleanup failed in ${failures.length} operations.`);
  });

  async function begin() {
    return store.begin(createWalletEnrollmentIntent({ manifest: enrollmentManifest, rpId: "wallet.juicebox.center",
      origin: "https://wallet.juicebox.center", recoveryOwner: enrollmentBackupAccount.address, expiresAt: Date.now() + 120_000 }));
  }
  function credential(record: WalletEnrollment) {
    return createRegistration({ challenge: challengeHex(record.intent.registration.challenge), rpId: record.intent.rpId,
      origin: record.intent.origin, userHandle: record.intent.userHandle });
  }
  function candidateRequest(record: WalletEnrollment, value: ReturnType<typeof createRegistration>) {
    return { action: "candidate", id: record.intent.id, response: { ...value.response, rawId: encode(value.response.rawId),
      clientDataJSON: encode(value.response.clientDataJSON), attestationObject: encode(value.response.attestationObject) } };
  }
  async function race(requests: unknown[]) {
    const started = performance.now();
    const results = await Promise.allSettled(requests.map(async (body, index) => {
      const requestStarted = performance.now();
      const response = await fetch(replicas[index % 2]!, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
      return { status: response.status, body: await response.json(), latencyMs: performance.now() - requestStarted };
    }));
    expect(results.filter(result => result.status === "rejected")).toHaveLength(0);
    const responses = results.map(result => {
      if (result.status === "rejected") throw new Error("Enrollment request failed without an HTTP result.");
      return result.value;
    });
    const latencies = responses.map(result => result.latencyMs).sort((a, b) => a - b);
    return { responses, observation: { offeredRequests: requests.length, durationMs: performance.now() - started,
      p50Ms: latencies[Math.ceil(latencies.length * 0.50) - 1], p95Ms: latencies[Math.ceil(latencies.length * 0.95) - 1],
      p99Ms: latencies[Math.ceil(latencies.length * 0.99) - 1], statuses: responses.reduce<Record<number, number>>((counts, result) => {
        counts[result.status] = (counts[result.status] ?? 0) + 1; return counts;
      }, {}) } };
  }
  async function observe(name: string, stages: unknown[]) {
    await mkdir(output, { recursive: true });
    await writeFile(new URL(`${name}.json`, output), JSON.stringify({ observedAt: new Date().toISOString(),
      tier: "bounded-concurrent-correctness", testCase: name, serverProcesses: 2, connectionsPerReplica: 1, databaseMajor: 16,
      concurrency: 100, stages, sustainedThroughputQualified: false, deploymentObserved: false }, null, 2), { mode: 0o600 });
  }

  it("returns one candidate and one original verification receipt under 100 identical concurrent requests", async () => {
    const initial = await begin(), key = credential(initial);
    const candidate = await race(Array.from({ length: 100 }, () => candidateRequest(initial, key)));
    expect(candidate.observation.statuses).toEqual({ 200: 100 });
    const record = candidate.responses[0]!.body as WalletEnrollment;
    for (const response of candidate.responses) expect(response.body).toEqual(record);
    const document = walletEnrollmentDocument(record);
    const assertion = signGet({ challenge: hashTypedData(document), rpId: record.intent.rpId, origin: record.intent.origin,
      userHandle: record.intent.userHandle, credentialId: key.credentialId, key: key.key });
    const proof = { assertion: { ...assertion, authenticatorData: encode(assertion.authenticatorData),
      clientDataJSON: encode(assertion.clientDataJSON), signature: encode(assertion.signature) }, backupSignature: await signBackupProof(document) };
    const finalization = await race(Array.from({ length: 100 }, () => ({ action: "finalize", id: record.intent.id, proof })));
    expect(finalization.observation.statuses).toEqual({ 200: 100 });
    expect(finalization.responses.filter(response => response.body.replayed === false)).toHaveLength(1);
    for (const response of finalization.responses) expect(response.body.record.receipt).toEqual(finalization.responses[0]!.body.record.receipt);
    const counts = (await pool!.query(`SELECT (SELECT count(*)::int FROM rest_wallet_credentials) AS credentials,
      (SELECT count(*)::int FROM rest_wallet_enrollments WHERE state='verified') AS verified,
      (SELECT count(*)::int FROM rest_wallet_ceremonies WHERE consumed_at IS NOT NULL) AS consumed`)).rows[0];
    expect(counts).toEqual({ credentials: 1, verified: 1, consumed: 2 });
    await observe("identical-candidate-and-proof", [candidate.observation, finalization.observation]);
  }, 60_000);

  it("freezes one candidate and explicitly rejects 99 different candidates racing for the same enrollment", async () => {
    const initial = await begin();
    const candidates = Array.from({ length: 100 }, () => credential(initial));
    expect(new Set(candidates.map(candidate => candidate.credentialId)).size).toBe(100);
    const result = await race(candidates.map(candidate => candidateRequest(initial, candidate)));
    expect(result.observation.statuses).toEqual({ 200: 1, 409: 99 });
    for (const response of result.responses.filter(response => response.status === 409)) expect(response.body.code).toBe("WALLET_ENROLLMENT_CONFLICT");
    const winner = result.responses.find(response => response.status === 200)!.body as WalletEnrollment;
    expect(await store.get(initial.intent.id)).toEqual(winner);
    const counts = (await pool!.query(`SELECT (SELECT count(*)::int FROM rest_wallet_credentials) AS credentials,
      (SELECT count(*)::int FROM rest_wallet_ceremonies) AS ceremonies,
      (SELECT count(*)::int FROM rest_wallet_ceremonies WHERE consumed_at IS NOT NULL) AS consumed`)).rows[0];
    expect(counts).toEqual({ credentials: 0, ceremonies: 2, consumed: 1 });
    await observe("conflicting-candidates", [result.observation]);
  }, 60_000);
});
