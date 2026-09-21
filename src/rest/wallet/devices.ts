import type { Address, Hex } from "viem";
import { RestError } from "../core.js";
import type { RestBlockEvidence } from "../core.js";
import { enrollmentDigest, type WalletEnrollment } from "./enrollment.js";
import type { WalletRegistrationCandidate } from "./registration.js";
import type { WalletAuthorityCredential } from "./authority.js";

/** What a second device leaves behind once its passkey is an owner of the account: the device
 * passkey, its own on-chain signer, the addition it was approved by, and where that was observed. */
export interface WalletCredentialDevice {
  version: "center-wallet-device-v1"; id: string; accountId: string; enrollmentId: string;
  rpId: string; origin: string; credential: WalletRegistrationCandidate; signerAddress: Address;
  /** The primary passkey's approval of the owner addition (the Safe transaction hash it signed). */
  approvalDigest: Hex; transactionHash: Hex; anchor: RestBlockEvidence;
  /** The consent digest the account was rebound with once the device owner was observed. */
  bindingDigest: Hex;
  verifiedAtMs: number; acceptedAtMs: number;
}
export type WalletAuthorityDevice = WalletAuthorityCredential & { device: WalletCredentialDevice };

function invalid(): never { throw new RestError(400, "WALLET_AUTHORITY_INVALID", "Current device lineage does not match the original wallet."); }
const word = (value: unknown) => typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value) && BigInt(value) !== 0n;
const address = (value: unknown) => typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value) && BigInt(value) > 1n;
const clock = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function fields(value: any, required: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key))) invalid();
}

/** A device row is bound to the enrollment's account and user handle, its receipt to the row. */
export function assertWalletAuthorityDevice(c: WalletAuthorityDevice, e: WalletEnrollment): void {
  enrollmentDigest(c);
  fields(c, ["accountId", "enrollmentId", "rpId", "credentialId", "userHandle", "publicKey", "backupEligible", "verifiedAtMs", "supersededAtMs", "device"]);
  fields(c.publicKey, ["x", "y"]);
  const d = c.device;
  fields(d, ["version", "id", "accountId", "enrollmentId", "rpId", "origin", "credential", "signerAddress", "approvalDigest", "transactionHash", "anchor", "bindingDigest", "verifiedAtMs", "acceptedAtMs"]);
  if (c.accountId !== e.receipt!.accountId || c.enrollmentId !== e.intent.id || c.rpId !== e.intent.rpId || c.userHandle !== e.intent.userHandle
    || c.supersededAtMs !== null || !clock(c.verifiedAtMs) || d.version !== "center-wallet-device-v1" || !uuid.test(d.id)
    || d.accountId !== c.accountId || d.enrollmentId !== c.enrollmentId || d.rpId !== c.rpId || d.origin !== e.intent.origin
    || d.credential.credentialId !== c.credentialId || d.credential.userHandle !== c.userHandle
    || d.credential.publicKey.x !== c.publicKey.x || d.credential.publicKey.y !== c.publicKey.y || d.credential.backupEligible !== c.backupEligible
    || !address(d.signerAddress) || !word(d.approvalDigest) || !word(d.transactionHash) || !word(d.bindingDigest) || d.verifiedAtMs !== c.verifiedAtMs
    || !clock(d.acceptedAtMs) || d.acceptedAtMs < d.verifiedAtMs || d.anchor?.chainId !== 8453 || !word(d.anchor.blockHash)
    || c.credentialId === e.candidate!.credentialId) invalid();
}
