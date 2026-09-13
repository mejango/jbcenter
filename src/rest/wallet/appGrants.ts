import { types } from "node:util";
import { getAddress, isAddress, type Address } from "viem";
import { validateAudience } from "../auth/signatures.js";
import { RestAuthError } from "../auth/store.js";
import { validateWalletPolicyCallback, validateWalletPolicyOrigin } from "./policy.js";

export const walletAppGrantMaximumLifetimeSeconds = 3600;
export const walletAppGrantRetentionSeconds = 86400;
export const walletAppBigintMaximum = 9223372036854775807n;
export const walletAppMaximumTime = Math.floor(Number.MAX_SAFE_INTEGER / 1000) - walletAppGrantRetentionSeconds;
export interface WalletAppGrant {
  kind: "wallet-app";
  id: string;
  incarnation: string;
  accountId: string;
  signerAddress: Address;
  scopes: ["read", "plan", "relay"];
  origin: string;
  callbackUri: string;
  audience: string;
  appGeneration: number;
  authorityEpoch: string;
  sessionEpoch: string;
  /** Unix seconds, matching the existing REST auth lifetime. */
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  retainUntil: number;
}
export interface WalletAppGrantAdmission {
  accountId: string;
  signerAddress: Address;
  origin: string;
  callbackUri: string;
  audience: string;
  expectedAppGeneration: number;
  expectedAuthorityEpoch: string;
  expectedSessionEpoch: string;
  expiresAt: number;
}
export interface WalletAuthority {
  accountId: string;
  authorityEpoch: string;
  /** Account-wide logout generation; this is not an individual browser session. */
  sessionEpoch: string;
  updatedAt: number;
}
export type WalletAppAuthorityContext =
  | { kind: "request"; audience: string; origin: string | null; expiresAt: number }
  | { kind: "actor"; principalId: string; audience?: string };
export interface WalletAuthorityAdvance {
  accountId: string;
  expectedAuthorityEpoch: string;
  expectedSessionEpoch: string;
  kind: "logout" | "authority";
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const accountPrefix = "eip155:8453:";
export function invalidWalletAppGrant(): never {
  throw new RestAuthError("WALLET_APP_GRANT_INVALID", 400, "Wallet app grant fields or bounds are invalid.");
}
export function inactiveWalletAppGrant(): never {
  throw new RestAuthError("FORBIDDEN", 403, "Wallet application authority is missing, changed or expired.");
}
/** Read ordinary own data once; reject executable object shapes before inspecting them. */
export function walletAppFields(input: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!input || typeof input !== "object" || types.isProxy(input) || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalidWalletAppGrant();
  const keys = Reflect.ownKeys(input), allowed = [...required, ...optional];
  if (keys.length < required.length || keys.length > allowed.length
    || keys.some(key => typeof key !== "string" || !allowed.includes(key))) invalidWalletAppGrant();
  const copy: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
    if (!("value" in descriptor) || !descriptor.enumerable) invalidWalletAppGrant();
    copy[key] = descriptor.value;
  }
  if (required.some(key => !Object.hasOwn(copy, key))) invalidWalletAppGrant();
  return copy;
}
export function walletAppUuid(value: unknown): value is string { return typeof value === "string" && uuid.test(value); }
export function walletAppBigint(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= walletAppBigintMaximum;
}
export function walletAppTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= walletAppMaximumTime;
}
export function walletAppAccount(value: unknown): value is string {
  return typeof value === "string" && /^eip155:8453:0x[0-9a-f]{40}$/.test(value) && BigInt(value.slice(accountPrefix.length)) > 1n;
}
function generation(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
export function walletAppAudience(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || Buffer.byteLength(value, "utf8") > 2048) invalidWalletAppGrant();
  try { if (validateAudience(value) !== value) invalidWalletAppGrant(); } catch { invalidWalletAppGrant(); }
  return value;
}
function location(origin: unknown, callbackUri: unknown): { origin: string; callbackUri: string } {
  try {
    const checked = validateWalletPolicyOrigin(origin);
    return { origin: checked, callbackUri: validateWalletPolicyCallback(callbackUri, checked) };
  } catch { invalidWalletAppGrant(); }
}
export function validateWalletAppGrantAdmission(input: unknown): WalletAppGrantAdmission {
  const v = walletAppFields(input, ["accountId", "signerAddress", "origin", "callbackUri", "audience", "expectedAppGeneration",
    "expectedAuthorityEpoch", "expectedSessionEpoch", "expiresAt"]);
  if (!walletAppAccount(v.accountId) || typeof v.signerAddress !== "string" || !isAddress(v.signerAddress)
    || BigInt(v.signerAddress) <= 1n || v.signerAddress.toLowerCase() === v.accountId.slice(accountPrefix.length)
    || !generation(v.expectedAppGeneration) || !walletAppBigint(v.expectedAuthorityEpoch)
    || !walletAppBigint(v.expectedSessionEpoch) || !walletAppTime(v.expiresAt)) invalidWalletAppGrant();
  return { accountId: v.accountId, signerAddress: getAddress(v.signerAddress).toLowerCase() as Address,
    ...location(v.origin, v.callbackUri), audience: walletAppAudience(v.audience), expectedAppGeneration: v.expectedAppGeneration,
    expectedAuthorityEpoch: v.expectedAuthorityEpoch, expectedSessionEpoch: v.expectedSessionEpoch, expiresAt: v.expiresAt };
}
export function validateWalletAppGrant(input: unknown): WalletAppGrant {
  const v = walletAppFields(input, ["kind", "id", "incarnation", "accountId", "signerAddress", "scopes", "origin", "callbackUri", "audience",
    "appGeneration", "authorityEpoch", "sessionEpoch", "createdAt", "expiresAt", "revokedAt", "retainUntil"]);
  const base = validateWalletAppGrantAdmission({ accountId: v.accountId, signerAddress: v.signerAddress,
    origin: v.origin, callbackUri: v.callbackUri, audience: v.audience, expectedAppGeneration: v.appGeneration,
    expectedAuthorityEpoch: v.authorityEpoch, expectedSessionEpoch: v.sessionEpoch, expiresAt: v.expiresAt });
  if (v.kind !== "wallet-app" || !walletAppUuid(v.id) || !walletAppBigint(v.incarnation) || !walletAppTime(v.createdAt)
    || v.signerAddress !== base.signerAddress || base.expiresAt <= v.createdAt
    || base.expiresAt - v.createdAt > walletAppGrantMaximumLifetimeSeconds
    || v.retainUntil !== base.expiresAt + walletAppGrantRetentionSeconds
    || (v.revokedAt !== null && (!walletAppTime(v.revokedAt) || v.revokedAt < v.createdAt))) invalidWalletAppGrant();
  if (!Array.isArray(v.scopes) || types.isProxy(v.scopes) || Object.getPrototypeOf(v.scopes) !== Array.prototype
    || v.scopes.length !== 3 || Reflect.ownKeys(v.scopes).length !== 4) invalidWalletAppGrant();
  for (const [index, scope] of ["read", "plan", "relay"].entries()) {
    const descriptor = Object.getOwnPropertyDescriptor(v.scopes, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || descriptor.value !== scope) invalidWalletAppGrant();
  }
  return { kind: "wallet-app", id: v.id, incarnation: v.incarnation, accountId: base.accountId, signerAddress: base.signerAddress,
    scopes: ["read", "plan", "relay"], origin: base.origin, callbackUri: base.callbackUri, audience: base.audience,
    appGeneration: base.expectedAppGeneration, authorityEpoch: base.expectedAuthorityEpoch, sessionEpoch: base.expectedSessionEpoch,
    createdAt: v.createdAt, expiresAt: base.expiresAt, revokedAt: v.revokedAt as number | null, retainUntil: v.retainUntil as number };
}
export function walletAppPrincipalId(grant: Pick<WalletAppGrant, "id" | "incarnation">): string {
  if (!walletAppUuid(grant.id) || !walletAppBigint(grant.incarnation)) invalidWalletAppGrant();
  return `app:${grant.id}:${grant.incarnation}`;
}
export function parseWalletAppPrincipalId(value: unknown): { id: string; incarnation: string } | null {
  if (typeof value !== "string" || value.length > 60) return null;
  const match = /^app:([^:]+):([^:]+)$/.exec(value);
  return match && walletAppUuid(match[1]) && walletAppBigint(match[2]) ? { id: match[1], incarnation: match[2] } : null;
}
