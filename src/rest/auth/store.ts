import type { Address, Hex } from "viem";

export type BotScope = "read" | "plan" | "relay";
export type Profile = { displayName: string; bio: string; avatarUri: string | null };
export type Account = {
  id: string;
  ownerAddress: Address;
  authorityChainId: number;
  profile: Profile;
  createdAt: number;
  updatedAt: number;
};
export type BotGrant = {
  id: string;
  accountId: string;
  botAddress: Address;
  scopes: BotScope[];
  label: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
};
export type RestPrincipal = {
  principalId: string;
  account: Account;
  signer: Address;
  grantId: string | null;
  scopes: BotScope[];
  isOwner: boolean;
  requestNonce: Hex;
  idempotencyKey: string | null;
};
export type ActiveAuthority = {
  accountId: string;
  signer: Address;
  grantId: string | null;
  requiredScopes: BotScope[];
  ownerOnly?: boolean;
  now: number;
};
/** Server-created identity from a previously authenticated request, never client-supplied authority. */
export type RestActor = { accountId: string; principalId: string };
/**
 * Times are integer Unix seconds. The caller has already verified the request
 * signature. `now` is trusted server time, never signed client input. PostgreSQL
 * independently samples its shared database clock before granting authority.
 */
export type VerifiedRequest = {
  accountId: string;
  signer: Address;
  grantId: string | null;
  nonce: Hex;
  issuedAt: number;
  expiresAt: number;
  idempotencyKey: string | null;
  requiredScopes: BotScope[];
  ownerOnly: boolean;
  now: number;
};

export interface AccountStore {
  getAccount(id: string): Promise<Account | null>;
  enroll(account: Account, request: VerifiedRequest): Promise<RestPrincipal>;
  authorizeAndConsume(request: VerifiedRequest): Promise<RestPrincipal>;
  assertActive(authority: ActiveAuthority): Promise<void>;
  /** Only short, local durable job admission belongs in this callback; never network submission. */
  withActiveActor<T>(actor: RestActor, scopes: BotScope[], now: number, operation: () => Promise<T>): Promise<T>;
  /** The service must authorize an owner request before calling any mutation below. */
  updateProfile(accountId: string, profile: Profile, now: number): Promise<Account>;
  listBots(accountId: string): Promise<BotGrant[]>;
  registerBot(grant: BotGrant): Promise<BotGrant>;
  revokeBot(accountId: string, grantId: string, now: number): Promise<BotGrant>;
  /** PostgreSQL uses its database clock for cleanup; memory uses the supplied trusted clock. */
  cleanupExpiredNonces(now: number, limit?: number): Promise<number>;
}

export class RestAuthError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
    this.name = "RestAuthError";
  }
}

export type AccountStoreOptions = {
  maxAccounts?: number;
  maxNoncesPerAccount?: number;
  maxGrantsPerAccount?: number;
};
export type AccountStoreLimits = Required<AccountStoreOptions>;
export const ALL_BOT_SCOPES: readonly BotScope[] = ["read", "plan", "relay"];
/** Reserved within the default 1000 outstanding nonce slots so bots cannot block owner recovery. */
export const OWNER_NONCE_RESERVE = 32;

/**
 * Call only after principalFor has proved the signer. A null grant ID then means
 * owner authority. Small configured limits reserve at most half their slots;
 * a one-slot account is owner-only. The account's total cap never increases.
 */
export function nonceCapacity(maximum: number, grantId: string | null): number {
  const reserved = Math.min(OWNER_NONCE_RESERVE, Math.max(1, Math.floor(maximum / 2)));
  return grantId === null ? maximum : maximum - reserved;
}

export function accountStoreLimits(options: AccountStoreOptions = {}): AccountStoreLimits {
  const limits = {
    maxAccounts: options.maxAccounts ?? 100_000,
    maxNoncesPerAccount: options.maxNoncesPerAccount ?? 1_000,
    maxGrantsPerAccount: options.maxGrantsPerAccount ?? 100,
  };
  for (const [key, maximum] of Object.entries({
    maxAccounts: 100_000,
    maxNoncesPerAccount: 1_000,
    maxGrantsPerAccount: 100,
  })) {
    const value = limits[key as keyof AccountStoreLimits];
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new TypeError(`Invalid account store limit: ${key}`);
    }
  }
  return limits;
}

export function assertTime(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RestAuthError("AUTH_REQUIRED", 401, "Invalid request time");
  }
}

export function assertIdentifier(value: string): void {
  if (typeof value !== "string" || !/^[a-zA-Z0-9:_-]{1,192}$/.test(value)) {
    throw new RestAuthError("FORBIDDEN", 403, "Invalid account or grant identifier");
  }
}

export function assertAddress(value: string): void {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new RestAuthError("AUTH_REQUIRED", 401, "Invalid signer address");
  }
}

function boundedText(value: string, bytes: number): boolean {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= bytes && !value.includes("\0");
}

export function assertProfile(profile: Profile): void {
  if (!profile || !boundedText(profile.displayName, 120) || !boundedText(profile.bio, 2_000)
    || (profile.avatarUri !== null && !boundedText(profile.avatarUri, 2_048))) {
    throw new RestAuthError("STORAGE_LIMIT", 429, "Profile storage limit exceeded");
  }
}

export function assertAccount(account: Account): void {
  assertIdentifier(account.id);
  assertAddress(account.ownerAddress);
  assertProfile(account.profile);
  assertTime(account.createdAt);
  assertTime(account.updatedAt);
  if (!Number.isSafeInteger(account.authorityChainId) || account.authorityChainId < 1
    || account.updatedAt < account.createdAt) {
    throw new RestAuthError("FORBIDDEN", 403, "Invalid account");
  }
}

function validScopes(scopes: BotScope[], allowEmpty: boolean): boolean {
  return Array.isArray(scopes) && (allowEmpty || scopes.length > 0) && scopes.length <= 3
    && new Set(scopes).size === scopes.length && scopes.every((scope) => ALL_BOT_SCOPES.includes(scope));
}

/** Grant profiles are cumulative and ordered; validation never expands or sorts the signed list. */
export function isCanonicalGrantScopes(scopes: unknown): scopes is BotScope[] {
  return Array.isArray(scopes) && scopes.length >= 1 && scopes.length <= ALL_BOT_SCOPES.length
    && ALL_BOT_SCOPES.slice(0, scopes.length).every((scope, index) => scopes[index] === scope);
}

export function assertGrant(grant: BotGrant): void {
  assertIdentifier(grant.id);
  assertIdentifier(grant.accountId);
  assertAddress(grant.botAddress);
  assertTime(grant.createdAt);
  assertTime(grant.expiresAt);
  if (grant.revokedAt !== null || grant.expiresAt <= grant.createdAt
    || !isCanonicalGrantScopes(grant.scopes) || !boundedText(grant.label, 120)) {
    throw new RestAuthError("FORBIDDEN", 403, "Invalid bot grant");
  }
}

export function assertRequest(request: VerifiedRequest): void {
  assertIdentifier(request.accountId);
  assertAddress(request.signer);
  if (request.grantId !== null) assertIdentifier(request.grantId);
  assertTime(request.now);
  assertTime(request.issuedAt);
  assertTime(request.expiresAt);
  if (!/^0x[0-9a-fA-F]{64}$/.test(request.nonce)
    || request.expiresAt <= request.now || request.expiresAt <= request.issuedAt
    || request.issuedAt > request.now + 30 || request.expiresAt - request.issuedAt > 300
    || !validScopes(request.requiredScopes, true) || typeof request.ownerOnly !== "boolean"
    || (request.idempotencyKey !== null
      && (typeof request.idempotencyKey !== "string" || !/^[\x21-\x7e]{1,128}$/.test(request.idempotencyKey)))) {
    throw new RestAuthError("AUTH_REQUIRED", 401, "Invalid or expired authenticated request");
  }
}

/** Authorization is checked again while the storage implementation holds the account lock. */
export function principalFor(account: Account, grant: BotGrant | null, request: VerifiedRequest): RestPrincipal {
  const isOwner = request.grantId === null
    && account.ownerAddress.toLowerCase() === request.signer.toLowerCase();
  if (request.accountId !== account.id || (!isOwner && (request.ownerOnly || !grant
    || grant.accountId !== account.id || grant.id !== request.grantId
    || grant.botAddress.toLowerCase() !== request.signer.toLowerCase()
    || grant.revokedAt !== null || grant.expiresAt <= request.now || grant.createdAt > request.now
    || !isCanonicalGrantScopes(grant.scopes)))) {
    throw new RestAuthError("FORBIDDEN", 403, "Account authority is missing or expired");
  }
  const scopes = isOwner ? [...ALL_BOT_SCOPES] : [...grant!.scopes];
  if (!request.requiredScopes.every((scope) => scopes.includes(scope))) {
    throw new RestAuthError("FORBIDDEN", 403, "Bot grant does not permit this operation");
  }
  return {
    principalId: isOwner ? `owner:${account.id}` : `bot:${grant!.id}`,
    account: structuredClone(account),
    signer: request.signer,
    grantId: request.grantId,
    scopes,
    isOwner,
    requestNonce: request.nonce,
    idempotencyKey: request.idempotencyKey,
  };
}

export function authorityRequest(authority: ActiveAuthority): VerifiedRequest {
  assertIdentifier(authority.accountId);
  assertAddress(authority.signer);
  if (authority.grantId !== null) assertIdentifier(authority.grantId);
  assertTime(authority.now);
  if (!validScopes(authority.requiredScopes, true)
    || (authority.ownerOnly !== undefined && typeof authority.ownerOnly !== "boolean")) {
    throw new RestAuthError("FORBIDDEN", 403, "Invalid required authority");
  }
  return {
    ...authority,
    ownerOnly: authority.ownerOnly ?? false,
    nonce: `0x${"00".repeat(32)}`,
    issuedAt: authority.now,
    expiresAt: authority.now + 1,
    idempotencyKey: null,
  };
}

export function actorGrantId(actor: RestActor): string | null {
  assertIdentifier(actor.accountId);
  if (actor.principalId === `owner:${actor.accountId}`) return null;
  if (typeof actor.principalId === "string" && actor.principalId.startsWith("bot:")) {
    const id = actor.principalId.slice(4);
    assertIdentifier(id);
    return id;
  }
  throw new RestAuthError("FORBIDDEN", 403, "Invalid authenticated actor");
}

export function assertActorAuthority(account: Account, grant: BotGrant | null, actor: RestActor, scopes: BotScope[], now: number): void {
  const grantId = actorGrantId(actor);
  const request = authorityRequest({
    accountId: actor.accountId,
    signer: grantId === null ? account.ownerAddress : grant?.botAddress ?? account.ownerAddress,
    grantId,
    requiredScopes: scopes,
    now,
  });
  principalFor(account, grant, request);
}

export function cleanupLimit(value = 1_000): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new TypeError("Nonce cleanup limit must be between 1 and 10000");
  }
  return value;
}
