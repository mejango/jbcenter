import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { walletPolicyConfigurationHash, type WalletPolicyConfiguration } from "../src/rest/wallet/policy.js";
import { assertWalletPolicyCallbackInTransaction, PostgresWalletPolicyStore, type WalletPolicyCallbackAdmission } from "../src/rest/wallet/policyPostgres.js";

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const schema = `rest_wallet_policy_${randomUUID().replaceAll("-", "")}`;
const origin = "https://beep.biz", other = "https://juicebox.money";
const configuration = (applications = [origin, other]): WalletPolicyConfiguration => ({
  version: "center-wallet-policy-v1", applications: applications.map(origin => ({ origin, walletCallbacks: [`${origin}/wallet/callback`] })),
});
const activation = (expectedRevision = 0, policy = configuration()) => ({ expectedRevision, nextRevision: expectedRevision + 1, configuration: policy });
const admission = (changes: Partial<WalletPolicyCallbackAdmission> = {}): WalletPolicyCallbackAdmission => ({
  origin, callbackUri: `${origin}/wallet/callback`, expectedGeneration: 1, expiresAt: Date.now() + 60_000, ...changes,
});
let admin: Pool, pool: Pool, store: PostgresWalletPolicyStore;
const children: ChildProcess[] = [];

function message(child: ChildProcess, kind: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => done(new Error(`Child did not emit ${kind}`)), 10_000);
    const onMessage = (value: unknown) => {
      if (value && typeof value === "object" && "kind" in value && value.kind === kind) done(undefined, value as Record<string, unknown>);
    };
    const onExit = () => done(new Error(`Child exited before ${kind}`));
    function done(error?: Error, value?: Record<string, unknown>) {
      clearTimeout(timeout); child.off("message", onMessage); child.off("exit", onExit);
      if (error) reject(error); else resolve(value!);
    }
    child.on("message", onMessage); child.on("exit", onExit);
  });
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  child.kill("SIGKILL"); await exited;
}
async function worker(options: { maxHistoricalApplications?: number } = {}, prefix = "") {
  const child = fork(fileURLToPath(new URL("./fixtures/wallet-policy-process.ts", import.meta.url)), [], {
    execArgv: ["--import", "tsx"], env: { ...process.env, WALLET_TEST_SCHEMA: schema, WALLET_TEST_PREFIX_SCHEMA: prefix, WALLET_TEST_OPTIONS: JSON.stringify(options) },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  children.push(child);
  const ready = await message(child, "ready");
  return { child, backendPid: ready.backendPid as number, request: async (body: unknown): Promise<{ status: number; body: any }> => {
    const response = await fetch(`http://127.0.0.1:${ready.port}`, {
      method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: await response.json() };
  } };
}
async function waitingForLock(pid: number) {
  for (let i = 0; i < 100; i++) {
    const row = (await pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0];
    if (row?.wait_event_type === "Lock") return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Expected backend to wait for a PostgreSQL row/advisory lock");
}
async function guarded(input = admission()) {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await assertWalletPolicyCallbackInTransaction(client, input); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

suite("PostgreSQL wallet application policy (eligibility only; no authentication)", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 8 });
    await pool.query(await readFile(new URL("../src/db/migrations/017_rest_wallet_policy.sql", import.meta.url), "utf8"));
    await pool.query(await readFile(new URL("../src/db/migrations/051_wallet_policy_app_grant_lifetime.sql", import.meta.url), "utf8"));
    await pool.query("CREATE TABLE wallet_policy_claims(id uuid PRIMARY KEY, origin text NOT NULL)");
    store = new PostgresWalletPolicyStore(pool);
  });
  beforeEach(async () => { await pool.query("TRUNCATE rest_wallet_policy_apps,rest_wallet_policy,wallet_policy_claims"); });
  afterEach(async () => { await Promise.all(children.splice(0).map(kill)); });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } });

  it("starts inactive on every replica and requires explicit activation", async () => {
    expect(await store.readActivePolicy()).toBeNull();
    const [a, b] = await Promise.all([worker(), worker()]);
    expect(a.child.pid).not.toBe(b.child.pid);
    expect((await a.request({ action: "read" })).body).toBeNull();
    expect((await b.request({ action: "guard", input: admission() }))).toMatchObject({ status: 403, body: { code: "WALLET_POLICY_INACTIVE" } });
    expect(await store.readActivePolicy()).toBeNull();
  });

  it("activates a canonical snapshot and recovers an exact retry without changing time or generation", async () => {
    const request = activation(), first = await store.activate(request);
    expect(first.revision).toBe(1);
    expect(first.configurationHash).toBe(walletPolicyConfigurationHash(request.configuration));
    expect(first.activatedAt).toBeGreaterThan(0);
    expect(first.apps).toEqual([origin, other].map(origin => ({ origin, walletCallbacks: [`${origin}/wallet/callback`], generation: 1, enabled: true, grantLifetimeSeconds: 3600 })));
    expect(await store.activate(request)).toEqual(first);
    expect(await store.readActivePolicy()).toEqual(first);
    expect((await guarded()).generation).toBe(1);
  });

  it("rejects stale revisions and same-revision different content instead of restoring a stale replica policy", async () => {
    const first = await store.activate(activation());
    await expect(store.activate(activation(0, configuration([origin])))).rejects.toMatchObject({ code: "WALLET_POLICY_CONFLICT" });
    const second = await store.activate(activation(1, configuration([other])));
    await expect(store.activate(activation())).rejects.toMatchObject({ code: "WALLET_POLICY_CONFLICT" });
    expect((await store.readActivePolicy())?.revision).toBe(second.revision);
    expect(first.configuration.applications).toHaveLength(2);
    const [stale, fresh] = await Promise.all([worker(), worker()]);
    expect((await stale.request({ action: "activate", input: activation() })).status).toBe(409);
    expect((await fresh.request({ action: "read" })).body).toEqual(second);
    expect((await stale.request({ action: "guard", input: admission() })).status).toBe(403);
  });

  it("stores each application's grant lifetime and changes it without advancing the generation", async () => {
    const store = new PostgresWalletPolicyStore(pool);
    const first = await store.activate(activation(0));
    expect(first.apps.map(app => app.grantLifetimeSeconds)).toEqual([3600, 3600]);
    const longer = { ...configuration(), applications: configuration().applications.map(app => app.origin === origin ? { ...app, grantLifetimeSeconds: 90 * 86_400 } : app) };
    const second = await store.activate(activation(1, longer));
    expect(second.apps.map(app => [app.origin, app.generation, app.grantLifetimeSeconds])).toEqual([[origin, 1, 90 * 86_400], [other, 1, 3600]]);
    expect((await guarded()).grantLifetimeSeconds).toBe(90 * 86_400);
    for (const bad of [59, 90 * 86_400 + 1, 1.5, "3600"])
      await expect(store.activate(activation(2, { ...longer, applications: longer.applications.map(app => app.origin === origin ? { ...app, grantLifetimeSeconds: bad as number } : app) })))
        .rejects.toMatchObject({ code: "WALLET_POLICY_INVALID" });
    expect((await store.readActivePolicy())!.revision).toBe(2);
    // An activation that lists the application without a lifetime puts it back to the hour, generation untouched.
    const reset = await store.activate(activation(2));
    expect(reset.apps.map(app => [app.generation, app.grantLifetimeSeconds])).toEqual([[1, 3600], [1, 3600]]);
  });

  it("preserves unchanged apps, advances changed callbacks, and never revives a removed generation", async () => {
    await store.activate(activation());
    const reordered = configuration([other, origin]);
    expect((await store.activate(activation(1, reordered))).apps.map(app => app.generation)).toEqual([1, 1]);
    const changed = configuration(); changed.applications[0]!.walletCallbacks = [`${origin}/wallet/complete`];
    const third = await store.activate(activation(2, changed));
    expect(third.apps.map(app => app.generation)).toEqual([2, 1]);
    await expect(guarded()).rejects.toMatchObject({ code: "WALLET_POLICY_INACTIVE" });
    await expect(guarded(admission({ callbackUri: `${origin}/wallet/complete` }))).rejects.toMatchObject({ code: "WALLET_POLICY_INACTIVE" });
    expect((await guarded(admission({ callbackUri: `${origin}/wallet/complete`, expectedGeneration: 2 }))).generation).toBe(2);
    const removed = await store.activate(activation(3, configuration([other])));
    expect(removed.apps[0]).toEqual({ origin, walletCallbacks: [], generation: 3, enabled: false, grantLifetimeSeconds: 3600 });
    const added = await store.activate(activation(4));
    expect(added.apps.map(app => app.generation)).toEqual([4, 1]);
    await expect(guarded()).rejects.toMatchObject({ code: "WALLET_POLICY_INACTIVE" });
    expect((await guarded(admission({ expectedGeneration: 4 }))).generation).toBe(4);
  });

  it("does not admit callbacks for an allowlisted app whose metadata is empty", async () => {
    const policy = configuration(); policy.applications[0]!.walletCallbacks = [];
    await store.activate(activation(0, policy));
    await expect(guarded()).rejects.toMatchObject({ code: "WALLET_POLICY_INACTIVE" });
  });

  it("requires an exact registered callback and optional exact live generation", async () => {
    await store.activate(activation());
    for (const change of [{ callbackUri: `${origin}/other` }, { expectedGeneration: 2 }, { origin: "https://revnet.money", callbackUri: "https://revnet.money/wallet/callback" }])
      await expect(guarded(admission(change))).rejects.toMatchObject({ code: "WALLET_POLICY_INACTIVE" });
    const currentGeneration = admission(); delete currentGeneration.expectedGeneration;
    expect((await guarded(currentGeneration)).generation).toBe(1);
  });

  it("rejects malformed activation and guard inputs without a policy mutation", async () => {
    for (const change of [{ expectedRevision: -1 }, { nextRevision: 0 }, { nextRevision: 2 }, { expectedRevision: NaN },
      { nextRevision: Number.MAX_SAFE_INTEGER + 1 }, { extra: true }, { configuration: { ...configuration(), privateKey: "secret" } }])
      await expect(store.activate({ ...activation(), ...change } as any)).rejects.toMatchObject({ code: "WALLET_POLICY_INVALID" });
    expect(await store.readActivePolicy()).toBeNull();
    for (const change of [{ expiresAt: NaN }, { expectedGeneration: 0 }, { expiresAt: Number.MAX_SAFE_INTEGER + 1 }, { extra: true },
      { callbackUri: `${origin}/wallet/callback?return=evil` }, { origin: "HTTPS://beep.biz" }, { callbackUri: `${other}/wallet/callback` }])
      await expect(guarded({ ...admission(), ...change } as any)).rejects.toMatchObject({ code: "WALLET_POLICY_INVALID" });
  });

  it("bounds retained historical origins and rolls back the entire rejected activation", async () => {
    const limited = new PostgresWalletPolicyStore(pool, { maxHistoricalApplications: 2 });
    const before = await limited.activate(activation());
    await expect(limited.activate(activation(1, configuration(["https://revnet.money"])))).rejects.toMatchObject({ code: "WALLET_POLICY_LIMIT" });
    expect(await store.readActivePolicy()).toEqual(before);
    for (const limit of [0, -1, NaN, 4097]) expect(() => new PostgresWalletPolicyStore(pool, { maxHistoricalApplications: limit })).toThrow();
  });

  it("arbitrates conflicting activation in two HTTP processes with one CAS winner", async () => {
    const [a, b] = await Promise.all([worker(), worker()]);
    const results = await Promise.all([a.request({ action: "activate", input: activation(0, configuration([origin])) }),
      b.request({ action: "activate", input: activation(0, configuration([other])) })]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    const current = await store.readActivePolicy();
    expect(current).toEqual(results.find(result => result.status === 200)!.body);
    expect(current!.apps).toHaveLength(1);
  });

  it("recovers identical concurrent activations across processes without advancing the revision", async () => {
    const [a, b] = await Promise.all([worker(), worker()]);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).request({ action: "activate", input: activation() })));
    expect(results.every(result => result.status === 200)).toBe(true);
    expect(results.every(result => JSON.stringify(result.body) === JSON.stringify(results[0]!.body))).toBe(true);
    expect((await store.readActivePolicy())?.revision).toBe(1);
  });

  it("serializes the same policy table across different replica search-path prefixes", async () => {
    await admin.query(`CREATE SCHEMA ${schema}_a`); await admin.query(`CREATE SCHEMA ${schema}_b`);
    try {
      await store.activate(activation()); const [a, b] = await Promise.all([worker({}, `${schema}_a`), worker({}, `${schema}_b`)]);
      const reached = message(a.child, "barrier");
      const first = a.request({ action: "activate", input: activation(1, configuration([origin, other, "https://revnet.money"])), barrier: "after-app-write" });
      await reached;
      const second = b.request({ action: "activate", input: activation(1, configuration([origin, other, "https://eth.shop"])) });
      try { await waitingForLock(b.backendPid); }
      finally { a.child.send("release"); await first; await second; }
      const results = await Promise.all([first, second]);
      expect(results.map(result => result.status)).toEqual([200, 409]);
      expect((await store.readActivePolicy())!.apps.map(app => app.origin)).toEqual([origin, other, "https://revnet.money"]);
    } finally { await admin.query(`DROP SCHEMA ${schema}_a CASCADE`); await admin.query(`DROP SCHEMA ${schema}_b CASCADE`); }
  });

  it("rejects activation and admission proxies without invoking their traps", async () => {
    let accessed = 0;
    const trap = { getPrototypeOf(target: object) { accessed++; return Reflect.getPrototypeOf(target); } };
    await expect(store.activate(new Proxy<ReturnType<typeof activation>>(activation(), trap))).rejects.toMatchObject({ code: "WALLET_POLICY_INVALID" });
    await expect(guarded(new Proxy<WalletPolicyCallbackAdmission>(admission(), trap))).rejects.toMatchObject({ code: "WALLET_POLICY_INVALID" });
    expect(accessed).toBe(0);
  });

  it("rejects accessors and custom root fields before reading or retaining them", async () => {
    let accessed = 0;
    const request = activation(); Object.defineProperty(request, "configuration", { enumerable: true, get() { accessed++; return configuration(); } });
    await expect(store.activate(request)).rejects.toMatchObject({ code: "WALLET_POLICY_INVALID" });
    const input = admission(); Object.defineProperty(input, "expiresAt", { enumerable: true, get() { accessed++; return Date.now() + 60_000; } });
    await expect(guarded(input)).rejects.toMatchObject({ code: "WALLET_POLICY_INVALID" });
    expect(accessed).toBe(0); expect(await store.readActivePolicy()).toBeNull();
  });

  it("snapshots activation before a pool wait and admission before an app-row wait", async () => {
    const single = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 1 }), occupied = await single.connect();
    const request = activation(), activating = new PostgresWalletPolicyStore(single).activate(request);
    request.nextRevision = 42; request.configuration.applications[0]!.walletCallbacks = [`${origin}/substituted`];
    request.configuration.applications.pop(); occupied.release();
    try {
      const stored = await activating;
      expect(stored.revision).toBe(1); expect(stored.apps).toHaveLength(2);
      expect(stored.apps[0]!.walletCallbacks).toEqual([`${origin}/wallet/callback`]);
    } finally { await single.end(); }
    const lock = await pool.connect(), reader = await pool.connect();
    try {
      await lock.query("BEGIN"); await lock.query("SELECT origin FROM rest_wallet_policy_apps WHERE origin=$1 FOR UPDATE", [origin]);
      await reader.query("BEGIN"); const pid = (await reader.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const input = admission(), reading = assertWalletPolicyCallbackInTransaction(reader, input);
      await waitingForLock(pid); input.expectedGeneration = 999; input.callbackUri = `${origin}/substituted`; input.expiresAt = 1;
      await lock.query("COMMIT"); expect((await reading).generation).toBe(1); await reader.query("COMMIT");
    } finally { await lock.query("ROLLBACK"); await reader.query("ROLLBACK"); lock.release(); reader.release(); }
  });

  it("fails closed at revision and per-app generation overflow without partial writes", async () => {
    await store.activate(activation());
    await pool.query("UPDATE rest_wallet_policy_apps SET generation=$1 WHERE origin=$2", [Number.MAX_SAFE_INTEGER, origin]);
    const before = await store.readActivePolicy();
    await expect(store.activate(activation(1, configuration([other])))).rejects.toMatchObject({ code: "WALLET_POLICY_CONFLICT" });
    expect(await store.readActivePolicy()).toEqual(before);
    await pool.query("UPDATE rest_wallet_policy SET revision=$1", [Number.MAX_SAFE_INTEGER]);
    await expect(store.activate({ expectedRevision: Number.MAX_SAFE_INTEGER, nextRevision: Number.MAX_SAFE_INTEGER + 1, configuration: configuration() }))
      .rejects.toMatchObject({ code: "WALLET_POLICY_INVALID" });
    expect((await store.readActivePolicy())?.revision).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("exposes atomic old/new snapshots while activation pauses between derived app writes", async () => {
    const before = await store.activate(activation()), [a, b] = await Promise.all([worker(), worker()]);
    const reached = message(a.child, "barrier");
    const pending = a.request({ action: "activate", input: activation(1, configuration(["https://revnet.money"])), barrier: "after-app-write" });
    await reached;
    expect((await b.request({ action: "read" })).body).toEqual(before);
    a.child.send("release");
    const after = await pending;
    expect(after.status).toBe(200);
    expect((await b.request({ action: "read" })).body).toEqual(after.body);
    expect(after.body.apps.filter((app: any) => app.enabled).map((app: any) => app.origin)).toEqual(["https://revnet.money"]);
  });

  it.each(["after-policy-write", "after-commit"] as const)("recovers a process crash %s without partial policy or generation changes", async boundary => {
    const before = await store.activate(activation()), [a, b] = await Promise.all([worker(), worker()]);
    const request = activation(1, configuration([other]));
    const reached = message(a.child, "barrier");
    const pending = a.request({ action: "activate", input: request, barrier: boundary }).catch(() => null);
    await reached; await kill(a.child); await pending;
    const current = await store.readActivePolicy();
    if (boundary === "after-policy-write") expect(current).toEqual(before);
    else expect(current?.revision).toBe(2);
    const recovered = await b.request({ action: "activate", input: request });
    expect(recovered.status).toBe(200);
    expect(recovered.body.apps[0]).toMatchObject({ enabled: false, generation: 2 });
    if (boundary === "after-commit") expect(recovered.body).toEqual(current);
  });

  it("holds the callback app lock through a durable claim before a later removal can commit", async () => {
    await store.activate(activation()); const [a, b] = await Promise.all([worker(), worker()]);
    const claimId = randomUUID(), reached = message(a.child, "barrier");
    const claim = a.request({ action: "claim", claimId, input: admission(), barrier: "after-guard" });
    await reached;
    const removing = b.request({ action: "activate", input: activation(1, configuration([other])) });
    await waitingForLock(b.backendPid);
    expect((await pool.query("SELECT * FROM wallet_policy_claims")).rows).toHaveLength(0);
    a.child.send("release");
    expect((await claim).status).toBe(200);
    expect((await removing).status).toBe(200);
    expect((await pool.query("SELECT id FROM wallet_policy_claims")).rows).toEqual([{ id: claimId }]);
    expect((await a.request({ action: "claim", claimId: randomUUID(), input: admission() })).status).toBe(403);
  });

  it("rejects a claim when removal acquired its app row first", async () => {
    await store.activate(activation()); const [a, b] = await Promise.all([worker(), worker()]);
    const reached = message(a.child, "barrier");
    const removing = a.request({ action: "activate", input: activation(1, configuration([other])), barrier: "after-app-write" });
    await reached;
    const claim = b.request({ action: "claim", claimId: randomUUID(), input: admission() });
    await waitingForLock(b.backendPid); a.child.send("release");
    expect((await removing).status).toBe(200);
    expect(await claim).toMatchObject({ status: 403, body: { code: "WALLET_POLICY_INACTIVE" } });
    expect((await pool.query("SELECT * FROM wallet_policy_claims")).rows).toHaveLength(0);
  });

  it("does not lock or advance an unchanged app during another app's removal", async () => {
    await store.activate(activation()); const [a, b] = await Promise.all([worker(), worker()]);
    const reached = message(a.child, "barrier");
    const held = a.request({ action: "guard", input: admission(), barrier: "after-guard", rollback: true });
    await reached;
    const update = await b.request({ action: "activate", input: activation(1, configuration([origin])) });
    expect(update.status).toBe(200); expect(update.body.apps[0].generation).toBe(1);
    a.child.send("release"); expect((await held).status).toBe(200);
    expect((await guarded()).generation).toBe(1);
  });

  it("uses database time after lock waits and cannot commit an expired claim", async () => {
    await store.activate(activation()); const a = await worker(), lock = await pool.connect();
    try {
      await lock.query("BEGIN"); await lock.query("SELECT origin FROM rest_wallet_policy_apps WHERE origin=$1 FOR UPDATE", [origin]);
      const claim = a.request({ action: "claim", claimId: randomUUID(), input: admission({ expiresAt: Date.now() + 250 }) });
      await waitingForLock(a.backendPid); await lock.query("SELECT pg_sleep(0.3)"); await lock.query("COMMIT");
      expect(await claim).toMatchObject({ status: 410, body: { code: "WALLET_POLICY_EXPIRED" } });
      expect((await pool.query("SELECT * FROM wallet_policy_claims")).rows).toHaveLength(0);
    } finally { await lock.query("ROLLBACK"); lock.release(); }
  });

  it("leaves transaction ownership with the caller and rolls back a claim that expires after admission", async () => {
    await store.activate(activation()); const a = await worker(), reached = message(a.child, "barrier");
    const claim = a.request({ action: "claim", claimId: randomUUID(), input: admission({ expiresAt: Date.now() + 250 }), barrier: "after-guard" });
    await reached; await pool.query("SELECT pg_sleep(0.3)"); a.child.send("release");
    expect(await claim).toMatchObject({ status: 410, body: { code: "WALLET_POLICY_EXPIRED" } });
    expect((await pool.query("SELECT * FROM wallet_policy_claims")).rows).toHaveLength(0);
  });
});
