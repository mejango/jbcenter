import type { Address, Hex } from "viem";
import type { RestActor, RestPlanDraft, RestRpc } from "../core.js";

export type StepState =
  | "waiting"
  | "reserved"
  | "submitted"
  | "unknown"
  | "confirming"
  | "confirmed"
  | "reverted"
  | "reorged";
export interface SemanticResult {
  /** Unknown modeled results block dependent steps; unmodeled calls are explicit. */
  status: "verified" | "failed" | "unknown" | "unmodeled";
  details?: unknown;
}
export interface StoredReceipt {
  transactionHash: Hex;
  blockHash: Hex;
  blockNumber: string;
  status: "success" | "reverted";
  confirmations: number;
  canonical: boolean;
  observedAt: number;
  logs: unknown[];
  /** Persistent records omit logs after semantic verification; these identify the full RPC log list. */
  logCount?: number;
  logsHash?: Hex;
  logsStored?: boolean;
}
export interface SignedAttempt {
  hash: Hex;
  rawTransaction: Hex;
  sender: Address;
  chainId: number;
  nonce: string;
  type: "legacy" | "eip2930" | "eip1559";
  gas: string;
  maximumFeePerGas: string;
  /** Native value + gas limit * fee cap; excludes additional rollup data/operator charges. */
  maximumCost: string;
  reservedAt: number;
  leaseToken: string;
  leaseUntil: number;
  dispatchCount: number;
  broadcastAt?: number;
  lastError?: { code: string; message: string };
}
export interface StoredStep {
  index: number;
  state: StepState;
  attempt?: SignedAttempt;
  /** A forwarded execution is not an owner-signed EOA transaction attempt. */
  externalExecution?: ExternalExecution;
  receipt?: StoredReceipt;
  semantic?: SemanticResult;
}
export interface ExternalExecution {
  transport: "relayr";
  bindingId: string;
  chainId: number;
  transactionHash?: Hex;
}
/** Internal, verified observation snapshot; never accepted from HTTP request bodies. */
export interface ExternalStepObservation {
  index: number;
  state: Exclude<StepState, "waiting">;
  transactionHash?: Hex;
  receipt?: StoredReceipt;
  semantic?: SemanticResult;
}
export interface ExternalExecutionObservation {
  stepIndex: number;
  chainId: number;
  providerState: string;
  state:
    | "pending"
    | "unknown"
    | "confirming"
    | "confirmed"
    | "reverted"
    | "reorged";
  hash?: Hex;
  receipt?: StoredReceipt;
  semantic?: SemanticResult;
  reason?: string;
}
/** Installed transport verifier; implementations must prove exact bound inner execution. */
export interface ExternalExecutionObserver {
  readonly kind: "relayr";
  observePlanStep(
    plan: StoredPlan,
    index: number,
    bindingId: string,
    options?: { signal?: AbortSignal },
  ): Promise<ExternalExecutionObservation>;
}
export interface StoredPlan {
  id: string;
  actor: RestActor;
  draft: RestPlanDraft;
  commitment: Hex;
  createdAt: number;
  expiresAt: number;
  revision: number;
  steps: StoredStep[];
}
export interface IdempotencyClaim {
  key: string;
  requestHash: string;
  operation: string;
}
export interface SubmissionClaim {
  actor: RestActor;
  planId: string;
  stepIndex: number;
  expectedRevision: number;
  attempt: SignedAttempt;
  idempotency: IdempotencyClaim;
  now: number;
  /** Server-verified owner authorization window in Unix seconds; never inferred from raw EOA signatures. */
  authorization?: { issuedAt: number; expiresAt: number };
  /** Reconcile-only repeats record their idempotency but never acquire a dispatch lease. */
  dispatch: boolean;
}
export interface RelayPolicy {
  planTtlMs: number;
  maximumPlanTtlMs: number;
  leaseMs: number;
  rpcTimeoutMs: number;
  maximumRawBytes: number;
  maximumGas: bigint;
  maximumFeePerGas: bigint;
  maximumTransactionCost: bigint;
  confirmations: number | Readonly<Record<number, number>>;
  allowedChainIds: readonly number[];
}
export interface SemanticVerifier {
  verify(
    plan: StoredPlan,
    stepIndex: number,
    receipt: StoredReceipt,
    rpc: RestRpc,
  ): Promise<SemanticResult>;
}
