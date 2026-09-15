import {
  concatHex, getAddress, hashDomain, hashStruct, hashTypedData, keccak256,
  recoverAddress, size, sliceHex, toHex, zeroAddress, type Address, type Hex,
} from "viem";
import { RestError } from "../core.js";
import { address, integer } from "../protocol/abi.js";
import {
  canonicalEoaSignature, safe7579OwnerSigningPayload,
  type Safe7579OwnerSigningInput,
} from "./accountExecution.js";

export type SafeOwnerSignature =
  | { kind: "ecdsa"; owner: Address; signature: Hex }
  | { kind: "contract"; owner: Address; signature: Hex };

export type SafeOwner = { address: Address; kind: "ecdsa" | "contract" };
export type DecodedSafeOwnerSignature =
  | { kind: "ecdsa"; signature: Hex }
  | { kind: "contract"; owner: Address; signature: Hex };

// Fits the existing REST signature limit, including its longest (20-byte) prefix.
const MAX_PACKED_BYTES = 8192 - 20;
const MAX_CONTRACT_BYTES = 4096;
const MAX_OWNERS = 16;
function fail(message: string): never {
  throw new RestError(400, "SMART_ACCOUNT_ENVELOPE_INVALID", message);
}
function bytes(value: unknown, label: string, minimum: number, maximum: number): Hex {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value) ||
      (value.length - 2) / 2 < minimum || (value.length - 2) / 2 > maximum)
    fail(`${label} must contain ${minimum} to ${maximum} complete bytes.`);
  return value.toLowerCase() as Hex;
}
function thresholdChecked(threshold: number): void {
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > MAX_OWNERS)
    fail("Supply a current owner threshold between 1 and 16.");
}
function validityPrefix(input: { validAfter: string; validUntil: string }): Hex {
  const after = integer(input.validAfter, "validAfter", false, 48);
  const until = integer(input.validUntil, "validUntil", false, 48);
  if (until <= after) fail("Owner operations require a finite ordered validity interval.");
  return concatHex([toHex(after, { size: 6 }), toHex(until, { size: 6 })]);
}
function ecdsaChecked(value: Hex): Hex {
  const signature = bytes(value, "ECDSA signature", 65, 65);
  // Reuse the legacy profile's canonical low-s/r/v checks, never apply them to P-256.
  return canonicalEoaSignature(signature);
}

/** Safe's 65-byte static entries followed by tightly packed length-prefixed contract data.
 * This profile rejects approved-hash signatures and personal_sign. Encoding is not authority proof.
 */
export function encodeSafeOwnerSignatures(entries: readonly SafeOwnerSignature[]): Hex {
  if (!Array.isArray(entries)) fail("Supply exact owner signatures.");
  thresholdChecked(entries.length);
  const sorted = entries.map((entry) => {
    if (!entry || (entry.kind !== "ecdsa" && entry.kind !== "contract"))
      fail("Unsupported owner signature kind.");
    return { ...entry, owner: address(entry.owner, "owner", true) };
  }).sort((a, b) => BigInt(a.owner) < BigInt(b.owner) ? -1 : 1);
  if (new Set(sorted.map((entry) => entry.owner.toLowerCase())).size !== sorted.length)
    fail("Owner signatures must be distinct.");
  const head: Hex[] = [];
  const tail: Hex[] = [];
  let offset = 65 * sorted.length;
  for (const entry of sorted) {
    if (entry.kind === "ecdsa") {
      head.push(ecdsaChecked(entry.signature));
    } else {
      const signature = bytes(entry.signature, "contract signature", 1, MAX_CONTRACT_BYTES);
      head.push(concatHex([toHex(BigInt(entry.owner), { size: 32 }), toHex(offset, { size: 32 }), "0x00"]));
      tail.push(concatHex([toHex(size(signature), { size: 32 }), signature]));
      offset += 32 + size(signature);
    }
  }
  return bytes(concatHex([...head, ...tail]), "packed owner signatures", 65, MAX_PACKED_BYTES);
}

/** Threshold is canonical account state, never inferred from attacker-controlled dynamic lengths. */
export function decodeSafeOwnerSignatures(value: Hex, threshold: number): DecodedSafeOwnerSignature[] {
  thresholdChecked(threshold);
  const data = bytes(value, "packed owner signatures", 65 * threshold, MAX_PACKED_BYTES);
  let dynamicOffset = 65 * threshold;
  const result: DecodedSafeOwnerSignature[] = [];
  for (let i = 0; i < threshold; i++) {
    const entry = sliceHex(data, i * 65, (i + 1) * 65);
    const v = Number(BigInt(sliceHex(entry, 64, 65)));
    if (v !== 0) {
      result.push({ kind: "ecdsa", signature: ecdsaChecked(entry) });
      continue;
    }
    const ownerWord = BigInt(sliceHex(entry, 0, 32));
    if (ownerWord === 0n || ownerWord >> 160n) fail("Contract owner address must use canonical zero padding.");
    const offset = BigInt(sliceHex(entry, 32, 64));
    if (offset !== BigInt(dynamicOffset) || dynamicOffset + 32 > size(data))
      fail("Contract signature offsets must follow the static table without gaps, aliases or overlap.");
    const length = BigInt(sliceHex(data, dynamicOffset, dynamicOffset + 32));
    if (length < 1n || length > BigInt(MAX_CONTRACT_BYTES) ||
        BigInt(dynamicOffset + 32) + length > BigInt(size(data)))
      fail("Contract signature length is outside the bounded envelope.");
    result.push({
      kind: "contract", owner: getAddress(toHex(ownerWord, { size: 20 })),
      signature: sliceHex(data, dynamicOffset + 32, dynamicOffset + 32 + Number(length)),
    });
    dynamicOffset += 32 + Number(length);
  }
  if (dynamicOffset !== size(data)) fail("Owner signatures cannot contain trailing bytes or extra entries.");
  return result;
}

export function encodeSafe7579PasskeyOwnerSignature(input: {
  validAfter: string;
  validUntil: string;
  signatures: readonly SafeOwnerSignature[];
}): Hex {
  return concatHex([validityPrefix(input), encodeSafeOwnerSignatures(input.signatures)]);
}

export function decodeSafe7579PasskeyOwnerSignature(input: {
  signature: Hex; validAfter: string; validUntil: string; threshold: number;
}): DecodedSafeOwnerSignature[] {
  const signature = bytes(input.signature, "SafeOp owner envelope", 77, 12 + MAX_PACKED_BYTES);
  if (sliceHex(signature, 0, 12) !== validityPrefix(input))
    fail("Owner signature validity differs from its review.");
  return decodeSafeOwnerSignatures(sliceHex(signature, 12), input.threshold);
}

export function encodeSafe7579MessageSignature(entries: readonly SafeOwnerSignature[]): Hex {
  return concatHex([zeroAddress, encodeSafeOwnerSignatures(entries)]);
}

export function decodeSafe7579MessageSignature(signature: Hex, threshold: number): DecodedSafeOwnerSignature[] {
  const value = bytes(signature, "SafeMessage owner envelope", 85, 20 + MAX_PACKED_BYTES);
  if (sliceHex(value, 0, 20) !== zeroAddress) fail("SafeMessage must select the zero-validator owner path.");
  return decodeSafeOwnerSignatures(sliceHex(value, 20), threshold);
}

/** The legacy Safe owner ERC-1271 selector hashes this preimage once, just like checkSignatures. */
export function safe7579PasskeyOwnerSigningPayload(input: Safe7579OwnerSigningInput) {
  const payload = safe7579OwnerSigningPayload(input);
  const original = payload.typedData;
  const typedData = {
    ...original,
    domain: { ...original.domain, chainId: BigInt(original.domain.chainId) },
    message: {
      ...original.message,
      nonce: BigInt(original.message.nonce),
      verificationGasLimit: BigInt(original.message.verificationGasLimit),
      callGasLimit: BigInt(original.message.callGasLimit),
      preVerificationGas: BigInt(original.message.preVerificationGas),
      maxPriorityFeePerGas: BigInt(original.message.maxPriorityFeePerGas),
      maxFeePerGas: BigInt(original.message.maxFeePerGas),
      validAfter: Number(original.message.validAfter),
      validUntil: Number(original.message.validUntil),
    },
  };
  const signedData = concatHex([
    "0x1901", hashDomain({ domain: { ...typedData.domain, chainId: BigInt(input.chainId) }, types: typedData.types }),
    hashStruct({ data: typedData.message, primaryType: typedData.primaryType, types: typedData.types }),
  ]);
  if (keccak256(signedData) !== payload.digest) fail("SafeOp preimage differs from its approved digest.");
  return { ...payload, signedData };
}

/** f22a194 Safe7579 wraps abi.encode(requestDigest) in SafeMessage under the Safe's own domain. */
export function safe7579MessageSigningPayload(input: { safe: Address; chainId: number; requestDigest: Hex }) {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) fail("Use the verified authority chain.");
  const typedData = {
    domain: { chainId: input.chainId, verifyingContract: address(input.safe, "safe", true) },
    types: {
      EIP712Domain: [{ name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
      SafeMessage: [{ name: "message", type: "bytes" }],
    },
    primaryType: "SafeMessage" as const,
    message: { message: bytes(input.requestDigest, "request digest", 32, 32) },
  } as const;
  const signedData = concatHex([
    "0x1901", hashDomain({ domain: { ...typedData.domain, chainId: BigInt(input.chainId) }, types: typedData.types }),
    hashStruct({ data: typedData.message, primaryType: typedData.primaryType, types: typedData.types }),
  ]);
  const digest = hashTypedData({ ...typedData, domain: { ...typedData.domain, chainId: BigInt(input.chainId) } });
  return { scheme: "eip712-safe7579-message" as const, typedData, signedData, digest };
}

/** Safe v=0 calls legacy isValidSignature(bytes,bytes) with signedData, requiring 0x20c13b0b.
 * Checking only the bytes32 selector is not equivalent for an arbitrary contract owner.
 */
export type SafeContractSignatureVerifier = (input: {
  owner: Address; digest: Hex; signedData: Hex; signature: Hex;
}) => Promise<boolean>;

/** Admission helper for the new profile. Its caller supplies canonically inspected owners and
 * a bounded, block-pinned contract verifier. Never uses an app-supplied owner list as authority.
 */
export async function verifySafeOwnerSignatures(input: {
  digest: Hex; signedData: Hex; signatures: Hex; owners: readonly SafeOwner[]; threshold: number;
  verifyContractSignature: SafeContractSignatureVerifier;
}): Promise<Address[]> {
  const signedData = bytes(input.signedData, "signed preimage", 1, 4096);
  if (keccak256(signedData) !== bytes(input.digest, "digest", 32, 32))
    fail("Signature verification must bind the exact signed preimage.");
  const entries = decodeSafeOwnerSignatures(input.signatures, input.threshold);
  const owners = new Map<string, SafeOwner["kind"]>();
  if (!Array.isArray(input.owners) || input.owners.length > MAX_OWNERS)
    fail("Supply the bounded current owner set.");
  for (const owner of input.owners) {
    if (owner.kind !== "ecdsa" && owner.kind !== "contract") fail("Unsupported owner kind.");
    const key = address(owner.address, "owner", true).toLowerCase();
    if (owners.has(key)) fail("The current owner set must be distinct.");
    owners.set(key, owner.kind);
  }
  if (input.threshold > owners.size) fail("The current threshold exceeds the owner set.");
  const verified: Address[] = [];
  let previous = 0n;
  for (const entry of entries) {
    let owner: Address;
    try {
      owner = entry.kind === "contract" ? entry.owner : await recoverAddress({ hash: input.digest, signature: entry.signature });
    } catch {
      throw new RestError(403, "SMART_OWNER_SIGNATURE_INVALID", "The current owner signature is invalid.");
    }
    if (owners.get(owner.toLowerCase()) !== entry.kind || BigInt(owner) <= previous)
      throw new RestError(403, "SMART_OWNER_SIGNATURE_INVALID", "Use sorted distinct signatures from the current owner threshold.");
    if (entry.kind === "contract") {
      let valid = false, reason = "unverified";
      try { valid = await input.verifyContractSignature({ owner, digest: input.digest, signedData, signature: entry.signature }); }
      catch (error) {
        // Missing canonical evidence never proves authority; the bounded reason reaches the log.
        const failure = error as { code?: unknown; message?: unknown };
        reason = String(typeof failure?.code === "string" ? failure.code : failure?.message ?? "error").slice(0, 80);
      }
      if (valid !== true) throw new RestError(403, "SMART_OWNER_SIGNATURE_INVALID", "The contract owner signature could not be verified.",
        { stage: "contract-signature", reason });
    }
    verified.push(owner);
    previous = BigInt(owner);
  }
  return verified;
}
