import { hexToBytes, keccak256, sha256, stringToHex, toHex, type Address, type Hex } from "viem";

/** Browser-safe wire contract. Server admission additionally validates exact public fields and policy. */
export interface WalletHandoffRequest {
  readonly version: "center-wallet-handoff-request-v1";
  readonly issuer: string;
  readonly origin: string;
  readonly callbackUri: string;
  readonly audience: string;
  readonly appGeneration: number;
  readonly requestKey: Address;
  readonly state: string;
  readonly codeChallenge: string;
  readonly nonce: Hex;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}
export interface WalletHandoffExchangeDocumentInput {
  readonly request: WalletHandoffRequest;
  readonly intentId: string;
  readonly codeHash: Hex;
}

const requestMessageTypes = [
  { name: "version", type: "string" },
  { name: "issuer", type: "string" },
  { name: "origin", type: "string" },
  { name: "callbackUri", type: "string" },
  { name: "audience", type: "string" },
  { name: "appGeneration", type: "uint64" },
  { name: "requestKey", type: "address" },
  { name: "state", type: "bytes32" },
  { name: "codeChallenge", type: "bytes32" },
  { name: "nonce", type: "bytes32" },
  { name: "issuedAtMs", type: "uint64" },
  { name: "expiresAtMs", type: "uint64" },
] as const;
const exchangeMessageTypes = [...requestMessageTypes,
  { name: "intentId", type: "bytes32" }, { name: "codeHash", type: "bytes32" }] as const;
// Returned documents must not expose mutable schemas shared with later verification.
for (const field of exchangeMessageTypes) Object.freeze(field);
const requestTypes = Object.freeze({ WalletHandoffRequest: Object.freeze(requestMessageTypes) });
const exchangeTypes = Object.freeze({ WalletHandoffExchange: Object.freeze(exchangeMessageTypes) });

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function validateWalletHandoffToken(value: unknown): string {
  if (typeof value !== "string" || value.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("Invalid wallet handoff token.");
  const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/") + "="), character => character.charCodeAt(0));
  if (bytes.length !== 32 || base64url(bytes) !== value) throw new Error("Invalid wallet handoff token.");
  return value;
}
function tokenHex(value: string): Hex {
  return toHex(Uint8Array.from(atob(validateWalletHandoffToken(value).replaceAll("-", "+").replaceAll("_", "/") + "="), character => character.charCodeAt(0)));
}
/** RFC 7636 S256 only; verifier entropy is supplied by the requesting browser. */
export function walletHandoffPkceChallenge(value: unknown): string {
  if (typeof value !== "string" || value.length < 43 || value.length > 128 || !/^[A-Za-z0-9._~-]+$/.test(value)) throw new Error("Invalid wallet handoff verifier.");
  return base64url(hexToBytes(sha256(stringToHex(value))));
}
export function walletHandoffCodeHash(value: unknown): Hex {
  return sha256(stringToHex("center-wallet-handoff-code-v1\0" + validateWalletHandoffToken(value)));
}
function domain(request: WalletHandoffRequest) {
  return { name: "Juicebox Center Wallet Handoff", version: "1", chainId: 8453, salt: keccak256(stringToHex(request.issuer)) } as const;
}
function message(request: WalletHandoffRequest) {
  return { ...request, state: tokenHex(request.state), codeChallenge: tokenHex(request.codeChallenge),
    appGeneration: BigInt(request.appGeneration), issuedAtMs: BigInt(request.issuedAtMs), expiresAtMs: BigInt(request.expiresAtMs) };
}
export function walletHandoffRequestDocument(request: WalletHandoffRequest) {
  return { domain: domain(request), types: requestTypes, primaryType: "WalletHandoffRequest" as const, message: message(request) };
}
export function walletHandoffExchangeDocument(input: WalletHandoffExchangeDocumentInput) {
  return { domain: domain(input.request), types: exchangeTypes, primaryType: "WalletHandoffExchange" as const,
    message: { ...message(input.request), intentId: tokenHex(input.intentId), codeHash: input.codeHash } };
}
