import {
  createPublicClient,
  decodeEventLog,
  http,
  isAddressEqual,
  type Address,
  type Hex,
} from "viem";
import type { RpcUpstreams } from "./rpc.js";

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

export type ChainRpcConfig = {
  rpcUrl: string;
  projectsAddress: Address;
  confirmations: number;
  deploymentVersion: string;
};

export type DeploymentClaim = {
  chainId: number;
  projectId: string;
  transactionHash: Hex;
  deploymentVersion: string;
};

export type ReceiptReader = {
  getTransactionReceipt(args: { hash: Hex }): Promise<{
    status: "success" | "reverted";
    blockNumber: bigint;
    logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[];
  }>;
  getBlockNumber(): Promise<bigint>;
};

export class DeploymentVerificationError extends Error {}

export interface DeploymentVerifier {
  verify(claim: DeploymentClaim): Promise<void>;
}

const PROJECTS = "0x6017d1fba9dc279bfa0b03fd931c22e242ab3691" as Address;
const DEPLOYMENT_CHAIN_IDS = [1, 10, 8453, 42161] as const;

export function canonicalDeploymentChains(upstreams: RpcUpstreams): Map<number, ChainRpcConfig> {
  return new Map(
    DEPLOYMENT_CHAIN_IDS.map((chainId) => {
      const rpcUrl = upstreams.get(chainId)?.[0];
      if (!rpcUrl) throw new Error(`Canonical deployment chain ${chainId} needs an RPC upstream`);
      return [
        chainId,
        {
          rpcUrl,
          projectsAddress: PROJECTS,
          confirmations: 2,
          deploymentVersion: "6",
        },
      ];
    }),
  );
}

export class RpcDeploymentVerifier implements DeploymentVerifier {
  private readonly readers: Map<number, ReceiptReader>;

  constructor(
    private readonly chains: Map<number, ChainRpcConfig>,
    readers?: Map<number, ReceiptReader>,
  ) {
    this.readers = readers ?? new Map<number, ReceiptReader>();
    if (readers) return;
    for (const [chainId, config] of chains) {
      this.readers.set(
        chainId,
        createPublicClient({
          chain: {
            id: chainId,
            name: `Chain ${chainId}`,
            nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
            rpcUrls: { default: { http: [config.rpcUrl] } },
          },
          transport: http(config.rpcUrl, { timeout: 10_000, retryCount: 2 }),
        }),
      );
    }
  }

  async verify(claim: DeploymentClaim): Promise<void> {
    const config = this.chains.get(claim.chainId);
    const reader = this.readers.get(claim.chainId);
    if (!config || !reader) {
      throw new DeploymentVerificationError(`Chain ${claim.chainId} is not configured`);
    }
    if (claim.deploymentVersion !== config.deploymentVersion) {
      throw new DeploymentVerificationError(
        `Chain ${claim.chainId} is not configured for deployment version ${claim.deploymentVersion}`,
      );
    }
    let receipt: Awaited<ReturnType<ReceiptReader["getTransactionReceipt"]>>;
    try {
      receipt = await reader.getTransactionReceipt({ hash: claim.transactionHash });
    } catch {
      throw new DeploymentVerificationError("Transaction receipt is not available from RPC");
    }
    if (receipt.status !== "success") {
      throw new DeploymentVerificationError("Deployment transaction reverted");
    }
    let head: bigint;
    try {
      head = await reader.getBlockNumber();
    } catch {
      throw new DeploymentVerificationError("Current chain height is not available from RPC");
    }
    const confirmations = head >= receipt.blockNumber ? head - receipt.blockNumber + 1n : 0n;
    if (confirmations < BigInt(config.confirmations)) {
      throw new DeploymentVerificationError(
        `Deployment has ${confirmations} confirmations; ${config.confirmations} required`,
      );
    }
    const expectedProjectId = BigInt(claim.projectId);
    for (const log of receipt.logs) {
      if (!isAddressEqual(log.address, config.projectsAddress)) continue;
      try {
        const decoded = decodeEventLog({
          abi: createEvent,
          eventName: "Create",
          data: log.data,
          topics: log.topics as [Hex, ...Hex[]],
          strict: true,
        });
        if (decoded.args.projectId === expectedProjectId) return;
      } catch {
        // The canonical contract emits other events in the same transaction.
      }
    }
    throw new DeploymentVerificationError(
      "Transaction did not create the claimed project on canonical JBProjects",
    );
  }
}
