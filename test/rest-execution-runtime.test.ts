import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashTypedData, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { accountIdFor, buildRequestTypedData, createRestAuth, MemoryAccountStore, newRequestNonce,
  REST_AUTH_HEADERS as H, type BotScope, type RequestClaims, type RestPrincipal, type SignedRequestInput } from "../src/rest/auth/index.js";
import { createSessionPlanAuthorizer, createUserOperationRequestAuthorizer } from "../src/rest/dispatchAuthority.js";
import { setRestAuthority, withRestRequest } from "../src/rest/context.js";

// Public deterministic test keys. No network publication or live contract calls.
const owner = privateKeyToAccount(`0x${"37".repeat(32)}`), bot = privateKeyToAccount(`0x${"38".repeat(32)}`);
const audience = "https://juicebox.center", start = 1_900_000_000;
const accountId = accountIdFor(owner.address, 1), id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const compiledHash = `0x${"ab".repeat(32)}` as Hex, operationSignature = "0x1234" as Hex;
type Authority = { input: SignedRequestInput; principal: RestPrincipal; claims: RequestClaims };
async function signed(target: string, body: unknown, signer = owner, grantId = "") {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const claims: RequestClaims = { accountId, signer: signer.address, grantId, method: "POST", requestTarget: target,
    contentType: "application/json", bodyHash: keccak256(bytes), issuedAt: start, expiresAt: start + 60,
    nonce: newRequestNonce(), idempotencyKey: "execution-runtime-test" };
  const signature = await signer.signTypedData(buildRequestTypedData(audience, claims));
  const input: SignedRequestInput = { method: claims.method, requestTarget: target, contentType: claims.contentType, body: bytes,
    headers: new Headers({ "content-type": claims.contentType, [H.account]: accountId, [H.signer]: signer.address, [H.grant]: grantId, [H.issuedAt]: String(claims.issuedAt),
      [H.expiresAt]: String(claims.expiresAt), [H.nonce]: claims.nonce, [H.signature]: signature, [H.idempotencyKey]: claims.idempotencyKey }) };
  return { input, claims };
}
async function fixture() {
  let now = start;
  const store = new MemoryAccountStore(), auth = createRestAuth({ audience, store, now: () => now });
  await auth.enroll((await signed("/api/v1/accounts/enroll", {})).input);
  const grantId = randomUUID();
  await store.registerBot({ id: grantId, accountId, botAddress: bot.address, scopes: ["read", "plan", "relay"],
    label: "Execution authorization fixture", createdAt: start, expiresAt: start + 3600, revokedAt: null });
  async function authority(target: string, body: unknown, useBot = false, scopes: BotScope[] = ["relay"]): Promise<Authority> {
    const request = await signed(target, body, useBot ? bot : owner, useBot ? grantId : "");
    return { ...request, principal: await auth.authenticate(request.input, scopes) };
  }
  const options = { audience, now: () => now };
  return { authority, session: createSessionPlanAuthorizer(options), operation: createUserOperationRequestAuthorizer(options),
    setNow: (value: number) => { now = value; } };
}
const actor = (authority: Authority) => ({ accountId: authority.principal.account.id, principalId: authority.principal.principalId });
function invoke<T>(authority: Authority, work: () => Promise<T>, signal = new AbortController().signal) {
  return withRestRequest(signal, async () => { setRestAuthority(authority.principal, authority.input); return work(); });
}

describe("production session and UserOperation dispatch authorizers", () => {
  it.each(["activation", "revocation"] as const)("binds owner %s consent to the actual route and compiled policy", async kind => {
    const f = await fixture(), authority = await f.authority(`/api/v1/smart-accounts/sessions/${id}/${kind}-plans`, { compiledHash });
    const result = await invoke(authority, () => f.session(actor(authority), id, kind, compiledHash));
    expect(result).toEqual({ issuedAt: start, expiresAt: start + 60, digest: hashTypedData(buildRequestTypedData(audience, authority.claims)) });
  });
  it.each([false, true])("binds exact externally supplied operation signature for owner/bot=%s", async useBot => {
    const f = await fixture(), authority = await f.authority(`/api/v1/user-operations/${id}/submissions`, { signature: operationSignature }, useBot);
    expect(await invoke(authority, () => f.operation(actor(authority), id, operationSignature))).toEqual({ issuedAt: start, expiresAt: start + 60 });
    await expect(invoke(authority, () => f.operation(actor(authority), id, "0x5678"))).rejects.toMatchObject({ code: "DISPATCH_AUTHORITY_MISMATCH" });
  });
  it("never turns bot request authority into owner session activation consent", async () => {
    const f = await fixture(), authority = await f.authority(`/api/v1/smart-accounts/sessions/${id}/activation-plans`, { compiledHash }, true);
    await expect(invoke(authority, () => f.session(actor(authority), id, "activation", compiledHash))).rejects.toMatchObject({ code: "DISPATCH_AUTHORITY_MISMATCH" });
  });
  it.each([
    `/api/v1/sessions/${id}/activation`,
    `/api/v1/smart-accounts/sessions/${id}/revocation-plans`,
    `/api/v1/smart-accounts/sessions/${id}/activation-plans?mode=owner`,
  ])("rejects a valid signature for a different lifecycle target %s", async target => {
    const f = await fixture(), authority = await f.authority(target, { compiledHash });
    await expect(invoke(authority, () => f.session(actor(authority), id, "activation", compiledHash))).rejects.toMatchObject({ code: "DISPATCH_AUTHORITY_MISMATCH" });
  });
  it("rejects changed policy, body extras, cross-account identity and another operation ID", async () => {
    const f = await fixture();
    const lifecycle = await f.authority(`/api/v1/smart-accounts/sessions/${id}/activation-plans`, { compiledHash });
    await expect(invoke(lifecycle, () => f.session(actor(lifecycle), id, "activation", `0x${"cd".repeat(32)}`))).rejects.toMatchObject({ code: "DISPATCH_AUTHORITY_MISMATCH" });
    const extra = await f.authority(`/api/v1/user-operations/${id}/submissions`, { signature: operationSignature, ownerApproval: {} });
    await expect(invoke(extra, () => f.operation(actor(extra), id, operationSignature))).rejects.toMatchObject({ code: "DISPATCH_AUTHORITY_MISMATCH" });
    const operation = await f.authority(`/api/v1/user-operations/${id}/submissions`, { signature: operationSignature });
    await expect(invoke(operation, () => f.operation({ ...actor(operation), accountId: accountIdFor(owner.address, 10) }, id, operationSignature))).rejects.toMatchObject({ code: "DISPATCH_AUTHORITY_MISMATCH" });
    await expect(invoke(operation, () => f.operation(actor(operation), randomUUID(), operationSignature))).rejects.toMatchObject({ code: "DISPATCH_AUTHORITY_MISMATCH" });
  });
  it.each(["session", "operation"] as const)("reverifies mutable headers and exact body bytes for %s admission", async mode => {
    for (const mutate of ["expiry", "spacing"]) {
      const f = await fixture();
      const authority = mode === "session"
        ? await f.authority(`/api/v1/smart-accounts/sessions/${id}/activation-plans`, { compiledHash })
        : await f.authority(`/api/v1/user-operations/${id}/submissions`, { signature: operationSignature });
      if (mutate === "expiry") authority.input.headers.set(H.expiresAt, String(start + 120));
      else authority.input.body = new TextEncoder().encode(` ${new TextDecoder().decode(authority.input.body)}`);
      await expect(invoke(authority, () => mode === "session" ? f.session(actor(authority), id, "activation", compiledHash)
        : f.operation(actor(authority), id, operationSignature))).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });
    }
  });
  it("rejects expiry after authentication, aborted preflight and missing request context", async () => {
    const f = await fixture(), authority = await f.authority(`/api/v1/user-operations/${id}/submissions`, { signature: operationSignature });
    await expect(f.operation(actor(authority), id, operationSignature)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    await expect(f.session(actor(authority), id, "activation", compiledHash)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    const aborted = new AbortController(); aborted.abort();
    await expect(invoke(authority, () => f.operation(actor(authority), id, operationSignature), aborted.signal)).rejects.toMatchObject({ code: "REQUEST_ABORTED" });
    f.setNow(start + 60);
    await expect(invoke(authority, () => f.operation(actor(authority), id, operationSignature))).rejects.toMatchObject({ code: "OWNER_APPROVAL_EXPIRED" });
  });
});
