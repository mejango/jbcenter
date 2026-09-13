import { randomBytes, randomUUID } from "node:crypto";
import { RestError } from "../core.js";

export const walletCeremonyPurposes = ["registration", "login", "session", "deploy", "payment", "rotate"] as const;
export type WalletCeremonyPurpose = typeof walletCeremonyPurposes[number];
export const walletCeremonyMaxLifetimeMs = 300_000;
export const walletCeremonyRetentionMs = 86_400_000;

/** Server-owned input only. Never renew an old ID/challenge with a different expiry. */
export interface WalletCeremonyDraft {
  id: string;
  accountId: string;
  purpose: WalletCeremonyPurpose;
  /** SHA-256 of the canonical trusted context, including RP/origin and exact operation where applicable. */
  contextDigest: string;
  challenge: string;
  /** Absolute Unix milliseconds. Database time, rather than this caller's clock, determines admission. */
  expiresAt: number;
}

export interface WalletCeremony extends WalletCeremonyDraft {
  createdAt: number;
  retainUntil: number;
  consumedAt: number | null;
  proofDigest: string | null;
  resultId: string | null;
}

export interface WalletCeremonyConsume extends WalletCeremonyDraft {
  /** Semantic verified credential and operation commitment, not mutable raw signature bytes. */
  proofDigest: string;
  /** Fixed UUID of a durable operation prepared before consumption; never a token or secret. */
  resultId: string;
}

/** Internal service assertion after verifying an existing wallet's authority. This shape is not
 * proof verification and must never be built by forwarding a request body or supplied account ID. */
export interface TrustedWalletControlAdmission {
  accountId: string;
  contextDigest: string;
  verifiedProofDigest: string;
}

export type WalletControlCeremonyDraft = WalletCeremonyDraft & { purpose: "login" | "rotate" };

/** This creates a challenge, not an identity, verified credential, session or spending authority. */
export function createWalletCeremony(input: Pick<WalletCeremonyDraft, "accountId" | "purpose" | "contextDigest" | "expiresAt">): WalletCeremonyDraft {
  const result = { ...input, id: randomUUID(), challenge: randomBytes(32).toString("base64url") };
  assertWalletCeremonyDraft(result);
  return result;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const fields = ["id", "accountId", "purpose", "contextDigest", "challenge", "expiresAt"];

export function invalidWalletCeremony(): never {
  throw new RestError(400, "WALLET_CEREMONY_INVALID", "Wallet ceremony fields or bounds are invalid.");
}

export function assertWalletCeremonyDraft(input: WalletCeremonyDraft, consumption = false): void {
  if (!input || typeof input !== "object") invalidWalletCeremony();
  const allowed = consumption ? [...fields, "proofDigest", "resultId"] : fields;
  if (Object.keys(input).length !== allowed.length || Object.keys(input).some(key => !allowed.includes(key))
    || typeof input.id !== "string" || !uuid.test(input.id)
    || typeof input.accountId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/.test(input.accountId)
    || !walletCeremonyPurposes.includes(input.purpose)
    || typeof input.contextDigest !== "string" || !digest.test(input.contextDigest)
    || typeof input.challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.challenge)
    || Buffer.from(input.challenge, "base64url").toString("base64url") !== input.challenge
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt < 1) invalidWalletCeremony();
  if (consumption) {
    const request = input as WalletCeremonyConsume;
    if (typeof request.proofDigest !== "string" || !digest.test(request.proofDigest)
      || typeof request.resultId !== "string" || !uuid.test(request.resultId)) invalidWalletCeremony();
  }
}

export function sameWalletCeremony(record: WalletCeremony, input: WalletCeremonyDraft): boolean {
  return record.id === input.id && record.accountId === input.accountId && record.purpose === input.purpose
    && record.contextDigest === input.contextDigest && record.challenge === input.challenge && record.expiresAt === input.expiresAt;
}
