import { isProxy } from "node:util/types";
import type { Address, Hex } from "viem";
import { enrollmentDigest } from "./enrollment.js";
import { RestError, type RestBlockEvidence } from "../core.js";

export interface WalletDeploymentObservation {
  version: "center-wallet-deployment-observation-v1";
  operationId: string;
  templateCommitment: Hex;
  transactionHash: Hex;
  observedAt: number;
  head: RestBlockEvidence | null;
  transaction: {
    state: "not-observed" | "pending" | "canonical-success" | "canonical-revert" | "reorged" | "nonce-conflict" | "unknown";
    reason: string | null;
    receipt: {
      block: RestBlockEvidence;
      transactionIndex: string;
      status: "success" | "reverted";
      gasUsed: string;
      effectiveGasPrice: string;
      logCount: number;
      logsHash: Hex;
    } | null;
    conflict: { transactionHash: Hex; block: RestBlockEvidence; transactionIndex: string } | null;
    nonce: { confirmed: string; pending: string } | null;
  };
  finality: { state: "finalized" | "unfinalized" | "unknown"; evidence: RestBlockEvidence | null };
  wallet: {
    state: "undeployed" | "verified" | "unknown";
    address: Address;
    initializerHash: Hex;
    stateHash: Hex | null;
    evidence: RestBlockEvidence | null;
    creationTransaction: Hex | null;
    reason: string | null;
  };
  fees: { executionWei: string | null; l1Wei: null; operatorWei: null; totalWei: null };
  dispatchEligible: false;
}

const maximumQuantity = (1n << 256n) - 1n;
function invalid(): never {
  throw new RestError(400, "WALLET_DEPLOYMENT_OBSERVATION_INVALID", "Deployment observation fields or evidence are inconsistent.");
}
/** Inspect only the schema's fixed object levels before using the shared JSON validator.
 * A proxy must be rejected before own-key/prototype traps, and accessors are never evaluated. */
function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length || keys.some(key => typeof key !== "string" || !names.includes(key))) invalid();
  const output: Record<string, unknown> = Object.create(null);
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
    output[key] = descriptor.value;
  }
  return output;
}
function choice<const T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) invalid();
  return value as T;
}
function hash(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value) || BigInt(value) === 0n) invalid();
  return value as Hex;
}
function quantity(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) > maximumQuantity) invalid();
  return value;
}
function reason(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 128 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)) invalid();
  return value;
}
function evidence(value: unknown): RestBlockEvidence {
  const v = fields(value, ["chainId", "blockNumber", "blockHash", "timestamp", "source"]);
  if (v.chainId !== 8453 || v.source !== "onchain") invalid();
  return { chainId: 8453, blockNumber: quantity(v.blockNumber), blockHash: hash(v.blockHash),
    timestamp: quantity(v.timestamp), source: "onchain" };
}

/** Shape and internal coherence only. This cannot establish RPC provenance, signing authority,
 * canonical chain facts or permission to advance a durable operation. */
export function assertWalletDeploymentObservation(value: unknown): WalletDeploymentObservation {
  try {
    const v = fields(value, ["version", "operationId", "templateCommitment", "transactionHash", "observedAt", "head", "transaction", "finality", "wallet", "fees", "dispatchEligible"]);
    if (v.version !== "center-wallet-deployment-observation-v1" || v.dispatchEligible !== false ||
      typeof v.operationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v.operationId) ||
      typeof v.observedAt !== "number" || !Number.isSafeInteger(v.observedAt) || v.observedAt <= 0) invalid();
    const t = fields(v.transaction, ["state", "reason", "receipt", "conflict", "nonce"]);
    const f = fields(v.finality, ["state", "evidence"]), w = fields(v.wallet, ["state", "address", "initializerHash", "stateHash", "evidence", "creationTransaction", "reason"]);
    const fees = fields(v.fees, ["executionWei", "l1Wei", "operatorWei", "totalWei"]);
    if (typeof w.address !== "string" || !/^0x[0-9a-f]{40}$/.test(w.address) || BigInt(w.address) <= 1n ||
      fees.l1Wei !== null || fees.operatorWei !== null || fees.totalWei !== null) invalid();
    let receipt: WalletDeploymentObservation["transaction"]["receipt"] = null;
    if (t.receipt !== null) {
      const r = fields(t.receipt, ["block", "transactionIndex", "status", "gasUsed", "effectiveGasPrice", "logCount", "logsHash"]);
      if (typeof r.logCount !== "number" || !Number.isSafeInteger(r.logCount) || Object.is(r.logCount, -0) || r.logCount < 0 || r.logCount > 10000) invalid();
      receipt = { block: evidence(r.block), transactionIndex: quantity(r.transactionIndex), status: choice(r.status, ["success", "reverted"]),
        gasUsed: quantity(r.gasUsed), effectiveGasPrice: quantity(r.effectiveGasPrice), logCount: r.logCount, logsHash: hash(r.logsHash) };
    }
    let conflict: WalletDeploymentObservation["transaction"]["conflict"] = null;
    if (t.conflict !== null) {
      const c = fields(t.conflict, ["transactionHash", "block", "transactionIndex"]);
      conflict = { transactionHash: hash(c.transactionHash), block: evidence(c.block), transactionIndex: quantity(c.transactionIndex) };
    }
    let nonce: WalletDeploymentObservation["transaction"]["nonce"] = null;
    if (t.nonce !== null) {
      const n = fields(t.nonce, ["confirmed", "pending"]);
      nonce = { confirmed: quantity(n.confirmed), pending: quantity(n.pending) };
      if (BigInt(nonce.pending) < BigInt(nonce.confirmed)) invalid();
    }
    const result: WalletDeploymentObservation = { version: "center-wallet-deployment-observation-v1", operationId: v.operationId,
      templateCommitment: hash(v.templateCommitment), transactionHash: hash(v.transactionHash), observedAt: v.observedAt,
      head: v.head === null ? null : evidence(v.head),
      transaction: { state: choice(t.state, ["not-observed", "pending", "canonical-success", "canonical-revert", "reorged", "nonce-conflict", "unknown"]),
        reason: reason(t.reason), receipt, conflict, nonce },
      finality: { state: choice(f.state, ["finalized", "unfinalized", "unknown"]), evidence: f.evidence === null ? null : evidence(f.evidence) },
      wallet: { state: choice(w.state, ["undeployed", "verified", "unknown"]), address: w.address as Address,
        initializerHash: hash(w.initializerHash), stateHash: w.stateHash === null ? null : hash(w.stateHash),
        evidence: w.evidence === null ? null : evidence(w.evidence), creationTransaction: w.creationTransaction === null ? null : hash(w.creationTransaction), reason: reason(w.reason) },
      fees: { executionWei: fees.executionWei === null ? null : quantity(fees.executionWei), l1Wei: null, operatorWei: null, totalWei: null }, dispatchEligible: false };
    const transaction = result.transaction, finality = result.finality, wallet = result.wallet, head = result.head;
    const canonical = transaction.state === "canonical-success" || transaction.state === "canonical-revert";
    if (!head && !["unknown", "reorged"].includes(transaction.state)) invalid();
    if (canonical) {
      if (!head || !receipt || receipt.status !== (transaction.state === "canonical-success" ? "success" : "reverted")) invalid();
    } else if (receipt || result.fees.executionWei !== null) invalid();
    if (["unknown", "reorged", "nonce-conflict"].includes(transaction.state) && !transaction.reason) invalid();
    if ((transaction.state === "nonce-conflict") !== (conflict !== null) || conflict?.transactionHash === result.transactionHash) invalid();
    if (receipt && (!head || BigInt(receipt.block.blockNumber) > BigInt(head.blockNumber))) invalid();
    if (conflict && (!head || BigInt(conflict.block.blockNumber) > BigInt(head.blockNumber))) invalid();
    if (finality.state === "unknown") {
      if (finality.evidence !== null) invalid();
    } else {
      if (!canonical || !receipt || !head || !finality.evidence || BigInt(finality.evidence.blockNumber) > BigInt(head.blockNumber)) invalid();
      const reached = BigInt(finality.evidence.blockNumber) >= BigInt(receipt.block.blockNumber);
      if ((finality.state === "finalized") !== reached) invalid();
    }
    if (wallet.state === "unknown") {
      if (!wallet.reason || wallet.stateHash !== null || wallet.evidence !== null || wallet.creationTransaction !== null) invalid();
    } else {
      if (!head || !wallet.evidence || wallet.reason !== null || wallet.evidence.blockNumber !== head.blockNumber) invalid();
      if (wallet.state === "verified") { if (wallet.stateHash === null || wallet.creationTransaction === null) invalid(); }
      else if (wallet.stateHash !== null || wallet.creationTransaction !== null) invalid();
    }
    // Every repeated height and hash must describe the same Base block, across all proof sections.
    const byHeight = new Map<string, RestBlockEvidence>(), byHash = new Map<Hex, RestBlockEvidence>();
    for (const block of [head, receipt?.block, conflict?.block, finality.evidence, wallet.evidence]) if (block) {
      for (const previous of [byHeight.get(block.blockNumber), byHash.get(block.blockHash)])
        if (previous && (previous.blockHash !== block.blockHash || previous.blockNumber !== block.blockNumber || previous.timestamp !== block.timestamp)) invalid();
      byHeight.set(block.blockNumber, block); byHash.set(block.blockHash, block);
    }
    if (receipt) {
      if (receipt.status === "reverted" && receipt.logCount !== 0) invalid();
      const execution = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
      if (execution > maximumQuantity || result.fees.executionWei !== execution.toString()) invalid();
    }
    // All original schema objects and scalars are admitted before the shared JSON boundary.
    enrollmentDigest(result);
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > 16_384) invalid();
    return structuredClone(result);
  } catch { return invalid(); }
}
