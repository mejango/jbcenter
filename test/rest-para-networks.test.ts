import { describe, expect, it, vi } from "vitest";
import { keccak256, recoverTypedDataAddress, stringToHex, type Hex, type TypedDataDefinition } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { accountIdFor, buildRequestTypedData } from "../src/rest/auth/signatures.js";
import { walletNetworkSession, type Provider } from "../src/rest/web/para.js";

const owner = privateKeyToAccount(`0x${"01".padStart(64, "0")}`);
const other = privateKeyToAccount(`0x${"02".padStart(64, "0")}`);
const audience = "https://juicebox.center";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function apiRequest(chainId = 1) {
  return buildRequestTypedData(audience, {
    accountId: accountIdFor(owner.address, chainId), signer: owner.address, grantId: "", method: "GET", requestTarget: "/api/v1/accounts/me",
    contentType: "application/json", bodyHash: keccak256(stringToHex("")), issuedAt: 1_900_000_000, expiresAt: 1_900_000_300,
    nonce: `0x${"ab".repeat(32)}`, idempotencyKey: "",
  });
}
function fixture() {
  const state = { owner: owner.address, chainId: 1, current: true };
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const emit = (event: string, ...args: unknown[]) => { for (const listener of listeners.get(event) ?? []) listener(...args); };
  const changeNetwork = (id: number) => { state.chainId = id; emit("chainChanged", `0x${id.toString(16)}`); };
  const switchChain = vi.fn(async (id: number) => { changeNetwork(id); });
  const sign = vi.fn(async (data: unknown) => owner.signTypedData((typeof data === "string" ? JSON.parse(data) : data) as TypedDataDefinition));
  const send = vi.fn(async () => `0x${"11".repeat(32)}` as Hex);
  const receipt = vi.fn(async () => ({ transactionHash: `0x${"11".repeat(32)}` as Hex, blockNumber: "0x1" }));
  const raw: Provider = {
    on(event, listener) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(listener); },
    removeListener(event, listener) { listeners.get(event)?.delete(listener); },
    request: vi.fn(async ({ method, params = [] }) => {
      if (method === "eth_chainId") return `0x${state.chainId.toString(16)}`;
      if (method === "eth_accounts") return [state.owner];
      if (method === "wallet_switchEthereumChain") { await switchChain(Number((params[0] as { chainId: string }).chainId)); return null; }
      if (method === "eth_signTypedData_v4") return sign(params[1]);
      if (method === "eth_sendTransaction") return send();
      if (method === "eth_getTransactionReceipt") return receipt();
      throw new Error(`Unexpected wallet request: ${method}`);
    }),
  };
  const onChain = vi.fn();
  const session = walletNetworkSession({ provider: raw, owner: owner.address, chainId: 1, stillCurrent: () => state.current, onChain });
  const signWith = (provider: Provider, chainId = 1) => provider.request({ method: "eth_signTypedData_v4", params: [owner.address, apiRequest(chainId)] });
  return { state, listeners, emit, changeNetwork, switchChain, sign, send, receipt, raw, onChain, session, signWith };
}

describe("wallet execution networks", () => {
  it("switches for execution and returns to the fixed API authority before signing", async () => {
    const f = fixture(), authority = apiRequest();
    const execution = await f.session.execution(10);
    expect(await execution.request({ method: "eth_chainId" })).toBe("0xa");
    expect(await f.session.refresh()).toBe(10);
    const api = await f.session.execution(1);
    const signature = await f.signWith(api) as Hex;
    expect(await recoverTypedDataAddress({ ...authority, signature })).toBe(owner.address);
    expect(authority.message.accountId).toBe(accountIdFor(owner.address, 1));
    expect(f.switchChain.mock.calls).toEqual([[10], [1]]);
    expect(f.onChain).toHaveBeenLastCalledWith(1);
  });

  it("verifies manual network changes without prompting for wallet access", async () => {
    const f = fixture(); f.changeNetwork(8453);
    expect(await f.session.refresh()).toBe(8453);
    expect(f.onChain).toHaveBeenLastCalledWith(8453);
    expect(f.switchChain).not.toHaveBeenCalled(); expect(f.sign).not.toHaveBeenCalled();
    expect(vi.mocked(f.raw.request).mock.calls.some(([input]) => input.method === "eth_requestAccounts")).toBe(false);
  });

  it("allows retry after a rejected network switch without signing", async () => {
    const f = fixture(); f.switchChain.mockRejectedValueOnce(Object.assign(new Error("Canceled"), { code: 4001 }));
    await expect(f.session.execution(10)).rejects.toMatchObject({ code: 4001 });
    expect(f.sign).not.toHaveBeenCalled();
    await f.session.execution(10);
    expect(await f.session.refresh()).toBe(10);
  });

  it("requires the wallet to actually switch to the requested network", async () => {
    const f = fixture(); f.switchChain.mockResolvedValueOnce(undefined);
    await expect(f.session.execution(10)).rejects.toThrow();
    expect(f.sign).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });

  it("binds execution to Base even when a transaction omits its chain ID", async () => {
    const f = fixture(), base = await f.session.execution(8453);
    f.changeNetwork(1);
    await expect(base.request({ method: "eth_sendTransaction", params: [{ from: owner.address, to: other.address, value: "0x0" }] })).rejects.toThrow();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("refuses a receipt read when its bound execution network is no longer selected", async () => {
    const f = fixture(), base = await f.session.execution(8453);
    f.changeNetwork(1);
    await expect(base.request({ method: "eth_getTransactionReceipt", params: [`0x${"11".repeat(32)}`] })).rejects.toThrow();
    expect(f.receipt).not.toHaveBeenCalled();
  });

  it("discards a receipt returned after the selected network changes", async () => {
    const f = fixture(), base = await f.session.execution(8453), started = deferred<void>(), observed = deferred<void>();
    f.receipt.mockImplementationOnce(async () => {
      started.resolve(); await observed.promise;
      return { transactionHash: `0x${"11".repeat(32)}` as Hex, blockNumber: "0x1" };
    });
    const reading = base.request({ method: "eth_getTransactionReceipt", params: [`0x${"11".repeat(32)}`] });
    await started.promise; f.changeNetwork(1); observed.resolve();
    await expect(reading).rejects.toThrow();
    expect(f.receipt).toHaveBeenCalledOnce();
  });

  it("rejects an account change during the network switch", async () => {
    const f = fixture();
    f.switchChain.mockImplementationOnce(async (id) => { f.state.owner = other.address; f.changeNetwork(id); });
    await expect(f.session.execution(10)).rejects.toThrow();
    expect(f.sign).not.toHaveBeenCalled(); expect(f.onChain).not.toHaveBeenCalledWith(10);
  });

  it("blocks competing network switches and signatures while signing", async () => {
    const f = fixture(), started = deferred<void>(), signature = deferred<Hex>();
    f.sign.mockImplementationOnce(async () => { started.resolve(); return signature.promise; });
    const signing = f.signWith(f.session.provider); await started.promise;
    await expect(f.session.execution(10)).rejects.toThrow();
    await expect(f.signWith(f.session.provider)).rejects.toThrow();
    expect(f.switchChain).not.toHaveBeenCalled();
    signature.resolve(await owner.signTypedData(apiRequest()));
    await signing; expect(f.sign).toHaveBeenCalledOnce();
  });

  it.each(["away and back", "without an event"])("rejects a signature when the wallet changes networks %s during approval", async (change) => {
    const f = fixture(), started = deferred<void>(), signature = deferred<Hex>();
    f.sign.mockImplementationOnce(async () => { started.resolve(); return signature.promise; });
    const signing = f.signWith(f.session.provider); await started.promise;
    if (change === "away and back") { f.changeNetwork(10); f.changeNetwork(1); }
    else f.state.chainId = 10;
    signature.resolve(await owner.signTypedData(apiRequest()));
    await expect(signing).rejects.toThrow();
  });

  it("blocks protected requests until a pending explicit switch has completed", async () => {
    const f = fixture(), started = deferred<void>(), switched = deferred<void>();
    f.switchChain.mockImplementationOnce(async (id) => { started.resolve(); await switched.promise; f.changeNetwork(id); });
    const switching = f.session.execution(10); await started.promise;
    await expect(f.session.execution(8453)).rejects.toThrow();
    await expect(f.signWith(f.session.provider)).rejects.toThrow();
    expect(f.sign).not.toHaveBeenCalled();
    switched.resolve(); await switching;
    expect(f.switchChain).toHaveBeenCalledExactlyOnceWith(10);
  });

  it("keeps the exact typed request copied for a pending wallet approval", async () => {
    const f = fixture(), started = deferred<void>(), accepted = deferred<void>();
    f.sign.mockImplementationOnce(async (data) => { started.resolve(); await accepted.promise; return owner.signTypedData(data as TypedDataDefinition); });
    const data = apiRequest();
    const signing = f.session.provider.request({ method: "eth_signTypedData_v4", params: [owner.address, data] });
    await started.promise; data.message.requestTarget = "/api/v1/accounts/me/bots"; accepted.resolve();
    const signature = await signing as Hex;
    expect(await recoverTypedDataAddress({ ...apiRequest(), signature })).toBe(owner.address);
  });

  it.each(["signature", "transaction"])("captures the original %s before the initial account read resolves", async (operation) => {
    const f = fixture(), started = deferred<void>(), checked = deferred<void>();
    const original = vi.mocked(f.raw.request).getMockImplementation()!;
    vi.mocked(f.raw.request).mockImplementationOnce(async (input) => {
      expect(input.method).toBe("eth_accounts"); started.resolve(); await checked.promise; return original(input);
    });
    const data = apiRequest(), transaction = { from: owner.address, to: other.address, value: "0x1", data: "0x1234" };
    const pending = operation === "signature"
      ? f.session.provider.request({ method: "eth_signTypedData_v4", params: [owner.address, data] })
      : f.session.provider.request({ method: "eth_sendTransaction", params: [transaction] });
    await started.promise;
    data.message.requestTarget = "/api/v1/accounts/me/bots";
    transaction.to = owner.address; transaction.value = "0x2"; transaction.data = "0xabcd";
    checked.resolve(); const result = await pending;
    if (operation === "signature") expect(await recoverTypedDataAddress({ ...apiRequest(), signature: result as Hex })).toBe(owner.address);
    else expect(vi.mocked(f.raw.request).mock.calls.find(([input]) => input.method === "eth_sendTransaction")![0].params).toEqual([
      { from: owner.address, to: other.address, value: "0x1", data: "0x1234", chainId: "0x1" },
    ]);
  });

  it("rejects a request for a different signer or network before invoking the wallet", async () => {
    const f = fixture();
    await expect(f.session.provider.request({ method: "eth_signTypedData_v4", params: [other.address, apiRequest()] })).rejects.toThrow();
    await expect(f.signWith(f.session.provider, 10)).rejects.toThrow();
    await expect(f.session.provider.request({ method: "eth_sendTransaction", params: [{ from: other.address, to: owner.address, chainId: "0x1" }] })).rejects.toThrow();
    await expect(f.session.provider.request({ method: "eth_sendTransaction", params: [{ from: owner.address, to: other.address, chainId: "0xa" }] })).rejects.toThrow();
    expect(f.sign).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });

  it.each(["selected account", "lost session", "disposed"])("discards a pending signature after %s changes", async (reason) => {
    const f = fixture(), started = deferred<void>(), signature = deferred<Hex>();
    f.sign.mockImplementationOnce(async () => { started.resolve(); return signature.promise; });
    const signing = f.signWith(f.session.provider); await started.promise;
    if (reason === "selected account") f.state.owner = other.address;
    if (reason === "lost session") f.state.current = false;
    if (reason === "disposed") f.session.dispose();
    signature.resolve(await owner.signTypedData(apiRequest()));
    await expect(signing).rejects.toThrow();
  });

  it("does not sign after a silent live-account change, even without an event", async () => {
    const f = fixture(); f.state.owner = other.address;
    await expect(f.signWith(f.session.provider)).rejects.toThrow();
    expect(f.sign).not.toHaveBeenCalled();
  });

  it("sends only after verifying the selected execution network and account", async () => {
    const f = fixture(), provider = await f.session.execution(10);
    const transaction = { from: owner.address, to: other.address, value: "0x0", data: "0x1234", chainId: "0xa" };
    expect(await provider.request({ method: "eth_sendTransaction", params: [transaction] })).toBe(`0x${"11".repeat(32)}`);
    expect(f.send).toHaveBeenCalledOnce();
    f.state.owner = other.address;
    await expect(provider.request({ method: "eth_sendTransaction", params: [transaction] })).rejects.toThrow();
    expect(f.send).toHaveBeenCalledOnce();
  });

  it("rejects a send result if its account session is invalidated while the wallet is pending", async () => {
    const f = fixture(), started = deferred<void>(), sent = deferred<Hex>();
    f.send.mockImplementationOnce(async () => { started.resolve(); return sent.promise; });
    const sending = f.session.provider.request({ method: "eth_sendTransaction", params: [{ from: owner.address, to: other.address, value: "0x0", chainId: "0x1" }] });
    await started.promise; f.state.current = false;
    sent.resolve(`0x${"11".repeat(32)}`);
    await expect(sending).rejects.toMatchObject({ transactionHash: `0x${"11".repeat(32)}`, broadcastState: "unknown" });
    expect(f.send).toHaveBeenCalledOnce();
  });

  it("disposes its subscriptions and prevents subsequent protected requests", async () => {
    const f = fixture(); f.session.dispose();
    expect([...f.listeners.values()].every((entries) => entries.size === 0)).toBe(true);
    await expect(f.signWith(f.session.provider)).rejects.toThrow();
    await expect(f.session.execution(10)).rejects.toThrow();
    expect(f.sign).not.toHaveBeenCalled(); expect(f.switchChain).not.toHaveBeenCalled();
  });
});
