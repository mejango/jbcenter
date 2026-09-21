import {
  getAddress, hashTypedData, isAddress, keccak256, recoverAddress, stringToHex,
  type Address, type Hex,
} from "viem";
import { RestError } from "../core.js";
import { exactObject } from "../protocol/abi.js";
import { validateAudience } from "../auth/signatures.js";
import type { Account, BotGrant, BotScope } from "../auth/store.js";
import type { SmartAccountBinding, SmartAccountState } from "./types.js";

export interface OnboardingInput {
  owner: Address;
  address: Address;
  manifestId: string;
  nonce: Hex;
  issuedAt: number;
  expiresAt: number;
  grant: { id: string; botAddress: Address; scopes: BotScope[]; expiresAt: number; label: string };
}
export interface OnboardingFinalizationInput extends OnboardingInput {
  manifestRevision: Hex;
  initializerHash: Hex;
  stateHash: Hex;
  signature: Hex;
  proofSignature: Hex;
}
export interface OnboardingResult {
  account: Account;
  binding: SmartAccountBinding;
  /** Absent for a passkey wallet bound by its creation consent; reads and preparation need no grant. */
  grant?: BotGrant;
}
/** The verified records are committed together, or none of them are committed. */
export interface OnboardingStore {
  finalize(input: OnboardingResult): Promise<OnboardingResult>;
}

const fields = ["owner", "address", "manifestId", "nonce", "issuedAt", "expiresAt", "grant"];
const word = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const signature = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-fA-F]{130}$/.test(value) && /(?:1b|1c)$/i.test(value);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function invalid(message: string, status = 400): never {
  throw new RestError(status, "SMART_ONBOARDING_INVALID", message);
}

/** Parse the one supported setup: current sole owner and one hour of API access.
 * This route cannot authorize a transaction or install an onchain session. */
export function validateOnboardingInput(input: unknown, now: number, final = false): OnboardingInput {
  exactObject(input, [...fields, ...(final ? ["manifestRevision", "initializerHash", "stateHash", "signature", "proofSignature"] : [])], "account setup");
  const value = input as unknown as OnboardingFinalizationInput;
  if (!isAddress(value.owner) || !isAddress(value.address) || same(value.owner, value.address)
    || BigInt(value.owner) <= 1n || BigInt(value.address) <= 1n
    || typeof value.manifestId !== "string" || !/^[a-zA-Z0-9:_-]{1,192}$/.test(value.manifestId)
    || !word(value.nonce) || BigInt(value.nonce) === 0n
    || !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt)
    || value.issuedAt < 0 || value.issuedAt > now + 30 || value.expiresAt <= now
    || value.expiresAt <= value.issuedAt || value.expiresAt > value.issuedAt + 300)
    invalid("Use an exact owner, wallet and setup authorization valid for at most five minutes.");
  exactObject(value.grant, ["id", "botAddress", "scopes", "expiresAt", "label"], "setup API grant");
  const grant = value.grant;
  if (typeof grant.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(grant.id)
    || !isAddress(grant.botAddress) || BigInt(grant.botAddress) <= 1n || same(grant.botAddress, value.owner) || same(grant.botAddress, value.address)
    || !Array.isArray(grant.scopes) || grant.scopes.length !== 3
    || !grant.scopes.every((scope, index) => scope === ["read", "plan", "relay"][index])
    || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= value.expiresAt || grant.expiresAt > value.issuedAt + 3600
    || typeof grant.label !== "string" || Buffer.byteLength(grant.label, "utf8") > 120 || /[\u0000-\u001f\u007f]/.test(grant.label))
    invalid("Use one distinct browser API key with exact read, plan and relay scopes for at most one hour.");
  if (final && (!word(value.manifestRevision) || !word(value.initializerHash) || !word(value.stateHash)
    || !signature(value.signature) || !signature(value.proofSignature)))
    invalid("Supply the exact reviewed state and direct owner and browser-key signatures.");
  return {
    owner: getAddress(value.owner), address: getAddress(value.address), manifestId: value.manifestId,
    nonce: value.nonce.toLowerCase() as Hex, issuedAt: value.issuedAt, expiresAt: value.expiresAt,
    grant: { ...grant, botAddress: getAddress(grant.botAddress), scopes: [...grant.scopes] },
  };
}

/** Current canonical inspection remains the authority for all wallet properties. */
export function onboardingDocument(audience: string, input: OnboardingInput, state: SmartAccountState) {
  const details = state.modules?.details as { sessions?: { permissionIds?: unknown }; provenance?: { initializerHash?: unknown } } | null;
  if (state.chainId !== 8453 || !same(state.address, input.address) || state.manifestId !== input.manifestId
    || state.threshold !== 1 || state.owners.length !== 1 || !same(state.owners[0]!, input.owner)
    || !state.moduleConfigurationVerified || !state.modules?.complete || !state.modules.arbitrarySigningDisabled || !state.modules.wildcardExecutionDisabled
    || !Array.isArray(details?.sessions?.permissionIds) || details.sessions.permissionIds.length !== 0
    || !word(details?.provenance?.initializerHash))
    invalid("Setup requires a canonically verified sole-owner Base wallet without spending sessions.", 403);
  const accountId = `eip155:8453:${input.owner.toLowerCase()}`;
  return {
    domain: { name: "Juicebox Center Account Setup", version: "1", chainId: 8453, verifyingContract: input.address,
      salt: keccak256(stringToHex(validateAudience(audience))) },
    types: { SetupAccount: [
      {name:"accountId",type:"string"}, {name:"owner",type:"address"}, {name:"manifestId",type:"string"},
      {name:"manifestRevision",type:"bytes32"}, {name:"initializerHash",type:"bytes32"}, {name:"stateHash",type:"bytes32"},
      {name:"nonce",type:"bytes32"}, {name:"issuedAt",type:"uint64"}, {name:"expiresAt",type:"uint64"},
      {name:"grantId",type:"string"}, {name:"botAddress",type:"address"}, {name:"scopes",type:"string[]"},
      {name:"grantExpiresAt",type:"uint64"}, {name:"label",type:"string"},
    ] } as const,
    primaryType: "SetupAccount" as const,
    message: { accountId, owner: input.owner, manifestId: input.manifestId, manifestRevision: state.manifestRevision,
      initializerHash: details.provenance.initializerHash, stateHash: state.stateHash, nonce: input.nonce,
      issuedAt: BigInt(input.issuedAt), expiresAt: BigInt(input.expiresAt), grantId: input.grant.id,
      botAddress: input.grant.botAddress, scopes: [...input.grant.scopes], grantExpiresAt: BigInt(input.grant.expiresAt), label: input.grant.label },
  };
}
export function onboardingProofDocument(document: ReturnType<typeof onboardingDocument>) {
  return { domain: document.domain, types: { CenterSetupProof: [{name:"setupDigest",type:"bytes32"}] } as const,
    primaryType: "CenterSetupProof" as const, message: { setupDigest: hashTypedData(document) } };
}
export async function verifyOnboardingSignatures(document: ReturnType<typeof onboardingDocument>, ownerSignature: Hex, proofSignature: Hex) {
  try {
    const [owner, key] = await Promise.all([
      recoverAddress({hash:hashTypedData(document),signature:ownerSignature}),
      recoverAddress({hash:hashTypedData(onboardingProofDocument(document)),signature:proofSignature}),
    ]);
    if (!same(owner, document.message.owner) || !same(key, document.message.botAddress)) throw new Error();
  } catch { invalid("Account setup requires its exact current owner and browser API key.", 403); }
}
