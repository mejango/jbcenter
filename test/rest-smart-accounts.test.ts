import { describe, expect, it, vi } from "vitest";
import {
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
  keccak256,
  parseAbi,
  stringToHex,
  zeroAddress,
  zeroHash,
  type Address,
  type Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Hono } from "hono";
import { createRestApp, type RestDependencies } from "../src/rest/app.js";
import {
  createSessionPolicyReviewer,
  createSmartAccountService,
  MemorySmartAccountRegistry,
  type SmartAccountManifest,
  CHECKED_SMART_ACCOUNT_BINDING_MANIFESTS,
} from "../src/rest/smartAccounts/index.js";
import type { BotGrant, RestPrincipal } from "../src/rest/auth/store.js";
import type { RestBlockEvidence } from "../src/rest/core.js";

const owner = privateKeyToAccount(`0x${"11".repeat(32)}`);
const coowner = privateKeyToAccount(`0x${"22".repeat(32)}`);
const bot = privateKeyToAccount(`0x${"33".repeat(32)}`);
const wallet = "0x8000000000000000000000000000000000000000" as const;
const asset = "0x9000000000000000000000000000000000000000" as const;
const recipient = "0xa000000000000000000000000000000000000000" as const;
const runtime = "0x60016000" as const;
const codeHash = keccak256(runtime);
let time = 1800000000;
const blockHash = `0x${"ab".repeat(32)}` as Hex;
const moduleAbi = parseAbi([
  "function getValidatorsPaginated(address cursor,uint256 pageSize) view returns(address[] array,address next)",
  "function getExecutorsPaginated(address cursor,uint256 pageSize) view returns(address[] array,address next)",
  "function getActiveHook() view returns(address)",
  "function getPrevalidationHook(uint256 moduleType) view returns(address)",
]);
const nonce = `0x${"cd".repeat(32)}` as Hex;
const principal: RestPrincipal = {
  principalId: `owner:eip155:1:${owner.address.toLowerCase()}`,
  account: {
    id: `eip155:1:${owner.address.toLowerCase()}`,
    ownerAddress: owner.address,
    authorityChainId: 1,
    createdAt: time,
    updatedAt: time,
    profile: { displayName: "fixture", bio: "", avatarUri: null },
  },
  signer: owner.address,
  grantId: null,
  scopes: ["read", "plan", "relay"],
  isOwner: true,
  requestNonce: nonce,
  idempotencyKey: null,
};
const grant: BotGrant = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  accountId: principal.account.id,
  botAddress: bot.address,
  scopes: ["read", "plan", "relay"],
  label: "fixture",
  createdAt: time,
  expiresAt: time + 40 * 86400,
  revokedAt: null,
};
const abi = parseAbi([
  "function VERSION() view returns (string)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function getModulesPaginated(address,uint256) view returns (address[],address)",
]);
const pin = (n: number) => ({
  address: getAddress(`0x${n.toString(16).padStart(40, "0")}`),
  runtimeCodeHash: codeHash,
  source: {
    repository: "https://github.com/example/fixture",
    commit: "a".repeat(40),
    artifactSha256: "b".repeat(64),
  },
});
const manifest: SmartAccountManifest = {
  id: "fixture-safe",
  mode: "execution-candidate",
  chainId: 1,
  revision: zeroHash,
  safeVersion: "1.4.1",
  proxyRuntimeCodeHash: codeHash,
  singleton: pin(10),
  factory: pin(11),
  safe7579: pin(12),
  launchpad: pin(13),
  entryPoint: { ...pin(14), version: "0.7" },
  smartSessions: { ...pin(15), generation: "emissary" },
  policies: [pin(16)],
  moduleInspectorId: "fixture-pinned-inspector",
};
const asSlot = (address: Address) =>
  `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
function fixture(
  options: {
    threshold?: number;
    modules?: Address[];
    runtimeMismatch?: boolean;
    wrongChain?: boolean;
    inspector?: boolean;
    guard?: Address;
    contractOwner?: boolean;
    /** Extra canonical blocks by number (hex) beside the fixture's 0x64; the last one is the head. */
    blocks?: Record<string, Hex>;
    logs?: (filter: { address?: string; fromBlock?: string; toBlock?: string; topics?: unknown[] }) => unknown[];
    validators?: Address[];
  } = {},
) {
  const state = {
    owners: [owner.address, coowner.address],
    threshold: options.threshold ?? 1,
  };
  const request = vi.fn(
    async (_chainId: number, method: string, params: readonly unknown[]) => {
      if (method === "eth_chainId") return options.wrongChain ? "0xa" : "0x1";
      const blocks: Record<string, Hex> = { "0x64": blockHash, ...(options.blocks ?? {}) };
      const head = Object.keys(blocks).at(-1)!;
      if (method === "eth_blockNumber") return head;
      if (method === "eth_getBlockByNumber") {
        const number = params[0] === "latest" ? head : String(params[0]);
        if (!blocks[number]) return null;
        return { number, hash: blocks[number], timestamp: `0x${time.toString(16)}` };
      }
      if (method === "eth_getLogs") return options.logs?.(params[0] as never) ?? [];
      expect(Object.values(blocks)).toContain((params.at(-1) as { blockHash: Hex }).blockHash);
      expect((params.at(-1) as { requireCanonical: boolean }).requireCanonical).toBe(true);
      if (method === "eth_call" && String((params[0] as { to: string }).to).toLowerCase() === manifest.safe7579.address.toLowerCase()) {
        const decoded = decodeFunctionData({ abi: moduleAbi, data: (params[0] as { data: Hex }).data });
        const result = decoded.functionName === "getValidatorsPaginated" ? [options.validators ?? [manifest.smartSessions.address], "0x0000000000000000000000000000000000000001"]
          : decoded.functionName === "getExecutorsPaginated" ? [[], "0x0000000000000000000000000000000000000001"] : zeroAddress;
        return encodeFunctionResult({ abi: moduleAbi, functionName: decoded.functionName, result: result as never });
      }
      if (method === "eth_getCode")
        return state.owners.some(
          (a) => a.toLowerCase() === String(params[0]).toLowerCase(),
        )
          ? options.contractOwner
            ? runtime
            : "0x"
          : options.runtimeMismatch
            ? "0x6000"
            : runtime;
      if (method === "eth_getStorageAt") {
        const slot = params[1];
        if (slot === zeroHash) return asSlot(manifest.singleton.address);
        if (slot === keccak256(stringToHex("fallback_manager.handler.address")))
          return asSlot(manifest.safe7579.address);
        if (slot === keccak256(stringToHex("guard_manager.guard.address")))
          return asSlot(options.guard ?? zeroAddress);
      }
      if (method === "eth_call") {
        const decoded = decodeFunctionData({
          abi: abi as Abi,
          data: (params[0] as { data: Hex }).data,
        });
        const result =
          decoded.functionName === "VERSION"
            ? "1.4.1"
            : decoded.functionName === "getOwners"
              ? state.owners
              : decoded.functionName === "getThreshold"
                ? BigInt(state.threshold)
                : decoded.functionName === "nonce"
                  ? 2n
                  : [
                      options.modules ?? [manifest.safe7579.address],
                      "0x0000000000000000000000000000000000000001",
                    ];
        return encodeFunctionResult({
          abi: abi as Abi,
          functionName: decoded.functionName,
          result,
        });
      }
      throw new Error(`Unexpected ${method}`);
    },
  );
  const registry = new MemorySmartAccountRegistry();
  const inspections: (AbortSignal | null)[] = [];
  const service = createSmartAccountService({
    rpc: { request },
    manifests: [manifest],
    registry,
    audience: "https://center.example",
    now: () => time * 1000,
    ...(options.inspector
      ? {
          moduleInspectors: [
            {
              id: manifest.moduleInspectorId,
              inspect: async (input: { signal?: AbortSignal }) => {
                inspections.push(input.signal ?? null);
                await new Promise((resolve) => setTimeout(resolve, 20));
                return {
                  stateHash: zeroHash,
                  complete: true as const,
                  arbitrarySigningDisabled: true as const,
                  wildcardExecutionDisabled: true as const,
                  details: { fixture: true },
                };
              },
            },
          ],
        }
      : {}),
  });
  async function bind() {
    const input = {
      manifestId: manifest.id,
      address: wallet,
      nonce,
      expiresAt: time + 600,
    };
    const challenge = await service.challenge(principal, input);
    const signers =
      state.threshold === 1
        ? [owner]
        : [owner, coowner].sort((a, b) =>
            BigInt(a.address) < BigInt(b.address) ? -1 : 1,
          );
    const signature =
      `0x${(await Promise.all(signers.map((signer) => signer.signTypedData(challenge.typedData)))).map((sig) => sig.slice(2)).join("")}` as Hex;
    const payload = {
      ...input,
      stateHash: challenge.state.stateHash,
      signature,
    };
    return { record: await service.bind(principal, payload), payload };
  }
  return { service, registry, request, state, bind, inspections, options };
}
describe("smart account ownership and module boundaries", () => {
  it("retains exact older manifest bindings when new creation defaults are introduced", async () => {
    const original = fixture();
    const { record } = await original.bind();
    const next = {
      ...manifest,
      id: "new-default",
      revision: keccak256(stringToHex("new-default")),
    };
    const upgraded = createSmartAccountService({
      rpc: { request: original.request },
      registry: original.registry,
      manifests: [next],
      retainedManifests: [manifest],
      audience: "https://center.example",
      now: () => time * 1000,
    });
    expect(
      (await upgraded.capabilities()).deployments.map((d) => d.manifestId),
    ).toEqual([next.id]);
    expect(
      await upgraded.current(principal.account.id, record.id),
    ).toMatchObject({
      id: record.id,
      manifestId: manifest.id,
      state: { stateHash: record.state.stateHash },
    });
    await expect(
      createSmartAccountService({
        rpc: { request: original.request },
        registry: original.registry,
        manifests: [next],
        audience: "https://center.example",
        now: () => time * 1000,
      }).current(principal.account.id, record.id),
    ).rejects.toMatchObject({ code: "SMART_MANIFEST_UNAVAILABLE" });
  });
  it("provides a checked Sepolia ownership-only manifest without inventing EntryPoint readiness", async () => {
    const request = vi.fn(async () => {
      throw new Error("No RPC expected");
    });
    const service = createSmartAccountService({
      rpc: { request },
      manifests: CHECKED_SMART_ACCOUNT_BINDING_MANIFESTS,
      registry: new MemorySmartAccountRegistry(),
      audience: "https://center.example",
    });
    expect((await service.capabilities()).deployments[0]).toMatchObject({
      chainId: 11155111,
      mode: "ownership-only",
      entryPointSourceVerified: false,
    });
    expect(
      await service.bundlerReadiness(
        CHECKED_SMART_ACCOUNT_BINDING_MANIFESTS[0]!.id,
      ),
    ).toMatchObject({
      ready: false,
      reason: "source-verified-entrypoint-required",
    });
    expect(request).not.toHaveBeenCalled();
  });
  it("pins all account and dependency reads to a canonical block while distinguishing incomplete module proof", async () => {
    const test = fixture();
    const state = await test.service.inspect({
      manifestId: manifest.id,
      address: wallet,
    });
    expect(state).toMatchObject({
      address: wallet,
      owners: [owner.address, coowner.address],
      threshold: 1,
      executionVerified: false,
      modules: null,
      evidence: { blockHash },
    });
    expect(state.codeHashes).toHaveLength(8);
    const complete = await fixture({ inspector: true }).service.inspect({
      manifestId: manifest.id,
      address: wallet,
    });
    expect(complete.moduleConfigurationVerified).toBe(true);
    expect(complete.executionVerified).toBe(false);
  });
  it.each([
    { wrongChain: true },
    { runtimeMismatch: true },
    { modules: [manifest.safe7579.address, pin(17).address] },
    { guard: pin(18).address },
    { contractOwner: true },
  ])(
    "rejects mismatched chain/code, extra modules, guards and unsupported owner implementations: %j",
    async (options) => {
      await expect(
        fixture(options).service.inspect({
          manifestId: manifest.id,
          address: wallet,
        }),
      ).rejects.toBeInstanceOf(Error);
    },
  );
  it("serves an opted-in read from the last verification for its window, while every other read hits the chain", async () => {
    const started = time;
    try {
      const test = fixture({ inspector: true });
      const read = (at?: RestBlockEvidence, reuse = true) =>
        test.service.inspect({ manifestId: manifest.id, address: wallet }, undefined, at, reuse);
      const first = await read();
      const reads = test.request.mock.calls.length;
      // The same account, whether at the latest head or at the very block already verified.
      const again = await read();
      const pinned = await read(first.evidence);
      expect([again, pinned]).toEqual([first, first]);
      expect(test.inspections).toHaveLength(1);
      expect(test.request.mock.calls.length).toBe(reads);
      // A caller may not mutate the shared copy.
      again.owners.push(wallet);
      expect((await read()).owners).toEqual(first.owners);
      // A read that did not opt in (onboarding, authority, dispatch) verifies afresh and refreshes the entry.
      await read(undefined, false);
      expect(test.inspections).toHaveLength(2);
      // Another service instance never shares the entry, unless it is handed a verified state
      // (the wallet authority refresh does this); a state for an unknown manifest revision is ignored.
      const other = fixture({ inspector: true });
      other.service.remember({ ...first, manifestRevision: `0x${"ff".repeat(32)}` as Hex });
      other.service.remember(first);
      expect(await other.service.inspect({ manifestId: manifest.id, address: wallet }, undefined, undefined, true)).toEqual(first);
      expect(other.inspections).toHaveLength(0);
      // A verification at an older block (a historical check for a receipt) never replaces a newer entry.
      const older = { ...first, evidence: { ...first.evidence, blockNumber: "1", blockHash: `0x${"0a".repeat(32)}` as Hex, timestamp: String(time - 3000) } };
      test.service.remember(older);
      expect((await read()).evidence.blockHash).toBe(first.evidence.blockHash);
      // Past the window an opted-in read still answers from the last verification, and the chain is
      // read again behind it; the next read finds the new state. A read that fails behind the
      // answer forgets the entry, so the read after it waits on the chain and sees the failure.
      time += 901;
      expect(await read()).toEqual(first);
      await vi.waitFor(async () => expect((await read()).evidence.timestamp).toBe(String(time)));
      expect(test.inspections).toHaveLength(3);
      time += 901;
      test.options.runtimeMismatch = true;
      const calls = test.request.mock.calls.length;
      expect((await read()).evidence.timestamp).toBe(String(time - 901));
      await vi.waitFor(() => expect(test.request.mock.calls.length).toBeGreaterThan(calls));
      await new Promise((resolve) => setTimeout(resolve, 50));
      await expect(read()).rejects.toMatchObject({ code: "SMART_RUNTIME_MISMATCH" });
    } finally {
      time = started;
    }
  });
  it("carries a verified state to a pinned block across an empty authority gap, and inspects afresh otherwise", async () => {
    const later = `0x${"ba".repeat(32)}` as Hex, at = { chainId: 1, blockNumber: "110", blockHash: later, timestamp: String(time), source: "onchain" as const };
    const filters: unknown[] = [];
    const test = fixture({ inspector: true, logs: (filter) => { filters.push(filter); return []; } });
    const read = (evidence?: RestBlockEvidence) => test.service.inspect({ manifestId: manifest.id, address: wallet }, undefined, evidence, true);
    const first = await read();
    expect(test.inspections).toHaveLength(1);
    test.options.blocks = { "0x6e": later };
    // Ten blocks on: the three ingress streams over (100, 110] are empty and the authority fields
    // read at 110 equal the verified ones, so the state is the same state at the new block.
    const carried = await read(at);
    expect(test.inspections).toHaveLength(1);
    expect(carried.stateHash).toBe(first.stateHash);
    expect(carried.evidence).toEqual(at);
    expect(filters.map((f) => (f as { fromBlock: string; toBlock: string }).fromBlock + "-" + (f as { toBlock: string }).toBlock)).toEqual(["0x65-0x6e", "0x65-0x6e", "0x65-0x6e"]);
    // The carried state serves the next pinned read at that block without any read at all.
    const reads = test.request.mock.calls.length;
    expect(await read(at)).toEqual(carried);
    expect(test.request.mock.calls.length).toBe(reads);
    // A log in the gap, a changed owner set, or a foreign validator each mean a full inspection.
    for (const change of ["log", "owners", "validator"] as const) {
      const changed = fixture({ inspector: true,
        ...(change === "log" ? { logs: () => [{ blockNumber: "0x66" }] } : {}),
        ...(change === "validator" ? { validators: [recipient] } : {}) });
      await changed.service.inspect({ manifestId: manifest.id, address: wallet }, undefined, undefined, true);
      changed.options.blocks = { "0x6e": later };
      if (change === "owners") changed.state.owners = [owner.address];
      await changed.service.inspect({ manifestId: manifest.id, address: wallet }, undefined, at, true);
      expect(changed.inspections.length, change).toBe(2);
    }
    // A node behind the gap, or an origin block no longer canonical, means a full inspection.
    for (const doubt of ["head", "origin"] as const) {
      const doubted = fixture({ inspector: true });
      await doubted.service.inspect({ manifestId: manifest.id, address: wallet }, undefined, undefined, true);
      doubted.options.blocks = { "0x6e": later };
      const rpc = doubted.request.getMockImplementation()!;
      doubted.request.mockImplementation(async (chainId, method, params) => {
        if (doubt === "head" && method === "eth_blockNumber") return "0x66";
        if (doubt === "origin" && method === "eth_getBlockByNumber" && params[0] === "0x64") return { number: "0x64", hash: `0x${"dd".repeat(32)}`, timestamp: `0x${time.toString(16)}` };
        return rpc(chainId, method, params);
      });
      await doubted.service.inspect({ manifestId: manifest.id, address: wallet }, undefined, at, true);
      expect(doubted.inspections.length, doubt).toBe(2);
    }
    // A later full verification at a lower block replaces a carried entry; a carried state never
    // displaces a newer full one.
    {
      const chain = fixture({ inspector: true });
      const full = await chain.service.inspect({ manifestId: manifest.id, address: wallet }, undefined, undefined, true);
      chain.options.blocks = { "0x6e": later };
      const carried = await chain.service.inspect({ manifestId: manifest.id, address: wallet }, undefined, at, true);
      expect(carried.evidence.blockNumber).toBe("110");
      chain.service.remember(full);
      expect((await chain.service.inspect({ manifestId: manifest.id, address: wallet }, undefined, undefined, true)).evidence.blockNumber).toBe("100");
      chain.options.blocks = { "0x6e": later, "0x78": `0x${"ee".repeat(32)}` as Hex };
      const fresh = await chain.service.inspect({ manifestId: manifest.id, address: wallet }, undefined, undefined, false);
      expect(fresh.evidence.blockNumber).toBe("120");
      const older = await chain.service.inspect({ manifestId: manifest.id, address: wallet }, undefined, at, true);
      expect(older.evidence.blockNumber).toBe("110");
      expect((await chain.service.inspect({ manifestId: manifest.id, address: wallet }, undefined, undefined, true)).evidence.blockNumber).toBe("120");
      expect(chain.inspections).toHaveLength(2);
    }
    // A verified state can only be carried within two thousand blocks of its full verification.
    const far = fixture({ inspector: true });
    await far.service.inspect({ manifestId: manifest.id, address: wallet }, undefined, undefined, true);
    far.options.blocks = { "0x8ca": `0x${"cc".repeat(32)}` as Hex };
    await far.service.inspect({ manifestId: manifest.id, address: wallet }, undefined, { ...at, blockNumber: "2250", blockHash: `0x${"cc".repeat(32)}` as Hex }, true);
    expect(far.inspections).toHaveLength(2);
  });
  it("never starts the module inspection for an address that fails the layout gate, and cancels it when a later check fails", async () => {
    // Before the layout gate: runtime code and Safe storage layout. The inspector runs only past it.
    for (const options of [{ runtimeMismatch: true }, { guard: pin(18).address }]) {
      const test = fixture({ ...options, inspector: true });
      await expect(test.service.inspect({ manifestId: manifest.id, address: wallet })).rejects.toBeInstanceOf(Error);
      expect(test.inspections).toEqual([]);
    }
    // Past the gate but failing an owner check: the inspection was started alongside and is cancelled.
    const owner = fixture({ contractOwner: true, inspector: true });
    await expect(owner.service.inspect({ manifestId: manifest.id, address: wallet })).rejects.toBeInstanceOf(Error);
    expect(owner.inspections).toHaveLength(1);
    expect(owner.inspections[0]?.aborted).toBe(true);
    // A clean account: one inspection, never cancelled.
    const clean = fixture({ inspector: true });
    await clean.service.inspect({ manifestId: manifest.id, address: wallet });
    expect(clean.inspections).toHaveLength(1);
    expect(clean.inspections[0]?.aborted).toBe(false);
  });
  it("requires the current owner threshold and prevents a revoked signature from restoring its binding", async () => {
    const test = fixture({ threshold: 2 });
    const { record, payload } = await test.bind();
    expect(record.ownerAccountId).toBe(principal.account.id);
    expect(record.wallet.address).toBe(wallet);
    expect(
      await test.registry.get("different-owner", record.id),
    ).toBeUndefined();
    expect((await test.service.bind(principal, payload)).id).toBe(record.id);
    await test.registry.revoke(principal.account.id, record.id);
    await expect(test.service.bind(principal, payload)).rejects.toMatchObject({
      code: "SMART_BINDING_REVOKED",
    });
    await expect(
      test.service.bind(principal, {
        ...payload,
        nonce: `0x${payload.nonce.slice(2).toUpperCase()}` as Hex,
      }),
    ).rejects.toMatchObject({ code: "SMART_BINDING_REVOKED" });
  });
  it("rejects bot enrollment, stale owner state, partial signatures and approved-hash signature forms", async () => {
    const test = fixture({ threshold: 2 });
    const { record, payload } = await test.bind();
    await expect(
      test.service.bind(
        {
          ...principal,
          isOwner: false,
          grantId: grant.id,
          signer: bot.address,
        },
        payload,
      ),
    ).rejects.toMatchObject({ code: "SMART_OWNER_REQUIRED" });
    await expect(
      test.service.bind(principal, {
        ...payload,
        signature: payload.signature.slice(0, 132) as Hex,
      }),
    ).rejects.toMatchObject({ code: "SMART_OWNER_SIGNATURE_INVALID" });
    await expect(
      test.service.bind(principal, {
        ...payload,
        signature:
          `${payload.signature.slice(0, 130)}01${payload.signature.slice(132)}` as Hex,
      }),
    ).rejects.toMatchObject({ code: "SMART_OWNER_SIGNATURE_INVALID" });
    await expect(
      test.service.bind(principal, {
        ...payload,
        signature:
          `0x${"00".repeat(64)}1b${payload.signature.slice(132)}` as Hex,
      }),
    ).rejects.toMatchObject({
      code: "SMART_OWNER_SIGNATURE_INVALID",
      status: 403,
    });
    test.state.threshold = 1;
    // The binding read answers from the last verification at any age while the chain is read
    // again behind it; the change shows on the next read (a dispatch-time read at its exact block
    // never reuses a stale state).
    time += 901;
    try {
      const calls = test.request.mock.calls.length;
      expect((await test.service.current(principal.account.id, record.id)).state.threshold).toBe(2);
      await vi.waitFor(() => expect(test.request.mock.calls.length).toBeGreaterThan(calls));
      await new Promise((resolve) => setTimeout(resolve, 50));
      await expect(
        test.service.current(principal.account.id, record.id),
      ).rejects.toMatchObject({ code: "SMART_ACCOUNT_CHANGED" });
    } finally {
      time -= 901;
    }
  });
  it("does not imply bundler configuration or verified account state creates an execution adapter", async () => {
    const service = fixture({ inspector: true }).service;
    expect(await service.capabilities()).toMatchObject({
      userOperations: "/api/v1/capabilities",
      requirements: expect.arrayContaining(["configured-erc4337-bundler"]),
    });
    expect(await service.bundlerReadiness(manifest.id)).toMatchObject({
      ready: false,
    });
  });
});
describe("explicit smart session policy reviews", () => {
  async function setup(
    assetOverride: { assetIdentity?: string; decimals?: number } = {},
  ) {
    const test = fixture({ inspector: true });
    const { record } = await test.bind();
    let activeGrant: BotGrant | null = grant;
    const reviewer = createSessionPolicyReviewer({
      currentBinding: test.service.current,
      getGrant: async () => activeGrant,
      assets: [
        {
          chainId: 1,
          address: asset,
          assetIdentity: "fixture-token",
          decimals: 18,
          reviewId: "fixture-ethereum",
        },
        {
          chainId: 8453,
          address: asset,
          assetIdentity: "fixture-token",
          decimals: 18,
          reviewId: "fixture-base",
          ...assetOverride,
        },
      ],
      targets: [
        {
          chainId: 1,
          address: pin(22).address,
          runtimeCodeHash: codeHash,
          kind: "v6-controller-uri",
          reviewId: "fixture-controller",
        },
        {
          chainId: 1,
          address: asset,
          runtimeCodeHash: codeHash,
          kind: "erc20-exact-transfer",
          reviewId: "fixture-token",
        },
        {
          chainId: 1,
          address: pin(21).address,
          runtimeCodeHash: codeHash,
          kind: "v6-core-terminal",
          reviewId: "fixture-terminal",
        },
      ],
      paymasters: [
        {
          chainId: 1,
          address: pin(23).address,
          runtimeCodeHash: codeHash,
          reviewId: "fixture-paymaster",
        },
      ],
      now: () => time * 1000,
    });
    const input = {
      bindingId: record.id,
      grantId: grant.id,
      generation: "1",
      nonce,
      validAfter: time + 1,
      durationDays: 7 as const,
      maximumCalls: "100",
      allocations: [
        {
          id: "token-group",
          total: "1000",
          allocations: [
            { id: "ethereum-token", chainId: 1, asset, limit: "600" },
            { id: "base-token", chainId: 8453, asset, limit: "400" },
          ],
        },
      ],
      actions: [
        {
          kind: "erc20-transfer" as const,
          allocationId: "ethereum-token",
          beneficiary: recipient,
          perCallLimit: "100",
          totalLimit: "600",
        },
      ],
    };
    return {
      reviewer,
      input,
      revokeGrant: () => {
        activeGrant = { ...grant, revokedAt: time };
      },
    };
  }
  it("reviews closed metadata-only authority without inventing a financial allocation", async () => {
    const { reviewer, input } = await setup();
    const metadata = {
      ...input,
      allocations: [],
      actions: [
        {
          kind: "v6-project-uri" as const,
          controller: pin(22).address,
          projectId: "123",
        },
      ],
    };
    expect(
      (await reviewer.review(principal, metadata)).policy.actions,
    ).toMatchObject([
      {
        kind: "v6-project-uri",
        projectId: "123",
        requiredEnforcement: expect.arrayContaining(["zero-native-value"]),
      },
    ]);
    await expect(
      reviewer.review(principal, {
        ...metadata,
        actions: [{ ...metadata.actions[0]!, selector: "0xdeadbeef" }],
      } as never),
    ).rejects.toBeInstanceOf(Error);
  });
  it("binds gas budgets to reviewed paymaster identity and rejects unsupported wire lengths", async () => {
    const { reviewer, input } = await setup();
    const gasBudget = {
      paymaster: pin(23).address,
      maxGasPerOperation: "1000",
      maxFeePerGas: "2",
      maxPriorityFeePerGas: "1",
      totalGasLimit: "2000",
      totalSponsoredCostLimit: "4000",
      maxPaymasterDataLength: 130,
    };
    expect(
      (await reviewer.review(principal, { ...input, gasBudget })).policy
        .gasBudget,
    ).toMatchObject({
      paymasterCodeHash: codeHash,
      paymasterReviewId: "fixture-paymaster",
    });
    await expect(
      reviewer.review(principal, {
        ...input,
        gasBudget: { ...gasBudget, maxPaymasterDataLength: 129 },
      }),
    ).rejects.toMatchObject({ code: "SMART_SESSION_POLICY_INVALID" });
    await expect(
      reviewer.review(principal, {
        ...input,
        gasBudget: { ...gasBudget, paymaster: recipient },
      }),
    ).rejects.toMatchObject({ code: "SMART_PAYMASTER_REVIEW_REQUIRED" });
  });
  it("binds account, wallet, grant key, exact expiry, distinct generation salt and whole-policy hash", async () => {
    const { reviewer, input } = await setup();
    const first = await reviewer.review(principal, input);
    const next = await reviewer.review(principal, {
      ...input,
      generation: "2",
    });
    expect(first).toMatchObject({
      status: "reviewable-not-activated",
      policy: {
        wallet,
        sessionKey: bot.address,
        restrictToActions: true,
        signing: { mode: "disabled" },
        validUntil: time + 1 + 7 * 86400,
        crossChainPermits: false,
        claimPolicies: false,
        wildcardFallback: false,
      },
    });
    expect(next.policy.salt).not.toBe(first.policy.salt);
    expect(next.policyHash).not.toBe(first.policyHash);
  });
  it("rejects duplicated cross-chain allocations and limits exceeding owner-approved totals", async () => {
    const { reviewer, input } = await setup();
    await expect(
      reviewer.review(principal, {
        ...input,
        allocations: [{ ...input.allocations[0]!, total: "999" }],
      }),
    ).rejects.toMatchObject({ code: "SMART_SESSION_POLICY_INVALID" });
    await expect(
      reviewer.review(principal, {
        ...input,
        allocations: [...input.allocations, ...input.allocations],
      }),
    ).rejects.toMatchObject({ code: "SMART_SESSION_POLICY_INVALID" });
    await expect(
      reviewer.review(principal, {
        ...input,
        actions: [
          ...input.actions,
          { ...input.actions[0]!, totalLimit: "1", perCallLimit: "1" },
        ],
      }),
    ).rejects.toMatchObject({ code: "SMART_SESSION_POLICY_INVALID" });
  });
  it.each([{ assetIdentity: "different-token" }, { decimals: 6 }])(
    "rejects heterogeneous asset units within a summed allocation group: %j",
    async (override) => {
      const { reviewer, input } = await setup(override);
      await expect(reviewer.review(principal, input)).rejects.toMatchObject({
        code: "SMART_SESSION_POLICY_INVALID",
      });
    },
  );
  it("rejects API-revoked grants, expiry extensions, forged session keys and arbitrary policy selectors", async () => {
    const { reviewer, input, revokeGrant } = await setup();
    await expect(
      reviewer.review(principal, { ...input, durationDays: 31 as 7 }),
    ).rejects.toMatchObject({ code: "SMART_SESSION_POLICY_INVALID" });
    await expect(
      reviewer.review(principal, {
        ...input,
        sessionKey: owner.address,
      } as typeof input),
    ).rejects.toMatchObject({ code: "ABI_ARGUMENT_INVALID" });
    await expect(
      reviewer.review(principal, {
        ...input,
        actions: [{ ...input.actions[0]!, kind: "arbitrary-call" } as never],
      }),
    ).rejects.toMatchObject({ code: "SMART_SESSION_POLICY_INVALID" });
    revokeGrant();
    await expect(reviewer.review(principal, input)).rejects.toMatchObject({
      code: "SMART_BOT_GRANT_INVALID",
    });
  });
  it("requires full dynamic-tail and native-value enforcement before enabling V6 payment policies", async () => {
    const { reviewer, input } = await setup();
    const review = await reviewer.review(principal, {
      ...input,
      actions: [
        {
          kind: "v6-pay",
          allocationId: "ethereum-token",
          terminal: pin(21).address,
          projectId: "7",
          beneficiary: recipient,
          perCallLimit: "100",
          totalLimit: "600",
          minReturnedTokens: "1",
        },
      ],
    });
    expect(review.policy.actions[0]).toMatchObject({
      memo: "",
      metadata: "0x",
      requiredEnforcement: expect.arrayContaining([
        "canonical-empty-dynamic-memo-and-metadata",
        "no-permit2",
      ]),
    });
    expect(review.activationRequirements).toContain(
      "reviewed-version-specific-policy-compiler",
    );
  });
});
describe("smart account HTTP admission", () => {
  function appFixture(denyAccountBudget = false) {
    const test = fixture();
    const authenticate = vi.fn(async () => principal);
    const quota = vi.fn(async (key: string) => ({
      allowed: !(denyAccountBudget && key.startsWith("rest:account:")),
      remaining: 10,
    }));
    const app = new Hono().route(
      "/api/v1",
      createRestApp({
        auth: { authenticate },
        quota: { consumeRequest: quota },
        operations: { list: () => [] },
        smartAccounts: test.service,
      } as unknown as RestDependencies),
    );
    const post = (body: unknown) =>
      app.request("/api/v1/smart-accounts/binding-challenges", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    return { ...test, app, post, authenticate, quota };
  }
  it("rejects expired binding proofs and caller-supplied trust configuration through the mounted route", async () => {
    const test = appFixture();
    const input = {
      manifestId: manifest.id,
      address: wallet,
      nonce,
      expiresAt: time,
    };
    const expired = await test.post(input);
    expect(expired.status).toBe(400);
    expect(await expired.json()).toMatchObject({
      code: "SMART_BINDING_INVALID",
    });
    const injected = await test.post({
      ...input,
      expiresAt: time + 100,
      manifests: [manifest],
    });
    expect(injected.status).toBe(400);
    expect(test.request).not.toHaveBeenCalled();
  });
  it("charges the authenticated account quota before starting canonical wallet reads", async () => {
    const test = appFixture(true);
    const response = await test.post({
      manifestId: manifest.id,
      address: wallet,
      nonce,
      expiresAt: time + 100,
    });
    expect(response.status).toBe(429);
    expect(test.authenticate).toHaveBeenCalledTimes(1);
    expect(test.quota).toHaveBeenCalledWith(
      `rest:account:${principal.account.id}:owner`,
      expect.any(Number),
      60,
    );
    expect(test.request).not.toHaveBeenCalled();
  });
});
