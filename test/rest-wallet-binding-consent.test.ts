import { beforeAll, describe, expect, it } from "vitest";
import { keccak256, stringToHex } from "viem";
import { createWalletAuthorityContextFixture } from "./fixtures/wallet-authority-context.js";
import { assertOnboardingLive, assertOnboardingRecord } from "../src/rest/smartAccounts/onboardingStore.js";
import { walletPasskeyConsentBinding, walletPasskeyBindingMethods } from "../src/rest/wallet/bindingConsent.js";
import { validateWalletAuthorityContext, type WalletAuthorityContext } from "../src/rest/wallet/authority.js";

// A wallet the passkey created through Center needs no second owner signature to be bound to its
// account: the possession proof recorded at enrollment (or the recovery proof) is the consent.
const now = 1_800_000_120_000, seconds = now / 1000;
let base: WalletAuthorityContext;
beforeAll(async () => { base = await createWalletAuthorityContextFixture(now); });

describe("passkey account binding by creation consent", () => {
  it("binds the account from the enrollment possession proof without a setup document or browser grant", () => {
    const c = structuredClone(base), receipt = c.enrollment.receipt!;
    const record = walletPasskeyConsentBinding({ accountId: c.accountId, state: c.binding.state,
      consent: { id: receipt.enrollmentId, digest: `0x${receipt.verificationDigest}` }, nowSeconds: seconds });
    expect(record.account).toMatchObject({ id: c.accountId, ownerAddress: c.binding.state.address, authorityChainId: 8453 });
    expect(record.binding.authorization).toEqual({ method: "center-wallet-passkey-creation-v1", digest: `0x${receipt.verificationDigest}`,
      nonce: keccak256(stringToHex(`center-wallet-passkey-creation-v1:${receipt.enrollmentId}`)), expiresAt: seconds + 300 });
    expect(record.binding.id).toBe(c.binding.id);
    expect(record.grant).toBeUndefined();
    expect(() => assertOnboardingRecord(record)).not.toThrow();
    expect(() => assertOnboardingLive(record, seconds + 1)).not.toThrow();
    expect(() => assertOnboardingLive(record, seconds + 301)).toThrow(/expired/i);
    expect(walletPasskeyBindingMethods).toContain(record.binding.authorization.method);
  });
  it("is accepted as the authority context binding only with the recorded possession proof", () => {
    const c = structuredClone(base), receipt = c.enrollment.receipt!;
    const { binding } = walletPasskeyConsentBinding({ accountId: c.accountId, state: c.binding.state,
      consent: { id: receipt.enrollmentId, digest: `0x${receipt.verificationDigest}` }, nowSeconds: seconds });
    expect(() => validateWalletAuthorityContext({ ...c, binding })).not.toThrow();
    const forged = { ...binding, authorization: { ...binding.authorization, digest: keccak256(stringToHex("other")) } };
    expect(() => validateWalletAuthorityContext({ ...c, binding: forged })).toThrow();
    const withSetup = { ...binding, authorization: { ...binding.authorization, setup: c.binding.authorization.setup! } };
    expect(() => validateWalletAuthorityContext({ ...c, binding: withSetup })).toThrow();
    // The original setup-document binding stays valid for accounts created before this change.
    expect(() => validateWalletAuthorityContext(c)).not.toThrow();
  });
  it("refuses a browser grant or a setup document with the consent method", () => {
    const c = structuredClone(base), receipt = c.enrollment.receipt!;
    const record = walletPasskeyConsentBinding({ accountId: c.accountId, state: c.binding.state,
      consent: { id: receipt.enrollmentId, digest: `0x${receipt.verificationDigest}` }, nowSeconds: seconds });
    const grant = { id: "12345678-1234-4567-89ab-123456789abc", accountId: c.accountId, botAddress: "0x2222222222222222222222222222222222222222" as const,
      scopes: ["read", "plan", "relay"] as ["read", "plan", "relay"], label: "x", createdAt: seconds, expiresAt: seconds + 3600, revokedAt: null };
    expect(() => assertOnboardingRecord({ ...record, grant })).toThrow();
    expect(() => assertOnboardingRecord({ ...record, binding: { ...record.binding, authorization: { ...record.binding.authorization, setup: c.binding.authorization.setup! } } })).toThrow();
    expect(() => assertOnboardingRecord({ ...record, account: { ...record.account, id: "eip155:8453:0x0000000000000000000000000000000000000001" } })).toThrow();
  });
});
