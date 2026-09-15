import {
  assertAccount,
  assertGrant,
  assertTime,
  type BotGrant,
} from "../auth/store.js";
import { RestError } from "../core.js";
import type { OnboardingStore } from "./onboarding.js";
import type { SmartAccountBinding } from "./types.js";
import { fingerprint, stable } from "./service.js";
import { assertPasskeyOnboardingState, validatePasskeyOnboardingInput } from "./passkeyOnboarding.js";

export type OnboardingRecord = Parameters<OnboardingStore["finalize"]>[0];
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const bytes32 = (value: unknown) => typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
const time = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Verified service output must still agree across every durable authority record. */
export function assertOnboardingRecord({ account, binding, grant }: OnboardingRecord): void {
  assertAccount(account);
  const auth = binding.authorization;
  if (auth.method === "center-wallet-passkey-creation-v1") {
    // Consent bindings carry the passkey's own proof digest and nothing a browser could use.
    if (grant !== undefined || auth.setup !== undefined || Buffer.byteLength(stable(binding)) > 60_000
      || binding.id !== fingerprint({ ownerAccountId: account.id, wallet: binding.wallet.address, chainId: binding.wallet.chainId })
      || binding.ownerAccountId !== account.id || !same(binding.ownerAddress, account.ownerAddress)
      || binding.state.address !== binding.wallet.address || binding.state.chainId !== binding.wallet.chainId
      || binding.manifestId !== binding.state.manifestId || !bytes32(auth.nonce) || !bytes32(auth.digest) || !time(auth.expiresAt)
      || account.authorityChainId !== 8453 || binding.wallet.chainId !== 8453
      || account.id !== `eip155:8453:${binding.wallet.address.toLowerCase()}` || !same(account.ownerAddress, binding.wallet.address))
      throw new RestError(400, "SMART_ONBOARDING_INVALID", "The passkey creation consent binding is inconsistent.");
    assertPasskeyOnboardingState(binding.state);
    return;
  }
  if (!grant) throw new RestError(400, "SMART_ONBOARDING_INVALID", "Owner setup bindings need their browser API grant.");
  assertGrant(grant);
  const passkey = auth.method === "safe-passkey-owner-threshold-and-api-grant";
  const setup = auth.method === "safe-current-owner-threshold-and-api-grant" || passkey ? auth.setup : undefined;
  if (!setup || Buffer.byteLength(stable(binding)) > 60_000
    || binding.id !== fingerprint({ ownerAccountId: account.id, wallet: binding.wallet.address, chainId: binding.wallet.chainId })
    || binding.ownerAccountId !== account.id || grant.accountId !== account.id
    || !same(binding.ownerAddress, account.ownerAddress)
    || binding.state.address !== binding.wallet.address || binding.state.chainId !== binding.wallet.chainId
    || binding.manifestId !== binding.state.manifestId
    || !bytes32(auth.nonce) || !bytes32(auth.digest) || !bytes32(setup.manifestRevision) || !bytes32(setup.initializerHash)
    || setup.manifestRevision !== binding.state.manifestRevision
    || !time(setup.issuedAt) || !time(auth.expiresAt)
    || auth.expiresAt <= setup.issuedAt || auth.expiresAt - setup.issuedAt > 300
    || grant.expiresAt <= setup.issuedAt || grant.expiresAt - setup.issuedAt > 3_600
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(grant.id)
    || setup.grantId !== grant.id || !same(setup.botAddress, grant.botAddress)
    || stable(setup.scopes) !== stable(grant.scopes) || setup.grantExpiresAt !== grant.expiresAt || setup.label !== grant.label) {
    throw new RestError(400, "SMART_ONBOARDING_INVALID", "The verified setup binding and browser API grant are inconsistent.");
  }
  if (passkey) {
    const observed = assertPasskeyOnboardingState(binding.state);
    validatePasskeyOnboardingInput({ profile: observed.profile.version, address: binding.wallet.address,
      manifestId: binding.manifestId, nonce: auth.nonce, issuedAt: setup.issuedAt, expiresAt: auth.expiresAt,
      grant: { id: grant.id, botAddress: grant.botAddress, scopes: grant.scopes, expiresAt: grant.expiresAt, label: grant.label } }, setup.issuedAt);
    if (account.authorityChainId !== 8453 || binding.wallet.chainId !== 8453
      || account.id !== `eip155:8453:${binding.wallet.address.toLowerCase()}` || !same(account.ownerAddress, binding.wallet.address)
      || !same(setup.initializerHash, observed.initializerHash)
      || binding.state.owners.some((owner) => same(owner, grant.botAddress)))
      throw new RestError(400, "SMART_ONBOARDING_INVALID", "Passkey setup must retain the Base Safe identity and a distinct nonspending browser key.");
  } else if (binding.state.ownerProfile || same(account.ownerAddress, binding.wallet.address)) {
    throw new RestError(400, "SMART_ONBOARDING_INVALID", "Legacy owner setup cannot enroll the Safe itself or a passkey owner profile.");
  }
}

/** PostgreSQL calls this with its shared database clock both before writes and before commit. */
export function assertOnboardingLive({ binding, grant }: OnboardingRecord, now: number): void {
  assertTime(now);
  const auth = binding.authorization;
  if (auth.method === "center-wallet-passkey-creation-v1") {
    if (grant || auth.setup || auth.expiresAt <= now) throw new RestError(409, "SMART_ONBOARDING_EXPIRED", "The passkey creation consent binding expired.");
    return;
  }
  if ((auth.method !== "safe-current-owner-threshold-and-api-grant" && auth.method !== "safe-passkey-owner-threshold-and-api-grant") || !auth.setup
    || !grant || auth.setup.issuedAt > now + 30 || auth.expiresAt <= now || grant.expiresAt <= now) {
    throw new RestError(409, "SMART_ONBOARDING_EXPIRED", "The owner setup authorization or browser API grant expired.");
  }
}

/** A repeated consent binding carries the same consent; only its activation window follows the clock. */
export function sameConsent(actual: SmartAccountBinding["authorization"], expected: SmartAccountBinding["authorization"]): boolean {
  return actual.method === expected.method && actual.digest === expected.digest && actual.nonce === expected.nonce && !actual.setup && !expected.setup;
}
export function sameOnboardingGrant(actual: BotGrant, expected: BotGrant, now: number): boolean {
  return actual.id === expected.id && actual.accountId === expected.accountId
    && same(actual.botAddress, expected.botAddress) && stable(actual.scopes) === stable(expected.scopes)
    && actual.label === expected.label && actual.expiresAt === expected.expiresAt
    && actual.revokedAt === null && actual.createdAt <= now && actual.expiresAt > now;
}
