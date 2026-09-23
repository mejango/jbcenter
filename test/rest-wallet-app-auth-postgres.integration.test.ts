import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { migrate } from "../src/db/migrate.js";
import { buildRequestTypedData, REST_AUTH_HEADERS as H, type RequestClaims } from "../src/rest/auth/signatures.js";
import { assertRestActorActive, PostgresAccountStore } from "../src/rest/auth/postgres.js";
import { PostgresWalletPolicyStore } from "../src/rest/wallet/policyPostgres.js";
import { PostgresWalletAppGrantStore, getWalletAppGrantInTransaction } from "../src/rest/wallet/appGrantsPostgres.js";
import { walletAppPrincipalId, type WalletAppGrant } from "../src/rest/wallet/appGrants.js";
import { bindSmartAccountInTransaction, PostgresSmartAccountRegistry } from "../src/rest/smartAccounts/postgres.js";
import { seedTrustedWalletAuthority, trustedAuthorityNow, unreadyTrustedWalletAuthority, writeTrustedWalletAuthoritySnapshot,
  type TrustedWalletAuthorityFixture } from "./fixtures/wallet-authority-readiness.js";

const database = process.env.TEST_DATABASE_URL, suite = database ? describe : describe.skip;
const schema = `wallet_app_auth_${randomUUID().replaceAll("-", "")}`, audience = "https://juicebox.center";
const origin = "https://beep.example", secondOrigin = "https://money.example";
const owner = privateKeyToAccount(`0x${"31".repeat(32)}`), browser = privateKeyToAccount(`0x${"32".repeat(32)}`), other = privateKeyToAccount(`0x${"33".repeat(32)}`);
const accountId = `eip155:8453:${owner.address.toLowerCase()}`;
let admin: Pool, pool: Pool;
let trustedAuthority: TrustedWalletAuthorityFixture;
const children: Array<{ child: ChildProcess; url: string; backendPid: number }> = [];
const configuration = (origins = [origin, secondOrigin]) => ({ version: "center-wallet-policy-v1" as const,
  applications: origins.map(value => ({ origin: value, walletCallbacks: [`${value}/callback`] })) });
async function start() {
  const child = fork(fileURLToPath(new URL("./fixtures/wallet-app-auth-process.ts", import.meta.url)), [], {
    execArgv: ["--import", "tsx"], env: { ...process.env, WALLET_APP_AUTH_SCHEMA: schema }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const result = await new Promise<{ child: ChildProcess; url: string; backendPid: number }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("App auth fixture startup timed out")); }, 5000);
    const fail = () => { clearTimeout(timer); reject(new Error("App auth fixture did not start")); };
    child.once("error", fail); child.once("exit", fail);
    child.on("message", value => {
      if (value && typeof value === "object" && "kind" in value && value.kind === "ready" && "port" in value && typeof value.port === "number"
        && "backendPid" in value && typeof value.backendPid === "number") {
        clearTimeout(timer); child.removeListener("exit", fail); child.removeListener("error", fail);
        resolve({ child, url: `http://127.0.0.1:${value.port}`, backendPid: value.backendPid });
      }
    });
  });
  children.push(result);
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const kill = setTimeout(() => child.kill("SIGKILL"), 1000);
    const deadline = setTimeout(() => finish(new Error("App auth fixture did not exit")), 5000);
    const exited = () => finish(), failed = () => finish(new Error("App auth fixture termination failed"));
    function finish(error?: Error) {
      clearTimeout(kill); clearTimeout(deadline); child.off("exit", exited); child.off("error", failed);
      if (error) reject(error); else resolve();
    }
    child.once("exit", exited); child.once("error", failed); child.kill("SIGTERM");
  });
}
async function now() { return Number((await pool.query("SELECT floor(extract(epoch FROM clock_timestamp()))::text AS now")).rows[0].now); }
async function grant(appOrigin = origin, changes: Partial<Parameters<PostgresWalletAppGrantStore["insert"]>[0]> = {}) {
  return new PostgresWalletAppGrantStore(pool).insert({ accountId, signerAddress: browser.address, origin: appOrigin,
    callbackUri: `${appOrigin}/callback`, audience, expectedAppGeneration: 1, expectedAuthorityEpoch: "1", expectedSessionEpoch: "1", expiresAt: await now() + 600, ...changes });
}
async function foreignAccount() {
  const id = `eip155:8453:${other.address.toLowerCase()}`;
  await pool.query(`INSERT INTO rest_accounts(id,owner_address,authority_chain_id,display_name,bio,avatar_uri,created_at,updated_at)
    VALUES($1,$2,8453,'','',NULL,1,1)`, [id, other.address.toLowerCase()]);
  return id;
}
async function signed(value: Pick<WalletAppGrant, "id" | "origin">, options: { wallet?: typeof browser; origin?: string | null; audience?: string;
  target?: string; payload?: unknown; changes?: Partial<RequestClaims> } = {}) {
  const wallet = options.wallet ?? browser, target = options.target ?? "/api/v1/accounts/me";
  const body = options.payload === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(options.payload));
  const current = await now();
  const claims: RequestClaims = { accountId, signer: wallet.address, grantId: value.id, method: options.payload === undefined ? "GET" : "POST",
    requestTarget: target, contentType: options.payload === undefined ? "" : "application/json", bodyHash: keccak256(body),
    issuedAt: current, expiresAt: current + 60, nonce: `0x${randomUUID().replaceAll("-", "").repeat(2)}` as Hex,
    idempotencyKey: "", ...options.changes };
  const signature = await wallet.signTypedData(buildRequestTypedData(options.audience ?? audience, claims));
  const headers = new Headers({ [H.account]: claims.accountId, [H.signer]: claims.signer, [H.grant]: claims.grantId,
    [H.issuedAt]: String(claims.issuedAt), [H.expiresAt]: String(claims.expiresAt), [H.nonce]: claims.nonce, [H.signature]: signature,
    [H.idempotencyKey]: "", "content-type": claims.contentType });
  const browserOrigin = options.origin === undefined ? value.origin : options.origin;
  if (browserOrigin !== null) headers.set("origin", browserOrigin);
  return { claims, target, init: { method: claims.method, headers, ...(body.byteLength ? { body } : {}), signal: AbortSignal.timeout(7000) } };
}
async function send(replica: number, request: Awaited<ReturnType<typeof signed>>) {
  const response = await fetch(children[replica]!.url + request.target, request.init);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
async function nonceCount(nonce: Hex, id = accountId) { return Number((await pool.query("SELECT count(*)::int AS n FROM rest_request_nonces WHERE account_id=$1 AND nonce=$2", [id, nonce])).rows[0].n); }
async function responseOrLock<T>(pending: Promise<T>, backendPid: number): Promise<"completed" | "blocked"> {
  let completed = false;
  void pending.then(() => { completed = true; }, () => { completed = true; });
  for (let attempt = 0; attempt < 200; attempt++) {
    if (completed) return "completed";
    const row = (await pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [backendPid])).rows[0];
    if (row?.wait_event_type === "Lock") return "blocked";
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Expected the app-auth request to complete or reach a PostgreSQL lock");
}

suite("real signed app requests across two PostgreSQL HTTP replicas", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: database, connectionTimeoutMillis: 3000 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: database, max: 4, connectionTimeoutMillis: 3000, query_timeout: 5000,
      options: `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=5000` });
    await migrate(pool);
    await pool.query("CREATE TABLE wallet_app_auth_claims(id text PRIMARY KEY,principal_id text NOT NULL)");
    await start(); await start();
  }, 20000);
  afterAll(async () => {
    const stopped = await Promise.allSettled(children.map(({ child }) => stop(child)));
    try { await pool?.end(); }
    finally { if (admin) { try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); } } }
    for (const result of stopped) if (result.status === "rejected") throw result.reason;
  }, 15000);
  beforeEach(async () => {
    await pool.query("TRUNCATE rest_accounts,rest_wallet_policy,wallet_app_auth_claims CASCADE");
    await new PostgresWalletPolicyStore(pool).activate({ expectedRevision: 0, nextRevision: 1, configuration: configuration() });
    await pool.query(`INSERT INTO rest_accounts(id,owner_address,authority_chain_id,display_name,bio,avatar_uri,created_at,updated_at)
      VALUES($1,$2,8453,'','',NULL,1,1)`, [accountId, owner.address.toLowerCase()]);
    // Synthetic readiness isolates signed-request/nonce behavior. It is not canonical producer or login proof.
    trustedAuthority = await seedTrustedWalletAuthority(pool, accountId);
  });

  it("authenticates the same app incarnation through both actual service processes", async () => {
    const value = await grant();
    for (const replica of [0, 1]) expect(await send(replica, await signed(value))).toMatchObject({ status: 200,
      body: { kind: "wallet-app", isOwner: false, principalId: walletAppPrincipalId(value), grantId: value.id,
        scopes: ["read", "plan", "relay"], walletApp: { origin, audience, incarnation: value.incarnation } } });
  });

  it("consumes one genuine signed request nonce across two replicas", async () => {
    const value = await grant(), request = await signed(value);
    const results = await Promise.all([send(0, request), send(1, request)]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    expect(results.find(result => result.status === 409)?.body.code).toBe("REPLAY");
    expect(await nonceCount(request.claims.nonce)).toBe(1);
  });

  it("preserves genuine legacy bot authentication without wallet readiness or wallet authority", async () => {
    const requestedAccount = await foreignAccount(), id = randomUUID(), current = await now();
    await new PostgresAccountStore(pool).registerBot({ id, accountId: requestedAccount, botAddress: browser.address,
      scopes: ["read"], label: "legacy bot", createdAt: current, expiresAt: current + 600, revokedAt: null });
    expect((await pool.query("SELECT count(*)::int AS count FROM rest_wallet_authority WHERE account_id=$1", [requestedAccount])).rows[0].count).toBe(0);
    for (const replica of [0, 1]) {
      const request = await signed({ id, origin }, { origin: null, changes: { accountId: requestedAccount } });
      expect(await send(replica, request)).toEqual({ status: 200, body: { isOwner: false,
        principalId: `bot:${id}`, grantId: id, scopes: ["read"] } });
      expect(await nonceCount(request.claims.nonce, requestedAccount)).toBe(1);
    }
  });

  it("admits a verified snapshot whose readiness window lapsed: the identity is enough, and the nonce is consumed", async () => {
    const value = await grant();
    const expired = structuredClone(trustedAuthority.snapshot), observedAtMs = await trustedAuthorityNow(pool);
    expired.updatedAtMs = observedAtMs; expired.validUntilMs = observedAtMs + 200;
    expired.latestObservation!.observedAtMs = observedAtMs; expired.latestObservation!.validUntilMs = expired.validUntilMs;
    await writeTrustedWalletAuthoritySnapshot(pool, expired);
    await pool.query("SELECT pg_sleep(GREATEST(0,$1::double precision/1000-extract(epoch FROM clock_timestamp())::double precision+0.03))", [expired.validUntilMs]);
    const request = await signed(value);
    expect((await send(1, request)).status).toBe(200);
    expect(await nonceCount(request.claims.nonce)).toBe(1);
  });

  it.each(["unknown", "changed", "fenced"] as const)("rejects %s wallet readiness before consuming a signed nonce", async readiness => {
    const value = await grant();
    // Preserve captured epochs in a validated synthetic state so this isolates readiness admission.
    const snapshot = unreadyTrustedWalletAuthority(trustedAuthority.snapshot, readiness, await trustedAuthorityNow(pool));
    await writeTrustedWalletAuthoritySnapshot(pool, snapshot);
    const request = await signed(value);
    expect(await send(1, request)).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(await nonceCount(request.claims.nonce)).toBe(0);
  });

  it("rejects epoch-only wallet authority before consuming a signed nonce", async () => {
    const requestedAccount = await foreignAccount(), id = randomUUID(), current = await now();
    // Trusted historical app grant on migration020's initial epoch-only authority shape.
    // This raw fixture write is deliberately separate from production grant admission.
    await pool.query("INSERT INTO rest_wallet_authority(account_id,authority_epoch,session_epoch,updated_at) VALUES($1,1,1,$2)", [requestedAccount, current]);
    await pool.query(`INSERT INTO rest_wallet_app_grants(id,account_id,signer_address,origin,callback_uri,audience,
      app_generation,authority_epoch,session_epoch,created_at,expires_at,retain_until)
      VALUES($1,$2,$3,$4,$5,$6,1,1,1,$7,$8,$9)`, [id, requestedAccount, browser.address.toLowerCase(),
      origin, `${origin}/callback`, audience, current, current + 600, current + 87000]);
    const request = await signed({ id, origin }, { changes: { accountId: requestedAccount } });
    expect(await send(1, request)).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(await nonceCount(request.claims.nonce, requestedAccount)).toBe(0);
  });

  it.each(["revoked", "replaced"])("rejects a %s live wallet binding before consuming a signed nonce", async change => {
    const value = await grant(), binding = trustedAuthority.binding;
    if (change === "revoked") await new PostgresSmartAccountRegistry(pool).revoke(accountId, binding.id);
    else {
      const replacement = structuredClone(binding), client = await pool.connect();
      replacement.authorization.digest = keccak256(new TextEncoder().encode(`replacement:${randomUUID()}`));
      replacement.authorization.nonce = keccak256(new TextEncoder().encode(`replacement-nonce:${randomUUID()}`));
      try {
        await client.query("BEGIN"); await client.query("SELECT id FROM rest_accounts WHERE id=$1 FOR UPDATE", [accountId]);
        // Trusted synthetic setup input exercises the existing account-locked binding writer only.
        await bindSmartAccountInTransaction(client, replacement, await now()); await client.query("COMMIT");
      } finally { await client.query("ROLLBACK"); client.release(); }
      expect((await new PostgresSmartAccountRegistry(pool).get(accountId, binding.id))?.authorization.digest)
        .toBe(replacement.authorization.digest);
    }
    const request = await signed(value);
    expect(await send(1, request)).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(await nonceCount(request.claims.nonce)).toBe(0);
  });

  it("returns a controlled conflict when a legacy bot registration reuses an app UUID", async () => {
    const value = await grant(), store = new PostgresAccountStore(pool);
    await expect(store.registerBot({ id: value.id, accountId, botAddress: other.address, scopes: ["read"],
      label: "legacy bot", createdAt: await now(), expiresAt: await now() + 600, revokedAt: null }))
      .rejects.toMatchObject({ code: "REPLAY", status: 409 });
    expect((await pool.query("SELECT count(*)::int AS n FROM rest_bot_grants WHERE id=$1", [value.id])).rows[0].n).toBe(0);
    expect((await send(1, await signed(value))).status).toBe(200);
  });

  it.each(["signer", "origin", "no-origin", "audience", "owner-only"])("rejects %s substitution before nonce consumption", async change => {
    const value = await grant(), request = await signed(value, change === "signer" ? { wallet: other }
      : change === "origin" ? { origin: secondOrigin } : change === "no-origin" ? { origin: null }
      : change === "audience" ? { audience: "https://different.example" } : { target: "/fixture/owner" });
    const result = await send(0, request);
    expect([401, 403]).toContain(result.status); expect(await nonceCount(request.claims.nonce)).toBe(0);
  });

  it("rejects a signed cross-account app request without waiting for the grant owner's lock", async () => {
    const value = await grant(), requestedAccount = await foreignAccount();
    const request = await signed(value, { changes: { accountId: requestedAccount } }), lock = await pool.connect();
    let pending: ReturnType<typeof send> | undefined;
    try {
      await lock.query("BEGIN"); await lock.query("SELECT id FROM rest_accounts WHERE id=$1 FOR UPDATE", [accountId]);
      pending = send(0, request);
      expect(await responseOrLock(pending, children[0]!.backendPid)).toBe("completed");
      expect(await pending).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
      expect(await nonceCount(request.claims.nonce, requestedAccount)).toBe(0);
    } finally { await lock.query("ROLLBACK"); lock.release(); await pending?.catch(() => {}); }
  });

  it.each(["active principal", "stored actor"])("rejects a cross-account %s without locking the grant owner's account", async boundary => {
    const value = await grant(), requestedAccount = await foreignAccount(), lock = await pool.connect();
    const isolated = new Pool({ connectionString: database, max: 1, connectionTimeoutMillis: 3000, query_timeout: 5000,
      options: `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=5000` });
    let pending: Promise<unknown> | undefined;
    try {
      const backendPid = (await isolated.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await lock.query("BEGIN"); await lock.query("SELECT id FROM rest_accounts WHERE id=$1 FOR UPDATE", [accountId]);
      const actor = { accountId: requestedAccount, principalId: walletAppPrincipalId(value) }, current = await now();
      pending = (boundary === "active principal"
        ? new PostgresAccountStore(isolated).assertActive({ ...actor, signer: browser.address, grantId: value.id, requiredScopes: ["read"], now: current, audience })
        : (async () => {
          const client = await isolated.connect();
          try { await client.query("BEGIN"); await assertRestActorActive(client, actor, ["plan"], current); }
          finally { await client.query("ROLLBACK"); client.release(); }
        })()).then(() => ({ accepted: true }), error => error);
      expect(await responseOrLock(pending, backendPid)).toBe("completed");
      expect(await pending).toMatchObject({ code: "FORBIDDEN", status: 403 });
    } finally { await lock.query("ROLLBACK"); lock.release(); await pending; await isolated.end(); }
  });

  it.each(["grant", "request"])("refuses a signed request whose %s expires while it waits for the account lock, writing no nonce", async boundary => {
    // Use a fresh worker so its observed backend PID has not been retired while idle.
    const replica = children.length; await start();
    const process = children[replica]!;
    const lock = await pool.connect(); let pending: ReturnType<typeof send> | undefined;
    try {
      // Admission is one transaction under the account lock; a request that waits behind another
      // writer past its own or its grant's expiry is refused at the clock read after the lock.
      await lock.query("BEGIN");
      const blocker = Number((await lock.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      // Grant insertion itself needs the account lock. Prepare the holder first,
      // then issue a real 3–4s window inside the unchanged 5s SQL/auth budgets.
      const expiresAt = Math.ceil(await trustedAuthorityNow(pool) / 1000) + 3;
      const value = await grant(origin, boundary === "grant" ? { expiresAt } : {});
      await lock.query("SELECT id FROM rest_accounts WHERE id=$1 FOR UPDATE", [accountId]);
      const request = await signed(value, boundary === "request" ? { changes: { expiresAt } } : {});
      pending = send(replica, request);
      if (await responseOrLock(pending, process.backendPid) !== "blocked")
        throw new Error(`Request returned before account lock: ${JSON.stringify(await pending)}`);
      const blocked = (await pool.query("SELECT query,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1", [process.backendPid])).rows[0];
      expect(blocked.query).toContain("FROM rest_accounts");
      expect(blocked.blockers).toContain(blocker);
      expect(await now()).toBeLessThan(expiresAt);
      await lock.query("SELECT pg_sleep(GREATEST(0,$1::double precision-extract(epoch FROM clock_timestamp())::double precision+0.05))", [expiresAt]);
      await lock.query("ROLLBACK");
      expect(await pending).toMatchObject(boundary !== "request"
        ? { status: 403, body: { code: "FORBIDDEN" } } : { status: 401, body: { code: "AUTH_REQUIRED" } });
      expect(await nonceCount(request.claims.nonce)).toBe(0);
    } finally { await lock.query("ROLLBACK"); lock.release(); await pending?.catch(() => {}); await stop(process.child); }
  }, 10_000);

  it("does not revive an old signed app grant when the same origin and callback are re-enabled", async () => {
    const previous = await grant(), policies = new PostgresWalletPolicyStore(pool);
    await policies.activate({ expectedRevision: 1, nextRevision: 2, configuration: configuration([secondOrigin]) });
    await policies.activate({ expectedRevision: 2, nextRevision: 3, configuration: configuration() });
    expect((await pool.query("SELECT enabled,generation FROM rest_wallet_policy_apps WHERE origin=$1", [origin])).rows[0])
      .toEqual({ enabled: true, generation: "3" });
    const stale = await signed(previous);
    expect(await send(1, stale)).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(await nonceCount(stale.claims.nonce)).toBe(0);
    const replacement = await grant(origin, { expectedAppGeneration: 3 });
    expect(await send(0, await signed(replacement))).toMatchObject({ status: 200,
      body: { principalId: walletAppPrincipalId(replacement), walletApp: { origin, incarnation: replacement.incarnation } } });
  });

  it.each(["logout", "authority", "revoke", "remove-app"])("rechecks %s in the other already running replica", async change => {
    const value = await grant(), survivor = await grant(secondOrigin);
    expect((await send(0, await signed(value))).status).toBe(200);
    if (change === "logout" || change === "authority") await new PostgresWalletAppGrantStore(pool).advanceEpochs({ accountId,
      expectedAuthorityEpoch: "1", expectedSessionEpoch: "1", kind: change });
    else if (change === "revoke") await pool.query("UPDATE rest_wallet_app_grants SET revoked_at=created_at WHERE id=$1", [value.id]);
    else await new PostgresWalletPolicyStore(pool).activate({ expectedRevision: 1, nextRevision: 2, configuration: configuration([secondOrigin]) });
    const request = await signed(value), rejected = await send(1, request);
    expect(rejected.status).toBe(403); expect(await nonceCount(request.claims.nonce)).toBe(0);
    if (change === "remove-app") expect((await send(1, await signed(survivor))).status).toBe(200);
  });

  it("keeps the app incarnation through a separately guarded durable fixture claim", async () => {
    const value = await grant(), id = randomUUID();
    expect(await send(0, await signed(value, { target: "/fixture/claim", payload: { id } })))
      .toMatchObject({ status: 200, body: { id, principalId: walletAppPrincipalId(value) } });
    expect((await pool.query("SELECT principal_id FROM wallet_app_auth_claims WHERE id=$1", [id])).rows[0].principal_id)
      .toBe(walletAppPrincipalId(value));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await expect(assertRestActorActive(client, { accountId, principalId: `bot:${value.id}` }, ["plan"], await now()))
        .rejects.toMatchObject({ code: "FORBIDDEN" });
      await client.query("ROLLBACK");
    } finally { client.release(); }
  });

  it("requires the exact prior incarnation for active-principal checks", async () => {
    const value = await grant(), store = new PostgresAccountStore(pool);
    const authority = { accountId, signer: browser.address, grantId: value.id, requiredScopes: ["read" as const], now: await now(), audience };
    await expect(store.assertActive(authority)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(store.assertActive({ ...authority, principalId: `app:${value.id}:999999` })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(store.assertActive({ ...authority, principalId: walletAppPrincipalId(value) })).resolves.toBeUndefined();
    const client = await pool.connect();
    try { expect((await getWalletAppGrantInTransaction(client, value.id))?.incarnation).toBe(value.incarnation); }
    finally { client.release(); }
  });

  it("requires app claims to share their authority transaction instead of the generic callback fallback", async () => {
    const value = await grant(), operation = vi.fn(async () => "independently committed");
    await expect(new PostgresAccountStore(pool).withActiveActor({ accountId, principalId: walletAppPrincipalId(value) },
      ["plan"], await now(), operation)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(operation).not.toHaveBeenCalled();
  });
});
