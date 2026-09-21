import type { Address, Hex } from "viem";

/** REST reads and the signed-transaction relay use configured, bounded upstreams. */
export interface RestRpc {
  request(
    chainId: number,
    method: string,
    params: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export interface RestBlockEvidence {
  chainId: number;
  blockNumber: string;
  blockHash: Hex;
  timestamp: string;
  source: "onchain";
}

export interface RestCall {
  chainId: number;
  to: Address;
  data: Hex;
  value: string;
  label: string;
  dependsOn: number[];
  decoded: unknown;
}

/** A reviewable plan contains no key material and conveys no signing authority. */
export interface RestPlanDraft {
  operation: string;
  account: Address;
  project?: { chainId: number; projectId: string; version?: 6 };
  calls: RestCall[];
  evidence: RestBlockEvidence[];
  summary: unknown;
  warnings: string[];
}

export interface RestActor {
  accountId: string;
  /** Bot grant ID, or an owner principal distinguished from every bot. */
  principalId: string;
}

export class RestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "RestError";
  }
}
