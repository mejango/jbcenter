import { randomUUID } from "node:crypto";
import { getAddress, isAddress, type Hex } from "viem";
import {
  RestAuthError,
  isCanonicalGrantScopes,
  type Account,
  type AccountStore,
  type BotGrant,
  type BotScope,
  type Profile,
  type RestPrincipal,
  type VerifiedRequest,
} from "./store.js";
import {
  parseAccountId,
  readRequestClaims,
  validateAudience,
  verifyBotProof,
  verifyRequestSignature,
  type ContractOwnerVerifier,
  type SignedRequestInput,
} from "./signatures.js";

export type RestAuthOptions = {
  store: AccountStore;
  audience: string;
  verifyContractOwner?: ContractOwnerVerifier;
  /** Unix seconds; defaults to the server's clock. */
  now?: () => number;
};

export type RegisterBotInput = {
  botAddress: string;
  scopes?: BotScope[];
  expiresAt: number;
  label?: string;
  proofSignature: Hex;
};

const allScopes: BotScope[] = ["read", "plan", "relay"];

function bad(message: string): never {
  throw new RestAuthError("INVALID_INPUT", 400, message);
}

function boundedText(value: unknown, maximumBytes: number, name: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > maximumBytes || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    return bad(`Invalid ${name}`);
  }
  return value;
}

export function validateProfile(input: unknown): Profile {
  if (!input || typeof input !== "object" || Array.isArray(input)) return bad("Invalid account profile");
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["displayName", "bio", "avatarUri"].includes(key))) return bad("Unknown profile field");
  const displayName = boundedText(record.displayName ?? "", 120, "display name");
  const bio = boundedText(record.bio ?? "", 2_000, "biography");
  const avatarUri = record.avatarUri === null || record.avatarUri === undefined ? null
    : boundedText(record.avatarUri, 2_048, "avatar URI");
  if (avatarUri !== null) {
    let url: URL;
    try { url = new URL(avatarUri); } catch { return bad("Avatar URI must be HTTPS or IPFS"); }
    if (!["https:", "ipfs:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
      return bad("Avatar URI must be HTTPS or IPFS without credentials");
    }
  }
  return { displayName, bio, avatarUri };
}

export function createRestAuth(options: RestAuthOptions) {
  const audience = validateAudience(options.audience);
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  const issuedPrincipals = new WeakSet<RestPrincipal>();

  async function verify(input: SignedRequestInput, requiredScopes: BotScope[], ownerOnly: boolean): Promise<VerifiedRequest> {
    const { claims, signature } = readRequestClaims(input);
    const current = now();
    if (!Number.isSafeInteger(current) || claims.expiresAt <= current || claims.issuedAt > current + 30 ||
      claims.expiresAt <= claims.issuedAt || claims.expiresAt > claims.issuedAt + 300) {
      throw new RestAuthError("AUTH_EXPIRED", 401, "Request signature expired or has an invalid validity window");
    }
    if (requiredScopes.some((scope) => !allScopes.includes(scope))) return bad("Unknown required scope");
    await verifyRequestSignature(audience, claims, signature, options.verifyContractOwner, input.signal);
    const verifiedAt = now();
    if (!Number.isSafeInteger(verifiedAt) || claims.expiresAt <= verifiedAt || claims.issuedAt > verifiedAt + 30) {
      throw new RestAuthError("AUTH_EXPIRED", 401, "Request signature expired during verification");
    }
    return {
      accountId: claims.accountId,
      signer: claims.signer,
      grantId: claims.grantId || null,
      nonce: claims.nonce,
      issuedAt: claims.issuedAt,
      expiresAt: claims.expiresAt,
      idempotencyKey: claims.idempotencyKey || null,
      requiredScopes,
      ownerOnly,
      now: verifiedAt,
    };
  }

  function remember(principal: RestPrincipal): RestPrincipal {
    issuedPrincipals.add(principal);
    return principal;
  }

  async function authenticate(input: SignedRequestInput, requiredScopes: BotScope[] = ["read"], ownerOnly = false): Promise<RestPrincipal> {
    return remember(await options.store.authorizeAndConsume(await verify(input, requiredScopes, ownerOnly)));
  }

  async function assertActive(principal: RestPrincipal, scope: BotScope = "read", ownerOnly = false): Promise<void> {
    // Callers may persist a principal for queued work. Always recheck durable authority;
    // the object itself is never an authorization token.
    await options.store.assertActive({
      accountId: principal.account.id,
      signer: principal.signer,
      grantId: principal.grantId,
      requiredScopes: [scope],
      ownerOnly,
      now: now(),
    });
  }

  function requireAuthenticatedOwner(principal: RestPrincipal): void {
    if (!issuedPrincipals.has(principal) || !principal.isOwner || principal.grantId !== null) {
      throw new RestAuthError("FORBIDDEN", 403, "This action requires an authenticated account owner");
    }
  }

  async function enroll(input: SignedRequestInput): Promise<RestPrincipal> {
    const request = await verify(input, allScopes, true);
    const owner = parseAccountId(request.accountId);
    if (request.grantId !== null || request.signer.toLowerCase() !== owner.ownerAddress.toLowerCase()) {
      throw new RestAuthError("FORBIDDEN", 403, "Only the owner wallet can enroll its account");
    }
    const account: Account = {
      id: request.accountId,
      ...owner,
      profile: { displayName: "", bio: "", avatarUri: null },
      createdAt: request.now,
      updatedAt: request.now,
    };
    return remember(await options.store.enroll(account, request));
  }

  async function getProfile(principal: RestPrincipal): Promise<Account> {
    await assertActive(principal, "read");
    const account = await options.store.getAccount(principal.account.id);
    if (!account) throw new RestAuthError("ACCOUNT_NOT_FOUND", 404, "Account does not exist");
    return account;
  }

  async function updateProfile(principal: RestPrincipal, input: unknown): Promise<Account> {
    requireAuthenticatedOwner(principal);
    return options.store.updateProfile(principal.account.id, validateProfile(input), now());
  }

  async function listBots(principal: RestPrincipal): Promise<BotGrant[]> {
    requireAuthenticatedOwner(principal);
    return options.store.listBots(principal.account.id);
  }

  async function registerBot(principal: RestPrincipal, input: RegisterBotInput): Promise<BotGrant> {
    requireAuthenticatedOwner(principal);
    if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some((key) => !["botAddress", "scopes", "expiresAt", "label", "proofSignature"].includes(key))) {
      return bad("Invalid bot registration");
    }
    if (typeof input.botAddress !== "string" || !isAddress(input.botAddress) || input.botAddress.toLowerCase() === principal.account.ownerAddress.toLowerCase()) {
      return bad("Bot address must be an EOA distinct from the account owner");
    }
    const scopes = input.scopes ?? ["read"];
    if (!Array.isArray(scopes) || !isCanonicalGrantScopes(scopes)) {
      return bad("Bot scopes must be [read], [read, plan], or [read, plan, relay] in that order");
    }
    const current = now();
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= current || input.expiresAt > current + 365 * 86_400) {
      return bad("Bot expiry must be in the future and within one year");
    }
    const label = boundedText(input.label ?? "", 120, "bot label");
    const botAddress = getAddress(input.botAddress);
    await verifyBotProof(audience, {
      accountId: principal.account.id, botAddress, scopes,
      expiresAt: input.expiresAt, label,
      ownerRequestNonce: principal.requestNonce,
    }, input.proofSignature);
    return options.store.registerBot({
      id: randomUUID(), accountId: principal.account.id, botAddress,
      scopes: [...scopes], expiresAt: input.expiresAt, label,
      createdAt: current, revokedAt: null,
    });
  }

  async function revokeBot(principal: RestPrincipal, grantId: string): Promise<BotGrant> {
    requireAuthenticatedOwner(principal);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(grantId)) {
      return bad("Invalid bot grant identifier");
    }
    return options.store.revokeBot(principal.account.id, grantId, now());
  }

  return { audience, authenticate, assertActive, enroll, getProfile, updateProfile, listBots, registerBot, revokeBot };
}

export type RestAuth = ReturnType<typeof createRestAuth>;
