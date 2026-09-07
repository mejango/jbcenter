import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { migrate } from "../src/db/migrate.js";
import { MemoryAccountStore } from "../src/rest/auth/memory.js";
import { assertRestActorActive, PostgresAccountStore } from "../src/rest/auth/postgres.js";
import {
  RestAuthError,
  type Account,
  type AccountStore,
  type AccountStoreOptions,
  type BotGrant,
  type BotScope,
  type VerifiedRequest,
} from "../src/rest/auth/store.js";

let NOW = Math.floor(Date.now() / 1_000);
const OWNER = `0x${"11".repeat(20)}` as Address;
const OTHER = `0x${"22".repeat(20)}` as Address;
const BOT = `0x${"ab".repeat(20)}` as Address;
const nonce = (value: number): Hex => `0x${value.toString(16).padStart(64, "0")}`;
const account = (owner = OWNER): Account => ({
  id: `eip155:1:${owner.toLowerCase()}`,
  ownerAddress: owner,
  authorityChainId: 1,
  profile: { displayName: "Garden", bio: "Public goods", avatarUri: null },
  createdAt: NOW,
  updatedAt: NOW,
});
const request = (changes: Partial<VerifiedRequest> = {}): VerifiedRequest => ({
  accountId: account().id,
  signer: OWNER,
  grantId: null,
  nonce: nonce(1),
  issuedAt: NOW,
  expiresAt: NOW + 120,
  idempotencyKey: null,
  requiredScopes: ["read"],
  ownerOnly: false,
  now: NOW,
  ...changes,
});
const grant = (changes: Partial<BotGrant> = {}): BotGrant => ({
  id: randomUUID(), accountId: account().id, botAddress: BOT, scopes: ["read"],
  label: "Garden bot", createdAt: NOW, expiresAt: NOW + 3_600, revokedAt: null, ...changes,
});
const code = (value: PromiseSettledResult<unknown>): string | null =>
  value.status === "rejected" && value.reason instanceof RestAuthError ? value.reason.code : null;

const connectionString = process.env.TEST_DATABASE_URL;
const schema = `jbcenter_rest_auth_${randomUUID().replaceAll("-", "")}`;
let admin: Pool | undefined;
let pool: Pool | undefined;

beforeAll(async () => {
  if (!connectionString) return;
  admin = new Pool({ connectionString });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 12 });
  await migrate(pool);
});

afterAll(async () => {
  await pool?.end();
  if (admin) {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

for (const backend of ["memory", "postgres"] as const) {
  const suite = backend === "postgres" && !connectionString ? describe.skip : describe;
  suite(`${backend} REST account store`, () => {
    let store: AccountStore;
    const createStore = (options: AccountStoreOptions = {}): AccountStore => backend === "memory"
      ? new MemoryAccountStore(options) : new PostgresAccountStore(pool!, options);

    beforeEach(async () => {
      NOW = Math.floor(Date.now() / 1_000);
      if (backend === "postgres") await pool!.query("TRUNCATE rest_request_nonces, rest_bot_grants, rest_accounts CASCADE");
      store = createStore();
    });

    it("enrolls once under concurrent replay and preserves the existing owner profile", async () => {
      const results = await Promise.allSettled(Array.from({ length: 20 }, () => store.enroll(account(), request())));
      expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((value) => code(value) === "REPLAY")).toHaveLength(19);
      const repeated = await store.enroll({ ...account(), profile: { displayName: "Replacement", bio: "", avatarUri: null } }, request({ nonce: nonce(2) }));
      expect(repeated.account.profile.displayName).toBe("Garden");
      expect(repeated.principalId).toBe(`owner:${account().id}`);
      expect(repeated.scopes).toEqual(["read", "plan", "relay"]);
    });

    it("atomically caps global enrollment and rolls back rejected enrollment", async () => {
      store = createStore({ maxAccounts: 1 });
      const results = await Promise.allSettled([OWNER, OTHER].map((owner) => store.enroll(account(owner), request({ accountId: account(owner).id, signer: owner }))));
      expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((value) => code(value) === "STORAGE_LIMIT")).toHaveLength(1);
      expect((await Promise.all([store.getAccount(account(OWNER).id), store.getAccount(account(OTHER).id)])).filter(Boolean)).toHaveLength(1);
    });

    it("rejects invalid enrollment without persisting an account or consuming the nonce", async () => {
      await expect(store.enroll(account(), request({ signer: OTHER }))).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await store.getAccount(account().id)).toBeNull();
      await expect(store.enroll(account(), request({ expiresAt: NOW }))).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
      expect(await store.getAccount(account().id)).toBeNull();
      await expect(store.enroll(account(), request())).resolves.toMatchObject({ isOwner: true });
    });

    it("prevents an alternate account identifier from duplicating an owner identity", async () => {
      await store.enroll(account(), request());
      await expect(store.enroll({ ...account(), id: "alternate" }, request({ accountId: "alternate", nonce: nonce(2) })))
        .rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await store.getAccount("alternate")).toBeNull();
    });

    it("accepts exactly one of concurrent authenticated requests sharing a nonce", async () => {
      await store.enroll(account(), request());
      const results = await Promise.allSettled(Array.from({ length: 30 }, () => store.authorizeAndConsume(request({ nonce: nonce(2) }))));
      expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((value) => code(value) === "REPLAY")).toHaveLength(29);
      await expect(store.authorizeAndConsume(request({ nonce: `0x${"ab".repeat(32)}` }))).resolves.toMatchObject({ isOwner: true });
      await expect(store.authorizeAndConsume(request({ nonce: `0x${"AB".repeat(32)}` }))).rejects.toMatchObject({ code: "REPLAY" });
    });

    it("rechecks bot scope, account ownership, expiry, and revocation before consuming a nonce", async () => {
      await store.enroll(account(), request());
      const bot = await store.registerBot(grant());
      const botRequest = request({ nonce: nonce(2), signer: BOT, grantId: bot.id });
      for (const changes of [
        { requiredScopes: ["relay"] as const }, { ownerOnly: true }, { signer: OTHER },
      ]) {
        await expect(store.authorizeAndConsume({ ...botRequest, ...changes, requiredScopes: [...(changes.requiredScopes ?? ["read"])] }))
          .rejects.toMatchObject({ code: "FORBIDDEN" });
      }
      const authenticated = await store.authorizeAndConsume(botRequest);
      expect(authenticated.principalId).toBe(`bot:${bot.id}`);
      expect(authenticated.scopes).toEqual(["read"]);
      if (backend === "postgres") {
        await pool!.query("UPDATE rest_bot_grants SET created_at = $2 - 1, expires_at = $2 WHERE id = $1", [bot.id, NOW]);
        await expect(store.assertActive({ accountId: account().id, signer: BOT, grantId: bot.id, requiredScopes: ["read"], now: NOW }))
          .rejects.toMatchObject({ code: "FORBIDDEN" });
      } else {
        await expect(store.authorizeAndConsume(request({ nonce: nonce(3), signer: BOT, grantId: bot.id, now: bot.expiresAt, issuedAt: bot.expiresAt, expiresAt: bot.expiresAt + 60 })))
          .rejects.toMatchObject({ code: "FORBIDDEN" });
      }
      await store.revokeBot(account().id, bot.id, NOW + 1);
      await expect(store.authorizeAndConsume({ ...botRequest, nonce: nonce(4) })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(store.assertActive({ accountId: account().id, signer: BOT, grantId: bot.id, requiredScopes: ["read"], now: NOW }))
        .rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("does not permit a grant from another account or owner escalation through a bot grant", async () => {
      await store.enroll(account(), request());
      await store.enroll(account(OTHER), request({ accountId: account(OTHER).id, signer: OTHER }));
      const foreign = await store.registerBot(grant({ accountId: account(OTHER).id }));
      await expect(store.authorizeAndConsume(request({ nonce: nonce(2), signer: BOT, grantId: foreign.id })))
        .rejects.toMatchObject({ code: "FORBIDDEN" });
      const ownerBot = await store.registerBot(grant({ botAddress: OWNER }));
      await expect(store.authorizeAndConsume(request({ nonce: nonce(3), grantId: ownerBot.id, ownerOnly: true })))
        .rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("accepts only exact cumulative grant profiles and keeps operation scope checks independent", async () => {
      await store.enroll(account(), request());
      const profiles: BotScope[][] = [["read"], ["read", "plan"], ["read", "plan", "relay"]];
      for (const scopes of profiles) {
        const bot = await store.registerBot(grant({ scopes }));
        expect(bot.scopes).toEqual(scopes);
        await expect(store.assertActive({ accountId: account().id, signer: BOT, grantId: bot.id,
          requiredScopes: [scopes[scopes.length - 1]!], now: NOW })).resolves.toBeUndefined();
      }
      for (const scopes of [[], ["plan"], ["relay"], ["read", "relay"], ["plan", "read"],
        ["read", "relay", "plan"], ["read", "read"], ["read", "plan", "plan"], new Array<BotScope>(1)] as BotScope[][]) {
        await expect(store.registerBot(grant({ scopes }))).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
      expect(await store.listBots(account().id)).toHaveLength(3);
    });

    it("caps nonce storage under concurrent requests and frees only expired entries", async () => {
      store = createStore({ maxNoncesPerAccount: 3 });
      await store.enroll(account(), request());
      const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => store.authorizeAndConsume(request({ nonce: nonce(i + 2) }))));
      expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(2);
      expect(results.filter((value) => code(value) === "STORAGE_LIMIT")).toHaveLength(10);
      expect(await store.cleanupExpiredNonces(NOW + 119)).toBe(0);
      if (backend === "postgres") await pool!.query("UPDATE rest_request_nonces SET expires_at = $1", [NOW]);
      const freshTime = backend === "postgres" ? NOW : NOW + 120;
      await expect(store.authorizeAndConsume(request({ nonce: nonce(100), now: freshTime, issuedAt: freshTime, expiresAt: freshTime + 60 })))
        .resolves.toMatchObject({ isOwner: true });
      // Callers provide the current time: the expired original signature must fail at that time.
      await expect(store.authorizeAndConsume(request({ now: NOW + 120 }))).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    });

    it("preserves owner recovery slots when concurrent bot requests fill their nonce capacity", async () => {
      store = createStore({ maxNoncesPerAccount: 6 });
      await store.enroll(account(), request());
      const bot = await store.registerBot(grant());
      // Three slots are reserved for the owner at this small configured limit.
      // Enrollment already consumed one of the three slots accessible to bots.
      const botRequest = request({ signer: BOT, grantId: bot.id });
      const attempts = await Promise.allSettled(Array.from({ length: 12 }, (_, index) =>
        store.authorizeAndConsume({ ...botRequest, nonce: nonce(index + 2) })));
      expect(attempts.filter((value) => value.status === "fulfilled")).toHaveLength(2);
      expect(attempts.filter((value) => code(value) === "STORAGE_LIMIT")).toHaveLength(10);
      await expect(store.authorizeAndConsume({ ...botRequest, nonce: nonce(100) }))
        .rejects.toMatchObject({ code: "STORAGE_LIMIT", status: 429 });
      // Omitting the grant ID cannot claim the owner's protected capacity.
      await expect(store.authorizeAndConsume({ ...botRequest, grantId: null, nonce: nonce(101) }))
        .rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(store.authorizeAndConsume(request({ ownerOnly: true, nonce: nonce(102) })))
        .resolves.toMatchObject({ isOwner: true });
      expect((await store.revokeBot(account().id, bot.id, NOW)).revokedAt).not.toBeNull();
      await expect(store.authorizeAndConsume({ ...botRequest, nonce: nonce(103) }))
        .rejects.toMatchObject({ code: "FORBIDDEN" });
      // The reserve is part of the existing total cap, not additional storage.
      await store.authorizeAndConsume(request({ nonce: nonce(104) }));
      await store.authorizeAndConsume(request({ nonce: nonce(105) }));
      await expect(store.authorizeAndConsume(request({ nonce: nonce(106) })))
        .rejects.toMatchObject({ code: "STORAGE_LIMIT" });
    });

    it("bounds global cleanup batches, retaining live replay records", async () => {
      await store.enroll(account(), request());
      await store.authorizeAndConsume(request({ nonce: nonce(2), expiresAt: NOW + 30 }));
      await store.authorizeAndConsume(request({ nonce: nonce(3), expiresAt: NOW + 60 }));
      if (backend === "postgres") {
        await pool!.query("UPDATE rest_request_nonces SET expires_at = $1 WHERE nonce = ANY($2::text[])", [NOW, [nonce(2), nonce(3)]]);
      }
      expect(await store.cleanupExpiredNonces(NOW + 60, 1)).toBe(1);
      expect(await store.cleanupExpiredNonces(NOW + 60, 1)).toBe(1);
      expect(await store.cleanupExpiredNonces(NOW + 60, 1)).toBe(0);
      await expect(store.authorizeAndConsume(request({ now: NOW + 60 }))).rejects.toMatchObject({ code: "REPLAY" });
      await expect(store.cleanupExpiredNonces(NOW, 10_001)).rejects.toThrow("cleanup limit");
    });

    it("keeps revoked grant generations immutable and counts them against the quota", async () => {
      store = createStore({ maxGrantsPerAccount: 2 });
      await store.enroll(account(), request());
      const first = await store.registerBot(grant());
      await store.registerBot(grant());
      const revokedAt = (await store.revokeBot(account().id, first.id, NOW + 1)).revokedAt;
      expect(revokedAt).toBeGreaterThanOrEqual(NOW);
      if (backend === "memory") expect(revokedAt).toBe(NOW + 1);
      expect((await store.revokeBot(account().id, first.id, NOW + 2)).revokedAt).toBe(revokedAt);
      await expect(store.registerBot(first)).rejects.toMatchObject({ code: "REPLAY" });
      await expect(store.registerBot(grant())).rejects.toMatchObject({ code: "STORAGE_LIMIT" });
      expect(await store.listBots(account().id)).toHaveLength(2);
    });

    it("atomically enforces the grant quota across concurrent registrations", async () => {
      store = createStore({ maxGrantsPerAccount: 2 });
      await store.enroll(account(), request());
      const results = await Promise.allSettled(Array.from({ length: 12 }, () => store.registerBot(grant())));
      expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(2);
      expect(results.filter((value) => code(value) === "STORAGE_LIMIT")).toHaveLength(10);
    });

    it("holds the same account lock across durable claim admission and revocation", async () => {
      await store.enroll(account(), request());
      const bot = await store.registerBot(grant({ scopes: ["read", "plan", "relay"] }));
      let release!: () => void;
      let entered!: () => void;
      const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      const events: string[] = [];
      const actor = { accountId: account().id, principalId: `bot:${bot.id}` };
      const admitted = store.withActiveActor(actor, ["relay"], NOW, async () => {
        events.push("claim admitted");
        entered();
        await released;
        events.push("claim persisted");
        return "job";
      });
      await enteredPromise;
      const revoked = store.revokeBot(account().id, bot.id, NOW + 1).then(() => { events.push("revoked"); });
      await Promise.resolve();
      expect(events).toEqual(["claim admitted"]);
      release();
      expect(await admitted).toBe("job");
      await revoked;
      expect(events).toEqual(["claim admitted", "claim persisted", "revoked"]);
      let invoked = false;
      await expect(store.withActiveActor(actor, ["relay"], NOW + 1, async () => { invoked = true; }))
        .rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(invoked).toBe(false);
    });

    it("releases the account lock when durable admission fails", async () => {
      await store.enroll(account(), request());
      const bot = await store.registerBot(grant());
      await expect(store.withActiveActor({ accountId: account().id, principalId: `bot:${bot.id}` }, ["read"], NOW,
        async () => { throw new Error("job transaction failed"); })).rejects.toThrow("job transaction failed");
      expect((await store.revokeBot(account().id, bot.id, NOW + 1)).revokedAt).toBeGreaterThanOrEqual(NOW);
    });

    it("rechecks request and grant expiry after waiting for the account lock", async () => {
      await store.enroll(account(), request());
      const bot = await store.registerBot(grant({ expiresAt: NOW + 2 }));
      let release!: () => void;
      let entered!: () => void;
      const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      const lock = store.withActiveActor({ accountId: account().id, principalId: `owner:${account().id}` }, ["read"], NOW, async () => {
        entered();
        await released;
      });
      await enteredPromise;
      const authentication = expect(store.authorizeAndConsume(request({ nonce: nonce(2), signer: BOT, grantId: bot.id, expiresAt: NOW + 2 })))
        .rejects.toMatchObject({ code: "AUTH_REQUIRED" });
      const authority = expect(store.assertActive({ accountId: account().id, signer: BOT, grantId: bot.id, requiredScopes: ["read"], now: NOW }))
        .rejects.toMatchObject({ code: "FORBIDDEN" });
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      release();
      await Promise.all([lock, authentication, authority]);
    });

    it("rejects invalid time windows and oversized profile data without mutation", async () => {
      await store.enroll(account(), request());
      for (const changes of [{ expiresAt: NOW }, { issuedAt: NOW + 31 }, { expiresAt: NOW + 301 }, { now: 0.5 }, { nonce: "0x12" as Hex }]) {
        await expect(store.authorizeAndConsume(request({ nonce: nonce(2), ...changes }))).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
      }
      await expect(store.updateProfile(account().id, { displayName: "é".repeat(61), bio: "", avatarUri: null }, NOW + 1))
        .rejects.toMatchObject({ code: "STORAGE_LIMIT" });
      expect((await store.getAccount(account().id))!.profile.displayName).toBe("Garden");
      const updated = await store.updateProfile(account().id, { displayName: "New", bio: "", avatarUri: null }, NOW + 1);
      updated.profile.displayName = "Changed returned value";
      expect((await store.getAccount(account().id))!.profile.displayName).toBe("New");
    });
  });
}

(connectionString ? describe : describe.skip)("PostgreSQL durable actor admission helper", () => {
  beforeEach(async () => {
    NOW = Math.floor(Date.now() / 1_000);
    await pool!.query("TRUNCATE rest_request_nonces, rest_bot_grants, rest_accounts CASCADE");
  });

  it("rejects noncanonical grant profiles at the database constraint even when bypassing store validation", async () => {
    const store = new PostgresAccountStore(pool!);
    await store.enroll(account(), request());
    for (const scopes of [[], ["plan"], ["relay"], ["read", "relay"], ["plan", "read"],
      ["read", "relay", "plan"], ["read", "read"], ["read", null]]) {
      await expect(pool!.query(
        `INSERT INTO rest_bot_grants (id, account_id, bot_address, scopes, label, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [randomUUID(), account().id, BOT, scopes, "Invalid profile", NOW, NOW + 3_600],
      )).rejects.toMatchObject({ code: "23514" });
    }
    expect(await store.listBots(account().id)).toHaveLength(0);
  });

  it("retains its account row lock in the caller transaction and preserves rollback ownership", async () => {
    const store = new PostgresAccountStore(pool!);
    await store.enroll(account(), request());
    const bot = await store.registerBot(grant({ scopes: ["read", "plan", "relay"] }));
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      await assertRestActorActive(client, { accountId: account().id, principalId: `bot:${bot.id}` }, ["relay"], NOW);
      let completed = false;
      const revoke = store.revokeBot(account().id, bot.id, NOW + 1).then(() => { completed = true; });
      await expect(pool!.query("SELECT id FROM rest_accounts WHERE id = $1 FOR UPDATE NOWAIT", [account().id]))
        .rejects.toMatchObject({ code: "55P03" });
      // A queued revocation cannot finish until the caller, not the helper, releases its transaction.
      expect(completed).toBe(false);
      await client.query("ROLLBACK");
      await revoke;
      expect(completed).toBe(true);
      await expect(store.assertActive({ accountId: account().id, signer: BOT, grantId: bot.id, requiredScopes: ["relay"], now: NOW + 1 }))
        .rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("uses database time for authorization and cleanup despite stale or future application clocks", async () => {
    const store = new PostgresAccountStore(pool!);
    await store.enroll(account(), request());
    await expect(store.authorizeAndConsume(request({ nonce: nonce(2), issuedAt: NOW - 600, expiresAt: NOW - 300, now: NOW - 600 })))
      .rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(await store.cleanupExpiredNonces(NOW + 86_400)).toBe(0);
    await expect(store.authorizeAndConsume(request())).rejects.toMatchObject({ code: "REPLAY" });
    const bot = await store.registerBot(grant());
    // A fast application clock cannot expire a grant on behalf of the database.
    await expect(store.assertActive({ accountId: account().id, signer: BOT, grantId: bot.id, requiredScopes: ["read"], now: NOW + 86_400 })).resolves.toBeUndefined();
    await pool!.query("UPDATE rest_bot_grants SET created_at = $2 - 1, expires_at = $2 WHERE id = $1", [bot.id, NOW]);
    await expect(store.withActiveActor({ accountId: account().id, principalId: `bot:${bot.id}` }, ["read"], NOW - 600, async () => "admitted"))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("stamps account and grant lifecycle times using the same database authority clock", async () => {
    const store = new PostgresAccountStore(pool!);
    const future = NOW + 20;
    const principal = await store.enroll({ ...account(), createdAt: future, updatedAt: future }, request({ now: future }));
    expect(principal.account.createdAt).toBeGreaterThanOrEqual(NOW);
    expect(principal.account.createdAt).toBeLessThan(future);
    const bot = await store.registerBot(grant({ createdAt: future }));
    expect(bot.createdAt).toBeLessThan(future);
    await expect(store.assertActive({ accountId: account().id, signer: BOT, grantId: bot.id, requiredScopes: ["read"], now: NOW }))
      .resolves.toBeUndefined();
    const updated = await store.updateProfile(account().id, { displayName: "Renamed", bio: "", avatarUri: null }, NOW + 86_400);
    expect(updated.updatedAt).toBeLessThan(future);
    const revoked = await store.revokeBot(account().id, bot.id, NOW + 86_400);
    expect(revoked.revokedAt).toBeLessThan(future);
    await expect(store.registerBot(grant({ expiresAt: NOW + 366 * 86_400 }))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rolls back an in-flight replay when its nonce expires and cleanup wins between SQL queries", async () => {
    const store = new PostgresAccountStore(pool!);
    const shortRequest = request({ expiresAt: NOW + 2 });
    await store.enroll(account(), shortRequest);
    const client = await pool!.connect();
    let entered!: () => void;
    let resume!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    const gatedClient = new Proxy(client, {
      get(target, property) {
        if (property === "release") return () => undefined;
        if (property === "query") return async (...args: unknown[]) => {
          if (typeof args[0] === "string" && args[0].startsWith("SELECT 1 FROM rest_request_nonces")) {
            entered();
            await resumed;
          }
          return Reflect.apply(target.query, target, args);
        };
        return Reflect.get(target, property, target);
      },
    });
    const gatedStore = new PostgresAccountStore({ connect: async () => gatedClient } as unknown as Pool);
    const replay = gatedStore.authorizeAndConsume(shortRequest);
    // Attach the rejection handler before advancing the database's real clock.
    const rejected = expect(replay).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    try {
      await Promise.race([enteredPromise, replay.then(
        () => { throw new Error("Replay unexpectedly completed before the SQL gate"); },
        (error: unknown) => { throw error; },
      )]);
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      expect(await store.cleanupExpiredNonces(Math.floor(Date.now() / 1_000))).toBe(1);
      resume();
      await rejected;
      const rows = await pool!.query("SELECT 1 FROM rest_request_nonces WHERE account_id = $1", [account().id]);
      expect(rows.rowCount).toBe(0);
    } finally {
      resume();
      await replay.catch(() => undefined);
      client.release();
    }
  });
});
