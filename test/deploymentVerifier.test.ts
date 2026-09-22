import { encodeAbiParameters, encodeEventTopics, zeroAddress, type Address, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalDeploymentChains,
  DeploymentVerificationError,
  RpcDeploymentVerifier,
  type ReceiptReader,
} from "../src/deploymentVerifier.js";
import type { RpcUpstreams } from "../src/rpc.js";

const projects = "0x1111111111111111111111111111111111111111" as const;
const deployer = "0x3333333333333333333333333333333333333333" as const;
const wrapper = "0x4444444444444444444444444444444444444444" as const;
const FORWARDER = "0x5555555555555555555555555555555555555555" as const;
const CANONICAL_FORWARDER = "0x3ba60b60933916a7c87d0860dcee62a0ce34e3e2" as const;
const SIGNER_SUFFIX = "39b8f61fa47c5e3194baf6bb71dba799edda15fc";
const SPONSOR = `0x${SIGNER_SUFFIX}` as const;
const OTHER_SENDER_SUFFIX = "c0ffee0000000000000000000000000000000001";
const hash = `0x${"22".repeat(32)}` as const;
const call = { chainId: 1, to: deployer, data: "0x12345678" as const };
const createEvent = [
  {
    type: "event",
    name: "Create",
    anonymous: false,
    inputs: [
      { name: "projectId", type: "uint256", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "caller", type: "address", indexed: false },
    ],
  },
] as const;

type Receipt = Awaited<ReturnType<ReceiptReader["getTransactionReceipt"]>>;
type Log = Receipt["logs"][number];
type Transaction = Awaited<ReturnType<ReceiptReader["getTransaction"]>>;

function createLog(projectId = 42n): Log {
  return {
    address: projects,
    topics: encodeEventTopics({
      abi: createEvent,
      eventName: "Create",
      args: { projectId, owner: zeroAddress },
    }) as unknown as readonly Hex[],
    data: encodeAbiParameters([{ type: "address" }], [zeroAddress]),
  };
}

function successReceipt(...logs: Log[]): Receipt {
  return { status: "success" as const, blockNumber: 10n, logs };
}

function callFrame(to: Address, input: Hex, extra: Record<string, unknown> = {}) {
  return { type: "CALL", to, input, ...extra };
}

function forwardedFrame(from: Address, to: Address, data: Hex, suffix = SIGNER_SUFFIX) {
  return { type: "CALL", from, to, input: `${data}${suffix}` as Hex };
}

function fakeReader(
  options: {
    receipt?: Receipt;
    transaction?: Transaction;
    trace?: unknown;
  } = {},
): ReceiptReader {
  const receipt = options.receipt ?? successReceipt(createLog());
  const transaction = options.transaction ?? { to: FORWARDER, input: "0xdeadbeef" as Hex };
  const trace = options.trace ?? callFrame(deployer, call.data);
  return {
    getTransactionReceipt: vi.fn(async () => receipt),
    getBlockNumber: vi.fn(async () => 11n),
    getTransaction: vi.fn(async () => transaction),
    traceTransaction: vi.fn(async () => trace),
  };
}

function verifier(receiptReader = fakeReader()) {
  const chains = new Map([
    [
      1,
      {
        rpcUrl: "https://rpc.example",
        projectsAddress: projects,
        confirmations: 2,
        deploymentVersion: "6",
      },
    ],
  ]);
  return new RpcDeploymentVerifier(chains, SPONSOR, new Map([[1, receiptReader]]));
}

describe("RPC deployment verification", () => {
  it("accepts a confirmed canonical JBProjects Create event", async () => {
    await expect(
      verifier().verify({
        chainId: 1,
        projectId: "42",
        transactionHash: hash,
        deploymentVersion: "6",
        call,
      }),
    ).resolves.toEqual({ forwarded: false });
  });

  it("rejects reverted, unconfirmed, and mismatched project claims", async () => {
    await expect(
      verifier(fakeReader({ receipt: { ...successReceipt(createLog()), status: "reverted" } })).verify({
        chainId: 1,
        projectId: "42",
        transactionHash: hash,
        deploymentVersion: "6",
        call,
      }),
    ).rejects.toThrow("reverted");
    await expect(
      verifier().verify({
        chainId: 1,
        projectId: "43",
        transactionHash: hash,
        deploymentVersion: "6",
        call,
      }),
    ).rejects.toThrow("exactly");
    const unconfirmed: ReceiptReader = {
      ...fakeReader(),
      getBlockNumber: async () => 10n,
    };
    await expect(
      new RpcDeploymentVerifier(
        new Map([
          [
            1,
            {
              rpcUrl: "https://rpc.example",
              projectsAddress: projects,
              confirmations: 2,
              deploymentVersion: "6",
            },
          ],
        ]),
        SPONSOR,
        new Map([[1, unconfirmed]]),
      ).verify({
        chainId: 1,
        projectId: "42",
        transactionHash: hash,
        deploymentVersion: "6",
        call,
      }),
    ).rejects.toThrow("confirmations");
  });

  it("accepts the committed call inside a successful wrapper transaction", async () => {
    const wrapped = callFrame(wrapper, "0xabcdef01", {
      calls: [callFrame(deployer, call.data)],
    });
    await expect(
      verifier(fakeReader({ trace: wrapped })).verify({
        chainId: 1,
        projectId: "42",
        transactionHash: hash,
        deploymentVersion: "6",
        call,
      }),
    ).resolves.toEqual({ forwarded: false });
  });

  it("rejects mismatched, reverted, and malformed committed calls", async () => {
    const claim = {
      chainId: 1,
      projectId: "42",
      transactionHash: hash,
      deploymentVersion: "6",
      call,
    };
    await expect(
      verifier(fakeReader({ trace: callFrame(deployer, "0x87654321") })).verify(claim),
    ).rejects.toThrow("committed");
    await expect(
      verifier(
        fakeReader({
          trace: callFrame(wrapper, "0xabcdef01", {
            calls: [callFrame(deployer, call.data, { error: "execution reverted" })],
          }),
        }),
      ).verify(claim),
    ).rejects.toThrow("committed");
    await expect(
      verifier(fakeReader({ trace: { unexpected: true } })).verify(claim),
    ).rejects.toThrow("malformed");
    await expect(
      verifier().verify({ ...claim, call: { ...call, chainId: 10 } }),
    ).rejects.toThrow("chain does not match");
  });

  it("rejects a transaction which creates more than one project", async () => {
    await expect(
      verifier(fakeReader({ receipt: successReceipt(createLog(), createLog(43n)) })).verify({
        chainId: 1,
        projectId: "42",
        transactionHash: hash,
        deploymentVersion: "6",
        call,
      }),
    ).rejects.toThrow("exactly");
  });

  it("uses reviewed canonical V6 chain metadata with configured RPCs", () => {
    const chains = canonicalDeploymentChains(
      new Map(
        [1, 10, 8453, 42161, 11155111, 11155420, 84532, 421614].map((chainId) => [
          chainId,
          [`https://rpc-${chainId}.example`],
        ]),
      ),
    );
    expect([...chains.keys()]).toEqual([1, 10, 8453, 42161, 11155111, 11155420, 84532, 421614]);
    expect(chains.get(1)).toMatchObject({
      rpcUrl: "https://rpc-1.example",
      projectsAddress: "0x6017d1fba9dc279bfa0b03fd931c22e242ab3691",
      confirmations: 2,
      deploymentVersion: "6",
    });
    expect(() => canonicalDeploymentChains(new Map())).toThrow("needs an RPC upstream");
  });
});

describe("deployment verifier fast path and testnet configuration", () => {
  const upstreams: RpcUpstreams = new Map(
    [1, 10, 8453, 42161, 11155111, 11155420, 84532, 421614].map((chainId) => [
      chainId,
      [`https://rpc-${chainId}.example`],
    ]),
  );
  const chains = new Map(
    [84532, 8453].map((chainId) => [
      chainId,
      {
        rpcUrl: "https://rpc.example",
        projectsAddress: projects,
        confirmations: 2,
        deploymentVersion: "6",
      },
    ]),
  );
  const claim = {
    chainId: 1,
    projectId: "7",
    transactionHash: hash,
    deploymentVersion: "6",
    call,
  };

  it("a top-level transaction matching the call verifies without a trace", async () => {
    const reader = fakeReader({
      receipt: successReceipt(createLog(7n)),
      transaction: { to: call.to, input: call.data },
    });
    reader.traceTransaction = vi.fn(async () => {
      throw new Error("trace must not run");
    });
    const verifier = new RpcDeploymentVerifier(chains, SPONSOR, new Map([[84532, reader]]));
    await expect(
      verifier.verify({ ...claim, chainId: 84532, call: { ...call, chainId: 84532 } }),
    ).resolves.toEqual({ forwarded: false });
  });

  it("a relayed transaction falls back to the trace", async () => {
    const reader = fakeReader({
      receipt: successReceipt(createLog(7n)),
      transaction: { to: FORWARDER, input: "0xdeadbeef" },
      trace: callFrame(call.to, call.data),
    });
    const verifier = new RpcDeploymentVerifier(chains, SPONSOR, new Map([[8453, reader]]));
    await expect(
      verifier.verify({ ...claim, chainId: 8453, call: { ...call, chainId: 8453 } }),
    ).resolves.toEqual({ forwarded: false });
    expect(reader.traceTransaction).toHaveBeenCalled();
  });

  it("rejects when the transaction is not available from RPC", async () => {
    const reader = fakeReader({ receipt: successReceipt(createLog(7n)) });
    reader.getTransaction = vi.fn(async () => {
      throw new Error("rpc down");
    });
    const verifier = new RpcDeploymentVerifier(chains, SPONSOR, new Map([[84532, reader]]));
    await expect(
      verifier.verify({ ...claim, chainId: 84532, call: { ...call, chainId: 84532 } }),
    ).rejects.toThrow(DeploymentVerificationError);
  });

  it("testnets are configured", () => {
    const configured = canonicalDeploymentChains(upstreams);
    expect([...configured.keys()].sort()).toEqual(
      [1, 10, 8453, 42161, 84532, 421614, 11155111, 11155420].sort(),
    );
  });
});

describe("forwarded deployment calls", () => {
  const chainId = 84532;
  const chains = new Map([
    [chainId, { rpcUrl: "https://rpc.example", projectsAddress: projects, confirmations: 2, deploymentVersion: "6" }],
  ]);
  const forwardedClaim = { chainId, projectId: "7", transactionHash: hash, deploymentVersion: "6", call: { ...call, chainId } };

  it("accepts the committed calldata with the signer appended when the canonical forwarder made the call", async () => {
    const reader = fakeReader({
      receipt: successReceipt(createLog(7n)),
      transaction: { to: CANONICAL_FORWARDER, input: "0xdeadbeef" },
      trace: { type: "CALL", to: CANONICAL_FORWARDER, input: "0xdeadbeef", calls: [forwardedFrame(CANONICAL_FORWARDER, call.to, call.data)] },
    });
    const verifier = new RpcDeploymentVerifier(chains, SPONSOR, new Map([[chainId, reader]]));
    await expect(verifier.verify(forwardedClaim)).resolves.toEqual({ forwarded: true });
  });

  it("rejects appended bytes from any other caller", async () => {
    const reader = fakeReader({
      receipt: successReceipt(createLog(7n)),
      transaction: { to: FORWARDER, input: "0xdeadbeef" },
      trace: { type: "CALL", to: FORWARDER, input: "0xdeadbeef", calls: [forwardedFrame(FORWARDER, call.to, call.data)] },
    });
    const verifier = new RpcDeploymentVerifier(chains, SPONSOR, new Map([[chainId, reader]]));
    await expect(verifier.verify(forwardedClaim)).rejects.toThrow("did not execute the committed deployment call");
  });

  it("reads a forwarded call from another sender as a deployment Center did not make", async () => {
    const reader = fakeReader({
      receipt: successReceipt(createLog(7n)),
      transaction: { to: CANONICAL_FORWARDER, input: "0xdeadbeef" },
      trace: { type: "CALL", to: CANONICAL_FORWARDER, input: "0xdeadbeef", calls: [forwardedFrame(CANONICAL_FORWARDER, call.to, call.data, OTHER_SENDER_SUFFIX)] },
    });
    const verifier = new RpcDeploymentVerifier(chains, SPONSOR, new Map([[chainId, reader]]));
    await expect(verifier.verify(forwardedClaim)).resolves.toEqual({ forwarded: false });
  });

  it("reads every call as unforwarded with no sponsor configured", async () => {
    const reader = fakeReader({
      receipt: successReceipt(createLog(7n)),
      transaction: { to: CANONICAL_FORWARDER, input: "0xdeadbeef" },
      trace: { type: "CALL", to: CANONICAL_FORWARDER, input: "0xdeadbeef", calls: [forwardedFrame(CANONICAL_FORWARDER, call.to, call.data)] },
    });
    const verifier = new RpcDeploymentVerifier(chains, undefined, new Map([[chainId, reader]]));
    await expect(verifier.verify(forwardedClaim)).resolves.toEqual({ forwarded: false });
  });

  it("rejects a forwarder call whose suffix is not exactly one address", async () => {
    const reader = fakeReader({
      receipt: successReceipt(createLog(7n)),
      transaction: { to: CANONICAL_FORWARDER, input: "0xdeadbeef" },
      trace: { type: "CALL", to: CANONICAL_FORWARDER, input: "0xdeadbeef", calls: [forwardedFrame(CANONICAL_FORWARDER, call.to, call.data, `${SIGNER_SUFFIX}00`)] },
    });
    const verifier = new RpcDeploymentVerifier(chains, SPONSOR, new Map([[chainId, reader]]));
    await expect(verifier.verify(forwardedClaim)).rejects.toThrow("did not execute the committed deployment call");
  });
});
