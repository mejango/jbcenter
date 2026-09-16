import { randomBytes, randomUUID } from "node:crypto";
import { getAddress, hashTypedData, isAddress, keccak256, parseTransaction, serializeTransaction, type Address, type Hex } from "viem";
import { RestError } from "../core.js";
import { assertWalletCeremonyDraft, type WalletCeremonyDraft } from "./ceremonies.js";
/** A deployment approval stays a five-minute decision; only the signup window grew. */
const walletDeploymentApprovalMaxLifetimeMs = 300_000;
import { assertRegisteredWalletEnrollment, assertVerifiedWalletEnrollment, enrollmentDigest, type WalletEnrollment } from "./enrollment.js";
import { verifyWalletAssertion, type WalletAssertion } from "./webauthn.js";
import { validateSignedTransaction } from "../transactions/signed.js";
import type { RelayPolicy } from "../transactions/types.js";

export interface WalletDeploymentApproval {
  version: "center-wallet-deployment-v1" | "center-wallet-deployment-v2";
  id: string;
  enrollmentId: string;
  enrollmentCommitment: Hex;
  nonce: Hex;
  issuedAt: number;
  expiresAt: number;
  ceremony: WalletCeremonyDraft;
}
export interface WalletDeploymentFees {
  sender: Address;
  nonce: string;
  gas: string;
  maxFeePerGas: string;
  /** Positive by this deployment relay profile's fee policy. */
  maxPriorityFeePerGas: string;
}
export interface WalletDeploymentTemplate {
  version: "center-wallet-deployment-transaction-v1";
  approvalDigest: Hex;
  enrollmentCommitment: Hex;
  creationCommitment: Hex;
  predictedSafe: Address;
  initializerHash: Hex;
  sender: Address;
  transaction: {
    type: "eip1559";
    chainId: 8453;
    to: Address;
    data: Hex;
    value: "0";
    nonce: string;
    gas: string;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
    accessList: [];
  };
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const word = /^0x[0-9a-f]{64}$/;
const uint256Max = (1n << 256n) - 1n;
const commitment = (value: unknown): Hex => `0x${enrollmentDigest(value)}`;
function invalid(): never {
  throw new RestError(400, "WALLET_DEPLOYMENT_INVALID", "Wallet deployment context or immutable transaction is invalid.");
}
function fields(value: unknown, keys: readonly string[]): void {
  // Reuse the bounded public-JSON boundary, including rejection of accessors and custom serialization.
  enrollmentDigest(value);
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) invalid();
}
function timestamp(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
function lifetime(times: { issuedAt: number; expiresAt: number }, verifiedAt: number): void {
  if (!timestamp(times.issuedAt) || !timestamp(times.expiresAt) || times.issuedAt < verifiedAt ||
      times.expiresAt <= times.issuedAt || times.expiresAt - times.issuedAt > walletDeploymentApprovalMaxLifetimeMs) invalid();
}

const documentTypes = { WalletDeployment: [
  { name: "approvalId", type: "string" }, { name: "purpose", type: "string" }, { name: "version", type: "uint256" },
  { name: "enrollmentId", type: "string" }, { name: "enrollmentCommitment", type: "bytes32" },
  { name: "manifestCommitment", type: "bytes32" }, { name: "manifestRevision", type: "bytes32" },
  { name: "predictedSafe", type: "address" }, { name: "factory", type: "address" },
  { name: "initializerHash", type: "bytes32" }, { name: "creationCommitment", type: "bytes32" },
  { name: "calldataHash", type: "bytes32" }, { name: "nativeValue", type: "uint256" },
  { name: "rpId", type: "string" }, { name: "origin", type: "string" },
  { name: "nonce", type: "bytes32" }, { name: "issuedAtMs", type: "uint64" }, { name: "expiresAtMs", type: "uint64" },
] } as const;
// The receipt-independent identity of a registered enrollment. A verified receipt repeats these
// exact values (assertVerifiedWalletEnrollment checks that), so v1 documents are unchanged.
function identity(enrollment: WalletEnrollment) {
  const creation = enrollment.creation!;
  return { accountId: `eip155:8453:${creation.address.toLowerCase()}`, manifestCommitment: `0x${enrollmentDigest(enrollment.intent.manifest)}` as Hex,
    manifestRevision: enrollment.intent.manifest.revision, creationCommitment: `0x${enrollmentDigest(creation)}` as Hex };
}
/** v1 approvals bind the whole verified record and can only follow possession; v2 approvals bind
 * the registered identity so the first assertion after registration can approve creation. */
function binding(enrollment: WalletEnrollment, version: WalletDeploymentApproval["version"]) {
  if (version === "center-wallet-deployment-v1") return { commitment: assertVerifiedWalletEnrollment(enrollment), since: enrollment.receipt!.verifiedAt };
  if (version !== "center-wallet-deployment-v2") invalid();
  return { commitment: assertRegisteredWalletEnrollment(enrollment), since: enrollment.createdAt };
}
function document(enrollment: WalletEnrollment, approval: Omit<WalletDeploymentApproval, "ceremony">) {
  const creation = enrollment.creation!, receipt = identity(enrollment);
  return {
    domain: { name: "Juicebox Center Wallet Deployment", version: "1", chainId: 8453, verifyingContract: creation.address },
    types: structuredClone(documentTypes), primaryType: "WalletDeployment" as const,
    message: { approvalId: approval.id, purpose: "deploy", version: 1n, enrollmentId: enrollment.intent.id,
      enrollmentCommitment: approval.enrollmentCommitment, manifestCommitment: receipt.manifestCommitment,
      manifestRevision: receipt.manifestRevision, predictedSafe: creation.address, factory: creation.transaction.to,
      initializerHash: creation.initializerHash, creationCommitment: receipt.creationCommitment,
      calldataHash: keccak256(creation.transaction.data), nativeValue: 0n, rpId: enrollment.intent.rpId, origin: enrollment.intent.origin,
      nonce: approval.nonce, issuedAtMs: BigInt(approval.issuedAt), expiresAtMs: BigInt(approval.expiresAt) },
  };
}

/** Fresh, purpose-separated creation approval. The original registration expiry does not change
 * the frozen wallet identity. Issuing this draft grants no nonce, budget, signing or session authority. */
export function prepareWalletDeploymentApproval(enrollment: WalletEnrollment, times: { issuedAt: number; expiresAt: number }): WalletDeploymentApproval {
  try {
    const { commitment: enrollmentCommitment, since } = binding(enrollment, "center-wallet-deployment-v2");
    fields(times, ["issuedAt", "expiresAt"]);
    lifetime(times, since);
    const base = { version: "center-wallet-deployment-v2" as const, id: randomUUID(), enrollmentId: enrollment.intent.id,
      enrollmentCommitment, nonce: `0x${randomBytes(32).toString("hex")}` as Hex, ...times };
    const challenge = hashTypedData(document(enrollment, base));
    const result: WalletDeploymentApproval = { ...base, ceremony: { id: base.id, accountId: identity(enrollment).accountId,
      purpose: "deploy", expiresAt: base.expiresAt, contextDigest: enrollmentDigest(challenge),
      challenge: Buffer.from(challenge.slice(2), "hex").toString("base64url") } };
    walletDeploymentDocument(enrollment, result);
    return result;
  } catch { return invalid(); }
}

/** Reconstructs immutable context without clock admission: an already claimed deployment must
 * remain recoverable after approval expiry. Only fresh proof admission below checks the clock. */
export function walletDeploymentDocument(enrollment: WalletEnrollment, approval: WalletDeploymentApproval) {
  try {
    fields(approval, ["version", "id", "enrollmentId", "enrollmentCommitment", "nonce", "issuedAt", "expiresAt", "ceremony"]);
    const { commitment: enrollmentCommitment, since } = binding(enrollment, approval.version);
    if (!uuid.test(approval.id) || !word.test(approval.nonce) ||
        approval.enrollmentId !== enrollment.intent.id || approval.enrollmentCommitment !== enrollmentCommitment) invalid();
    lifetime(approval, since);
    const result = document(enrollment, approval), challenge = hashTypedData(result), ceremony = approval.ceremony;
    assertWalletCeremonyDraft(ceremony);
    if (ceremony.id !== approval.id || ceremony.accountId !== identity(enrollment).accountId || ceremony.purpose !== "deploy" ||
        ceremony.expiresAt !== approval.expiresAt || ceremony.contextDigest !== enrollmentDigest(challenge) ||
        ceremony.challenge !== Buffer.from(challenge.slice(2), "hex").toString("base64url")) invalid();
    return result;
  } catch { return invalid(); }
}

/** Crypto and point-in-time admission only. The future durable claim must recheck DB time and
 * consume this exact ceremony/proof with the enrollment, treasury lane, nonce and template atomically.
 * EIP1559 has no execution deadline: expiry cannot cancel an already claimed/signed deployment. */
export function verifyWalletDeploymentProof(enrollment: WalletEnrollment, approval: WalletDeploymentApproval,
  assertion: WalletAssertion, now: number): { verificationDigest: string } {
  try {
    enrollmentDigest(enrollment);
    enrollmentDigest(approval);
    const snapshot = structuredClone(enrollment), frozenApproval = structuredClone(approval);
    const challenge = hashTypedData(walletDeploymentDocument(snapshot, frozenApproval)), candidate = snapshot.candidate!;
    if (!timestamp(now) || now < frozenApproval.issuedAt || now >= frozenApproval.expiresAt) invalid();
    verifyWalletAssertion(assertion, { purpose: "deploy", challenge, rpId: snapshot.intent.rpId, origin: snapshot.intent.origin,
      requireUserHandle: true, credential: { id: candidate.credentialId, userHandle: candidate.userHandle,
        publicKey: candidate.publicKey, backupEligible: candidate.backupEligible } });
    return { verificationDigest: enrollmentDigest({ version: "center-wallet-deployment-proof-v1", documentHash: challenge,
      enrollmentCommitment: frozenApproval.enrollmentCommitment, credentialId: candidate.credentialId, publicKey: candidate.publicKey }) };
  } catch {
    throw new RestError(403, "WALLET_DEPLOYMENT_PROOF_INVALID", "A fresh matching wallet deployment approval is required.");
  }
}

function quantity(value: string, positive: boolean): bigint {
  if (typeof value !== "string" || value.length > 78 || !/^(0|[1-9][0-9]*)$/.test(value)) invalid();
  const number = BigInt(value);
  if (number > uint256Max || (positive && number === 0n)) invalid();
  return number;
}
function checkedPolicy(policy: RelayPolicy): RelayPolicy {
  if (!policy || !Array.isArray(policy.allowedChainIds) || !policy.allowedChainIds.includes(8453) ||
      !Number.isSafeInteger(policy.maximumRawBytes) || policy.maximumRawBytes < 1 || policy.maximumRawBytes > 131_072 ||
      [policy.maximumGas, policy.maximumFeePerGas, policy.maximumTransactionCost]
        .some(value => typeof value !== "bigint" || value <= 0n || value > uint256Max)) invalid();
  return { ...policy, allowedChainIds: [...policy.allowedChainIds] };
}

/** Server-owned fees/nonce only, bounded by the prepaid relay policy. This pure template does not
 * reserve funds or a nonce. Execution gas * fee cap excludes Base L1 and operator charges. */
export function prepareWalletDeploymentTemplate(enrollment: WalletEnrollment, approval: WalletDeploymentApproval,
  fees: WalletDeploymentFees, policy: RelayPolicy): WalletDeploymentTemplate {
  try {
    const approvalDigest = hashTypedData(walletDeploymentDocument(enrollment, approval));
    fields(fees, ["sender", "nonce", "gas", "maxFeePerGas", "maxPriorityFeePerGas"]);
    const bounds = checkedPolicy(policy), creation = enrollment.creation!;
    const nonce = quantity(fees.nonce, false), gas = quantity(fees.gas, true), maxFee = quantity(fees.maxFeePerGas, true);
    const priority = quantity(fees.maxPriorityFeePerGas, true);
    if (!isAddress(fees.sender) || BigInt(fees.sender) <= 1n || nonce > BigInt(Number.MAX_SAFE_INTEGER) ||
        gas > bounds.maximumGas || maxFee > bounds.maximumFeePerGas || priority > maxFee ||
        gas * maxFee > bounds.maximumTransactionCost) invalid();
    return { version: "center-wallet-deployment-transaction-v1", approvalDigest, enrollmentCommitment: approval.enrollmentCommitment,
      creationCommitment: commitment(creation), predictedSafe: creation.address, initializerHash: creation.initializerHash,
      sender: getAddress(fees.sender).toLowerCase() as Address,
      transaction: { type: "eip1559", chainId: 8453, ...creation.transaction, value: "0", nonce: fees.nonce, gas: fees.gas,
        maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, accessList: [] } };
  } catch { return invalid(); }
}

/** Validates only; never signs, reserves, publishes, reprices or normalizes stored bytes. Reuse the
 * general validator's low-s/sender/call/gas bounds, then enforce this relay's exact frozen envelope. */
export async function validateSignedWalletDeployment(input: { enrollment: WalletEnrollment; approval: WalletDeploymentApproval;
  template: WalletDeploymentTemplate; rawTransaction: Hex; policy: RelayPolicy }) {
  try {
    const policy = checkedPolicy(input.policy);
    // Snapshot bounded public state before asynchronous signature recovery. No caller-owned aliases
    // may change the template commitment or expected fields while recovery is pending.
    enrollmentDigest(input.template);
    const template = structuredClone(input.template), tx = template.transaction, rawTransaction = input.rawTransaction;
    const expected = prepareWalletDeploymentTemplate(input.enrollment, input.approval, { sender: template.sender,
      nonce: tx.nonce, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas }, policy);
    if (enrollmentDigest(template) !== enrollmentDigest(expected) || typeof rawTransaction !== "string" ||
        (rawTransaction.length - 2) / 2 > policy.maximumRawBytes || !/^0x02(?:[0-9a-fA-F]{2})+$/.test(rawTransaction)) invalid();
    const parsed = parseTransaction(rawTransaction);
    if (parsed.type !== "eip1559" || !parsed.r || !parsed.s || parsed.yParity === undefined ||
        parsed.nonce !== Number(tx.nonce) || parsed.gas !== BigInt(tx.gas) || parsed.maxFeePerGas !== BigInt(tx.maxFeePerGas) ||
        parsed.maxPriorityFeePerGas !== BigInt(tx.maxPriorityFeePerGas) || (parsed.accessList?.length ?? 0) !== 0 ||
        (parsed.value ?? 0n) !== 0n) invalid();
    // viem accepts some noncanonical RLP and canonicalizes during recovery. Compare bytes using
    // the original signature; this is only validation, never the envelope returned for dispatch.
    const canonical = serializeTransaction(parsed, { r: parsed.r, s: parsed.s, yParity: parsed.yParity });
    if (canonical.toLowerCase() !== rawTransaction.toLowerCase()) invalid();
    const result = await validateSignedTransaction(rawTransaction,
      { ...tx, label: "Deploy enrolled wallet", dependsOn: [], decoded: null }, template.sender, policy);
    return { hash: result.hash, rawTransaction: result.rawTransaction, sender: result.sender, nonce: result.nonce,
      templateCommitment: commitment(template), maximumExecutionCost: result.maximumCost };
  } catch { return invalid(); }
}
