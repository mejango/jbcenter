import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, getAddress, hashTypedData, keccak256, parseAbi,
  padHex, parseTransaction, stringToHex, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { RestRpc } from "../src/rest/core.js";
import { createWalletDeploymentChain, type WalletDeploymentChainOptions } from "../src/rest/wallet/deploymentChain.js";
import { prepareWalletDeploymentApproval, validateSignedWalletDeployment } from "../src/rest/wallet/deployment.js";
import type { WalletDeploymentOperation, WalletDeploymentPoolConfiguration } from "../src/rest/wallet/deploymentPostgres.js";
import { createWalletEnrollmentIntent, enrollmentDigest, prepareWalletEnrollmentCandidate, verifyWalletEnrollmentProof,
  walletEnrollmentDocument, type WalletEnrollment } from "../src/rest/wallet/enrollment.js";
import type { ContractPin, SmartAccountManifest } from "../src/rest/smartAccounts/types.js";
import { createRegistration, enrollmentBackupAccount, enrollmentManifest, signBackupProof, signGet } from "./fixtures/wallet-enrollment-crypto.js";

const now = 1_800_000_000_000, blockHash = `0x${"01".repeat(32)}` as Hex;
const sender = privateKeyToAccount(`0x${"22".repeat(32)}`).address.toLowerCase() as Address;
const signerAbi = parseAbi(["function SINGLETON() view returns(address)", "function getSigner(uint256 x,uint256 y,uint176 verifiers) view returns(address)",
  "function getConfiguration() view returns(uint256 x,uint256 y,uint176 verifiers)"]);
const artifact = (name: string, dir = "") => JSON.parse(readFileSync(new URL(`../src/rest/smartAccounts/stack/${dir}artifacts/${name}.json`, import.meta.url), "utf8"));
function patched(a: ReturnType<typeof artifact>, values: Record<string, bigint>): Hex {
  const code = Buffer.from(a.deployedBytecode.slice(2), "hex");
  for (const [key, references] of Object.entries(a.immutableReferences) as [string, { start: number }[]][])
    for (const ref of references) Buffer.from(toHex(values[key]!, { size: 32 }).slice(2), "hex").copy(code, ref.start);
  return `0x${code.toString("hex")}`;
}
const mainPin = (a: ReturnType<typeof artifact>): ContractPin => ({ address: a.address, runtimeCodeHash: a.runtimeCodeHash,
  source: { repository: a.source.repo, commit: a.source.commit, artifactSha256: a.source.artifactSha256 } });
const utility = mainPin(artifact("Safe7579DCUtil"));
const manifest: SmartAccountManifest = structuredClone(enrollmentManifest);
manifest.moduleInspectorId = "safe7579-f22a194-trace-v1";
manifest.entryPoint = { ...mainPin(artifact("EntryPoint")), version: "0.7" };
const factoryRuntime = patched(artifact("SafeWebAuthnSignerFactory", "passkey/"), { "16": BigInt(manifest.ownerProfile!.signerSingleton.address) });
manifest.ownerProfile!.signerFactory.runtimeCodeHash = keccak256(factoryRuntime);
let enrollment: WalletEnrollment;
beforeAll(async () => {
  const intent = createWalletEnrollmentIntent({ manifest, rpId: "juicebox.center", origin: "https://juicebox.center",
    recoveryOwner: enrollmentBackupAccount.address, expiresAt: now + 60_000 });
  const empty: WalletEnrollment = { intent, createdAt: now, state: "awaiting_registration", candidate: null,
    candidateDigest: null, creation: null, possession: null, receipt: null };
  const credential = createRegistration({ challenge: `0x${Buffer.from(intent.registration.challenge, "base64url").toString("hex")}`,
    rpId: intent.rpId, origin: intent.origin, userHandle: intent.userHandle });
  const pending: WalletEnrollment = { ...empty, ...prepareWalletEnrollmentCandidate(empty, credential.response), state: "awaiting_possession" };
  const document = walletEnrollmentDocument(pending);
  const proof = await verifyWalletEnrollmentProof(pending, { assertion: signGet({ ...credential, challenge: hashTypedData(document),
    rpId: intent.rpId, origin: intent.origin }), backupSignature: await signBackupProof(document) });
  // Genuine crypto, followed by a unit-test stand-in for W3's atomic durable receipt.
  enrollment = { ...pending, state: "verified", receipt: { id: intent.id, enrollmentId: intent.id,
    accountId: `eip155:8453:${pending.creation!.address.toLowerCase()}`, credentialId: credential.credentialId,
    initializerHash: pending.creation!.initializerHash, manifestCommitment: `0x${enrollmentDigest(intent.manifest)}`,
    manifestRevision: intent.manifest.revision, creationCommitment: `0x${enrollmentDigest(pending.creation)}`,
    verificationDigest: proof.verificationDigest, verifiedAt: now + 1 } };
});
function configuration(): WalletDeploymentPoolConfiguration {
  return { id: randomUUID(), chainId: 8453, sender, allocationWei: "100000000000000000",
    globalAllocationLimitWei: "1000000000000000000", policy: { maximumRawBytes: 32768, maximumGas: "2000000",
      maximumFeePerGas: "10000000000", maximumTransactionCost: "20000000000000000", maximumObservationAgeMs: 5000 } };
}
type Override = (method: string, params: readonly unknown[], result: unknown, signal?: AbortSignal) => unknown | Promise<unknown>;
function fixture(override?: Override, options: Partial<Omit<WalletDeploymentChainOptions, "rpc">> = {}) {
  const config = configuration(), record = structuredClone(enrollment);
  const approval = prepareWalletDeploymentApproval(record, { issuedAt: now + 2, expiresAt: now + 30_000 });
  const codes = new Map<string, Hex>();
  for (const name of ["SafeL2", "SafeProxyFactory", "Safe7579", "Safe7579Launchpad", "Safe7579DCUtil", "EntryPoint", "SmartSession"]) {
    const a = artifact(name); codes.set(a.address.toLowerCase(), a.deployedRuntimeBytecode ?? a.deployedBytecode);
  }
  codes.set(manifest.ownerProfile!.signerFactory.address.toLowerCase(), factoryRuntime);
  codes.set(manifest.ownerProfile!.signerSingleton.address.toLowerCase(), artifact("SafeWebAuthnSignerSingleton", "passkey/").deployedBytecode);
  codes.set(manifest.ownerProfile!.p256Verifier.address.toLowerCase(), artifact("FCLP256Verifier", "passkey/").deployedBytecode);
  codes.set(manifest.creationProfile!.multiSend.address.toLowerCase(), artifact("MultiSend", "passkey/bootstrap/").deployedRuntimeBytecode);
  const calls: { method: string; params: readonly unknown[]; signal?: AbortSignal }[] = [];
  const rpc: RestRpc = { request: async (_chain, method, params, signal) => {
    calls.push({ method, params: structuredClone(params), ...(signal ? { signal } : {}) });
    let result: unknown;
    if (method === "eth_chainId") result = "0x2105";
    else if (method === "eth_getBlockByNumber") result = { number: "0x64", hash: blockHash, timestamp: toHex(BigInt(now / 1000)), baseFeePerGas: "0x3b9aca00", transactions: [] };
    else if (method === "eth_getTransactionByHash" || method === "eth_getTransactionReceipt") result = null;
    else if (method === "eth_getCode") result = codes.get(String(params[0]).toLowerCase()) ?? "0x";
    else if (method === "eth_getTransactionCount") result = "0x1";
    else if (method === "eth_getBalance") result = toHex(100_000_000_000_000_000n);
    else if (method === "eth_estimateGas") result = "0x7a120";
    else if (method === "eth_call") {
      const call = params[0] as { to: Address; data: Hex };
      if (call.to.toLowerCase() === manifest.factory.address.toLowerCase())
        result = encodeAbiParameters([{ type: "address" }], [record.creation!.address]);
      else {
        const decoded = decodeFunctionData({ abi: signerAbi, data: call.data });
        result = decoded.functionName === "SINGLETON"
          ? encodeFunctionResult({ abi: signerAbi, functionName: "SINGLETON", result: manifest.ownerProfile!.signerSingleton.address })
          : decoded.functionName === "getSigner"
            ? encodeFunctionResult({ abi: signerAbi, functionName: "getSigner", result: record.creation!.bootstrap.signerAddress })
            : encodeFunctionResult({ abi: signerAbi, functionName: "getConfiguration", result: [BigInt(record.candidate!.publicKey.x),
              BigInt(record.candidate!.publicKey.y), BigInt(manifest.ownerProfile!.p256Verifier.address)] });
      }
    } else throw new Error(`Unexpected mutation or RPC method: ${method}`);
    return override ? override(method, params, result, signal) : result;
  } };
  const chain = createWalletDeploymentChain({ rpc, configuration: config, manifest, utility, now: () => now + 3, ...options });
  return { chain, calls, record, approval, config, codes, preflight: (signal?: AbortSignal) => chain.preflight(record, approval, signal) };
}
function signerRuntime(record: WalletEnrollment): Hex {
  return patched(artifact("SafeWebAuthnSignerProxy", "passkey/"), { "226": BigInt(manifest.ownerProfile!.signerSingleton.address),
    "229": BigInt(record.candidate!.publicKey.x), "232": BigInt(record.candidate!.publicKey.y), "236": BigInt(manifest.ownerProfile!.p256Verifier.address) });
}

describe("provider-owned deployment preflight without dispatch authority", () => {
  it("pins the exact factory call and canonical state while distinguishing execution coverage from Base affordability", async () => {
    const f = fixture(), result = await f.preflight();
    expect(result).toMatchObject({ dispatchEligible: false, signer: { address: f.record.creation!.bootstrap.signerAddress, deployed: false },
      admission: { sender, confirmedNonce: "1", pendingNonce: "1", blockHash, observedAt: now + 3, gas: "650000", maxFeePerGas: "2001000000", maxPriorityFeePerGas: "1000000" },
      feeModel: { kind: "base-execution-only-v1", executionEnvelopeCovered: true, baseTotalAffordability: "unknown",
        maximumExecutionCost: "1300650000000000", estimatedGas: "500000", baseFeePerGas: "1000000000" } });
    const creationCalls = f.calls.filter(c => ["eth_call", "eth_estimateGas"].includes(c.method) &&
      String((c.params[0] as { to: Address }).to).toLowerCase() === manifest.factory.address.toLowerCase());
    expect(creationCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of creationCalls) expect(call.params[0]).toMatchObject({ from: sender, to: manifest.factory.address,
      data: f.record.creation!.transaction.data, value: "0x0", nonce: "0x1", accessList: [] });
    for (const call of f.calls.filter(c => ["eth_getCode", "eth_getBalance", "eth_call"].includes(c.method)))
      expect(call.params.at(-1)).toEqual({ blockHash, requireCanonical: true });
    expect(f.calls.some(c => c.method === "eth_getTransactionCount" && typeof c.params[1] === "object")).toBe(true);
    expect(f.calls.every(c => !/send|sign|set|anvil/i.test(c.method))).toBe(true);
    expect(result.template.transaction.data).toBe(f.record.creation!.transaction.data);
  });
  it("accepts an already deployed exact signer, preventing permissionless signer deployment from blocking enrollment", async () => {
    const f = fixture(); f.codes.set(f.record.creation!.bootstrap.signerAddress.toLowerCase(), signerRuntime(f.record));
    expect((await f.preflight()).signer.deployed).toBe(true);
  });
  it.each(["signer", "backup", "sender", "safe", "factory", "utility"])("rejects incompatible %s runtime", async who => {
    const f = fixture(), address = who === "signer" ? f.record.creation!.bootstrap.signerAddress : who === "backup" ? f.record.intent.recoveryOwner :
      who === "sender" ? sender : who === "safe" ? f.record.creation!.address : who === "factory" ? manifest.factory.address : utility.address;
    f.codes.set(address.toLowerCase(), "0xef01001234567890123456789012345678901234567890");
    await expect(f.preflight()).rejects.toThrow();
  });
  it("rejects another P256 key's immutable runtime at the enrolled signer address", async () => {
    const f = fixture(), changed = structuredClone(f.record); changed.candidate!.publicKey.x = toHex(1n, { size: 32 });
    f.codes.set(f.record.creation!.bootstrap.signerAddress.toLowerCase(), signerRuntime(changed));
    await expect(f.preflight()).rejects.toThrow();
  });
  it.each(["SINGLETON", "getSigner", "getConfiguration"])("rejects a false %s response despite matching runtime", async functionName => {
    const f = fixture((method, params, result) => {
      if (method !== "eth_call") return result;
      const call = params[0] as { to: Address; data: Hex };
      if (call.to.toLowerCase() === manifest.factory.address.toLowerCase()) return result;
      if (decodeFunctionData({ abi: signerAbi, data: call.data }).functionName !== functionName) return result;
      return functionName === "getConfiguration"
        ? encodeFunctionResult({ abi: signerAbi, functionName, result: [1n, 2n, BigInt(manifest.ownerProfile!.p256Verifier.address)] })
        : encodeFunctionResult({ abi: signerAbi, functionName, result: sender });
    });
    f.codes.set(f.record.creation!.bootstrap.signerAddress.toLowerCase(), signerRuntime(f.record));
    await expect(f.preflight()).rejects.toThrow();
  });
  it.each([
    ["chain", "eth_chainId", "0x1"], ["insufficient balance", "eth_getBalance", "0x1"],
    ["zero estimate", "eth_estimateGas", "0x0"], ["excessive estimate", "eth_estimateGas", "0x1e8481"],
    ["malformed nonce", "eth_getTransactionCount", "0x01"], ["unsafe nonce", "eth_getTransactionCount", "0x20000000000000"],
  ])("rejects %s", async (_, method, replacement) => {
    await expect(fixture((name, _params, result) => name === method ? replacement : result).preflight()).rejects.toThrow();
  });
  it.each(["0x0", "0x2"])("rejects pending nonce %s differing from the canonical confirmed nonce", async pending => {
    await expect(fixture((method, params, result) => method === "eth_getTransactionCount" && params[1] === "pending" ? pending : result).preflight()).rejects.toThrow();
  });
  it("rechecks the pending signal after simulation", async () => {
    let reads = 0;
    await expect(fixture((method, params, result) => method === "eth_getTransactionCount" && params[1] === "pending" && ++reads > 1 ? "0x2" : result).preflight()).rejects.toThrow();
    expect(reads).toBe(2);
  });
  it.each(["0x", encodeAbiParameters([{ type: "address" }], [sender])])( "rejects incorrect factory simulation return %s", async replacement => {
    await expect(fixture((method, params, result) => method === "eth_call" &&
      String((params[0] as { to: Address }).to).toLowerCase() === manifest.factory.address.toLowerCase() ? replacement : result).preflight()).rejects.toThrow();
  });
  it("rejects a changed canonical block after simulation", async () => {
    await expect(fixture((method, params, result) => method === "eth_getBlockByNumber" && params[0] !== "latest" ?
      { ...result as object, hash: `0x${"02".repeat(32)}` } : result).preflight()).rejects.toThrow();
  });
  it.each(["missing", "too high", "stale", "future"])("rejects %s block/fee evidence", async mutation => {
    await expect(fixture((method, _params, result) => {
      if (method !== "eth_getBlockByNumber") return result;
      const block = { ...result as Record<string, unknown> };
      if (mutation === "missing") delete block.baseFeePerGas;
      if (mutation === "too high") block.baseFeePerGas = toHex(10_000_000_000n);
      if (mutation === "stale") block.timestamp = toHex(BigInt(now / 1000) - 301n);
      if (mutation === "future") block.timestamp = toHex(BigInt(now / 1000) + 31n);
      return block;
    }).preflight()).rejects.toThrow();
  });
  it("keeps the first observation time across RPC work", async () => {
    let clock = now + 3;
    const f = fixture((_method, _params, result) => { clock += 10; return result; }, { now: () => clock });
    const result = await f.preflight(); expect(clock).toBeGreaterThan(now + 3); expect(result.admission.observedAt).toBe(now + 3);
  });
  it("rejects observation expiry during RPC work", async () => {
    let clock = now + 3;
    await expect(fixture((_method, _params, result) => { clock += 1000; return result; }, { now: () => clock }).preflight()).rejects.toThrow();
  });
  it("rejects same-revision manifest substitution before RPC", async () => {
    const changed = structuredClone(manifest); changed.ownerProfile!.p256Verifier.source.contentSha256 = "ab".repeat(32);
    const f = fixture(undefined, { manifest: changed });
    await expect(f.preflight()).rejects.toMatchObject({ code: "WALLET_DEPLOYMENT_MANIFEST_MISMATCH" }); expect(f.calls).toHaveLength(0);
  });
  it.each(["creation", "approval", "manifest"])("rejects changed immutable %s before RPC", async field => {
    const f = fixture();
    if (field === "creation") f.record.creation!.transaction.data = "0x1234";
    if (field === "approval") f.approval.enrollmentCommitment = `0x${"ab".repeat(32)}`;
    if (field === "manifest") f.record.intent.manifest.revision = `0x${"ab".repeat(32)}`;
    await expect(f.preflight()).rejects.toThrow(); expect(f.calls).toHaveLength(0);
  });
  it("does not reread caller-owned enrollment/configuration after starting RPC", async () => {
    const config = configuration(), f = fixture((_method, _params, result) => {
      f.record.creation!.transaction.data = "0x1234"; config.sender = enrollmentBackupAccount.address; return result;
    }, { configuration: config });
    const expected = f.record.creation!.transaction.data;
    const result = await f.preflight(); expect(result.template.transaction.data).toBe(expected); expect(result.admission.sender).toBe(sender);
  });
  it.each([
    { rpcCalls: 2 }, { responseBytes: 16 },
  ])("enforces shared response/call limits %j", async limits => {
    await expect(fixture(undefined, { limits }).preflight()).rejects.toMatchObject({ status: 429 });
  });
  it("bounds runtime byte strings before comparing code", async () => {
    await expect(fixture((method, _params, result) => method === "eth_getCode" ? `0x${"00".repeat(49153)}` : result).preflight()).rejects.toThrow();
  });
  it("counts JSON escaping in the shared provider byte budget", async () => {
    await expect(fixture((method, _params, result) => method === "eth_getBlockByNumber"
      ? { ...result as object, extra: "\0".repeat(100_000) } : result).preflight()).rejects.toMatchObject({ code: "WALLET_DEPLOYMENT_RPC_BYTES" });
  });
  it("rejects oversized property names before serializing them", async () => {
    const key = "x".repeat(524_289), f = fixture((method, _params, result) => method === "eth_getBlockByNumber"
      ? { ...result as object, [key]: true } : result);
    let serialized = false; const original = JSON.stringify;
    const spy = vi.spyOn(JSON, "stringify").mockImplementation(((value: unknown, ...args: unknown[]) => {
      if (value === key) serialized = true; return (original as (...args: unknown[]) => string)(value, ...args);
    }) as typeof JSON.stringify);
    try { await expect(f.preflight()).rejects.toThrow(); expect(serialized).toBe(false); } finally { spy.mockRestore(); }
  });
  it("rejects sparse arrays before cloning their unbounded length", async () => {
    const sparse = new Array(100_000_000), f = fixture((method, _params, result) => method === "eth_getBlockByNumber" ? sparse : result);
    let copied = false; const original = structuredClone;
    const spy = vi.spyOn(globalThis, "structuredClone").mockImplementation((value, options) => {
      if (value === sparse) copied = true; return original(value, options);
    });
    try { await expect(f.preflight()).rejects.toThrow(); expect(copied).toBe(false); } finally { spy.mockRestore(); }
  });
  it("rejects proxy responses without invoking their traps", async () => {
    let trapped = false;
    const proxy = new Proxy({}, { ownKeys() { trapped = true; throw new Error("untrusted trap"); } });
    await expect(fixture((method, _params, result) => method === "eth_getBlockByNumber" ? proxy : result).preflight()).rejects.toThrow();
    expect(trapped).toBe(false);
  });
  it.each(["maximumRawBytes", "maximumTransactionCost"])("rejects the prepared envelope exceeding %s", async field => {
    const config = configuration();
    if (field === "maximumRawBytes") config.policy.maximumRawBytes = 100;
    else config.policy.maximumTransactionCost = "1";
    await expect(fixture(undefined, { configuration: config }).preflight()).rejects.toThrow();
  });
  it("terminates when the configured RPC ignores its per-call deadline", async () => {
    const f = fixture(() => new Promise(() => {}), { limits: { rpcTimeoutMs: 20, totalTimeoutMs: 100 } });
    await expect(f.preflight()).rejects.toMatchObject({ code: "WALLET_DEPLOYMENT_RPC_TIMEOUT" });
    expect(f.calls.every(call => call.signal?.aborted)).toBe(true);
  });
  it("enforces the overall deadline independently from per-call timeouts", async () => {
    const f = fixture(() => new Promise(() => {}), { limits: { rpcTimeoutMs: 100, totalTimeoutMs: 20 } });
    await expect(f.preflight()).rejects.toMatchObject({ code: "WALLET_DEPLOYMENT_DEADLINE" });
  });
  it.each([
    [{ rpcTimeoutMs: 10, totalTimeoutMs: 100 }, "WALLET_DEPLOYMENT_RPC_TIMEOUT"],
    [{ rpcTimeoutMs: 100, totalTimeoutMs: 10 }, "WALLET_DEPLOYMENT_DEADLINE"],
  ] as const)("enforces monotonic deadlines when synchronous RPC work starves timers: %j", async (limits, code) => {
    let delayed = false;
    const f = fixture((_method, _params, result) => {
      if (!delayed) { delayed = true; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30); }
      return result;
    }, { limits });
    await expect(f.preflight()).rejects.toMatchObject({ code });
  });
  it("propagates cancellation even when the RPC ignores its AbortSignal", async () => {
    const controller = new AbortController(), f = fixture(() => new Promise(() => {}));
    const promise = f.preflight(controller.signal); controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "WALLET_DEPLOYMENT_CANCELLED" });
    expect(f.calls.every(call => call.signal?.aborted)).toBe(true);
  });
  it("performs no RPC for an already cancelled operation", async () => {
    const controller = new AbortController(); controller.abort(); const f = fixture();
    await expect(f.preflight(controller.signal)).rejects.toMatchObject({ code: "WALLET_DEPLOYMENT_CANCELLED" }); expect(f.calls).toHaveLength(0);
  });
});

async function signedFixture(override?: Override, options: Partial<Omit<WalletDeploymentChainOptions, "rpc">> = {}) {
  const f = fixture(override, options), prepared = await f.preflight(), tx = prepared.template.transaction;
  const rawTransaction = await privateKeyToAccount(`0x${"22".repeat(32)}`).signTransaction({ ...tx, nonce: Number(tx.nonce), gas: BigInt(tx.gas),
    value: 0n, maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) });
  const validated = await validateSignedWalletDeployment({ enrollment: f.record, approval: f.approval, template: prepared.template, rawTransaction,
    policy: { ...f.config.policy, maximumGas: BigInt(f.config.policy.maximumGas), maximumFeePerGas: BigInt(f.config.policy.maximumFeePerGas),
      maximumTransactionCost: BigInt(f.config.policy.maximumTransactionCost), planTtlMs: 300_000, maximumPlanTtlMs: 300_000,
      leaseMs: 15_000, rpcTimeoutMs: 3000, confirmations: 1, allowedChainIds: [8453] } });
  const operation = { id: f.approval.id, poolId: f.config.id, enrollmentId: f.record.intent.id, poolConfigurationDigest: enrollmentDigest(f.config),
    approval: f.approval, state: "signed", createdAt: now + 2, retainUntil: now + 300_000, claimedAt: now + 3,
    proofDigest: "aa".repeat(32), admission: prepared.admission, template: prepared.template, templateCommitment: validated.templateCommitment,
    signingLease: null, signed: { rawTransaction, hash: validated.hash, maximumExecutionCost: validated.maximumExecutionCost }, revision: 2,
    observation: null, historicalCanonicalObservation: null, highestObservedHead: null, observationSavedAt: null } as WalletDeploymentOperation;
  const parsed = parseTransaction(rawTransaction);
  const wire = { hash: validated.hash, from: sender, to: tx.to, input: tx.data, type: "0x2", chainId: "0x2105", nonce: toHex(Number(tx.nonce)),
    gas: toHex(BigInt(tx.gas)), value: "0x0", maxFeePerGas: toHex(BigInt(tx.maxFeePerGas)), maxPriorityFeePerGas: toHex(BigInt(tx.maxPriorityFeePerGas)),
    accessList: [], r: parsed.r!, s: parsed.s!, v: toHex(parsed.yParity!), blockNumber: null as Hex | null,
    blockHash: null as Hex | null, transactionIndex: null as Hex | null };
  f.calls.length = 0;
  return { ...f, operation, wire, observe: (signal?: AbortSignal) => f.chain.observeSigned({ enrollment: f.record, operation }, signal) };
}

async function minedFixture() {
  let tx: unknown = null, receipt: Record<string, unknown> | null = null, expectedHash: Hex | null = null;
  const f = await signedFixture((method, _params, result) => method === "eth_getTransactionByHash" ? tx : method === "eth_getTransactionReceipt" ? receipt :
    method === "eth_getBlockByNumber" && expectedHash ? { ...result as object, transactions: [expectedHash] } : result);
  expectedHash = f.operation.signed!.hash;
  tx = { ...f.wire, blockNumber: "0x64", blockHash, transactionIndex: "0x0" };
  receipt = { transactionHash: expectedHash, from: sender, to: f.wire.to, blockNumber: "0x64", blockHash, transactionIndex: "0x0",
    status: "0x0", gasUsed: "0x5208", effectiveGasPrice: toHex(1_001_000_000n), logs: [] };
  const log = { address: manifest.factory.address, topics: [keccak256(stringToHex("ProxyCreation(address,address)")),
    padHex(f.record.creation!.address, { size: 32 })], data: encodeAbiParameters([{ type: "address" }], [manifest.singleton.address]),
    removed: false, transactionHash: expectedHash, blockNumber: "0x64", blockHash, transactionIndex: "0x0", logIndex: "0x0" };
  return { ...f, receipt, log };
}

describe("read-only signed deployment observation", () => {
  it("reconciles an unobserved signed hash after original approval expiry without selecting a new nonce or sending", async () => {
    let clock = now + 3; const f = await signedFixture(undefined, { now: () => clock }); clock = now + 60_000;
    const observation = await f.observe();
    expect(observation).toMatchObject({ transactionHash: f.operation.signed!.hash, templateCommitment: f.operation.templateCommitment,
      transaction: { state: "not-observed", receipt: null, nonce: { confirmed: "1", pending: "1" } },
      wallet: { state: "undeployed" }, dispatchEligible: false, fees: { executionWei: null, l1Wei: null, operatorWei: null, totalWei: null } });
    expect(f.calls.every(call => !/send|sign|estimate|anvil/i.test(call.method))).toBe(true);
  });
  it("recognizes only the exact pending signed envelope", async () => {
    let tx: unknown = null; const f = await signedFixture((method, _params, result) => method === "eth_getTransactionByHash" ? tx : result);
    tx = f.wire; expect((await f.observe()).transaction.state).toBe("pending");
  });
  it.each(["from", "nonce", "gas", "input", "r", "accessList", "pending position"])("rejects a pending provider transaction with changed %s", async field => {
    let tx: unknown = null; const f = await signedFixture((method, _params, result) => method === "eth_getTransactionByHash" ? tx : result);
    tx = { ...f.wire, ...(field === "pending position" ? { transactionIndex: "0x0" } :
      { [field]: field === "from" ? enrollmentBackupAccount.address : field === "accessList" ? "invalid" : "0x01" }) };
    expect((await f.observe()).transaction.state).toBe("unknown");
  });
  it.each(["hash", "raw", "template", "configuration"])("rejects changed stored %s identity before any provider request", async field => {
    const f = await signedFixture();
    if (field === "hash") f.operation.signed!.hash = `0x${"ab".repeat(32)}`;
    if (field === "raw") f.operation.signed!.rawTransaction = "0x02";
    if (field === "template") f.operation.template!.transaction.nonce = "2";
    if (field === "configuration") f.operation.poolConfigurationDigest = "ab".repeat(32);
    await expect(f.observe()).rejects.toThrow(); expect(f.calls).toHaveLength(0);
  });
  it("keeps canonical treasury revert, explicit finality and execution fees separate from an undeployed wallet", async () => {
    const f = await minedFixture();
    const result = await f.observe();
    expect(result).toMatchObject({ transaction: { state: "canonical-revert", receipt: { status: "reverted", gasUsed: "21000" } },
      finality: { state: "finalized" }, wallet: { state: "undeployed" }, fees: { executionWei: "21021000000000", totalWei: null }, dispatchEligible: false });
  });
  it.each(["reverted logs", "omitted intermediate log"])("rejects %s before using receipt evidence for further reads", async mutation => {
    const f = await minedFixture();
    f.receipt.logs = mutation === "reverted logs" ? [f.log] : [f.log, { ...f.log, address: sender, topics: [], data: "0x", logIndex: "0x2" }];
    if (mutation === "omitted intermediate log") f.receipt.status = "0x1";
    const result = await f.observe();
    expect(result).toMatchObject({ head: null, transaction: { state: "unknown", receipt: null }, finality: { state: "unknown" },
      wallet: { state: "unknown" }, fees: { executionWei: null } });
    expect(f.calls.some(call => call.method === "eth_getBlockByNumber" && call.params[0] === "finalized")).toBe(false);
  });
});
