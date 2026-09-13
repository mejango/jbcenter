import {
  encodeAbiParameters, getAddress, hashTypedData, isAddress, keccak256, recoverAddress,
  sliceHex, stringToHex, type Address, type Hex,
} from "viem";
import { RestError } from "../core.js";
import { exactObject } from "../protocol/abi.js";
import { validateAudience } from "../auth/signatures.js";
import { canonicalEoaSignature } from "./accountExecution.js";
import {
  decodeSafe7579MessageSignature, safe7579MessageSigningPayload, verifySafeOwnerSignatures,
  type SafeContractSignatureVerifier,
} from "./passkeySignatures.js";
import type { OnboardingInput } from "./onboarding.js";
import type { PasskeyOwnerState, SmartAccountState } from "./types.js";

/** Explicit initial setup of an already deployed pilot wallet. This is not registration or deployment. */
export interface PasskeyOnboardingInput extends Omit<OnboardingInput, "owner"> { profile: "center-passkey-v1" }
export interface PasskeyOnboardingFinalizationInput extends PasskeyOnboardingInput {
  manifestRevision: Hex; initializerHash: Hex; stateHash: Hex; signature: Hex; proofSignature: Hex;
}
const fields = ["profile", "address", "manifestId", "nonce", "issuedAt", "expiresAt", "grant"];
const word = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
const validAddress = (v: unknown): v is Address => typeof v === "string" && isAddress(v) && BigInt(v) > 1n;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function invalid(message: string, status = 400): never { throw new RestError(status, "SMART_ONBOARDING_INVALID", message); }

export function validatePasskeyOnboardingInput(input: unknown, now: number, final = false): PasskeyOnboardingInput {
  exactObject(input, [...fields, ...(final ? ["manifestRevision", "initializerHash", "stateHash", "signature", "proofSignature"] : [])], "passkey account setup");
  const value = input as unknown as PasskeyOnboardingFinalizationInput;
  if (!Number.isSafeInteger(now) || now < 0 || value.profile !== "center-passkey-v1" || !validAddress(value.address)
    || typeof value.manifestId !== "string" || !/^[a-zA-Z0-9:_-]{1,192}$/.test(value.manifestId)
    || !word(value.nonce) || BigInt(value.nonce) === 0n
    || !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt)
    || value.issuedAt < 0 || value.issuedAt > now + 30 || value.expiresAt <= now
    || value.expiresAt <= value.issuedAt || value.expiresAt > value.issuedAt + 300)
    invalid("Use the explicit passkey profile and an exact wallet setup valid for at most five minutes.");
  exactObject(value.grant, ["id", "botAddress", "scopes", "expiresAt", "label"], "setup API grant");
  const grant = value.grant;
  if (typeof grant.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(grant.id)
    || !validAddress(grant.botAddress) || same(grant.botAddress, value.address)
    || !Array.isArray(grant.scopes) || grant.scopes.length !== 3
    || !grant.scopes.every((scope, index) => scope === ["read", "plan", "relay"][index])
    || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= value.expiresAt || grant.expiresAt > value.issuedAt + 3600
    || typeof grant.label !== "string" || Buffer.byteLength(grant.label, "utf8") > 120 || /[\u0000-\u001f\u007f]/.test(grant.label))
    invalid("Use one distinct browser API key with exact read, plan and relay scopes for at most one hour.");
  if (final) {
    if (!word(value.manifestRevision) || !word(value.initializerHash) || !word(value.stateHash))
      invalid("Supply the exact reviewed manifest, initializer and state.");
    // The reviewed pilot is threshold one; canonical inspection must establish that again before verification.
    decodeSafe7579MessageSignature(value.signature, 1);
    canonicalEoaSignature(value.proofSignature);
  }
  return { profile: value.profile, address: getAddress(value.address), manifestId: value.manifestId,
    nonce: value.nonce.toLowerCase() as Hex, issuedAt: value.issuedAt, expiresAt: value.expiresAt,
    grant: { ...grant, botAddress: getAddress(grant.botAddress), scopes: [...grant.scopes] } };
}

/** Caller supplies only the service's freshly inspected, block-pinned state, never client owner claims. */
export function assertPasskeyOnboardingState(state: SmartAccountState): { profile: PasskeyOwnerState; initializerHash: Hex; ownerProfileHash: Hex } {
  const profile = state.ownerProfile;
  const details = state.modules?.details as { sessions?: { permissionIds?: unknown }; provenance?: { initializerHash?: unknown } } | null;
  if (state.chainId !== 8453 || state.evidence.chainId !== 8453 || !validAddress(state.address)
    || profile?.version !== "center-passkey-v1" || profile.signer?.kind !== "contract" || profile.recoveryOwner?.kind !== "ecdsa"
    || !validAddress(profile.signer.address) || !validAddress(profile.recoveryOwner.address)
    || same(profile.signer.address, profile.recoveryOwner.address) || same(profile.signer.address, state.address) || same(profile.recoveryOwner.address, state.address)
    || state.threshold !== 1 || state.owners.length !== 2
    || !state.owners.some((owner) => same(owner, profile.signer.address)) || !state.owners.some((owner) => same(owner, profile.recoveryOwner.address))
    || !word(state.stateHash) || !word(state.manifestRevision) || !word(profile.signer.x) || !word(profile.signer.y) || !word(profile.signer.runtimeCodeHash)
    || typeof profile.signer.verifiers !== "string" || !/^0x[0-9a-fA-F]{44}$/.test(profile.signer.verifiers)
    || !state.moduleConfigurationVerified || !state.modules?.complete || !state.modules.arbitrarySigningDisabled || !state.modules.wildcardExecutionDisabled
    || !Array.isArray(details?.sessions?.permissionIds) || details.sessions.permissionIds.length !== 0 || !word(details?.provenance?.initializerHash))
    invalid("Setup requires a canonically verified Base passkey pilot with independent recovery and no spending sessions.", 403);
  const ownerProfileHash = keccak256(encodeAbiParameters(
    [{ type: "string" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes22" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" }],
    [profile.version, profile.signer.address, profile.signer.x, profile.signer.y, profile.signer.verifiers,
      profile.signer.runtimeCodeHash, profile.recoveryOwner.address, BigInt(state.threshold)],
  ));
  return { profile, initializerHash: details.provenance.initializerHash, ownerProfileHash };
}

export function passkeyOnboardingDocument(audience: string, input: PasskeyOnboardingInput, state: SmartAccountState) {
  const observed = assertPasskeyOnboardingState(state);
  if (input.profile !== observed.profile.version || !same(state.address, input.address) || state.manifestId !== input.manifestId
    || [state.address, observed.profile.signer.address, observed.profile.recoveryOwner.address].some((owner) => same(owner, input.grant.botAddress)))
    invalid("The reviewed profile and distinct browser key must belong to this exact wallet.", 403);
  return {
    domain: { name: "Juicebox Center Account Setup", version: "2", chainId: 8453, verifyingContract: state.address,
      salt: keccak256(stringToHex(validateAudience(audience))) },
    types: { SetupAccount: [
      { name: "accountId", type: "string" }, { name: "profile", type: "string" }, { name: "ownerProfileHash", type: "bytes32" },
      { name: "manifestId", type: "string" }, { name: "manifestRevision", type: "bytes32" }, { name: "initializerHash", type: "bytes32" }, { name: "stateHash", type: "bytes32" },
      { name: "nonce", type: "bytes32" }, { name: "issuedAt", type: "uint64" }, { name: "expiresAt", type: "uint64" },
      { name: "grantId", type: "string" }, { name: "botAddress", type: "address" }, { name: "scopes", type: "string[]" },
      { name: "grantExpiresAt", type: "uint64" }, { name: "label", type: "string" },
    ] } as const,
    primaryType: "SetupAccount" as const,
    message: { accountId: `eip155:8453:${state.address.toLowerCase()}`, profile: input.profile, ownerProfileHash: observed.ownerProfileHash,
      manifestId: state.manifestId, manifestRevision: state.manifestRevision, initializerHash: observed.initializerHash, stateHash: state.stateHash,
      nonce: input.nonce, issuedAt: BigInt(input.issuedAt), expiresAt: BigInt(input.expiresAt), grantId: input.grant.id,
      botAddress: input.grant.botAddress, scopes: [...input.grant.scopes], grantExpiresAt: BigInt(input.grant.expiresAt), label: input.grant.label },
  };
}
export function passkeyOnboardingProofDocument(document: ReturnType<typeof passkeyOnboardingDocument>) {
  return { domain: document.domain, types: { CenterSetupProof: [{ name: "setupDigest", type: "bytes32" }] } as const,
    primaryType: "CenterSetupProof" as const, message: { setupDigest: hashTypedData(document) } };
}
export function passkeyOnboardingSigningPayload(document: ReturnType<typeof passkeyOnboardingDocument>) {
  return safe7579MessageSigningPayload({ safe: document.domain.verifyingContract, chainId: document.domain.chainId, requestDigest: hashTypedData(document) });
}
export async function verifyPasskeyOnboardingSignatures(
  document: ReturnType<typeof passkeyOnboardingDocument>, state: SmartAccountState, signature: Hex, proofSignature: Hex,
  verifyContractSignature: SafeContractSignatureVerifier,
): Promise<Address[]> {
  const observed = assertPasskeyOnboardingState(state), message = document.message;
  if (!same(document.domain.verifyingContract, state.address) || message.accountId !== `eip155:8453:${state.address.toLowerCase()}`
    || message.profile !== observed.profile.version || !same(message.ownerProfileHash, observed.ownerProfileHash)
    || message.manifestId !== state.manifestId || !same(message.manifestRevision, state.manifestRevision)
    || !same(message.initializerHash, observed.initializerHash) || !same(message.stateHash, state.stateHash))
    throw new RestError(409, "SMART_ACCOUNT_CHANGED", "The wallet configuration changed since setup review.");
  decodeSafe7579MessageSignature(signature, state.threshold);
  const payload = passkeyOnboardingSigningPayload(document);
  let browser: Address;
  try { browser = await recoverAddress({ hash: hashTypedData(passkeyOnboardingProofDocument(document)), signature: canonicalEoaSignature(proofSignature) }); }
  catch { invalid("Setup requires possession of its exact browser API key.", 403); }
  if (!same(browser, message.botAddress)) invalid("Setup requires possession of its exact browser API key.", 403);
  return verifySafeOwnerSignatures({ ...payload, signatures: sliceHex(signature, 20),
    owners: [observed.profile.signer, observed.profile.recoveryOwner], threshold: state.threshold, verifyContractSignature });
}
