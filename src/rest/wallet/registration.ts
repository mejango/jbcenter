import { createHash, createPublicKey } from "node:crypto";
import { decode, type DecodeOptions } from "cbor2";
import type { Hex } from "viem";
import { readWalletClientData, validateWalletRpConfiguration } from "./webauthn.js";

export type WalletRegistrationResponse = {
  type: "public-key";
  credentialId: string;
  rawId: Uint8Array;
  clientDataJSON: Uint8Array;
  attestationObject: Uint8Array;
};
export type WalletRegistrationExpectation = {
  /** Exact bytes issued for navigator.credentials.create, loaded from the enrollment intent. */
  challenge: Hex;
  rpId: string;
  origin: string;
  /** Opaque stable handle supplied in creation options. It is not returned/proven by attestation. */
  userHandle: string;
  /** The one origin admitted to frame the page the passkey is created on: a cross-origin creation must
   * then name it as its top origin. Absent: the creation must not be cross-origin at all. */
  topOrigin?: string;
};
/** An unproven candidate, never an active credential, session, hardware claim or deployment approval. */
export type WalletRegistrationCandidate = {
  credentialId: string;
  userHandle: string;
  publicKey: { x: Hex; y: Hex };
  signCount: number;
  backupEligible: boolean;
  backedUp: boolean;
  aaguid: Hex;
};
export class WalletRegistrationError extends Error {
  constructor() { super("Invalid or unsupported wallet registration"); this.name = "WalletRegistrationError"; }
}
const invalid = (): never => { throw new WalletRegistrationError(); };
const hex = (value: Uint8Array): Hex => `0x${Buffer.from(value).toString("hex")}`;
function boundedBytes(value: unknown, min: number, max: number): Buffer {
  if (!(value instanceof Uint8Array) || value.length < min || value.length > max) return invalid();
  return Buffer.from(value);
}
function base64url(value: unknown, max: number): Buffer {
  if (typeof value !== "string" || !value.length || value.length > Math.ceil(max * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) return invalid();
  const bytes = Buffer.from(value, "base64url");
  if (!bytes.length || bytes.length > max || bytes.toString("base64url") !== value) return invalid();
  return bytes;
}

const cborOptions: DecodeOptions = {
  maxDepth: 4, preferMap: true, ignoreGlobalTags: true, tags: null,
  rejectFloats: true, rejectStreaming: true, rejectUndefined: true, rejectSimple: true,
  // cbor2's encoded-key duplicate check does not catch equal keys encoded with different widths.
  // Preserve integer/string types and reject duplicate decoded keys before constructing any map.
  createObject(entries) {
    if (entries.length > 8) return invalid();
    const map = new Map<string | number, unknown>();
    for (const [key, value] of entries) {
      if ((typeof key !== "string" && !(typeof key === "number" && Number.isSafeInteger(key))) || map.has(key)) return invalid();
      map.set(key, value);
    }
    return map;
  },
};
function exactMap(value: unknown, keys: readonly (string | number)[]): Map<string | number, unknown> {
  if (!(value instanceof Map) || value.size !== keys.length || keys.some(key => !value.has(key))) return invalid();
  return value;
}

/** Parses the initial none/ES256/no-extensions browser profile. None attestation carries no
 * possession signature: keep the result pending until a separate registration-purpose get proof
 * binds this credential, user handle and exact intended initializer to a server-owned intent.
 * Ceremony expiry/consumption and account activation belong to one durable consumer. This pure
 * parser accepts no timestamp; callers must preserve their stored units (currently milliseconds).
 * Byte caps apply before the general CBOR decoder, whose tag results face exact-schema rejection. */
export function parseWalletRegistration(response: WalletRegistrationResponse, expected: WalletRegistrationExpectation): WalletRegistrationCandidate {
  try {
    if (!response || !expected || response.type !== "public-key") return invalid();
    validateWalletRpConfiguration(expected);
    if (typeof expected.challenge !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(expected.challenge)) return invalid();
    base64url(expected.userHandle, 64);
    const credentialId = base64url(response.credentialId, 1023);
    const rawId = boundedBytes(response.rawId, 1, 1023);
    if (!rawId.equals(credentialId)) return invalid();

    const clientDataBytes = boundedBytes(response.clientDataJSON, 1, 2048);
    const json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(clientDataBytes);
    const clientData = readWalletClientData(json);
    if (clientData.type !== "webauthn.create" ||
        clientData.challenge !== Buffer.from(expected.challenge.slice(2), "hex").toString("base64url") ||
        clientData.origin !== expected.origin) return invalid();
    if (clientData.crossOrigin === true) {
      if (!expected.topOrigin || (Object.hasOwn(clientData, "topOrigin") && clientData.topOrigin !== expected.topOrigin)) return invalid();
    } else if ((Object.hasOwn(clientData, "crossOrigin") && clientData.crossOrigin !== false) || Object.hasOwn(clientData, "topOrigin")) return invalid();

    const attestation = exactMap(decode(boundedBytes(response.attestationObject, 1, 2048), cborOptions), ["fmt", "attStmt", "authData"]);
    if (attestation.get("fmt") !== "none") return invalid();
    exactMap(attestation.get("attStmt"), []);
    const authData = boundedBytes(attestation.get("authData"), 56, 2048);
    if (!authData.subarray(0, 32).equals(createHash("sha256").update(expected.rpId).digest())) return invalid();
    const flags = authData[32]!;
    const backupEligible = !!(flags & 0x08);
    const backedUp = !!(flags & 0x10);
    if ((flags & 0x45) !== 0x45 || (flags & 0xa2) !== 0 || (backedUp && !backupEligible)) return invalid();
    const credentialLength = authData.readUInt16BE(53);
    if (credentialLength !== credentialId.length || 55 + credentialLength >= authData.length ||
        !authData.subarray(55, 55 + credentialLength).equals(credentialId)) return invalid();

    // No ED flag is accepted, so all remaining bytes must be exactly one COSE key, with no trailer.
    const cose = exactMap(decode(authData.subarray(55 + credentialLength), cborOptions), [1, 3, -1, -2, -3]);
    if (cose.get(1) !== 2 || cose.get(3) !== -7 || cose.get(-1) !== 1) return invalid();
    const x = boundedBytes(cose.get(-2), 32, 32);
    const y = boundedBytes(cose.get(-3), 32, 32);
    // Native key import validates the ES256 curve point; no custom elliptic-curve implementation.
    createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: x.toString("base64url"), y: y.toString("base64url") } });
    return {
      credentialId: response.credentialId, userHandle: expected.userHandle,
      publicKey: { x: hex(x), y: hex(y) }, signCount: authData.readUInt32BE(33),
      backupEligible, backedUp, aaguid: hex(authData.subarray(37, 53)),
    };
  } catch { return invalid(); }
}
