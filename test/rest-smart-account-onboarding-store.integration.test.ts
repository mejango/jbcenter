import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { zeroHash, type Address, type Hex } from "viem";
import { migrate } from "../src/db/migrate.js";
import { PostgresAccountStore } from "../src/rest/auth/postgres.js";
import type { Account, BotGrant } from "../src/rest/auth/store.js";
import { PostgresOnboardingStore } from "../src/rest/smartAccounts/onboardingPostgres.js";
import { PostgresSmartAccountRegistry } from "../src/rest/smartAccounts/postgres.js";
import { fingerprint } from "../src/rest/smartAccounts/service.js";
import type { SmartAccountBinding } from "../src/rest/smartAccounts/types.js";

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const schema = `smart_onboarding_test_${randomUUID().replaceAll("-", "")}`;
const owner = "0x1111111111111111111111111111111111111111" as const;
const otherOwner = "0x2222222222222222222222222222222222222222" as const;
const nonce = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
let admin: Pool, pool: Pool, store: PostgresOnboardingStore;
let accounts: PostgresAccountStore, registry: PostgresSmartAccountRegistry, now: number;

function record(n: number, ownerAddress: Address = owner, issuedAt = now): {
  account: Account; binding: SmartAccountBinding; grant: BotGrant;
} {
  const account: Account = {
    id: `eip155:1:${ownerAddress}`,
    ownerAddress,
    authorityChainId: 1,
    profile: { displayName: "Garden", bio: "Public goods", avatarUri: null },
    createdAt: issuedAt,
    updatedAt: issuedAt,
  };
  const grant: BotGrant = {
    id: randomUUID(), accountId: account.id, botAddress: address(1000 + n),
    scopes: ["read", "plan", "relay"], label: "Beep checkout",
    createdAt: issuedAt, expiresAt: issuedAt + 3600, revokedAt: null,
  };
  const wallet = { chainId: 1, address: address(100 + n) };
  const binding: SmartAccountBinding = {
    id: fingerprint({ ownerAccountId: account.id, wallet: wallet.address, chainId: wallet.chainId }),
    ownerAccountId: account.id, ownerAddress, wallet, manifestId: "fixture",
    authorization: {
      digest: nonce(n + 200), nonce: nonce(n), expiresAt: issuedAt + 300,
      method: "safe-current-owner-threshold-and-api-grant",
      setup: {
        manifestRevision: zeroHash, initializerHash: nonce(n + 300), issuedAt,
        grantId: grant.id, botAddress: grant.botAddress, scopes: [...grant.scopes],
        grantExpiresAt: grant.expiresAt, label: grant.label,
      },
    },
    state: {
      ...wallet, manifestId: "fixture", manifestRevision: zeroHash,
      owners: [ownerAddress], threshold: 1, safeNonce: "0", stateHash: nonce(n + 100),
      evidence: { chainId: 1, blockNumber: "100", blockHash: zeroHash, timestamp: "1", source: "onchain" },
      codeHashes: [], modules: {
        stateHash: nonce(n + 400), complete: true, arbitrarySigningDisabled: true,
        wildcardExecutionDisabled: true, details: { sessions: [] },
      },
      moduleConfigurationVerified: true, executionVerified: true,
    },
  };
  return { account, binding, grant };
}

async function usage(accountId: string) {
  const result = await pool.query(
    `SELECT (SELECT count(*)::int FROM rest_accounts WHERE id=$1) AS accounts,
      (SELECT count(*)::int FROM rest_smart_account_bindings WHERE account_id=$1) AS bindings,
      (SELECT count(*)::int FROM rest_smart_account_binding_nonces WHERE account_id=$1) AS nonces,
      (SELECT count(*)::int FROM rest_bot_grants WHERE account_id=$1) AS grants`,
    [accountId],
  );
  return result.rows[0];
}

function passkeyRecord(n: number, walletAddress = address(100 + n)) {
  const input = record(n), signer = address(9000), accountId = `eip155:8453:${walletAddress.toLowerCase()}`;
  input.account = { ...input.account, id: accountId, ownerAddress: walletAddress, authorityChainId: 8453 };
  input.grant.accountId = accountId;
  input.binding.ownerAccountId = accountId;
  input.binding.ownerAddress = walletAddress;
  input.binding.wallet = { chainId: 8453, address: walletAddress };
  input.binding.id = fingerprint({ ownerAccountId: accountId, wallet: walletAddress, chainId: 8453 });
  input.binding.authorization.method = "safe-passkey-owner-threshold-and-api-grant";
  input.binding.state = { ...input.binding.state, chainId: 8453, address: walletAddress, owners: [signer, owner],
    evidence: { ...input.binding.state.evidence, chainId: 8453, timestamp: String(now) },
    ownerProfile: { version: "center-passkey-v1", signer: { address: signer, kind: "contract", x: nonce(1), y: nonce(2),
      verifiers: `0x${"11".repeat(22)}`, runtimeCodeHash: nonce(3) }, recoveryOwner: { address: owner, kind: "ecdsa" } } };
  input.binding.state.modules!.details = { sessions: { permissionIds: [] }, provenance: { initializerHash: input.binding.authorization.setup!.initializerHash } };
  return input;
}

suite("atomic PostgreSQL smart account onboarding", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 12 });
    await migrate(pool);
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE rest_accounts CASCADE");
    now = Number((await pool.query("SELECT floor(extract(epoch FROM clock_timestamp()))::text AS now")).rows[0].now);
    store = new PostgresOnboardingStore(pool);
    accounts = new PostgresAccountStore(pool);
    registry = new PostgresSmartAccountRegistry(pool);
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it("commits the versioned Safe identity once across concurrent store instances and preserves it after owner rotation", async () => {
    const input = passkeyRecord(1), peer = new PostgresOnboardingStore(pool);
    const results = await Promise.all(Array.from({ length: 12 }, (_, n) => (n % 2 ? peer : store).finalize(input)));
    expect(results.every((result) => result.account.id === input.account.id && result.grant.id === input.grant.id)).toBe(true);
    expect(await usage(input.account.id)).toEqual({ accounts: 1, bindings: 1, nonces: 1, grants: 1 });
    const next = passkeyRecord(2, input.binding.wallet.address);
    next.binding.state.ownerProfile!.recoveryOwner.address = otherOwner;
    next.binding.state.owners = [next.binding.state.ownerProfile!.signer.address, otherOwner];
    const rotated = await peer.finalize(next);
    expect(rotated.account).toEqual(results[0]!.account);
    expect(rotated.binding.id).toBe(input.binding.id);
    expect(rotated.binding.state.ownerProfile!.recoveryOwner.address).toBe(otherOwner);
    await expect(store.finalize(input)).rejects.toThrow();
    await expect(accounts.assertActive({ accountId: input.account.id, signer: next.grant.botAddress,
      grantId: next.grant.id, requiredScopes: ["read", "plan", "relay"], ownerOnly: true, now })).rejects.toThrow();
    expect(await usage(input.account.id)).toEqual({ accounts: 1, bindings: 1, nonces: 2, grants: 2 });
  });

  it("serializes conflicting passkey setup digests and never restores a revoked browser grant", async () => {
    const first = passkeyRecord(1), second = passkeyRecord(2, first.binding.wallet.address);
    second.binding.authorization.nonce = first.binding.authorization.nonce;
    const outcomes = await Promise.allSettled([store.finalize(first), new PostgresOnboardingStore(pool).finalize(second)]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const winner = outcomes[0]!.status === "fulfilled" ? first : second;
    expect(await usage(first.account.id)).toEqual({ accounts: 1, bindings: 1, nonces: 1, grants: 1 });
    await accounts.revokeBot(winner.account.id, winner.grant.id, now);
    await expect(store.finalize(winner)).rejects.toThrow();
  });

  it("enforces the new profile and Safe principal in the database independently of service validation", async () => {
    const input = passkeyRecord(1);
    await store.finalize(input);
    for (const [path, value] of [
      [["state", "ownerProfile", "version"], "legacy-eoa"], [["ownerAddress"], owner],
      [["state", "chainId"], 1], [["state", "address"], otherOwner],
    ] as const) await expect(pool.query("UPDATE rest_smart_account_bindings SET document=jsonb_set(document,$2::text[],$3::jsonb) WHERE id=$1",
      [input.binding.id, path, JSON.stringify(value)])).rejects.toMatchObject({ code: "23514" });
    expect(await registry.get(input.account.id, input.binding.id)).toEqual(input.binding);
  });

  it("commits concurrent identical finalizations once and returns the same exact grant", async () => {
    const input = record(1);
    const results = await Promise.all(Array.from({ length: 12 }, () => store.finalize(input)));
    for (const result of results) expect(result).toEqual(results[0]);
    expect(results[0]).toMatchObject({ account: { id: input.account.id }, binding: input.binding,
      grant: { id: input.grant.id, botAddress: input.grant.botAddress, scopes: input.grant.scopes, expiresAt: input.grant.expiresAt } });
    expect(await usage(input.account.id)).toEqual({ accounts: 1, bindings: 1, nonces: 1, grants: 1 });
    expect(await registry.get(input.account.id, input.binding.id)).toEqual(input.binding);
    await expect(accounts.assertActive({ accountId: input.account.id, signer: input.grant.botAddress,
      grantId: input.grant.id, requiredScopes: ["read", "plan", "relay"], now })).resolves.toBeUndefined();
  });

  it("serializes competing digests for one nonce without partial enrollment or grants", async () => {
    const first = record(1), second = record(2);
    second.binding.authorization.nonce = first.binding.authorization.nonce;
    const results = await Promise.allSettled([store.finalize(first), store.finalize(second)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = results[0]!.status === "fulfilled" ? first : second;
    expect(await usage(first.account.id)).toEqual({ accounts: 1, bindings: 1, nonces: 1, grants: 1 });
    expect(await registry.list(first.account.id)).toEqual([winner.binding]);
    expect((await accounts.listBots(first.account.id)).map((grant) => grant.id)).toEqual([winner.grant.id]);
  });

  it("rolls back enrollment and nonce consumption when the browser grant UUID already exists", async () => {
    const first = record(1), second = record(2, otherOwner);
    await store.finalize(first);
    second.grant.id = first.grant.id;
    second.binding.authorization.setup!.grantId = first.grant.id;
    await expect(store.finalize(second)).rejects.toThrow();
    expect(await usage(second.account.id)).toEqual({ accounts: 0, bindings: 0, nonces: 0, grants: 0 });
    expect((await accounts.listBots(first.account.id))[0]!.botAddress).toBe(first.grant.botAddress);
    second.grant.id = randomUUID();
    second.binding.authorization.setup!.grantId = second.grant.id;
    await expect(store.finalize(second)).resolves.toMatchObject({ grant: { id: second.grant.id } });
    expect(await usage(second.account.id)).toEqual({ accounts: 1, bindings: 1, nonces: 1, grants: 1 });
  });

  it("enforces the global account quota across concurrent owners", async () => {
    store = new PostgresOnboardingStore(pool, { maxAccounts: 1 });
    const inputs = [record(1), record(2, otherOwner)];
    const results = await Promise.allSettled(inputs.map((input) => store.finalize(input)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    for (const [index, input] of inputs.entries()) {
      const count = results[index]!.status === "fulfilled" ? 1 : 0;
      expect(await usage(input.account.id)).toEqual({ accounts: count, bindings: count, nonces: count, grants: count });
    }
  });

  it("preserves the existing profile and account timestamps during fresh setup", async () => {
    const first = await store.finalize(record(1));
    const profile = { displayName: "Existing customer", bio: "Keep this", avatarUri: "ipfs://existing" };
    const existing = await accounts.updateProfile(first.account.id, profile, now);
    const next = record(2);
    next.account.profile = { displayName: "Replacement", bio: "", avatarUri: null };
    next.account.createdAt = 1;
    next.account.updatedAt = 1;
    const result = await store.finalize(next);
    expect(result.account).toEqual(existing);
    expect(await accounts.getAccount(first.account.id)).toEqual(existing);
  });

  it("rejects a changed account identity and an alternate identifier for the same owner", async () => {
    const first = record(1);
    await store.finalize(first);
    const changedOwner = record(2, otherOwner);
    changedOwner.account.id = first.account.id;
    changedOwner.binding.ownerAccountId = first.account.id;
    changedOwner.binding.id = fingerprint({ ownerAccountId: first.account.id,
      wallet: changedOwner.binding.wallet.address, chainId: 1 });
    changedOwner.grant.accountId = first.account.id;
    await expect(store.finalize(changedOwner)).rejects.toThrow();
    const changedChain = record(3);
    changedChain.account.authorityChainId = 2;
    await expect(store.finalize(changedChain)).rejects.toThrow();
    const alternate = record(4);
    alternate.account.id = "alternate";
    alternate.binding.ownerAccountId = "alternate";
    alternate.binding.id = fingerprint({ ownerAccountId: "alternate", wallet: alternate.binding.wallet.address, chainId: 1 });
    alternate.grant.accountId = "alternate";
    await expect(store.finalize(alternate)).rejects.toThrow();
    expect(await accounts.getAccount("alternate")).toBeNull();
    expect(await usage(first.account.id)).toEqual({ accounts: 1, bindings: 1, nonces: 1, grants: 1 });
  });

  it.each(["binding", "grant"] as const)("never restores a revoked %s through identical finalization replay", async (kind) => {
    const input = record(1);
    await store.finalize(input);
    if (kind === "binding") await registry.revoke(input.account.id, input.binding.id);
    else await accounts.revokeBot(input.account.id, input.grant.id, now);
    await expect(store.finalize(input)).rejects.toThrow();
    if (kind === "binding") expect(await registry.get(input.account.id, input.binding.id)).toBeUndefined();
    else expect((await accounts.listBots(input.account.id))[0]!.revokedAt).not.toBeNull();
    expect(await usage(input.account.id)).toEqual({ accounts: 1, bindings: 1, nonces: 1, grants: 1 });
  });

  it("does not restore a superseded binding even when its old grant is still active", async () => {
    const first = record(1), next = record(2);
    await store.finalize(first);
    next.binding.id = first.binding.id;
    next.binding.wallet = { ...first.binding.wallet };
    next.binding.state.address = first.binding.wallet.address;
    await store.finalize(next);
    await expect(store.finalize(first)).rejects.toThrow();
    expect(await registry.get(first.account.id, first.binding.id)).toEqual(next.binding);
    expect(await usage(first.account.id)).toEqual({ accounts: 1, bindings: 1, nonces: 2, grants: 2 });
  });

  it("requires the exact stored grant to remain unexpired during replay", async () => {
    const input = record(1);
    await store.finalize(input);
    await pool.query("UPDATE rest_bot_grants SET created_at=$2-3600,expires_at=$2-1 WHERE id=$1", [input.grant.id, now]);
    await expect(store.finalize(input)).rejects.toThrow();
    expect((await accounts.listBots(input.account.id))[0]!.expiresAt).toBe(now - 1);
    expect(await usage(input.account.id)).toEqual({ accounts: 1, bindings: 1, nonces: 1, grants: 1 });
  });

  it("counts revoked grants toward capacity and rolls back a replacement binding and nonce", async () => {
    store = new PostgresOnboardingStore(pool, { maxGrantsPerAccount: 1 });
    const first = record(1), next = record(2);
    await store.finalize(first);
    await accounts.revokeBot(first.account.id, first.grant.id, now);
    next.binding.id = first.binding.id;
    next.binding.wallet = { ...first.binding.wallet };
    next.binding.state.address = first.binding.wallet.address;
    await expect(store.finalize(next)).rejects.toMatchObject({ code: "SMART_ONBOARDING_GRANT_LIMIT", status: 429 });
    expect(await registry.get(first.account.id, first.binding.id)).toEqual(first.binding);
    expect(await usage(first.account.id)).toEqual({ accounts: 1, bindings: 1, nonces: 1, grants: 1 });
  });

  it("bounds wallet bindings and live setup nonces without creating an extra grant", async () => {
    const first = record(1);
    for (let n = 1; n <= 16; n++) await store.finalize(n === 1 ? first : record(n));
    await expect(store.finalize(record(17))).rejects.toThrow();
    expect(await usage(first.account.id)).toEqual({ accounts: 1, bindings: 16, nonces: 16, grants: 16 });
    await pool.query(
      `INSERT INTO rest_smart_account_binding_nonces(account_id,nonce,digest,expires_at)
       SELECT $1,'0x'||lpad(to_hex(n),64,'0'),'0x'||lpad(to_hex(n+10000),64,'0'),$2
       FROM generate_series(1000,1239) n`,
      [first.account.id, now + 300],
    );
    const next = record(18);
    next.binding.id = first.binding.id;
    next.binding.wallet = { ...first.binding.wallet };
    next.binding.state.address = first.binding.wallet.address;
    await expect(store.finalize(next)).rejects.toThrow();
    expect(await registry.get(first.account.id, first.binding.id)).toEqual(first.binding);
    expect(await usage(first.account.id)).toEqual({ accounts: 1, bindings: 16, nonces: 256, grants: 16 });
  });

  it("uses database time even when the application clock would accept an expired authorization", async () => {
    const input = record(1, owner, now - 400);
    const clock = vi.spyOn(Date, "now").mockReturnValue((now - 400) * 1000);
    try {
      await expect(store.finalize(input)).rejects.toThrow();
    } finally {
      clock.mockRestore();
    }
    expect(await usage(input.account.id)).toEqual({ accounts: 0, bindings: 0, nonces: 0, grants: 0 });
  });

  it("rechecks authorization expiry after waiting for the account row lock", async () => {
    const first = record(1);
    await store.finalize(first);
    const lock = await pool.connect();
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT id FROM rest_accounts WHERE id=$1 FOR UPDATE", [first.account.id]);
      const dbNow = Number((await lock.query("SELECT floor(extract(epoch FROM clock_timestamp()))::text AS now")).rows[0].now);
      const next = record(2, owner, dbNow - 299);
      const pending = expect(store.finalize(next)).rejects.toThrow();
      await lock.query("SELECT pg_sleep(1.1)");
      await lock.query("COMMIT");
      await pending;
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
    }
    expect(await usage(first.account.id)).toEqual({ accounts: 1, bindings: 1, nonces: 1, grants: 1 });
  });

  it("rolls back every write when authorization expires during grant insertion", async () => {
    await pool.query("CREATE SEQUENCE onboarding_grant_insertions");
    await pool.query(`CREATE FUNCTION delay_onboarding_grant() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM nextval('onboarding_grant_insertions'); PERFORM pg_sleep(1.1); RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER delay_onboarding_grant AFTER INSERT ON rest_bot_grants
      FOR EACH ROW EXECUTE FUNCTION delay_onboarding_grant()`);
    const dbNow = Number((await pool.query("SELECT floor(extract(epoch FROM clock_timestamp()))::text AS now")).rows[0].now);
    const input = record(1, owner, dbNow - 299);
    try {
      await expect(store.finalize(input)).rejects.toMatchObject({ code: "SMART_ONBOARDING_EXPIRED" });
      // Sequence increments survive rollback and prove the grant INSERT was reached before expiry.
      expect((await pool.query("SELECT is_called FROM onboarding_grant_insertions")).rows[0].is_called).toBe(true);
      expect(await usage(input.account.id)).toEqual({ accounts: 0, bindings: 0, nonces: 0, grants: 0 });
    } finally {
      await pool.query("DROP TRIGGER delay_onboarding_grant ON rest_bot_grants");
      await pool.query("DROP FUNCTION delay_onboarding_grant()");
      await pool.query("DROP SEQUENCE onboarding_grant_insertions");
    }
  });
});
