import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isProxy } from "node:util/types";
import type { Hex } from "viem";
import { RestError } from "../core.js";
import { assertWalletCeremonyDraft, createWalletCeremony } from "./ceremonies.js";
import { enrollmentDigest } from "./enrollment.js";
import { deriveWalletAuthenticationChallenge, validateWalletRpConfiguration, verifyWalletAssertion } from "./webauthn.js";
import type { WalletCeremonyDraft } from "./ceremonies.js";
import type { WalletAuthorityCredential } from "./authority.js";
import type { WalletAssertion } from "./webauthn.js";

export const walletLoginMaximumLifetimeMs = 180_000;
export const walletCentralSessionLifetimeMs = 3_600_000;
export const walletLoginRetentionMs = 86_400_000;
export interface WalletLoginDraft {
  version: "center-wallet-login-v1";
  id: string;
  sessionId: string;
  rpId: string;
  origin: string;
  flowTokenHash: string;
  issuedAtMs: number;
  expiresAtMs: number;
  retainUntilMs: number;
  ceremony: WalletCeremonyDraft;
}
export interface WalletLoginChallenge {
  id: string;
  rpId: string;
  origin: string;
  challenge: Hex;
  expiresAtMs: number;
}
export interface WalletLoginCompletion {
  loginId: string;
  flowToken: string;
  assertion: WalletAssertion;
}
export interface WalletLoginProof {
  verificationDigest: string;
  credentialId: string;
  userHandle: string;
  signCount: number;
  backupEligible: boolean;
  backedUp: boolean;
}
/** Metadata only. A session ID or receipt is never a bearer credential or spending principal. */
export interface WalletCentralSession {
  id: string;
  loginId: string;
  accountId: string;
  enrollmentId: string;
  rpId: string;
  credentialId: string;
  userHandle: string;
  authorityEpoch: string;
  sessionEpoch: string;
  bindingId: Hex;
  bindingAuthorizationDigest: Hex;
  authorityIdentityDigest: Hex;
  createdAtMs: number;
  expiresAtMs: number;
  revokedAtMs: number | null;
}
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength")!.get!;
function invalid(): never { throw new RestError(400, "WALLET_LOGIN_INVALID", "Wallet login fields or bounds are invalid."); }
function unauthorized(): never { throw new RestError(403, "WALLET_LOGIN_UNAUTHORIZED", "Wallet login proof does not match its trusted intent."); }
function fields(value: any, names: string[], optional: string[] = []): void {
  if (!value || typeof value !== "object" || isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const keys = Reflect.ownKeys(value);
  if (names.some(key => !Object.hasOwn(value, key)) || keys.some(key => typeof key !== "string" || (!names.includes(key) && !optional.includes(key)) || (() => {
    const d = Object.getOwnPropertyDescriptor(value, key)!; return !("value" in d) || !d.enumerable;
  })())) invalid();
}
function uuid(value: unknown): asserts value is string { if (typeof value !== "string" || !uuidPattern.test(value)) invalid(); }
function clock(value: unknown): asserts value is number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) invalid(); }
function base64(value: unknown, min: number, max = min): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(max * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length < min || bytes.length > max || bytes.toString("base64url") !== value) invalid();
  return bytes;
}
function rp(value: { rpId: string; origin: string }): void {
  if (value.rpId.length > 253 || value.origin.length > 2048) invalid();
  validateWalletRpConfiguration(value);
}
function word(value: unknown): asserts value is Hex { if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) invalid(); }
function epoch(value: unknown): void {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) invalid();
}
function contextDigest(draft: Omit<WalletLoginDraft, "ceremony">): string {
  return enrollmentDigest(["Juicebox Center discoverable login intent v1", draft]);
}
function boundedBytes(value: unknown, min: number, max: number): Uint8Array {
  if (!value || typeof value !== "object" || isProxy(value)) invalid();
  let length: number;
  try { length = typedArrayByteLength.call(value); } catch { return invalid(); }
  if (!(value instanceof Uint8Array) || length < min || length > max) invalid();
  const result = new Uint8Array(length); result.set(value); return result;
}

/** Trusted server configuration only. Anonymous initiation always consumes ordinary capacity. */
export function createWalletLoginDraft(input: { rpId: string; origin: string; nowMs: number; lifetimeMs?: number }): {
  draft: WalletLoginDraft; flowToken: string;
} {
  fields(input, ["rpId", "origin", "nowMs"], ["lifetimeMs"]);
  if (typeof input.rpId !== "string" || typeof input.origin !== "string") invalid();
  rp(input); clock(input.nowMs);
  const lifetime = input.lifetimeMs ?? walletLoginMaximumLifetimeMs;
  if (!Number.isSafeInteger(lifetime) || lifetime < 1000 || lifetime > walletLoginMaximumLifetimeMs) invalid();
  const flowToken = randomBytes(32).toString("base64url");
  const expiresAtMs = Math.floor((input.nowMs + lifetime) / 1000) * 1000;
  const base: Omit<WalletLoginDraft, "ceremony"> = { version: "center-wallet-login-v1", id: randomUUID(), sessionId: randomUUID(),
    rpId: input.rpId, origin: input.origin, flowTokenHash: walletLoginFlowTokenHash(flowToken), issuedAtMs: input.nowMs,
    expiresAtMs, retainUntilMs: expiresAtMs + walletCentralSessionLifetimeMs + walletLoginRetentionMs };
  const draft = { ...base, ceremony: createWalletCeremony({ accountId: `wallet-login:${base.id}`, purpose: "login",
    contextDigest: contextDigest(base), expiresAt: expiresAtMs }) };
  return { draft: validateWalletLoginDraft(draft), flowToken };
}
export function validateWalletLoginDraft(value: unknown): WalletLoginDraft {
  const v = value as WalletLoginDraft;
  fields(v, ["version", "id", "sessionId", "rpId", "origin", "flowTokenHash", "issuedAtMs", "expiresAtMs", "retainUntilMs", "ceremony"]);
  uuid(v.id); uuid(v.sessionId); clock(v.issuedAtMs); clock(v.expiresAtMs); clock(v.retainUntilMs);
  if (v.version !== "center-wallet-login-v1" || typeof v.rpId !== "string" || typeof v.origin !== "string" ||
    typeof v.flowTokenHash !== "string" || !digestPattern.test(v.flowTokenHash) || v.expiresAtMs % 1000 !== 0 ||
    v.expiresAtMs <= v.issuedAtMs || v.expiresAtMs > v.issuedAtMs + walletLoginMaximumLifetimeMs ||
    v.retainUntilMs !== v.expiresAtMs + walletCentralSessionLifetimeMs + walletLoginRetentionMs) invalid();
  rp(v);
  fields(v.ceremony, ["id", "accountId", "purpose", "contextDigest", "challenge", "expiresAt"]);
  assertWalletCeremonyDraft(v.ceremony);
  const { ceremony, ...base } = v;
  if (ceremony.purpose !== "login" || ceremony.accountId !== `wallet-login:${v.id}` || ceremony.expiresAt !== v.expiresAtMs ||
    ceremony.contextDigest !== contextDigest(base)) invalid();
  return { ...base, ceremony: { ...ceremony } };
}
export function walletLoginChallenge(input: WalletLoginDraft): WalletLoginChallenge {
  const draft = validateWalletLoginDraft(input);
  return { id: draft.id, rpId: draft.rpId, origin: draft.origin, expiresAtMs: draft.expiresAtMs,
    challenge: deriveWalletAuthenticationChallenge({ purpose: "login", accountId: draft.ceremony.accountId,
      bindingDigest: `0x${draft.ceremony.contextDigest}`, nonce: `0x${Buffer.from(draft.ceremony.challenge, "base64url").toString("hex")}`,
      expiresAt: draft.expiresAtMs / 1000 }) };
}
export function walletLoginFlowTokenHash(token: string): string {
  return createHash("sha256").update("Juicebox Center login flow token v1\0").update(base64(token, 32)).digest("hex");
}
export function walletCentralSessionTokenHash(token: string): string {
  return createHash("sha256").update("Juicebox Center central session token v1\0").update(base64(token, 32)).digest("hex");
}
/** A retriable bearer secret is derived solely from server-minted entropy still held in the
 * HttpOnly flow cookie. Neither the intent ID nor its durable receipt can recreate this secret. */
export function deriveWalletCentralSessionToken(flowToken: string, loginId: string): string {
  uuid(loginId);
  return createHmac("sha256", base64(flowToken, 32)).update("Juicebox Center central session recovery v1\0").update(loginId).digest("base64url");
}
export function copyWalletLoginCompletion(input: WalletLoginCompletion): WalletLoginCompletion {
  fields(input, ["loginId", "flowToken", "assertion"]); uuid(input.loginId); base64(input.flowToken, 32);
  const a = input.assertion;
  fields(a, ["credentialId", "userHandle", "authenticatorData", "clientDataJSON", "signature"]);
  base64(a.credentialId, 1, 1023); if (a.userHandle !== null) base64(a.userHandle, 1, 64);
  return { loginId: input.loginId, flowToken: input.flowToken, assertion: { credentialId: a.credentialId, userHandle: a.userHandle,
    authenticatorData: boundedBytes(a.authenticatorData, 37, 37), clientDataJSON: boundedBytes(a.clientDataJSON, 1, 2048),
    signature: boundedBytes(a.signature, 8, 72) } };
}
/** Proof verification only. Expiry, current mapping, epochs and one-use consumption are durable
 * store responsibilities; this must never be treated as a session or onchain authorization. */
export function verifyWalletLoginProof(inputDraft: WalletLoginDraft, flowToken: string, credential: WalletAuthorityCredential,
  assertion: WalletAssertion): WalletLoginProof {
  const draft = validateWalletLoginDraft(inputDraft);
  const input = copyWalletLoginCompletion({ loginId: draft.id, flowToken, assertion });
  if (!timingSafeEqual(Buffer.from(walletLoginFlowTokenHash(input.flowToken), "hex"), Buffer.from(draft.flowTokenHash, "hex"))) unauthorized();
  fields(credential, ["accountId", "enrollmentId", "rpId", "credentialId", "userHandle", "publicKey", "backupEligible", "verifiedAtMs", "supersededAtMs"]);
  fields(credential.publicKey, ["x", "y"]); word(credential.publicKey.x); word(credential.publicKey.y);
  uuid(credential.enrollmentId); base64(credential.credentialId, 1, 1023); base64(credential.userHandle, 32); clock(credential.verifiedAtMs);
  if (typeof credential.accountId !== "string" || !/^eip155:8453:0x[0-9a-f]{40}$/.test(credential.accountId) || credential.rpId !== draft.rpId ||
    typeof credential.backupEligible !== "boolean" || credential.supersededAtMs !== null) unauthorized();
  try {
    const proof = verifyWalletAssertion(input.assertion, { purpose: "login", ...walletLoginChallenge(draft),
      credential: { id: credential.credentialId, publicKey: credential.publicKey, userHandle: credential.userHandle,
        backupEligible: credential.backupEligible }, requireUserHandle: true });
    return { verificationDigest: enrollmentDigest(["Juicebox Center verified login possession v1", draft.id, draft.ceremony.contextDigest,
      credential.accountId, credential.enrollmentId, credential.rpId, credential.credentialId, credential.userHandle,
      credential.publicKey, credential.backupEligible]), credentialId: proof.credentialId, userHandle: proof.userHandle!,
      signCount: proof.signCount, backupEligible: proof.backupEligible, backedUp: proof.backedUp };
  } catch { return unauthorized(); }
}
export function validateWalletCentralSession(input: unknown): WalletCentralSession {
  const v = input as WalletCentralSession;
  fields(v, ["id", "loginId", "accountId", "enrollmentId", "rpId", "credentialId", "userHandle", "authorityEpoch", "sessionEpoch",
    "bindingId", "bindingAuthorizationDigest", "authorityIdentityDigest", "createdAtMs", "expiresAtMs", "revokedAtMs"]);
  uuid(v.id); uuid(v.loginId); uuid(v.enrollmentId); base64(v.credentialId, 1, 1023); base64(v.userHandle, 32);
  epoch(v.authorityEpoch); epoch(v.sessionEpoch); word(v.bindingId); word(v.bindingAuthorizationDigest); word(v.authorityIdentityDigest);
  clock(v.createdAtMs); clock(v.expiresAtMs);
  if (typeof v.accountId !== "string" || !/^eip155:8453:0x[0-9a-f]{40}$/.test(v.accountId) ||
    typeof v.rpId !== "string" || v.rpId.length < 1 || v.rpId.length > 253 ||
    v.expiresAtMs !== v.createdAtMs + walletCentralSessionLifetimeMs) invalid();
  if (v.revokedAtMs !== null) { clock(v.revokedAtMs); if (v.revokedAtMs < v.createdAtMs) invalid(); }
  return { ...v };
}
