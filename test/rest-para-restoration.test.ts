import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, stringToHex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { accountIdFor, buildRequestTypedData } from "../src/rest/auth/signatures.js";
import type { Provider } from "../src/rest/web/para.js";

type Wallet = { id: string; userId: string; type: string; address: string };
const sdk = vi.hoisted(() => ({
  construct: vi.fn(), bridge: vi.fn(), setup: vi.fn(), isLoggedIn: vi.fn(), logout: vi.fn(), sign: vi.fn(),
  ready: true, readyListeners: new Set<(ready: boolean) => void>(), unsubscribeReady: vi.fn(),
  account: undefined as LocalAccount | undefined,
  userId: "user-1", walletIds: ["wallet-1"], wallets: {} as Record<string, Wallet>,
}));
vi.mock("@getpara/web-sdk", () => ({
  Environment: { BETA: "beta", PROD: "prod" },
  default: class {
    constructor(environment: string, key: string) { sdk.construct(environment, key); }
    setup = sdk.setup;
    isFullyLoggedIn = sdk.isLoggedIn;
    logout = sdk.logout;
    get userId() { return sdk.userId; }
    get currentWalletIds() { return { EVM: sdk.walletIds }; }
    get isReady() { return sdk.ready; }
    onReadyStateChange(listener: (ready: boolean) => void) {
      sdk.readyListeners.add(listener);
      return () => { sdk.unsubscribeReady(); sdk.readyListeners.delete(listener); };
    }
    getWallets() { return sdk.wallets; }
  },
}));
vi.mock("@getpara/viem-v2-integration", () => ({
  createParaViemAccount: (input: unknown) => { sdk.bridge(input); return sdk.account; },
}));

const owner = privateKeyToAccount(`0x${"01".padStart(64, "0")}`);
const other = privateKeyToAccount(`0x${"02".padStart(64, "0")}`);
const storageKey = "juicebox-center.sign-in";
const audience = "https://juicebox.center";
let stored: Map<string, string>;
let browser: EventTarget & {
  localStorage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn> };
  location: { origin: string }; ethereum: Provider | undefined;
};
let approvalElement: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(1_900_000_000_000);
  for (const mock of [sdk.construct, sdk.bridge, sdk.setup, sdk.isLoggedIn, sdk.logout, sdk.sign, sdk.unsubscribeReady]) mock.mockReset();
  sdk.ready = true; sdk.readyListeners.clear();
  sdk.setup.mockResolvedValue(undefined); sdk.isLoggedIn.mockResolvedValue(true); sdk.logout.mockResolvedValue(undefined);
  sdk.sign.mockImplementation(owner.signTypedData);
  sdk.account = { ...owner, signTypedData: sdk.sign as typeof owner.signTypedData };
  sdk.userId = "user-1"; sdk.walletIds = ["wallet-1"];
  sdk.wallets = { "wallet-1": { id: "wallet-1", userId: "user-1", type: "EVM", address: owner.address } };
  stored = new Map();
  browser = Object.assign(new EventTarget(), {
    localStorage: { getItem: vi.fn((key: string) => stored.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { stored.set(key, value); }) },
    location: { origin: audience }, ethereum: undefined as Provider | undefined,
  });
  approvalElement = vi.fn(() => { throw new Error("Explicit approval UI required"); });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", { body: { dataset: { paraApiKey: "public-test-key", paraEnvironment: "BETA", audience } }, getElementById: approvalElement });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected request"); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function save(type = "para", extra: Record<string, unknown> = {}) {
  stored.set(storageKey, JSON.stringify({ version: 1, type, owner: owner.address, chainId: 1, ...extra }));
}
function external(accounts = [owner.address], chain = "0x1") {
  return { request: vi.fn(async ({ method }: { method: string }) => {
    if (method === "eth_accounts") return accounts;
    if (method === "eth_chainId") return chain;
    throw new Error(`Unexpected wallet method: ${method}`);
  }) };
}
function announce(entries: { provider: Provider; rdns: string }[]) {
  browser.addEventListener("eip6963:requestProvider", () => {
    for (const entry of entries) browser.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { provider: entry.provider, info: { rdns: entry.rdns } } }));
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function restoreExternal(api: typeof import("../src/rest/web/para.js")) {
  const restoring = api.restoreSignIn();
  await vi.advanceTimersByTimeAsync(400);
  return restoring;
}

describe("remembered account restoration", () => {
  it("does not load the SDK or contact a wallet for a fresh visitor", async () => {
    const discovery = vi.fn(); browser.addEventListener("eip6963:requestProvider", discovery);
    const api = await import("../src/rest/web/para.js");
    expect(await api.restoreSignIn()).toBeUndefined();
    expect(sdk.construct).not.toHaveBeenCalled(); expect(discovery).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled(); expect(approvalElement).not.toHaveBeenCalled();
  });

  it("restores a verified Para wallet and network using only public saved metadata", async () => {
    save("para", { chainId: 8453 });
    const api = await import("../src/rest/web/para.js");
    const provider = await api.restoreSignIn();
    expect(provider).toBeDefined();
    expect(await provider!.request({ method: "eth_accounts" })).toEqual([owner.address]);
    expect(await provider!.request({ method: "eth_chainId" })).toBe("0x2105");
    expect(api.restoredAuthorityChainId(provider!, owner.address, 8453)).toBe(8453);
    expect(api.restoredIdentityMatches(provider!, owner.address, 8453)).toBe(true);
    expect(api.restoredIdentityMatches(provider!, other.address, 8453)).toBe(false);
    expect(api.restoredIdentityMatches(provider!, owner.address, 1)).toBe(false);
    expect(sdk.construct).toHaveBeenCalledExactlyOnceWith("beta", "public-test-key");
    expect(sdk.sign).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(approvalElement).not.toHaveBeenCalled();
    api.rememberSignIn(provider!, owner.address, 8453);
    expect(JSON.parse(stored.get(storageKey)!)).toEqual({ version: 1, type: "para", owner: owner.address, chainId: 8453 });
    api.rememberSignIn(external(), other.address, 1);
    expect(JSON.parse(stored.get(storageKey)!).owner).toBe(owner.address);
  });

  it.each(["para", "external"])("restores the stable API authority separately from the last %s execution network", async (type) => {
    save(type, { chainId: 1, walletChainId: 10, ...(type === "external" ? { rdns: "com.example.wallet" } : {}) });
    const candidate = external([owner.address], "0xa");
    if (type === "external") announce([{ provider: candidate, rdns: "com.example.wallet" }]);
    const api = await import("../src/rest/web/para.js");
    const provider = type === "external" ? await restoreExternal(api) : await api.restoreSignIn();
    expect(provider).toBeDefined();
    expect(await provider!.request({ method: "eth_chainId" })).toBe("0xa");
    expect(api.restoredAuthorityChainId(provider!, owner.address, 10)).toBe(1);
    expect(api.restoredAuthorityChainId(provider!, owner.address, 1)).toBeUndefined();
    expect(api.restoredAuthorityChainId(provider!, other.address, 10)).toBeUndefined();
    api.rememberSignIn(provider!, owner.address, 1, 10);
    expect(JSON.parse(stored.get(storageKey)!)).toEqual({ version: 1, type, owner: owner.address, chainId: 1, walletChainId: 10,
      ...(type === "external" ? { rdns: "com.example.wallet" } : {}) });
    expect(sdk.sign).not.toHaveBeenCalled();
  });

  it("persists execution changes without changing the API account and omits a redundant wallet network", async () => {
    save(); const api = await import("../src/rest/web/para.js"), provider = await api.restoreSignIn();
    await provider!.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xa" }] });
    api.rememberSignIn(provider!, owner.address, 1, 10);
    expect(JSON.parse(stored.get(storageKey)!)).toEqual({ version: 1, type: "para", owner: owner.address, chainId: 1, walletChainId: 10 });
    await provider!.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] });
    api.rememberSignIn(provider!, owner.address, 1, 1);
    expect(JSON.parse(stored.get(storageKey)!)).toEqual({ version: 1, type: "para", owner: owner.address, chainId: 1 });
    api.rememberSignIn(provider!, owner.address, 1, 0);
    expect(JSON.parse(stored.get(storageKey)!)).toEqual({ version: 1, type: "para", owner: owner.address, chainId: 1 });
  });

  it.each(["wrong user", "wrong wallet", "inactive wallet"])("does not restore a saved Para account with a %s", async (mismatch) => {
    save();
    if (mismatch === "wrong user") sdk.userId = "user-2";
    if (mismatch === "wrong wallet") sdk.wallets["wallet-1"]!.address = other.address;
    if (mismatch === "inactive wallet") sdk.walletIds = [];
    const api = await import("../src/rest/web/para.js");
    await expect(api.restoreSignIn()).rejects.toMatchObject({ name: "CenterWalletError" });
    expect(sdk.bridge).not.toHaveBeenCalled(); expect(sdk.sign).not.toHaveBeenCalled();
  });

  it("waits for SDK readiness before deciding whether the stored session is authenticated", async () => {
    save(); sdk.ready = false;
    const api = await import("../src/rest/web/para.js"), restoring = api.restoreSignIn();
    await vi.dynamicImportSettled();
    expect(sdk.isLoggedIn).not.toHaveBeenCalled(); expect(sdk.bridge).not.toHaveBeenCalled();
    sdk.ready = true;
    for (const listener of sdk.readyListeners) listener(true);
    expect(await restoring).toBeDefined();
    expect(sdk.unsubscribeReady).toHaveBeenCalledOnce(); expect(sdk.readyListeners.size).toBe(0);
  });

  it("does not reuse the automatic enrollment shortcut after restoration", async () => {
    save();
    const api = await import("../src/rest/web/para.js");
    const provider = await api.restoreSignIn();
    const data = buildRequestTypedData(audience, {
      accountId: accountIdFor(owner.address, 1), signer: owner.address, grantId: "", method: "POST", requestTarget: "/api/v1/accounts/enroll",
      contentType: "application/json", bodyHash: keccak256(stringToHex("{}")), issuedAt: 1_900_000_000, expiresAt: 1_900_000_300,
      nonce: `0x${"ab".repeat(32)}`, idempotencyKey: "",
    });
    await expect(provider!.request({ method: "eth_signTypedData_v4", params: [owner.address, data] })).rejects.toThrow("Explicit approval UI required");
    expect(approvalElement).toHaveBeenCalledExactlyOnceWith("para-approval");
    expect(sdk.sign).not.toHaveBeenCalled();
  });

  it.each([true, false])("verifies the live SDK session when migrating an older public user ID (logged in: %s)", async (loggedIn) => {
    stored.set("@CAPSULE/userId", "public-user-id"); sdk.isLoggedIn.mockResolvedValue(loggedIn);
    const api = await import("../src/rest/web/para.js");
    expect(Boolean(await api.restoreSignIn())).toBe(loggedIn);
    expect(sdk.construct).toHaveBeenCalledOnce(); expect(sdk.isLoggedIn).toHaveBeenCalled();
    expect(sdk.sign).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("restores only the unique announced wallet matching its saved identity without requesting access", async () => {
    save("external", { rdns: "com.example.wallet" });
    const chosen = external(), unrelated = external();
    announce([{ provider: unrelated, rdns: "com.other.wallet" }, { provider: chosen, rdns: "COM.EXAMPLE.WALLET" }]);
    const api = await import("../src/rest/web/para.js");
    expect(await restoreExternal(api)).toBe(chosen);
    expect(api.restoredIdentityMatches(chosen, owner.address, 1)).toBe(true);
    expect(api.restoredIdentityMatches(chosen, other.address, 1)).toBe(false);
    expect(api.restoredIdentityMatches(chosen, owner.address, 8453)).toBe(false);
    expect(chosen.request.mock.calls.map(([input]) => input.method).sort()).toEqual(["eth_accounts", "eth_chainId"]);
    expect(unrelated.request).not.toHaveBeenCalled(); expect(sdk.construct).not.toHaveBeenCalled();
    api.rememberSignIn(chosen, owner.address, 1);
    expect(JSON.parse(stored.get(storageKey)!)).toEqual({ version: 1, type: "external", rdns: "com.example.wallet", owner: owner.address, chainId: 1 });
  });

  it.each(["owner", "chain", "second account", "rdns"])("rejects a different external wallet %s", async (mismatch) => {
    save("external", { rdns: "com.example.wallet" });
    const candidate = external(mismatch === "owner" ? [other.address] : mismatch === "second account" ? [other.address, owner.address] : [owner.address], mismatch === "chain" ? "0xa" : "0x1");
    announce([{ provider: candidate, rdns: mismatch === "rdns" ? "com.other.wallet" : "com.example.wallet" }]);
    const api = await import("../src/rest/web/para.js");
    expect(await restoreExternal(api)).toBeUndefined();
    expect(candidate.request.mock.calls.every(([input]) => ["eth_accounts", "eth_chainId"].includes(input.method))).toBe(true);
  });

  it("rejects two providers announcing the saved reverse-domain identifier", async () => {
    save("external", { rdns: "com.example.wallet" });
    const first = external(), second = external();
    announce([{ provider: first, rdns: "com.example.wallet" }, { provider: second, rdns: "com.example.wallet" }]);
    const api = await import("../src/rest/web/para.js");
    expect(await restoreExternal(api)).toBeUndefined();
    expect(first.request).not.toHaveBeenCalled(); expect(second.request).not.toHaveBeenCalled();
  });

  it.each([false, true])("restores legacy injection only when no other provider is announced (ambiguous: %s)", async (ambiguous) => {
    save("legacy"); const injected = external(); browser.ethereum = injected;
    announce([{ provider: injected, rdns: "com.example.wallet" }, ...(ambiguous ? [{ provider: external(), rdns: "com.other.wallet" }] : [])]);
    const api = await import("../src/rest/web/para.js");
    expect(await restoreExternal(api)).toBe(ambiguous ? undefined : injected);
    if (ambiguous) expect(injected.request).not.toHaveBeenCalled();
  });

  it("tolerates blocked storage reads without starting restoration", async () => {
    browser.localStorage.getItem.mockImplementation(() => { throw new Error("Storage blocked"); });
    const api = await import("../src/rest/web/para.js");
    expect(await api.restoreSignIn()).toBeUndefined(); expect(sdk.construct).not.toHaveBeenCalled();
  });

  it("keeps sign-out effective in memory when storage writes are blocked", async () => {
    save(); const api = await import("../src/rest/web/para.js"); const provider = await api.restoreSignIn();
    browser.localStorage.setItem.mockImplementation(() => { throw new Error("Storage blocked"); });
    expect(() => api.rememberSignIn(provider!, owner.address, 1)).not.toThrow();
    await api.signOut();
    expect(await api.restoreSignIn()).toBeUndefined(); expect(sdk.logout).toHaveBeenCalledOnce();
    await expect(provider!.request({ method: "eth_accounts" })).rejects.toMatchObject({ code: 4900 });
  });

  it("persists sign-out suppression across reload even when remote logout fails", async () => {
    save(); stored.set("@CAPSULE/userId", "old-public-user-id");
    const api = await import("../src/rest/web/para.js"); const provider = await api.restoreSignIn();
    sdk.logout.mockRejectedValueOnce(new Error("Offline"));
    await expect(api.signOut()).rejects.toMatchObject({ code: 4900 });
    expect(JSON.parse(stored.get(storageKey)!)).toEqual({ version: 1, signedOut: true });
    await expect(provider!.request({ method: "eth_accounts" })).rejects.toMatchObject({ code: 4900 });
    expect(await api.restoreSignIn()).toBeUndefined();
    vi.resetModules();
    const reloaded = await import("../src/rest/web/para.js");
    expect(await reloaded.restoreSignIn()).toBeUndefined(); expect(sdk.construct).toHaveBeenCalledOnce();
  });

  it.each(["forget", "signout"])("cancels delayed Para restoration after %s", async (action) => {
    save(); const session = deferred<boolean>(); sdk.isLoggedIn.mockImplementationOnce(() => session.promise);
    const api = await import("../src/rest/web/para.js"); const restoring = api.restoreSignIn();
    await vi.dynamicImportSettled();
    if (action === "forget") api.forgetSignIn(); else await api.signOut();
    session.resolve(true);
    expect(await restoring).toBeUndefined(); expect(sdk.bridge).not.toHaveBeenCalled();
    expect(await api.restoreSignIn()).toBeUndefined();
  });

  it.each(["forget", "signout"])("cancels delayed external restoration after %s", async (action) => {
    save("external", { rdns: "com.example.wallet" });
    const accounts = deferred<(typeof owner.address)[]>(), candidate = external();
    candidate.request.mockImplementation(async ({ method }) => method === "eth_accounts" ? accounts.promise : "0x1");
    announce([{ provider: candidate, rdns: "com.example.wallet" }]);
    const api = await import("../src/rest/web/para.js"), restoring = api.restoreSignIn();
    await vi.advanceTimersByTimeAsync(400);
    if (action === "forget") api.forgetSignIn(); else await api.signOut();
    accounts.resolve([owner.address]);
    expect(await restoring).toBeUndefined();
    api.rememberSignIn(candidate, owner.address, 1);
    expect(JSON.parse(stored.get(storageKey)!)).toEqual({ version: 1, signedOut: true });
  });

  it("bounds restoration to six seconds and ignores a session result arriving afterward", async () => {
    save(); const session = deferred<boolean>(); sdk.isLoggedIn.mockImplementationOnce(() => session.promise);
    const api = await import("../src/rest/web/para.js"), restoring = api.restoreSignIn();
    const rejected = expect(restoring).rejects.toMatchObject({ code: 4900 });
    await vi.dynamicImportSettled(); await vi.advanceTimersByTimeAsync(6000); await rejected;
    session.resolve(true); await vi.dynamicImportSettled();
    expect(sdk.bridge).not.toHaveBeenCalled(); expect(sdk.sign).not.toHaveBeenCalled();
  });

  it("returns a controlled reconnect error without erasing the remembered account when the SDK fails", async () => {
    save(); const hint = stored.get(storageKey); sdk.isLoggedIn.mockRejectedValueOnce(new Error("Internal SDK failure"));
    const api = await import("../src/rest/web/para.js");
    await expect(api.restoreSignIn()).rejects.toMatchObject({ code: 4900, message: "Your sign-in could not be restored. Sign in to reconnect." });
    expect(stored.get(storageKey)).toBe(hint); expect(sdk.bridge).not.toHaveBeenCalled();
  });
});
