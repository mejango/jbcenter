import { afterEach, describe, expect, it, vi } from "vitest";
import { hashTypedData, keccak256, recoverTypedDataAddress, stringToHex, type Hex, type TypedDataDefinition } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { accountIdFor, buildBotProofTypedData, buildRequestTypedData } from "../src/rest/auth/signatures.js";
import { CenterWalletError, createEmbeddedProvider, setReviewedRequestBody, trustedParaUrl } from "../src/rest/web/para.js";

const rpc = vi.hoisted(() => ({ prepare: vi.fn(), sign: vi.fn(), broadcast: vi.fn(), receipt: vi.fn() }));
vi.mock("viem", async (importOriginal) => ({
  ...await importOriginal<typeof import("viem")>(),
  createWalletClient: () => ({ prepareTransactionRequest: rpc.prepare, signTransaction: rpc.sign }),
  createPublicClient: () => ({ sendRawTransaction: rpc.broadcast, request: rpc.receipt }),
}));

const owner = privateKeyToAccount(`0x${"01".padStart(64, "0")}`);
const bot = privateKeyToAccount(`0x${"02".padStart(64, "0")}`);
const audience = "https://juicebox.center";
const now = 1_900_000_000;
type Review = Parameters<NonNullable<Parameters<typeof createEmbeddedProvider>[0]["confirm"]>>[0];

function enrollment() {
  return buildRequestTypedData(audience, {
    accountId: accountIdFor(owner.address, 1), signer: owner.address, grantId: "", method: "POST",
    requestTarget: "/api/v1/accounts/enroll", contentType: "application/json", bodyHash: keccak256(stringToHex("{}")),
    issuedAt: now, expiresAt: now + 300, nonce: `0x${"ab".repeat(32)}`, idempotencyKey: "",
  });
}
function connection() {
  return buildBotProofTypedData(audience, {
    accountId: accountIdFor(owner.address, 1), botAddress: bot.address, scopes: ["read", "plan"],
    label: "Integration", expiresAt: now + 3600, ownerRequestNonce: `0x${"cd".repeat(32)}`,
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function setup(confirm = vi.fn<(review: Review) => Promise<void>>().mockResolvedValue(undefined)) {
  vi.spyOn(Date, "now").mockReturnValue(now * 1000);
  const sign = vi.fn(owner.signTypedData);
  const isLoggedIn = vi.fn(async () => true);
  const provider = createEmbeddedProvider({
    account: { ...owner, signTypedData: sign as typeof owner.signTypedData }, audience, isLoggedIn, confirm, enrollmentFromSignIn: true,
  });
  const request = (data: unknown, address = owner.address) => provider.request({ method: "eth_signTypedData_v4", params: [address, data] });
  return { provider, request, confirm, sign, isLoggedIn };
}

afterEach(() => { vi.restoreAllMocks(); for (const mock of Object.values(rpc)) mock.mockReset(); });

describe("embedded account approvals", () => {
  it("uses the sign-in approval for one exact enrollment and reviews subsequent signatures", async () => {
    const f = setup();
    const signature = await f.request(enrollment()) as Hex;
    expect(await recoverTypedDataAddress({ ...enrollment(), signature })).toBe(owner.address);
    expect(f.confirm).not.toHaveBeenCalled();
    await f.request(enrollment());
    expect(f.confirm).toHaveBeenCalledOnce();
    expect(f.confirm.mock.calls[0]![0]).toMatchObject({ title: "Approve API request" });
    expect(f.sign).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["another audience", (data: ReturnType<typeof enrollment>) => { data.message.audience = "https://other.example"; }],
    ["another signing domain", (data: ReturnType<typeof enrollment>) => { data.domain = { ...data.domain, salt: `0x${"ff".repeat(32)}` }; }],
    ["a nonempty body", (data: ReturnType<typeof enrollment>) => { data.message.bodyHash = keccak256(stringToHex('{"admin":true}')); }],
    ["another endpoint", (data: ReturnType<typeof enrollment>) => { data.message.requestTarget = "/api/v1/accounts/bots"; }],
    ["an old request", (data: ReturnType<typeof enrollment>) => { data.message.issuedAt = BigInt(now - 61); }],
    ["an expired request", (data: ReturnType<typeof enrollment>) => { data.message.expiresAt = BigInt(now - 1); }],
    ["an extended deadline", (data: ReturnType<typeof enrollment>) => { data.message.expiresAt = BigInt(now + 601); }],
  ])("does not automatically sign enrollment with %s", async (_label, change) => {
    const f = setup(vi.fn().mockRejectedValue(new CenterWalletError("Canceled", 4001)));
    const data = enrollment(); change(data);
    await expect(f.request(data)).rejects.toMatchObject({ code: 4001 });
    expect(f.confirm).toHaveBeenCalledOnce();
    expect(f.sign).not.toHaveBeenCalled();
  });

  it("expires the sign-in shortcut and requires approval for creating API access", async () => {
    const f = setup();
    await f.request(connection());
    expect(f.confirm.mock.calls[0]![0]).toMatchObject({
      title: "Create API connection",
      summary: expect.arrayContaining([["Name", "Integration"], ["Permissions", "read, plan"], ["API key address", bot.address]]),
    });
    const later = setup();
    vi.mocked(Date.now).mockReturnValue((now + 61) * 1000);
    await later.request(enrollment());
    expect(later.confirm).toHaveBeenCalledOnce();
  });

  it("shows API-access permissions only for the exact registration body and consumes that review", async () => {
    const f = setup();
    const body = { botAddress: bot.address, label: "Integration", scopes: ["read", "plan"], expiresAt: now + 3600 };
    const serialized = JSON.stringify(body), data = enrollment();
    data.message.requestTarget = "/api/v1/accounts/me/bots";
    data.message.bodyHash = keccak256(stringToHex(serialized));
    setReviewedRequestBody(body);
    body.scopes.push("relay");
    const signature = await f.request(data) as Hex;
    expect(await recoverTypedDataAddress({ ...data, signature })).toBe(owner.address);
    expect(f.confirm.mock.calls[0]![0]).toMatchObject({
      title: "Create API connection",
      summary: expect.arrayContaining([["Permissions", "read, plan"], ["API key address", bot.address],
        ["Expires", new Date((now + 3600) * 1000).toLocaleString()]]),
      details: { requestBody: JSON.parse(serialized), signing: { message: { bodyHash: data.message.bodyHash } } },
    });

    await f.request(data);
    setReviewedRequestBody(body);
    await f.request(data);
    data.message.bodyHash = keccak256(stringToHex(JSON.stringify(body)));
    await f.request(data);
    for (const [review] of f.confirm.mock.calls.slice(1)) {
      expect(review.title).toBe("Approve API request");
      expect(review.summary.some(([label]) => ["Permissions", "API key address"].includes(label))).toBe(false);
      expect(review.details).not.toHaveProperty("requestBody");
    }
  });

  it("never signs a refused approval, and allows a later approved request", async () => {
    const confirm = vi.fn<(review: Review) => Promise<void>>()
      .mockRejectedValueOnce(new CenterWalletError("Canceled", 4001)).mockResolvedValue(undefined);
    const f = setup(confirm);
    await expect(f.request(connection())).rejects.toMatchObject({ code: 4001 });
    expect(f.sign).not.toHaveBeenCalled();
    await f.request(connection());
    expect(f.sign).toHaveBeenCalledOnce();
  });

  it("rejects an expired session and publishes disconnection without signing", async () => {
    const f = setup(), changed = vi.fn(), disconnected = vi.fn();
    f.provider.on!("accountsChanged", changed); f.provider.on!("disconnect", disconnected);
    f.isLoggedIn.mockResolvedValue(false);
    await expect(f.request(enrollment())).rejects.toMatchObject({ code: 4900 });
    expect(changed).toHaveBeenCalledExactlyOnceWith([]);
    expect(disconnected).toHaveBeenCalledExactlyOnceWith({ code: 4900 });
    expect(f.sign).not.toHaveBeenCalled();
    expect(f.confirm).not.toHaveBeenCalled();
  });

  it.each(["session expired", "disconnected"])("does not sign when %s during approval", async (reason) => {
    const opened = deferred<void>(), accepted = deferred<void>();
    const f = setup(vi.fn(async () => { opened.resolve(); await accepted.promise; }));
    const signing = f.request(connection());
    await opened.promise;
    if (reason === "session expired") f.isLoggedIn.mockResolvedValue(false);
    else f.provider.disconnect();
    accepted.resolve();
    await expect(signing).rejects.toMatchObject({ code: 4900 });
    expect(f.sign).not.toHaveBeenCalled();
  });

  it("does not sign after disconnecting while the final session check is pending", async () => {
    const checking = deferred<void>(), loggedIn = deferred<boolean>();
    const f = setup();
    f.isLoggedIn.mockResolvedValueOnce(true).mockImplementationOnce(async () => {
      checking.resolve(); return loggedIn.promise;
    });
    const signing = f.request(connection());
    await checking.promise;
    f.provider.disconnect(); loggedIn.resolve(true);
    await expect(signing).rejects.toMatchObject({ code: 4900 });
    expect(f.sign).not.toHaveBeenCalled();
  });

  it("signs the reviewed snapshot when a caller mutates its input during approval", async () => {
    const opened = deferred<void>(), accepted = deferred<void>();
    const f = setup(vi.fn(async () => { opened.resolve(); await accepted.promise; }));
    const data = connection(), expectedHash = hashTypedData(data);
    const signing = f.request(data);
    await opened.promise;
    data.message.scopes.push("relay"); data.message.botAddress = owner.address; data.message.label = "Changed";
    accepted.resolve();
    const signature = await signing as Hex;
    const reviewed = f.confirm.mock.calls[0]![0].details as TypedDataDefinition;
    expect(hashTypedData(reviewed)).toBe(expectedHash);
    expect(hashTypedData(f.sign.mock.calls[0]![0])).toBe(expectedHash);
    expect(await recoverTypedDataAddress({ ...reviewed, signature })).toBe(owner.address);
  });

  it("rejects the wrong signer or chain and blocks competing signing and network changes", async () => {
    const opened = deferred<void>(), accepted = deferred<void>();
    const f = setup(vi.fn(async () => { opened.resolve(); await accepted.promise; }));
    await expect(f.request(connection(), bot.address)).rejects.toMatchObject({ code: 4200 });
    await expect(f.provider.request({ method: "personal_sign", params: ["0x1234", owner.address] })).rejects.toMatchObject({ code: 4200 });
    const wrongChain = { ...connection(), domain: { ...connection().domain, chainId: 10 } };
    await expect(f.request(wrongChain)).rejects.toMatchObject({ code: 4200 });
    await expect(f.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x9999" }] })).rejects.toMatchObject({ code: 4902 });
    expect(f.confirm).not.toHaveBeenCalled();
    const signing = f.request(connection()); await opened.promise;
    await expect(f.request(connection())).rejects.toMatchObject({ code: -32000 });
    await expect(f.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xa" }] })).rejects.toMatchObject({ code: -32000 });
    accepted.resolve(); await signing;
    expect(f.sign).toHaveBeenCalledOnce();
    const changed = vi.fn(); f.provider.on!("chainChanged", changed);
    await f.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xa" }] });
    expect(changed).toHaveBeenCalledExactlyOnceWith("0xa");
    expect(await f.provider.request({ method: "eth_chainId" })).toBe("0xa");
  });

  it("restores a supported network and reports subsequent changes for the account session", async () => {
    const onChainChange = vi.fn();
    const provider = createEmbeddedProvider({ account: owner, audience, isLoggedIn: async () => true, initialChainId: 8453, onChainChange });
    expect(await provider.request({ method: "eth_chainId" })).toBe("0x2105");
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xa" }] });
    expect(onChainChange).toHaveBeenCalledExactlyOnceWith(10);
  });
});

describe("embedded transaction approval and submission", () => {
  async function transaction(confirm?: ReturnType<typeof setup>["confirm"]) {
    const f = setup(confirm);
    const prepared = { chainId: 1, to: bot.address, data: "0x1234" as const, value: 1_000_000_000_000_000n,
      gas: 100_000n, nonce: 7, type: "eip1559" as const, maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
    const serialized = await owner.signTransaction(prepared), hash = keccak256(serialized);
    rpc.prepare.mockResolvedValue(prepared); rpc.sign.mockResolvedValue(serialized); rpc.broadcast.mockResolvedValue(hash);
    const raw = { from: owner.address, to: bot.address, data: "0x1234", value: "0x38d7ea4c68000", chainId: "0x1" };
    const send = () => f.provider.request({ method: "eth_sendTransaction", params: [raw] });
    return { ...f, prepared, serialized, hash, raw, send };
  }

  it("reviews and signs the same destination, bytes, fees and nonce despite caller mutation", async () => {
    const opened = deferred<void>(), accepted = deferred<void>();
    const f = await transaction(vi.fn(async () => { opened.resolve(); await accepted.promise; }));
    const sending = f.send(); await opened.promise;
    f.raw.to = owner.address; f.raw.data = "0xabcd"; f.raw.value = "0x0";
    expect(f.confirm.mock.calls[0]![0]).toMatchObject({
      title: "Send transaction", confirm: "Approve and send", details: { ...f.prepared, account: owner.address },
      summary: expect.arrayContaining([["To", bot.address], ["Value", "0.001 ETH"], ["Execution fee cap", "0.002 ETH"]]),
    });
    expect(rpc.sign).not.toHaveBeenCalled(); expect(rpc.broadcast).not.toHaveBeenCalled();
    accepted.resolve();
    expect(await sending).toBe(f.hash);
    expect(rpc.sign).toHaveBeenCalledExactlyOnceWith(f.prepared);
    expect(rpc.broadcast).toHaveBeenCalledExactlyOnceWith({ serializedTransaction: f.serialized });
  });

  it("does not sign or send when transaction approval is refused", async () => {
    const f = await transaction(vi.fn().mockRejectedValue(new CenterWalletError("Canceled", 4001)));
    await expect(f.send()).rejects.toMatchObject({ code: 4001 });
    expect(rpc.sign).not.toHaveBeenCalled(); expect(rpc.broadcast).not.toHaveBeenCalled();
  });

  it("does not broadcast when the session is lost while signing", async () => {
    const f = await transaction();
    rpc.sign.mockImplementationOnce(async () => { f.isLoggedIn.mockResolvedValue(false); return f.serialized; });
    await expect(f.send()).rejects.toMatchObject({ code: 4900 });
    expect(rpc.sign).toHaveBeenCalledOnce(); expect(rpc.broadcast).not.toHaveBeenCalled();
  });

  it.each(["lost response", "mismatched hash"])("preserves the signed hash for recovery after a %s", async (outcome) => {
    const f = await transaction();
    if (outcome === "lost response") rpc.broadcast.mockRejectedValueOnce(new Error("RPC disconnected"));
    else rpc.broadcast.mockResolvedValueOnce(`0x${"ef".repeat(32)}`);
    await expect(f.send()).rejects.toMatchObject({ transactionHash: f.hash, broadcastState: "unknown" });
    expect(rpc.sign).toHaveBeenCalledOnce(); expect(rpc.broadcast).toHaveBeenCalledOnce();
  });

  it("rejects unavailable network fees and conflicting fee models before approval", async () => {
    const f = await transaction();
    rpc.prepare.mockResolvedValueOnce({ ...f.prepared, maxFeePerGas: 0n });
    await expect(f.send()).rejects.toThrow(/fee could not be estimated/);
    await expect(f.provider.request({ method: "eth_sendTransaction", params: [{ ...f.raw, gasPrice: "0x1", maxFeePerGas: "0x2" }] })).rejects.toMatchObject({ code: 4200 });
    expect(f.confirm).not.toHaveBeenCalled(); expect(rpc.sign).not.toHaveBeenCalled(); expect(rpc.broadcast).not.toHaveBeenCalled();
  });
});

describe("secure Para portal URLs", () => {
  it("accepts only the configured environment's HTTPS portal origins", () => {
    expect(trustedParaUrl("https://app.beta.getpara.com/verify?session=example", "BETA")).toBe("https://app.beta.getpara.com/verify?session=example");
    expect(trustedParaUrl("https://app.usecapsule.com/verify", "PROD")).toBe("https://app.usecapsule.com/verify");
    for (const url of [
      "http://app.beta.getpara.com/verify", "https://app.beta.getpara.com.attacker.example/verify",
      "https://app.beta.getpara.com@attacker.example/verify", "https://attacker.example@app.beta.getpara.com/verify",
      "https://app.beta.getpara.com:8443/verify", "https://app.getpara.com/verify", "javascript:alert(1)",
      "data:text/html,example", "/verify", "https://app.beta.getpara.com./verify",
    ]) expect(() => trustedParaUrl(url, "BETA"), url).toThrow();
    expect(() => trustedParaUrl("https://app.beta.getpara.com/verify", "PROD")).toThrow();
  });
});
