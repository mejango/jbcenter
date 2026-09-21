import { describe, expect, it, vi } from "vitest";
import type { RestPrincipal } from "../src/rest/auth/store.js";
import { SessionService, type SessionServiceDependencies } from "../src/rest/sessions/service.js";
import type { SessionStore } from "../src/rest/sessions/store.js";
import type { StoredSession } from "../src/rest/sessions/types.js";
import type { SessionPolicyInput } from "../src/rest/smartAccounts/types.js";
import type { StoredPlan } from "../src/rest/transactions/types.js";
import { account, h } from "./fixtures/user-operations.js";

const grantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const apiAccount = account(1_800_000_000_000, 8453);
function app(): RestPrincipal {
  return {
    kind: "wallet-app", walletApp: { origin: "https://beep.biz", audience: "https://juicebox.center", incarnation: "1" },
    principalId: `app:${grantId}:1`, account: apiAccount, signer: "0x4444444444444444444444444444444444444444",
    grantId, scopes: ["read", "plan", "relay"], isOwner: false, requestNonce: h("app-request"), idempotencyKey: "app-session",
  };
}
function legacy(owner: boolean, typed: boolean): RestPrincipal {
  return {
    ...(typed ? { kind: owner ? "owner" as const : "bot" as const } : {}),
    principalId: owner ? `owner:${apiAccount.id}` : `bot:${grantId}`, account: apiAccount,
    signer: owner ? apiAccount.ownerAddress : app().signer, grantId: owner ? null : grantId,
    scopes: ["read", "plan", "relay"], isOwner: owner, requestNonce: h("legacy-request"), idempotencyKey: "legacy-session",
  };
}

/** Only eligibility and cache admission are under test here; no policy, RPC or onchain validity is simulated. */
function fixture() {
  const cached = {
    id: sessionId, actor: { accountId: apiAccount.id, principalId: `bot:${grantId}` },
    compiled: { grantId, sessionKey: app().signer, compiledHash: h("compiled") },
    state: "active", observation: { proofHash: h("observation") },
  } as unknown as StoredSession;
  const store = {
    find: vi.fn<SessionStore["find"]>().mockResolvedValue(cached),
    get: vi.fn<SessionStore["get"]>().mockResolvedValue(cached),
    list: vi.fn<SessionStore["list"]>().mockResolvedValue({ items: [cached] }),
    quota: vi.fn<SessionStore["quota"]>(),
    create: vi.fn<SessionStore["create"]>(),
  };
  const review = vi.fn(), authorizeOwnerPlan = vi.fn(), currentBinding = vi.fn(), currentBindingAt = vi.fn();
  const findPlanByIdempotency = vi.fn();
  const service = new SessionService({
    store, reviewer: { review }, authorizeOwnerPlan, currentBinding, currentBindingAt,
    transactions: { findPlanByIdempotency },
  } as unknown as SessionServiceDependencies);
  const untouched = () => {
    for (const dependency of [...Object.values(store), review, authorizeOwnerPlan, currentBinding, currentBindingAt, findPlanByIdempotency])
      expect(dependency).not.toHaveBeenCalled();
  };
  return { service, store, cached, untouched };
}
const policyInput = {} as SessionPolicyInput;
function lifecyclePlan(kind: "activation" | "revocation"): StoredPlan {
  return { draft: { operation: kind === "activation" ? "activate_smart_account_session" : "revoke_smart_account_session",
    summary: { sessionId, compiledHash: h("compiled") } } } as StoredPlan;
}

describe("SmartSession eligibility for wallet app principals", () => {
  it.each(["prepare", "list", "get", "quota", "executionBinding"] as const)(
    "rejects app %s before cached data or downstream authority is accessed", async method => {
      const f = fixture(), principal = app();
      const operation = method === "prepare" ? f.service.prepare(principal, policyInput, "cached", h("cached"))
        : method === "list" ? f.service.list(principal, { limit: 10 })
          : method === "executionBinding" ? f.service.executionBinding(principal, sessionId)
            : method === "quota" ? f.service.quota(principal, sessionId)
              : f.service.get(principal, sessionId);
      await expect(operation).rejects.toMatchObject({ status: 403, code: "SESSION_APP_UNAVAILABLE" });
      f.untouched();
    },
  );

  it("checks app eligibility before evaluating ordinary read scope", async () => {
    const f = fixture();
    await expect(f.service.list({ ...app(), scopes: [] }, { limit: 10 }))
      .rejects.toMatchObject({ status: 403, code: "SESSION_APP_UNAVAILABLE" });
    f.untouched();
  });

  it("rejects fresh app preparation before looking up or reviewing a policy", async () => {
    const f = fixture(); f.store.find.mockResolvedValue(undefined);
    await expect(f.service.prepare(app(), policyInput, "fresh", h("fresh")))
      .rejects.toMatchObject({ status: 403, code: "SESSION_APP_UNAVAILABLE" });
    f.untouched();
  });

  it.each(["activation", "revocation"] as const)(
    "cannot turn an app into owner authority for %s by modifying legacy owner fields", async kind => {
      const f = fixture(), principal: RestPrincipal = { ...app(), isOwner: true, grantId: null, principalId: `owner:${apiAccount.id}` };
      await expect(f.service.prepareOwnerPlan(principal, sessionId, kind, { compiledHash: h("compiled") }, "owner-plan", h("owner-plan")))
        .rejects.toMatchObject({ status: 403, code: "SESSION_OWNER_REQUIRED" });
      await expect(f.service.assertOwnerPlan(principal, lifecyclePlan(kind)))
        .rejects.toMatchObject({ status: 403, code: "SESSION_OWNER_REQUIRED" });
      f.untouched();
    },
  );

  it("leaves ordinary app payment plans to their separate owner-signature checks", async () => {
    const f = fixture(), plan = { draft: { operation: "v6-pay" } } as StoredPlan;
    await expect(f.service.assertOwnerPlan(app(), plan)).resolves.toBeUndefined();
    f.untouched();
  });

  it.each([
    { owner: true, typed: false }, { owner: false, typed: false },
    { owner: true, typed: true }, { owner: false, typed: true },
  ])("preserves cached preparation and reads for legacy owner=$owner typed=$typed", async ({ owner, typed }) => {
    const f = fixture(), principal = legacy(owner, typed);
    expect(await f.service.prepare(principal, policyInput, "cached", h("cached"))).toBe(f.cached);
    expect(await f.service.get(principal, sessionId, false)).toBe(f.cached);
    expect(await f.service.list(principal, { limit: 10 })).toEqual({ items: [f.cached] });
    if (!owner) expect((await f.service.executionBinding(principal, sessionId)).record).toBe(f.cached);
    else await expect(f.service.executionBinding(principal, sessionId)).rejects.toMatchObject({ code: "SESSION_BOT_REQUIRED" });
  });
});
