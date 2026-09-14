import { fork, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { hashTypedData, keccak256, toHex } from "viem";
import { migrate } from "../src/db/migrate.js";
import { PostgresWalletPolicyStore } from "../src/rest/wallet/policyPostgres.js";
import { validateWalletHandoffRequest, walletHandoffCodeHash, walletHandoffExchangeDocument, walletHandoffPkceChallenge,
  walletHandoffRequestDocument, walletHandoffLaunchDocument, type WalletHandoffExchangeInput, type WalletHandoffRequest } from "../src/rest/wallet/handoff.js";
import { PostgresWalletHandoffStore, type WalletHandoffStoreOptions } from "../src/rest/wallet/handoffPostgres.js";
import { PostgresWalletAppGrantStore } from "../src/rest/wallet/appGrantsPostgres.js";
import { PostgresWalletLoginStore } from "../src/rest/wallet/loginPostgres.js";
import { createWalletLoginDraft } from "../src/rest/wallet/login.js";
import { PostgresWalletAuthorityStore } from "../src/rest/wallet/authorityPostgres.js";
import { walletAuthorityContextDigest, walletAuthorityExpectedAnchor } from "../src/rest/wallet/authority.js";
import { completeWalletLoginFixture, walletLoginFixtureOrigin, walletLoginFixtureRpId } from "./fixtures/wallet-login-setup.js";

const connectionString = process.env.TEST_DATABASE_URL, suite = connectionString ? describe : describe.skip;
const schema = `wallet_handoff_${randomUUID().replaceAll("-", "")}`;
const issuer = "https://wallet.juicebox.center", audience = "https://juicebox.center";
const origin = "https://beep.biz", secondOrigin = "https://juicebox.money";
const appKey = privateKeyToAccount(`0x${"61".repeat(32)}`), otherKey = privateKeyToAccount(`0x${"62".repeat(32)}`);
const token = () => randomBytes(32).toString("base64url");
const children = new Set<ChildProcess>();
let admin: Pool, pool: Pool, store: PostgresWalletHandoffStore;
type Options = Omit<WalletHandoffStoreOptions, "issuer" | "audience" | "grantStore">;
const options = (extra: Options = {}) => ({ issuer, audience, ...extra });
const policy = (origins = [origin, secondOrigin]) => ({ version: "center-wallet-policy-v1" as const,
  applications: origins.map(value => ({ origin: value, walletCallbacks: [`${value}/wallet/callback`] })) });

async function nowMs() {
  return Number((await pool.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now")).rows[0].now);
}
async function request(changes: Partial<WalletHandoffRequest> = {}) {
  const verifier = token(), issuedAtMs = await nowMs();
  const value: WalletHandoffRequest = { version: "center-wallet-handoff-request-v1", issuer, origin,
    callbackUri: `${origin}/wallet/callback`, audience, appGeneration: 1, requestKey: appKey.address,
    state: token(), codeChallenge: walletHandoffPkceChallenge(verifier), nonce: `0x${randomBytes(32).toString("hex")}`,
    issuedAtMs, expiresAtMs: issuedAtMs + 120_000, ...changes };
  const signature = await appKey.signTypedData(walletHandoffRequestDocument(value));
  return { request: value, signature, verifier };
}
async function exchangeInput(value: WalletHandoffRequest, intentId: string, code: string, verifier: string,
  key = appKey): Promise<WalletHandoffExchangeInput> {
  const signature = await key.signTypedData(walletHandoffExchangeDocument({ request: value, intentId, codeHash: walletHandoffCodeHash(code) }));
  return { request: value, intentId, code, verifier, signature };
}
async function counts() {
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM rest_wallet_handoffs) AS handoffs,
    (SELECT count(*)::int FROM rest_wallet_handoffs WHERE state='consumed') AS consumed,
    (SELECT count(*)::int FROM rest_wallet_app_grants) AS grants,
    (SELECT count(*)::int FROM rest_grant_ids WHERE kind='wallet-app') AS "grantIds"`)).rows[0];
}
function message(child: ChildProcess, kind: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Handoff fixture did not emit ${kind}`)), 12_000);
    const receive = (value: unknown) => {
      if (value && typeof value === "object" && "kind" in value && value.kind === kind) finish(undefined, value as Record<string, unknown>);
    };
    const exited = () => finish(new Error(`Handoff fixture exited before ${kind}`));
    const failed = () => finish(new Error("Handoff fixture process failed"));
    function finish(error?: Error, value?: Record<string, unknown>) {
      clearTimeout(timer); child.off("message", receive); child.off("exit", exited); child.off("error", failed);
      if (error) reject(error); else resolve(value!);
    }
    child.on("message", receive); child.once("exit", exited); child.once("error", failed);
  });
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) { children.delete(child); return; }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Handoff fixture did not terminate")), 5000);
    const exited = () => finish();
    function finish(error?: Error) {
      clearTimeout(timeout); child.off("exit", exited); children.delete(child);
      if (error) reject(error); else resolve();
    }
    child.once("exit", exited); child.kill("SIGKILL");
  });
}
async function worker(extra: Options & { grantLifetimeSeconds?: number } = {}) {
  const child = fork(fileURLToPath(new URL("./fixtures/wallet-handoff-process.ts", import.meta.url)), [], {
    execArgv: ["--import", "tsx"], env: { ...process.env, WALLET_HANDOFF_TEST_SCHEMA: schema,
      WALLET_HANDOFF_TEST_OPTIONS: JSON.stringify(extra) }, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  children.add(child); child.stderr?.resume();
  const ready = await message(child, "ready");
  return { child, backendPid: Number(ready.backendPid), request: async (body: unknown, appOrigin: string | null = origin) => {
    const headers = new Headers({ "content-type": "application/json" });
    if (appOrigin !== null) headers.set("origin", appOrigin);
    // Cross-site exchange sends no central cookie or other bearer credential.
    const response = await fetch(`http://127.0.0.1:${ready.port}`, { method: "POST", headers,
      body: JSON.stringify(body), credentials: "omit", signal: AbortSignal.timeout(12_000) });
    return { status: response.status, body: await response.json() as any };
  } };
}
async function waitingForLock(backendPid: number, expectedQuery?: RegExp) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const row = (await pool.query("SELECT wait_event_type,query FROM pg_stat_activity WHERE pid=$1", [backendPid])).rows[0];
    if (row?.wait_event_type === "Lock") {
      if (expectedQuery) expect(row.query).toMatch(expectedQuery);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Expected a real PostgreSQL handoff lock wait");
}
async function waitPast(deadline: number) {
  const remaining = deadline - await nowMs();
  if (remaining > 6000) throw new Error("Fixture deadline is not short and bounded");
  await pool.query("SELECT pg_sleep($1)", [Math.max(0, remaining + 30) / 1000]);
  expect(await nowMs()).toBeGreaterThan(deadline);
}
async function issuedHandoff(extra: Options = {}, readinessLifetimeMs = 30_000, requestLifetimeMs = 120_000) {
  // Real enrollment, setup consent and WebAuthn completion; canonical observation is explicitly synthetic.
  const login = await completeWalletLoginFixture(pool, { lifetimeMs: readinessLifetimeMs });
  const target = new PostgresWalletHandoffStore(pool, options(extra));
  const input = await request({ expiresAtMs: await nowMs() + requestLifetimeMs });
  const prepared = await target.prepare({ request: input.request, signature: input.signature }, origin);
  const launchSignature = await appKey.signTypedData(walletHandoffLaunchDocument({request:input.request,intentId:prepared.id}));
  const issued = await target.issue(prepared.id, login.session.id, launchSignature);
  return { login, target, input, prepared, issued, launchSignature,
    exchange: await exchangeInput(input.request, prepared.id, issued.code, input.verifier) };
}
async function handoffRow(id: string) {
  return (await pool.query("SELECT * FROM rest_wallet_handoffs WHERE id=$1", [id])).rows[0];
}
async function holdAccount(accountId: string) {
  const lock = await pool.connect(); await lock.query("BEGIN");
  await lock.query("SELECT id FROM rest_accounts WHERE id=$1 FOR UPDATE", [accountId]);
  return async () => { try { await lock.query("ROLLBACK"); } finally { lock.release(); } };
}
async function refreshSyntheticObservation(accountId: string) {
  const authority = new PostgresWalletAuthorityStore(pool), context = await authority.loadContext(accountId);
  const prior = context.prior!.latestObservation!, observedAtMs = await nowMs(), expected = walletAuthorityExpectedAnchor(context);
  const blockNumber = (BigInt(context.prior!.highestObservedBlock!) + 1n).toString();
  await authority.reconcile(context, { ...prior, contextDigest: walletAuthorityContextDigest(context), observedAtMs,
    validUntilMs: observedAtMs + 30_000, head: { ...prior.head!, blockNumber,
      blockHash: keccak256(toHex(`handoff-synthetic-block-${blockNumber}`)), timestamp: String(Math.floor(observedAtMs / 1000)) },
    priorAnchor: { status: "same", expected, observed: expected } });
}

suite("PostgreSQL wallet handoff with genuine request-key proofs and credentialless exchange", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 10_000 });
    const version = Number((await admin.query("SELECT current_setting('server_version_num') AS version")).rows[0].version);
    expect(Math.floor(version / 10_000)).toBe(16);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=10000`,
      max: 12, connectionTimeoutMillis: 5000, query_timeout: 10_000 });
    await migrate(pool); store = new PostgresWalletHandoffStore(pool, options());
  }, 20_000);
  beforeEach(async () => {
    await pool.query("TRUNCATE rest_wallet_handoffs,rest_accounts,rest_wallet_credentials,rest_wallet_enrollments,rest_wallet_ceremonies,rest_wallet_policy CASCADE");
    await new PostgresWalletPolicyStore(pool).activate({ expectedRevision: 0, nextRevision: 1, configuration: policy() });
  });
  afterEach(async () => {
    const results = await Promise.allSettled([...children].map(kill));
    for (const result of results) if (result.status === "rejected") throw result.reason;
  });
  afterAll(async () => {
    try { await pool?.end(); }
    finally { if (admin) { try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await admin.end(); } } }
  }, 15_000);

  it("prepares one immutable handoff from a genuine app request-key signature", async () => {
    const input = await request(), prepared = await store.prepare({ request: input.request, signature: input.signature }, origin);
    expect(prepared.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(prepared).toMatchObject({ state: "prepared", request: validateWalletHandoffRequest(input.request), expiresAtMs: input.request.expiresAtMs });
    expect(await store.getIntent(prepared.id)).toEqual(prepared);
    expect(await counts()).toEqual({ handoffs: 1, consumed: 0, grants: 0, grantIds: 0 });
    const row = (await pool.query("SELECT session_id,code_hash,grant_document FROM rest_wallet_handoffs WHERE id=$1", [prepared.id])).rows[0];
    expect(row).toEqual({ session_id: null, code_hash: null, grant_document: null });
  });
  it('keeps a copied intent prepared when the caller has no matching launch proof',async()=>{
    const login=await completeWalletLoginFixture(pool,{lifetimeMs:30000}), input=await request();
    const prepared=await store.prepare({request:input.request,signature:input.signature},origin);
    await expect(store.issue(prepared.id,login.session.id,undefined as never)).rejects.toMatchObject({code:'WALLET_HANDOFF_UNCLAIMED'});
    await expect(store.issue(prepared.id,login.session.id,input.signature)).rejects.toMatchObject({code:'WALLET_HANDOFF_SIGNATURE_INVALID'});
    const proof=walletHandoffLaunchDocument({request:input.request,intentId:prepared.id});
    await expect(store.issue(prepared.id,login.session.id,await otherKey.signTypedData(proof))).rejects.toMatchObject({code:'WALLET_HANDOFF_SIGNATURE_INVALID'});
    expect(await handoffRow(prepared.id)).toMatchObject({state:'prepared',session_id:null,code_hash:null});
    const signature=await appKey.signTypedData(proof);
    const issued=await store.issue(prepared.id,login.session.id,signature);
    expect(issued.callbackUri).toBe(input.request.callbackUri);
    await expect(store.issue(prepared.id,login.session.id,signature)).rejects.toMatchObject({code:'WALLET_HANDOFF_CONFLICT'});
  });

  it("reports handoff-specific validation errors for malformed preparation and configuration", async () => {
    await expect(store.prepare({} as never, origin)).rejects.toMatchObject({ status: 400, code: "WALLET_HANDOFF_INVALID" });
    expect(() => new PostgresWalletHandoffStore(pool, { ...options(), unrecognized: true } as never))
      .toThrowError(expect.objectContaining({ status: 400, code: "WALLET_HANDOFF_INVALID" }));
  });

  it.each([false, true])("rejects direct insertion of a pre-issued record with consumed=%s", async consumed => {
    const value = await issuedHandoff(); if (consumed) await value.target.exchange(value.exchange, origin);
    const source = await handoffRow(value.prepared.id);
    const clone = { ...source, id: token(), request_digest: `0x${randomBytes(32).toString("hex")}`,
      code_hash: `0x${randomBytes(32).toString("hex")}` };
    await expect(pool.query("INSERT INTO rest_wallet_handoffs SELECT * FROM jsonb_populate_record(NULL::rest_wallet_handoffs,$1::jsonb)",
      [JSON.stringify(clone)])).rejects.toMatchObject({ code: "23514" });
    expect((await counts()).handoffs).toBe(1);
  });

  it.each(["prepared", "issued", "consumed"] as const)("retains %s records until their fixed cleanup deadline", async state => {
    let id: string;
    if (state === "prepared") {
      const input = await request(); id = (await store.prepare({ request: input.request, signature: input.signature }, origin)).id;
    } else {
      const value = await issuedHandoff(); id = value.prepared.id;
      if (state === "consumed") await value.target.exchange(value.exchange, origin);
    }
    await expect(pool.query("DELETE FROM rest_wallet_handoffs WHERE id=$1", [id])).rejects.toMatchObject({ code: "23514" });
    expect((await counts()).handoffs).toBe(1);
  });

  it("cleans expired receipts in bounded batches, skips held rows and preserves the live grant", async () => {
    // This checks cleanup and row locking, not a 100ms completion deadline under
    // the full parallel EVM suite. Keep the successful exchange alive long enough.
    const value = await issuedHandoff({ receiptRetentionMs: 1000 }, 30_000, 1600);
    const first = await value.target.exchange(value.exchange, origin);
    const another = await request({ expiresAtMs: await nowMs() + 1000 });
    const other = await value.target.prepare({ request: another.request, signature: another.signature }, origin);
    const deadline = Math.max(Number((await handoffRow(value.prepared.id)).retain_until_ms), Number((await handoffRow(other.id)).retain_until_ms));
    await waitPast(deadline);
    const lock = await pool.connect(); await lock.query("BEGIN");
    await lock.query("SELECT id FROM rest_wallet_handoffs WHERE id=$1 FOR UPDATE", [value.prepared.id]);
    try {
      expect(await value.target.cleanup(1)).toBe(1);
      expect(await handoffRow(other.id)).toBeUndefined();
      expect(await handoffRow(value.prepared.id)).toBeDefined();
    } finally { await lock.query("ROLLBACK"); lock.release(); }
    expect(await value.target.cleanup(1)).toBe(1); expect(await value.target.cleanup(1)).toBe(0);
    expect(await counts()).toEqual({ handoffs: 0, consumed: 0, grants: 1, grantIds: 1 });
    const grant = (await pool.query("SELECT id,incarnation,revoked_at FROM rest_wallet_app_grants WHERE id=$1", [first.grant.id])).rows[0];
    expect(grant).toEqual({ id: first.grant.id, incarnation: first.grant.incarnation, revoked_at: null });
  });

  it("cleans an expired parent independently of its locked retained handoff and rejects the missing session reference", async () => {
    // Storage-only historical fixture: a validated anonymous login draft and ordinary SQL
    // handoff transitions isolate cleanup/FK behavior. This parent never authenticated a user;
    // genuine completed-login issuance and exchange are covered separately above and below.
    const current = await nowMs(), { draft } = createWalletLoginDraft({ rpId: walletLoginFixtureRpId, origin: issuer,
      nowMs: current - 3_600_000 - 86_400_000 - 180_000 - 2000 });
    await pool.query(`INSERT INTO rest_wallet_logins(id,session_id,ceremony_id,rp_id,flow_token_hash,
      issued_at_ms,expires_at_ms,retain_until_ms,draft) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [draft.id, draft.sessionId, draft.ceremony.id, draft.rpId, draft.flowTokenHash,
      draft.issuedAtMs, draft.expiresAtMs, draft.retainUntilMs, JSON.stringify(draft)]);
    const issuedAtMs = draft.expiresAtMs + 3_600_000 - 1000;
    const input = await request({ issuedAtMs, expiresAtMs: issuedAtMs + 120_000 }), id = token(), code = token();
    const canonical = validateWalletHandoffRequest(input.request), retention = canonical.expiresAtMs + 86_400_000;
    expect(retention).toBeGreaterThan(current); expect(draft.retainUntilMs).toBeLessThan(current);
    await pool.query(`INSERT INTO rest_wallet_handoffs(id,request_digest,request,origin,created_at_ms,expires_at_ms,retain_until_ms)
      VALUES($1,$2,$3::jsonb,$4,$5,$6,$7)`, [id, hashTypedData(walletHandoffRequestDocument(canonical)),
      JSON.stringify(canonical), origin, issuedAtMs, canonical.expiresAtMs, retention]);
    await pool.query(`UPDATE rest_wallet_handoffs SET state='issued',session_id=$2,code_hash=$3,issued_at_ms=$4,
      code_expires_at_ms=$5 WHERE id=$1`, [id, draft.sessionId, walletHandoffCodeHash(code), issuedAtMs + 10, issuedAtMs + 500]);
    const isolated = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, query_timeout: 10_000,
      options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=5000` });
    const backendPid = Number((await isolated.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    const lock = await pool.connect(); await lock.query("BEGIN");
    await lock.query("SELECT id FROM rest_wallet_handoffs WHERE id=$1 FOR UPDATE", [id]);
    const cleanup = new PostgresWalletLoginStore(isolated, { rpId: walletLoginFixtureRpId, origin: issuer }).cleanup(1);
    let outcome: number | "blocked";
    try {
      outcome = await Promise.race([cleanup, new Promise<"blocked">(resolve => setTimeout(() => resolve("blocked"), 500))]);
      if (outcome === "blocked") await waitingForLock(backendPid, /rest_wallet_logins/i);
    } finally {
      await lock.query("ROLLBACK"); lock.release();
      try { await cleanup; } finally { await isolated.end(); }
    }
    expect(outcome).toBe(1);
    expect((await pool.query("SELECT id FROM rest_wallet_logins WHERE id=$1", [draft.id])).rowCount).toBe(0);
    expect(await handoffRow(id)).toBeDefined(); expect(await store.cleanup(1)).toBe(0);
    await expect(pool.query("DELETE FROM rest_wallet_handoffs WHERE id=$1", [id])).rejects.toMatchObject({ code: "23514" });
    const exchange = await exchangeInput(canonical, id, code, input.verifier);
    await expect(store.exchange(exchange, origin)).rejects.toMatchObject({ status: 403 });
    await expect(store.identifyExchange(exchange, origin)).rejects.toMatchObject({ status: 403 });
    expect((await counts()).grants).toBe(0);
  });

  it("retries the same signed preparation without consuming additional global capacity", async () => {
    const limited = new PostgresWalletHandoffStore(pool, options({ maxRecords: 1 })), input = await request();
    const first = await limited.prepare({ request: input.request, signature: input.signature }, origin);
    expect(await limited.prepare({ request: input.request, signature: input.signature }, origin)).toEqual(first);
    const another = await request({ origin: secondOrigin, callbackUri: `${secondOrigin}/wallet/callback` });
    await expect(limited.prepare({ request: another.request, signature: another.signature }, secondOrigin)).rejects.toMatchObject({ status: 429 });
    expect((await counts()).handoffs).toBe(1);
  });

  it("enforces preparation capacity across two processes and two origins", async () => {
    const [first, second] = await Promise.all([worker({ maxRecords: 1 }), worker({ maxRecords: 1 })]);
    const a = await request(), b = await request({ origin: secondOrigin, callbackUri: `${secondOrigin}/wallet/callback` });
    const lock = await pool.connect(); await lock.query("BEGIN");
    await lock.query("SELECT pg_advisory_xact_lock(hashtextextended('wallet-handoffs:' || 'rest_wallet_handoffs'::regclass::oid::text, 0))");
    const responses = [first.request({ action: "prepare", input: { request: a.request, signature: a.signature } }),
      second.request({ action: "prepare", input: { request: b.request, signature: b.signature } }, secondOrigin)];
    try { await Promise.all([waitingForLock(first.backendPid), waitingForLock(second.backendPid)]); }
    finally { await lock.query("ROLLBACK"); lock.release(); }
    expect((await Promise.all(responses)).map(value => value.status).sort()).toEqual([200, 429]);
    expect((await counts()).handoffs).toBe(1);
  });

  it("issues only a hashed code and exchanges without a central cookie for one typed grant", async () => {
    const value = await issuedHandoff(), process = await worker();
    const row = await handoffRow(value.prepared.id), metadata = await value.target.getIntent(value.prepared.id);
    expect(row.code_hash).toBe(walletHandoffCodeHash(value.issued.code));
    expect(JSON.stringify(row)).not.toContain(value.issued.code);
    expect(metadata).not.toHaveProperty("sessionId"); expect(metadata).not.toHaveProperty("code");
    expect(value.issued).toEqual({ code: value.issued.code, state: value.input.request.state, issuer,
      callbackUri: value.input.request.callbackUri });
    await expect(value.target.issue(value.prepared.id, value.login.session.id, value.launchSignature)).rejects.toMatchObject({ status: 409 });
    const result = await process.request({ action: "exchange", input: value.exchange });
    expect(result.status).toBe(200); expect(result.body.replayed).toBe(false);
    expect(result.body.grant).toMatchObject({ kind: "wallet-app", accountId: value.login.accountId,
      signerAddress: appKey.address.toLowerCase(), scopes: ["read", "plan", "relay"], origin,
      callbackUri: value.input.request.callbackUri, audience, appGeneration: 1,
      authorityEpoch: value.login.session.authorityEpoch, sessionEpoch: value.login.session.sessionEpoch });
    expect(typeof result.body.grant.incarnation).toBe("string");
    expect(result.body.grant.expiresAt * 1000).toBeLessThanOrEqual(value.login.session.expiresAtMs);
    expect(await counts()).toEqual({ handoffs: 1, consumed: 1, grants: 1, grantIds: 1 });
  });

  it("serializes simultaneous exchanges in two processes into the same grant and incarnation", async () => {
    const value = await issuedHandoff(), [first, second] = await Promise.all([worker(), worker()]);
    const barrier = message(first.child, "barrier");
    const firstResponse = first.request({ action: "exchange", input: value.exchange, barrier: "after-grant-write" });
    expect((await barrier).boundary).toBe("after-grant-write");
    const secondResponse = second.request({ action: "exchange", input: value.exchange });
    await waitingForLock(second.backendPid); first.child.send("release");
    const [a, b] = await Promise.all([firstResponse, secondResponse]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.replayed).toBe(false); expect(b.body.replayed).toBe(true);
    expect(b.body.grant).toEqual(a.body.grant);
    expect(await counts()).toEqual({ handoffs: 1, consumed: 1, grants: 1, grantIds: 1 });
  });

  it.each(["after-grant-write", "after-receipt-write", "after-commit"] as const)(
    "recovers after a process dies %s without duplicating a grant", async boundary => {
      const value = await issuedHandoff(), [first, second] = await Promise.all([worker(), worker()]);
      const barrier = message(first.child, "barrier");
      const lostResponse = first.request({ action: "exchange", input: value.exchange, barrier: boundary }).catch(() => null);
      expect((await barrier).boundary).toBe(boundary);
      const committed = boundary === "after-commit";
      const retained = await handoffRow(value.prepared.id);
      expect(retained.state).toBe(committed ? "consumed" : "issued");
      expect((await counts()).grants).toBe(committed ? 1 : 0);
      await kill(first.child); await lostResponse;
      const retried = await second.request({ action: "exchange", input: value.exchange });
      expect(retried.status).toBe(200); expect(retried.body.replayed).toBe(committed);
      if (committed) expect(retried.body.grant).toEqual(retained.grant_document);
      expect(await counts()).toEqual({ handoffs: 1, consumed: 1, grants: 1, grantIds: 1 });
    });

  it("replays the same fixed receipt after code and request expiry, then refuses receipt expiry", async () => {
    const value = await issuedHandoff({ codeLifetimeMs: 700, receiptRetentionMs: 2400 }, 30_000, 1100);
    const first = await value.target.exchange(value.exchange, origin), retained = await handoffRow(value.prepared.id);
    await waitPast(value.input.request.expiresAtMs);
    const replayed = await value.target.exchange(value.exchange, origin);
    expect(replayed).toEqual({ grant: first.grant, replayed: true });
    expect(await handoffRow(value.prepared.id)).toEqual(retained);
    await waitPast(Number(retained.receipt_until_ms));
    await expect(value.target.exchange(value.exchange, origin)).rejects.toMatchObject({ status: 410 });
    expect(await counts()).toEqual({ handoffs: 1, consumed: 1, grants: 1, grantIds: 1 });
  });

  it.each(["code", "verifier", "key", "state", "issuer", "callback", "audience", "generation", "origin", "no-origin"] as const)(
    "rejects %s substitution before consuming the valid code", async substitution => {
      const value = await issuedHandoff(), process = await worker();
      let input = { ...value.exchange }, requestValue = { ...input.request }, header: string | null = origin;
      if (substitution === "code") input = await exchangeInput(requestValue, input.intentId, token(), input.verifier);
      else if (substitution === "verifier") input.verifier = token();
      else if (substitution === "key") input = await exchangeInput(requestValue, input.intentId, input.code, input.verifier, otherKey);
      else if (substitution === "origin") header = secondOrigin;
      else if (substitution === "no-origin") header = null;
      else {
        if (substitution === "state") requestValue.state = token();
        if (substitution === "issuer") requestValue.issuer = "https://other.juicebox.center";
        if (substitution === "callback") requestValue.callbackUri = `${origin}/another-callback`;
        if (substitution === "audience") requestValue.audience = "https://another.juicebox.center";
        if (substitution === "generation") requestValue.appGeneration++;
        input = await exchangeInput(requestValue, input.intentId, input.code, input.verifier);
      }
      const rejected = await process.request({ action: "exchange", input }, header);
      expect([400, 401, 403, 409]).toContain(rejected.status);
      expect(await counts()).toEqual({ handoffs: 1, consumed: 0, grants: 0, grantIds: 0 });
      expect((await process.request({ action: "exchange", input: value.exchange })).status).toBe(200);
    });

  it.each([false, true])("refuses logout after consumed=%s without creating a replacement grant", async consumed => {
    const value = await issuedHandoff();
    if (consumed) await value.target.exchange(value.exchange, origin);
    await new PostgresWalletLoginStore(pool, { rpId: walletLoginFixtureRpId, origin: walletLoginFixtureOrigin }).logout(value.login.sessionToken);
    await expect(value.target.exchange(value.exchange, origin)).rejects.toMatchObject({ status: 403 });
    expect((await counts()).grants).toBe(consumed ? 1 : 0);
  });

  it.each([false, true])("refuses authority rotation after consumed=%s without changing the receipt", async consumed => {
    const value = await issuedHandoff();
    if (consumed) await value.target.exchange(value.exchange, origin);
    const retained = await handoffRow(value.prepared.id);
    await new PostgresWalletAppGrantStore(pool).advanceEpochs({ accountId: value.login.accountId, kind: "authority",
      expectedAuthorityEpoch: value.login.session.authorityEpoch, expectedSessionEpoch: value.login.session.sessionEpoch });
    await expect(value.target.exchange(value.exchange, origin)).rejects.toMatchObject({ status: 403 });
    expect(await handoffRow(value.prepared.id)).toEqual(retained); expect((await counts()).grants).toBe(consumed ? 1 : 0);
  });

  it.each([false, true])("refuses policy removal and re-addition after consumed=%s", async consumed => {
    const value = await issuedHandoff(); if (consumed) await value.target.exchange(value.exchange, origin);
    const policies = new PostgresWalletPolicyStore(pool);
    await policies.activate({ expectedRevision: 1, nextRevision: 2, configuration: policy([secondOrigin]) });
    await expect(value.target.exchange(value.exchange, origin)).rejects.toMatchObject({ status: 403 });
    await policies.activate({ expectedRevision: 2, nextRevision: 3, configuration: policy() });
    await expect(value.target.exchange(value.exchange, origin)).rejects.toMatchObject({ status: 403 });
    expect((await counts()).grants).toBe(consumed ? 1 : 0);
  });

  it("refuses a revoked original grant on exact receipt retry", async () => {
    const value = await issuedHandoff(), first = await value.target.exchange(value.exchange, origin);
    await pool.query("UPDATE rest_wallet_app_grants SET revoked_at=floor(extract(epoch FROM clock_timestamp())) WHERE id=$1", [first.grant.id]);
    await expect(value.target.exchange(value.exchange, origin)).rejects.toMatchObject({ status: 403 });
    await expect(value.target.identifyExchange(value.exchange, origin)).rejects.toMatchObject({ status: 403 });
    expect(await counts()).toEqual({ handoffs: 1, consumed: 1, grants: 1, grantIds: 1 });
  });

  it("does not reissue a grant after the original grant and its capped receipt expire", async () => {
    const value = await issuedHandoff(), process = await worker({ grantLifetimeSeconds: 2 });
    const first = await process.request({ action: "exchange", input: value.exchange });
    expect(first.status).toBe(200);
    const retained = await handoffRow(value.prepared.id);
    expect(Number(retained.receipt_until_ms)).toBeLessThanOrEqual(first.body.grant.expiresAt * 1000);
    await waitPast(first.body.grant.expiresAt * 1000);
    expect([403, 410]).toContain((await process.request({ action: "exchange", input: value.exchange })).status);
    expect(await handoffRow(value.prepared.id)).toEqual(retained);
    expect(await counts()).toEqual({ handoffs: 1, consumed: 1, grants: 1, grantIds: 1 });
  });

  it.each(["code", "readiness"] as const)("rechecks %s expiry after a real account lock wait before first consume", async boundary => {
    const value = await issuedHandoff({ codeLifetimeMs: boundary === "code" ? 2500 : 60_000 }, boundary === "readiness" ? 2500 : 30_000);
    const process = await worker(), release = await holdAccount(value.login.accountId);
    const deadline = boundary === "code" ? Number((await handoffRow(value.prepared.id)).code_expires_at_ms) : value.login.observation.validUntilMs!;
    expect(await nowMs()).toBeLessThan(deadline);
    const response = process.request({ action: "exchange", input: value.exchange });
    try { await waitingForLock(process.backendPid, /rest_accounts/i); await waitPast(deadline); }
    finally { await release(); }
    expect((await response).status).toBe(boundary === "code" ? 410 : 403);
    expect(await counts()).toEqual({ handoffs: 1, consumed: 0, grants: 0, grantIds: 0 });
  });

  it.each(["code", "readiness"] as const)("rolls back grant and receipt when %s expires after their writes", async boundary => {
    const value = await issuedHandoff({ codeLifetimeMs: boundary === "code" ? 2500 : 60_000 }, boundary === "readiness" ? 2500 : 30_000);
    const process = await worker(), barrier = message(process.child, "barrier");
    const deadline = boundary === "code" ? Number((await handoffRow(value.prepared.id)).code_expires_at_ms) : value.login.observation.validUntilMs!;
    const response = process.request({ action: "exchange", input: value.exchange, barrier: "after-receipt-write" });
    expect((await barrier).boundary).toBe("after-receipt-write");
    await waitPast(deadline); process.child.send("release");
    expect((await response).status).toBe(boundary === "code" ? 410 : 403);
    expect(await counts()).toEqual({ handoffs: 1, consumed: 0, grants: 0, grantIds: 0 });
  });

  it.each([false, true])("identifies the proved originating account after readiness expiry with consumed=%s, then admits a fresh observation", async consumed => {
    const value = await issuedHandoff({}, 700);
    const first = consumed ? await value.target.exchange(value.exchange, origin) : null;
    await waitPast(value.login.observation.validUntilMs!);
    await expect(value.target.exchange(value.exchange, origin)).rejects.toMatchObject({ status: 403 });
    expect(await value.target.identifyExchange(value.exchange, origin)).toEqual({ accountId: value.login.accountId });
    expect(await counts()).toEqual({ handoffs: 1, consumed: consumed ? 1 : 0, grants: consumed ? 1 : 0, grantIds: consumed ? 1 : 0 });
    await refreshSyntheticObservation(value.login.accountId);
    const result = await value.target.exchange(value.exchange, origin);
    expect(result.replayed).toBe(consumed); if (first) expect(result.grant).toEqual(first.grant);
  });

  it.each(["signature", "verifier", "code", "origin", "logout", "removed-policy"] as const)(
    "does not expose a refresh identity for %s", async invalidation => {
      const value = await issuedHandoff(), process = await worker(); let input = { ...value.exchange }, header = origin;
      if (invalidation === "signature") input = await exchangeInput(input.request, input.intentId, input.code, input.verifier, otherKey);
      if (invalidation === "verifier") input.verifier = token();
      if (invalidation === "code") input = await exchangeInput(input.request, input.intentId, token(), input.verifier);
      if (invalidation === "origin") header = secondOrigin;
      if (invalidation === "logout") await new PostgresWalletLoginStore(pool, { rpId: walletLoginFixtureRpId, origin: issuer }).logout(value.login.sessionToken);
      if (invalidation === "removed-policy") await new PostgresWalletPolicyStore(pool).activate({ expectedRevision: 1, nextRevision: 2, configuration: policy([secondOrigin]) });
      const response = await process.request({ action: "identify-exchange", input }, header);
      expect([400, 401, 403]).toContain(response.status); expect(response.body).not.toHaveProperty("accountId");
      expect(await counts()).toEqual({ handoffs: 1, consumed: 0, grants: 0, grantIds: 0 });
    });

  it.each([false, true])("refuses expired refresh identity when consumed=%s", async consumed => {
    const value = await issuedHandoff({ codeLifetimeMs: 600, receiptRetentionMs: 900 });
    if (consumed) await value.target.exchange(value.exchange, origin);
    const row = await handoffRow(value.prepared.id);
    await waitPast(Number(consumed ? row.receipt_until_ms : row.code_expires_at_ms));
    await expect(value.target.identifyExchange(value.exchange, origin)).rejects.toMatchObject({ status: 410 });
    expect((await counts()).grants).toBe(consumed ? 1 : 0);
  });
});
