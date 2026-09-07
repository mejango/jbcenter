import type { Address, Hex } from "viem";
import type { RestActor } from "../core.js";
import type { CompiledSession, InstalledSessionObservation } from "../smartAccounts/compiler/types.js";

export type SessionState = "prepared" | "installing" | "active" | "revoking" | "revoked" | "expired" | "stale";
export interface SessionAllocation {
  id: string;
  chainId: number;
  asset: Address;
  limit: string;
  assetReviewId: string;
}
export interface SessionAllocationGroup {
  id: string;
  assetIdentity: string;
  decimals: number;
  total: string;
  allocations: SessionAllocation[];
}
/** Verified server-side consent for this exact owner-approved setup/revocation plan. */
export interface SessionOwnerApproval {
  kind: "activation" | "revocation";
  accountId: string;
  sessionId: string;
  policyHash: Hex;
  compiledHash: Hex;
  planId: string;
  planCommitment: Hex;
  digest: Hex;
  issuedAt: number;
  expiresAt: number;
}
export interface SessionCanonicalObservation {
  /** Comes from the trusted installed-policy verifier, never an HTTP proof body. */
  installed: InstalledSessionObservation;
  observedAt: number;
  /** True only after the host independently verifies chain finality for this exact block. */
  finalized: boolean;
  proofHash: Hex;
}
export interface SessionInvalidation {
  reason: "reorg" | "configuration-changed" | "counter-reset" | "grant-inactive" | "binding-unlinked" | "verification-unavailable";
  priorProofHash: Hex | null;
  observedAt: number;
}
export interface StoredSession {
  id: string;
  actor: RestActor;
  compiled: CompiledSession;
  /** Complete canonical administration baseline from the verified preparation block. Immutable. */
  preparedAdministration: { epoch: string; hash: Hex };
  /** Full normalized approved grouping, including sibling-chain allocations; no shared balance is inferred. */
  allocationGroups: SessionAllocationGroup[];
  allocationManifestHash: Hex;
  createdAt: number;
  updatedAt: number;
  revision: number;
  state: SessionState;
  activation?: SessionOwnerApproval;
  revocation?: SessionOwnerApproval;
  supersededApprovals?: { approval: SessionOwnerApproval; supersededAt: number }[];
  observation?: SessionCanonicalObservation;
  invalidation?: SessionInvalidation;
  /** Finalized retirement only; identity tombstones remain permanent. */
  reservationsReleased: boolean;
}
export interface SessionIdempotency {
  key: string;
  requestHash: string;
}
export interface SessionClaim {
  actor: RestActor;
  id: string;
  expectedRevision: number;
  approval: SessionOwnerApproval;
  idempotency: SessionIdempotency;
  now: number;
}
export interface SessionObservationUpdate {
  actor: RestActor;
  id: string;
  expectedRevision: number;
  expectedObservationHash: Hex | null;
  observation: SessionCanonicalObservation;
  now: number;
}
export interface SessionInvalidationUpdate {
  actor: RestActor;
  id: string;
  expectedRevision: number;
  reason: SessionInvalidation["reason"];
  now: number;
}
export interface SessionMutationResult { record: StoredSession; applied: boolean }
export interface SessionClaimResult { record: StoredSession; claimed: boolean }
export interface SessionListOptions { limit: number; cursor?: string }
export interface UserOperationSessionBinding {
  id: string;
  policyHash: Hex;
  compiledHash: Hex;
  generation: string;
  grantId: string;
  permissionId: Hex;
  sessionKey: Address;
  observationHash: Hex;
}
export interface SessionQuota {
  sessionId: string;
  state: SessionState;
  allocationManifestHash: Hex;
  approvedGroups: SessionAllocationGroup[];
  localAllocations: SessionAllocation[];
  counters: InstalledSessionObservation["counters"] | null;
  observation: SessionCanonicalObservation | null;
  reservationsReleased: boolean;
  executionAuthority: false;
  balanceSource: "onchain-only";
  atomicAcrossChains: false;
}
