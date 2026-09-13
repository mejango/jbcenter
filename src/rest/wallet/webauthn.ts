import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { encodeAbiParameters, type Hex } from "viem";

export type WalletAssertionPurpose = "registration" | "login" | "deploy" | "session" | "payment" | "rotate";
export type WalletAssertion = {
  credentialId: string;
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  signature: Uint8Array;
  userHandle: string | null;
};
export type WalletAssertionExpectation = {
  /** Loaded from the server's ceremony record, never copied from assertion/request metadata. */
  purpose: WalletAssertionPurpose;
  /** For onchain actions this is the exact SafeOp/SafeMessage digest from the trusted codec. */
  challenge: Hex;
  rpId: string;
  origin: string;
  credential: {
    id: string;
    publicKey: { x: Hex; y: Hex };
    userHandle: string;
    /** Immutable BE bit recorded when this credential was registered. */
    backupEligible?: boolean;
  };
  requireUserHandle: boolean;
};
export class WalletAssertionError extends Error {
  constructor(message: string) { super(message); this.name = "WalletAssertionError"; }
}

const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const PURPOSES = ["registration", "login", "deploy", "session", "payment", "rotate"];
const sha256 = (input: string | Uint8Array) => createHash("sha256").update(input).digest();
const hex = (input: Uint8Array): Hex => `0x${Buffer.from(input).toString("hex")}`;
function invalid(message = "Invalid wallet assertion"): never { throw new WalletAssertionError(message); }
function bytes32(value: unknown): Buffer {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) return invalid("Invalid wallet challenge or public key");
  return Buffer.from(value.slice(2), "hex");
}
function base64url(value: unknown, maxBytes: number): Buffer {
  if (typeof value !== "string" || !value.length || value.length > Math.ceil(maxBytes * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) return invalid();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length > maxBytes || decoded.toString("base64url") !== value) return invalid();
  return decoded;
}
function boundedBytes(value: unknown, min: number, max: number): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength < min || value.byteLength > max) return invalid();
  return Buffer.from(value);
}

/** These offchain challenges cannot authorize a transaction. Context and expiry come from the
 * server, with a fresh cryptographic nonce. The caller must persist and atomically consume them. */
export function deriveWalletAuthenticationChallenge(context: {
  purpose: "registration" | "login" | "session";
  accountId: string;
  bindingDigest: Hex;
  nonce: Hex;
  expiresAt: number; // Unix seconds, checked for expiry by the durable ceremony consumer.
}): Hex {
  if (!context || !["registration", "login", "session"].includes(context.purpose) ||
      typeof context.accountId !== "string" || context.accountId.length < 1 || context.accountId.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(context.accountId) ||
      !Number.isSafeInteger(context.expiresAt) || context.expiresAt <= 0) return invalid("Invalid wallet authentication context");
  return hex(sha256(JSON.stringify([
    "Juicebox Center wallet authentication v1", context.purpose, context.accountId,
    hex(bytes32(context.bindingDigest)), hex(bytes32(context.nonce)), context.expiresAt,
  ])));
}

/** The initial browser profile supports flat scalar fields, including Chrome's extra-field
 * sentinel. A bounded scanner rejects duplicate decoded keys; JSON.parse alone loses them.
 * Unsupported nested fields fail explicitly, without rewriting any signed bytes. */
export function readWalletClientData(json: string): Record<string, unknown> {
  const fields: Record<string, unknown> = Object.create(null);
  const stringToken = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
  const scalarToken = /(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/y;
  let offset = 0;
  const whitespace = () => { while (/[\x20\t\r\n]/.test(json[offset] ?? "x")) offset++; };
  const take = (token: RegExp): string => {
    token.lastIndex = offset;
    const match = token.exec(json);
    if (!match) return invalid("Unsupported wallet client data encoding");
    offset = token.lastIndex;
    return match[0];
  };
  if (json[offset++] !== "{") return invalid();
  while (true) {
    whitespace();
    const key = JSON.parse(take(stringToken)) as string;
    if (Object.hasOwn(fields, key)) return invalid("Duplicate wallet client data field");
    whitespace();
    if (json[offset++] !== ":") return invalid();
    whitespace();
    const value = take(json[offset] === '"' ? stringToken : scalarToken);
    fields[key] = JSON.parse(value) as unknown;
    whitespace();
    if (json[offset] === "}") { offset++; break; }
    if (json[offset++] !== ",") return invalid();
  }
  if (offset !== json.length) return invalid();
  return fields;
}

/** Shared exact-host RP policy. Expected values always come from server configuration. */
export function validateWalletRpConfiguration(expected: { origin: string; rpId: string }): void {
  let origin: URL;
  try { origin = new URL(expected.origin); } catch { return invalid("Invalid wallet RP configuration"); }
  if (origin.origin !== expected.origin || origin.hostname !== expected.rpId ||
      expected.rpId.length > 253 || expected.rpId.endsWith(".") ||
      (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))) {
    return invalid("Invalid wallet RP configuration");
  }
}

/** Strict DER ECDSA, with no long-form lengths, negative/redundantly padded integers or trailer.
 * Safe's pinned P256 verifier accepts both high and low S, as authenticators may emit either. */
function readDerSignature(signature: Buffer): { r: bigint; s: bigint } {
  if (signature[0] !== 0x30 || signature[1] !== signature.length - 2) return invalid("Invalid wallet signature encoding");
  let offset = 2;
  const integer = () => {
    if (signature[offset++] !== 0x02) return invalid("Invalid wallet signature encoding");
    const length = signature[offset++];
    if (length === undefined || length < 1 || length > 33 || offset + length > signature.length) return invalid("Invalid wallet signature encoding");
    const bytes = signature.subarray(offset, offset + length);
    offset += length;
    if ((bytes[0]! & 0x80) || (length > 1 && bytes[0] === 0 && !(bytes[1]! & 0x80))) return invalid("Invalid wallet signature encoding");
    const value = BigInt(hex(bytes));
    if (value === 0n || value >= P256_ORDER) return invalid("Invalid wallet signature encoding");
    return value;
  };
  const r = integer();
  const s = integer();
  if (offset !== signature.length) return invalid("Invalid wallet signature encoding");
  return { r, s };
}

/** Pure cryptographic boundary, not a session or replay check. Registration here means a
 * get-assertion proving possession after enrollment; it does not verify an attestation object.
 * The purpose label alone has no cryptographic force: issue purpose-bound offchain challenges,
 * or load an exact reviewed Safe operation digest, and atomically consume the ceremony later. */
export function verifyWalletAssertion(assertion: WalletAssertion, expected: WalletAssertionExpectation): {
  credentialId: string; userHandle: string | null; signCount: number;
  backupEligible: boolean; backedUp: boolean; authenticatorData: Hex;
  clientDataFields: string; r: bigint; s: bigint; contractSignature: Hex;
} {
  if (!assertion || !expected || !expected.credential || !PURPOSES.includes(expected.purpose) ||
      typeof expected.requireUserHandle !== "boolean") return invalid();
  const challenge = bytes32(expected.challenge);
  validateWalletRpConfiguration(expected);
  const credentialId = base64url(assertion.credentialId, 1023);
  const storedCredentialId = base64url(expected.credential.id, 1023);
  if (credentialId.length !== storedCredentialId.length || !timingSafeEqual(credentialId, storedCredentialId)) return invalid();
  const storedUserHandle = base64url(expected.credential.userHandle, 64);
  if (assertion.userHandle !== null) {
    const userHandle = base64url(assertion.userHandle, 64);
    if (userHandle.length !== storedUserHandle.length || !timingSafeEqual(userHandle, storedUserHandle)) return invalid();
  } else if (expected.requireUserHandle) return invalid("Wallet user handle required");

  // This initial profile requests no authenticator extensions. Refuse ED/AT and trailing CBOR
  // until a supported extension has an explicit parser and an interoperability fixture.
  const authenticatorData = boundedBytes(assertion.authenticatorData, 37, 37);
  if (!timingSafeEqual(authenticatorData.subarray(0, 32), sha256(expected.rpId))) return invalid("Wallet RP does not match");
  const flags = authenticatorData[32]!;
  const backupEligible = !!(flags & 0x08);
  const backedUp = !!(flags & 0x10);
  if ((flags & 0x05) !== 0x05 || (flags & 0xe2) !== 0 || (backedUp && !backupEligible) ||
      (expected.credential.backupEligible !== undefined && expected.credential.backupEligible !== backupEligible)) return invalid("Invalid wallet authenticator flags");
  const clientDataJSON = boundedBytes(assertion.clientDataJSON, 1, 2048);
  let json: string;
  try { json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(clientDataJSON); }
  catch { return invalid("Invalid wallet client data encoding"); }
  const prefix = `{"type":"webauthn.get","challenge":"${challenge.toString("base64url")}",`;
  if (!json.startsWith(prefix) || !json.endsWith("}")) return invalid("Unsupported wallet client data encoding or challenge");
  const fields = readWalletClientData(json);
  if (fields.type !== "webauthn.get" || fields.challenge !== challenge.toString("base64url") ||
      fields.origin !== expected.origin || (Object.hasOwn(fields, "crossOrigin") && fields.crossOrigin !== false) ||
      Object.hasOwn(fields, "topOrigin")) return invalid("Invalid wallet client data");
  const clientDataFields = json.slice(prefix.length, -1);
  const signature = boundedBytes(assertion.signature, 8, 72);
  const { r, s } = readDerSignature(signature);
  try {
    const key = createPublicKey({ format: "jwk", key: {
      kty: "EC", crv: "P-256",
      x: bytes32(expected.credential.publicKey.x).toString("base64url"),
      y: bytes32(expected.credential.publicKey.y).toString("base64url"),
    } });
    if (!verify("sha256", Buffer.concat([authenticatorData, sha256(clientDataJSON)]), key, signature)) return invalid("Invalid wallet signature");
  } catch { return invalid("Invalid wallet signature or public key"); }
  return {
    credentialId: assertion.credentialId, userHandle: assertion.userHandle,
    signCount: authenticatorData.readUInt32BE(33), backupEligible, backedUp,
    authenticatorData: hex(authenticatorData), clientDataFields, r, s,
    contractSignature: encodeAbiParameters([
      { type: "bytes" }, { type: "string" }, { type: "uint256" }, { type: "uint256" },
    ], [hex(authenticatorData), clientDataFields, r, s]),
  };
}
