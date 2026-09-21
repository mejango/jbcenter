import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  decodeFunctionData, encodeFunctionResult, getAddress, hashTypedData, keccak256, parseAbi,
  stringToHex, zeroAddress, zeroHash, type Abi, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createRestApp, type RestDependencies } from "../src/rest/app.js";
import { REST_LIMITS } from "../src/rest/http.js";
import { createSmartAccountService, MemorySmartAccountRegistry, type SmartAccountManifest } from "../src/rest/smartAccounts/index.js";
import {
  onboardingProofDocument, type OnboardingFinalizationInput, type OnboardingInput, type OnboardingResult,
} from "../src/rest/smartAccounts/onboarding.js";
import type { ModuleStateEvidence } from "../src/rest/smartAccounts/types.js";

const owner = privateKeyToAccount(`0x${"11".repeat(32)}`);
const browser = privateKeyToAccount(`0x${"22".repeat(32)}`);
const other = privateKeyToAccount(`0x${"33".repeat(32)}`);
const wallet = "0x8000000000000000000000000000000000000000" as const;
const alternateWallet = "0x9000000000000000000000000000000000000000" as const;
const runtime = "0x60016000" as const;
const codeHash = keccak256(runtime);
const time = 1_800_000_000;
const blockHash = `0x${"ab".repeat(32)}` as Hex;
const nonce = `0x${"cd".repeat(32)}` as Hex;
const initializerHash = `0x${"ef".repeat(32)}` as Hex;
const accountId = `eip155:8453:${owner.address.toLowerCase()}`;
const abi = parseAbi([
  "function VERSION() view returns (string)", "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)", "function nonce() view returns (uint256)",
  "function getModulesPaginated(address,uint256) view returns (address[],address)",
]);
const pin = (n: number) => ({ address: getAddress(`0x${n.toString(16).padStart(40, "0")}`), runtimeCodeHash: codeHash,
  source: { repository: "https://github.com/example/fixture", commit: "a".repeat(40), artifactSha256: "b".repeat(64) } });
const manifest: SmartAccountManifest = {
  id: "fixture-base-safe", mode: "execution-candidate", chainId: 8453, revision: zeroHash,
  safeVersion: "1.4.1", proxyRuntimeCodeHash: codeHash, singleton: pin(10), factory: pin(11), safe7579: pin(12),
  launchpad: pin(13), entryPoint: { ...pin(14), version: "0.7" }, smartSessions: { ...pin(15), generation: "emissary" },
  policies: [pin(16)], moduleInspectorId: "fixture-canonical-inspector",
};
const input: OnboardingInput = {
  owner: owner.address, address: wallet, manifestId: manifest.id, nonce, issuedAt: time, expiresAt: time + 300,
  grant: { id: "550e8400-e29b-41d4-a716-446655440000", botAddress: browser.address,
    scopes: ["read", "plan", "relay"], expiresAt: time + 3600, label: "Beep checkout" },
};
const slot = (address: Address) => `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;

function fixture(options: { chainId?: number; inspector?: boolean; audience?: string; configured?: boolean } = {}) {
  const chosenManifest = { ...manifest, chainId: options.chainId ?? 8453 };
  const state = {
    now: time, blockTimestamp: time, owners: [owner.address] as Address[], threshold: 1, safeNonce: 0n,
    moduleList: [manifest.safe7579.address] as Address[], contractOwner: false, badRuntime: null as Address | null,
    proof: { stateHash: zeroHash, complete: true, arbitrarySigningDisabled: true, wildcardExecutionDisabled: true,
      details: { sessions: { permissionIds: [] }, provenance: { initializerHash } } } as ModuleStateEvidence,
    afterInspect: () => {},
  };
  const request = vi.fn(async (chainId: number, method: string, params: readonly unknown[], signal?: AbortSignal) => {
    signal?.throwIfAborted();
    expect(chainId).toBe(chosenManifest.chainId);
    if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
    if (method === "eth_getBlockByNumber") return { number: "0x64", hash: blockHash, timestamp: `0x${state.blockTimestamp.toString(16)}` };
    expect(params.at(-1)).toEqual({ blockHash, requireCanonical: true });
    if (method === "eth_getCode") {
      if (state.owners.some((address) => address.toLowerCase() === String(params[0]).toLowerCase()))
        return state.contractOwner ? runtime : "0x";
      return state.badRuntime?.toLowerCase() === String(params[0]).toLowerCase() ? "0x6000" : runtime;
    }
    if (method === "eth_getStorageAt") {
      if (params[1] === zeroHash) return slot(manifest.singleton.address);
      if (params[1] === keccak256(stringToHex("fallback_manager.handler.address"))) return slot(manifest.safe7579.address);
      if (params[1] === keccak256(stringToHex("guard_manager.guard.address"))) return slot(zeroAddress);
    }
    if (method === "eth_call") {
      const decoded = decodeFunctionData({ abi: abi as Abi, data: (params[0] as { data: Hex }).data });
      const result = decoded.functionName === "VERSION" ? "1.4.1" : decoded.functionName === "getOwners" ? state.owners
        : decoded.functionName === "getThreshold" ? BigInt(state.threshold) : decoded.functionName === "nonce" ? state.safeNonce
          : [state.moduleList, "0x0000000000000000000000000000000000000001"];
      return encodeFunctionResult({ abi: abi as Abi, functionName: decoded.functionName, result });
    }
    throw new Error(`Unexpected RPC method ${method}`);
  });
  const registry = new MemorySmartAccountRegistry();
  const registryBind = vi.spyOn(registry, "bind");
  const finalize = vi.fn(async (record: OnboardingResult) => structuredClone(record));
  const inspect = vi.fn(async () => { state.afterInspect(); return structuredClone(state.proof); });
  const service = createSmartAccountService({ rpc: { request }, manifests: [chosenManifest], registry,
    audience: options.audience ?? "https://center.example", now: () => state.now * 1000,
    ...(options.configured === false ? {} : { onboarding: { finalize } }),
    ...(options.inspector === false ? {} : { moduleInspectors: [{ id: manifest.moduleInspectorId, inspect }] }),
  });
  async function signed(value = input): Promise<OnboardingFinalizationInput> {
    const challenge = await service.onboardingChallenge(value);
    return { ...structuredClone(value), manifestRevision: challenge.state.manifestRevision,
      initializerHash: challenge.typedData.message.initializerHash, stateHash: challenge.state.stateHash,
      signature: await owner.signTypedData(challenge.typedData),
      proofSignature: await browser.signTypedData(onboardingProofDocument(challenge.typedData)) };
  }
  return { service, registry, registryBind, request, finalize, inspect, state, signed };
}

describe("purpose-signed account onboarding", () => {
  it("previews canonical state without enrolling, binding, consuming a nonce or granting authority", async () => {
    const test = fixture();
    const first = await test.service.onboardingChallenge(input);
    const second = await test.service.onboardingChallenge(input);
    expect(first.digest).toBe(hashTypedData(first.typedData));
    expect(second.digest).toBe(first.digest);
    expect(first.typedData).toMatchObject({ primaryType: "SetupAccount", domain: { chainId: 8453, verifyingContract: wallet },
      message: { accountId, owner: owner.address, grantId: input.grant.id, botAddress: browser.address,
        scopes: ["read", "plan", "relay"], grantExpiresAt: BigInt(time + 3600), initializerHash } });
    expect(first.state.executionVerified).toBe(false);
    expect(await test.registry.list(accountId)).toEqual([]);
    expect(test.registryBind).not.toHaveBeenCalled();
    expect(test.finalize).not.toHaveBeenCalled();
    expect(test.request.mock.calls.length).toBeLessThan(64);
    expect(test.request.mock.calls.some(([, method]) => method === "eth_getLogs" || method.startsWith("eth_send"))).toBe(false);
  });

  it("commits one coherent account, exact binding and browser grant only after both proofs verify", async () => {
    const test = fixture();
    const payload = await test.signed();
    expect(test.finalize).not.toHaveBeenCalled();
    const result = await test.service.finalizeOnboarding(payload);
    expect(test.finalize).toHaveBeenCalledExactlyOnceWith(result);
    expect(result).toMatchObject({
      account: { id: accountId, ownerAddress: owner.address, authorityChainId: 8453 },
      binding: { ownerAccountId: accountId, wallet: { chainId: 8453, address: wallet },
        authorization: { method: "safe-current-owner-threshold-and-api-grant", nonce, expiresAt: input.expiresAt,
          setup: { manifestRevision: manifest.revision, initializerHash, issuedAt: time, grantId: input.grant.id,
            botAddress: browser.address, scopes: input.grant.scopes, grantExpiresAt: input.grant.expiresAt, label: input.grant.label } } },
      grant: { ...input.grant, accountId, createdAt: time, revokedAt: null },
    });
    expect(result.grant).not.toHaveProperty("privateKey");
    expect(result.binding).not.toHaveProperty("signature");
    expect(test.registryBind).not.toHaveBeenCalled();
  });

  it("rejects substitution of every signed setup field without invoking the atomic store", async () => {
    const test = fixture();
    const payload = await test.signed();
    const substitutions = [
      { address: alternateWallet }, { owner: other.address }, { nonce: initializerHash },
      { issuedAt: time - 1, expiresAt: time + 299, grant: { ...payload.grant, expiresAt: time + 3599 } },
      { expiresAt: time + 299 }, { manifestRevision: initializerHash }, { initializerHash: nonce }, { stateHash: nonce },
      ...[{ id: "550e8400-e29b-41d4-a716-446655440001" }, { botAddress: other.address },
        { expiresAt: time + 3599 }, { label: "Another checkout" }, { scopes: ["read", "plan"] }]
        .map((grant) => ({ grant: { ...payload.grant, ...grant } })),
    ];
    for (const change of substitutions) await expect(test.service.finalizeOnboarding({ ...payload, ...change })).rejects.toBeInstanceOf(Error);
    expect(test.finalize).not.toHaveBeenCalled();
  });

  it("requires a distinct browser proof over the exact setup digest and audience", async () => {
    const test = fixture();
    const payload = await test.signed();
    const challenge = await test.service.onboardingChallenge(input);
    const invalidProofs = [
      { signature: await other.signTypedData(challenge.typedData) },
      { proofSignature: await other.signTypedData(onboardingProofDocument(challenge.typedData)) },
      { proofSignature: await owner.signTypedData(onboardingProofDocument(challenge.typedData)) },
      { proofSignature: await browser.signTypedData(challenge.typedData) },
      { proofSignature: (await test.signed({ ...input, nonce: initializerHash })).proofSignature },
      { signature: (await fixture({ audience: "https://another-center.example" }).signed()).signature },
      { signature: await owner.signMessage({ message: { raw: challenge.digest } }) },
    ];
    for (const change of invalidProofs)
      await expect(test.service.finalizeOnboarding({ ...payload, ...change })).rejects.toMatchObject({ code: "SMART_ONBOARDING_INVALID", status: 403 });
    expect(test.finalize).not.toHaveBeenCalled();
  });

  it("refuses changed canonical state even when the original signatures remain valid", async () => {
    const test = fixture();
    const payload = await test.signed();
    test.state.proof.stateHash = nonce;
    await expect(test.service.finalizeOnboarding(payload)).rejects.toMatchObject({ code: "SMART_ACCOUNT_CHANGED", status: 409 });
    expect(test.finalize).not.toHaveBeenCalled();
  });

  it("requires a sole EOA owner, complete module evidence, and no spending sessions on Base", async () => {
    for (const kind of ["non-owner", "co-owner", "contract-owner", "safe-module", "session", "unknown-sessions", "missing-provenance", "incomplete"] as const) {
      const test = fixture();
      const payload = await test.signed();
      if (kind === "non-owner") test.state.owners = [other.address];
      if (kind === "co-owner") test.state.owners.push(other.address);
      if (kind === "contract-owner") test.state.contractOwner = true;
      if (kind === "safe-module") test.state.moduleList.push(other.address);
      if (kind === "session") test.state.proof.details = { sessions: { permissionIds: [nonce] }, provenance: { initializerHash } };
      if (kind === "unknown-sessions") test.state.proof.details = { provenance: { initializerHash } };
      if (kind === "missing-provenance") test.state.proof.details = { sessions: { permissionIds: [] } };
      if (kind === "incomplete") test.state.proof = { ...test.state.proof, complete: false } as unknown as ModuleStateEvidence;
      await expect(test.service.finalizeOnboarding(payload), kind).rejects.toBeInstanceOf(Error);
      expect(test.finalize, kind).not.toHaveBeenCalled();
    }
    for (const options of [{ chainId: 1 }, { inspector: false }, { configured: false }]) {
      const test = fixture(options);
      await expect(test.service.onboardingChallenge(input)).rejects.toBeInstanceOf(Error);
      expect(test.finalize).not.toHaveBeenCalled();
    }
  });

  it("rechecks every pinned dependency before granting API access", async () => {
    for (const dependency of [wallet, manifest.factory.address, manifest.entryPoint!.address, manifest.launchpad.address, manifest.policies[0]!.address]) {
      const test = fixture();
      const payload = await test.signed();
      test.state.badRuntime = dependency;
      await expect(test.service.finalizeOnboarding(payload)).rejects.toMatchObject({ code: "SMART_RUNTIME_MISMATCH" });
      expect(test.finalize).not.toHaveBeenCalled();
    }
  });

  it("rejects invalid authority and time bounds before any canonical read", async () => {
    const test = fixture();
    const malformed = [
      { nonce: zeroHash }, { owner: zeroAddress }, { address: owner.address }, { manifestId: "x".repeat(193) },
      { issuedAt: time + 31 }, { expiresAt: time }, { expiresAt: time + 301 }, { issuedAt: time + 0.5 },
      { grant: { ...input.grant, expiresAt: time + 3601 } }, { grant: { ...input.grant, expiresAt: input.expiresAt } },
      { grant: { ...input.grant, id: "550e8400-e29b-11d4-a716-446655440000" } },
      { grant: { ...input.grant, botAddress: owner.address } }, { grant: { ...input.grant, botAddress: wallet } },
      { grant: { ...input.grant, scopes: ["relay", "plan", "read"] } }, { grant: { ...input.grant, scopes: ["read", "plan", "relay", "relay"] } },
      { grant: { ...input.grant, label: "a\nb" } }, { grant: { ...input.grant, label: "é".repeat(61) } },
      { grant: { ...input.grant, sessionKey: browser.address } }, { rpcUrl: "https://attacker.example" },
    ];
    for (const change of malformed) await expect(test.service.onboardingChallenge({ ...input, ...change })).rejects.toBeInstanceOf(Error);
    expect(test.request).not.toHaveBeenCalled();
    expect(test.finalize).not.toHaveBeenCalled();
    expect(await test.service.onboardingChallenge({ ...input, issuedAt: time + 30 })).toHaveProperty("digest");
  });

  it("refuses stale or implausibly future canonical observations on both setup routes", async () => {
    for (const timestamp of [time - 301, time + 31]) {
      const test = fixture();
      const payload = await test.signed();
      test.state.blockTimestamp = timestamp;
      await expect(test.service.onboardingChallenge(input)).rejects.toMatchObject({ code: "SMART_EVIDENCE_STALE", status: 409 });
      await expect(test.service.finalizeOnboarding(payload)).rejects.toMatchObject({ code: "SMART_EVIDENCE_STALE", status: 409 });
      expect(test.finalize).not.toHaveBeenCalled();
    }
    for (const timestamp of [time - 300, time + 30]) {
      const test = fixture();
      test.state.blockTimestamp = timestamp;
      await expect(test.service.onboardingChallenge(input)).resolves.toHaveProperty("digest");
    }
  });

  it("accepts the last live second but rejects expiry reached during canonical inspection", async () => {
    const test = fixture();
    const payload = await test.signed();
    test.state.now = input.expiresAt - 1;
    await expect(test.service.finalizeOnboarding(payload)).resolves.toHaveProperty("grant.id", input.grant.id);
    test.finalize.mockClear();
    test.state.afterInspect = () => { test.state.now = input.expiresAt; };
    await expect(test.service.finalizeOnboarding(payload)).rejects.toMatchObject({ code: "SMART_ONBOARDING_INVALID" });
    expect(test.finalize).not.toHaveBeenCalled();
    test.state.now = input.expiresAt - 1;
    await expect(test.service.onboardingChallenge(input)).rejects.toMatchObject({ code: "SMART_ONBOARDING_INVALID" });
  });

  it("does not commit when the request is cancelled during the last canonical observation", async () => {
    const test = fixture();
    const payload = await test.signed();
    const controller = new AbortController();
    test.state.afterInspect = () => controller.abort();
    await expect(test.service.finalizeOnboarding(payload, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(test.finalize).not.toHaveBeenCalled();
    const previewController = new AbortController();
    test.state.afterInspect = () => previewController.abort();
    await expect(test.service.onboardingChallenge(input, previewController.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("onboarding HTTP admission", () => {
  function appFixture(denied = false) {
    const test = fixture();
    const authenticate = vi.fn(async () => { throw new Error("Setup must use its own exact proof, without a generic owner REST signature"); });
    const quota = vi.fn(async () => ({ allowed: !denied, remaining: 10 }));
    const app = new Hono().route("/api/v1", createRestApp({ auth: { authenticate }, quota: { consumeRequest: quota },
      operations: { list: () => [] }, smartAccounts: test.service } as unknown as RestDependencies));
    const post = (route: string, body: unknown, headers: Record<string, string> = {}) => app.request(`/api/v1/smart-accounts/${route}`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    });
    return { ...test, app, post, authenticate, quota };
  }

  it("previews publicly, then verifies both body proofs and returns the exact committed records", async () => {
    const test = appFixture();
    const preview = await test.post("onboarding-challenges", input);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("cache-control")).toBe("no-store");
    expect(await preview.json()).toMatchObject({ typedData: { message: { issuedAt: String(time), expiresAt: String(input.expiresAt) } } });
    expect(test.finalize).not.toHaveBeenCalled();
    const payload = await test.signed();
    const bad = await test.post("onboarding", { ...payload, proofSignature: payload.signature });
    expect(bad.status).toBe(403);
    expect(await bad.json()).toMatchObject({ code: "SMART_ONBOARDING_INVALID" });
    expect(test.finalize).not.toHaveBeenCalled();
    const completed = await test.post("onboarding", payload);
    expect(completed.status).toBe(201);
    expect(await completed.json()).toMatchObject({ account: { id: accountId }, grant: { id: input.grant.id },
      binding: { authorization: { method: "safe-current-owner-threshold-and-api-grant" } } });
    expect(test.finalize).toHaveBeenCalledOnce();
    expect(test.authenticate).not.toHaveBeenCalled();
  });

  it("applies site admission and request shape limits before RPC or authority writes", async () => {
    const denied = appFixture(true);
    expect((await denied.post("onboarding-challenges", input)).status).toBe(429);
    expect(denied.request).not.toHaveBeenCalled();
    expect(denied.quota).toHaveBeenCalledWith("rest:site", REST_LIMITS.siteRequestsPerMinute, 60);
    const test = appFixture();
    for (const route of ["onboarding-challenges", "onboarding"]) {
      expect((await test.post(`${route}?owner=arbitrary`, input)).status).toBe(400);
      expect((await test.post(route, input, { "content-type": "text/plain" })).status).toBe(415);
      expect((await test.post(route, input, { "content-encoding": "gzip" })).status).toBe(415);
      expect((await test.post(route, input, { "content-length": String(REST_LIMITS.bodyBytes + 1) })).status).toBe(413);
      expect((await test.post(route, { ...input, manifests: [manifest] })).status).toBe(400);
    }
    expect(test.request).not.toHaveBeenCalled();
    expect(test.finalize).not.toHaveBeenCalled();
  });
});
