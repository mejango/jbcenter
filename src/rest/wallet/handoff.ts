import { getAddress, hashTypedData, isAddress, recoverAddress, type Hex } from "viem";
import { RestError } from "../core.js";
import { canonicalEoaSignature } from "../smartAccounts/accountExecution.js";
import { walletAppAudience, walletAppFields } from "./appGrants.js";
import { validateWalletPolicyCallback, validateWalletPolicyOrigin } from "./policy.js";
import * as shared from "./sharedHandoff.js";
import type { WalletHandoffExchangeDocumentInput, WalletHandoffRequest } from "./sharedHandoff.js";
export type { WalletHandoffExchangeDocumentInput, WalletHandoffRequest } from "./sharedHandoff.js";

export const walletHandoffMaximumLifetimeMs = 300_000;
export const walletHandoffFutureClockAllowanceMs = 30_000;

export interface WalletHandoffExchangeInput {
  readonly intentId: string;
  readonly request: WalletHandoffRequest;
  readonly code: string;
  readonly verifier: string;
  readonly signature: Hex;
}
export interface VerifiedWalletHandoffExchange {
  readonly request: WalletHandoffRequest;
  readonly intentId: string;
  readonly codeHash: Hex;
  readonly exchangeDigest: Hex;
}

const requestFields = ["version", "issuer", "origin", "callbackUri", "audience", "appGeneration", "requestKey", "state",
  "codeChallenge", "nonce", "issuedAtMs", "expiresAtMs"] as const;

function invalid(): never {
  throw new RestError(400, "WALLET_HANDOFF_INVALID", "Wallet handoff fields or bounds are invalid.");
}
function invalidSignature(): never {
  throw new RestError(401, "WALLET_HANDOFF_SIGNATURE_INVALID", "Wallet handoff requires the matching request key signature.");
}
function fields(value: unknown, required: readonly string[]): Record<string, unknown> {
  try { return walletAppFields(value, required); } catch { return invalid(); }
}
function bytes32(value: unknown): Hex {
  if (typeof value !== "string" || value.length !== 66 || !/^0x[0-9a-f]{64}$/.test(value)) invalid();
  return value as Hex;
}
function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
export function validateWalletHandoffToken(value: unknown): string {
  try { return shared.validateWalletHandoffToken(value); } catch { return invalid(); }
}
export function walletHandoffPkceChallenge(value: unknown): string {
  try { return shared.walletHandoffPkceChallenge(value); } catch { return invalid(); }
}
export function walletHandoffCodeHash(value: unknown): Hex {
  try { return shared.walletHandoffCodeHash(value); } catch { return invalid(); }
}
/** Current time, configured issuer/audience and live policy are checked by the durable store. */
export function validateWalletHandoffRequest(input: unknown): WalletHandoffRequest {
  const value = fields(input, requestFields);
  try {
    if (value.version !== "center-wallet-handoff-request-v1" || !positiveInteger(value.appGeneration)
      || !positiveInteger(value.issuedAtMs) || !positiveInteger(value.expiresAtMs)
      || value.expiresAtMs <= value.issuedAtMs || value.expiresAtMs - value.issuedAtMs > walletHandoffMaximumLifetimeMs
      || typeof value.requestKey !== "string" || value.requestKey.length !== 42 || !isAddress(value.requestKey)
      || BigInt(value.requestKey) <= 1n) invalid();
    const origin = validateWalletPolicyOrigin(value.origin);
    return Object.freeze({ version: value.version, issuer: validateWalletPolicyOrigin(value.issuer), origin,
      callbackUri: validateWalletPolicyCallback(value.callbackUri, origin), audience: walletAppAudience(value.audience),
      appGeneration: value.appGeneration, requestKey: getAddress(value.requestKey).toLowerCase() as WalletHandoffRequest["requestKey"],
      state: validateWalletHandoffToken(value.state), codeChallenge: validateWalletHandoffToken(value.codeChallenge),
      nonce: bytes32(value.nonce), issuedAtMs: value.issuedAtMs, expiresAtMs: value.expiresAtMs });
  } catch { return invalid(); }
}
export function walletHandoffRequestDocument(input: WalletHandoffRequest) {
  return shared.walletHandoffRequestDocument(validateWalletHandoffRequest(input));
}
export function walletHandoffExchangeDocument(input: WalletHandoffExchangeDocumentInput) {
  const value = fields(input, ["request", "intentId", "codeHash"]);
  return shared.walletHandoffExchangeDocument({ request: validateWalletHandoffRequest(value.request),
    intentId: validateWalletHandoffToken(value.intentId), codeHash: bytes32(value.codeHash) });
}
async function verifySignature(hash: Hex, requestKey: string, input: unknown): Promise<void> {
  try {
    // Bound before the shared ECDSA parser scans any signature bytes.
    if (typeof input !== "string" || input.length !== 132) invalidSignature();
    const signature = canonicalEoaSignature(input as Hex);
    if ((await recoverAddress({ hash, signature })).toLowerCase() === requestKey) return;
  } catch { /* Never return proof material or low-level recovery errors. */ }
  invalidSignature();
}
export async function verifyWalletHandoffRequestSignature(input: WalletHandoffRequest, signature: Hex): Promise<void> {
  const document = walletHandoffRequestDocument(input);
  await verifySignature(hashTypedData(document), document.message.requestKey, signature);
}
export async function verifyWalletHandoffExchangeSignature(input: WalletHandoffExchangeDocumentInput, signature: Hex): Promise<void> {
  const document = walletHandoffExchangeDocument(input);
  await verifySignature(hashTypedData(document), document.message.requestKey, signature);
}
/** Crypto only. The durable exchange must compare the complete stored tuple and recheck
 * live session, authority, policy and deadlines under its locks before consuming the code. */
export async function verifyWalletHandoffExchange(input: unknown): Promise<VerifiedWalletHandoffExchange> {
  const value = fields(input, ["intentId", "request", "code", "verifier", "signature"]);
  const request = validateWalletHandoffRequest(value.request), intentId = validateWalletHandoffToken(value.intentId);
  const codeHash = walletHandoffCodeHash(value.code);
  if (walletHandoffPkceChallenge(value.verifier) !== request.codeChallenge) invalid();
  const exchangeDigest = hashTypedData(walletHandoffExchangeDocument({ request, intentId, codeHash }));
  await verifySignature(exchangeDigest, request.requestKey, value.signature);
  // Signature bytes and the verifier are deliberately absent: exact retries identify the semantic exchange.
  return Object.freeze({ request, intentId, codeHash, exchangeDigest });
}
export function walletHandoffCallback(input: { request: WalletHandoffRequest; code: string }): string {
  const value = fields(input, ["request", "code"]), request = validateWalletHandoffRequest(value.request);
  return `${request.callbackUri}?${new URLSearchParams({ code: validateWalletHandoffToken(value.code), state: request.state, iss: request.issuer })}`;
}
