import { encodeAbiParameters, encodeEventTopics, zeroAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  RpcDeploymentVerifier,
  parseChainRpcConfig,
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

  it("validates chain configuration", () => {
    expect(
      parseChainRpcConfig(
        JSON.stringify({
          1: {
            rpcUrl: "https://rpc.example",
            projectsAddress: projects,
            confirmations: 3,
            deploymentVersion: "6",
          },
        }),
      ).get(1)?.confirmations,
    ).toBe(3);
    expect(() => parseChainRpcConfig("{}")).toThrow("at least one chain");
  });
});
