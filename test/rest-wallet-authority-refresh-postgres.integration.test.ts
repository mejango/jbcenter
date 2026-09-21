import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashTypedData } from "viem";
import { createWalletEnrollmentIntent, walletEnrollmentDocument } from "../src/rest/wallet/enrollment.js";
import { PostgresWalletEnrollmentStore } from "../src/rest/wallet/enrollmentPostgres.js";
import { PostgresWalletAuthorityRefreshQueue, type WalletAuthorityRefreshQueueOptions } from "../src/rest/wallet/authorityRefreshPostgres.js";
import { createRegistration, enrollmentBackupAccount, enrollmentManifest, signBackupProof, signGet } from "./fixtures/wallet-enrollment-crypto.js";
import { trustedWalletAuthorityFixture } from "./fixtures/wallet-authority-readiness.js";

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const schema = `rest_wallet_authority_refresh_${randomUUID().replaceAll("-", "")}`;
const children = new Set<ChildProcess>();
let admin: Pool, pool: Pool, enrollments: PostgresWalletEnrollmentStore;
type Lease = NonNullable<Awaited<ReturnType<PostgresWalletAuthorityRefreshQueue["claim"]>>>;
const options: WalletAuthorityRefreshQueueOptions = { maxTracked: 8, maxConcurrent: 2, maxStartsPerMinute: 30,
  interestMs: 5000, leaseMs: 2000, refreshLeadMs: 100, verifiedMinRetryMs: 80, backoffBaseMs: 120, backoffMaxMs: 240 };

async function databaseNow(): Promise<number> {
  return Number((await pool.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now")).rows[0].now);
}
async function untilDatabaseTime(deadline: number) {
  await pool.query("SELECT pg_sleep(GREATEST(0,($1-extract(epoch FROM clock_timestamp())*1000)/1000)+0.02)", [deadline]);
}
async function waitForLock(waiter: number, blocker: number | readonly number[], table: string) {
  const blockers = typeof blocker === "number" ? [blocker] : blocker;
  const deadline = Date.now() + 3000;
  do {
    const row = (await pool.query("SELECT wait_event_type,query,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1", [waiter])).rows[0];
    if (row?.wait_event_type === "Lock" && row.query.includes(table) && row.blockers.some((pid: number) => blockers.includes(pid))) return;
    await pool.query("SELECT pg_sleep(0.01)");
  } while (Date.now() < deadline);
  throw new Error(`Refresh child did not reach a real ${table} lock wait`);
}
async function job(accountId: string) {
  return (await pool.query(`SELECT account_id,interested_until_ms::text,due_at_ms::text,lease_token,lease_until_ms::text,failures
    FROM rest_wallet_authority_refresh_jobs WHERE account_id=$1`, [accountId])).rows[0];
}
async function eligibleAccount() {
  const now = await databaseNow();
  const initial = await enrollments.begin(createWalletEnrollmentIntent({ manifest: enrollmentManifest,
    rpId: "wallet.juicebox.center", origin: "https://wallet.juicebox.center", recoveryOwner: enrollmentBackupAccount.address,
    expiresAt: now + 120000 }));
  const credential = createRegistration({ challenge: `0x${Buffer.from(initial.intent.registration.challenge, "base64url").toString("hex")}`,
    rpId: initial.intent.rpId, origin: initial.intent.origin, userHandle: initial.intent.userHandle });
  const pending = await enrollments.acceptRegistration(initial.intent.id, credential.response);
  const document = walletEnrollmentDocument(pending);
  const { record } = await enrollments.finalize(initial.intent.id, { assertion: signGet({ ...credential,
    challenge: hashTypedData(document), rpId: initial.intent.rpId, origin: initial.intent.origin }),
    backupSignature: await signBackupProof(document) });
  const accountId = record.receipt!.accountId, seconds = Math.floor(now / 1000);
  // Genuine enrollment and possession; explicitly synthetic setup-binding metadata for queue
  // eligibility only. This fixture establishes no setup consent, canonical readiness or authority.
  const binding = trustedWalletAuthorityFixture(accountId, now).binding;
  await pool.query(`INSERT INTO rest_accounts(id,owner_address,authority_chain_id,display_name,bio,avatar_uri,created_at,updated_at)
    VALUES($1,$2,8453,'','',NULL,$3,$3)`, [accountId, accountId.slice("eip155:8453:".length), seconds]);
  await pool.query(`INSERT INTO rest_smart_account_bindings(account_id,id,chain_id,wallet_address,authorization_digest,created_at,updated_at,document)
    VALUES($1,$2,8453,$3,$4,$5,$5,$6::jsonb)`, [accountId, binding.id, binding.wallet.address,
    binding.authorization.digest, seconds, JSON.stringify(binding)]);
  return accountId;
}
function message(child: ChildProcess, kind: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Refresh child did not emit ${kind}`)), 10000);
    const received = (value: any) => { if (value?.kind === kind) finish(undefined, value); };
    const exited = () => finish(new Error(`Refresh child exited before ${kind}`));
    function finish(error?: Error, value?: unknown) {
      clearTimeout(timer); child.off("message", received); child.off("exit", exited);
      if (error) reject(error); else resolve(value);
    }
    child.on("message", received); child.on("exit", exited);
  });
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) { children.delete(child); return; }
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  child.kill("SIGKILL"); await exited; children.delete(child);
}
async function worker(configuration: WalletAuthorityRefreshQueueOptions = options) {
  const child = fork(fileURLToPath(new URL("./fixtures/wallet-authority-refresh-process.ts", import.meta.url)), [], {
    execArgv: ["--import", "tsx"], env: { ...process.env, WALLET_AUTHORITY_REFRESH_TEST_SCHEMA: schema },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  children.add(child); child.stderr?.on("data", () => {});
  const ready = await message(child, "ready");
  return { child, backendPid: Number(ready.backendPid), request: async (body: Record<string, unknown>) => {
    const response = await fetch(`http://127.0.0.1:${ready.port}`, { method: "POST", body: JSON.stringify({ ...body, options: configuration }),
      headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10000) });
    return { status: response.status, body: await response.json() as any };
  } };
}
function queue(configuration: WalletAuthorityRefreshQueueOptions = options) {
  return new PostgresWalletAuthorityRefreshQueue(pool, configuration);
}

suite("PostgreSQL bounded wallet authority refresh scheduling", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 4 });
    for (const name of ["004_rest_accounts.sql", "007_rest_smart_accounts.sql", "012_rest_smart_account_onboarding.sql",
      "013_rest_wallet_ceremonies.sql", "014_rest_passkey_onboarding.sql", "042_wallet_binding_consent.sql", "015_rest_wallet_enrollment.sql", "046_wallet_signup_window.sql", "041_wallet_passkey_name.sql", "043_wallet_networks.sql", "044_wallet_devices.sql",
      "017_rest_wallet_policy.sql", "051_wallet_policy_app_grant_lifetime.sql", "019_rest_wallet_app_grants.sql", "052_wallet_app_grant_lifetime_90d.sql", "020_rest_wallet_authority.sql", "039_wallet_authority_window.sql", "049_wallet_authority_window_15m.sql", "023_wallet_authority_refresh.sql", "040_wallet_authority_refresh_settings.sql", "050_wallet_authority_refresh_interest_day.sql"])
      await pool.query(await readFile(new URL(`../src/db/migrations/${name}`, import.meta.url), "utf8"));
    enrollments = new PostgresWalletEnrollmentStore(pool);
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE rest_wallet_authority_refresh_jobs,rest_wallet_app_grants,rest_wallet_authority,
      rest_grant_ids,rest_bot_grants,rest_request_nonces,rest_smart_account_binding_nonces,rest_smart_account_bindings,
      rest_accounts,rest_wallet_credentials,rest_wallet_enrollments,rest_wallet_ceremonies CASCADE`);
    await pool.query("UPDATE rest_wallet_authority_refresh_control SET configuration=NULL,window_start_ms=0,starts_in_window=0");
  });
  afterEach(async () => { await Promise.all([...children].map(kill)); });
  afterAll(async () => {
    await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  it("replaces a configuration pinned by an earlier revision, and refuses one that differs at its own", async () => {
    const accountId = await eligibleAccount(), store = queue();
    const pinned = async () => (await pool.query("SELECT configuration FROM rest_wallet_authority_refresh_control WHERE id=1")).rows[0]!.configuration;
    // An earlier release's copy (no revision, the old interest) gives way during a rollover.
    await pool.query("UPDATE rest_wallet_authority_refresh_control SET configuration=$1::jsonb WHERE id=1",
      [JSON.stringify({ ...options, interestMs: 120_000, revision: undefined })]);
    expect((await store.request(accountId)).status).toBe("queued");
    expect(await pinned()).toMatchObject({ ...options, revision: 2 });
    // The old replica, still ticking, now refuses; so does any replica that differs at the same revision.
    await expect(queue({ ...options, interestMs: 120_000 }).request(accountId)).rejects.toMatchObject({ code: "WALLET_AUTHORITY_REFRESH_CONFIG_CONFLICT" });
    await pool.query(await readFile(new URL("../src/db/migrations/050_wallet_authority_refresh_interest_day.sql", import.meta.url), "utf8"));
    expect(await pinned()).toBeNull();
    expect((await store.request(accountId)).status).toBe("coalesced");
    expect(await pinned()).toMatchObject(options);
  });
  it("coalesces concurrent demand without authority initialization or queue-order changes", async () => {
    const accountId = await eligibleAccount(), store = queue();
    const results = await Promise.all(Array.from({ length: 12 }, () => store.request(accountId)));
    expect(results.filter(result => result.status === "queued")).toHaveLength(1);
    expect(results.filter(result => result.status === "coalesced")).toHaveLength(11);
    const original = await job(accountId);
    expect(original.lease_token).toBeNull();
    expect(await store.request(accountId)).toEqual({ status: "coalesced", retryAtMs: Number(original.due_at_ms) });
    expect((await job(accountId)).due_at_ms).toBe(original.due_at_ms);
    expect(await store.stats()).toMatchObject({ tracked: 1, interested: 1, due: 1, inFlight: 0,
      oldestDueAtMs: Number(original.due_at_ms), startsInWindow: 0, maxStartsPerMinute: 30 });
    expect((await pool.query(`SELECT (SELECT count(*)::int FROM rest_wallet_authority) AS authority,
      (SELECT count(*)::int FROM rest_bot_grants) AS bots,(SELECT count(*)::int FROM rest_wallet_app_grants) AS apps`)).rows[0])
      .toEqual({ authority: 0, bots: 0, apps: 0 });
  });

  it("rejects ineligible demand and never revives a revoked binding or missing credential", async () => {
    const store = queue(), accountId = await eligibleAccount();
    await expect(store.request("eip155:1:0x0000000000000000000000000000000000000001"))
      .rejects.toMatchObject({ status: 400, code: "WALLET_AUTHORITY_REFRESH_INVALID" });
    await expect(store.request("eip155:8453:0x0000000000000000000000000000000000000002"))
      .rejects.toMatchObject({ status: 403, code: "WALLET_AUTHORITY_REFRESH_INELIGIBLE" });
    await pool.query("UPDATE rest_smart_account_bindings SET revoked_at=updated_at WHERE account_id=$1", [accountId]);
    await expect(store.request(accountId)).rejects.toMatchObject({ status: 403, code: "WALLET_AUTHORITY_REFRESH_INELIGIBLE" });
    const missingCredential = await eligibleAccount();
    await pool.query("UPDATE rest_wallet_credentials SET superseded_at=verified_at WHERE account_id=$1", [missingCredential]);
    await expect(store.request(missingCredential)).rejects.toMatchObject({ status: 403, code: "WALLET_AUTHORITY_REFRESH_INELIGIBLE" });
    expect(await store.stats()).toMatchObject({ tracked: 0, interested: 0, due: 0, inFlight: 0, startsInWindow: 0 });
    expect((await pool.query("SELECT revoked_at FROM rest_smart_account_bindings WHERE account_id=$1", [accountId])).rows[0].revoked_at).not.toBeNull();
    const revokedWhileQueued = await eligibleAccount(); await store.request(revokedWhileQueued);
    await pool.query("UPDATE rest_smart_account_bindings SET revoked_at=updated_at WHERE account_id=$1", [revokedWhileQueued]);
    expect(await store.claim()).toBeNull();
    expect(await job(revokedWhileQueued)).toBeUndefined();
    expect(await store.stats()).toMatchObject({ tracked: 0, startsInWindow: 0 });
  });

  it("admits one lease across two actual HTTP processes and releases their single connections", async () => {
    const accountId = await eligibleAccount(); await queue().request(accountId);
    const [a, b] = await Promise.all([worker(), worker()]);
    expect(a.backendPid).not.toBe(b.backendPid);
    expect(a.child.pid).not.toBe(b.child.pid);
    const holder = await pool.connect();
    let results: Awaited<ReturnType<typeof a.request>>[];
    try {
      await holder.query("BEGIN");
      const blocker = Number((await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      await holder.query("SELECT id FROM rest_wallet_authority_refresh_control WHERE id=1 FOR UPDATE");
      const claims = Promise.all([a.request({ action: "claim" }), b.request({ action: "claim" })]);
      // PostgreSQL may queue the second waiter behind the first waiter's tuple lock.
      await Promise.all([waitForLock(a.backendPid, [blocker, b.backendPid], "rest_wallet_authority_refresh_control"),
        waitForLock(b.backendPid, [blocker, a.backendPid], "rest_wallet_authority_refresh_control")]);
      await holder.query("COMMIT"); results = await claims;
    } finally { await holder.query("ROLLBACK"); holder.release(); }
    expect(results.map(result => result.status)).toEqual([200, 200]);
    const leases = results.map(result => result.body).filter(Boolean) as Lease[];
    expect(leases).toHaveLength(1); expect(leases[0]).toMatchObject({ accountId });
    expect(leases[0]!.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(leases[0]!.untilMs).toBeGreaterThan(await databaseNow());
    const observations = await Promise.all([a.request({ action: "stats" }), b.request({ action: "stats" })]);
    for (const observed of observations) expect(observed).toMatchObject({ status: 200, body: { inFlight: 1, startsInWindow: 1 } });
    expect(await a.request({ action: "complete", lease: leases[0], result: { outcome: "verified", readyUntilMs: await databaseNow() + 1000 } }))
      .toEqual({ status: 200, body: true });
    expect(await b.request({ action: "complete", lease: leases[0], result: { outcome: "failed", readyUntilMs: null } }))
      .toEqual({ status: 200, body: false });
  });

  it("enforces one shared concurrency cap across accounts and replicas", async () => {
    const store = queue(), ids = await Promise.all([eligibleAccount(), eligibleAccount(), eligibleAccount()]);
    for (const id of ids) await store.request(id);
    const [a, b] = await Promise.all([worker(), worker()]);
    const results = await Promise.all([a.request({ action: "claim" }), b.request({ action: "claim" }), a.request({ action: "claim" })]);
    expect(results.map(result => result.status)).toEqual([200, 200, 200]);
    const leases = results.map(result => result.body).filter(Boolean) as Lease[];
    expect(leases).toHaveLength(2); expect(new Set(leases.map(lease => lease.accountId)).size).toBe(2);
    expect(await store.stats()).toMatchObject({ tracked: 3, inFlight: 2, startsInWindow: 2 });
    expect(await store.claim()).toBeNull();
    expect(await store.complete(leases[0]!, { outcome: "verified", readyUntilMs: await databaseNow() + 1000 })).toBe(true);
    const next = await store.claim();
    expect(next?.accountId).toBe(ids.find(id => !leases.some(lease => lease.accountId === id)));
    expect(await store.stats()).toMatchObject({ inFlight: 2, startsInWindow: 3 });
  });

  it("bounds tracked demand: the account idle longest gives its slot, a leased one never does", async () => {
    const configuration = { ...options, maxTracked: 2 }, store = queue(configuration);
    const [first, second, excess] = await Promise.all([eligibleAccount(), eligibleAccount(), eligibleAccount()]);
    const [a, b] = await Promise.all([worker(configuration), worker(configuration)]);
    await store.request(first!); const lease = await store.claim();
    expect(lease).not.toBeNull();
    const before = await job(first!);
    const results = await Promise.all([a.request({ action: "request", accountId: second }), b.request({ action: "request", accountId: excess })]);
    expect(results.map(result => result.status)).toEqual([200, 200]);
    // Both are admitted: the later one takes the slot of the earlier, which is not in flight.
    expect(results.map(result => result.body.status)).toEqual(["queued", "queued"]);
    const kept = [await job(second!), await job(excess!)].filter(Boolean);
    expect(kept).toHaveLength(1);
    expect((await store.request(first!)).status).toBe("coalesced");
    expect((await job(first!)).lease_token).toBe(before.lease_token);
    expect(await store.stats()).toMatchObject({ tracked: 2, interested: 2, inFlight: 1, startsInWindow: 1 });
    // Once nothing is in flight, the account whose interest ends first is the one to give way.
    expect(await store.complete(lease!, { outcome: "verified", readyUntilMs: await databaseNow() + 1000 })).toBe(true);
    const survivor = kept[0]!.account_id;
    await untilDatabaseTime(await databaseNow() + 5); await store.request(survivor);
    expect((await store.request(await eligibleAccount())).status).toBe("queued");
    expect(await job(first!)).toBeUndefined();
    expect(await job(survivor)).toBeDefined();
  });

  it("preserves the global start budget through idle cleanup and process replacement", async () => {
    const configuration = { ...options, maxTracked: 2, maxConcurrent: 2, maxStartsPerMinute: 1, interestMs: 500 };
    const store = queue(configuration), ids = await Promise.all([eligibleAccount(), eligibleAccount(), eligibleAccount()]);
    const [a, b] = await Promise.all([worker(configuration), worker(configuration)]);
    for (const id of ids.slice(0, 2)) expect((await a.request({ action: "request", accountId: id })).body.status).toBe("queued");
    const results = await Promise.all([a.request({ action: "claim" }), b.request({ action: "claim" })]);
    expect(results.map(result => result.status)).toEqual([200, 200]);
    const leases = results.map(result => result.body).filter(Boolean) as Lease[];
    expect(leases).toHaveLength(1);
    expect(await store.stats()).toMatchObject({ tracked: 2, due: 1, inFlight: 1, startsInWindow: 1, maxStartsPerMinute: 1 });
    expect(await a.request({ action: "complete", lease: leases[0],
      result: { outcome: "verified", readyUntilMs: await databaseNow() + 1000 } })).toEqual({ status: 200, body: true });
    const interestDeadlines = await Promise.all(ids.slice(0, 2).map(async id => Number((await job(id!)).interested_until_ms)));
    await untilDatabaseTime(Math.max(...interestDeadlines));
    expect(await store.claim()).toBeNull();
    expect(await store.stats()).toMatchObject({ tracked: 0, interested: 0, inFlight: 0, startsInWindow: 1 });
    await Promise.all([kill(a.child), kill(b.child)]); const replacement = await worker(configuration);
    expect((await replacement.request({ action: "request", accountId: ids[2] })).body.status).toBe("queued");
    expect(await replacement.request({ action: "claim" })).toEqual({ status: 200, body: null });
    expect(await store.stats()).toMatchObject({ tracked: 1, due: 1, inFlight: 0, startsInWindow: 1, maxStartsPerMinute: 1 });
    // Advance only the test coordinator window; no sixty-second wall-clock sleep is needed.
    await pool.query("UPDATE rest_wallet_authority_refresh_control SET window_start_ms=window_start_ms-60001");
    expect((await replacement.request({ action: "claim" })).body).toMatchObject({ accountId: ids[2] });
    expect(await store.stats()).toMatchObject({ inFlight: 1, startsInWindow: 1 });
  });

  it("reclaims a crashed process only after database lease expiry and fences its stale completion", async () => {
    const configuration = { ...options, leaseMs: 4000 }, store = queue(configuration), accountId = await eligibleAccount();
    await store.request(accountId); const [a, b] = await Promise.all([worker(configuration), worker(configuration)]);
    const barrier = message(a.child, "barrier");
    const disconnected = a.request({ action: "claim", barrier: "after-claim" }).catch(() => null);
    const held = await barrier; expect(held.lease).toMatchObject({ accountId });
    // Even with its HTTP reply paused, the claiming process has released its sole DB connection.
    expect(await a.request({ action: "stats" })).toMatchObject({ status: 200, body: { inFlight: 1 } });
    await kill(a.child); expect(await disconnected).toBeNull();
    expect(await b.request({ action: "claim" })).toEqual({ status: 200, body: null });
    await untilDatabaseTime(held.lease.untilMs);
    const reclaimed = (await b.request({ action: "claim" })).body as Lease;
    expect(reclaimed).toMatchObject({ accountId }); expect(reclaimed.token).not.toBe(held.lease.token);
    const before = await job(accountId);
    expect(await store.complete(held.lease, { outcome: "verified", readyUntilMs: await databaseNow() + 1000 })).toBe(false);
    expect(await store.complete({ ...reclaimed, token: randomUUID() }, { outcome: "failed", readyUntilMs: null })).toBe(false);
    expect(await job(accountId)).toEqual(before);
    expect(await store.complete(reclaimed, { outcome: "verified", readyUntilMs: await databaseNow() + 1000 })).toBe(true);
  });

  it("rejects completion whose actual row-lock wait crosses database lease expiry without changing authority", async () => {
    const configuration = { ...options, leaseMs: 1500 }, store = queue(configuration), accountId = await eligibleAccount();
    const child = await worker(configuration);
    await store.request(accountId); const lease = await store.claim(); expect(lease).not.toBeNull();
    const before = await job(accountId), holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      const blocker = Number((await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      await holder.query("SELECT account_id FROM rest_wallet_authority_refresh_jobs WHERE account_id=$1 FOR UPDATE", [accountId]);
      const completing = child.request({ action: "complete", lease,
        result: { outcome: "verified", readyUntilMs: await databaseNow() + 3000 } });
      await waitForLock(child.backendPid, blocker, "rest_wallet_authority_refresh_jobs");
      await untilDatabaseTime(lease!.untilMs); await holder.query("COMMIT");
      expect(await completing).toEqual({ status: 200, body: false });
    } finally { await holder.query("ROLLBACK"); holder.release(); }
    expect(await job(accountId)).toEqual(before);
    expect(await store.complete(lease!, { outcome: "failed", readyUntilMs: null })).toBe(false);
    expect((await pool.query("SELECT count(*)::int AS count FROM rest_wallet_authority")).rows[0].count).toBe(0);
  });

  it("anchors refresh to the original readiness deadline and bounds retries of expired receipts", async () => {
    const store = queue(), accountId = await eligibleAccount(); await store.request(accountId);
    const lease = await store.claim(), readyUntilMs = await databaseNow() + 2500;
    expect(await store.complete(lease!, { outcome: "verified", readyUntilMs })).toBe(true);
    const due = readyUntilMs - options.refreshLeadMs!;
    expect(Number((await job(accountId)).due_at_ms)).toBe(due);
    expect(await store.request(accountId)).toEqual({ status: "coalesced", retryAtMs: due });
    expect(await store.claim()).toBeNull();
    await untilDatabaseTime(due); const next = await store.claim(); expect(next).not.toBeNull();
    const before = await databaseNow();
    expect(await store.complete(next!, { outcome: "verified", readyUntilMs: before - 1 })).toBe(true);
    expect(Number((await job(accountId)).due_at_ms)).toBeGreaterThanOrEqual(before + options.verifiedMinRetryMs!);
    expect(await store.claim()).toBeNull();
  });

  it("ends its own interest at the failure cap, and the customer's next request renews it", async () => {
    const store = queue(), accountId = await eligibleAccount();
    await store.request(accountId);
    await pool.query("UPDATE rest_wallet_authority_refresh_jobs SET failures=15 WHERE account_id=$1", [accountId]);
    const lease = await store.claim(); expect(lease?.accountId).toBe(accountId);
    expect(await store.complete(lease!, { outcome: "failed", readyUntilMs: null })).toBe(true);
    // Its interest over, the job leaves with the completion's own cleanup; nothing observes it again.
    expect(await job(accountId)).toBeUndefined();
    expect(await store.stats()).toMatchObject({ tracked: 0, interested: 0, due: 0 });
    expect((await store.request(accountId)).status).toBe("queued");
    expect((await job(accountId)).failures).toBe(0);
  });
  it("preserves oldest-due fairness and capped failure backoff under repeated hot-account demand", async () => {
    const store = queue(), first = await eligibleAccount(), second = await eligibleAccount();
    await store.request(first); await untilDatabaseTime(await databaseNow() + 5); await store.request(second);
    const firstLease = await store.claim(); expect(firstLease?.accountId).toBe(first);
    const beforeFailure = await databaseNow();
    expect(await store.complete(firstLease!, { outcome: "failed", readyUntilMs: null })).toBe(true);
    const backedOff = await job(first);
    expect(Number(backedOff.due_at_ms)).toBeGreaterThanOrEqual(beforeFailure + options.backoffBaseMs!);
    await Promise.all(Array.from({ length: 10 }, () => store.request(first)));
    expect((await job(first)).due_at_ms).toBe(backedOff.due_at_ms);
    const secondLease = await store.claim(); expect(secondLease?.accountId).toBe(second);
    expect(await store.complete(secondLease!, { outcome: "verified", readyUntilMs: await databaseNow() + 3000 })).toBe(true);
    for (const outcome of ["unready", "conflict", "failed"] as const) {
      await untilDatabaseTime(Number((await job(first)).due_at_ms));
      const lease = await store.claim(); expect(lease?.accountId).toBe(first);
      const before = await databaseNow();
      expect(await store.complete(lease!, { outcome, readyUntilMs: null })).toBe(true);
      const after = await databaseNow(), retry = Number((await job(first)).due_at_ms);
      expect(retry).toBeGreaterThanOrEqual(before + options.backoffBaseMs!);
      expect(retry).toBeLessThanOrEqual(after + options.backoffMaxMs!);
    }
    // A history catching up in stages is progress: retried at the base delay, the failure count reset.
    await untilDatabaseTime(Number((await job(first)).due_at_ms));
    const staged = await store.claim(); expect(staged?.accountId).toBe(first);
    const beforeProgress = await databaseNow();
    expect(await store.complete(staged!, { outcome: "progress", readyUntilMs: null })).toBe(true);
    expect((await job(first)).failures).toBe(0);
    expect(Number((await job(first)).due_at_ms)).toBeLessThanOrEqual(await databaseNow() + options.backoffBaseMs!);
    expect(Number((await job(first)).due_at_ms)).toBeGreaterThanOrEqual(beforeProgress);
    await untilDatabaseTime(Number((await job(first)).due_at_ms));
    const recovered = await store.claim();
    expect(await store.complete(recovered!, { outcome: "verified", readyUntilMs: await databaseNow() + 1000 })).toBe(true);
    expect((await job(first)).failures).toBe(0);
  });

  it("removes idle jobs while retaining unexpired leases and their capacity until expiry", async () => {
    const configuration = { ...options, maxTracked: 1, interestMs: 150, leaseMs: 4000 };
    const store = queue(configuration), first = await eligibleAccount(), second = await eligibleAccount();
    await store.request(first); const lease = await store.claim(); expect(lease).not.toBeNull();
    await untilDatabaseTime(Number((await job(first)).interested_until_ms));
    expect(await store.claim()).toBeNull();
    expect((await store.request(second)).status).toBe("overloaded");
    expect(await store.stats()).toMatchObject({ tracked: 1, interested: 0, inFlight: 1, startsInWindow: 1 });
    await untilDatabaseTime(lease!.untilMs);
    expect((await store.request(second)).status).toBe("queued");
    expect(await job(first)).toBeUndefined();
    expect(await store.stats()).toMatchObject({ tracked: 1, interested: 1, inFlight: 0, startsInWindow: 1 });
    expect(await store.complete(lease!, { outcome: "verified", readyUntilMs: await databaseNow() + 1000 })).toBe(false);
  });

  it("rejects a replica with larger persisted limits without changing jobs or the start budget", async () => {
    const configuration = { ...options, maxTracked: 1, maxConcurrent: 1, maxStartsPerMinute: 1 };
    const store = queue(configuration), accountId = await eligibleAccount(); await store.request(accountId);
    const before = await job(accountId);
    const control = (await pool.query("SELECT * FROM rest_wallet_authority_refresh_control")).rows[0];
    const different = await worker({ ...configuration, maxTracked: 2, maxConcurrent: 2, maxStartsPerMinute: 2 });
    for (const action of ["request", "claim", "stats"]) {
      expect(await different.request({ action, accountId }))
        .toEqual({ status: 409, body: { code: "WALLET_AUTHORITY_REFRESH_CONFIG_CONFLICT" } });
    }
    expect(await job(accountId)).toEqual(before);
    expect((await pool.query("SELECT * FROM rest_wallet_authority_refresh_control")).rows[0]).toEqual(control);
    expect(await store.stats()).toMatchObject({ tracked: 1, inFlight: 0, startsInWindow: 0, maxStartsPerMinute: 1 });
  });

  it("starts fresh interest after an actual account-lock wait during queue admission", async () => {
    const configuration = { ...options, interestMs: 3000 }, store = queue(configuration), accountId = await eligibleAccount();
    const child = await worker(configuration), holder = await pool.connect();
    let released = 0;
    try {
      await holder.query("BEGIN");
      const blocker = Number((await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      await holder.query("SELECT id FROM rest_accounts WHERE id=$1 FOR UPDATE", [accountId]);
      const admitting = child.request({ action: "request", accountId });
      await waitForLock(child.backendPid, blocker, "INSERT INTO rest_wallet_authority_refresh_jobs");
      await untilDatabaseTime(await databaseNow() + configuration.interestMs + 20);
      released = await databaseNow(); await holder.query("COMMIT");
      expect(await admitting).toMatchObject({ status: 200, body: { status: "queued" } });
    } finally { await holder.query("ROLLBACK"); holder.release(); }
    // Interest measured from the lock release, not from the admission's first database sample.
    expect(Number((await job(accountId)).interested_until_ms)).toBeGreaterThanOrEqual(released + configuration.interestMs);
    expect((await store.claim())?.accountId).toBe(accountId);
  });
});
