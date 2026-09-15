import { keccak256, stringToHex, type Hex } from "viem";
import { RestError } from "../core.js";
import { fingerprint } from "../smartAccounts/service.js";
import { passkeyBindingMethods } from "../smartAccounts/passkeyOnboarding.js";
import type { OnboardingRecord } from "../smartAccounts/onboardingStore.js";
import type { SmartAccountState } from "../smartAccounts/types.js";

export const walletPasskeyBindingMethods = passkeyBindingMethods;
export const walletPasskeyConsentBindingMethod = "center-wallet-passkey-creation-v1" as const;
/** The account window a fresh consent binding stays activatable (recovery uses it as its deadline). */
export const walletPasskeyConsentBindingSeconds = 300;

/** Binds a passkey wallet to its Center account from consent the passkey already gave: the
 * possession proof over the enrollment document (signup) or the recovery proof (replacement).
 * No setup document, no owner signature over Center state, no browser grant: reading and
 * preparing need none, and every execution still takes the passkey. */
export function walletPasskeyConsentBinding(input: { accountId: string; state: SmartAccountState;
  consent: { id: string; digest: Hex }; nowSeconds: number }): OnboardingRecord {
  const address = input.state.address, accountId = input.accountId, digest = input.consent.digest.toLowerCase() as Hex;
  if (accountId !== `eip155:8453:${address.toLowerCase()}` || input.state.chainId !== 8453 || !/^0x[0-9a-f]{64}$/.test(digest)
    || typeof input.consent.id !== "string" || !input.consent.id.length || !Number.isSafeInteger(input.nowSeconds) || input.nowSeconds <= 0)
    throw new RestError(400, "SMART_ONBOARDING_INVALID", "A consent binding needs the wallet's own account and its passkey proof digest.");
  const account = { id: accountId, ownerAddress: address, authorityChainId: 8453,
    profile: { displayName: "", bio: "", avatarUri: null }, createdAt: input.nowSeconds, updatedAt: input.nowSeconds };
  const binding = { id: fingerprint({ ownerAccountId: accountId, wallet: address, chainId: 8453 }), ownerAccountId: accountId,
    ownerAddress: address, wallet: { chainId: 8453, address }, manifestId: input.state.manifestId,
    authorization: { digest, nonce: keccak256(stringToHex(`${walletPasskeyConsentBindingMethod}:${input.consent.id}`)),
      expiresAt: input.nowSeconds + walletPasskeyConsentBindingSeconds, method: walletPasskeyConsentBindingMethod },
    state: input.state };
  return { account, binding };
}
