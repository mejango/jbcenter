import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  accountIdFor, buildRequestTypedData, createRestAuth, MemoryAccountStore,
  REST_AUTH_HEADERS as H, type Account, type AccountStoreOptions, type SignedRequestInput,
  type VerifiedRequest,
} from "../src/rest/auth/index.js";
import { MemoryOnboardingStore } from "../src/rest/smartAccounts/onboardingMemory.js";
import type { OnboardingRecord } from "../src/rest/smartAccounts/onboardingStore.js";
import { MemorySmartAccountRegistry } from "../src/rest/smartAccounts/registry.js";
import { fingerprint } from "../src/rest/smartAccounts/service.js";

const NOW = 1_900_000_000;
const audience = "https://juicebox.center";
const owner = privateKeyToAccount(`0x${"01".padStart(64, "0")}`).address.toLowerCase() as Address;
const other = privateKeyToAccount(`0x${"03".padStart(64, "0")}`).address.toLowerCase() as Address;
const browser = privateKeyToAccount(`0x${"02".padStart(64, "0")}`);
const hex = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;

function record(n = 1, ownerAddress = owner): OnboardingRecord {
  const address = `0x${(n + 100).toString(16).padStart(40, "0")}` as Address;
  const account: Account = {
    id: accountIdFor(ownerAddress, 8453), ownerAddress, authorityChainId: 8453,
    profile: { displayName: "", bio: "", avatarUri: null }, createdAt: NOW, updatedAt: NOW,
  };
  const grant = {
    id: randomUUID(), accountId: account.id, botAddress: browser.address.toLowerCase() as Address,
    scopes: ["read", "plan", "relay"] as const, label: "Beep checkout", createdAt: NOW,
    expiresAt: NOW + 3_600, revokedAt: null,
  };
  return {
    account, grant: { ...grant, scopes: [...grant.scopes] },
    binding: {
      id: fingerprint({ ownerAccountId: account.id, wallet: address, chainId: 8453 }),
      ownerAccountId: account.id, ownerAddress, wallet: { chainId: 8453, address }, manifestId: "fixture",
      authorization: {
        method: "safe-current-owner-threshold-and-api-grant", nonce: hex(n), digest: hex(n + 200),
        expiresAt: NOW + 300,
        setup: {
          manifestRevision: hex(500), initializerHash: hex(501), issuedAt: NOW, grantId: grant.id,
          botAddress: grant.botAddress, scopes: [...grant.scopes], grantExpiresAt: grant.expiresAt, label: grant.label,
        },
      },
      state: {
        chainId: 8453, address, manifestId: "fixture", manifestRevision: hex(500), owners: [ownerAddress],
        threshold: 1, safeNonce: "0", stateHash: hex(n + 300),
        evidence: { chainId: 8453, blockNumber: "100", blockHash: hex(502), timestamp: String(NOW), source: "onchain" },
        codeHashes: [], moduleConfigurationVerified: true, executionVerified: true,
        modules: {
          stateHash: hex(503), complete: true, arbitrarySigningDisabled: true, wildcardExecutionDisabled: true,
          details: { sessions: { permissionIds: [] }, provenance: { initializerHash: hex(501) } },
        },
      },
    },
  };
}

function fixture(options: AccountStoreOptions = {}, maximumBindings = 1_000, maximumNonces = 10_000) {
  let clock = NOW;
  const accounts = new MemoryAccountStore(options);
  const registry = new MemorySmartAccountRegistry(maximumBindings, maximumNonces);
  return {
    accounts, registry, store: new MemoryOnboardingStore(accounts, registry, () => clock),
    auth: createRestAuth({ store: accounts, audience, now: () => clock }),
    setClock: (value: number) => { clock = value; },
  };
}

function enrollmentRequest(account: Account): VerifiedRequest {
  return {
    accountId: account.id, signer: account.ownerAddress, grantId: null, nonce: hex(999),
    issuedAt: NOW, expiresAt: NOW + 300, now: NOW, requiredScopes: [], ownerOnly: true, idempotencyKey: null,
  };
}

async function browserRequest(input: OnboardingRecord, now = NOW): Promise<SignedRequestInput> {
  const body = new Uint8Array();
  const claims = {
    accountId: input.account.id, signer: browser.address, grantId: input.grant.id, method: "GET",
    requestTarget: `/api/v1/smart-accounts/${input.binding.id}`, contentType: "",
    bodyHash: keccak256(body), issuedAt: now, expiresAt: now + 60, nonce: hex(now), idempotencyKey: "",
  };
  const signature = await browser.signTypedData(buildRequestTypedData(audience, claims));
  return {
    method: claims.method, requestTarget: claims.requestTarget, contentType: claims.contentType, body,
    headers: new Headers({
      [H.account]: claims.accountId, [H.signer]: claims.signer, [H.grant]: claims.grantId,
      [H.issuedAt]: String(claims.issuedAt), [H.expiresAt]: String(claims.expiresAt),
      [H.nonce]: claims.nonce, [H.signature]: signature,
    }),
  };
}

describe("atomic memory account onboarding", () => {
  function passkeyRecord(n = 1): OnboardingRecord {
    const input = record(n), address = input.binding.wallet.address, signer = "0x9999999999999999999999999999999999999999";
    input.account.id = accountIdFor(address, 8453);
    input.account.ownerAddress = address;
    input.grant.accountId = input.account.id;
    input.binding.ownerAccountId = input.account.id;
    input.binding.ownerAddress = address;
    input.binding.id = fingerprint({ ownerAccountId: input.account.id, wallet: address, chainId: 8453 });
    input.binding.authorization.method = "safe-passkey-owner-threshold-and-api-grant";
    input.binding.state.owners = [signer, owner];
    input.binding.state.ownerProfile = { version: "center-passkey-v1", signer: { address: signer, kind: "contract",
      x: hex(1), y: hex(2), verifiers: `0x${"11".repeat(22)}`, runtimeCodeHash: hex(3) }, recoveryOwner: { address: owner, kind: "ecdsa" } };
    return input;
  }

  it("atomically sets up the Safe principal with a separate non-owner browser grant", async () => {
    const test = fixture(), input = passkeyRecord();
    const results = await Promise.all(Array.from({ length: 12 }, () => test.store.finalize(input)));
    expect(results.every((value) => value.account.id === accountIdFor(input.binding.wallet.address, 8453))).toBe(true);
    expect(await test.accounts.listBots(input.account.id)).toEqual([input.grant]);
    const principal = await test.auth.authenticate(await browserRequest(input));
    expect(principal).toMatchObject({ account: input.account, grantId: input.grant.id, isOwner: false });
    await expect(test.auth.assertActive(principal, "relay", true)).rejects.toMatchObject({ code: "FORBIDDEN" });
    input.binding.authorization.digest = hex(1000);
    await expect(test.store.finalize(input)).rejects.toThrow();
  });

  it("rejects passkey/legacy method substitution and inconsistent Safe-principal authority before persistence", async () => {
    for (const mutate of [
      (r: OnboardingRecord) => { r.binding.authorization.method = "safe-current-owner-threshold-and-api-grant"; },
      (r: OnboardingRecord) => { delete r.binding.state.ownerProfile; },
      (r: OnboardingRecord) => { r.account.ownerAddress = owner; r.binding.ownerAddress = owner; },
      (r: OnboardingRecord) => { r.account.authorityChainId = 1; },
      (r: OnboardingRecord) => { r.binding.state.owners = [owner]; },
      (r: OnboardingRecord) => { r.binding.authorization.setup!.initializerHash = hex(600); },
    ]) {
      const test = fixture(), input = passkeyRecord(); mutate(input);
      await expect(test.store.finalize(input)).rejects.toThrow();
      expect(await test.accounts.getAccount(input.account.id)).toBeNull();
      expect(await test.registry.list(input.account.id)).toEqual([]);
    }
    const test = fixture(), legacy = record();
    legacy.binding.authorization.method = "safe-passkey-owner-threshold-and-api-grant";
    await expect(test.store.finalize(legacy)).rejects.toThrow();
  });

  it("saves the exact account, binding and browser UUID in ordinary stores and authenticates recovery after consent expires", async () => {
    const test = fixture(), input = record();
    expect(await test.store.finalize(input)).toEqual(input);
    expect(await test.accounts.getAccount(input.account.id)).toEqual(input.account);
    expect(await test.accounts.listBots(input.account.id)).toEqual([input.grant]);
    expect(await test.registry.get(input.account.id, input.binding.id)).toEqual(input.binding);
    test.setClock(NOW + 301);
    await expect(test.store.finalize(input)).rejects.toThrow();
    const principal = await test.auth.authenticate(await browserRequest(input, NOW + 301));
    expect(principal).toMatchObject({ principalId: `bot:${input.grant.id}`, grantId: input.grant.id, isOwner: false });
    expect(await test.registry.get(principal.account.id, input.binding.id)).toEqual(input.binding);
    await expect(test.auth.assertActive(principal, "relay", true)).rejects.toMatchObject({ code: "FORBIDDEN" });
    test.setClock(input.grant.expiresAt);
    await expect(test.auth.authenticate(await browserRequest(input, input.grant.expiresAt))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("preserves an enrolled profile and does not expose mutable authority records", async () => {
    const test = fixture(), input = record();
    const existing = { ...input.account, profile: { displayName: "Garden", bio: "Public goods", avatarUri: null } };
    await test.accounts.enroll(existing, enrollmentRequest(existing));
    const saved = await test.store.finalize(input);
    expect(saved.account).toEqual(existing);
    saved.binding.authorization.digest = hex(777);
    saved.grant.scopes.length = 0;
    input.account.profile.displayName = "Overwritten";
    expect(await test.accounts.getAccount(existing.id)).toEqual(existing);
    expect(await test.accounts.listBots(existing.id)).toEqual([input.grant]);
    expect((await test.registry.get(existing.id, input.binding.id))?.authorization.digest).toBe(input.binding.authorization.digest);
  });

  it("keeps concurrent identical finalizations idempotent and rejects a changed digest for the consumed nonce", async () => {
    const test = fixture(), input = record();
    const saved = await Promise.all(Array.from({ length: 20 }, () => test.store.finalize(input)));
    expect(saved.every((value) => value.grant.id === input.grant.id)).toBe(true);
    expect(await test.accounts.listBots(input.account.id)).toEqual([input.grant]);
    expect(await test.registry.list(input.account.id)).toEqual([input.binding]);
    const changed = structuredClone(input);
    changed.binding.authorization.digest = hex(700);
    await expect(test.store.finalize(changed)).rejects.toThrow();
    expect(await test.registry.get(input.account.id, input.binding.id)).toEqual(input.binding);
  });

  it.each(["grant", "binding", "superseded binding"] as const)("never restores a revoked or %s through old consent", async (kind) => {
    const test = fixture(), input = record();
    await test.store.finalize(input);
    if (kind === "grant") await test.accounts.revokeBot(input.account.id, input.grant.id, NOW);
    else if (kind === "binding") await test.registry.revoke(input.account.id, input.binding.id);
    else {
      const replacement = structuredClone(input.binding);
      replacement.authorization.nonce = hex(900);
      replacement.authorization.digest = hex(901);
      await test.registry.bind(replacement);
    }
    await expect(test.store.finalize(input)).rejects.toThrow();
    if (kind === "grant") {
      expect((await test.accounts.listBots(input.account.id))[0]?.revokedAt).toBe(NOW);
      await expect(test.auth.authenticate(await browserRequest(input))).rejects.toMatchObject({ code: "FORBIDDEN" });
    } else {
      expect((await test.registry.get(input.account.id, input.binding.id))?.authorization.digest)
        .toBe(kind === "binding" ? undefined : hex(901));
    }
  });

  it.each(["grant", "binding"] as const)("serializes an ordinary %s revocation against finalization replay", async (kind) => {
    const test = fixture(), input = record();
    await test.store.finalize(input);
    const results = await Promise.allSettled([
      test.store.finalize(input),
      kind === "grant" ? test.accounts.revokeBot(input.account.id, input.grant.id, NOW)
        : test.registry.revoke(input.account.id, input.binding.id),
    ]);
    expect(results[1]?.status).toBe("fulfilled");
    await expect(test.store.finalize(input)).rejects.toThrow();
    if (kind === "grant") expect((await test.accounts.listBots(input.account.id))[0]?.revokedAt).toBe(NOW);
    else expect(await test.registry.get(input.account.id, input.binding.id)).toBeUndefined();
  });

  it.each([
    ["account cap", { maxAccounts: 1 }], ["grant cap", { maxGrantsPerAccount: 1 }],
  ] as const)("leaves no binding or claimed setup nonce when the %s rejects finalization", async (kind, limits) => {
    const test = fixture(limits), input = record(), occupied = record(2, kind === "account cap" ? other : owner);
    await test.accounts.enroll(occupied.account, enrollmentRequest(occupied.account));
    if (kind === "grant cap") await test.accounts.registerBot(occupied.grant);
    await expect(test.store.finalize(input)).rejects.toMatchObject({
      code: kind === "grant cap" ? "SMART_ONBOARDING_GRANT_LIMIT" : "STORAGE_LIMIT", status: 429,
    });
    expect(await test.registry.get(input.account.id, input.binding.id)).toBeUndefined();
    expect(await test.accounts.getAccount(input.account.id)).toEqual(kind === "account cap" ? null : occupied.account);
    if (kind === "grant cap") expect(await test.accounts.listBots(input.account.id)).toEqual([occupied.grant]);
    const changed = structuredClone(input.binding);
    changed.authorization.digest = hex(800);
    await expect(test.registry.bind(changed)).resolves.toEqual(changed);
  });

  it("rolls back a registry-cap failure, then accepts the same nonce with a different digest when capacity is free", async () => {
    const test = fixture({}, 1), input = record(), occupied = record(2, other);
    await test.registry.bind(occupied.binding);
    await expect(test.store.finalize(input)).rejects.toThrow();
    expect(await test.accounts.getAccount(input.account.id)).toBeNull();
    expect(await test.registry.get(input.account.id, input.binding.id)).toBeUndefined();
    await test.registry.revoke(occupied.account.id, occupied.binding.id);
    input.binding.authorization.digest = hex(800);
    await expect(test.store.finalize(input)).resolves.toEqual(input);
  });

  it("does not enroll an account when the registry nonce budget is full", async () => {
    const test = fixture({}, 10, 1), input = record(), occupied = record(2, other);
    await test.registry.bind(occupied.binding);
    await test.registry.revoke(occupied.account.id, occupied.binding.id);
    await expect(test.store.finalize(input)).rejects.toThrow();
    expect(await test.accounts.getAccount(input.account.id)).toBeNull();
    expect(await test.registry.list(input.account.id)).toEqual([]);
  });

  it.each(["enrollment", "grant registration", "binding"] as const)("preserves capacity while ordinary %s races finalization", async (kind) => {
    const test = fixture({ maxAccounts: 1, maxGrantsPerAccount: 1 }, 1), input = record(), competitor = record(2, other);
    if (kind === "grant registration") await test.accounts.enroll(input.account, enrollmentRequest(input.account));
    const ordinary = () => kind === "enrollment" ? test.accounts.enroll(competitor.account, enrollmentRequest(competitor.account))
      : kind === "grant registration" ? test.accounts.registerBot({ ...competitor.grant, accountId: input.account.id })
        : test.registry.bind(competitor.binding);
    const results = await Promise.allSettled([test.store.finalize(input), ordinary()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const committed = results[0]?.status === "fulfilled";
    expect(await test.registry.get(input.account.id, input.binding.id)).toEqual(committed ? input.binding : undefined);
    if (kind === "grant registration") expect(await test.accounts.listBots(input.account.id)).toHaveLength(1);
    else expect(await test.accounts.getAccount(input.account.id)).toEqual(committed ? input.account : null);
  });

  it("checks consent expiry after waiting for ordinary account work", async () => {
    const test = fixture(), input = record();
    await test.accounts.enroll(input.account, enrollmentRequest(input.account));
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const locked = test.accounts.withActiveActor({ accountId: input.account.id, principalId: `owner:${input.account.id}` }, [], NOW,
      async () => { entered(); await waiting; });
    await ready;
    const outcome = test.store.finalize(input);
    test.setClock(NOW + 300);
    release();
    await locked;
    await expect(outcome).rejects.toThrow();
    expect(await test.accounts.listBots(input.account.id)).toEqual([]);
    expect(await test.registry.get(input.account.id, input.binding.id)).toBeUndefined();
    test.setClock(NOW);
    await expect(test.store.finalize(input)).resolves.toEqual(input);
  });

  it.each([
    ["different grant UUID", (input: OnboardingRecord) => { input.grant.id = randomUUID(); }],
    ["broader grant scope", (input: OnboardingRecord) => { input.binding.authorization.setup!.scopes = ["read"]; }],
    ["different browser key", (input: OnboardingRecord) => { input.grant.botAddress = other; }],
    ["different account", (input: OnboardingRecord) => { input.grant.accountId = accountIdFor(other, 8453); }],
    ["long consent", (input: OnboardingRecord) => { input.binding.authorization.expiresAt = NOW + 301; }],
    ["long grant", (input: OnboardingRecord) => {
      input.grant.expiresAt = NOW + 3_601; input.binding.authorization.setup!.grantExpiresAt = input.grant.expiresAt;
    }],
  ] as const)("rejects %s without leaving enrollment or nonce state", async (_, change) => {
    const test = fixture(), input = record(), changed = structuredClone(input);
    change(changed);
    await expect(test.store.finalize(changed)).rejects.toThrow();
    expect(await test.accounts.getAccount(input.account.id)).toBeNull();
    expect(await test.registry.list(input.account.id)).toEqual([]);
    await expect(test.store.finalize(input)).resolves.toEqual(input);
  });
});
