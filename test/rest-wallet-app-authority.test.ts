import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, type Address } from "viem";
import { MemoryAccountStore } from "../src/rest/auth/memory.js";
import { actorGrantId, assertActorAuthority, authorityRequest, principalFor, type Account, type BotGrant, type VerifiedRequest } from "../src/rest/auth/store.js";
import { createRestAuth } from "../src/rest/auth/service.js";
import { buildRequestTypedData, REST_AUTH_HEADERS as H, type RequestClaims } from "../src/rest/auth/signatures.js";
import type { WalletAppGrant } from "../src/rest/wallet/appGrants.js";

const owner = privateKeyToAccount(`0x${"21".repeat(32)}`), browser = privateKeyToAccount(`0x${"22".repeat(32)}`);
const now = 1_900_000_000, id = "12345678-1234-4123-8123-123456789abc", incarnation = "9007199254740993";
const account: Account = { id: `eip155:8453:${owner.address.toLowerCase()}`, ownerAddress: owner.address,
  authorityChainId: 8453, profile: { displayName: "", bio: "", avatarUri: null }, createdAt: now, updatedAt: now };
function appGrant() {
  return { kind: "wallet-app" as const, id, incarnation, accountId: account.id, signerAddress: browser.address.toLowerCase() as Address,
    scopes: ["read", "plan", "relay"] as ["read", "plan", "relay"], origin: "https://beep.example", callbackUri: "https://beep.example/callback",
    audience: "https://juicebox.center", appGeneration: 1, authorityEpoch: "1", sessionEpoch: "1",
    createdAt: now, expiresAt: now + 600, revokedAt: null as number | null, retainUntil: now + 87_000 };
}
const request = (changes: Record<string, unknown> = {}): VerifiedRequest => ({ accountId: account.id, signer: browser.address,
  grantId: id, nonce: `0x${"12".repeat(32)}`, issuedAt: now, expiresAt: now + 60, idempotencyKey: null,
  requiredScopes: ["read"], ownerOnly: false, now, audience: "https://juicebox.center", origin: "https://beep.example", ...changes } as VerifiedRequest);
// Deliberately malformed records also cross this runtime validation boundary.
const asAppGrant = (value: unknown): WalletAppGrant => value as WalletAppGrant;

describe("distinct wallet app authority at the shared principal boundary", () => {
  it("constructs a non-owner app actor with the exact database incarnation and unchanged grant UUID", () => {
    const result = principalFor(account, asAppGrant(appGrant()), request());
    expect(result).toMatchObject({ kind: "wallet-app", isOwner: false, grantId: id,
      principalId: `app:${id}:${incarnation}`, signer: browser.address,
      walletApp: { origin: "https://beep.example", audience: "https://juicebox.center", incarnation } });
    expect(result.scopes).toEqual(["read", "plan", "relay"]);
  });

  it.each(["read", "plan", "relay"] as const)("permits the standard %s API scope without owner authority", scope => {
    expect(principalFor(account, asAppGrant(appGrant()), request({ requiredScopes: [scope] })).isOwner).toBe(false);
  });

  it.each([
    { ownerOnly: true }, { signer: owner.address }, { accountId: "different" },
    { audience: "https://different.example" }, { audience: undefined },
    { origin: "https://money.example" }, { origin: null }, { origin: undefined },
  ])("rejects mismatched request context without converting the app into a bot: %j", changes => {
    expect(() => principalFor(account, asAppGrant(appGrant()), request(changes))).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it.each([
    { revokedAt: now }, { expiresAt: now }, { createdAt: now + 1 },
    { scopes: ["read", "relay"] }, { accountId: "different" }, { incarnation: "09007199254740993" },
    { incarnation: "9223372036854775808" },
  ])("rejects invalid, changed or expired app records: %j", changes => {
    expect(() => principalFor(account, asAppGrant({ ...appGrant(), ...changes }), request()))
      .toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("retains the full incarnation through actor parsing and durable authority revalidation", () => {
    const actor = { accountId: account.id, principalId: `app:${id}:${incarnation}` };
    expect(actorGrantId(actor)).toBe(id);
    expect(() => assertActorAuthority(account, asAppGrant(appGrant()), actor, ["plan"], now)).not.toThrow();
  });

  it.each([`bot:${id}`, `app:${id}`, `app:${id}:1`, `app:${id}:09007199254740993`])("rejects actor alias %s", principalId => {
    expect(() => assertActorAuthority(account, asAppGrant(appGrant()), { accountId: account.id, principalId }, ["read"], now))
      .toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("does not attach an old app actor to a new grant row with the same UUID", () => {
    expect(() => assertActorAuthority(account, asAppGrant({ ...appGrant(), incarnation: "9007199254740994" }),
      { accountId: account.id, principalId: `app:${id}:${incarnation}` }, ["relay"], now))
      .toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("keeps exact actor and API audience in active authority requests", () => {
    const result = authorityRequest({ accountId: account.id, signer: browser.address, grantId: id, requiredScopes: ["read"], now,
      principalId: `app:${id}:${incarnation}`, audience: "https://juicebox.center" } as Parameters<typeof authorityRequest>[0]);
    expect(result).toMatchObject({ principalId: `app:${id}:${incarnation}`, audience: "https://juicebox.center" });
  });

  it("cannot inject an app-shaped grant into the legacy memory bot store", async () => {
    const store = new MemoryAccountStore();
    await store.enroll(account, request({ grantId: null, signer: owner.address }));
    await expect(store.registerBot({ ...appGrant(), botAddress: browser.address, label: "not a bot" } as unknown as BotGrant))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await store.listBots(account.id)).toEqual([]);
  });

  it("rejects app metadata hidden inside a tagged bot wrapper", () => {
    const hybrid = { ...appGrant(), botAddress: browser.address, label: "hybrid" };
    expect(() => principalFor(account, { kind: "bot", grant: hybrid }, request()))
      .toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("captures browser origin before genuine request signature verification yields", async () => {
    let captured: VerifiedRequest | undefined;
    const store = new MemoryAccountStore();
    // This isolates the signature producer/context boundary; the separate PostgreSQL suite
    // exercises durable eligibility and replay with real HTTP replicas.
    store.authorizeAndConsume = async input => { captured = input; return principalFor(account, appGrant(), input); };
    const auth = createRestAuth({ store, audience: "https://juicebox.center", now: () => now });
    const body = new Uint8Array(), claims: RequestClaims = { accountId: account.id, signer: browser.address, grantId: id,
      method: "GET", requestTarget: "/api/v1/accounts/me", contentType: "", bodyHash: keccak256(body),
      issuedAt: now, expiresAt: now + 60, nonce: `0x${"34".repeat(32)}`, idempotencyKey: "" };
    const signature = await browser.signTypedData(buildRequestTypedData("https://juicebox.center", claims));
    const headers = new Headers({ [H.account]: claims.accountId, [H.signer]: claims.signer, [H.grant]: id,
      [H.issuedAt]: String(now), [H.expiresAt]: String(now + 60), [H.nonce]: claims.nonce, [H.signature]: signature,
      origin: "https://beep.example" });
    const pending = auth.authenticate({ headers, body, method: claims.method, requestTarget: claims.requestTarget, contentType: "" });
    headers.set("origin", "https://money.example");
    expect((await pending).principalId).toBe(`app:${id}:${incarnation}`);
    expect(captured).toMatchObject({ origin: "https://beep.example", audience: "https://juicebox.center" });
  });
});
