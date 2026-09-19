import type { Address, Hex } from "viem";
import type {
  Deployment,
  Intent,
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

export interface Store {
  health(): Promise<void>;
  consumeRequest(
    client: string,
    limit: number,
    windowSeconds?: number,
  ): Promise<{ allowed: boolean; remaining: number }>;
  createIntent(
    value: NewIntent,
    limits: StorageLimits,
  ): Promise<{ intent: Intent; created: boolean }>;
  getIntent(id: string): Promise<Intent | null>;
  search(query: string, limit: number, offset: number): Promise<SearchPage>;
  recordDeployment(intentId: string, value: NewDeployment): Promise<Deployment>;
}

export class ConflictError extends Error {}
export class StorageLimitError extends Error {}
