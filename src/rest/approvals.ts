import {
  hashTypedData, keccak256, recoverAddress, sha256, stringToHex,
  type Address, type Hex,
} from "viem";
import { RestError } from "./core.js";
import { parseAccountId, validateAudience, type ContractOwnerVerifier } from "./auth/signatures.js";

/** Identifies one immutable effect, including the exact serialized transaction signature. */
export type TransactionApprovalBinding = {
  accountId: string;
  principalId: string;
  planId: string;
  commitment: Hex;
  stepIndex: number;
  transactionHash: Hex;
};
export type TransactionApprovalClaims = TransactionApprovalBinding & {
  issuedAt: number;
  expiresAt: number;
  nonce: Hex;
};
export type TransactionApproval = TransactionApprovalClaims & { signature: Hex };
export type SponsorshipApprovalBinding = {
  accountId: string;
  principalId: string;
  sponsorshipId: string;
  commitment: Hex;
  submissionHash: Hex;
};
export type SponsorshipApprovalClaims = SponsorshipApprovalBinding & {
  issuedAt: number;
  expiresAt: number;
  nonce: Hex;
};
export type SponsorshipApproval = SponsorshipApprovalClaims & { signature: Hex };
export type TransactionApprovalOptions = {
  /** Trusted Unix seconds, refreshed after every awaited signature check. */
  now?: () => number;
  verifyContractOwner?: ContractOwnerVerifier;
  signal?: AbortSignal;
};
export type VerifiedTransactionApproval = {
  readonly claims: Readonly<TransactionApprovalClaims>;
  readonly ownerAddress: Address;
  readonly authorityChainId: number;
  /** Recheck under the same durable lock that admits dispatch, using its database clock. */
  assertFreshAt(now: number): void;
};
export type VerifiedSponsorshipApproval = Omit<VerifiedTransactionApproval, "claims"> & {
  readonly claims: Readonly<SponsorshipApprovalClaims>;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const bytes32 = /^0x[0-9a-fA-F]{64}$/;
const fields = ["accountId", "principalId", "planId", "commitment", "stepIndex", "transactionHash", "issuedAt", "expiresAt", "nonce"] as const;
const types = {
  CenterTransactionApproval: [
    { name: "audience", type: "string" },
    { name: "accountId", type: "string" },
    { name: "principalId", type: "string" },
    { name: "planId", type: "string" },
    { name: "commitment", type: "bytes32" },
    { name: "stepIndex", type: "uint32" },
    { name: "transactionHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;
const sponsorshipFields = ["accountId", "principalId", "sponsorshipId", "commitment", "submissionHash", "issuedAt", "expiresAt", "nonce"] as const;
const sponsorshipTypes = {
  CenterSponsorshipApproval: [
    { name: "audience", type: "string" },
    { name: "accountId", type: "string" },
    { name: "principalId", type: "string" },
    { name: "sponsorshipId", type: "string" },
    { name: "commitment", type: "bytes32" },
    { name: "submissionHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

function invalid(message = "The owner approval is malformed"): never {
  throw new RestError(400, "INVALID_OWNER_APPROVAL", message);
}
function time(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function identity(input: { accountId: string; principalId: string }): void {
  if (!input || typeof input !== "object" || typeof input.accountId !== "string") return invalid();
  try { parseAccountId(input.accountId); } catch { return invalid("The approval account identity is invalid"); }
  if (typeof input.principalId !== "string" ||
      !(input.principalId === `owner:${input.accountId}` ||
        input.principalId.startsWith("bot:") && uuid.test(input.principalId.slice(4)))) {
    return invalid("The approval must identify an account principal");
  }
}
function binding(input: TransactionApprovalBinding): TransactionApprovalBinding {
  identity(input);
  if (typeof input.planId !== "string" || !uuid.test(input.planId) ||
      typeof input.commitment !== "string" || !bytes32.test(input.commitment) ||
      typeof input.transactionHash !== "string" || !bytes32.test(input.transactionHash) ||
      !Number.isSafeInteger(input.stepIndex) || Object.is(input.stepIndex, -0) || input.stepIndex < 0 || input.stepIndex > 31) {
    return invalid("The approval must identify an account principal, plan, and exact transaction step");
  }
  return {
    accountId: input.accountId, principalId: input.principalId, planId: input.planId,
    commitment: input.commitment, stepIndex: input.stepIndex, transactionHash: input.transactionHash,
  };
}
function claims(input: TransactionApprovalClaims): TransactionApprovalClaims {
  const bound = binding(input);
  return { ...bound, ...window(input) };
}
function window(input: Pick<TransactionApprovalClaims, "issuedAt" | "expiresAt" | "nonce">) {
  if (!time(input.issuedAt) || !time(input.expiresAt) || input.expiresAt <= input.issuedAt ||
      input.expiresAt - input.issuedAt > 300 ||
      typeof input.nonce !== "string" || !/^0x[0-9a-f]{64}$/.test(input.nonce)) {
    return invalid("The owner approval requires a validity window of at most five minutes and a 32-byte nonce");
  }
  return { issuedAt: input.issuedAt, expiresAt: input.expiresAt, nonce: input.nonce };
}

/** Browser-safe owner-wallet signing document; use a fresh cryptographically random nonce. */
export function buildTransactionApprovalTypedData(audience: string, input: TransactionApprovalClaims) {
  audience = validateAudience(audience);
  const value = claims(input);
  return {
    domain: {
      name: "Juicebox Center REST", version: "1",
      chainId: parseAccountId(value.accountId).authorityChainId,
      salt: keccak256(stringToHex(audience)),
    },
    types, primaryType: "CenterTransactionApproval" as const,
    message: { ...value, audience, issuedAt: BigInt(value.issuedAt), expiresAt: BigInt(value.expiresAt) },
  };
}

function sponsorshipBinding(input: SponsorshipApprovalBinding): SponsorshipApprovalBinding {
  identity(input);
  if (typeof input.sponsorshipId !== "string" || !uuid.test(input.sponsorshipId) ||
      typeof input.commitment !== "string" || !bytes32.test(input.commitment) ||
      typeof input.submissionHash !== "string" || !bytes32.test(input.submissionHash)) return invalid();
  return {
    accountId: input.accountId, principalId: input.principalId, sponsorshipId: input.sponsorshipId,
    commitment: input.commitment, submissionHash: input.submissionHash,
  };
}

/** Approves publishing exact signed forward requests, independently of direct transaction relay. */
export function buildSponsorshipApprovalTypedData(audience: string, input: SponsorshipApprovalClaims) {
  audience = validateAudience(audience);
  const value = { ...sponsorshipBinding(input), ...window(input) };
  return {
    domain: {
      name: "Juicebox Center REST", version: "1",
      chainId: parseAccountId(value.accountId).authorityChainId,
      salt: keccak256(stringToHex(audience)),
    },
    types: sponsorshipTypes, primaryType: "CenterSponsorshipApproval" as const,
    message: { ...value, audience, issuedAt: BigInt(value.issuedAt), expiresAt: BigInt(value.expiresAt) },
  };
}

/** Matches the server's canonical SHA-256 publication identity; order is significant. */
export function sponsorshipSubmissionHash(commitment: Hex, signatures: readonly Hex[]): Hex {
  if (typeof commitment !== "string" || !bytes32.test(commitment) || !Array.isArray(signatures) ||
      signatures.length < 1 || signatures.length > 4 ||
      Array.from(signatures).some((signature) => typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature))) return invalid();
  return sha256(stringToHex(JSON.stringify({ commitment: commitment.toLowerCase(), signatures: signatures.map((signature) => signature.toLowerCase()) })));
}

function fresh(value: Pick<TransactionApprovalClaims, "issuedAt" | "expiresAt">, now: number): void {
  if (!time(now)) throw new RestError(500, "APPROVAL_CLOCK_UNAVAILABLE", "The approval clock is unavailable");
  if (value.expiresAt <= now || value.issuedAt > now + 30) {
    throw new RestError(403, "OWNER_APPROVAL_EXPIRED", "A fresh owner approval is required before dispatch");
  }
}
function notAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RestError(408, "REQUEST_ABORTED", "Owner approval verification was interrupted");
}

async function contractSignature(
  verifier: ContractOwnerVerifier,
  owner: ReturnType<typeof parseAccountId>,
  digest: Hex,
  signature: Hex,
  signal?: AbortSignal,
): Promise<boolean> {
  notAborted(signal);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 5_000);
  let onAbort: (() => void) | undefined;
  try {
    if (signal?.aborted) controller.abort();
    if (controller.signal.aborted) return false;
    const interrupted = new Promise<false>((resolve) => {
      onAbort = () => resolve(false);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const result = await Promise.race([
      verifier({ ...owner, digest, signature, signal: controller.signal }), interrupted,
    ]);
    return result === true && !controller.signal.aborted;
  } catch { return false; }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

async function verifyOwnerSignature(
  typedData: ReturnType<typeof buildTransactionApprovalTypedData> | ReturnType<typeof buildSponsorshipApprovalTypedData>,
  signature: Hex,
  value: TransactionApprovalClaims | SponsorshipApprovalClaims,
  options: TransactionApprovalOptions,
): Promise<ReturnType<typeof parseAccountId>> {
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  notAborted(options.signal);
  fresh(value, now());
  const owner = parseAccountId(value.accountId);
  const digest = typedData.primaryType === "CenterTransactionApproval" ? hashTypedData(typedData) : hashTypedData(typedData);
  let accepted = false;
  try {
    const recovered = await recoverAddress({ hash: digest, signature });
    accepted = recovered.toLowerCase() === owner.ownerAddress.toLowerCase();
  } catch { /* Contract wallets may use a non-EOA signature. */ }
  notAborted(options.signal);
  fresh(value, now());
  if (!accepted && options.verifyContractOwner) {
    accepted = await contractSignature(options.verifyContractOwner, owner, digest, signature, options.signal);
    notAborted(options.signal);
    fresh(value, now());
  }
  if (!accepted) throw new RestError(403, "INVALID_OWNER_APPROVAL_SIGNATURE", "The wallet owner did not sign this approval");
  return owner;
}

function documentSignature(input: unknown, allowedFields: readonly string[]): Hex {
  if (input === null || input === undefined) throw new RestError(428, "OWNER_APPROVAL_REQUIRED", "A fresh wallet-owner approval is required for bot dispatch");
  if (typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some((key) => ![...allowedFields, "signature"].includes(key))) return invalid();
  const signature = (input as { signature: unknown }).signature;
  if (typeof signature !== "string" || !/^0x(?:[0-9a-fA-F]{2}){1,8192}$/.test(signature)) return invalid();
  return signature as Hex;
}

/**
 * Verifies fresh wallet-owner consent. A transaction's Ethereum signature alone
 * has no signing timestamp and cannot substitute for this approval.
 *
 * A nonce is not globally consumed: repeating this exact effect is safe only when
 * the transaction store permanently binds the step to this transaction hash.
 * Callers must still recheck freshness at actual durable dispatch admission.
 */
export async function verifyTransactionApproval(
  audience: string,
  input: unknown,
  expectedBinding: TransactionApprovalBinding,
  options: TransactionApprovalOptions = {},
): Promise<VerifiedTransactionApproval> {
  const signature = documentSignature(input, fields);
  // Snapshot primitives before the first await; caller mutation cannot extend an approved window.
  const document = input as TransactionApproval;
  const value = Object.freeze(claims(document));
  const expected = binding(expectedBinding);
  if (value.accountId !== expected.accountId || value.principalId !== expected.principalId ||
      value.planId !== expected.planId || value.stepIndex !== expected.stepIndex ||
      value.commitment.toLowerCase() !== expected.commitment.toLowerCase() ||
      value.transactionHash.toLowerCase() !== expected.transactionHash.toLowerCase()) {
    throw new RestError(409, "OWNER_APPROVAL_MISMATCH", "The owner approval does not match this principal and exact planned transaction");
  }
  const owner = await verifyOwnerSignature(buildTransactionApprovalTypedData(audience, value), signature, value, options);
  return Object.freeze({
    claims: value, ...owner,
    assertFreshAt: (at: number) => fresh(value, at),
  });
}

/** Publication approval is bound to the preparation and exact ordered forwarding signatures. */
export async function verifySponsorshipApproval(
  audience: string,
  input: unknown,
  expectedBinding: SponsorshipApprovalBinding,
  options: TransactionApprovalOptions = {},
): Promise<VerifiedSponsorshipApproval> {
  const signature = documentSignature(input, sponsorshipFields);
  const document = input as SponsorshipApproval;
  const value = Object.freeze({ ...sponsorshipBinding(document), ...window(document) });
  const expected = sponsorshipBinding(expectedBinding);
  if (value.accountId !== expected.accountId || value.principalId !== expected.principalId ||
      value.sponsorshipId !== expected.sponsorshipId || value.commitment.toLowerCase() !== expected.commitment.toLowerCase() ||
      value.submissionHash.toLowerCase() !== expected.submissionHash.toLowerCase()) {
    throw new RestError(409, "OWNER_APPROVAL_MISMATCH", "The owner approval does not match this principal and exact sponsorship publication");
  }
  const owner = await verifyOwnerSignature(buildSponsorshipApprovalTypedData(audience, value), signature, value, options);
  return Object.freeze({ claims: value, ...owner, assertFreshAt: (at: number) => fresh(value, at) });
}
