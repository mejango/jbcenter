import { describe, expect, it, vi } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import type { RestRpc } from "../src/rest/core.js";
import { SponsorshipChain } from "../src/rest/sponsorship/chain.js";
import { observeDestination } from "../src/rest/sponsorship/execution.js";
import {
  DEFAULT_SPONSORSHIP_POLICY,
  FORWARDER_ABI,
} from "../src/rest/sponsorship/constants.js";
import type {
  PreparedForwardRequest,
  RelayrEntry,
} from "../src/rest/sponsorship/types.js";
import type {
  SemanticResult,
  SemanticVerifier,
  StoredPlan,
} from "../src/rest/transactions/types.js";

const CHAIN = 8453;
const NOW = Date.parse("2026-09-07T00:00:00Z");
const OWNER = "0x1111111111111111111111111111111111111111";
const TARGET = "0x2222222222222222222222222222222222222222";
const FORWARDER = "0x3333333333333333333333333333333333333333";
const RELAYER = "0x4444444444444444444444444444444444444444";
const RUNTIME: Hex = "0x600060005260206000f3";
const TX_HASH = `0x${"ab".repeat(32)}` as Hex;
const RECEIPT_HASH = `0x${"cd".repeat(32)}` as Hex;
const HEAD_HASH = `0x${"ef".repeat(32)}` as Hex;
const PREPARE_HASH = `0x${"01".repeat(32)}` as Hex;
const REORG_HASH = `0x${"23".repeat(32)}` as Hex;
const quantity = (number: bigint | number): Hex => `0x${number.toString(16)}`;

function executionLog(
  input: {
    signer?: Address;
    nonce?: bigint;
    success?: boolean;
    address?: Address;
  } = {},
): Record<string, unknown> {
  return {
    address: input.address ?? FORWARDER,
    topics: encodeEventTopics({
      abi: FORWARDER_ABI,
      eventName: "ExecutedForwardRequest",
      args: { signer: input.signer ?? OWNER },
    }),
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "bool" }],
      [input.nonce ?? 7n, input.success ?? true],
    ),
    transactionHash: TX_HASH,
    blockHash: RECEIPT_HASH,
    blockNumber: "0x64",
    transactionIndex: "0x1",
    logIndex: "0x0",
    removed: false,
  };
}

function harness() {
  const policy = { ...DEFAULT_SPONSORSHIP_POLICY, confirmations: 2 };
  const request: PreparedForwardRequest = {
    stepIndex: 1,
    chainId: CHAIN,
    forwarder: FORWARDER,
    forwarderCodeHash: keccak256(RUNTIME),
    targetCodeHash: keccak256("0x6000"),
    domain: {
      name: "Juicebox",
      version: "1",
      chainId: CHAIN,
      verifyingContract: FORWARDER,
    },
    message: {
      from: OWNER,
      to: TARGET,
      value: "123",
      gas: "100000",
      nonce: "7",
      deadline: String(NOW / 1000 + 300),
      data: "0x12345678",
    },
    evidence: {
      chainId: CHAIN,
      blockNumber: "99",
      blockHash: PREPARE_HASH,
      timestamp: String(NOW / 1000 - 24),
      source: "onchain",
    },
  };
  const entry: RelayrEntry = {
    chain: CHAIN,
    target: FORWARDER,
    data: encodeFunctionData({
      abi: FORWARDER_ABI,
      functionName: "execute",
      args: [
        {
          from: OWNER,
          to: TARGET,
          value: 123n,
          gas: 100000n,
          deadline: Number(request.message.deadline),
          data: "0x12345678",
          // Public structural fixture only; no network signer or submitted transaction.
          signature: `0x${"01".repeat(65)}`,
        },
      ],
    }),
    value: "123",
    virtual_nonce: 0,
  };
  const plan: StoredPlan = {
    id: "reviewed-plan",
    actor: {
      accountId: `eip155:${CHAIN}:${OWNER}`,
      principalId: "owner:test-owner",
    },
    draft: {
      operation: "pay",
      account: OWNER,
      project: { chainId: CHAIN, projectId: "1", version: 6 },
      calls: [
        {
          chainId: CHAIN,
          to: TARGET,
          data: "0xabcdef12",
          value: "0",
          label: "Prerequisite",
          dependsOn: [],
          decoded: {},
        },
        {
          chainId: CHAIN,
          to: TARGET,
          data: request.message.data,
          value: request.message.value,
          label: "Pay",
          dependsOn: [0],
          decoded: {},
        },
      ],
      evidence: [request.evidence],
      summary: { expectedPayment: "123" },
      warnings: [],
    },
    commitment: PREPARE_HASH,
    createdAt: NOW - 24000,
    expiresAt: NOW + 300000,
    revision: 0,
    steps: [
      { index: 0, state: "confirmed" },
      { index: 1, state: "waiting" },
    ],
  };
  const state = {
    transaction: {
      hash: TX_HASH,
      from: RELAYER,
      to: FORWARDER,
      input: entry.data,
      value: "0x7b",
      chainId: "0x2105",
      blockHash: RECEIPT_HASH,
      blockNumber: "0x64",
      transactionIndex: "0x1",
    } as Record<string, unknown> | null,
    receipt: {
      transactionHash: TX_HASH,
      from: RELAYER,
      to: FORWARDER,
      blockHash: RECEIPT_HASH,
      blockNumber: "0x64",
      transactionIndex: "0x1",
      status: "0x1",
      logs: [executionLog()],
    } as Record<string, unknown> | null,
    height: 101n,
    runtime: RUNTIME,
    canonicalHash: RECEIPT_HASH,
    reorgOnRecheck: false,
    canonicalReads: 0,
  };
  const rpc = vi.fn<RestRpc["request"]>(async (chainId, method, params) => {
    expect(chainId).toBe(CHAIN);
    switch (method) {
      case "eth_chainId":
        return "0x2105";
      case "eth_getTransactionByHash":
        expect(params).toEqual([TX_HASH]);
        return state.transaction;
      case "eth_getTransactionReceipt":
        expect(params).toEqual([TX_HASH]);
        return state.receipt;
      case "eth_getBlockByNumber":
        if (params[0] === "latest")
          return {
            number: quantity(state.height),
            hash: HEAD_HASH,
            timestamp: quantity(NOW / 1000),
          };
        state.canonicalReads += 1;
        expect(params).toEqual(["0x64", false]);
        return {
          number: "0x64",
          hash:
            state.reorgOnRecheck && state.canonicalReads > 1
              ? REORG_HASH
              : state.canonicalHash,
          timestamp: quantity(NOW / 1000 - 12),
        };
      case "eth_getCode":
        expect(params).toEqual([
          FORWARDER,
          { blockHash: RECEIPT_HASH, requireCanonical: true },
        ]);
        return state.runtime;
      case "eth_call":
        return "0x42";
      default:
        throw new Error(`Unexpected fixture RPC method ${method}`);
    }
  });
  const chain = new SponsorshipChain(
    { request: rpc },
    policy,
    undefined,
    () => NOW,
  );
  const verify = (
    hint: { providerState: string; hash?: Hex } = {
      providerState: "Broadcast",
      hash: TX_HASH,
    },
    semanticVerifier?: SemanticVerifier,
  ) =>
    observeDestination({
      chain,
      request,
      entry,
      hint,
      plan,
      policy,
      now: NOW,
      ...(semanticVerifier ? { semanticVerifier } : {}),
    });
  return { state, rpc, request, entry, plan, policy, verify };
}

describe("independent sponsored destination execution verification", () => {
  it("requires a transaction hash even when provider status claims success", async () => {
    const h = harness();
    expect(await h.verify({ providerState: "Confirmed" })).toMatchObject({
      stepIndex: 1,
      chainId: CHAIN,
      state: "pending",
    });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it.each(["transaction", "receipt"] as const)(
    "keeps a missing %s pending regardless of provider status",
    async (missing) => {
      const h = harness();
      h.state[missing] = null;
      expect(
        await h.verify({ providerState: "Confirmed", hash: TX_HASH }),
      ).toMatchObject({ state: "pending" });
    },
  );

  it("proves exact outer and forwarded execution while keeping missing economic semantics unknown", async () => {
    const h = harness();
    const result = await h.verify({
      providerState: "ProviderFailed",
      hash: TX_HASH,
    });
    expect(result).toMatchObject({
      stepIndex: 1,
      chainId: CHAIN,
      providerState: "ProviderFailed",
      state: "confirmed",
      hash: TX_HASH,
      receipt: {
        transactionHash: TX_HASH,
        blockHash: RECEIPT_HASH,
        blockNumber: "100",
        status: "success",
        confirmations: 2,
        canonical: true,
        observedAt: NOW,
      },
      semantic: { status: "unknown" },
    });
    expect(h.state.canonicalReads).toBe(2);
    expect(
      h.rpc.mock.calls.every(([, method]) => !method.startsWith("eth_send")),
    ).toBe(true);
  });

  it.each([
    ["transaction", "hash", HEAD_HASH],
    ["transaction", "to", TARGET],
    ["transaction", "input", "0x12345679"],
    ["transaction", "value", "0x7c"],
    ["transaction", "chainId", "0x1"],
    ["transaction", "blockHash", HEAD_HASH],
    ["transaction", "blockNumber", "0x63"],
    ["transaction", "transactionIndex", "0x2"],
    ["receipt", "transactionHash", HEAD_HASH],
    ["receipt", "from", OWNER],
    ["receipt", "to", TARGET],
    ["receipt", "blockHash", HEAD_HASH],
    ["receipt", "transactionIndex", "0x2"],
  ] as const)(
    "rejects changed %s %s identity before economic verification",
    async (part, field, value) => {
      const h = harness();
      h.state[part]![field] = value;
      const verifier = { verify: vi.fn<SemanticVerifier["verify"]>() };
      expect(await h.verify(undefined, verifier)).toMatchObject({
        state: "unknown",
      });
      expect(verifier.verify).not.toHaveBeenCalled();
    },
  );

  it("rejects a quoted entry whose chain differs from the prepared forwarding chain", async () => {
    const h = harness();
    h.entry.chain = 1;
    const verifier = { verify: vi.fn<SemanticVerifier["verify"]>() };
    expect(await h.verify(undefined, verifier)).toMatchObject({
      state: "unknown",
    });
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it.each([
    ["chainId", 1],
    ["to", RELAYER],
    ["data", "0x12345679"],
    ["value", "124"],
  ] as const)(
    "rejects a changed original plan %s before RPC work",
    async (field, value) => {
      const h = harness();
      h.plan.draft.calls[1] = { ...h.plan.draft.calls[1]!, [field]: value };
      expect(await h.verify()).toMatchObject({ state: "unknown" });
      expect(h.rpc).not.toHaveBeenCalled();
    },
  );

  it("rejects a changed account, absent plan step or foreign quoted forwarder", async () => {
    for (const changed of ["account", "step", "forwarder"]) {
      const h = harness();
      if (changed === "account") h.plan.draft.account = RELAYER;
      if (changed === "step") h.request.stepIndex = 2;
      if (changed === "forwarder") h.entry.target = TARGET;
      expect(await h.verify()).toMatchObject({ state: "unknown" });
      expect(h.rpc).not.toHaveBeenCalled();
    }
  });

  it("rejects malformed relayer identities even if transaction and receipt repeat the same string", async () => {
    const h = harness();
    h.state.transaction!.from = "not-an-address";
    h.state.receipt!.from = "not-an-address";
    const verifier = { verify: vi.fn<SemanticVerifier["verify"]>() };
    expect(await h.verify(undefined, verifier)).toMatchObject({
      state: "unknown",
    });
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it("rejects a receipt missing from the canonical chain", async () => {
    const h = harness();
    h.state.canonicalHash = REORG_HASH;
    expect(await h.verify()).toMatchObject({
      state: "unknown",
      reason: "The receipt is not in the canonical chain.",
    });
    expect(
      h.rpc.mock.calls.some(([, method]) => method === "eth_getCode"),
    ).toBe(false);
  });

  it("rechecks canonical identity after runtime/log reads and aborts on a reorg", async () => {
    const h = harness();
    h.state.reorgOnRecheck = true;
    const verifier = { verify: vi.fn<SemanticVerifier["verify"]>() };
    await expect(h.verify(undefined, verifier)).rejects.toMatchObject({
      code: "SPONSORSHIP_REORGED",
      status: 409,
    });
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it.each([
    [99n, 0, "confirming"],
    [100n, 1, "confirming"],
    [101n, 2, "confirmed"],
    [3000n, 1024, "confirmed"],
  ] as const)(
    "derives %s head confirmations from chain evidence",
    async (height, confirmations, state) => {
      const h = harness();
      h.state.height = height;
      expect(await h.verify()).toMatchObject({
        state,
        receipt: { confirmations },
      });
    },
  );

  it("rejects runtime changes at the canonical execution block", async () => {
    const h = harness();
    h.state.runtime = "0x6001";
    const verifier = { verify: vi.fn<SemanticVerifier["verify"]>() };
    expect(await h.verify(undefined, verifier)).toMatchObject({
      state: "unknown",
      reason: expect.stringContaining("runtime"),
    });
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it.each([
    ["missing execution event", []],
    ["failed inner call", [executionLog({ success: false })]],
    ["another signer", [executionLog({ signer: RELAYER })]],
    ["another nonce", [executionLog({ nonce: 8n })]],
    ["another emitter", [executionLog({ address: TARGET })]],
    [
      "duplicate matching execution",
      [executionLog(), { ...executionLog(), logIndex: "0x1" }],
    ],
    ["another event", [{ ...executionLog(), topics: [HEAD_HASH] }]],
    ["undecodable event", [{ ...executionLog(), data: "0x12" }]],
  ])(
    "requires exactly one successful event for the reviewed signer and nonce: %s",
    async (_name, logs) => {
      const h = harness();
      h.state.receipt!.logs = logs;
      const verifier = { verify: vi.fn<SemanticVerifier["verify"]>() };
      expect(await h.verify(undefined, verifier)).toMatchObject({
        state: "unknown",
        reason: expect.stringContaining("one successful execution"),
      });
      expect(verifier.verify).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["removed", { removed: true }],
    ["wrong transaction", { transactionHash: HEAD_HASH }],
    ["wrong block hash", { blockHash: HEAD_HASH }],
    ["wrong block number", { blockNumber: "0x63" }],
    ["wrong transaction index", { transactionIndex: "0x2" }],
    ["malformed emitter", { address: "0x1234" }],
    ["missing topics", { topics: null }],
    ["too many topics", { topics: Array(5).fill(HEAD_HASH) }],
    ["malformed topic", { topics: ["0x1234"] }],
    ["odd-length bytes", { data: "0x123" }],
    ["oversized data", { data: `0x${"00".repeat(131073)}` }],
  ])(
    "rejects %s logs before event or economic verification",
    async (_name, fields) => {
      const h = harness();
      h.state.receipt!.logs = [{ ...executionLog(), ...fields }];
      const verifier = { verify: vi.fn<SemanticVerifier["verify"]>() };
      expect(await h.verify(undefined, verifier)).toMatchObject({
        state: "unknown",
        reason: expect.stringContaining("inconsistent"),
      });
      expect(verifier.verify).not.toHaveBeenCalled();
    },
  );

  it("bounds the complete log list and rejects a non-array log container", async () => {
    for (const logs of [
      Array.from({ length: 513 }, () => executionLog()),
      Array.from({ length: 5 }, (_, index) => ({
        ...executionLog(),
        logIndex: `0x${index.toString(16)}`,
        data: `0x${"ab".repeat(65_536)}`,
      })),
      null,
    ]) {
      const h = harness();
      h.state.receipt!.logs = logs;
      expect(await h.verify()).toMatchObject({
        state: "unknown",
        reason: expect.stringContaining("bounded verification limit"),
      });
    }
  });

  it("rejects malformed RPC quantities without treating them as successful evidence", async () => {
    const h = harness();
    h.state.receipt!.logs = [{ ...executionLog(), blockNumber: "100" }];
    await expect(h.verify()).rejects.toMatchObject({
      code: "INVALID_RPC_RESPONSE",
      status: 502,
    });
  });

  it("rejects missing or duplicate log positions before economic verification", async () => {
    const missing = harness();
    const log = executionLog();
    delete log.logIndex;
    missing.state.receipt!.logs = [log];
    await expect(missing.verify()).rejects.toMatchObject({
      code: "INVALID_RPC_RESPONSE",
    });

    const duplicate = harness();
    duplicate.state.receipt!.logs = [
      executionLog(),
      executionLog({ signer: RELAYER }),
    ];
    const verifier = { verify: vi.fn<SemanticVerifier["verify"]>() };
    expect(await duplicate.verify(undefined, verifier)).toMatchObject({
      state: "unknown",
      reason: "Receipt contains duplicate log positions.",
    });
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it.each([
    [100n, "confirming"],
    [101n, "reverted"],
  ] as const)(
    "reports an outer revert with %s head independently of provider state",
    async (height, state) => {
      const h = harness();
      h.state.height = height;
      h.state.receipt!.status = "0x0";
      h.state.receipt!.logs = [];
      const verifier = { verify: vi.fn<SemanticVerifier["verify"]>() };
      expect(
        await h.verify({ providerState: "Succeeded", hash: TX_HASH }, verifier),
      ).toMatchObject({
        state,
        receipt: { status: "reverted" },
        semantic: { status: "failed" },
      });
      expect(verifier.verify).not.toHaveBeenCalled();
    },
  );

  it("rejects a non-binary receipt status", async () => {
    const h = harness();
    h.state.receipt!.status = "0x2";
    expect(await h.verify()).toMatchObject({
      state: "unknown",
      reason: "The receipt status is invalid.",
    });
  });

  it.each(["verified", "failed", "unknown", "unmodeled"] as const)(
    "passes exact plan, selected step, canonical full receipt and bounded RPC to the semantic verifier: %s",
    async (status) => {
      const h = harness();
      const semantic: SemanticResult = {
        status,
        details: { checked: "economic outcome" },
      };
      const verify = vi.fn<SemanticVerifier["verify"]>(
        async (plan, step, receipt, rpc) => {
          expect(plan).toBe(h.plan);
          expect(step).toBe(1);
          expect(receipt).toMatchObject({
            canonical: true,
            transactionHash: TX_HASH,
            logs: [executionLog()],
          });
          await expect(
            rpc.request(CHAIN, "eth_call", [
              { to: TARGET, data: "0x12345678" },
              { blockHash: RECEIPT_HASH, requireCanonical: true },
            ]),
          ).resolves.toBe("0x42");
          return semantic;
        },
      );
      const observed = await h.verify(undefined, { verify });
      expect(verify).toHaveBeenCalledOnce();
      expect(observed).toMatchObject({ state: "confirmed", semantic });
      expect(
        h.rpc.mock.calls.find(([, method]) => method === "eth_call")?.[3],
      ).toBeInstanceOf(AbortSignal);
    },
  );
});
