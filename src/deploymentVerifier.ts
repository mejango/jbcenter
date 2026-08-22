import {
  createPublicClient,
  decodeEventLog,
  getAddress,
  http,
  isAddressEqual,
  type Address,
  type Hex,
} from "viem";

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

export function parseChainRpcConfig(value: string | undefined): Map<number, ChainRpcConfig> {
  if (!value) throw new Error("JUICE_CENTRAL_CHAINS is required");
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error("JUICE_CENTRAL_CHAINS must be valid JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("JUICE_CENTRAL_CHAINS must be an object keyed by chain ID");
  }
  const result = new Map<number, ChainRpcConfig>();
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    const chainId = Number(key);
    const config = entry as Record<string, unknown>;
    const confirmations = config.confirmations === undefined ? 2 : Number(config.confirmations);
    if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error(`Invalid chain ID: ${key}`);
    if (typeof config.rpcUrl !== "string" || !/^https?:\/\//u.test(config.rpcUrl)) {
      throw new Error(`Chain ${key} needs an HTTP(S) rpcUrl`);
    }
    if (!Number.isSafeInteger(confirmations) || confirmations < 1 || confirmations > 1_000) {
      throw new Error(`Chain ${key} confirmations must be between 1 and 1000`);
    }
    if (
      typeof config.deploymentVersion !== "string" ||
      !config.deploymentVersion.trim() ||
      config.deploymentVersion.length > 64
    ) {
      throw new Error(`Chain ${key} needs a deploymentVersion`);
    }
    try {
      result.set(chainId, {
        rpcUrl: config.rpcUrl,
        projectsAddress: getAddress(String(config.projectsAddress)),
        confirmations,
        deploymentVersion: config.deploymentVersion,
      });
    } catch {
      throw new Error(`Chain ${key} has an invalid projectsAddress`);
    }
  }
  if (result.size === 0) throw new Error("JUICE_CENTRAL_CHAINS must configure at least one chain");
  return result;
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
