import { keccak256, type Hex } from "viem";
import { restRequest } from "./context.js";
import { RestError, type RestActor } from "./core.js";
import {
  parseAccountId, readRequestClaims, validateAudience, verifyRequestSignature,
  type ContractOwnerVerifier,
} from "./auth/signatures.js";
import { sponsorshipSubmissionHash, verifySponsorshipApproval, verifyTransactionApproval } from "./approvals.js";
import type { StoredPlan } from "./transactions/types.js";
import type { SponsorshipRecord } from "./sponsorship/types.js";

export type DispatchApprovalWindow = Readonly<{ issuedAt: number; expiresAt: number }>;
export type DispatchAuthorityOptions = {
  audience: string;
  verifyContractOwner?: ContractOwnerVerifier;
  /** Trusted Unix seconds; final storage admission also checks the shared database clock. */
  now?: () => number;
};

function mismatch(): never {
  throw new RestError(403, "DISPATCH_AUTHORITY_MISMATCH", "Dispatch requires the authenticated principal that owns this preparation");
}
function currentAuthority(actor: RestActor) {
  const context = restRequest();
  if (!context?.authority) throw new RestError(401, "AUTH_REQUIRED", "Dispatch requires an authenticated REST request");
  if (context.signal.aborted) throw new RestError(408, "REQUEST_ABORTED", "Dispatch authorization was interrupted");
  const { principal, input } = context.authority;
  const owner = parseAccountId(actor.accountId);
  if (principal.account.id !== actor.accountId || principal.principalId !== actor.principalId ||
      principal.account.ownerAddress.toLowerCase() !== owner.ownerAddress.toLowerCase() ||
      principal.account.authorityChainId !== owner.authorityChainId || !principal.scopes.includes("relay")) return mismatch();
  const { claims, signature } = readRequestClaims(input);
  if (claims.accountId !== actor.accountId || claims.signer.toLowerCase() !== principal.signer.toLowerCase() ||
      claims.nonce !== principal.requestNonce || (claims.grantId || null) !== principal.grantId) return mismatch();
  if (principal.isOwner) {
    if (principal.grantId !== null || actor.principalId !== `owner:${actor.accountId}` ||
        claims.signer.toLowerCase() !== owner.ownerAddress.toLowerCase()) return mismatch();
  } else if (!principal.grantId || actor.principalId !== `bot:${principal.grantId}`) return mismatch();
  return { context, principal, claims, signature, input };
}

function requestBody(authority: ReturnType<typeof currentAuthority>): Record<string, unknown> {
  if (authority.claims.method !== "POST" ||
      authority.claims.contentType.split(";")[0]?.trim().toLowerCase() !== "application/json" ||
      authority.input.body.byteLength > 1_048_576) return mismatch();
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(authority.input.body));
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* No request content belongs in an authorization error. */ }
  return mismatch();
}

function transactionIntent(authority: ReturnType<typeof currentAuthority>, planId: string, stepIndex: number, transactionHash: Hex): void {
  const body = requestBody(authority);
  let raw: unknown;
  if (authority.claims.requestTarget === `/api/v1/plans/${planId}/steps/${stepIndex}/submissions`) {
    if (Object.keys(body).some((key) => !["rawSignedTransaction", "ownerApproval"].includes(key))) return mismatch();
    raw = body.rawSignedTransaction;
  } else if (authority.claims.requestTarget === `/api/v1/plans/${planId}/submissions`) {
    if (Object.keys(body).some((key) => key !== "submissions") || !Array.isArray(body.submissions) ||
        body.submissions.length < 1 || body.submissions.length > 32) return mismatch();
    const seen = new Set<number>();
    for (const entry of body.submissions) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return mismatch();
      const item = entry as Record<string, unknown>;
      if (Object.keys(item).some((key) => !["stepIndex", "rawSignedTransaction", "ownerApproval"].includes(key)) ||
          !Number.isSafeInteger(item.stepIndex) || Number(item.stepIndex) < 0 || Number(item.stepIndex) > 31 ||
          seen.has(Number(item.stepIndex))) return mismatch();
      seen.add(Number(item.stepIndex));
      if (item.stepIndex === stepIndex) raw = item.rawSignedTransaction;
    }
  } else return mismatch();
  if (typeof raw !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(raw) ||
      keccak256(raw as Hex).toLowerCase() !== transactionHash.toLowerCase()) return mismatch();
}

function sponsorshipIntent(authority: ReturnType<typeof currentAuthority>, record: SponsorshipRecord, submissionHash: Hex): void {
  const body = requestBody(authority);
  if (authority.claims.requestTarget !== `/api/v1/sponsorships/${record.id}/submissions` ||
      Object.keys(body).some((key) => !["signatures", "ownerApproval"].includes(key)) || !Array.isArray(body.signatures)) return mismatch();
  let actual: Hex;
  try { actual = sponsorshipSubmissionHash(record.commitment, body.signatures as Hex[]); }
  catch { return mismatch(); }
  if (actual.toLowerCase() !== submissionHash.toLowerCase()) return mismatch();
}

function fresh(window: DispatchApprovalWindow, now: number): void {
  if (!Number.isSafeInteger(now) || now <= 0) throw new RestError(500, "APPROVAL_CLOCK_UNAVAILABLE", "The approval clock is unavailable");
  if (!Number.isSafeInteger(window.issuedAt) || !Number.isSafeInteger(window.expiresAt) ||
      window.issuedAt <= 0 || window.expiresAt <= window.issuedAt || window.expiresAt - window.issuedAt > 300 ||
      window.expiresAt <= now || window.issuedAt > now + 30) {
    throw new RestError(403, "OWNER_APPROVAL_EXPIRED", "A fresh owner approval is required before dispatch");
  }
}

function completedWindow(authority: ReturnType<typeof currentAuthority>, window: DispatchApprovalWindow, now: number): DispatchApprovalWindow {
  if (authority.context.signal.aborted) throw new RestError(408, "REQUEST_ABORTED", "Dispatch authorization was interrupted");
  fresh(window, now);
  return Object.freeze({ issuedAt: window.issuedAt, expiresAt: window.expiresAt });
}

function normalizedOptions(options: DispatchAuthorityOptions) {
  const verifier = options.verifyContractOwner;
  return {
    audience: validateAudience(options.audience),
    now: options.now ?? (() => Math.floor(Date.now() / 1_000)),
    ...(verifier ? {
      verifyContractOwner: (async (input) => await verifier(input) === true) satisfies ContractOwnerVerifier,
    } : {}),
  };
}

async function ownerWindow(
  authority: ReturnType<typeof currentAuthority>, options: ReturnType<typeof normalizedOptions>,
): Promise<DispatchApprovalWindow | undefined> {
  if (!authority.principal.isOwner) return undefined;
  const { issuedAt, expiresAt } = authority.claims;
  const window = Object.freeze({ issuedAt, expiresAt });
  fresh(window, options.now());
  // Verify the exact snapshot again: mutable Headers cannot manufacture newer
  // consent after the request's initial authentication or during preflight.
  await verifyRequestSignature(options.audience, authority.claims, authority.signature,
    options.verifyContractOwner, authority.context.signal);
  if (authority.context.signal.aborted) throw new RestError(408, "REQUEST_ABORTED", "Dispatch authorization was interrupted");
  fresh(window, options.now());
  return window;
}

/** Install on TransactionService; every actual first or renewed dispatch calls this authorizer. */
export function createTransactionDispatchAuthorizer(inputOptions: DispatchAuthorityOptions) {
  const options = normalizedOptions(inputOptions);
  return async (plan: StoredPlan, stepIndex: number, transactionHash: Hex): Promise<DispatchApprovalWindow> => {
    const authority = currentAuthority(plan.actor);
    const binding = {
      accountId: plan.actor.accountId, principalId: plan.actor.principalId,
      planId: plan.id, commitment: plan.commitment, stepIndex, transactionHash,
    };
    if (authority.principal.isOwner) transactionIntent(authority, plan.id, stepIndex, transactionHash);
    const owner = await ownerWindow(authority, options);
    if (owner) return completedWindow(authority, owner, options.now());
    const verified = await verifyTransactionApproval(options.audience, authority.context.ownerApprovals.get(stepIndex), binding, {
      now: options.now, signal: authority.context.signal,
      ...(options.verifyContractOwner ? { verifyContractOwner: options.verifyContractOwner } : {}),
    });
    return completedWindow(authority, verified.claims, options.now());
  };
}

/** Publishing signed forwarding requests has its own approval type and exact publication hash. */
export function createSponsorshipDispatchAuthorizer(inputOptions: DispatchAuthorityOptions) {
  const options = normalizedOptions(inputOptions);
  return async (record: SponsorshipRecord, submissionHash: Hex): Promise<DispatchApprovalWindow> => {
    const authority = currentAuthority(record.actor);
    const binding = {
      accountId: record.actor.accountId, principalId: record.actor.principalId,
      sponsorshipId: record.id, commitment: record.commitment, submissionHash,
    };
    if (authority.principal.isOwner) sponsorshipIntent(authority, record, submissionHash);
    const owner = await ownerWindow(authority, options);
    if (owner) return completedWindow(authority, owner, options.now());
    const verified = await verifySponsorshipApproval(options.audience, authority.context.sponsorshipOwnerApproval, binding, {
      now: options.now, signal: authority.context.signal,
      ...(options.verifyContractOwner ? { verifyContractOwner: options.verifyContractOwner } : {}),
    });
    return completedWindow(authority, verified.claims, options.now());
  };
}
