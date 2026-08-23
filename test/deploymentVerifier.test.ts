import { encodeAbiParameters, encodeEventTopics, zeroAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  canonicalDeploymentChains,
  RpcDeploymentVerifier,
  type ReceiptReader,
} from "../src/deploymentVerifier.js";

const projects = "0x1111111111111111111111111111111111111111" as const;
const hash = `0x${"22".repeat(32)}` as const;
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

function reader(overrides: Partial<Receipt> = {}): ReceiptReader {
  const receipt: Receipt = {
    status: "success" as const,
    blockNumber: 10n,
    logs: [
      {
        address: projects,
        topics: encodeEventTopics({
          abi: createEvent,
          eventName: "Create",
          args: { projectId: 42n, owner: zeroAddress },
        }) as unknown as readonly Hex[],
        data: encodeAbiParameters([{ type: "address" }], [zeroAddress]),
      },
    ],
    ...overrides,
  };
  return {
    getTransactionReceipt: async () => receipt,
    getBlockNumber: async () => 11n,
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
      }),
    ).rejects.toThrow("reverted");
    await expect(
      verifier().verify({
        chainId: 1,
        projectId: "43",
        transactionHash: hash,
        deploymentVersion: "6",
      }),
    ).rejects.toThrow("did not create");
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
      }),
    ).rejects.toThrow("confirmations");
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
