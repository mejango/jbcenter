import { beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { keccak256, toHex, type Address, type Hex } from "viem";
import {
  getContractCatalog,
  type ContractCatalog,
} from "../src/rest/contracts/catalog.js";
import type { CodeRecord } from "../src/rest/contracts/types.js";
import type { RestBlockEvidence, RestRpc } from "../src/rest/core.js";
import type { ProtocolCatalog } from "../src/rest/protocol/index.js";
import {
  createSessionTargetResolver,
  V6_NATIVE_SESSION_ASSETS,
  V6_SESSION_TARGET_CONTRACTS,
  type SessionTargetSourceEvidence,
} from "../src/rest/smartAccounts/targets.js";
import type {
  SessionPolicyInput,
  SmartAccountBinding,
} from "../src/rest/smartAccounts/types.js";

const native = "0x000000000000000000000000000000000000eeee" as Address;
const wallet = "0x1111111111111111111111111111111111111111" as Address;
const recipient = "0x2222222222222222222222222222222222222222" as Address;
const runtime = "0x600160005260206000f3" as Hex;
const otherRuntime = "0x600260005260206000f3" as Hex;
const blockHash = keccak256("0x01");
const evidence: RestBlockEvidence = {
  chainId: 1,
  blockNumber: "100",
  blockHash,
  timestamp: "1800000000",
  source: "onchain",
};
const binding = {
  wallet: { chainId: 1, address: wallet },
  state: { evidence },
} as SmartAccountBinding;
let official: ContractCatalog;
beforeAll(async () => {
  official = await getContractCatalog();
});
function fixture() {
  const terminal = official.get(V6_SESSION_TARGET_CONTRACTS["v6-pay"]);
  const controller = official.get(
    V6_SESSION_TARGET_CONTRACTS["v6-project-uri"],
  );
  const target = terminal.deployments.find((d) => d.chainId === 1)!
    .instances[0]!;
  const control = controller.deployments.find((d) => d.chainId === 1)!
    .instances[0]!;
  const code = (id: string): CodeRecord => ({
    ...official.code(id),
    runtimeTemplate: runtime,
    runtimeTemplateKeccak256: keccak256(runtime),
    runtimeTemplateByteLength: 10,
    immutableReferences: [],
    linkReferences: [],
    compilerEvidence: {
      artifactPath: "fixture",
      artifactSha256: "fixture",
      metadataSha256: "fixture",
      compilerVersion: "0.8.28",
    },
  });
  const catalog: ProtocolCatalog = {
    data: official.data,
    get: (id) => official.get(id),
    code,
  };
  const state = {
    code: runtime,
    reorged: false,
    gap: false,
    wrongContract: false,
    wrongAssociation: false,
    wrongBlock: false,
    wrongPublication: false,
  };
  const rpc = vi.fn<RestRpc["request"]>(async (_chain, method) => {
    if (method === "eth_getBlockByNumber")
      return {
        number: "0x64",
        hash: state.reorged ? keccak256("0x02") : blockHash,
        timestamp: toHex(1800000000),
      };
    if (method === "eth_getCode") return state.code;
    throw new Error(`Unexpected ${method}`);
  });
  const resolve = vi.fn(
    async (input: {
      chainId: number;
      contractId: string;
      address?: string;
      projectId?: string;
      blockNumber?: string;
    }) => {
      const deployment = input.contractId === controller.id ? control : target;
      return {
        chainId: input.chainId,
        contractId: state.wrongContract
          ? "core-v4:JBMultiTerminal"
          : input.contractId,
        address: input.address as Address,
        abiHash: deployment.abiHash,
        provenance: {
          kind: "published-deployment",
          runtimeVerified: !state.gap,
          runtime: {
            mode: state.gap
              ? "official-address-runtime-observed"
              : "exact-runtime-template",
            runtimeCodeHash: keccak256(state.code),
          },
          publication: {
            ...deployment,
            ...(state.wrongPublication ? { artifactSha256: "other" } : {}),
          },
          projectContext: {
            projectId: input.projectId,
            terminalAssociationChecked: !state.wrongAssociation,
            controllerAssociationChecked: !state.wrongAssociation,
          },
        },
        evidence: [
          {
            ...evidence,
            ...(state.wrongBlock ? { blockHash: keccak256("0x03") } : {}),
          },
        ],
      };
    },
  );
  const input: Pick<SessionPolicyInput, "actions" | "allocations"> = {
    allocations: [
      {
        id: "eth",
        total: "100",
        allocations: [
          { id: "mainnet", chainId: 1, asset: native, limit: "100" },
        ],
      },
    ],
    actions: [
      {
        kind: "v6-pay",
        allocationId: "mainnet",
        terminal: target.address,
        projectId: "1",
        beneficiary: recipient,
        perCallLimit: "10",
        totalLimit: "100",
        minReturnedTokens: "1",
      },
    ],
  };
  const create = (
    sourceEvidence: readonly SessionTargetSourceEvidence[] = [],
  ) =>
    createSessionTargetResolver({
      catalog,
      protocol: { resolve },
      rpc: { request: rpc },
      sourceEvidence,
    });
  return { state, rpc, resolve, catalog, target, control, input, create };
}
describe("canonical V6 session target authority", () => {
  it.each([1, 10, 8453, 42161, 84532, 421614, 11155111, 11155420])(
    "closes the real terminal/controller source gap and verifies initialized linked libraries on chain %s",
    async (chainId) => {
      const snapshot = JSON.parse(
        readFileSync(
          new URL(
            "../src/rest/smartAccounts/targets-evidence/observations.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const observed = snapshot.chains.find(
        (item: { chainId: number }) => item.chainId === chainId,
      );
      const at: RestBlockEvidence = {
        ...evidence,
        chainId,
        blockNumber: BigInt(observed.blockNumber).toString(),
        blockHash: observed.blockHash,
      };
      const resolve = vi.fn(
        async (input: {
          chainId: number;
          contractId: string;
          address?: string;
          projectId?: string;
          blockNumber?: string;
        }) => {
          const deployment = official
            .get(input.contractId)
            .deployments.find((d) => d.chainId === chainId)!.instances[0]!;
          const code = observed.observations.find(
            (o: { contractId: string }) => o.contractId === input.contractId,
          );
          return {
            chainId,
            contractId: input.contractId,
            address: deployment.address,
            abiHash: deployment.abiHash,
            evidence: [at],
            provenance: {
              kind: "published-deployment",
              runtimeVerified: false,
              runtime: {
                mode: "official-address-runtime-observed",
                runtimeCodeHash: code.runtimeKeccak256,
              },
              publication: deployment,
              projectContext: {
                projectId: "1",
                terminalAssociationChecked: true,
                controllerAssociationChecked: true,
              },
            },
          };
        },
      );
      const rpc = vi.fn<RestRpc["request"]>(async (_chain, method, params) => {
        if (method === "eth_getBlockByNumber")
          return {
            number: observed.blockNumber,
            hash: observed.blockHash,
            timestamp: toHex(BigInt(at.timestamp)),
          };
        if (method === "eth_getCode") {
          const item = observed.observations.find(
            (o: { address: string }) =>
              o.address.toLowerCase() === String(params[0]).toLowerCase(),
          );
          return snapshot.runtimes[item.runtimeKeccak256].runtimeHex;
        }
        throw new Error("Unexpected RPC");
      });
      const input = fixture().input;
      input.allocations[0]!.allocations[0]!.chainId = chainId;
      input.actions.push({
        kind: "v6-project-uri",
        controller: fixture().control.address,
        projectId: "1",
      });
      const resolver = createSessionTargetResolver({
        catalog: official,
        protocol: { resolve },
        rpc: { request: rpc },
      });
      const result = await resolver.resolve(
        {
          ...binding,
          wallet: { ...binding.wallet, chainId },
          state: { ...binding.state, evidence: at },
        },
        input,
      );
      expect(result).toHaveLength(2);
      expect(result.every((r) => r.chainId === chainId)).toBe(true);
      expect(
        rpc.mock.calls.filter(([, method]) => method === "eth_getCode"),
      ).toHaveLength(4);
    },
  );
  it("does no construction network work and provides separate mainnet/testnet native identity", () => {
    const f = fixture();
    const resolver = f.create();
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
    expect(resolver.assets).toHaveLength(8);
    expect(
      V6_NATIVE_SESSION_ASSETS.every(
        (a) => a.decimals === 18 && a.address === native,
      ),
    ).toBe(true);
    expect(resolver.assets.find((a) => a.chainId === 1)?.assetIdentity).toBe(
      "ETH",
    );
    expect(
      resolver.assets.find((a) => a.chainId === 11155111)?.assetIdentity,
    ).toBe("ETH:testnet");
  });
  it("binds terminal and controller to exact official V6 source and the account review block", async () => {
    const f = fixture();
    f.input.actions.push({
      kind: "v6-project-uri",
      controller: f.control.address,
      projectId: "1",
    });
    const result = await f.create().resolve(binding, f.input);
    expect(result.map((r) => r.kind)).toEqual([
      "v6-core-terminal",
      "v6-controller-uri",
    ]);
    expect(
      result.every(
        (r) =>
          r.runtimeCodeHash === keccak256(runtime) &&
          r.reviewId.startsWith("v6-source:"),
      ),
    ).toBe(true);
    expect(f.resolve).toHaveBeenCalledWith(
      {
        chainId: 1,
        contractId: V6_SESSION_TARGET_CONTRACTS["v6-pay"],
        address: f.target.address,
        projectId: "1",
        blockNumber: "100",
      },
      expect.any(AbortSignal),
    );
    for (const [, method, params] of f.rpc.mock.calls)
      if (method === "eth_getCode")
        expect(params[1]).toEqual({ blockHash, requireCanonical: true });
  });
  it.each([
    "wrongContract",
    "wrongAssociation",
    "wrongBlock",
    "wrongPublication",
  ] as const)("rejects mismatched %s resolved provenance", async (field) => {
    const f = fixture();
    f.state[field] = true;
    await expect(f.create().resolve(binding, f.input)).rejects.toMatchObject({
      code: "SMART_TARGET_PROVENANCE_MISMATCH",
    });
  });
  it("does not authorize source-unverified address-only catalog results", async () => {
    const f = fixture();
    f.state.gap = true;
    await expect(f.create().resolve(binding, f.input)).rejects.toMatchObject({
      code: "SMART_TARGET_SOURCE_UNVERIFIED",
    });
  });
  it("requires independent runtime equality even if a protocol resolver claims runtimeVerified", async () => {
    const f = fixture();
    f.state.code = otherRuntime;
    await expect(f.create().resolve(binding, f.input)).rejects.toMatchObject({
      code: "RUNTIME_CODE_MISMATCH",
    });
  });
  it("rejects v4/foreign addresses and wrong action-contract combinations before any RPC", async () => {
    for (const terminal of [recipient, fixture().control.address]) {
      const f = fixture();
      Object.assign(f.input.actions[0]!, { terminal });
      await expect(f.create().resolve(binding, f.input)).rejects.toMatchObject({
        code: "SMART_TARGET_NOT_V6",
      });
      expect(f.rpc).not.toHaveBeenCalled();
      expect(f.resolve).not.toHaveBeenCalled();
    }
  });
  it.each(["count", "project", "unknown", "token", "duplicate"])(
    "bounds invalid %s requests before network work",
    async (mutation) => {
      const f = fixture();
      if (mutation === "count")
        f.input.actions = Array.from({ length: 17 }, () => f.input.actions[0]!);
      if (mutation === "project")
        Object.assign(f.input.actions[0]!, { projectId: "1".repeat(79) });
      if (mutation === "unknown")
        Object.assign(f.input.actions[0]!, { selector: "0x12345678" });
      if (mutation === "token")
        f.input.allocations[0]!.allocations[0]!.asset = recipient;
      if (mutation === "duplicate") f.input.actions.push(f.input.actions[0]!);
      await expect(f.create().resolve(binding, f.input)).rejects.toThrow();
      expect(f.rpc).not.toHaveBeenCalled();
      expect(f.resolve).not.toHaveBeenCalled();
    },
  );
  it("rejects another protocol catalog version", () => {
    const f = fixture();
    Object.assign(f.catalog, {
      data: { ...f.catalog.data, protocolVersion: 4 },
    });
    expect(() => f.create()).toThrow("verified V6 catalog");
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it("rechecks canonicality before returning authority and propagates cancellation", async () => {
    const f = fixture();
    f.resolve.mockImplementationOnce(async (input) => {
      f.state.reorged = true;
      return {
        chainId: input.chainId,
        contractId: input.contractId,
        address: input.address as Address,
        abiHash: f.target.abiHash,
        provenance: {
          kind: "published-deployment",
          runtimeVerified: true,
          runtime: {
            mode: "exact-runtime-template",
            runtimeCodeHash: keccak256(runtime),
          },
          publication: f.target,
          projectContext: {
            projectId: "1",
            terminalAssociationChecked: true,
            controllerAssociationChecked: true,
          },
        },
        evidence: [evidence],
      };
    });
    await expect(f.create().resolve(binding, f.input)).rejects.toMatchObject({
      code: "USER_OPERATION_REORGED",
    });
    const cancelled = fixture(),
      controller = new AbortController();
    cancelled.resolve.mockImplementationOnce(async () => {
      controller.abort();
      return new Promise(() => {});
    });
    await expect(
      cancelled.create().resolve(binding, cancelled.input, controller.signal),
    ).rejects.toMatchObject({ code: "SMART_TARGET_CANCELLED" });
  });
  it("accepts only source-input-bound supplemental immutable proof, never guessed masks", async () => {
    const f = fixture();
    f.state.gap = true;
    f.state.code = otherRuntime;
    const original = f.catalog.code(f.target.codeId);
    const supplement: SessionTargetSourceEvidence = {
      contractId: V6_SESSION_TARGET_CONTRACTS["v6-pay"],
      catalogCodeId: f.target.codeId,
      code: {
        ...original,
        immutableReferences: [{ start: 1, length: 1 }],
        compilerEvidence: {
          ...original.compilerEvidence!,
          sourceInputIdentitySha256: f.target.compilerInputIdentitySha256,
          deploymentPaths: [f.target.artifactPath],
        },
      },
    };
    expect(
      await f.create([supplement]).resolve(binding, f.input),
    ).toMatchObject([{ runtimeCodeHash: keccak256(otherRuntime) }]);
    const altered = structuredClone(supplement);
    altered.code.compilerEvidence!.sourceInputIdentitySha256 =
      "another-source-closure";
    await expect(
      f.create([altered]).resolve(binding, f.input),
    ).rejects.toMatchObject({ code: "SMART_TARGET_EVIDENCE_INVALID" });
  });
  it("requires both explicit immutable token review and asset units; native budget identity cannot be overridden", async () => {
    const f = fixture();
    const tokenInput = {
      allocations: [
        {
          id: "token",
          total: "100",
          allocations: [
            { id: "token-mainnet", chainId: 1, asset: recipient, limit: "100" },
          ],
        },
      ],
      actions: [
        {
          kind: "erc20-transfer" as const,
          allocationId: "token-mainnet",
          beneficiary: wallet,
          perCallLimit: "10",
          totalLimit: "100",
        },
      ],
    };
    const assets = [
      {
        chainId: 1,
        address: recipient,
        decimals: 18,
        assetIdentity: "reviewed-token",
        reviewId: "reviewed",
      },
    ];
    const base = {
      catalog: f.catalog,
      protocol: { resolve: f.resolve },
      rpc: { request: f.rpc },
      assets,
    };
    await expect(
      createSessionTargetResolver(base).resolve(binding, tokenInput),
    ).rejects.toMatchObject({ code: "SMART_TARGET_REVIEW_REQUIRED" });
    const resolver = createSessionTargetResolver({
      ...base,
      targets: [
        {
          chainId: 1,
          address: recipient,
          runtimeCodeHash: keccak256(runtime),
          reviewId: "immutable-source-reviewed",
          kind: "erc20-exact-transfer",
        },
      ],
    });
    expect(await resolver.resolve(binding, tokenInput)).toMatchObject([
      { address: recipient, kind: "erc20-exact-transfer" },
    ]);
    expect(() =>
      createSessionTargetResolver({
        ...base,
        assets: [{ ...assets[0]!, address: native }],
      }),
    ).toThrow("duplicated");
  });
});
