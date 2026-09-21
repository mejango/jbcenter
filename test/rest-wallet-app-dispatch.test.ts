import { describe, expect, it } from "vitest";
import { keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { accountIdFor, buildRequestTypedData, newRequestNonce, REST_AUTH_HEADERS as H,
  type RequestClaims, type RestPrincipal, type SignedRequestInput } from "../src/rest/auth/index.js";
import { setRestAuthority, withRestRequest } from "../src/rest/context.js";
import { createSessionPlanAuthorizer, createSponsorshipDispatchAuthorizer,
  createTransactionDispatchAuthorizer, createUserOperationRequestAuthorizer } from "../src/rest/dispatchAuthority.js";
import type { StoredPlan } from "../src/rest/transactions/types.js";
import type { SponsorshipRecord } from "../src/rest/sponsorship/types.js";

const requestKey = privateKeyToAccount(`0x${"44".repeat(32)}`);
const safe = "0x3333333333333333333333333333333333333333";
const audience = "https://juicebox.center", origin = "https://beep.biz", now = 1_900_000_000;
const grantId = "11111111-1111-4111-8111-111111111111", operationId = "22222222-2222-4222-8222-222222222222";
const operationSignature = "0x1234" as Hex;
const options = { audience, now: () => now };

// Auth/storage have their own real PostgreSQL suite. This exercises the server-created app principal
// at dispatch with a real v1 request signature; the operation's owner signature is a separate boundary.
async function fixture(target = `/api/v1/user-operations/${operationId}/submissions`, document: unknown = { signature: operationSignature }) {
  const body = new TextEncoder().encode(JSON.stringify(document));
  const accountId = accountIdFor(safe, 8453), nonce = newRequestNonce();
  const claims: RequestClaims = { accountId, signer: requestKey.address, grantId, method: "POST", requestTarget: target,
    contentType: "application/json", bodyHash: keccak256(body), issuedAt: now, expiresAt: now + 60,
    nonce, idempotencyKey: "app-dispatch" };
  const input: SignedRequestInput = { method: claims.method, requestTarget: target, contentType: claims.contentType, body,
    headers: new Headers({ "content-type": claims.contentType, [H.account]: accountId, [H.signer]: requestKey.address, [H.grant]: grantId,
      [H.issuedAt]: String(now), [H.expiresAt]: String(now + 60), [H.nonce]: nonce, [H.idempotencyKey]: claims.idempotencyKey,
      [H.signature]: await requestKey.signTypedData(buildRequestTypedData(audience, claims)), origin }) };
  const principal: RestPrincipal = { kind: "wallet-app", principalId: `app:${grantId}:9007199254740993`,
    walletApp: { origin, audience, incarnation: "9007199254740993" },
    account: { id: accountId, ownerAddress: safe, authorityChainId: 8453, profile: { displayName: "", bio: "", avatarUri: null }, createdAt: now, updatedAt: now },
    signer: requestKey.address, grantId, scopes: ["read", "plan", "relay"], isOwner: false,
    requestNonce: nonce, idempotencyKey: claims.idempotencyKey };
  const actor = () => ({ accountId: principal.account.id, principalId: principal.principalId });
  const invoke = <T>(work: () => Promise<T>) => withRestRequest(new AbortController().signal, async () => {
    setRestAuthority(principal, input); return work();
  });
  return { input, principal, actor, invoke, authorize: createUserOperationRequestAuthorizer(options) };
}

describe("typed app dispatch boundary", () => {
  it("admits the exact app incarnation using the unchanged UUID-grant v1 signature", async () => {
    const f = await fixture();
    expect(await f.invoke(() => f.authorize(f.actor(), operationId, operationSignature))).toEqual({ issuedAt: now, expiresAt: now + 60 });
    expect(f.input.headers.get(H.grant)).toBe(grantId);
  });

  it.each(["bot actor", "incarnation", "origin", "audience", "owner flag", "missing kind"])("rejects %s substitution", async variant => {
    const f = await fixture();
    if (variant === "bot actor") f.principal.principalId = `bot:${grantId}`;
    if (variant === "incarnation") f.principal.walletApp!.incarnation = "9007199254740994";
    if (variant === "origin") f.input.headers.set("origin", "https://juicebox.money");
    if (variant === "audience") f.principal.walletApp!.audience = "https://other.invalid";
    if (variant === "owner flag") f.principal.isOwner = true;
    if (variant === "missing kind") delete (f.principal as { kind?: string }).kind;
    await expect(f.invoke(() => f.authorize(f.actor(), operationId, operationSignature))).rejects.toMatchObject({ code: "DISPATCH_AUTHORITY_MISMATCH" });
  });

  it("reverifies the signed body and expiry after initial app authentication", async () => {
    for (const field of ["body", "expiry"]) {
      const f = await fixture();
      if (field === "body") f.input.body = new TextEncoder().encode(` ${new TextDecoder().decode(f.input.body)}`);
      else f.input.headers.set(H.expiresAt, String(now + 120));
      await expect(f.invoke(() => f.authorize(f.actor(), operationId, operationSignature))).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });
    }
  });

  it("keeps legacy transaction/sponsorship dispatch and session installation unavailable", async () => {
    const f = await fixture();
    await f.invoke(async () => {
      await expect(createTransactionDispatchAuthorizer(options)({ actor: f.actor() } as StoredPlan, 0, keccak256("0x01")))
        .rejects.toMatchObject({ code: "DISPATCH_AUTHORITY_MISMATCH" });
      await expect(createSponsorshipDispatchAuthorizer(options)({ actor: f.actor() } as SponsorshipRecord, keccak256("0x01")))
        .rejects.toMatchObject({ code: "DISPATCH_AUTHORITY_MISMATCH" });
      await expect(createSessionPlanAuthorizer(options)(f.actor(), operationId, "activation", keccak256("0x01")))
        .rejects.toMatchObject({ code: "DISPATCH_AUTHORITY_MISMATCH" });
    });
  });
});
