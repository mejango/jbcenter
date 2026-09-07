import type { Address, Hex } from "viem";
import type { RestActor, RestBlockEvidence } from "../core.js";
import type { SemanticResult, StoredReceipt } from "../transactions/types.js";

export interface ForwardRequest {
  from: Address;
  to: Address;
  value: string;
  gas: string;
  nonce: string;
  deadline: string;
  data: Hex;
}
export interface PreparedForwardRequest {
  stepIndex: number;
  chainId: number;
  forwarder: Address;
  forwarderCodeHash: Hex;
  targetCodeHash: Hex;
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Address;
  };
  message: ForwardRequest;
  evidence: RestBlockEvidence;
}
export interface RelayrEntry {
  chain: number;
  target: Address;
  data: Hex;
  value: string;
  virtual_nonce: 0;
}
export interface RelayrPayment {
  chainId: number;
  to: Address;
  data: Hex;
  value: string;
  deadline: string;
}
export interface RelayrQuote {
  bundleUuid: string;
  entries: { txUuid: string; entry: RelayrEntry }[];
  payments: RelayrPayment[];
  commitment: Hex;
  observedAt: number;
}
export interface DestinationObservation {
  stepIndex: number;
  chainId: number;
  /** Provider status is only a hint for locating a transaction. */
  providerState: string;
  state: "pending" | "unknown" | "confirming" | "confirmed" | "reverted";
  hash?: Hex;
  receipt?: StoredReceipt;
  semantic?: SemanticResult;
  reason?: string;
}
export interface SponsorshipRecord {
  id: string;
  actor: RestActor;
  planId: string;
  planCommitment: Hex;
  preparationKey: string;
  inputHash: Hex;
  commitment: Hex;
  requests: PreparedForwardRequest[];
  createdAt: number;
  expiresAt: number;
  revision: number;
  state: "prepared" | "submitting" | "submission_unknown" | "quoted";
  submission?: {
    key: string;
    hash: Hex;
    entries: RelayrEntry[];
    startedAt: number;
  };
  quote?: RelayrQuote;
  quoteRuntimeVerified?: boolean;
  observations: DestinationObservation[];
}
export interface SponsorshipPolicy {
  enabled: boolean;
  allowedChainIds: readonly number[];
  requestTtlSeconds: number;
  minimumRemainingSeconds: number;
  maximumGas: bigint;
  maximumFundingValue: bigint;
  confirmations: number;
  rpcTimeoutMs: number;
  providerTimeoutMs: number;
}
export interface SponsorshipPrepareInput {
  stepIndexes?: number[];
}
export interface SponsorshipSubmission {
  signatures: Hex[];
}
