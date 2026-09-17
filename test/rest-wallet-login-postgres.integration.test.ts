import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresWalletLoginStore } from "../src/rest/wallet/loginPostgres.js";
import { PostgresWalletPolicyStore } from "../src/rest/wallet/policyPostgres.js";
import { PostgresWalletAppGrantStore, assertWalletAppGrantActiveInTransaction } from "../src/rest/wallet/appGrantsPostgres.js";
import { walletAppPrincipalId } from "../src/rest/wallet/appGrants.js";
import { createWalletLoginDraft, type WalletLoginChallenge, type WalletLoginCompletion } from "../src/rest/wallet/login.js";
import { signGet } from "./fixtures/wallet-enrollment-crypto.js";
import { createWalletLoginSetup, completeWalletLoginFixture, walletLoginTestMigrations,
  walletLoginFixtureOrigin as audience, walletLoginFixtureRpId as rpId } from "./fixtures/wallet-login-setup.js";
import { addWalletLoginDevice } from "./fixtures/wallet-login-setup.js";

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const schema = `rest_wallet_login_${randomUUID().replaceAll("-", "")}`;
let admin: Pool, pool: Pool, store: PostgresWalletLoginStore;
const children = new Set<ChildProcess>();
async function databaseNow(): Promise<number> {
  return Number((await pool.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now")).rows[0].now);
}
const initialized = (lifetimeMs = 30_000) => createWalletLoginSetup(pool, { lifetimeMs });
function proof(value: Awaited<ReturnType<typeof initialized>>, begun: { login: WalletLoginChallenge; flowToken: string }): WalletLoginCompletion {
  return { loginId: begun.login.id, flowToken: begun.flowToken, assertion: signGet({ ...value.credential,
    challenge: begun.login.challenge, rpId, origin: audience }) };
}
function wire(input: WalletLoginCompletion) {
  return { ...input, assertion: { ...input.assertion,
    authenticatorData: Buffer.from(input.assertion.authenticatorData).toString("base64url"),
    clientDataJSON: Buffer.from(input.assertion.clientDataJSON).toString("base64url"),
    signature: Buffer.from(input.assertion.signature).toString("base64url") } };
}
function message(child: ChildProcess, kind: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Login child did not emit ${kind}`)), 10000);
    const received = (value: any) => { if (value?.kind === kind) finish(undefined, value); };
    const exited = () => finish(new Error(`Login child exited before ${kind}`));
    function finish(error?: Error, value?: unknown) {
      clearTimeout(timer); child.off("message", received); child.off("exit", exited);
      if (error) reject(error); else resolve(value);
    }
    child.on("message", received); child.on("exit", exited);
  });
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) { children.delete(child); return; }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Login fixture did not terminate")), 5000);
    const exited = () => finish(), failed = () => finish(new Error("Login fixture termination failed"));
    function finish(error?: Error) {
      clearTimeout(timer); child.off("exit", exited); child.off("error", failed);
      if (error) reject(error); else { children.delete(child); resolve(); }
    }
    child.once("exit", exited); child.once("error", failed); child.kill("SIGKILL");
  });
}
async function worker(options: { maxRecords?: number; maxAccountSessions?: number; loginLifetimeMs?: number } = {}, prefix = "") {
  const child = fork(fileURLToPath(new URL("./fixtures/wallet-login-process.ts", import.meta.url)), [], {
    execArgv: ["--import", "tsx"], env: { ...process.env, WALLET_LOGIN_TEST_SCHEMA: schema,
      WALLET_LOGIN_TEST_OPTIONS: JSON.stringify(options), WALLET_LOGIN_TEST_PREFIX_SCHEMA: prefix }, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  children.add(child); child.stderr?.on("data", () => {});
  const ready = await message(child, "ready");
  return { child, backendPid: Number(ready.backendPid), request: async (body: unknown): Promise<{ status: number; body: any }> => {
    const response = await fetch(`http://127.0.0.1:${ready.port}`, { method: "POST", body: JSON.stringify(body),
      headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15000) });
    return { status: response.status, body: await response.json() };
  } };
}
async function untilDatabaseTime(deadline: number) {
  await pool.query("SELECT pg_sleep(GREATEST(0,($1-extract(epoch FROM clock_timestamp())*1000)/1000)+0.03)", [deadline]);
}
async function waitForLock(waiter: number, blocker: number, table: string) {
  const deadline = Date.now() + 5000;
  do {
    const row = (await pool.query("SELECT wait_event_type,query,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1", [waiter])).rows[0];
    if (row?.wait_event_type === "Lock" && row.query.includes(table) && row.blockers.includes(blocker)) return;
    await pool.query("SELECT pg_sleep(0.01)");
  } while (Date.now() < deadline);
  throw new Error(`Login worker did not reach a real ${table} lock wait`);
}
async function completionCount() {
  return Number((await pool.query("SELECT count(*)::int AS count FROM rest_wallet_logins WHERE completed_at_ms IS NOT NULL")).rows[0].count);
}
async function storedCeremony(loginId: string) {
  return (await pool.query(`SELECT c.consumed_at,c.result_id,c.proof_digest FROM rest_wallet_logins l
    JOIN rest_wallet_ceremonies c ON c.id=l.ceremony_id WHERE l.id=$1`, [loginId])).rows[0];
}
async function reachedBarrier(barrier: Promise<unknown>, pending: Promise<{ status: number; body: any } | null>) {
  await Promise.race([barrier, pending.then(result => {
    throw new Error(`Login request ended before its write barrier: ${result?.status ?? "disconnected"}/${result?.body?.code ?? "no-code"}`);
  })]);
}

suite("PostgreSQL discoverable wallet login with genuine P256 and synthetic canonical readiness", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 6 });
    for (const name of walletLoginTestMigrations)
      await pool.query(await readFile(new URL(`../src/db/migrations/${name}`, import.meta.url), "utf8"));
    store = new PostgresWalletLoginStore(pool, { rpId, origin: audience });
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE rest_wallet_logins,rest_wallet_policy_apps,rest_wallet_policy,rest_wallet_app_grants,rest_wallet_authority,rest_grant_ids,rest_bot_grants,rest_request_nonces,
      rest_smart_account_binding_nonces,rest_smart_account_bindings,rest_accounts,
      rest_wallet_credentials,rest_wallet_enrollments,rest_wallet_ceremonies CASCADE`);
  });
  afterEach(async () => { await Promise.all([...children].map(kill)); });
  afterAll(async () => {
    await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  it("issues a discoverable challenge and a separate opaque flow token without authenticating an account", async () => {
    const begun = await store.begin();
    expect(begun.login).toMatchObject({ rpId, origin: audience });
    expect(begun.login.challenge).toMatch(/^0x[0-9a-f]{64}$/);
    expect(begun.flowToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(begun.login.expiresAtMs).toBeGreaterThan(await databaseNow());
    expect(begun.login.expiresAtMs).toBeLessThanOrEqual(await databaseNow() + 180_000);
  });

  it("completes genuine registered P256 possession once and returns the identical opaque session on retry", async () => {
    const value = await initialized(), begun = await store.begin(), input = proof(value, begun);
    const first = await store.complete(input), repeated = await store.complete(input);
    expect(first.replayed).toBe(false);
    expect(repeated).toEqual({ ...first, replayed: true });
    expect(first.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.sessionToken).not.toBe(begun.flowToken);
    expect(first.session).toMatchObject({ accountId: value.accountId, loginId: begun.login.id,
      credentialId: value.credential.credentialId, enrollmentId: value.record.intent.id, revokedAtMs: null });
    expect(await store.readSession(first.sessionToken)).toEqual(first.session);
    // The account page shows the name given to the passkey at enrollment; it is never editable.
    expect(await store.passkeyName(first.session)).toBe("Juicebox fixture");
    expect(await store.readSession(first.session.id)).toBeNull();
    expect(await storedCeremony(begun.login.id)).toMatchObject({ consumed_at: expect.any(String), result_id: first.session.id });
    const persisted = (await pool.query("SELECT to_jsonb(l)::text AS document FROM rest_wallet_logins l WHERE id=$1", [begun.login.id])).rows[0].document;
    expect(persisted).not.toContain(begun.flowToken); expect(persisted).not.toContain(first.sessionToken);
  });

  it("logs in with a device passkey, names it, and keeps the primary's session apart", async () => {
    const value = await initialized(), added = await addWalletLoginDevice(pool, value);
    const begun = await store.begin();
    const input: WalletLoginCompletion = { loginId: begun.login.id, flowToken: begun.flowToken,
      assertion: signGet({ ...added.device, challenge: begun.login.challenge, rpId, origin: audience }) };
    const completed = await store.complete(input);
    expect(completed.session).toMatchObject({ accountId: value.accountId, credentialId: added.device.credentialId, enrollmentId: value.record.intent.id });
    expect(await store.readSession(completed.sessionToken)).toEqual(completed.session);
    expect(await store.passkeyName(completed.session)).toBe("Fixture phone");
    // The primary still logs in to the same account with its own session.
    const again = await store.begin(), primary = await store.complete(proof(value, again));
    expect(primary.session.credentialId).toBe(value.credential.credentialId);
    expect(primary.session.accountId).toBe(completed.session.accountId);
    expect(primary.session.id).not.toBe(completed.session.id);
  });

  it("identifies only a proved current mapping for refresh without consuming the ceremony or issuing a session", async () => {
    const value = await initialized(), begun = await store.begin(), input = proof(value, begun);
    expect(await store.identifyCompletion(input)).toEqual({ accountId: value.accountId });
    expect(await store.identifyCompletion(input)).toEqual({ accountId: value.accountId });
    expect(await completionCount()).toBe(0);
    expect((await pool.query("SELECT c.consumed_at FROM rest_wallet_logins l JOIN rest_wallet_ceremonies c ON c.id=l.ceremony_id WHERE l.id=$1",
      [begun.login.id])).rows[0].consumed_at).toBeNull();
    expect((await store.complete(input)).replayed).toBe(false);
  });

  it("rejects wrong flow, handle, credential, challenge, origin and missing UV before consuming anything", async () => {
    const value = await initialized(), begun = await store.begin(), input = proof(value, begun);
    const missingUv = proof(value, begun);
    missingUv.assertion.authenticatorData = Buffer.from(missingUv.assertion.authenticatorData);
    missingUv.assertion.authenticatorData[32]! &= ~4;
    missingUv.assertion.signature = sign("sha256", Buffer.concat([Buffer.from(missingUv.assertion.authenticatorData),
      createHash("sha256").update(missingUv.assertion.clientDataJSON).digest()]), value.credential.key);
    const attempts = [
      { ...input, flowToken: Buffer.alloc(32, 1).toString("base64url") },
      { ...input, assertion: { ...input.assertion, userHandle: Buffer.alloc(32, 2).toString("base64url") } },
      { ...input, assertion: signGet({ ...value.credential, challenge: `0x${"01".repeat(32)}`, rpId, origin: audience }) },
      { ...input, assertion: signGet({ ...value.credential, challenge: begun.login.challenge, rpId, origin: "https://other.juicebox.center" }) },
      missingUv,
    ];
    for (const attempt of attempts) {
      await expect(store.identifyCompletion(attempt)).rejects.toMatchObject({ code: "WALLET_LOGIN_UNAUTHORIZED" });
      await expect(store.complete(attempt)).rejects.toMatchObject({ code: "WALLET_LOGIN_UNAUTHORIZED" });
    }
    // A passkey no account here knows (one left over from an unfinished signup) is named as such,
    // so the page can point at signing up instead of "try again"; nothing else is revealed.
    const unknown = { ...input, assertion: { ...input.assertion, credentialId: Buffer.alloc(32, 3).toString("base64url") } };
    await expect(store.identifyCompletion(unknown)).rejects.toMatchObject({ code: "WALLET_LOGIN_UNKNOWN_PASSKEY", status: 403 });
    await expect(store.complete(unknown)).rejects.toMatchObject({ code: "WALLET_LOGIN_UNKNOWN_PASSKEY", status: 403 });
    expect(await completionCount()).toBe(0);
    expect((await store.complete(input)).replayed).toBe(false);
  });

  it("does not treat a genuine registration response as a login assertion", async () => {
    const value = await initialized(), begun = await store.begin(), input = proof(value, begun);
    const data = JSON.parse(Buffer.from(input.assertion.clientDataJSON).toString());
    data.type = "webauthn.create"; input.assertion.clientDataJSON = Buffer.from(JSON.stringify(data));
    input.assertion.signature = sign("sha256", Buffer.concat([Buffer.from(input.assertion.authenticatorData),
      createHash("sha256").update(input.assertion.clientDataJSON).digest()]), value.credential.key);
    await expect(store.complete(input)).rejects.toMatchObject({ code: "WALLET_LOGIN_UNAUTHORIZED" });
    expect(await completionCount()).toBe(0);
  });

  it("returns one identical committed session across twenty requests in two actual one-connection processes", async () => {
    const value = await initialized(), begun = await store.begin(), input = wire(proof(value, begun));
    const [a, b] = await Promise.all([worker(), worker()]);
    expect(a.child.pid).not.toBe(b.child.pid); expect(a.backendPid).not.toBe(b.backendPid);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).request({ action: "complete", input })));
    expect(results.every(result => result.status === 200)).toBe(true);
    expect(results.filter(result => !result.body.replayed)).toHaveLength(1);
    expect(new Set(results.map(result => result.body.sessionToken)).size).toBe(1);
    expect(new Set(results.map(result => result.body.session.id)).size).toBe(1);
    expect(await completionCount()).toBe(1);
  });

  it("allows only one credential to claim a discoverable ceremony in competing processes", async () => {
    const [first, second] = await Promise.all([initialized(), initialized()]), begun = await store.begin();
    const [a, b] = await Promise.all([worker(), worker()]);
    const results = await Promise.all([a.request({ action: "complete", input: wire(proof(first, begun)) }),
      b.request({ action: "complete", input: wire(proof(second, begun)) })]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    expect(results.find(result => result.status === 409)?.body.code).toBe("WALLET_LOGIN_CONFLICT");
    expect(await completionCount()).toBe(1);
  });

  it.each(["after-login-write", "after-commit"])("recovers process death at %s without consuming twice or replacing the session token", async stage => {
    const value = await initialized(), begun = await store.begin(), input = proof(value, begun);
    const [a, b] = await Promise.all([worker(), worker()]), barrier = message(a.child, "barrier");
    const interrupted = a.request({ action: "complete", input: wire(input), barrier: stage }).catch(() => null);
    await reachedBarrier(barrier, interrupted); await kill(a.child); await interrupted;
    expect(await completionCount()).toBe(stage === "after-commit" ? 1 : 0);
    if (stage === "after-commit") expect((await storedCeremony(begun.login.id)).consumed_at).not.toBeNull();
    else expect((await storedCeremony(begun.login.id)).consumed_at).toBeNull();
    const recovered = await b.request({ action: "complete", input: wire(input) });
    expect(recovered.status).toBe(200);
    expect(recovered.body.replayed).toBe(stage === "after-commit");
    expect(await store.complete(input)).toEqual({ ...recovered.body, replayed: true });
    expect(await completionCount()).toBe(1);
  });

  it("rolls back both anonymous intent and issued ceremony when its process dies after the begin write", async () => {
    const [a, b] = await Promise.all([worker({ maxRecords: 1 }), worker({ maxRecords: 1 })]);
    const barrier = message(a.child, "barrier");
    const interrupted = a.request({ action: "begin", barrier: "after-login-write" }).catch(() => null);
    await reachedBarrier(barrier, interrupted); await kill(a.child); await interrupted;
    expect((await pool.query(`SELECT (SELECT count(*)::int FROM rest_wallet_logins) AS logins,
      (SELECT count(*)::int FROM rest_wallet_ceremonies WHERE purpose='login') AS ceremonies`)).rows[0])
      .toEqual({ logins: 0, ceremonies: 0 });
    expect((await b.request({ action: "begin" })).status).toBe(200);
    expect((await pool.query(`SELECT (SELECT count(*)::int FROM rest_wallet_logins) AS logins,
      (SELECT count(*)::int FROM rest_wallet_ceremonies WHERE purpose='login') AS ceremonies`)).rows[0])
      .toEqual({ logins: 1, ceremonies: 1 });
  });

  it("signs in and views the account on a lapsed readiness window; only dispatch use fails closed", async () => {
    // The last verified observation is the identity; its age only matters where the account acts on chain.
    const value = await completeWalletLoginFixture(pool, { lifetimeMs: 1800 });
    await untilDatabaseTime(value.observation.validUntilMs!);
    expect(await store.readSession(value.sessionToken)).toBeNull();
    expect(await store.viewSession(value.sessionToken)).toMatchObject({ id: value.session.id, accountId: value.accountId });
    expect(await store.identifySession(value.sessionToken)).toEqual({ accountId: value.accountId });
    expect(await store.identityKnown(value.accountId)).toBe(true);
    expect(await store.identityKnown("eip155:8453:0x0000000000000000000000000000000000000001")).toBe(false);
    const begun = await store.begin();
    const again = await store.complete(proof(value, begun));
    expect(again.session.accountId).toBe(value.accountId); expect(again.replayed).toBe(false);
    expect(await store.viewSession(again.sessionToken)).toMatchObject({ id: again.session.id });
  });
  it("recovers the same session after challenge expiry even when its valid authenticator counter advances", async () => {
    const value = await initialized(), short = new PostgresWalletLoginStore(pool, { rpId, origin: audience, loginLifetimeMs: 1800 });
    const begun = await short.begin(), input = proof(value, begun), completed = await short.complete(input);
    await untilDatabaseTime(begun.login.expiresAtMs);
    expect(await short.complete(input)).toEqual({ ...completed, replayed: true });
    const changed = { ...input, assertion: signGet({ ...value.credential, challenge: begun.login.challenge,
      rpId, origin: audience, signCount: 1 }) };
    expect(await short.complete(changed)).toEqual({ ...completed, replayed: true });
    expect(await completionCount()).toBe(1);
  });

  it("denies the original one-hour session under explicitly simulated elapsed DB time without changing its signed intent", async () => {
    const value = await completeWalletLoginFixture(pool), child = await worker();
    const before = (await pool.query("SELECT draft,session_document,proof_digest FROM rest_wallet_logins WHERE id=$1", [value.login.id])).rows[0];
    const databaseTimeOffsetMs = value.session.expiresAtMs - await databaseNow() + 1;
    expect(databaseTimeOffsetMs).toBeGreaterThan(3_500_000);
    expect((await child.request({ action: "readSession", token: value.sessionToken, databaseTimeOffsetMs })).body).toBeNull();
    // Both identity methods omit readiness; their rejection establishes session expiry itself.
    expect((await child.request({ action: "identifySession", token: value.sessionToken, databaseTimeOffsetMs })).body).toBeNull();
    for (const action of ["identifyCompletion", "complete"]) {
      expect(await child.request({ action, input: wire(value.input), databaseTimeOffsetMs }))
        .toMatchObject({ status: 403, body: { code: "WALLET_LOGIN_INACTIVE" } });
    }
    expect(await child.request({ action: "logout", token: value.sessionToken, databaseTimeOffsetMs }))
      .toMatchObject({ status: 403, body: { code: "WALLET_LOGIN_INACTIVE" } });
    expect((await pool.query("SELECT draft,session_document,proof_digest FROM rest_wallet_logins WHERE id=$1", [value.login.id])).rows[0]).toEqual(before);
    expect(await store.readSession(value.sessionToken)).toEqual(value.session);
  });

  it("logs out account-wide once and never revives either old cookie through completion replay", async () => {
    const value = await completeWalletLoginFixture(pool), other = await store.complete(proof(value, await store.begin()));
    const before = (await pool.query("SELECT session_epoch FROM rest_wallet_authority WHERE account_id=$1", [value.accountId])).rows[0].session_epoch;
    expect(await store.logout(value.sessionToken)).toEqual({ loggedOut: true, replayed: false });
    expect(await store.logout(value.sessionToken)).toEqual({ loggedOut: true, replayed: true });
    for (const token of [value.sessionToken, other.sessionToken]) {
      expect(await store.readSession(token)).toBeNull(); expect(await store.identifySession(token)).toBeNull();
    }
    await expect(store.complete(value.input)).rejects.toMatchObject({ code: "WALLET_LOGIN_INACTIVE" });
    expect((await pool.query("SELECT session_epoch FROM rest_wallet_authority WHERE account_id=$1", [value.accountId])).rows[0].session_epoch)
      .toBe((BigInt(before) + 1n).toString());
  });

  it("revokes an already admitted app grant when concurrent logout retries advance the session epoch only once", async () => {
    const value = await completeWalletLoginFixture(pool), appOrigin = "https://beep.example";
    await new PostgresWalletPolicyStore(pool).activate({ expectedRevision: 0, nextRevision: 1,
      configuration: { version: "center-wallet-policy-v1", applications: [{ origin: appOrigin, walletCallbacks: [`${appOrigin}/callback`] }] } });
    const grant = await new PostgresWalletAppGrantStore(pool).insert({ accountId: value.accountId,
      signerAddress: value.binding.authorization.setup!.botAddress, origin: appOrigin, callbackUri: `${appOrigin}/callback`,
      audience, expectedAppGeneration: 1, expectedAuthorityEpoch: value.session.authorityEpoch,
      expectedSessionEpoch: value.session.sessionEpoch, expiresAt: Math.floor(await databaseNow() / 1000) + 600 });
    const guard = async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN"); await assertWalletAppGrantActiveInTransaction(client, grant,
          { kind: "actor", principalId: walletAppPrincipalId(grant), audience }); await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    };
    await guard();
    const [a, b] = await Promise.all([worker(), worker()]);
    const results = await Promise.all([a.request({ action: "logout", token: value.sessionToken }),
      b.request({ action: "logout", token: value.sessionToken })]);
    expect(results.map(result => result.status)).toEqual([200, 200]);
    expect(results.map(result => result.body.replayed).sort()).toEqual([false, true]);
    await expect(guard()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await pool.query("SELECT session_epoch FROM rest_wallet_authority WHERE account_id=$1", [value.accountId])).rows[0].session_epoch)
      .toBe((BigInt(value.session.sessionEpoch) + 1n).toString());
  });

  it.each(["credential", "binding", "authority"])("rechecks changed %s in both already-running replicas without reviving old sessions", async kind => {
    const value = await completeWalletLoginFixture(pool), [a, b] = await Promise.all([worker(), worker()]);
    expect((await a.request({ action: "readSession", token: value.sessionToken })).body).toEqual(value.session);
    if (kind === "credential") await pool.query("UPDATE rest_wallet_credentials SET superseded_at=$2 WHERE account_id=$1", [value.accountId, await databaseNow()]);
    else if (kind === "binding") await pool.query("UPDATE rest_smart_account_bindings SET revoked_at=$2 WHERE account_id=$1", [value.accountId, Math.floor(await databaseNow() / 1000)]);
    else await pool.query("UPDATE rest_wallet_authority SET authority_epoch=authority_epoch+1,session_epoch=session_epoch+1 WHERE account_id=$1", [value.accountId]);
    for (const child of [a, b]) {
      expect((await child.request({ action: "readSession", token: value.sessionToken })).body).toBeNull();
      expect((await child.request({ action: "identifySession", token: value.sessionToken })).body).toBeNull();
      expect((await child.request({ action: "complete", input: wire(value.input) })).status).toBe(403);
    }
  });

  it("admits only the final global login slot across two processes", async () => {
    const [a, b] = await Promise.all([worker({ maxRecords: 2 }), worker({ maxRecords: 2 })]);
    expect((await a.request({ action: "begin" })).status).toBe(200);
    const results = await Promise.all([a.request({ action: "begin" }), b.request({ action: "begin" })]);
    expect(results.map(result => result.status).sort()).toEqual([200, 429]);
    expect(results.find(result => result.status === 429)?.body.code).toBe("WALLET_LOGIN_LIMIT");
    expect((await pool.query("SELECT count(*)::int AS count FROM rest_wallet_logins")).rows[0].count).toBe(2);
  });

  it("shares global admission across different search paths resolving the same actual login and ceremony tables", async () => {
    const firstAlias = `rest_wallet_login_alias_${randomUUID().replaceAll("-", "")}`;
    const secondAlias = `rest_wallet_login_alias_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${firstAlias}`); await admin.query(`CREATE SCHEMA ${secondAlias}`);
    try {
      const [a, b] = await Promise.all([worker({ maxRecords: 1 }, firstAlias), worker({ maxRecords: 1 }, secondAlias)]);
      const barrier = message(a.child, "barrier"), first = a.request({ action: "begin", barrier: "after-count", continueBarrier: true });
      await reachedBarrier(barrier, first);
      let finished = false;
      const second = b.request({ action: "begin" }).finally(() => { finished = true; });
      const deadline = Date.now() + 3000;
      let blocked = false;
      do {
        const row = (await pool.query("SELECT pg_blocking_pids($1) AS blockers", [b.backendPid])).rows[0];
        if (row.blockers.includes(a.backendPid)) { blocked = true; break; }
        if (finished) break;
        await pool.query("SELECT pg_sleep(0.01)");
      } while (Date.now() < deadline);
      a.child.send({ kind: "continue" });
      const results = await Promise.all([first, second]);
      expect(results.map(result => result.status).sort()).toEqual([200, 429]);
      expect(blocked).toBe(true);
      expect((await pool.query("SELECT count(*)::int AS count FROM rest_wallet_logins")).rows[0].count).toBe(1);
    } finally {
      await admin.query(`DROP SCHEMA ${firstAlias}`); await admin.query(`DROP SCHEMA ${secondAlias}`);
    }
  });

  it("admits only the final account session slot across distinct ceremonies and processes", async () => {
    const value = await initialized(), [a, b] = await Promise.all([worker({ maxAccountSessions: 1 }), worker({ maxAccountSessions: 1 })]);
    const [first, second] = await Promise.all([store.begin(), store.begin()]);
    const results = await Promise.all([a.request({ action: "complete", input: wire(proof(value, first)) }),
      b.request({ action: "complete", input: wire(proof(value, second)) })]);
    expect(results.map(result => result.status).sort()).toEqual([200, 429]);
    expect(await completionCount()).toBe(1);
  });

  it.each(["rest_accounts", "rest_wallet_credentials"])("rolls back login after a genuine %s lock wait crosses ceremony expiry", async table => {
    const value = await initialized(), child = await worker({ loginLifetimeMs: 1800 });
    const blocker = await pool.connect(), begun = (await child.request({ action: "begin" })).body;
    const input = proof(value, begun);
    try {
      await blocker.query("BEGIN");
      await blocker.query(`SELECT * FROM ${table} WHERE ${table === "rest_accounts" ? "id" : "account_id"}=$1 FOR UPDATE`, [value.accountId]);
      const blockerPid = Number((await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      const pending = child.request({ action: "complete", input: wire(input) });
      await waitForLock(child.backendPid, blockerPid, table); await untilDatabaseTime(begun.login.expiresAtMs);
      await blocker.query("ROLLBACK");
      expect(await pending).toMatchObject({ status: 410, body: { code: "WALLET_LOGIN_EXPIRED" } });
      expect(await completionCount()).toBe(0);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  });

  it("rolls back a written session when completion passes the original ceremony deadline before commit", async () => {
    const value = await initialized(), child = await worker({ loginLifetimeMs: 1600 });
    const begun = (await child.request({ action: "begin" })).body, barrier = message(child.child, "barrier");
    const pending = child.request({ action: "complete", input: wire(proof(value, begun)), barrier: "after-login-write", continueBarrier: true });
    await reachedBarrier(barrier, pending); await untilDatabaseTime(begun.login.expiresAtMs); child.child.send({ kind: "continue" });
    expect(await pending).toMatchObject({ status: 410, body: { code: "WALLET_LOGIN_EXPIRED" } });
    expect(await completionCount()).toBe(0);
    expect((await storedCeremony(begun.login.id)).consumed_at).toBeNull();
  });

  it("rejects SQL NULL escapes, partial completion and changes to immutable intent/session fields", async () => {
    const value = await completeWalletLoginFixture(pool), another = await store.begin();
    for (const sql of [
      "UPDATE rest_wallet_logins SET session_id=NULL WHERE id=$1",
      "UPDATE rest_wallet_logins SET draft=draft-'origin' WHERE id=$1",
      "UPDATE rest_wallet_logins SET draft=jsonb_set(draft,'{origin}','null'::jsonb) WHERE id=$1",
      "UPDATE rest_wallet_logins SET flow_token_hash=repeat('1',64) WHERE id=$1",
      "UPDATE rest_wallet_logins SET session_document=session_document-'accountId' WHERE id=$1",
      "UPDATE rest_wallet_logins SET session_document=jsonb_set(session_document,'{sessionEpoch}','null'::jsonb) WHERE id=$1",
      "UPDATE rest_wallet_logins SET session_epoch=NULL WHERE id=$1",
      "UPDATE rest_wallet_logins SET session_token_hash=repeat('2',64) WHERE id=$1",
      "UPDATE rest_wallet_logins SET completed_at_ms=NULL WHERE id=$1",
    ]) await expect(pool.query(sql, [value.login.id])).rejects.toMatchObject({ code: expect.stringMatching(/^23/) });
    await expect(pool.query("UPDATE rest_wallet_logins SET completed_at_ms=issued_at_ms WHERE id=$1", [another.login.id]))
      .rejects.toMatchObject({ code: expect.stringMatching(/^23/) });
    expect(await store.readSession(value.sessionToken)).toEqual(value.session);
  });

  it("rejects missing and JSON-null intent fields on INSERT independently of update immutability", async () => {
    const { draft: initial } = createWalletLoginDraft({ rpId, origin: audience, nowMs: await databaseNow() });
    const source = (await pool.query(`INSERT INTO rest_wallet_logins(id,session_id,ceremony_id,rp_id,flow_token_hash,
      issued_at_ms,expires_at_ms,retain_until_ms,draft) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *`,
      [initial.id, initial.sessionId, initial.ceremony.id, initial.rpId, initial.flowTokenHash,
        initial.issuedAtMs, initial.expiresAtMs, initial.retainUntilMs, JSON.stringify(initial)])).rows[0];
    const row = async () => {
      const { draft } = createWalletLoginDraft({ rpId, origin: audience, nowMs: await databaseNow() });
      return { ...source, id: draft.id, session_id: draft.sessionId, ceremony_id: draft.ceremony.id,
        draft, rp_id: draft.rpId, flow_token_hash: draft.flowTokenHash,
        issued_at_ms: draft.issuedAtMs, expires_at_ms: draft.expiresAtMs, retain_until_ms: draft.retainUntilMs };
    };
    const insert = (value: unknown) => pool.query("INSERT INTO rest_wallet_logins SELECT * FROM jsonb_populate_record(NULL::rest_wallet_logins,$1::jsonb)", [JSON.stringify(value)]);
    // A positive control ensures failures below are not merely duplicate-ID or row-shape errors.
    await insert(await row());
    for (const field of ["origin", "flowTokenHash", "sessionId", "expiresAtMs", "ceremony"] as const) {
      for (const mode of ["missing", "null"] as const) {
        const value = await row();
        if (mode === "missing") delete (value.draft as any)[field];
        else (value.draft as any)[field] = null;
        await expect(insert(value)).rejects.toMatchObject({ code: expect.stringMatching(/^23/) });
      }
    }
  });

  it("reclaims abandoned logins at challenge expiry in bounded cleanup without touching independent ceremony records", async () => {
    const live = await store.begin(), before = Number((await pool.query("SELECT count(*)::int AS count FROM rest_wallet_ceremonies")).rows[0].count);
    for (let i = 0; i < 2; i++) {
      const { draft } = createWalletLoginDraft({ rpId, origin: audience,
        nowMs: await databaseNow() - 180_000 - 2000 });
      await pool.query(`INSERT INTO rest_wallet_logins(id,session_id,ceremony_id,rp_id,flow_token_hash,
        issued_at_ms,expires_at_ms,retain_until_ms,draft) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [draft.id, draft.sessionId, draft.ceremony.id, draft.rpId, draft.flowTokenHash,
          draft.issuedAtMs, draft.expiresAtMs, draft.retainUntilMs, JSON.stringify(draft)]);
    }
    expect(await store.cleanup(1)).toBe(1); expect(await store.cleanup(1000)).toBe(1); expect(await store.cleanup()).toBe(0);
    expect((await pool.query("SELECT id FROM rest_wallet_logins")).rows).toEqual([{ id: live.login.id }]);
    expect(Number((await pool.query("SELECT count(*)::int AS count FROM rest_wallet_ceremonies")).rows[0].count)).toBe(before);
  });
  it("retains completed login receipts and rejects direct early deletion after challenge expiry", async () => {
    const value = await initialized(), short = new PostgresWalletLoginStore(pool, { rpId, origin: audience, loginLifetimeMs: 2000 });
    const begun = await short.begin(), input = proof(value, begun), completed = await short.complete(input);
    await untilDatabaseTime(begun.login.expiresAtMs);
    expect(await short.cleanup()).toBe(0);
    await expect(pool.query('DELETE FROM rest_wallet_logins WHERE id=$1', [begun.login.id])).rejects.toMatchObject({ code: '23514' });
    expect(await short.complete(input)).toEqual({ ...completed, replayed: true });
  });

});
