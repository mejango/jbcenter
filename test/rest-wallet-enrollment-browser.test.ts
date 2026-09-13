import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createWalletEnrollmentIntent, walletEnrollmentDocument, type WalletEnrollment } from "../src/rest/wallet/enrollment.js";
import { prepareWalletDeploymentApproval, verifyWalletDeploymentProof } from "../src/rest/wallet/deployment.js";
import { enrollmentBackupAccount, enrollmentManifest, signBackupProof } from "./fixtures/wallet-enrollment-crypto.js";

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const schema = `rest_wallet_enrollment_${randomUUID().replaceAll("-", "")}`;
const observation = new URL("../.generated/wallet-observations/browser-enrollment/", import.meta.url);
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Center enrollment observation</title>
<style>body{font:16px monospace;background:#faf9f6;color:#171717;max-width:700px;margin:60px auto;padding:24px}pre{white-space:pre-wrap;line-height:1.7}</style></head>
<body><h1>Center enrollment observation</h1><pre id="status">Testing browser ownership proofs and durable enrollment.</pre>
<p>Local virtual passkey, test backup owner, two server processes and PostgreSQL.</p>
<p>No wallet deployment, session or payment is authorized by this test.</p></body></html>`;

suite("real browser enrollment through two HTTP replicas and PostgreSQL", () => {
  let admin: Pool | undefined, pool: Pool | undefined, server: Server | undefined, browser: Browser | undefined;
  let page: Page, cdp: CDPSession, authenticatorId: string, origin: string;
  const children: ChildProcess[] = [];
  const replicas: string[] = [];
  const pageErrors: string[] = [];
  let lostReplies = 0;
  let databaseMajor = 0;
  const lostReceipts: Array<{ replayed: boolean; receipt: unknown }> = [];

  async function worker(): Promise<string> {
    const child = fork(fileURLToPath(new URL("./fixtures/wallet-enrollment-process.ts", import.meta.url)), [], {
      execArgv: ["--import", "tsx"],
      env: { ...process.env, WALLET_ENROLLMENT_TEST_SCHEMA: schema, WALLET_ENROLLMENT_TEST_OPTIONS: "{}" },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    children.push(child);
    // Bound stderr drainage; diagnostic errors must not include proof or connection bytes.
    child.stderr?.resume();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => done(new Error("Enrollment replica startup timed out.")), 10_000);
      const exited = () => done(new Error("Enrollment replica exited during startup."));
      const failed = () => done(new Error("Enrollment replica could not start."));
      const message = (value: unknown) => {
        const ready = value as { kind?: string; port?: number };
        if (ready?.kind === "ready" && Number.isInteger(ready.port)) done(undefined, `http://127.0.0.1:${ready.port}`);
      };
      function done(error?: Error, url?: string) {
        clearTimeout(timeout); child.off("message", message); child.off("exit", exited); child.off("error", failed);
        if (error) reject(error); else resolve(url!);
      }
      child.on("message", message); child.on("exit", exited); child.on("error", failed);
    });
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString, connectionTimeoutMillis: 3_000, query_timeout: 10_000 });
    const version = (await admin.query("SELECT current_setting('server_version_num') AS version")).rows[0].version;
    databaseMajor = Math.floor(Number(version) / 10_000);
    expect(databaseMajor).toBe(16);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 2, connectionTimeoutMillis: 3_000, query_timeout: 10_000 });
    for (const migration of ["013_rest_wallet_ceremonies.sql", "015_rest_wallet_enrollment.sql"])
      await pool.query(await readFile(new URL(`../src/db/migrations/${migration}`, import.meta.url), "utf8"));
    replicas.push(...await Promise.all([worker(), worker()]));
    // This is a test gateway, not a product route or an authorization middleware.
    // Browser requests use one RP/origin while independent processes share the database.
    server = createServer(async (request, response) => {
      if (request.method === "GET" && request.url === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(html); return;
      }
      try {
        const route = /^\/replica\/([01])\/(begin|candidate|finalize|get)(\/lose-reply)?$/.exec(request.url ?? "");
        if (request.method !== "POST" || !route) { response.writeHead(404); response.end(); return; }
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 64 * 1024) throw new Error("Oversized test request.");
          chunks.push(Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const payload = route[2] === "begin" ? { action: "begin", intent: createWalletEnrollmentIntent({
          manifest: enrollmentManifest, rpId: "localhost", origin, recoveryOwner: enrollmentBackupAccount.address,
          expiresAt: Date.now() + 120_000,
        }) } : { ...body, action: route[2] };
        const upstream = await fetch(replicas[Number(route[1])]!, { method: "POST", body: JSON.stringify(payload),
          headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000) });
        const bytes = await upstream.text();
        if (route[3] && upstream.ok) {
          // The replica has committed and answered. The browser never receives that answer.
          const committed = JSON.parse(bytes);
          lostReceipts.push({ replayed: committed.replayed, receipt: committed.record.receipt });
          lostReplies++; response.destroy(); return;
        }
        response.writeHead(upstream.status, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(bytes);
      } catch {
        if (!response.destroyed) { response.writeHead(500); response.end('{"code":"TEST_GATEWAY_FAILED"}'); }
      }
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Browser gateway did not start.");
    origin = `http://localhost:${address.port}`;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1000, height: 750 } });
    page = await context.newPage(); page.on("pageerror", error => pageErrors.push(error.message));
    cdp = await context.newCDPSession(page); await cdp.send("WebAuthn.enable");
    ({ authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
      protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
    } }));
    await page.goto(origin);
  }, 30_000);

  beforeEach(async () => {
    await pool!.query("TRUNCATE rest_wallet_credentials,rest_wallet_enrollments,rest_wallet_ceremonies");
    await cdp.send("WebAuthn.clearCredentials", { authenticatorId });
    lostReplies = 0; lostReceipts.length = 0; pageErrors.length = 0;
  });

  afterAll(async () => {
    server?.closeAllConnections();
    const results = await Promise.allSettled([browser?.close(),
      new Promise<void>(resolve => server?.listening ? server.close(() => resolve()) : resolve()),
      ...children.map(async child => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
      })]);
    results.push(...await Promise.allSettled([pool?.end()]));
    if (admin) {
      results.push(...await Promise.allSettled([admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).then(() => {})]));
      results.push(...await Promise.allSettled([admin.end()]));
    }
    const failures = results.filter(result => result.status === "rejected");
    if (failures.length) throw new Error(`Enrollment browser cleanup failed in ${failures.length} operations.`);
  });

  async function browserRequest(path: string, body: unknown = {}) {
    return page.evaluate(async ({ path, body }) => {
      try {
        const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        return { status: response.status, body: await response.json(), lost: false };
      } catch { return { status: 0, body: null, lost: true }; }
    }, { path, body });
  }

  async function register() {
    const initial = await browserRequest("/replica/0/begin");
    expect(initial.status).toBe(200);
    const record = initial.body as WalletEnrollment;
    const response = await page.evaluate(async intent => {
      const decode = (value: string) => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
      const encode = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      const credential = await navigator.credentials.create({ publicKey: {
        rp: { id: intent.rpId, name: "Center local enrollment" }, user: { id: decode(intent.userHandle), name: "Test owner", displayName: "Test owner" },
        challenge: decode(intent.registration.challenge), pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { residentKey: "required", userVerification: "required" }, attestation: "none", timeout: 5_000,
      } }) as PublicKeyCredential;
      const attestation = credential.response as AuthenticatorAttestationResponse;
      return { type: credential.type, credentialId: credential.id, rawId: encode(credential.rawId),
        clientDataJSON: encode(attestation.clientDataJSON), attestationObject: encode(attestation.attestationObject) };
    }, record.intent);
    const candidates = await Promise.all([0, 1].map(replica => browserRequest(`/replica/${replica}/candidate`, { id: record.intent.id, response })));
    expect(candidates.map(candidate => candidate.status)).toEqual([200, 200]);
    expect(candidates[0]!.body).toEqual(candidates[1]!.body);
    expect(candidates[0]!.body.state).toBe("awaiting_possession");
    expect(candidates[0]!.body.receipt).toBeNull();
    return candidates[0]!.body as WalletEnrollment;
  }

  async function assertion(record: WalletEnrollment, userVerification: "required" | "discouraged" = "required",
    challenge = record.possession!.ceremony.challenge) {
    return page.evaluate(async ({ record, userVerification, challenge }) => {
      const decode = (value: string) => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
      const encode = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      const credential = await navigator.credentials.get({ publicKey: {
        rpId: record.intent.rpId, challenge: decode(challenge), userVerification, timeout: 5_000,
      } }) as PublicKeyCredential;
      const proof = credential.response as AuthenticatorAssertionResponse;
      return { credentialId: credential.id, authenticatorData: encode(proof.authenticatorData), clientDataJSON: encode(proof.clientDataJSON),
        signature: encode(proof.signature), userHandle: proof.userHandle ? encode(proof.userHandle) : null };
    }, { record, userVerification, challenge });
  }

  it("keeps one enrollment and original receipt when a committed browser response is lost", async () => {
    const record = await register();
    const proof = { assertion: await assertion(record), backupSignature: await signBackupProof(walletEnrollmentDocument(record)) };
    expect(proof.assertion.userHandle).toBe(record.intent.userHandle);
    const request = { id: record.intent.id, proof };
    expect((await browserRequest("/replica/0/finalize/lose-reply", request)).lost).toBe(true);
    // Chromium may transparently retry a failed POST connection before rejecting fetch.
    // Every admitted retry must preserve the original database effect and receipt.
    expect(lostReplies).toBeGreaterThanOrEqual(1);
    expect(lostReceipts.filter(result => result.replayed === false)).toHaveLength(1);
    const recovered = await browserRequest("/replica/1/finalize", request);
    expect(recovered.status).toBe(200); expect(recovered.body.replayed).toBe(true);
    expect(recovered.body.record.state).toBe("verified");
    for (const result of lostReceipts) expect(result.receipt).toEqual(recovered.body.record.receipt);
    expect(recovered.body.record.receipt.accountId).toBe(`eip155:8453:${record.creation!.address.toLowerCase()}`);
    const retained = await browserRequest("/replica/0/get", { id: record.intent.id });
    expect(retained.status).toBe(200); expect(retained.body).toEqual(recovered.body.record);
    const counts = (await pool!.query(`SELECT (SELECT count(*)::int FROM rest_wallet_credentials) AS credentials,
      (SELECT count(*)::int FROM rest_wallet_enrollments WHERE state='verified') AS verified,
      (SELECT count(*)::int FROM rest_wallet_ceremonies WHERE consumed_at IS NOT NULL) AS consumed`)).rows[0];
    expect(counts).toEqual({ credentials: 1, verified: 1, consumed: 2 });
    expect(pageErrors).toEqual([]);
    await page.locator("#status").evaluate(element => { element.textContent =
      "Browser passkey registration accepted by both replicas.\nPasskey and backup ownership proofs verified.\nCommitted response deliberately lost.\nSecond replica returned the original receipt.\nOne credential mapping and one wallet identity retained."; });
    await mkdir(observation, { recursive: true });
    await page.screenshot({ path: fileURLToPath(new URL("chromium-enrollment.png", observation)), fullPage: true });
    await writeFile(new URL("summary.json", observation), JSON.stringify({ tier: "virtual-authenticator", browserVersion: browser!.version(),
      observedAt: new Date().toISOString(), testCase: "committed response recovery", databaseMajor,
      serverProcesses: 2, connectionsPerReplica: 1, candidateRace: true, ownershipProofsVerified: true,
      responseLostAfterCommit: true, lostResponseCount: lostReplies, originalReceiptRecovered: true, verifiedCredentials: 1, walletDeployed: false,
      sessionCreated: false, physicalDeviceObserved: false }, null, 2), { mode: 0o600 });
  }, 30_000);

  it("leaves enrollment pending after a genuine UV-off assertion and accepts a later verified assertion", async () => {
    const record = await register(), backupSignature = await signBackupProof(walletEnrollmentDocument(record));
    await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: false });
    try {
      const unverified = await assertion(record, "discouraged");
      expect(Buffer.from(unverified.authenticatorData, "base64url")[32]! & 4).toBe(0);
      const rejected = await browserRequest("/replica/0/finalize", { id: record.intent.id, proof: { assertion: unverified, backupSignature } });
      expect(rejected.status).toBe(403); expect(rejected.body.code).toBe("WALLET_ENROLLMENT_PROOF_INVALID");
      expect((await browserRequest("/replica/1/get", { id: record.intent.id })).body.state).toBe("awaiting_possession");
      expect((await pool!.query("SELECT count(*)::int AS count FROM rest_wallet_credentials")).rows[0].count).toBe(0);
    } finally { await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: true }); }
    const accepted = await browserRequest("/replica/1/finalize", { id: record.intent.id,
      proof: { assertion: await assertion(record), backupSignature } });
    expect(accepted.status).toBe(200); expect(accepted.body.replayed).toBe(false);
    expect(accepted.body.record.state).toBe("verified"); expect(pageErrors).toEqual([]);
  }, 30_000);

  it("requires a separate browser assertion for deployment of the same verified wallet", async () => {
    const candidate = await register(), registration = await assertion(candidate);
    const completed = await browserRequest("/replica/0/finalize", { id: candidate.intent.id, proof: {
      assertion: registration, backupSignature: await signBackupProof(walletEnrollmentDocument(candidate)),
    } });
    expect(completed.status).toBe(200);
    const record = completed.body.record as WalletEnrollment, issuedAt = Date.now();
    const approval = prepareWalletDeploymentApproval(record, { issuedAt, expiresAt: issuedAt + 120_000 });
    const decode = (wire: typeof registration) => ({ ...wire,
      authenticatorData: Buffer.from(wire.authenticatorData, "base64url"), clientDataJSON: Buffer.from(wire.clientDataJSON, "base64url"),
      signature: Buffer.from(wire.signature, "base64url") });
    expect(approval.ceremony.challenge).not.toBe(record.possession!.ceremony.challenge);
    expect(() => verifyWalletDeploymentProof(record, approval, decode(registration), Date.now())).toThrow();
    const fresh = await assertion(record, "required", approval.ceremony.challenge);
    expect(fresh.credentialId).toBe(registration.credentialId); expect(fresh.userHandle).toBe(registration.userHandle);
    expect(verifyWalletDeploymentProof(record, approval, decode(fresh), Date.now()).verificationDigest).toMatch(/^[0-9a-f]{64}$/);
    // The pure deployment proof does not mutate identity, allocate a nonce, or authorize a session.
    expect((await browserRequest("/replica/1/get", { id: record.intent.id })).body).toEqual(record);
    const crossPurposeReplay = await browserRequest("/replica/1/finalize", { id: record.intent.id, proof: {
      assertion: fresh, backupSignature: await signBackupProof(walletEnrollmentDocument(record)),
    } });
    expect(crossPurposeReplay.status).toBe(403);
    expect((await pool!.query("SELECT count(*)::int AS count FROM rest_wallet_credentials")).rows[0].count).toBe(1);
    expect(pageErrors).toEqual([]);
  }, 30_000);
});
