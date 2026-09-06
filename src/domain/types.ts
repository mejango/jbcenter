import type { Address, Hex, PublicClient } from 'viem';
import type { JBChainId } from '@bananapus/nana-sdk-core';

export type ChainId = JBChainId;
export interface ProjectRef {
  chainId: ChainId;
  projectId: string;
  version?: 6;
}
export interface BlockEvidence {
  chainId: ChainId;
  blockNumber: string;
  blockHash: Hex;
  timestamp: string;
  source: 'rpc';
}
export interface RpcSnapshot {
  client: PublicClient;
  evidence: BlockEvidence;
}
export interface RpcProvider {
  snapshot(chainId: ChainId, blockNumber?: bigint): Promise<RpcSnapshot>;
  client(chainId: ChainId): PublicClient;
}
export type Observation<T> =
  | { status: 'known'; value: T }
  | { status: 'unknown'; error: { code: string; message: string; retryable: boolean } };

export interface PreparedCall {
  chainId: ChainId;
  to: Address;
  data: Hex;
  value: string;
  label: string;
  decoded: { functionName: string; args: unknown };
  /** Indices of transactions which must be confirmed before simulation/execution. */
  dependsOn: number[];
}
export interface PlanDraft {
  operation: string;
  account: Address;
  project?: ProjectRef;
  calls: PreparedCall[];
  evidence: BlockEvidence[];
  summary: unknown;
  warnings: string[];
}
