import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { decodeAbiParameters, decodeFunctionData, encodeFunctionResult, keccak256, parseAbi, size, sliceHex, toHex, type Address, type Hex } from "viem";
import { MemoryAccountStore } from "../src/rest/auth/memory.js";
import { type RestRpc } from "../src/rest/core.js";
import { encodeSafe7579PasskeyOwnerSignature } from "../src/rest/smartAccounts/passkeySignatures.js";
import type { SmartAccountManifest } from "../src/rest/smartAccounts/types.js";
import { MemoryTransactionStore } from "../src/rest/transactions/memory.js";
import { TransactionService } from "../src/rest/transactions/service.js";
import { MemoryTransportReservations } from "../src/rest/transactions/transport-reservations.js";
import { ENTRY_POINT_V07_ABI } from "../src/rest/userOperations/chain.js";
import { getUserOperationHash, unpackUserOperation } from "../src/rest/userOperations/codec.js";
import { MemoryUserOperationStore } from "../src/rest/userOperations/memory.js";
import { passkeyDummyContractSignature, passkeyDummySignature, passkeyEstimateProvider, PASSKEY_MAX_SIGNATURE_BYTES } from "../src/rest/userOperations/passkeyEstimation.js";
import { UserOperationProvider } from "../src/rest/userOperations/provider.js";
import { UserOperationService } from "../src/rest/userOperations/service.js";
import { assertPlan } from "../src/rest/userOperations/store.js";
import type { UserOperationGasEstimate, UserOperationGasPolicy, UserOperationV07 } from "../src/rest/userOperations/types.js";
import { account, binding, entryPoint, h, owner, ownerKey, plan, safe, target } from "./fixtures/user-operations.js";

const signer = "0x4444444444444444444444444444444444444444" as Address;
const code = "0x6000" as Hex;
const now = 1_800_000_000_000;
const legacy1271 = parseAbi(["function isValidSignature(bytes data, bytes signature) view returns(bytes4)"]);
const gas: UserOperationGasPolicy = {
  id: "passkey-test", maximumCallGas: 1_000_000n, maximumVerificationGas: 1_000_000n,
  maximumPreVerificationGas: 1_000_000n, maximumPaymasterVerificationGas: 1_000_000n,
  maximumPaymasterPostOpGas: 1_000_000n, maximumFeePerGas: 100n,
  maximumPriorityFeePerGas: 100n, maximumCost: 1_000_000_000n, requirePaymaster: false,
};

// Real service, storage, codecs and EOA signatures; RPC/provider I/O is synthetic here.
// The separate pinned-Anvil suite establishes actual passkey/FCL execution compatibility.
async function fixture(options: { legacy?: boolean; sponsored?: boolean; maximumPreVerificationGas?: bigint } = {}) {
  const apiAccount = account(now, 8453);
  if (!options.legacy) { apiAccount.id = `eip155:8453:${safe}`; apiAccount.ownerAddress = safe; }
  const actor = owner(apiAccount), wallet = binding(apiAccount, now);
  wallet.wallet.chainId = wallet.state.chainId = wallet.state.evidence.chainId = 8453;
  wallet.state.evidence.blockHash = h("passkey-block");
  wallet.state.owners = options.legacy ? [ownerKey.address] : [signer, ownerKey.address];
  if (!options.legacy) wallet.state.ownerProfile = {
    version: "center-passkey-v1",
    signer: { address: signer, kind: "contract", x: h("x"), y: h("y"), verifiers: toHex(99n, { size: 22 }), runtimeCodeHash: keccak256(code) },
    recoveryOwner: { address: ownerKey.address, kind: "ecdsa" },
  };
  const pin = (address: Address) => ({ address, runtimeCodeHash: keccak256(code), source: {
    repository: "https://example.test/test-only", commit: "1".repeat(40), artifactSha256: "2".repeat(64),
  } });
  const manifest: SmartAccountManifest = {
    id: wallet.manifestId, mode: "execution-candidate", chainId: 8453,
    revision: wallet.state.manifestRevision, safeVersion: "1.4.1", proxyRuntimeCodeHash: keccak256(code),
    singleton: pin(target), factory: pin(target), safe7579: pin(target), launchpad: pin(target),
    entryPoint: { ...pin(entryPoint), version: "0.7" },
    smartSessions: { ...pin(target), generation: "legacy-validator" }, policies: [], moduleInspectorId: "test-only",
    ...(!options.legacy ? { ownerProfile: { version: "center-passkey-v1" as const,
      signerFactory: pin(target), signerSingleton: pin(target), p256Verifier: pin(target) } } : {}),
  };
  const authority = new MemoryAccountStore();
  const principal = await authority.enroll(apiAccount, {
    accountId: apiAccount.id, signer: apiAccount.ownerAddress, grantId: null,
    nonce: h("enroll"), issuedAt: now / 1000, expiresAt: now / 1000 + 60,
    idempotencyKey: null, requiredScopes: [], ownerOnly: true, now: now / 1000,
  });
  const transports = new MemoryTransportReservations();
  const transactionStore = new MemoryTransactionStore(authority, transports);
  const preparedPlan = plan("passkey-plan", actor, wallet, now);
  preparedPlan.smartAccount!.chainId = 8453;
  for (const call of preparedPlan.draft.calls) call.chainId = 8453;
  await transactionStore.create(preparedPlan, { key: "plan", requestHash: h("plan"), operation: "fixture" }, now);
  const store = new MemoryUserOperationStore(authority, transports, {
    now: () => now, assertBindingAndSession: (record, clock) => assertPlan(record, preparedPlan, clock * 1000),
  });
  const state = {
    contractResult: encodeFunctionResult({ abi: legacy1271, functionName: "isValidSignature", result: "0x20c13b0b" }) as unknown,
    contractFailure: false, runtimeFailure: false, reorg: false, preflightFailure: false, bindingFailure: false,
    estimateFailure: false, sends: 0, sendFailure: false, finalQuotes: 0, growth: false, growAlways: false,
    estimateTimeout: false, signedEstimate: undefined as Partial<UserOperationGasEstimate> | undefined,
    estimated: [] as UserOperationV07[], sent: undefined as UserOperationV07 | undefined,
  };
  const rpc = vi.fn<RestRpc["request"]>(async (_chain, method, params) => {
    if (method === "eth_chainId") return toHex(8453);
    if (method === "eth_getBlockByNumber") return { number: "0x64", hash: state.reorg ? h("reorg") : h("passkey-block"), timestamp: toHex(now / 1000), baseFeePerGas: "0x0" };
    if (method === "eth_maxPriorityFeePerGas") return "0x1";
    if (method === "eth_getCode") return state.runtimeFailure && params[0] === signer ? "0x6001" : code;
    if (method === "eth_getBalance") return toHex(10n ** 18n);
    if (method === "eth_call") {
      const call = params[0] as { to: Address; data: Hex };
      if (call.to.toLowerCase() === signer) {
        if (state.contractFailure) throw Error("unavailable");
        return state.contractResult;
      }
      if (call.to.toLowerCase() === safe) return "0x";
      const decoded = decodeFunctionData({ abi: ENTRY_POINT_V07_ABI, data: call.data });
      if (decoded.functionName === "getNonce") return toHex(0n, { size: 32 });
      if (decoded.functionName === "getUserOpHash") return getUserOperationHash(unpackUserOperation(decoded.args[0]), entryPoint, 8453);
      if (decoded.functionName === "balanceOf") return toHex(10n ** 18n, { size: 32 });
      if (decoded.functionName === "entryPoint") return encodeFunctionResult({ abi: ENTRY_POINT_V07_ABI, functionName: "entryPoint", result: entryPoint });
      if (decoded.functionName === "validatePaymasterUserOp") return encodeFunctionResult({ abi: ENTRY_POINT_V07_ABI, functionName: "validatePaymasterUserOp", result: ["0x", 0n] });
      if (decoded.functionName === "handleOps" && state.preflightFailure) throw Error("validation failed");
      return "0x";
    }
    throw Error(`unexpected RPC ${method}`);
  });
  const paymaster = "0x000000000000000000000000000000000000006a" as Address;
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    let result: unknown;
    if (request.method === "eth_chainId") result = toHex(8453);
    else if (request.method === "eth_supportedEntryPoints") result = [entryPoint];
    else if (request.method === "eth_estimateUserOperationGas") {
      state.estimated.push(structuredClone(request.params[0]));
      if (state.estimateTimeout) return new Promise<Response>(() => {});
      if (state.estimateFailure) return Response.json({ jsonrpc: "2.0", id: request.id, error: { code: -32500, message: "GS024" } });
      result = { callGasLimit: "0x186a0", verificationGasLimit: "0xc3500",
        preVerificationGas: toHex(state.growAlways ? 100_000n * BigInt(1 + state.finalQuotes) : state.growth && state.finalQuotes > 0 ? 60_000n : 50_000n),
        ...state.signedEstimate };
    } else if (request.method === "pm_getPaymasterStubData" || request.method === "pm_getPaymasterData") {
      if (request.method === "pm_getPaymasterData") state.finalQuotes++;
      result = { paymaster, paymasterData: toHex(0x1234 + state.finalQuotes, { size: 2 }), paymasterVerificationGasLimit: "0x64", paymasterPostOpGasLimit: "0x0" };
    } else if (request.method === "eth_sendUserOperation") {
      state.sends++; state.sent = request.params[0];
      if (state.sendFailure) throw Error("lost response after provider acceptance");
      result = getUserOperationHash(state.sent!, entryPoint, 8453);
    } else if (request.method === "eth_getUserOperationReceipt") result = null;
    else throw Error(`unexpected provider ${request.method}`);
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  });
  const provider = new UserOperationProvider([{
    chainId: 8453, providerId: "passkey-provider", entryPoint: pin(entryPoint), bundlerUrl: "https://bundler.example.test/rpc",
    ...(options.sponsored ? { paymasterUrl: "https://paymaster.example.test/rpc", paymasterPolicy: {
      id: "fixture-policy", profile: "pimlico-v7-current-flags" as const, contract: pin(paymaster), context: {},
      inspect: () => ({ policyId: "fixture-policy", gasOnly: true as const, validAfter: 0, validUntil: now / 1000 + 1000, commitment: h("sponsor") }),
    } } : {}),
  }], fetcher, 1000, () => now);
  const currentBindingAt = vi.fn(async () => { if (state.bindingFailure) throw Error("binding changed"); return wallet; });
  const transactions = new TransactionService({ store: transactionStore, rpc: { request: rpc }, now: () => now });
  const service = new UserOperationService({
    rpc: { request: rpc }, provider, store, transactionStore, transactions,
    policies: [{ chainId: 8453, gas: { ...gas,
      ...(options.maximumPreVerificationGas !== undefined ? { maximumPreVerificationGas: options.maximumPreVerificationGas } : {}),
    }, confirmations: 1 }],
    currentBinding: async () => wallet, currentBindingAt, manifestFor: () => manifest, manifestForPlan: () => manifest,
    verifyHistoricalAccount: async () => {}, semanticVerifier: { verify: async () => ({ status: "verified" }) },
    now: () => now, authorizeRequest: async () => ({ issuedAt: now / 1000, expiresAt: now / 1000 + 60 }),
  });
  const prepare = (extra = {}) => service.prepare(principal, { planId: preparedPlan.id, stepIndexes: [0], ...extra }, "prepare", h("prepare"));
  const signature = (view: Awaited<ReturnType<typeof prepare>>, body: Hex = "0x1234") => encodeSafe7579PasskeyOwnerSignature({
    validAfter: String(view.createdAt / 1000), validUntil: String(view.expiresAt / 1000), signatures: [{ kind: "contract", owner: signer, signature: body }],
  });
  return { service, prepare, signature, state, wallet, manifest, principal, rpc, provider, currentBindingAt, store, actor };
}

describe("passkey UserOperation estimation", () => {
  it("uses the maximum accepted real WebAuthn shape and nonzero in-range FCL scalars", async () => {
    const maximum = JSON.parse(await readFile(new URL("./fixtures/wallet/passkey-assertion-max.json", import.meta.url), "utf8"));
    const body = passkeyDummyContractSignature();
    expect(body).toBe(maximum.contractSignature);
    expect(size(body)).toBe(2240);
    const [auth, fields, r, s] = decodeAbiParameters([{ type: "bytes" }, { type: "string" }, { type: "uint256" }, { type: "uint256" }], body);
    expect(size(auth)).toBe(37); expect(Buffer.byteLength(fields)).toBe(1966);
    expect(BigInt(sliceHex(auth, 32, 33)) & 4n).toBe(4n);
    const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
    expect(r > 0n && r < n && s > 0n && s < n).toBe(true);
    expect(size(passkeyDummySignature({ signer, validAfter: "1", validUntil: "2" }))).toBe(PASSKEY_MAX_SIGNATURE_BYTES);
  });

  it("adds the calldata-byte margin independently to every provider estimate", async () => {
    const estimate = { callGasLimit: "0x1", verificationGasLimit: "0x1", preVerificationGas: toHex(50_000) };
    const original = { estimate: vi.fn(async () => ({ ...estimate })), sponsor: vi.fn() };
    const wrapper = passkeyEstimateProvider(original as unknown as UserOperationProvider);
    const operation = {} as UserOperationV07;
    for (let i = 0; i < 3; i++) expect(BigInt((await wrapper.estimate(8453, operation)).preVerificationGas)).toBe(50_000n + 12n * 2349n);
    expect(estimate.preVerificationGas).toBe(toHex(50_000));
  });

  it("prepares the new explicit signature profile with its exact SafeOp preimage", async () => {
    const f = await fixture(), view = await f.prepare();
    expect(size(f.state.estimated[0]!.signature)).toBe(2349);
    expect(BigInt(view.operation.preVerificationGas)).toBe(50_000n + 12n * 2349n);
    expect(view.signing).toMatchObject({ ownerProfile: "center-passkey-v1" });
    expect(keccak256((view.signing as { signedData: Hex }).signedData)).toBe(view.signing.digest);
    expect(view.operation.signature).toBe("0x");
  });

  it("preserves legacy EOA preparation without dynamic signatures or margins", async () => {
    const f = await fixture({ legacy: true }), view = await f.prepare();
    expect(size(f.state.estimated[0]!.signature)).toBe(77);
    expect(view.operation.preVerificationGas).toBe(toHex(50_000));
    expect(view.signing).not.toHaveProperty("ownerProfile");
  });

  it("fails closed when the hosted provider cannot estimate the actual invalid-signature path", async () => {
    const f = await fixture(); f.state.estimateFailure = true;
    await expect(f.prepare()).rejects.toMatchObject({ code: "USER_OPERATION_PROVIDER_REJECTED" });
    expect(f.state.sends).toBe(0);
    expect(await f.store.find(f.actor, "prepare", h("prepare"))).toBeUndefined();
  });

  it("rejects a calldata margin above policy before requesting a final sponsor quote", async () => {
    const f = await fixture({ sponsored: true, maximumPreVerificationGas: 78_187n });
    await expect(f.prepare()).rejects.toMatchObject({ code: "USER_OPERATION_GAS_LIMIT" });
    expect(f.state.finalQuotes).toBe(0); expect(f.state.sends).toBe(0);
    expect(await f.store.find(f.actor, "prepare", h("prepare"))).toBeUndefined();
  });

  it("requires matching canonical state and manifest profiles", async () => {
    for (const remove of ["manifest", "state"] as const) {
      const f = await fixture();
      if (remove === "manifest") delete f.manifest.ownerProfile; else delete f.wallet.state.ownerProfile;
      await expect(f.prepare()).rejects.toMatchObject({ code: "USER_OPERATION_OWNER_PROFILE_CHANGED" });
      expect(f.state.estimated).toHaveLength(0);
    }
  });

  it("refuses delegated sessions for the pilot owner profile", async () => {
    const f = await fixture();
    await expect(f.prepare({ sessionId: "00000000-0000-0000-0000-000000000000" })).rejects.toMatchObject({ code: "USER_OPERATION_PASSKEY_SESSION_UNAVAILABLE" });
  });

  it("re-estimates exact sponsor quotes with the same bounded shape and non-accumulating margin", async () => {
    const f = await fixture({ sponsored: true }); f.state.growth = true;
    const view = await f.prepare();
    expect(f.state.finalQuotes).toBe(2);
    expect(f.state.estimated).toHaveLength(3);
    expect(f.state.estimated.every((operation) => size(operation.signature) === 2349)).toBe(true);
    expect(BigInt(view.operation.preVerificationGas)).toBe((88_188n * 105n + 99n) / 100n);
  });

  it("stops sponsorship when its bounded quotes do not converge", async () => {
    const f = await fixture({ sponsored: true }); f.state.growAlways = true;
    await expect(f.prepare()).rejects.toMatchObject({ code: "USER_OPERATION_SPONSOR_GAS_CHANGED" });
    expect(f.state.finalQuotes).toBe(3); expect(f.state.sends).toBe(0);
  });
});

describe("passkey UserOperation owner admission", () => {
  it("calls the exact legacy bytes selector at the inspected block and preserves every approved field", async () => {
    const f = await fixture(), view = await f.prepare(), signature = f.signature(view);
    const submitted = await f.service.submit(f.principal, view.id, signature, "submit");
    expect(submitted.state).toBe("pending");
    expect(f.state.sent).toEqual({ ...view.operation, signature });
    expect(f.state.estimated).toHaveLength(2);
    expect(f.state.estimated[1]).toEqual({ ...view.operation, signature });
    expect(f.currentBindingAt).toHaveBeenCalledTimes(1);
    const call = f.rpc.mock.calls.find(([, method, params]) => method === "eth_call" && (params[0] as { to: string }).to === signer)!;
    const data = decodeFunctionData({ abi: legacy1271, data: (call[2][0] as { data: Hex }).data });
    expect(data.args).toEqual([(view.signing as { signedData: Hex }).signedData, "0x1234"]);
    expect(call[2][1]).toEqual({ blockHash: h("passkey-block"), requireCanonical: true });
    expect(BigInt((call[2][0] as { gas: Hex }).gas)).toBeLessThanOrEqual(2_000_000n);
    expect(call[3]).toBeInstanceOf(AbortSignal);
  });

  it("allows the independent recovery EOA to sign the exact same SafeOp", async () => {
    const f = await fixture(), view = await f.prepare();
    const signature = encodeSafe7579PasskeyOwnerSignature({ validAfter: String(view.createdAt / 1000), validUntil: String(view.expiresAt / 1000),
      signatures: [{ kind: "ecdsa", owner: ownerKey.address, signature: await ownerKey.sign({ hash: view.signing.digest }) }],
    });
    expect((await f.service.submit(f.principal, view.id, signature, "submit")).state).toBe("pending");
    expect(f.rpc.mock.calls.some(([, method, params]) => method === "eth_call" && (params[0] as { to: string }).to === signer)).toBe(false);
  });

  it.each([
    [false, "callGasLimit"], [false, "verificationGasLimit"], [false, "preVerificationGas"],
    [true, "callGasLimit"], [true, "verificationGasLimit"], [true, "preVerificationGas"],
    [true, "paymasterVerificationGasLimit"], [true, "paymasterPostOpGasLimit"],
  ] as const)("does not claim or change approved gas when the exact signed estimate grows: sponsored=%s %s", async (sponsored, field) => {
    const f = await fixture({ sponsored }), view = await f.prepare();
    f.state.signedEstimate = { [field]: toHex(BigInt(view.operation[field]!) + 1n) };
    await expect(f.service.submit(f.principal, view.id, f.signature(view), "submit")).rejects.toMatchObject({ code: "USER_OPERATION_SIGNED_GAS_CHANGED" });
    const stored = (await f.store.get(f.actor, view.id))!;
    expect(stored.state).toBe("prepared"); expect(stored.submission).toBeUndefined();
    expect(stored.operation).toEqual(view.operation); expect(f.state.sends).toBe(0);
  });

  it.each([false, true])("does not reserve a nonce when exact signed provider estimation rejects: sponsored=%s", async (sponsored) => {
    const f = await fixture({ sponsored }), view = await f.prepare(); f.state.estimateFailure = true;
    await expect(f.service.submit(f.principal, view.id, f.signature(view), "submit")).rejects.toMatchObject({ code: "USER_OPERATION_PROVIDER_REJECTED" });
    expect((await f.store.get(f.actor, view.id))!.submission).toBeUndefined(); expect(f.state.sends).toBe(0);
  });

  it("retains the approved bytes when the exact signed estimate times out under the existing provider deadline", async () => {
    const f = await fixture(), view = await f.prepare(); f.state.estimateTimeout = true;
    await expect(f.service.submit(f.principal, view.id, f.signature(view), "submit")).rejects.toMatchObject({ code: "USER_OPERATION_PROVIDER_TIMEOUT" });
    expect((await f.store.get(f.actor, view.id))!.submission).toBeUndefined(); expect(f.state.sends).toBe(0);
  });

  it("does not add the dummy margin a second time to the actual signed estimate", async () => {
    const f = await fixture(), view = await f.prepare();
    f.state.signedEstimate = { preVerificationGas: view.operation.preVerificationGas };
    expect((await f.service.submit(f.principal, view.id, f.signature(view), "submit")).state).toBe("pending");
    expect(f.state.sent!.preVerificationGas).toBe(view.operation.preVerificationGas);
  });

  it("submits the exact final sponsored bytes when their signed estimate fits", async () => {
    const f = await fixture({ sponsored: true }), view = await f.prepare(), signature = f.signature(view);
    expect((await f.service.submit(f.principal, view.id, signature, "submit")).state).toBe("pending");
    expect(f.state.sent).toEqual({ ...view.operation, signature });
  });

  it.each(["0x1626ba7e", `0x1626ba7e${"00".repeat(28)}`, "0x20c13b0b", `0x20c13b0b${"00".repeat(29)}`, "0x", "0x01", null, true])("rejects noncanonical contract evidence %s before admission", async (invalid) => {
    const f = await fixture(), view = await f.prepare(); f.state.contractResult = invalid;
    await expect(f.service.submit(f.principal, view.id, f.signature(view), "submit")).rejects.toMatchObject({ code: "SMART_OWNER_SIGNATURE_INVALID" });
    expect(f.state.sends).toBe(0);
    expect((await f.store.get(f.actor, view.id))!.submission).toBeUndefined();
  });

  it.each(["contractFailure", "runtimeFailure", "reorg", "preflightFailure", "bindingFailure"] as const)("never claims or sends when %s removes canonical evidence", async (failure) => {
    const f = await fixture(), view = await f.prepare(); f.state[failure] = true;
    await expect(f.service.submit(f.principal, view.id, f.signature(view), "submit")).rejects.toThrow();
    expect(f.state.sends).toBe(0);
    expect((await f.store.get(f.actor, view.id))!.submission).toBeUndefined();
  });

  it("rejects signatures beyond the approved maximum without attempting verification or gas changes", async () => {
    const f = await fixture(), view = await f.prepare();
    await expect(f.service.submit(f.principal, view.id, f.signature(view, `0x${"11".repeat(2241)}`), "submit")).rejects.toMatchObject({ code: "USER_OPERATION_PASSKEY_SIGNATURE_LIMIT" });
    expect(f.state.sends).toBe(0); expect(f.state.estimated).toHaveLength(1);
  });

  it("rejects a modified validity window before checking the contract or reserving its nonce", async () => {
    const f = await fixture(), view = await f.prepare();
    const signature = encodeSafe7579PasskeyOwnerSignature({ validAfter: String(view.createdAt / 1000), validUntil: String(view.expiresAt / 1000 + 1),
      signatures: [{ kind: "contract", owner: signer, signature: "0x1234" }],
    });
    await expect(f.service.submit(f.principal, view.id, signature, "submit")).rejects.toMatchObject({ code: "SMART_ACCOUNT_ENVELOPE_INVALID" });
    expect(f.state.sends).toBe(0);
    expect(f.rpc.mock.calls.some(([, method, params]) => method === "eth_call" && (params[0] as { to: string }).to === signer)).toBe(false);
  });

  it("an aborted contract verification never claims or sends the operation", async () => {
    const f = await fixture(), view = await f.prepare(), controller = new AbortController();
    controller.abort();
    await expect(f.service.submit(f.principal, view.id, f.signature(view), "submit", controller.signal)).rejects.toThrow();
    expect(f.state.sends).toBe(0);
    expect((await f.store.get(f.actor, view.id))!.submission).toBeUndefined();
  });

  it("permits only one competing signature to claim the same prepared nonce", async () => {
    const f = await fixture(), view = await f.prepare();
    const results = await Promise.allSettled(Array.from({ length: 25 }, (_, index) =>
      f.service.submit(f.principal, view.id, f.signature(view, toHex(index + 1, { size: 2 })), `submit-${index}`)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "USER_OPERATION_CONFLICT" });
    expect(f.state.sends).toBe(1);
    expect((await f.store.get(f.actor, view.id))!.submission!.operation).toEqual(f.state.sent);
  });

  it("preserves unknown submission and forbids a second signature from taking the same nonce", async () => {
    const f = await fixture(), view = await f.prepare(); f.state.sendFailure = true;
    expect((await f.service.submit(f.principal, view.id, f.signature(view), "submit")).state).toBe("submission_unknown");
    await expect(f.service.submit(f.principal, view.id, f.signature(view, "0x5678"), "submit")).rejects.toMatchObject({ code: "USER_OPERATION_CONFLICT" });
    expect(f.state.sends).toBe(1);
  });
});
