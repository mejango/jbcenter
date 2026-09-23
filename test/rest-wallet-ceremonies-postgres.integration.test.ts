import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createWalletCeremony, type WalletCeremony, type WalletCeremonyConsume } from "../src/rest/wallet/ceremonies.js";
import { PostgresWalletCeremonyStore } from "../src/rest/wallet/ceremoniesPostgres.js";

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const schema = `rest_wallet_ceremonies_${randomUUID().replaceAll("-", "")}`;
const digest = "a".repeat(64), otherDigest = "b".repeat(64);
let admin: Pool, pool: Pool, store: PostgresWalletCeremonyStore;
const children: ChildProcess[] = [];
const draft = (accountId = "wallet:fixture") => createWalletCeremony({
  accountId, purpose: "payment", contextDigest: digest, expiresAt: Date.now() + 120_000,
});
const databaseNow = async () =>
  Number((await pool.query<{ now: string }>("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now")).rows[0]!.now);
const consume = (record: WalletCeremony): WalletCeremonyConsume => ({
  id: record.id, accountId: record.accountId, purpose: record.purpose, contextDigest: record.contextDigest,
  challenge: record.challenge, expiresAt: record.expiresAt, proofDigest: digest, resultId: randomUUID(),
});
async function untilDatabaseTime(deadline: number) {
  await pool.query("SELECT pg_sleep(GREATEST(0,($1-extract(epoch FROM clock_timestamp())*1000)/1000)+0.03)", [deadline]);
}

function message(child: ChildProcess, kind: string): Promise<Record<string, unknown>> {
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

async function worker(options: { maxRecords?: number; maxAccountRecords?: number; reservedControlRecords?: number; reservedControlAccountRecords?: number } = {}) {
  const child = fork(fileURLToPath(new URL("./fixtures/wallet-ceremony-process.ts", import.meta.url)), [], {
    execArgv: ["--import", "tsx"], env: { ...process.env, WALLET_TEST_SCHEMA: schema, WALLET_TEST_OPTIONS: JSON.stringify(options) },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  children.push(child);
  const ready = await message(child, "ready");
  return {
    child,
    request: async (body: unknown): Promise<{ status: number; body: any }> => {
      const response = await fetch(`http://127.0.0.1:${ready.port}`, {
        method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

suite("PostgreSQL wallet ceremony storage (does not verify authentication)", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 8 });
    await pool.query(await readFile(new URL("../src/db/migrations/013_rest_wallet_ceremonies.sql", import.meta.url), "utf8"));
    await pool.query(await readFile(new URL("../src/db/migrations/015_rest_wallet_enrollment.sql", import.meta.url), "utf8"));
    await pool.query(await readFile(new URL("../src/db/migrations/046_wallet_signup_window.sql", import.meta.url), "utf8"));
    store = new PostgresWalletCeremonyStore(pool);
  });
  beforeEach(async () => { await pool.query("TRUNCATE rest_wallet_ceremonies"); });
  afterEach(async () => {
    await Promise.all(children.splice(0).map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.kill("SIGKILL"); await exited;
    }));
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  it("issues a bounded immutable draft and returns the original record on exact retry", async () => {
    const input = draft(), first = await store.issue(input);
    expect(first.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.id).toBe(input.id);
    expect(first.createdAt).toBeLessThan(first.expiresAt);
    expect(first.retainUntil).toBe(first.expiresAt + 86_400_000);
    expect(first.resultId).toBeNull();
    expect(await store.issue(input)).toEqual(first);
    for (const change of [{ accountId: "other" }, { purpose: "login" as const }, { contextDigest: otherDigest },
      { challenge: draft().challenge }, { expiresAt: input.expiresAt + 1 }]) {
      await expect(store.issue({ ...input, ...change })).rejects.toMatchObject({ code: "WALLET_CEREMONY_CONFLICT" });
    }
  });

  it("rejects invalid inputs before storing arbitrary JSON or unbounded data", async () => {
    for (const change of [{ id: "bad" }, { accountId: "x".repeat(257) }, { contextDigest: "bad" },
      { purpose: "withdraw" }, { challenge: "a".repeat(44) }, { expiresAt: NaN }, { secret: "must not persist" }]) {
      await expect(store.issue({ ...draft(), ...change } as any)).rejects.toMatchObject({ code: "WALLET_CEREMONY_INVALID" });
    }
    expect((await pool.query("SELECT count(*)::int AS count FROM rest_wallet_ceremonies")).rows[0].count).toBe(0);
  });

  it("uses database time despite a caller clock that tries to extend a challenge", async () => {
    await expect(store.issue({ ...draft(), expiresAt: await databaseNow() - 1 })).rejects.toMatchObject({ code: "WALLET_CEREMONY_EXPIRED" });
    await expect(store.issue({ ...draft(), expiresAt: await databaseNow() + 1_200_000 })).rejects.toMatchObject({ code: "WALLET_CEREMONY_INVALID" });
  });

  it("rejects malformed receipt IDs and duplicate challenges without leaking a database error", async () => {
    await expect(store.get({ id: "-".repeat(36), accountId: "wallet:fixture" })).rejects.toMatchObject({ code: "WALLET_CEREMONY_INVALID" });
    const input = draft();
    await store.issue(input);
    await expect(store.issue({ ...draft("another"), challenge: input.challenge })).rejects.toMatchObject({ code: "WALLET_CEREMONY_CONFLICT" });
  });

  it("binds the exact trusted account, purpose, context, challenge, expiry, proof and result", async () => {
    const record = await store.issue(draft()), request = consume(record);
    for (const change of [{ accountId: "other" }, { purpose: "login" as const }, { contextDigest: otherDigest },
      { challenge: draft().challenge }, { expiresAt: record.expiresAt + 1 }]) {
      await expect(store.consume({ ...request, ...change })).rejects.toMatchObject({ code: "WALLET_CEREMONY_CONFLICT" });
    }
    const first = await store.consume(request);
    expect(first.replayed).toBe(false);
    expect(first.record.resultId).toBe(request.resultId);
    expect((await store.consume(request))).toEqual({ ...first, replayed: true });
    for (const change of [{ proofDigest: otherDigest }, { resultId: randomUUID() }]) {
      await expect(store.consume({ ...request, ...change })).rejects.toMatchObject({ code: "WALLET_CEREMONY_REPLAY" });
    }
    expect(await store.get({ id: record.id, accountId: "other" })).toBeNull();
  });

  it("recovers an expired consumed receipt without turning it into a new authorization", async () => {
    // The store gates expiry on the database clock, so the receipt's window and the wait that
    // outlives it both come from that clock rather than a fixed application-side sleep.
    const record = await store.issue({ ...draft(), expiresAt: await databaseNow() + 3_000 }), request = consume(record);
    const consumed = await store.consume(request);
    expect(consumed).toMatchObject({ replayed: false, record: { consumedAt: expect.any(Number) } });
    expect(consumed.record.consumedAt).toBeLessThan(record.expiresAt);
    await untilDatabaseTime(record.expiresAt);
    const recovered = await store.get({ id: record.id, accountId: record.accountId });
    expect(recovered?.resultId).toBe(request.resultId);
    expect(recovered!.expiresAt).toBeLessThan(await databaseNow());
    await expect(store.consume(request)).resolves.toMatchObject({ replayed: true });
  });

  it("arbitrates the same proof in two actual HTTP service processes sharing PostgreSQL", async () => {
    const [a, b] = await Promise.all([worker(), worker()]);
    expect(a.child.pid).not.toBe(b.child.pid);
    const record = await store.issue(draft()), request = consume(record);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).request({ action: "consume", input: request })));
    expect(results.every(result => result.status === 200)).toBe(true);
    expect(results.filter(result => !result.body.replayed)).toHaveLength(1);
    expect(results.every(result => result.body.record.resultId === request.resultId)).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS count FROM rest_wallet_ceremonies WHERE consumed_at IS NOT NULL")).rows[0].count).toBe(1);
  });

  it("allows only one conflicting proof/result to win across two processes", async () => {
    const [a, b] = await Promise.all([worker(), worker()]);
    const request = consume(await store.issue(draft()));
    const results = await Promise.all([
      a.request({ action: "consume", input: request }),
      b.request({ action: "consume", input: { ...request, proofDigest: otherDigest, resultId: randomUUID() } }),
    ]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    expect(results.find(result => result.status === 409)?.body.code).toBe("WALLET_CEREMONY_REPLAY");
  });

  it("atomically admits the last global slot across processes and account aliases", async () => {
    const [a, b] = await Promise.all([worker({ maxRecords: 2 }), worker({ maxRecords: 2 })]);
    const results = await Promise.all([
      a.request({ action: "issue", input: draft("wallet:one") }), b.request({ action: "issue", input: draft("wallet:two") }),
    ]);
    expect(results.map(result => result.status).sort()).toEqual([200, 429]);
    expect(results.find(result => result.status === 429)?.body.code).toBe("WALLET_CEREMONY_LIMIT");
    expect((await pool.query("SELECT count(*)::int AS count FROM rest_wallet_ceremonies")).rows[0].count).toBe(1);
  });

  it("counts consumed replay receipts toward ordinary account admission, even across purposes", async () => {
    const capped = new PostgresWalletCeremonyStore(pool, { maxAccountRecords: 2 });
    const record = await capped.issue(draft());
    await capped.consume(consume(record));
    await expect(capped.issue({ ...draft(), purpose: "deploy" })).rejects.toMatchObject({ code: "WALLET_CEREMONY_LIMIT" });
  });

  it("atomically admits the last account slot across processes and different purposes", async () => {
    const [a, b] = await Promise.all([worker({ maxAccountRecords: 2 }), worker({ maxAccountRecords: 2 })]);
    const results = await Promise.all([
      a.request({ action: "issue", input: draft() }), b.request({ action: "issue", input: { ...draft(), purpose: "session" } }),
    ]);
    expect(results.map(result => result.status).sort()).toEqual([200, 429]);
  });

  it("reserves bounded account capacity for login and rotation after payment admission is full", async () => {
    const options = { maxAccountRecords: 4, reservedControlAccountRecords: 2 };
    const capped = new PostgresWalletCeremonyStore(pool, options);
    const records = await Promise.all([capped.issue(draft()), capped.issue(draft())]);
    await capped.consume(consume(records[0]!));
    for (const purpose of ["payment", "deploy", "session"] as const)
      await expect(capped.issue({ ...draft(), purpose })).rejects.toMatchObject({ code: "WALLET_CEREMONY_LIMIT" });
    const [a, b] = await Promise.all([worker(options), worker(options)]);
    const results = await Promise.all([
      a.request({ action: "issueControl", input: { ...draft(), purpose: "login" } }),
      b.request({ action: "issueControl", input: { ...draft(), purpose: "rotate" } }),
    ]);
    expect(results.map(result => result.status)).toEqual([200, 200]);
    expect((await a.request({ action: "issue", input: { ...draft(), purpose: "registration" } })).status).toBe(429);
    expect((await pool.query("SELECT count(*)::int AS count FROM rest_wallet_ceremonies")).rows[0].count).toBe(4);
  });

  it("reserves global control capacity across account aliases and still rejects a full control pool", async () => {
    const options = { maxRecords: 3, reservedControlRecords: 2 };
    const capped = new PostgresWalletCeremonyStore(pool, options);
    await capped.issue(draft("payment:one"));
    await expect(capped.issue(draft("payment:two"))).rejects.toMatchObject({ code: "WALLET_CEREMONY_LIMIT" });
    const [a, b] = await Promise.all([worker(options), worker(options)]);
    expect((await a.request({ action: "issueControl", input: { ...draft("owner:one"), purpose: "login" } })).status).toBe(200);
    expect((await b.request({ action: "issueControl", input: { ...draft("owner:two"), purpose: "rotate" } })).status).toBe(200);
    const full = await Promise.all([
      a.request({ action: "issue", input: { ...draft("owner:three"), purpose: "registration" } }),
      b.request({ action: "issueControl", input: { ...draft("owner:four"), purpose: "rotate" } }),
    ]);
    expect(full.map(result => result.status)).toEqual([429, 429]);
    expect((await pool.query("SELECT count(*)::int AS count FROM rest_wallet_ceremonies")).rows[0].count).toBe(3);
  });

  it("keeps registration floods and anonymous login outside reserved existing-wallet capacity", async () => {
    const options = { maxRecords: 3, reservedControlRecords: 2 };
    const [a, b] = await Promise.all([worker(options), worker(options)]);
    const registrations = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).request({
      action: "issue", input: { ...draft(`registration:${i}`), purpose: "registration" },
    })));
    expect(registrations.filter(result => result.status === 200)).toHaveLength(1);
    expect(registrations.filter(result => result.status === 429)).toHaveLength(19);
    for (const purpose of ["login", "rotate"] as const)
      expect((await a.request({ action: "issue", input: { ...draft("owner:one"), purpose } })).status).toBe(429);
    const recovery = await Promise.all([
      a.request({ action: "issueControl", input: { ...draft("owner:one"), purpose: "login" } }),
      b.request({ action: "issueControl", input: { ...draft("owner:two"), purpose: "rotate" } }),
    ]);
    expect(recovery.map(result => result.status)).toEqual([200, 200]);
  });

  it("arbitrates the final reserved slot between two verified existing-wallet processes", async () => {
    const options = { maxRecords: 3, reservedControlRecords: 2 };
    const [a, b] = await Promise.all([worker(options), worker(options)]);
    expect((await a.request({ action: "issue", input: draft("ordinary") })).status).toBe(200);
    expect((await a.request({ action: "issueControl", input: { ...draft("owner:one"), purpose: "login" } })).status).toBe(200);
    const race = await Promise.all([
      a.request({ action: "issueControl", input: { ...draft("owner:two"), purpose: "rotate" } }),
      b.request({ action: "issueControl", input: { ...draft("owner:three"), purpose: "login" } }),
    ]);
    expect(race.map(result => result.status).sort()).toEqual([200, 429]);
    expect((await pool.query("SELECT count(*)::int AS count FROM rest_wallet_ceremonies")).rows[0].count).toBe(3);
  });

  it("binds internal control admission to the verified wallet and context and excludes registration", async () => {
    const input = { ...draft(), purpose: "login" as const };
    const trusted = { accountId: input.accountId, contextDigest: input.contextDigest, verifiedProofDigest: digest };
    for (const change of [{ accountId: "different" }, { contextDigest: otherDigest }, { verifiedProofDigest: "bad" }])
      await expect(store.issueControl(input, { ...trusted, ...change })).rejects.toMatchObject({ code: "WALLET_CEREMONY_INVALID" });
    for (const purpose of ["registration", "payment", "deploy", "session"] as const)
      await expect(store.issueControl({ ...input, purpose } as any, trusted)).rejects.toMatchObject({ code: "WALLET_CEREMONY_INVALID" });
    expect((await pool.query("SELECT count(*)::int AS count FROM rest_wallet_ceremonies")).rows[0].count).toBe(0);
  });

  it("requires positive reserved capacity strictly below both total admission caps", () => {
    for (const options of [{ maxRecords: 1 }, { maxAccountRecords: 1 }, { reservedControlRecords: 0 },
      { reservedControlAccountRecords: -1 }, { reservedControlRecords: 100_000 }, { reservedControlAccountRecords: 256 }]) {
      expect(() => new PostgresWalletCeremonyStore(pool, options)).toThrowError(expect.objectContaining({ code: "WALLET_CEREMONY_INVALID" }));
    }
  });

  it("rechecks expiration after waiting for another transaction's row lock", async () => {
    const blocker = await pool.connect();
    const consumingPool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 1 });
    try {
      await blocker.query("BEGIN");
      const holder = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const waiter = (await consumingPool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const record = await store.issue({ ...draft(), expiresAt: await databaseNow() + 3000 });
      await blocker.query("SELECT 1 FROM rest_wallet_ceremonies WHERE id=$1 FOR UPDATE", [record.id]);
      const pending = new PostgresWalletCeremonyStore(consumingPool).consume(consume(record))
        .then(result => ({ result }), error => ({ error }));
      await expect.poll(async () => (await pool.query(
        "SELECT wait_event_type,query,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1", [waiter],
      )).rows[0]).toMatchObject({
        wait_event_type: "Lock", query: "SELECT * FROM rest_wallet_ceremonies WHERE id=$1 FOR UPDATE", blockers: [holder],
      });
      expect(await databaseNow()).toBeLessThan(record.expiresAt);
      await untilDatabaseTime(record.expiresAt);
      await blocker.query("COMMIT");
      expect(await pending).toMatchObject({ error: { code: "WALLET_CEREMONY_EXPIRED" } });
      expect(await store.get({ id: record.id, accountId: record.accountId })).toMatchObject({
        consumedAt: null, proofDigest: null, resultId: null,
      });
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await consumingPool.end(); }
  });

  it("rolls back a killed process after writing consumption but before commit", async () => {
    const [a, b] = await Promise.all([worker(), worker()]);
    const record = await store.issue(draft()), request = consume(record);
    const barrier = message(a.child, "barrier");
    const lost = a.request({ action: "consume", input: request, barrier: "after-write" }).catch(() => null);
    await barrier; a.child.kill("SIGKILL"); await lost;
    const recovered = await b.request({ action: "consume", input: request });
    expect(recovered.status).toBe(200); expect(recovered.body.replayed).toBe(false);
    expect(recovered.body.record.resultId).toBe(request.resultId);
  });

  it("recovers the original committed result after a process loses its response", async () => {
    const [a, b] = await Promise.all([worker(), worker()]);
    const record = await store.issue(draft()), request = consume(record);
    const barrier = message(a.child, "barrier");
    const lost = a.request({ action: "consume", input: request, barrier: "after-commit" }).catch(() => null);
    await barrier; a.child.kill("SIGKILL"); await lost;
    const recovered = await b.request({ action: "consume", input: request });
    expect(recovered.status).toBe(200); expect(recovered.body.replayed).toBe(true);
    expect(recovered.body.record.resultId).toBe(request.resultId);
  });

  it("cleans only a bounded set past retention and cannot renew a cleaned expired draft", async () => {
    const records = await Promise.all([store.issue(draft("a")), store.issue(draft("b")), store.issue(draft("c"))]);
    await store.consume(consume(records[0]!));
    await pool.query("UPDATE rest_wallet_ceremonies SET created_at=created_at-90000000, expires_at=expires_at-90000000, retain_until=retain_until-90000000, consumed_at=consumed_at-90000000");
    expect(await store.cleanup(2)).toBe(2);
    expect((await pool.query("SELECT count(*)::int AS count FROM rest_wallet_ceremonies")).rows[0].count).toBe(1);
    expect(await store.cleanup(2)).toBe(1);
    expect(await store.get({ id: records[0]!.id, accountId: records[0]!.accountId })).toBeNull();
    const { id, accountId, purpose, contextDigest, challenge } = records[0]!;
    await expect(store.issue({ id, accountId, purpose, contextDigest, challenge, expiresAt: records[0]!.expiresAt - 90_000_000 }))
      .rejects.toMatchObject({ code: "WALLET_CEREMONY_EXPIRED" });
    await expect(store.cleanup(10_001)).rejects.toMatchObject({ code: "WALLET_CEREMONY_INVALID" });
  });
  it("reclaims unconsumed expired challenges while retaining consumed replay receipts", async () => {
    const records = await Promise.all([store.issue(draft("a")), store.issue(draft("b")), store.issue(draft("c"))]);
    await store.consume(consume(records[0]!));
    await pool.query("UPDATE rest_wallet_ceremonies SET created_at=created_at-301000, expires_at=expires_at-301000, retain_until=retain_until-301000, consumed_at=consumed_at-301000");
    expect(await store.cleanup(1)).toBe(1); expect(await store.cleanup(1)).toBe(1); expect(await store.cleanup()).toBe(0);
    expect((await pool.query('SELECT id FROM rest_wallet_ceremonies')).rows).toEqual([{ id: records[0]!.id }]);
    const retained = (await store.get({ id: records[0]!.id, accountId: records[0]!.accountId }))!;
    expect((await store.consume({ ...consume(retained), proofDigest: retained.proofDigest!, resultId: retained.resultId! })).replayed).toBe(true);
  });

});
