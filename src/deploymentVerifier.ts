import {
  createPublicClient,
  decodeEventLog,
  getAddress,
  http,
  isAddressEqual,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import type { RpcUpstreams } from "./rpc.js";
import type { DeploymentCall } from "./types.js";

export const CREATE_TOPIC: Hex = keccak256(stringToHex("Create(uint256,address,address)"));

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
  call: DeploymentCall;
};

export type ReceiptReader = {
  getTransactionReceipt(args: { hash: Hex }): Promise<{
    status: "success" | "reverted";
    blockNumber: bigint;
    logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[];
  }>;
  getBlockNumber(): Promise<bigint>;
  getTransaction(args: { hash: Hex }): Promise<{ to: Address | null; input: Hex }>;
  traceTransaction(hash: Hex): Promise<unknown>;
};

export class DeploymentVerificationError extends Error {}

export interface DeploymentVerifier {
  verify(claim: DeploymentClaim): Promise<void>;
}

type TraceCall = {
  type: string;
  from: Address | null;
  to: Address;
  input: Hex;
  error?: string;
  calls: TraceCall[];
};

/** The canonical ERC2771Forwarder, deployed at the same address on every supported chain. */
export const FORWARDER = "0x3ba60b60933916a7c87d0860dcee62a0ce34e3e2" as Address;
const FORWARDED_SENDER_HEX_LENGTH = 40;

const MAX_TRACE_DEPTH = 128;
const MAX_TRACE_FRAMES = 100_000;

function traceCall(value: unknown, depth: number, frames: { count: number }): TraceCall {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DeploymentVerificationError("RPC returned a malformed transaction trace");
  }
  if (depth > MAX_TRACE_DEPTH || ++frames.count > MAX_TRACE_FRAMES) {
    throw new DeploymentVerificationError("Transaction trace exceeds verification limits");
  }
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.type !== "string" ||
    typeof raw.to !== "string" ||
    typeof raw.input !== "string" ||
    !/^0x(?:[0-9a-f]{2})*$/iu.test(raw.input)
  ) {
    throw new DeploymentVerificationError("RPC returned a malformed transaction trace");
  }
  let to: Address;
  let from: Address | null = null;
  try {
    to = getAddress(raw.to);
    if (typeof raw.from === "string") from = getAddress(raw.from);
  } catch {
    throw new DeploymentVerificationError("RPC returned a malformed transaction trace");
  }
  if (raw.error !== undefined && typeof raw.error !== "string") {
    throw new DeploymentVerificationError("RPC returned a malformed transaction trace");
  }
  if (raw.calls !== undefined && !Array.isArray(raw.calls)) {
    throw new DeploymentVerificationError("RPC returned a malformed transaction trace");
  }
  return {
    type: raw.type,
    from,
    to,
    input: raw.input as Hex,
    ...(raw.error ? { error: raw.error } : {}),
    calls: (raw.calls ?? []).map((call) => traceCall(call, depth + 1, frames)),
  };
}

/**
 * A direct call carries the committed calldata verbatim. The ERC-2771 forwarder appends the
 * signer's 20-byte address, so a call made by the canonical forwarder matches when its input is
 * the committed calldata followed by exactly one address.
 */
function executesCommittedData(call: TraceCall, data: Hex): boolean {
  const input = call.input.toLowerCase();
  const committed = data.toLowerCase();
  if (input === committed) return true;
  return (
    call.from !== null &&
    isAddressEqual(call.from, FORWARDER) &&
    input.length === committed.length + FORWARDED_SENDER_HEX_LENGTH &&
    input.startsWith(committed)
  );
}

function containsCommittedCall(trace: unknown, expected: DeploymentCall): boolean {
  const root = traceCall(trace, 0, { count: 0 });
  const stack: { call: TraceCall; ancestorFailed: boolean }[] = [
    { call: root, ancestorFailed: false },
  ];
  while (stack.length) {
    const { call, ancestorFailed } = stack.pop()!;
    const failed = ancestorFailed || Boolean(call.error);
    if (!failed && call.type.toUpperCase() === "CALL" && isAddressEqual(call.to, expected.to) && executesCommittedData(call, expected.data)) {
      return true;
    }
    stack.push(...call.calls.map((child) => ({ call: child, ancestorFailed: failed })));
  }
  return false;
}

export const PROJECTS = "0x6017d1fba9dc279bfa0b03fd931c22e242ab3691" as Address;
const DEPLOYMENT_CHAIN_IDS = [1, 10, 8453, 42161, 11155111, 11155420, 84532, 421614] as const;

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
      const client = createPublicClient({
        chain: {
          id: chainId,
          name: `Chain ${chainId}`,
          nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
          rpcUrls: { default: { http: [config.rpcUrl] } },
        },
        transport: http(config.rpcUrl, { timeout: 20_000, retryCount: 2 }),
      });
      const request = client.request as unknown as (args: {
        method: string;
        params: readonly unknown[];
      }) => Promise<unknown>;
      this.readers.set(chainId, {
        getTransactionReceipt: (args) => client.getTransactionReceipt(args),
        getBlockNumber: () => client.getBlockNumber(),
        getTransaction: (args) =>
          client.getTransaction(args).then((transaction) => ({
            to: transaction.to,
            input: transaction.input,
          })),
        traceTransaction: (hash) =>
          request({
            method: "debug_traceTransaction",
            params: [hash, { tracer: "callTracer", timeout: "15s" }],
          }),
      });
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
    if (claim.call.chainId !== claim.chainId) {
      throw new DeploymentVerificationError("Deployment call chain does not match the claim");
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
    const createdProjectIds: bigint[] = [];
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
        createdProjectIds.push(decoded.args.projectId);
      } catch {
        // The canonical contract emits other events in the same transaction.
      }
    }
    if (createdProjectIds.length !== 1 || createdProjectIds[0] !== BigInt(claim.projectId)) {
      throw new DeploymentVerificationError(
        "Transaction must create exactly the claimed project on canonical JBProjects",
      );
    }
    let transaction: Awaited<ReturnType<ReceiptReader["getTransaction"]>>;
    try {
      transaction = await reader.getTransaction({ hash: claim.transactionHash });
    } catch {
      throw new DeploymentVerificationError("Transaction is not available from RPC");
    }
    const direct =
      transaction.to?.toLowerCase() === claim.call.to.toLowerCase() &&
      transaction.input.toLowerCase() === claim.call.data.toLowerCase();
    if (!direct) {
      let trace: unknown;
      try {
        trace = await reader.traceTransaction(claim.transactionHash);
      } catch (error) {
        if (error instanceof DeploymentVerificationError) throw error;
        throw new DeploymentVerificationError("Transaction trace is not available from RPC");
      }
      if (!containsCommittedCall(trace, claim.call)) {
        throw new DeploymentVerificationError(
          "The transaction did not execute the committed deployment call",
        );
      }
    }
  }
}
