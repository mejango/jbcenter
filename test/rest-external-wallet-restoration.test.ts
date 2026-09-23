import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Provider } from "../src/rest/web/externalWallet.js";

const owner = privateKeyToAccount(`0x${"01".padStart(64, "0")}`);
const other = privateKeyToAccount(`0x${"02".padStart(64, "0")}`);
const storageKey = "juicebox-center.sign-in";
let stored: Map<string, string>;
let browser: EventTarget & {
  localStorage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn> };
  ethereum: Provider | undefined;
};
let approvalElement: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(1_900_000_000_000);
  stored = new Map();
  browser = Object.assign(new EventTarget(), {
    localStorage: { getItem: vi.fn((key: string) => stored.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { stored.set(key, value); }) },
    ethereum: undefined as Provider | undefined,
  });
  approvalElement = vi.fn(() => { throw new Error("Restoration must not open approval UI"); });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", { getElementById: approvalElement });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected request"); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function save(type = "external", extra: Record<string, unknown> = {}) {
  stored.set(storageKey, JSON.stringify({ version: 1, type, owner: owner.address, chainId: 1,
    ...(type === "external" ? { rdns: "com.example.wallet" } : {}), ...extra }));
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
async function restoreExternal(api: typeof import("../src/rest/web/externalWallet.js")) {
  const restoring = api.restoreSignIn();
  await vi.advanceTimersByTimeAsync(400);
  return restoring;
}

describe("remembered external account restoration", () => {
  it("does not contact a wallet for a fresh visitor", async () => {
    const discovery = vi.fn(); browser.addEventListener("eip6963:requestProvider", discovery);
    const api = await import("../src/rest/web/externalWallet.js");
    expect(await api.restoreSignIn()).toBeUndefined();
    expect(discovery).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled(); expect(approvalElement).not.toHaveBeenCalled();
  });

  it("ignores a saved Para hint without contacting an external wallet", async () => {
    save("para", { rdns: "com.example.wallet" });
    stored.set("@CAPSULE/userId", "old-public-user-id");
    const candidate = external(), discovery = vi.fn(); browser.ethereum = candidate;
    announce([{ provider: candidate, rdns: "com.example.wallet" }]);
    browser.addEventListener("eip6963:requestProvider", discovery);
    const api = await import("../src/rest/web/externalWallet.js");
    expect(await api.restoreSignIn()).toBeUndefined();
    expect(discovery).not.toHaveBeenCalled(); expect(candidate.request).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled(); expect(approvalElement).not.toHaveBeenCalled();
  });

  it("ignores an old embedded-wallet user ID without a saved external hint", async () => {
    stored.set("@CAPSULE/userId", "old-public-user-id");
    const discovery = vi.fn(); browser.addEventListener("eip6963:requestProvider", discovery);
    const api = await import("../src/rest/web/externalWallet.js");
    expect(await api.restoreSignIn()).toBeUndefined();
    expect(discovery).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("restores stable API authority separately from the last execution network", async () => {
    save("external", { chainId: 1, walletChainId: 10 });
    const candidate = external([owner.address], "0xa");
    announce([{ provider: candidate, rdns: "com.example.wallet" }]);
    const api = await import("../src/rest/web/externalWallet.js"), provider = await restoreExternal(api);
    expect(provider).toBe(candidate);
    expect(await provider!.request({ method: "eth_chainId" })).toBe("0xa");
    expect(api.restoredAuthorityChainId(provider!, owner.address, 10)).toBe(1);
    expect(api.restoredAuthorityChainId(provider!, owner.address, 1)).toBeUndefined();
    expect(api.restoredAuthorityChainId(provider!, other.address, 10)).toBeUndefined();
    api.rememberSignIn(provider!, owner.address, 1, 10);
    expect(JSON.parse(stored.get(storageKey)!)).toEqual({ version: 1, type: "external", owner: owner.address,
      chainId: 1, walletChainId: 10, rdns: "com.example.wallet" });
    expect(fetch).not.toHaveBeenCalled(); expect(approvalElement).not.toHaveBeenCalled();
  });

  it("persists execution changes without changing API authority or accepting an inactive provider", async () => {
    save(); const candidate = external();
    announce([{ provider: candidate, rdns: "com.example.wallet" }]);
    const api = await import("../src/rest/web/externalWallet.js"), provider = await restoreExternal(api);
    api.rememberSignIn(provider!, owner.address, 1, 10);
    expect(JSON.parse(stored.get(storageKey)!)).toEqual({ version: 1, type: "external", rdns: "com.example.wallet",
      owner: owner.address, chainId: 1, walletChainId: 10 });
    api.rememberSignIn(provider!, owner.address, 1, 1);
    const hint = stored.get(storageKey);
    expect(JSON.parse(hint!)).toEqual({ version: 1, type: "external", rdns: "com.example.wallet", owner: owner.address, chainId: 1 });
    api.rememberSignIn(provider!, owner.address, 1, 0);
    api.rememberSignIn(external(), other.address, 1);
    expect(stored.get(storageKey)).toBe(hint);
  });

  it("restores only the unique announced wallet matching its saved identity without requesting access", async () => {
    save("external", { rdns: "com.example.wallet" });
    const chosen = external(), unrelated = external();
    announce([{ provider: unrelated, rdns: "com.other.wallet" }, { provider: chosen, rdns: "COM.EXAMPLE.WALLET" }]);
    const api = await import("../src/rest/web/externalWallet.js");
    expect(await restoreExternal(api)).toBe(chosen);
    expect(api.restoredIdentityMatches(chosen, owner.address, 1)).toBe(true);
    expect(api.restoredIdentityMatches(chosen, other.address, 1)).toBe(false);
    expect(api.restoredIdentityMatches(chosen, owner.address, 8453)).toBe(false);
    expect(chosen.request.mock.calls.map(([input]) => input.method).sort()).toEqual(["eth_accounts", "eth_chainId"]);
    expect(unrelated.request).not.toHaveBeenCalled();
    api.rememberSignIn(chosen, owner.address, 1);
    expect(JSON.parse(stored.get(storageKey)!)).toEqual({ version: 1, type: "external", rdns: "com.example.wallet", owner: owner.address, chainId: 1 });
  });

  it.each(["owner", "chain", "second account", "rdns"])("rejects a different external wallet %s", async (mismatch) => {
    save("external", { rdns: "com.example.wallet" });
    const candidate = external(mismatch === "owner" ? [other.address] : mismatch === "second account" ? [other.address, owner.address] : [owner.address], mismatch === "chain" ? "0xa" : "0x1");
    announce([{ provider: candidate, rdns: mismatch === "rdns" ? "com.other.wallet" : "com.example.wallet" }]);
    const api = await import("../src/rest/web/externalWallet.js");
    expect(await restoreExternal(api)).toBeUndefined();
    expect(candidate.request.mock.calls.every(([input]) => ["eth_accounts", "eth_chainId"].includes(input.method))).toBe(true);
  });

  it("rejects two providers announcing the saved reverse-domain identifier", async () => {
    save("external", { rdns: "com.example.wallet" });
    const first = external(), second = external();
    announce([{ provider: first, rdns: "com.example.wallet" }, { provider: second, rdns: "com.example.wallet" }]);
    const api = await import("../src/rest/web/externalWallet.js");
    expect(await restoreExternal(api)).toBeUndefined();
    expect(first.request).not.toHaveBeenCalled(); expect(second.request).not.toHaveBeenCalled();
  });

  it.each([false, true])("restores legacy injection only when no other provider is announced (ambiguous: %s)", async (ambiguous) => {
    save("legacy"); const injected = external(); browser.ethereum = injected;
    announce([{ provider: injected, rdns: "com.example.wallet" }, ...(ambiguous ? [{ provider: external(), rdns: "com.other.wallet" }] : [])]);
    const api = await import("../src/rest/web/externalWallet.js");
    expect(await restoreExternal(api)).toBe(ambiguous ? undefined : injected);
    if (ambiguous) expect(injected.request).not.toHaveBeenCalled();
  });

  it("tolerates blocked storage reads without starting restoration", async () => {
    browser.localStorage.getItem.mockImplementation(() => { throw new Error("Storage blocked"); });
    const api = await import("../src/rest/web/externalWallet.js");
    expect(await api.restoreSignIn()).toBeUndefined();
  });

  it("keeps sign-out effective in memory when storage writes are blocked", async () => {
    save(); const candidate = external();
    announce([{ provider: candidate, rdns: "com.example.wallet" }]);
    const api = await import("../src/rest/web/externalWallet.js"), provider = await restoreExternal(api);
    browser.localStorage.setItem.mockImplementation(() => { throw new Error("Storage blocked"); });
    expect(() => api.rememberSignIn(provider!, owner.address, 1)).not.toThrow();
    await api.signOut();
    expect(await api.restoreSignIn()).toBeUndefined();
    expect(api.restoredIdentityMatches(provider!, owner.address, 1)).toBe(false);
    // The extension stays connected; the Center session is still forgotten.
    expect(await candidate.request({ method: "eth_accounts" })).toEqual([owner.address]);
  });

  it("persists sign-out suppression across reload while the external wallet stays connected", async () => {
    save(); const candidate = external();
    announce([{ provider: candidate, rdns: "com.example.wallet" }]);
    const api = await import("../src/rest/web/externalWallet.js"), provider = await restoreExternal(api);
    await api.signOut();
    expect(JSON.parse(stored.get(storageKey)!)).toEqual({ version: 1, signedOut: true });
    expect(api.restoredIdentityMatches(provider!, owner.address, 1)).toBe(false);
    expect(await api.restoreSignIn()).toBeUndefined();
    candidate.request.mockClear(); vi.resetModules();
    const reloaded = await import("../src/rest/web/externalWallet.js");
    expect(await reloaded.restoreSignIn()).toBeUndefined(); expect(candidate.request).not.toHaveBeenCalled();
  });

  it.each(["forget", "signout"])("cancels delayed external restoration after %s", async (action) => {
    save("external", { rdns: "com.example.wallet" });
    const accounts = deferred<(typeof owner.address)[]>(), candidate = external();
    candidate.request.mockImplementation(async ({ method }) => method === "eth_accounts" ? accounts.promise : "0x1");
    announce([{ provider: candidate, rdns: "com.example.wallet" }]);
    const api = await import("../src/rest/web/externalWallet.js"), restoring = api.restoreSignIn();
    await vi.advanceTimersByTimeAsync(400);
    if (action === "forget") api.forgetSignIn(); else await api.signOut();
    accounts.resolve([owner.address]);
    expect(await restoring).toBeUndefined();
    api.rememberSignIn(candidate, owner.address, 1);
    expect(JSON.parse(stored.get(storageKey)!)).toEqual({ version: 1, signedOut: true });
  });

  it("bounds restoration to six seconds and ignores an account result arriving afterward", async () => {
    save(); const accounts = deferred<(typeof owner.address)[]>(), candidate = external();
    candidate.request.mockImplementation(async ({ method }) => method === "eth_accounts" ? accounts.promise : "0x1");
    announce([{ provider: candidate, rdns: "com.example.wallet" }]);
    const hint = stored.get(storageKey), api = await import("../src/rest/web/externalWallet.js"), restoring = api.restoreSignIn();
    const rejected = expect(restoring).rejects.toMatchObject({ code: 4900 });
    await vi.advanceTimersByTimeAsync(6000); await rejected;
    accounts.resolve([owner.address]); await vi.advanceTimersByTimeAsync(0);
    expect(api.restoredIdentityMatches(candidate, owner.address, 1)).toBe(false);
    api.rememberSignIn(candidate, other.address, 1);
    expect(stored.get(storageKey)).toBe(hint);
    expect(candidate.request.mock.calls.map(([input]) => input.method).sort()).toEqual(["eth_accounts", "eth_chainId"]);
  });

  it("returns a controlled reconnect error without erasing the remembered account when the wallet fails", async () => {
    save(); const hint = stored.get(storageKey), candidate = external();
    candidate.request.mockRejectedValueOnce(new Error("Internal wallet failure"));
    announce([{ provider: candidate, rdns: "com.example.wallet" }]);
    const api = await import("../src/rest/web/externalWallet.js"), restoring = api.restoreSignIn();
    const rejected = expect(restoring).rejects.toMatchObject({ code: 4900, message: "Your sign-in could not be restored. Sign in to reconnect." });
    await vi.advanceTimersByTimeAsync(400); await rejected;
    expect(stored.get(storageKey)).toBe(hint);
    expect(api.restoredIdentityMatches(candidate, owner.address, 1)).toBe(false);
  });
});
