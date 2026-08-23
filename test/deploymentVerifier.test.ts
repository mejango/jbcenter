import { encodeAbiParameters, encodeEventTopics, zeroAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  canonicalDeploymentChains,
  RpcDeploymentVerifier,
  type ReceiptReader,
} from "../src/deploymentVerifier.js";

const projects = "0x1111111111111111111111111111111111111111" as const;
const deployer = "0x3333333333333333333333333333333333333333" as const;
const wrapper = "0x4444444444444444444444444444444444444444" as const;
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

function createLog(projectId = 42n) {
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

function reader(
  overrides: Partial<Receipt> = {},
  trace: unknown = { type: "CALL", to: deployer, input: call.data },
): ReceiptReader {
  const receipt: Receipt = {
    status: "success" as const,
    blockNumber: 10n,
    logs: [createLog()],
    ...overrides,
  };
  return {
    getTransactionReceipt: async () => receipt,
    getBlockNumber: async () => 11n,
    traceTransaction: async () => trace,
  };
}

function verifier(receiptReader = reader()) {
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
  return new RpcDeploymentVerifier(chains, new Map([[1, receiptReader]]));
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
    ).resolves.toBeUndefined();
  });

  it("rejects reverted, unconfirmed, and mismatched project claims", async () => {
    await expect(
      verifier(reader({ status: "reverted" })).verify({
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
      ...reader(),
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
    const wrapped = {
      type: "CALL",
      to: wrapper,
      input: "0xabcdef01",
      calls: [{ type: "CALL", to: deployer, input: call.data }],
    };
    await expect(
      verifier(reader({}, wrapped)).verify({
        chainId: 1,
        projectId: "42",
        transactionHash: hash,
        deploymentVersion: "6",
        call,
      }),
    ).resolves.toBeUndefined();
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
      verifier(reader({}, { type: "CALL", to: deployer, input: "0x87654321" })).verify(claim),
    ).rejects.toThrow("committed");
    await expect(
      verifier(
        reader({}, {
          type: "CALL",
          to: wrapper,
          input: "0xabcdef01",
          calls: [{ type: "CALL", to: deployer, input: call.data, error: "execution reverted" }],
        }),
      ).verify(claim),
    ).rejects.toThrow("committed");
    await expect(verifier(reader({}, { unexpected: true })).verify(claim)).rejects.toThrow(
      "malformed",
    );
    await expect(
      verifier().verify({ ...claim, call: { ...call, chainId: 10 } }),
    ).rejects.toThrow("chain does not match");
  });

  it("rejects a transaction which creates more than one project", async () => {
    await expect(
      verifier(reader({ logs: [createLog(), createLog(43n)] })).verify({
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
      new Map([1, 10, 8453, 42161].map((chainId) => [chainId, [`https://rpc-${chainId}.example`]])),
    );
    expect([...chains.keys()]).toEqual([1, 10, 8453, 42161]);
    expect(chains.get(1)).toMatchObject({
      rpcUrl: "https://rpc-1.example",
      projectsAddress: "0x6017d1fba9dc279bfa0b03fd931c22e242ab3691",
      confirmations: 2,
      deploymentVersion: "6",
    });
    expect(() => canonicalDeploymentChains(new Map())).toThrow("needs an RPC upstream");
  });
});
