import type { Address, Hex } from "viem";
import type { RestBlockEvidence } from "../core.js";

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
  virtual_nonce: number;
}
export type RelayrIndependentEntry = Omit<RelayrEntry, 'virtual_nonce'> & { virtual_nonce?: never };

export interface RelayrPayment {
  chainId: number;
  to: Address;
  data: Hex;
  value: string;
  deadline: string;
}
export interface RelayrQuote<Entry extends RelayrEntry | RelayrIndependentEntry = RelayrEntry> {
  bundleUuid: string;
  entries: { txUuid: string; entry: Entry }[];
  payments: RelayrPayment[];
  commitment: Hex;
  observedAt: number;
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
