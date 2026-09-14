import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { getRequestListener } from "@hono/node-server";
import { build } from "esbuild";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { Pool } from "pg";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRestAuth } from "../src/rest/auth/service.js";
import { createRestAuthRouter } from "../src/rest/auth/router.js";
import { PostgresAccountStore } from "../src/rest/auth/postgres.js";
import { REST_AUTH_HEADERS } from "../src/rest/auth/signatures.js";
import { createWalletSite } from "../src/rest/wallet/site.js";
import { PostgresWalletLoginStore } from "../src/rest/wallet/loginPostgres.js";
import { PostgresWalletHandoffStore } from "../src/rest/wallet/handoffPostgres.js";
import { PostgresWalletPolicyStore } from "../src/rest/wallet/policyPostgres.js";
import { walletFlowCookie, walletSessionCookie } from "../src/rest/wallet/http.js";
import { createWalletLoginSetup, walletLoginTestMigrations } from "./fixtures/wallet-login-setup.js";

const database = process.env.TEST_DATABASE_URL, suite = database ? describe : describe.skip;
const schema = `wallet_browser_connect_${randomUUID().replaceAll("-", "")}`;
const output = new URL("../.generated/wallet-observations/browser-wallet-connect/", import.meta.url);
const encode = (value: string) => Buffer.from(value, "base64url").toString("base64");

suite("real browser shared-wallet connection with PostgreSQL (synthetic chain readiness)", () => {
  let admin: Pool, pool: Pool, browser: Browser, page: Page, cdp: CDPSession;
  let authenticatorId: string;
  let centerServer: Server, appServer: Server, apiServer: Server, issuer: string, appOrigin: string, audience: string;
  let productionScript: string, appScript: string, accountId: string, databaseMajor: number;
  let truncated = false, truncateCompletion = false;
  const transport: Array<{ path: string; method: string; origin: string | null; cookie: boolean; status: number }> = [];
  const pageErrors: string[] = [];
  const externalRequests: string[] = [];
  const authenticated: Array<{ kind: string; isOwner: boolean; accountId: string }> = [];
  const activeRequests = new Set<Promise<void>>();
  const track = (work: Promise<void>) => {
    activeRequests.add(work);
    void work.then(() => activeRequests.delete(work), () => activeRequests.delete(work));
  };

  async function listen(server: Server, hostname: string): Promise<string> {
    server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 1_000;
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Local listener did not start");
    return `http://${hostname}:${address.port}`;
  }
  async function close(server?: Server) {
    if (!server?.listening) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Local browser fixture cleanup timed out")), 5_000);
      server.close(error => { clearTimeout(timeout); if (error) reject(error); else resolve(); });
    });
  }
  const uiState = (expected: string) => expect.poll(() => page.locator("#wallet-status").getAttribute("data-state"), { timeout: 8_000 }).toBe(expected);
  const appState = (expected: string) => expect.poll(() => page.locator("#app-status").getAttribute("data-state"), { timeout: 8_000 }).toBe(expected);

  beforeAll(async () => {
    admin = new Pool({ connectionString: database, connectionTimeoutMillis: 3_000, query_timeout: 10_000 });
    databaseMajor = Math.floor(Number((await admin.query("SHOW server_version_num")).rows[0].server_version_num) / 10_000);
    expect(databaseMajor).toBe(16);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: database, max: 3, connectionTimeoutMillis: 3_000, query_timeout: 10_000,
      options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=5000` });
    for (const name of [...walletLoginTestMigrations, "024_wallet_handoff.sql"])
      await pool.query(await readFile(new URL(`../src/db/migrations/${name}`, import.meta.url), "utf8"));
    const [wallet, app] = await Promise.all(["../src/rest/web/wallet.ts", "./fixtures/wallet-connect-app.ts"].map(entry =>
      build({ entryPoints: [fileURLToPath(new URL(entry, import.meta.url))], platform: "browser", format: "esm", target: "es2022", bundle: true, write: false })));
    productionScript = wallet!.outputFiles[0]!.text; appScript = app!.outputFiles[0]!.text;
    browser = await chromium.launch({ headless: true, args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"] });
  }, 30_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE rest_accounts,rest_wallet_policy,rest_wallet_enrollments,rest_wallet_ceremonies CASCADE");
    transport.length = 0; pageErrors.length = 0; authenticated.length = 0; externalRequests.length = 0; truncated = false; truncateCompletion = false;
    // Loopback names are deliberately distinct: real browser Origin/CORS/cookie behavior applies.
    // The production Hono adapter receives actual Host headers; no browser header spoofing exists.
    let dispatch: ReturnType<typeof getRequestListener> | undefined;
    centerServer = createServer((request, response) => {
      if (dispatch) track(dispatch(request, response));
      else { response.writeHead(503); response.end(); }
    });
    issuer = await listen(centerServer, "localhost");
    let apiDispatch: ReturnType<typeof getRequestListener> | undefined;
    apiServer = createServer((request, response) => {
      if (apiDispatch) track(apiDispatch(request, response));
      else { response.writeHead(503); response.end(); }
    });
    audience = await listen(apiServer, "127.0.0.1");
    appServer = createServer((request, response) => {
      if (request.url === "/app.js") { response.writeHead(200, { "content-type": "text/javascript" }); response.end(appScript); return; }
      response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store", "referrer-policy": "strict-origin" });
      response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <meta name="wallet-issuer" content="${issuer}"><meta name="wallet-audience" content="${audience}"><title>Local shared wallet acceptance</title><script type="module" src="/app.js"></script></head>
        <body><main><h1>Local shared wallet acceptance</h1><p>Chromium virtual authenticator. Real browser, HTTP and PostgreSQL. Synthetic chain readiness.</p>
        <p id="app-status" role="status" data-state="loading">Loading…</p><p id="app-account"></p>
        <button id="app-connect">Connect Center wallet</button><button id="app-retry" hidden>Retry connection</button><button id="app-read" hidden>Read account</button></main></body></html>`);
    });
    appOrigin = await listen(appServer, "127.0.0.1");
    const setup = await createWalletLoginSetup(pool, { origin: issuer, rpId: "localhost", lifetimeMs: 30_000 });
    if (!setup.accountId) throw new Error("Verified fixture is missing its account identity");
    accountId = setup.accountId;
    const policy = new PostgresWalletPolicyStore(pool);
    await policy.activate({ expectedRevision: 0, nextRevision: 1, configuration: { version: "center-wallet-policy-v1",
      applications: [{ origin: appOrigin, walletCallbacks: [`${appOrigin}/callback`] }] } });
    const central = createWalletSite({ origin: issuer, audience, browserScript: productionScript, policy,
      login: new PostgresWalletLoginStore(pool, { rpId: "localhost", origin: issuer }),
      handoff: new PostgresWalletHandoffStore(pool, { issuer, audience }),
      // The existing fixture installs genuine enrollment/setup identity and a bounded synthetic
      // authority observation. This adapter does not claim a live-chain refresh or deployment.
      refresh: { request: async () => ({ status: "queued" }), tick: async () => ({}) } });
    const api = new Hono();
    api.use("*", cors({ origin: appOrigin, credentials: false, allowMethods: ["GET", "OPTIONS"], allowHeaders: [...Object.values(REST_AUTH_HEADERS), "Content-Type"] }));
    api.route("/api/v1", createRestAuthRouter(createRestAuth({ store: new PostgresAccountStore(pool), audience }), {
      requestTarget: context => new URL(context.req.url).pathname,
      onAuthenticated: principal => { authenticated.push({ kind: principal.kind ?? "legacy", isOwner: principal.isOwner, accountId: principal.account.id }); },
    }));
    dispatch = getRequestListener(async request => {
      const response = await central.fetch(request), path = new URL(request.url).pathname;
      transport.push({ path, method: request.method, origin: request.headers.get("origin"), cookie: request.headers.has("cookie"), status: response.status });
      if (path === "/wallet/login/complete" && response.ok && truncateCompletion && !truncated) {
        truncated = true;
        // Hono and PostgreSQL completed normally. Preserve accepted Set-Cookie headers but
        // truncate the success body before the browser can observe its session receipt.
        await response.body?.cancel();
        return new Response('{"session":', { status: response.status, headers: response.headers });
      }
      return response;
    });
    apiDispatch = getRequestListener(async request => {
      const response = await api.fetch(request);
      transport.push({ path: new URL(request.url).pathname, method: request.method, origin: request.headers.get("origin"), cookie: request.headers.has("cookie"), status: response.status });
      return response;
    });
    const context = await browser.newContext({ viewport: { width: 800, height: 650 } });
    context.on("request", request => {
      const origin = new URL(request.url()).origin;
      if (![issuer, appOrigin, audience].includes(origin)) externalRequests.push(origin);
    });
    page = await context.newPage(); page.setDefaultTimeout(5_000);
    page.on("pageerror", error => pageErrors.push(error.name));
    cdp = await context.newCDPSession(page); await cdp.send("WebAuthn.enable");
    ({ authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
      protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
    } }));
    // Import the actual private key whose W3 enrollment/P256 possession was verified by the
    // real store. Browser navigator.credentials.get must sign every production login challenge.
    await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: {
      credentialId: encode(setup.credential.credentialId), privateKey: setup.credential.key.export({ format: "der", type: "pkcs8" }).toString("base64"),
      userHandle: encode(setup.credential.userHandle), rpId: "localhost", isResidentCredential: true, signCount: 0,
      backupEligibility: setup.record.candidate!.backupEligible, backupState: setup.record.candidate!.backedUp,
    } });
    await page.addInitScript(() => {
      const original = navigator.credentials.get.bind(navigator.credentials);
      (window as any).nativePasskeyRequests = 0;
      navigator.credentials.get = options => { (window as any).nativePasskeyRequests++; return original(options); };
    });
  }, 20_000);

  afterEach(async () => {
    const results = await Promise.allSettled([page?.context().close(), close(centerServer), close(appServer), close(apiServer)]);
    // Closing sockets does not stop an already running Hono/SQL operation.
    // Drain those operations before the next case truncates the shared schema.
    results.push(...await Promise.allSettled([...activeRequests]));
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }, 20_000);
  afterAll(async () => {
    const results: PromiseSettledResult<unknown>[] = await Promise.allSettled([browser?.close(), pool?.end()]);
    if (admin) {
      results.push(...await Promise.allSettled([admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)]));
      results.push(...await Promise.allSettled([admin.end()]));
    }
    if (results.some(result => result.status === "rejected")) throw new Error("Browser/PG integration cleanup failed");
  }, 15_000);

  async function prepare() {
    await page.goto(appOrigin); await appState("ready");
    await page.locator("#app-connect").click();
    await expect.poll(() => new URL(page.url()).origin).toBe(issuer);
    await uiState("ready");
    expect(await page.evaluate(() => (window as any).nativePasskeyRequests)).toBe(0);
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: fileURLToPath(new URL("production-wallet-login.png", output)), fullPage: true });
    await page.locator("#wallet-signin").click();
  }
  async function finish() {
    await expect.poll(() => new URL(page.url()).origin).toBe(appOrigin);
    await appState("connected");
    expect(page.url()).toBe(`${appOrigin}/callback`);
    expect(await page.locator("#app-account").textContent()).toBe(accountId);
    const calls = transport.filter(item => item.path.startsWith("/wallet/handoff/") && item.method === "POST");
    expect(calls.map(item => item.status)).toEqual([201, 200]);
    expect(calls.every(item => !item.cookie && item.origin === appOrigin)).toBe(true);
    await page.screenshot({ path: fileURLToPath(new URL("connected-app.png", output)), fullPage: true });
    await page.locator("#app-read").click(); await appState("verified");
    expect(authenticated).toEqual([{ kind: "wallet-app", isOwner: false, accountId }]);
    expect(pageErrors).toEqual([]); expect(externalRequests).toEqual([]);
  }

  it("connects the actual app helper through native login, reads the signed account, blocks app cookie access and revokes on logout", async () => {
    await prepare(); await finish();
    const spoofed = await page.evaluate(async issuer => {
      try { await fetch(`${issuer}/wallet/logout`, { method: "POST", credentials: "include",
        headers: { "content-type": "application/json", "x-center-wallet-request": "1" }, body: "{}" }); return false; }
      catch { return true; }
    }, issuer);
    expect(spoofed).toBe(true);
    expect(transport.filter(item => item.path === "/wallet/logout")).toEqual([
      expect.objectContaining({ method: "OPTIONS", status: 403 }),
    ]);
    expect((await pool.query("SELECT count(*)::int AS n FROM rest_wallet_logins WHERE revoked_at_ms IS NOT NULL")).rows[0].n).toBe(0);
    const centerPage = await page.context().newPage();
    await centerPage.goto(`${issuer}/wallet`);
    await expect.poll(() => centerPage.locator("#wallet-status").getAttribute("data-state")).toBe("signed-in");
    await centerPage.locator("#wallet-logout").click();
    await expect.poll(() => centerPage.locator("#wallet-status").getAttribute("data-state")).toBe("ready");
    await page.locator("#app-read").click(); await appState("rejected");
    expect(transport.filter(item => item.path === "/api/v1/accounts/me" && item.method === "GET").map(item => item.status)).toEqual([200, 403]);
    expect((await pool.query("SELECT count(*)::int AS n FROM rest_wallet_logins WHERE revoked_at_ms IS NOT NULL")).rows[0].n).toBe(1);
    const resultCounts = (await pool.query(`SELECT
      (SELECT count(*)::int FROM rest_wallet_logins WHERE completed_at_ms IS NOT NULL) AS sessions,
      (SELECT count(*)::int FROM rest_wallet_handoffs WHERE state='consumed') AS handoffs,
      (SELECT count(*)::int FROM rest_wallet_app_grants) AS grants`)).rows[0];
    expect(resultCounts).toEqual({ sessions: 1, handoffs: 1, grants: 1 });
    await mkdir(output, { recursive: true });
    await page.locator("#app-status").screenshot({ path: fileURLToPath(new URL("signed-read-revoked.png", output)) });
    await writeFile(new URL("summary.json", output), JSON.stringify({ observedAt: new Date().toISOString(),
      testCase: "browser login, credentialless handoff, signed account read and logout revocation", tier: "virtual-authenticator",
      browserVersion: browser.version(), databaseMajor, productionWalletBundle: true, productionAppHelper: true,
      realHonoRoutes: true, realPostgresStores: true, realWebAuthnAssertion: true, appCookieMutationRejected: true,
      logoutRevokedAppRead: true, resultCounts, signedReadStatuses: [200, 403], syntheticChainReadiness: true,
      physicalDeviceObserved: false, fundedPaymentObserved: false }, null, 2), { mode: 0o600 });
  }, 25_000);

  it("recovers a truncated committed login response with the same browser credential and one durable session", async () => {
    truncateCompletion = true;
    await prepare(); await uiState("retry");
    expect(truncated).toBe(true);
    expect(await page.evaluate(() => (window as any).nativePasskeyRequests)).toBe(1);
    const cookies = await page.context().cookies(issuer);
    expect(cookies.some(cookie => cookie.name === walletSessionCookie)).toBe(true);
    expect(cookies.some(cookie => cookie.name === walletFlowCookie)).toBe(false);
    await page.locator("#wallet-retry").click(); await finish();
    // CDP's credential counter survives both top-level navigations; a page-local wrapper
    // counter alone cannot prove that recovery avoided a second signed assertion.
    const counters = (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials
      .map((credential: { signCount: number }) => credential.signCount);
    expect(counters).toEqual([1]);
    expect(transport.filter(item => item.path === "/wallet/login/complete")).toHaveLength(1);
    const counts = (await pool.query(`SELECT
      (SELECT count(*)::int FROM rest_wallet_logins WHERE completed_at_ms IS NOT NULL) AS sessions,
      (SELECT count(*)::int FROM rest_wallet_handoffs WHERE state='consumed') AS handoffs,
      (SELECT count(*)::int FROM rest_wallet_app_grants) AS grants`)).rows[0];
    expect(counts).toEqual({ sessions: 1, handoffs: 1, grants: 1 });
    expect(pageErrors).toEqual([]);
    await writeFile(new URL("response-recovery.json", output), JSON.stringify({ observedAt: new Date().toISOString(),
      testCase: "committed login body truncated after session cookie acceptance", tier: "virtual-authenticator",
      browserVersion: browser.version(), databaseMajor, productionWalletBundle: true, productionAppHelper: true,
      originalSessionRecovered: true, nativeLoginAssertions: counters[0], completionPosts: 1, resultCounts: counts,
      syntheticChainReadiness: true, physicalDeviceObserved: false, fundedPaymentObserved: false }, null, 2), { mode: 0o600 });
  }, 25_000);
  it('rejects a copied intent in a different signed-in browser and preserves the original app connection', async () => {
    await page.goto(appOrigin); await appState('ready');await page.locator('#app-connect').click();await uiState('ready');
    const copied=page.url(), intentId=new URL(copied).searchParams.get('intent');
    const attacker=await createWalletLoginSetup(pool,{origin:issuer,rpId:'localhost',lifetimeMs:30000});
    expect(attacker.accountId).not.toBe(accountId);
    const context=await browser.newContext();
    try {
      const other=await context.newPage(), control=await context.newCDPSession(other);
      await control.send('WebAuthn.enable');
      const {authenticatorId:otherId}=await control.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',ctap2Version:'ctap2_1',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
      await control.send('WebAuthn.addCredential',{authenticatorId:otherId,credential:{credentialId:encode(attacker.credential.credentialId),
        privateKey:attacker.credential.key.export({format:'der',type:'pkcs8'}).toString('base64'),userHandle:encode(attacker.credential.userHandle),rpId:'localhost',isResidentCredential:true,signCount:0,
        backupEligibility:attacker.record.candidate!.backupEligible,backupState:attacker.record.candidate!.backedUp}});
      await other.goto(issuer+'/wallet');
      await expect.poll(()=>other.locator('#wallet-status').getAttribute('data-state')).toBe('ready');
      await other.locator('#wallet-signin').click();
      await expect.poll(()=>other.locator('#wallet-status').getAttribute('data-state')).toBe('signed-in');
      await other.goto(copied);
      await expect.poll(()=>transport.filter(x=>x.path==='/wallet/authorize/issue').at(-1)?.status).toBe(403);
      expect((await pool.query('SELECT state,session_id,code_hash FROM rest_wallet_handoffs WHERE id=$1',[intentId])).rows[0]).toEqual({state:'prepared',session_id:null,code_hash:null});
      expect((await pool.query('SELECT count(*)::int AS n FROM rest_wallet_app_grants')).rows[0].n).toBe(0);
    } finally {await context.close();}
    await page.locator('#wallet-signin').click(); await finish();
    const account=(await pool.query('SELECT account_id FROM rest_wallet_app_grants')).rows[0].account_id;
    expect(account).toBe(accountId);
  },25000);

  it('keeps the older tab unclaimed after a newer tab replaces the single browser launch',async()=>{
    await page.goto(appOrigin);await appState('ready');await page.locator('#app-connect').click();await uiState('ready');
    const originalId=new URL(page.url()).searchParams.get('intent');
    const newer=await page.context().newPage();
    try {
      await newer.goto(appOrigin);await expect.poll(()=>newer.locator('#app-status').getAttribute('data-state')).toBe('ready');
      await newer.locator('#app-connect').click();await expect.poll(()=>newer.locator('#wallet-status').getAttribute('data-state')).toBe('ready');
      const newerId=new URL(newer.url()).searchParams.get('intent');expect(newerId).not.toBe(originalId);
      await page.locator('#wallet-signin').click();
      await expect.poll(()=>transport.filter(x=>x.path==='/wallet/authorize/issue').at(-1)?.status).toBe(403);
      expect((await pool.query('SELECT state,session_id FROM rest_wallet_handoffs WHERE id=$1',[originalId])).rows[0]).toEqual({state:'prepared',session_id:null});
      await newer.reload();await expect.poll(()=>new URL(newer.url()).origin).toBe(appOrigin);
      await expect.poll(()=>newer.locator('#app-status').getAttribute('data-state')).toBe('connected');
      expect((await pool.query('SELECT state FROM rest_wallet_handoffs WHERE id=$1',[newerId])).rows[0].state).toBe('consumed');
      expect((await pool.query('SELECT count(*)::int AS n FROM rest_wallet_app_grants')).rows[0].n).toBe(1);
    } finally {await newer.close();}
  },25000);
});
