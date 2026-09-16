import { createServer, request as httpRequest, type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getRequestListener } from "@hono/node-server";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletSite } from "../src/rest/wallet/site.js";
import { walletFlowCookie, walletSessionCookie } from "../src/rest/wallet/http.js";
import { PostgresWalletLoginStore } from "../src/rest/wallet/loginPostgres.js";
import { PostgresWalletHandoffStore } from "../src/rest/wallet/handoffPostgres.js";
import { PostgresWalletPolicyStore } from "../src/rest/wallet/policyPostgres.js";
import { PostgresWalletAuthorityStore } from "../src/rest/wallet/authorityPostgres.js";
import { PostgresWalletAuthorityRefreshQueue } from "../src/rest/wallet/authorityRefreshPostgres.js";
import { createWalletAuthorityRefresh } from "../src/rest/wallet/authorityRefresh.js";
import { walletAuthorityContextDigest, walletAuthorityExpectedAnchor } from "../src/rest/wallet/authority.js";
import { walletHandoffCodeHash, walletHandoffExchangeDocument, walletHandoffPkceChallenge,
  walletHandoffRequestDocument, walletHandoffLaunchDocument, type WalletHandoffRequest } from "../src/rest/wallet/handoff.js";
import { walletAppPrincipalId } from "../src/rest/wallet/appGrants.js";
import { createRestAuth } from "../src/rest/auth/service.js";
import { PostgresAccountStore } from "../src/rest/auth/postgres.js";
import { RestAuthError } from "../src/rest/auth/store.js";
import { RestError } from "../src/rest/core.js";
import { SignedRestClient } from "../src/rest/client/index.js";
import { createWalletLoginSetup, walletLoginTestMigrations, walletLoginFixtureOrigin as issuer,
  walletLoginFixtureRpId as rpId } from "./fixtures/wallet-login-setup.js";
import { signGet } from "./fixtures/wallet-enrollment-crypto.js";

const connectionString = process.env.TEST_DATABASE_URL, suite = connectionString ? describe : describe.skip;
const schema = `wallet_site_${randomUUID().replaceAll("-", "")}`;
const audience = "https://juicebox.center", appOrigin = "https://beep.biz";
const appKey = privateKeyToAccount(`0x${"73".repeat(32)}`);
const token = () => randomBytes(32).toString("base64url");
let admin: Pool, database: Pool, pool: Pool, clockOffsetMs = 0;
const servers: Server[] = [], workers: ReturnType<typeof createWalletAuthorityRefresh>[] = [];

/** Test-only elapsed-time seam. All actual PG rows and original signed login bytes remain
 * unchanged. The main HTTP journey uses offset zero; recovery cases explicitly advance both
 * browser cookie age and SQL clock observations without waiting three wall-clock minutes. */
function observedClockPool(base: Pool): Pool {
  const argsWithClock = (args: any[]) => {
    if (!clockOffsetMs || typeof args[0] !== "string") return args;
    if (!Number.isSafeInteger(clockOffsetMs) || clockOffsetMs < 0 || clockOffsetMs > 300_000) throw new Error("Fixture clock bound exceeded");
    return [args[0].replaceAll("clock_timestamp()", `(clock_timestamp() + interval '${clockOffsetMs} milliseconds')`), ...args.slice(1)];
  };
  const wrapped = Object.create(base) as Pool;
  wrapped.query = ((...args: any[]) => (base.query as any)(...argsWithClock(args))) as Pool["query"];
  wrapped.connect = (async () => {
    const client = await base.connect(), query = client.query.bind(client);
    return new Proxy(client, { get(target, property) {
      if (property === "query") return (...args: any[]) => (query as any)(...argsWithClock(args));
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
  }) as Pool["connect"];
  return wrapped;
}
async function nowMs() {
  return Number((await pool.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now")).rows[0].now);
}
class CookieJar {
  private readonly cookies = new Map<string, { value: string; expiresAt: number }>();
  accept(response: Response) {
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(";"), at = pair!.indexOf("="), name = pair!.slice(0, at), value = pair!.slice(at + 1);
      const maxAge = Number(/(?:^|;)\s*Max-Age=(\d+)(?:;|$)/i.exec(raw)?.[1]);
      if (!Number.isSafeInteger(maxAge)) throw new Error("Fixture cookie lacks a bounded age");
      if (maxAge === 0) this.cookies.delete(name);
      else this.cookies.set(name, { value, expiresAt: Date.now() + clockOffsetMs + maxAge * 1000 });
    }
  }
  value(name: string) {
    const saved = this.cookies.get(name);
    if (!saved || saved.expiresAt <= Date.now() + clockOffsetMs) { this.cookies.delete(name); return null; }
    return saved.value;
  }
  header() { return [walletFlowCookie, walletSessionCookie, '__Host-center-wallet-launch'].flatMap(name => this.value(name) ? [`${name}=${this.value(name)}`] : []).join("; "); }
}
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture listener unavailable");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Wallet HTTP fixture did not close")), 5000);
    server.close(error => { clearTimeout(timer); if (error) reject(error); else resolve(); });
  });
}
/** Native HTTP preserves the configured proxy Host. Node fetch replaces it with the local
 * connection host, which would correctly fail the site's production Host check. */
function httpFetch(url: string, init: RequestInit = {}, dropBody = false): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers)),
      ...(init.signal ? { signal: init.signal } : {}) }, response => {
      const headers = new Headers();
      for (let i = 0; i < response.rawHeaders.length; i += 2) headers.append(response.rawHeaders[i]!, response.rawHeaders[i + 1]!);
      if (dropBody) {
        response.destroy();
        const body = new ReadableStream({ start(controller) { controller.error(new Error("Fixture response disconnected")); } });
        resolve(new Response(body, { status: response.statusCode!, headers })); return;
      }
      let size = 0; const chunks: Buffer[] = [];
      response.on("data", chunk => { size += chunk.length; if (size > 65536) request.destroy(new Error("Fixture response exceeded bound")); else chunks.push(Buffer.from(chunk)); });
      response.on("error", reject);
      response.on("end", () => resolve(new Response(response.statusCode === 204 ? null : Buffer.concat(chunks), { status: response.statusCode!, headers })));
    });
    request.on("error", reject);
    if (init.body !== undefined && init.body !== null) {
      if (typeof init.body !== "string" && !(init.body instanceof Uint8Array)) { request.destroy(); reject(new Error("Unsupported fixture request body")); return; }
      request.write(init.body);
    }
    request.end();
  });
}
async function start() {
  const setup = await createWalletLoginSetup(pool), authority = new PostgresWalletAuthorityStore(pool);
  const policy = new PostgresWalletPolicyStore(pool);
  await policy.activate({ expectedRevision: 0, nextRevision: 1, configuration: { version: "center-wallet-policy-v1",
    applications: [{ origin: appOrigin, walletCallbacks: [`${appOrigin}/wallet/callback`] }] } });
  let observerAvailable = true, observations = 0;
  const refresh = createWalletAuthorityRefresh({ queue: new PostgresWalletAuthorityRefreshQueue(pool), concurrency: 1,
    // The observer is explicitly synthetic. Queueing, leases, context checks and reconciliation
    // are the real production implementations; no browser or live-chain claim follows.
    service: { async refreshAuthority(accountId) {
      if (!observerAvailable) throw new Error("Synthetic observer unavailable");
      const context = await authority.loadContext(accountId), observedAtMs = await nowMs();
      const expected = walletAuthorityExpectedAnchor(context), identity = context.prior?.identity;
      if (!identity) throw new Error("Fixture requires its genuine enrolled/setup identity");
      const blockNumber = (BigInt(context.prior?.highestObservedBlock ?? "100") + 1n).toString();
      observations++;
      return authority.reconcile(context, { version: "center-wallet-authority-observation-v1", accountId,
        contextDigest: walletAuthorityContextDigest(context), observedAtMs, validUntilMs: observedAtMs + 30_000,
        head: { chainId: 8453, blockNumber, blockHash: keccak256(toHex(`wallet-site-fixture-${blockNumber}`)),
          timestamp: String(Math.floor(observedAtMs / 1000)), source: "onchain" },
        priorAnchor: { status: expected ? "same" : "none", expected, observed: expected },
        identity, eligibility: "matched", reason: null });
    } }, now: () => Date.now() + clockOffsetMs });
  workers.push(refresh);
  const events: Array<{ action: string; outcome: string; code?: string }> = [];
  const site = createWalletSite({ origin: issuer, audience, browserScript: "", policy, refresh,
    login: new PostgresWalletLoginStore(pool, { rpId, origin: issuer }),
    handoff: new PostgresWalletHandoffStore(pool, { issuer, audience }), onEvent: event => events.push(event) });
  // Real loopback HTTP with the configured Host models the existing TLS-terminating proxy.
  // The test deliberately manages cookie headers; it is not a browser secure-cookie pilot.
  const transports: Array<{ host: string | null; origin: string | null; site: string | null }> = [];
  const base = await listen(createServer(getRequestListener(request => {
    transports.push({ host: request.headers.get("host"), origin: request.headers.get("origin"), site: request.headers.get("sec-fetch-site") });
    return site.fetch(request);
  })));
  const auth = createRestAuth({ store: new PostgresAccountStore(pool), audience });
  const api = await listen(createServer(async (request, response) => {
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(",") : value);
      const principal = await auth.authenticate({ headers, body: new Uint8Array(), method: request.method ?? "GET",
        requestTarget: request.url ?? "/", contentType: headers.get("content-type") ?? "", signal: AbortSignal.timeout(5000) }, ["read"]);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ accountId: principal.account.id, principalId: principal.principalId,
        kind: principal.kind, isOwner: principal.isOwner, grantId: principal.grantId }));
    } catch (error) {
      const known = error instanceof RestError || error instanceof RestAuthError;
      response.writeHead(known ? error.status : 503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: known ? error.code : "FIXTURE_ERROR" } }));
    }
  }));
  const post = (path: string, body: unknown, jar?: CookieJar, extra: Record<string, string> = {}, dropBody = false) => httpFetch(base + path, {
    method: "POST", headers: { host: new URL(issuer).host, origin: issuer, "sec-fetch-site": "same-origin",
      "content-type": "application/json", "x-center-wallet-request": "1", ...(jar?.header() ? { cookie: jar.header() } : {}), ...extra },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000) }, dropBody);
  const getSession = (jar: CookieJar) => httpFetch(base + "/wallet/session", {
    headers: { host: new URL(issuer).host, cookie: jar.header() }, signal: AbortSignal.timeout(15000) });
  const launch = (intentId: string, signature: string) => httpFetch(base + '/wallet/launch', {
    method:'POST', headers:{host:new URL(issuer).host,origin:appOrigin,'sec-fetch-mode':'navigate','sec-fetch-dest':'document','content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({intentId,signature}).toString(), signal:AbortSignal.timeout(15000) });
  async function begin(jar: CookieJar) {
    const response = await post("/wallet/login/begin", {}, jar); expect(response.status, JSON.stringify(transports)).toBe(201); jar.accept(response);
    const body = await response.json();
    const assertion = signGet({ ...setup.credential, challenge: `0x${Buffer.from(body.publicKey.challenge, "base64url").toString("hex")}`,
      rpId, origin: issuer });
    const input = { loginId: body.loginId, assertion: { ...assertion,
      authenticatorData: Buffer.from(assertion.authenticatorData).toString("base64url"),
      clientDataJSON: Buffer.from(assertion.clientDataJSON).toString("base64url"), signature: Buffer.from(assertion.signature).toString("base64url") } };
    return { input, csrf: body.csrfToken as string, expiresAtMs: body.expiresAtMs as number };
  }
  return { setup, post, getSession, begin, events, api, refresh, launch,
    observe: () => observations, outage: (value: boolean) => { observerAvailable = !value; } };
}

suite("real wallet HTTP sign-in, PostgreSQL handoff and signed app requests", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
    database = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 1 }); pool = observedClockPool(database);
    for (const name of [...walletLoginTestMigrations, "023_wallet_authority_refresh.sql", "040_wallet_authority_refresh_settings.sql", "024_wallet_handoff.sql", "047_wallet_handoff_window.sql"])
      await pool.query(await readFile(new URL(`../src/db/migrations/${name}`, import.meta.url), "utf8"));
  });
  beforeEach(async () => {
    clockOffsetMs = 0;
    await pool.query(`TRUNCATE rest_wallet_handoffs,rest_wallet_authority_refresh_jobs,rest_wallet_authority_refresh_control,
      rest_wallet_logins,rest_wallet_policy_apps,rest_wallet_policy,rest_wallet_app_grants,rest_wallet_authority,
      rest_grant_ids,rest_bot_grants,rest_request_nonces,rest_smart_account_binding_nonces,rest_smart_account_bindings,
      rest_accounts,rest_wallet_credentials,rest_wallet_enrollments,rest_wallet_ceremonies CASCADE`);
    await pool.query("INSERT INTO rest_wallet_authority_refresh_control(id,window_start_ms,starts_in_window) VALUES(1,0,0)");
  });
  afterEach(async () => { await Promise.all(workers.splice(0).map(worker => worker.stop())); await Promise.all(servers.splice(0).map(close)); });
  afterAll(async () => { await database?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } });

  it("signs in with P256, exchanges an app-key/S256 handoff without cookies, authenticates SignedRestClient, then revokes it through HTTP logout", async () => {
    const value = await start(), jar = new CookieJar(), begun = await value.begin(jar);
    expect((await value.post("/wallet/login/complete", begun.input, jar)).status).toBe(403);
    const completed = await value.post("/wallet/login/complete", begun.input, jar, { "x-center-wallet-csrf": begun.csrf });
    expect(completed.status).toBe(200); jar.accept(completed);
    const login = await completed.json(); expect(login.session.accountId).toBe(value.setup.accountId);
    expect(jar.value(walletFlowCookie)).toBeNull(); expect(jar.value(walletSessionCookie)).not.toBeNull();
    expect(value.observe()).toBeGreaterThan(0); expect((await value.refresh.stats()).startsInWindow).toBeGreaterThan(0);
    const verifier = token(), issuedAtMs = await nowMs();
    const request: WalletHandoffRequest = { version: "center-wallet-handoff-request-v1", issuer, audience, origin: appOrigin,
      callbackUri: `${appOrigin}/wallet/callback`, appGeneration: 1, requestKey: appKey.address,
      state: token(), codeChallenge: walletHandoffPkceChallenge(verifier), nonce: `0x${randomBytes(32).toString("hex")}`,
      issuedAtMs, expiresAtMs: issuedAtMs + 120_000 };
    const prepared = await value.post("/wallet/handoff/prepare", { request, signature: await appKey.signTypedData(walletHandoffRequestDocument(request)) },
      undefined, { origin: appOrigin, "sec-fetch-site": "cross-site" });
    expect(prepared.status).toBe(201); const intent = await prepared.json();
    const unclaimed = await value.post('/wallet/authorize/issue',{intentId:intent.id},jar,{'x-center-wallet-csrf':login.csrfToken});
    expect(unclaimed.status).toBe(403);expect((await unclaimed.json()).error.code).toBe('WALLET_HANDOFF_UNCLAIMED');
    const launched = await value.launch(intent.id, await appKey.signTypedData(walletHandoffLaunchDocument({request,intentId:intent.id})));
    expect(launched.status).toBe(303);jar.accept(launched);
    const issued = await value.post("/wallet/authorize/issue", { intentId: intent.id }, jar, { "x-center-wallet-csrf": login.csrfToken });
    expect(issued.status).toBe(200); const redirect = new URL((await issued.json()).redirectUri);
    expect(redirect.origin + redirect.pathname).toBe(request.callbackUri); expect(redirect.searchParams.get("state")).toBe(request.state);
    expect(redirect.searchParams.get("iss")).toBe(issuer);
    const code = redirect.searchParams.get("code")!;
    const exchange = { request, intentId: intent.id, code, verifier,
      signature: await appKey.signTypedData(walletHandoffExchangeDocument({ request, intentId: intent.id, codeHash: walletHandoffCodeHash(code) })) };
    const cookieRejected = await value.post("/wallet/handoff/exchange", exchange, jar, { origin: appOrigin, "sec-fetch-site": "cross-site" });
    expect(cookieRejected.status).toBe(403);
    const exchanged = await value.post("/wallet/handoff/exchange", exchange, undefined, { origin: appOrigin, "sec-fetch-site": "cross-site" });
    expect(exchanged.status).toBe(200); expect(exchanged.headers.get("access-control-allow-credentials")).toBeNull();
    expect(exchanged.headers.get("access-control-allow-origin")).toBe(appOrigin);
    const result = await exchanged.json(); expect(result.replayed).toBe(false);
    const client = new SignedRestClient({ audience, accountId: value.setup.accountId, signer: appKey, grantId: result.grant.id,
      fetch: async (url, init) => {
        expect(init?.credentials).toBe("omit"); const target = new URL(String(url)); expect(target.origin).toBe(audience);
        const headers = new Headers(init?.headers); headers.set("host", new URL(audience).host); headers.set("origin", appOrigin);
        return httpFetch(value.api + target.pathname + target.search, { ...init, headers });
      } });
    expect(await client.request({ requestTarget: "/api/v1/accounts/me" })).toEqual({ accountId: value.setup.accountId,
      principalId: walletAppPrincipalId(result.grant), kind: "wallet-app", isOwner: false, grantId: result.grant.id });
    const loggedOut = await value.post("/wallet/logout", {}, jar, { "x-center-wallet-csrf": login.csrfToken });
    expect(loggedOut.status).toBe(200); jar.accept(loggedOut); expect(jar.value(walletSessionCookie)).toBeNull();
    await expect(client.request({ requestTarget: "/api/v1/accounts/me" })).rejects.toMatchObject({ status: 403 });
    expect(value.events).toEqual(expect.arrayContaining([{ action: "login_complete", outcome: "ok" }, { action: "handoff_exchange", outcome: "ok" }, { action: "logout", outcome: "ok" }]));
  }, 15000);

  it("recovers the identical session when complete response headers are lost and the original challenge later expires", async () => {
    const value = await start(), jar = new CookieJar(), begun = await value.begin(jar), flow = jar.value(walletFlowCookie);
    const lost = await value.post("/wallet/login/complete", begun.input, jar, { "x-center-wallet-csrf": begun.csrf }, true);
    expect(lost.status).toBe(200);
    const oracle = new CookieJar(); oracle.accept(lost); const originalSession = oracle.value(walletSessionCookie);
    await lost.body?.cancel().catch(() => {}); // The client accepts neither headers nor body from this disconnected response.
    clockOffsetMs = 181_000;
    expect(await nowMs()).toBeGreaterThan(begun.expiresAtMs);
    expect(jar.value(walletFlowCookie)).toBe(flow); expect(jar.value(walletSessionCookie)).toBeNull();
    const recovered = await value.post("/wallet/login/complete", begun.input, jar, { "x-center-wallet-csrf": begun.csrf });
    expect(recovered.status).toBe(200); jar.accept(recovered);
    expect((await recovered.json()).replayed).toBe(true); expect(jar.value(walletSessionCookie)).toBe(originalSession);
    expect((await pool.query("SELECT count(*)::int AS count FROM rest_wallet_logins WHERE completed_at_ms IS NOT NULL")).rows[0].count).toBe(1);
  }, 15000);

  it("recovers via GET session after the browser accepted complete cookies but lost its response body", async () => {
    const value = await start(), jar = new CookieJar(), begun = await value.begin(jar);
    const response = await value.post("/wallet/login/complete", begun.input, jar, { "x-center-wallet-csrf": begun.csrf }, true);
    expect(response.status).toBe(200); jar.accept(response);
    await expect(response.json()).rejects.toThrow("Fixture response disconnected");
    const originalCookie = jar.value(walletSessionCookie), recovered = await value.getSession(jar);
    expect(recovered.status).toBe(200); const body = await recovered.json();
    expect(body.session.accountId).toBe(value.setup.accountId); expect(body.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(jar.value(walletSessionCookie)).toBe(originalCookie);
  }, 15000);

  it("shows the account during an observer outage and restores the same session through the real refresh queue", async () => {
    const value = await start(), jar = new CookieJar(), begun = await value.begin(jar);
    const completed = await value.post("/wallet/login/complete", begun.input, jar, { "x-center-wallet-csrf": begun.csrf });
    expect(completed.status).toBe(200); jar.accept(completed); await completed.body?.cancel();
    const originalCookie = jar.value(walletSessionCookie); value.outage(true); clockOffsetMs = 31_000;
    // The account still shows while its authority record is stale; the refresh runs in the background.
    const stale = await value.getSession(jar); expect(stale.status).toBe(200);
    expect((await stale.json()).session.accountId).toBe(value.setup.accountId); jar.accept(stale);
    expect(jar.value(walletSessionCookie)).toBe(originalCookie);
    value.outage(false); clockOffsetMs += 3000;
    const recovered = await value.getSession(jar); expect(recovered.status).toBe(200);
    expect((await recovered.json()).session.accountId).toBe(value.setup.accountId);
    expect(jar.value(walletSessionCookie)).toBe(originalCookie);
  }, 15000);
});
