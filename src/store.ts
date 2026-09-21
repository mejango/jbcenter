import type { Address, Hex } from "viem";
import type {
  Deployment,
  Intent,
  IntentDeploy,
  IntentDeployStatus,
  IntentEnvelope,
  IntentMetadata,
  SearchPage,
} from "./types.js";

export type NewIntent = IntentMetadata & {
  contentHash: Hex;
  envelope: IntentEnvelope;
  publisher: Address;
  signature: Hex;
  submittedBy: string;
  jbBytes: number;
};

export type StorageLimits = {
  maxIntents: number;
  maxBytes: number;
};

export type NewDeployment = {
  chainId: number;
  projectId: string;
  transactionHash: Hex;
};

export type DeployPatch = {
  status: IntentDeployStatus;
  transactionHash?: Hex;
  bundleUuid?: string;
  error?: string;
  spentWei?: bigint;
};

export interface Store {
  health(): Promise<void>;
  consumeRequest(
    client: string,
    limit: number,
    windowSeconds?: number,
  ): Promise<{ allowed: boolean; remaining: number }>;
  /** Removes rate-limit windows older than two days; returns the count removed. */
  cleanupRateLimits(): Promise<number>;
  createIntent(
    value: NewIntent,
    limits: StorageLimits,
  ): Promise<{ intent: Intent; created: boolean }>;
  getIntent(id: string): Promise<Intent | null>;
  search(query: string, limit: number, offset: number): Promise<SearchPage>;
  recordDeployment(intentId: string, value: NewDeployment): Promise<Deployment>;
  queueDeploys(
    intentId: string,
    chainIds: number[],
    requester: string,
    reservedWeiPerChain: bigint,
  ): Promise<IntentDeploy[]>;
  listDeploys(intentId: string): Promise<IntentDeploy[]>;
  claimQueuedDeploys(
    leaseSeconds: number,
    limit: number,
  ): Promise<{ intentId: string; chainIds: number[] }[]>;
  updateDeploy(intentId: string, chainId: number, patch: DeployPatch): Promise<void>;
  /** Give a claim back unspent: the lease ends and the attempt is not counted. */
  /** Hands a claim back without spending an attempt; the rows wait five minutes before the next pass. */
  releaseClaim(intentId: string, chainIds: number[]): Promise<void>;
  sponsoredWeiSince(since: Date): Promise<bigint>;
}

export class ConflictError extends Error {}
export class StorageLimitError extends Error {}
