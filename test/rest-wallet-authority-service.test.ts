import { beforeAll, describe, expect, it, vi } from "vitest";
import { keccak256, stringToHex } from "viem";
import { RestError } from "../src/rest/core.js";
import { createWalletAuthorityService } from "../src/rest/wallet/authorityService.js";
import { createWalletAuthorityIdentity, reconcileWalletAuthority, walletAuthorityContextDigest, walletAuthorityExpectedAnchor,
  type WalletAuthorityContext, type WalletAuthorityObservation } from "../src/rest/wallet/authority.js";
import { createWalletAuthorityContextFixture } from "./fixtures/wallet-authority-context.js";

const now = 1_800_000_120_000, hash = (value: string) => keccak256(stringToHex(value));
let base: WalletAuthorityContext;
beforeAll(async () => { base = await createWalletAuthorityContextFixture(now); });
function fixture() {
  const context = structuredClone(base);
  // Store/producer doubles isolate orchestration. Actual PostgreSQL and Anvil suites
  // separately establish durable provenance and canonical chain inspection.
  const observation: WalletAuthorityObservation = { version: "center-wallet-authority-observation-v1", accountId: context.accountId,
    contextDigest: walletAuthorityContextDigest(context), observedAtMs: now, validUntilMs: now + 30_000,
    head: context.binding.state.evidence, priorAnchor: { status: "none", expected: null, observed: null },
    identity: createWalletAuthorityIdentity(context, { stateHash: context.binding.state.stateHash,
      sessionAdministration: { epoch: "0", hash: hash("administration") }, creationTransaction: hash("creation") }),
    eligibility: "matched", reason: null };
  const result = { snapshot: reconcileWalletAuthority(context, observation, now + 1), replayed: false };
  const store = { loadContext: vi.fn(async (_id: string) => context),
    reconcile: vi.fn(async (_context: WalletAuthorityContext, _observation: WalletAuthorityObservation) => result) };
  const chain = { observe: vi.fn(async (_context: WalletAuthorityContext, _signal?: AbortSignal) => observation) };
  const service = createWalletAuthorityService({ store, chain });
  return { service, store, chain, context, observation, result };
}

describe("internal authority refresh orchestration", () => {
  it("reads the stored snapshot for readiness views without observing the chain", async () => {
    const f = fixture(), stored = { ...f.result.snapshot };
    expect(await f.service.currentAuthority(f.context.accountId)).toBeNull();
    const service = createWalletAuthorityService({ store: { ...f.store, get: vi.fn(async () => stored) }, chain: f.chain });
    expect(await service.currentAuthority(f.context.accountId)).toEqual(stored);
    expect(f.chain.observe).not.toHaveBeenCalled();
    await expect(service.currentAuthority("eip155:1:0x0000000000000000000000000000000000000001")).rejects.toMatchObject({ code: "WALLET_AUTHORITY_ACCOUNT_INVALID" });
  });
  it("loads trusted context, observes after the loader completes, then reconciles once", async () => {
    const f = fixture(), controller = new AbortController(), order: string[] = [];
    let holdingDatabaseWork = false;
    f.store.loadContext.mockImplementation(async () => {
      holdingDatabaseWork = true; order.push("load"); await Promise.resolve(); holdingDatabaseWork = false; return f.context;
    });
    f.chain.observe.mockImplementation(async () => {
      expect(holdingDatabaseWork).toBe(false); order.push("observe"); return f.observation;
    });
    f.store.reconcile.mockImplementation(async () => { order.push("reconcile"); return f.result; });
    expect(await f.service.refreshAuthority(f.context.accountId, controller.signal)).toEqual(f.result);
    expect(order).toEqual(["load", "observe", "reconcile"]);
    expect(f.store.loadContext).toHaveBeenCalledExactlyOnceWith(f.context.accountId);
    expect(f.chain.observe).toHaveBeenCalledExactlyOnceWith(f.context, controller.signal);
    expect(f.store.reconcile).toHaveBeenCalledExactlyOnceWith(f.context, f.observation);
  });

  it("keeps a verified identity untouched while the account's history is still catching up", async () => {
    // A staged catch-up carries no head and no new fact about the account: storing it would turn a
    // known identity into `unknown` and refuse every sign-in and app request until the last stage.
    const f = fixture(), prior = f.result.snapshot;
    f.context.prior = prior;
    f.chain.observe.mockResolvedValue({ ...f.observation, contextDigest: walletAuthorityContextDigest(f.context), validUntilMs: null, head: null,
      identity: null, eligibility: null, priorAnchor: { status: "unavailable", expected: walletAuthorityExpectedAnchor(f.context), observed: null },
      reason: "authority-history-catching-up" });
    const result = await f.service.refreshAuthority(f.context.accountId);
    expect(result).toEqual({ snapshot: prior, replayed: true, catchingUp: true });
    expect(f.store.reconcile).not.toHaveBeenCalled();
    // Before the first verified observation there is nothing to keep: the catch-up is stored as today.
    f.context.prior = null; f.store.reconcile.mockResolvedValue(f.result);
    f.chain.observe.mockResolvedValue({ ...f.observation, validUntilMs: null, head: null, identity: null, eligibility: null,
      priorAnchor: { status: "none", expected: null, observed: null }, reason: "authority-history-catching-up" });
    expect(await f.service.refreshAuthority(f.context.accountId)).toEqual(f.result);
    expect(f.store.reconcile).toHaveBeenCalledOnce();
  });
  it("keeps a private bounded context when the observer changes its own copy", async () => {
    const f = fixture(), expected = structuredClone(f.context);
    f.chain.observe.mockImplementation(async observed => {
      observed.credential.userHandle = "changed";
      observed.binding.authorization.digest = hash("changed");
      f.context.enrollment.receipt!.verificationDigest = "00".repeat(32);
      return f.observation;
    });
    await f.service.refreshAuthority(expected.accountId);
    expect(f.store.reconcile.mock.calls[0]![0]).toEqual(expected);
  });

  it("retains the configured bound dependencies if their public properties are replaced", async () => {
    const f = fixture();
    const load = f.store.loadContext, observe = f.chain.observe, reconcile = f.store.reconcile;
    const replacement = vi.fn(async () => { throw new Error("replacement must not be called"); });
    f.store.loadContext = replacement; f.chain.observe = replacement; f.store.reconcile = replacement;
    await expect(f.service.refreshAuthority(f.context.accountId)).resolves.toEqual(f.result);
    expect(load).toHaveBeenCalledOnce(); expect(observe).toHaveBeenCalledOnce(); expect(reconcile).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
  });

  it.each(["", "eip155:1:0x" + "11".repeat(20), "eip155:8453:0x" + "AB".repeat(20), "https://provider.example"])(
    "rejects invalid account input before storage or provider work: %s", async accountId => {
      const f = fixture();
      await expect(f.service.refreshAuthority(accountId)).rejects.toMatchObject({ code: "WALLET_AUTHORITY_ACCOUNT_INVALID" });
      expect(f.store.loadContext).not.toHaveBeenCalled(); expect(f.chain.observe).not.toHaveBeenCalled();
    });

  it("rejects a different valid account returned by storage before chain work", async () => {
    const f = fixture();
    await expect(f.service.refreshAuthority(`eip155:8453:0x${"42".repeat(20)}`)).rejects.toMatchObject({ code: "WALLET_AUTHORITY_ACCOUNT_INVALID" });
    expect(f.chain.observe).not.toHaveBeenCalled(); expect(f.store.reconcile).not.toHaveBeenCalled();
  });

  it("rejects an observation for a different captured context before persistence", async () => {
    const f = fixture(); f.observation.contextDigest = hash("another context");
    await expect(f.service.refreshAuthority(f.context.accountId)).rejects.toThrow();
    expect(f.store.reconcile).not.toHaveBeenCalled();
  });

  it("honors cancellation before loading", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await expect(f.service.refreshAuthority(f.context.accountId, controller.signal)).rejects.toMatchObject({ status: 499 });
    expect(f.store.loadContext).not.toHaveBeenCalled(); expect(f.chain.observe).not.toHaveBeenCalled();
  });

  it("honors cancellation after loading and before provider work", async () => {
    const f = fixture(), controller = new AbortController();
    f.store.loadContext.mockImplementation(async () => { controller.abort(); return f.context; });
    await expect(f.service.refreshAuthority(f.context.accountId, controller.signal)).rejects.toMatchObject({ status: 499 });
    expect(f.chain.observe).not.toHaveBeenCalled(); expect(f.store.reconcile).not.toHaveBeenCalled();
  });

  it("does not discard a completed canonical observation when its requester subsequently cancels", async () => {
    const f = fixture(), controller = new AbortController();
    f.chain.observe.mockImplementation(async () => { controller.abort(); return f.observation; });
    await expect(f.service.refreshAuthority(f.context.accountId, controller.signal)).resolves.toEqual(f.result);
    expect(f.store.reconcile).toHaveBeenCalledOnce();
  });

  it("never fabricates evidence after an unexpected observer failure", async () => {
    const f = fixture(), error = new Error("observer failed"); f.chain.observe.mockRejectedValue(error);
    await expect(f.service.refreshAuthority(f.context.accountId)).rejects.toBe(error);
    expect(f.store.reconcile).not.toHaveBeenCalled();
  });

  it("does not retry a stale reconciliation with rewritten epochs", async () => {
    const f = fixture(), conflict = new RestError(409, "WALLET_AUTHORITY_CONFLICT", "Changed authority");
    f.store.reconcile.mockRejectedValue(conflict);
    await expect(f.service.refreshAuthority(f.context.accountId)).rejects.toBe(conflict);
    expect(f.store.loadContext).toHaveBeenCalledOnce(); expect(f.chain.observe).toHaveBeenCalledOnce();
    expect(f.store.reconcile).toHaveBeenCalledOnce();
  });
});
