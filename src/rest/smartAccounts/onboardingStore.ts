import {
  assertAccount,
  assertGrant,
  assertTime,
  type BotGrant,
} from "../auth/store.js";
import { RestError } from "../core.js";
import type { OnboardingStore } from "./onboarding.js";
import { fingerprint, stable } from "./service.js";

export type OnboardingRecord = Parameters<OnboardingStore["finalize"]>[0];
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const bytes32 = (value: unknown) => typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
const time = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Verified service output must still agree across every durable authority record. */
export function assertOnboardingRecord({ account, binding, grant }: OnboardingRecord): void {
  assertAccount(account);
  assertGrant(grant);
  const auth = binding.authorization;
  const setup = auth.method === "safe-current-owner-threshold-and-api-grant" ? auth.setup : undefined;
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
}

/** PostgreSQL calls this with its shared database clock both before writes and before commit. */
export function assertOnboardingLive({ binding, grant }: OnboardingRecord, now: number): void {
  assertTime(now);
  const auth = binding.authorization;
  if (auth.method !== "safe-current-owner-threshold-and-api-grant" || !auth.setup
    || auth.setup.issuedAt > now + 30 || auth.expiresAt <= now || grant.expiresAt <= now) {
    throw new RestError(409, "SMART_ONBOARDING_EXPIRED", "The owner setup authorization or browser API grant expired.");
  }
}

export function sameOnboardingGrant(actual: BotGrant, expected: BotGrant, now: number): boolean {
  return actual.id === expected.id && actual.accountId === expected.accountId
    && same(actual.botAddress, expected.botAddress) && stable(actual.scopes) === stable(expected.scopes)
    && actual.label === expected.label && actual.expiresAt === expected.expiresAt
    && actual.revokedAt === null && actual.createdAt <= now && actual.expiresAt > now;
}
