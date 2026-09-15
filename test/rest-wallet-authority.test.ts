import { beforeAll, expect, it } from "vitest";
import type { Hex } from "viem";
import { createWalletAuthorityIdentity, reconcileWalletAuthority, validateWalletAuthorityContext, validateWalletAuthorityObservation,
  validateWalletAuthoritySnapshot, walletAuthorityContextDigest, walletAuthorityMaximumAgeMs, walletAuthorityExpectedAnchor, walletAuthorityIdentityDigest,
  type WalletAuthorityContext, type WalletAuthorityObservation, type WalletAuthoritySnapshot } from "../src/rest/wallet/authority.js";
import { createWalletAuthorityContextFixture } from "./fixtures/wallet-authority-context.js";

const now = 1_800_000_120_000;
const hash = (byte: string): Hex => `0x${byte.repeat(64)}`;
const block = (height = "100", byte = "a") => ({ chainId: 8453, blockNumber: height, blockHash: hash(byte),
  timestamp: String(now / 1000), source: "onchain" as const });
let base: WalletAuthorityContext;
beforeAll(async () => { base = await createWalletAuthorityContextFixture(now); });
const context = (prior: WalletAuthoritySnapshot | null = null) => ({ ...structuredClone(base), prior });
const identity = (c: WalletAuthorityContext, stateHash = hash("b"), epoch = "0") => createWalletAuthorityIdentity(c,
  { stateHash, sessionAdministration: { epoch, hash: hash("c") }, creationTransaction: hash("d") });
function observation(c: WalletAuthorityContext, changes: Partial<WalletAuthorityObservation> = {}): WalletAuthorityObservation {
  const anchor = walletAuthorityExpectedAnchor(c);
  return { version: "center-wallet-authority-observation-v1", accountId: c.accountId, contextDigest: walletAuthorityContextDigest(c),
    observedAtMs: now, validUntilMs: now + walletAuthorityMaximumAgeMs, head: block(),
    priorAnchor: anchor ? { status: "same", expected: anchor, observed: anchor } : { status: "none", expected: null, observed: null },
    identity: identity(c), eligibility: "matched", reason: null, ...changes };
}

it("validates genuine verified genesis after registration expiry and returns an isolated context", () => {
  const input = context(), result = validateWalletAuthorityContext(input);
  expect(result).toEqual(input); expect(result).not.toBe(input);
  expect(result.enrollment.intent.expiresAt).toBeLessThan(now);
});
it("keeps fixture setup seconds canonical when its database-style clock includes milliseconds", async () => {
  const value = await createWalletAuthorityContextFixture(now + 123);
  expect(validateWalletAuthorityContext(value)).toEqual(value);
});
it("binds session-administration ABA without changing legacy stateHash", () => {
  const c = context(), first = identity(c), later = identity(c, first.stateHash, "2");
  expect(later.stateHash).toBe(first.stateHash);
  expect(walletAuthorityIdentityDigest(later)).not.toBe(walletAuthorityIdentityDigest(first));
});
it("initializes matched authority at epochs1/1 with a deadline from observation start", () => {
  const c = context(), result = reconcileWalletAuthority(c, observation(c), now + 100);
  expect(result).toMatchObject({ accountId: c.accountId, authorityEpoch: "1", sessionEpoch: "1", revision: "1",
    readiness: "verified", bootstrapRequired: false, validUntilMs: now + walletAuthorityMaximumAgeMs });
  expect(validateWalletAuthoritySnapshot(result)).toEqual(result);
});

function initialized() { const c = context(); return reconcileWalletAuthority(c, observation(c), now); }
function unknown(c: WalletAuthorityContext): WalletAuthorityObservation {
  const expected = walletAuthorityExpectedAnchor(c);
  return observation(c, { head: null, validUntilMs: null, identity: null, eligibility: null, reason: "provider-unavailable",
    priorAnchor: { status: expected ? "unavailable" : "none", expected, observed: null } });
}
function replacement(c: WalletAuthorityContext, complete = false): WalletAuthorityObservation {
  const expected = walletAuthorityExpectedAnchor(c)!;
  const replaced = { ...expected, blockHash: hash("f") };
  return observation(c, { head: block("110", "e"), priorAnchor: { status: "replaced", expected, observed: replaced },
    ...complete ? {} : { identity: null, eligibility: null, validUntilMs: null, reason: "canonical-anchor-replaced" } });
}
function bootstrap(): WalletAuthoritySnapshot {
  return { version: "center-wallet-authority-snapshot-v1", accountId: base.accountId, revision: "7", authorityEpoch: "12", sessionEpoch: "24",
    bootstrapRequired: true, readiness: "unknown", identity: null, historicalVerifiedIdentity: null, acceptedAnchor: null,
    highestObservedBlock: null, activeFence: null, lastClosedFence: null, latestObservation: null, validUntilMs: null, updatedAtMs: now - 1 };
}
it("bootstraps existing epoch-only rows by advancing both existing values exactly once", () => {
  const c = context(bootstrap()), first = reconcileWalletAuthority(c, observation(c), now);
  expect(first).toMatchObject({ revision: "8", authorityEpoch: "13", sessionEpoch: "25", bootstrapRequired: false, readiness: "verified" });
  const next = context(first), refreshed = reconcileWalletAuthority(next, observation(next), now + 1);
  expect(refreshed).toMatchObject({ revision: "9", authorityEpoch: "13", sessionEpoch: "25" });
});
it.each([null, "bootstrap"])("cannot initialize %s authority from unknown or changed observations", prior => {
  const c = context(prior ? bootstrap() : null);
  for (const o of [unknown(c), observation(c, { eligibility: "changed", validUntilMs: null, reason: "authority-changed" })])
    expect(() => reconcileWalletAuthority(c, o, now)).toThrowError(expect.objectContaining({ status: 409 }));
});
it("refreshes equal identity without advancing epochs or changing an ordinary payment's identity", () => {
  const c = context(initialized()), original = identity(c);
  c.binding.state.safeNonce = "1000";
  (c.binding.state.modules!.details as any).spendCounter = "999";
  expect(identity(c)).toEqual(original);
  const refreshed = reconcileWalletAuthority(c, observation(c, { observedAtMs: now + 10, validUntilMs: now + 30010 }), now + 11);
  expect(refreshed).toMatchObject({ authorityEpoch: "1", sessionEpoch: "1", revision: "2", validUntilMs: now + 30010 });
});
it("advances owner and session-administration identity transitions without resetting the Safe", () => {
  let current = initialized();
  for (const [state, epoch, expected] of [["e", "0", "2"], ["b", "0", "3"], ["b", "2", "4"]]) {
    const c = context(current);
    current = reconcileWalletAuthority(c, observation(c, { identity: identity(c, hash(state!), epoch!),
      eligibility: "changed", validUntilMs: null, reason: "authority-changed" }), now + Number(expected));
    expect(current).toMatchObject({ accountId: base.accountId, authorityEpoch: expected, sessionEpoch: expected, readiness: "changed", validUntilMs: null });
    expect(current.historicalVerifiedIdentity).toEqual(initialized().identity);
  }
  const c = context(current), repeated = observation(c, { identity: current.identity, eligibility: "changed", validUntilMs: null, reason: "authority-changed" });
  expect(reconcileWalletAuthority(c, repeated, now + 5).authorityEpoch).toBe("4");
});
it("removes readiness on ordinary unknown without inventing rotation or renewing time", () => {
  const original = initialized(), c = context(original), lost = reconcileWalletAuthority(c, unknown(c), now + 1);
  expect(lost).toMatchObject({ readiness: "unknown", validUntilMs: null, authorityEpoch: "1", sessionEpoch: "1" });
  expect(lost.identity).toEqual(original.identity); expect(lost.acceptedAnchor).toEqual(original.acceptedAnchor);
  const next = context(lost), restored = reconcileWalletAuthority(next, observation(next), now + 2);
  expect(restored).toMatchObject({ readiness: "verified", authorityEpoch: "1", sessionEpoch: "1" });
});
it("fences proven higher-head replacement without a new identity and deduplicates the episode through unknown", () => {
  const original = initialized(), c = context(original), fenced = reconcileWalletAuthority(c, replacement(c), now + 1);
  expect(fenced).toMatchObject({ readiness: "fenced", authorityEpoch: "2", sessionEpoch: "2", validUntilMs: null,
    activeFence: { recoveryAnchor: null, abandonedAnchor: original.acceptedAnchor, replacementAnchor: { blockHash: hash("f") } } });
  expect(fenced.identity).toEqual(original.identity);
  let next = context(fenced), repeated = reconcileWalletAuthority(next, replacement(next), now + 2);
  expect(repeated.activeFence).toEqual(fenced.activeFence); expect(repeated.authorityEpoch).toBe("2");
  next = context(repeated); repeated = reconcileWalletAuthority(next, unknown(next), now + 3);
  expect(repeated.readiness).toBe("fenced"); expect(repeated.activeFence).toEqual(fenced.activeFence);
});
it("requires a complete candidate then fresh candidate recheck, preserving post-fence epochs on recovery", () => {
  let c = context(initialized()); const fenced = reconcileWalletAuthority(c, replacement(c), now + 1);
  c = context(fenced); const candidate = reconcileWalletAuthority(c, replacement(c, true), now + 2);
  expect(candidate).toMatchObject({ readiness: "fenced", authorityEpoch: "2", sessionEpoch: "2", activeFence: { recoveryAnchor: block("110", "e") } });
  c = context(candidate); expect(walletAuthorityExpectedAnchor(c)).toEqual(block("110", "e"));
  const recovered = reconcileWalletAuthority(c, observation(c, { head: block("111", "1") }), now + 3);
  expect(recovered).toMatchObject({ readiness: "verified", authorityEpoch: "2", sessionEpoch: "2", activeFence: null,
    acceptedAnchor: block("111", "1"), lastClosedFence: candidate.activeFence });
  c = context(recovered);
  const later = replacement(c); later.head = block("120", "2");
  expect(reconcileWalletAuthority(c, later, now + 4).authorityEpoch).toBe("3");
});
it("preserves the fence when a candidate itself is replaced, without rebumping the episode", () => {
  let c = context(initialized()); const first = reconcileWalletAuthority(c, replacement(c, true), now);
  c = context(first); const second = replacement(c); second.head = block("120", "2");
  const changed = reconcileWalletAuthority(c, second, now + 1);
  expect(changed).toMatchObject({ readiness: "fenced", authorityEpoch: "2", sessionEpoch: "2", activeFence: { recoveryAnchor: null } });
});
it("keeps changed recovery identity fenced until that new candidate receives its own fresh recheck", () => {
  let c = context(initialized()); const first = reconcileWalletAuthority(c, replacement(c, true), now);
  c = context(first);
  const changed = reconcileWalletAuthority(c, observation(c, { head: block("111", "1"), identity: identity(c, hash("b"), "2") }), now + 1);
  expect(changed).toMatchObject({ readiness: "fenced", authorityEpoch: "3", sessionEpoch: "3", validUntilMs: null,
    activeFence: { recoveryAnchor: block("111", "1") } });
  c = context(changed);
  const recovered = reconcileWalletAuthority(c, observation(c, { head: block("112", "2"), identity: identity(c, hash("b"), "2") }), now + 2);
  expect(recovered).toMatchObject({ readiness: "verified", authorityEpoch: "3", sessionEpoch: "3", activeFence: null });
});
it("binds the exact prior revision and epochs so logout cannot be overwritten by an old refresh", () => {
  const before = initialized(), c = context(before), old = observation(c);
  const loggedOut = { ...before, revision: "2", sessionEpoch: "2", updatedAtMs: now + 1 };
  expect(validateWalletAuthoritySnapshot(loggedOut)).toEqual(loggedOut);
  expect(() => reconcileWalletAuthority(context(loggedOut), old, now + 2)).toThrowError(expect.objectContaining({ status: 409 }));
});
it.each(["identity", "anchor"])("rejects ready snapshot whose %s differs from its retained proof", field => {
  const prior = initialized();
  if (field === "identity") { prior.identity!.stateHash = hash("9"); prior.historicalVerifiedIdentity = structuredClone(prior.identity); }
  else prior.acceptedAnchor = block("100", "9");
  expect(() => validateWalletAuthoritySnapshot(prior)).toThrowError(expect.objectContaining({ status: 400 }));
});
it("rejects a fenced snapshot watermark below its last proven higher head", () => {
  const c = context(initialized()), prior = reconcileWalletAuthority(c, replacement(c), now);
  prior.highestObservedBlock = "105";
  expect(() => validateWalletAuthoritySnapshot(prior)).toThrowError(expect.objectContaining({ status: 400 }));
});
it.each(["revision", "authorityEpoch", "sessionEpoch"] as const)("fails closed at %s overflow", field => {
  const prior = initialized(); prior[field] = "9223372036854775807";
  const c = context(prior), o = observation(c, { identity: identity(c, hash("e")) });
  expect(() => reconcileWalletAuthority(c, o, now + 1)).toThrowError(expect.objectContaining({ status: 409 }));
});
it.each(["matched", "changed", "conflict"])("rejects %s evidence at its absolute deadline after waits", kind => {
  const c = context(initialized()), o = kind === "conflict" ? replacement(c) : observation(c,
    kind === "changed" ? { eligibility: "changed", validUntilMs: null, reason: "authority-changed" } : {});
  expect(() => reconcileWalletAuthority(c, o, now + walletAuthorityMaximumAgeMs)).toThrowError(expect.objectContaining({ status: 410 }));
});
it("rejects lower complete heads and backwards clocks without replacing durable evidence", () => {
  const c = context(initialized()), low = observation(c, { head: block("99", "9") });
  expect(() => reconcileWalletAuthority(c, low, now + 1)).toThrow();
  expect(() => reconcileWalletAuthority(c, observation(c), now - 1)).toThrow();
  expect(c.prior).toEqual(initialized());
});

it.each([
  ["account alias", (c: WalletAuthorityContext) => { c.accountId = "eip155:8453:0x4444444444444444444444444444444444444444"; }],
  ["forged receipt", (c: WalletAuthorityContext) => { c.enrollment.receipt!.verificationDigest = "aa".repeat(32); }],
  ["superseded credential", (c: WalletAuthorityContext) => { (c.credential as any).supersededAtMs = now; }],
  ["credential key", (c: WalletAuthorityContext) => { c.credential.publicKey.x = hash("e"); }],
  ["immutable BE", (c: WalletAuthorityContext) => { c.credential.backupEligible = false; }],
  ["user handle", (c: WalletAuthorityContext) => { c.credential.userHandle = "forged"; }],
  ["setup binding ID", (c: WalletAuthorityContext) => { c.binding.id = hash("b"); }],
  ["legacy binding purpose", (c: WalletAuthorityContext) => { c.binding.authorization.method = "safe-current-owner-threshold"; }],
  ["initializer", (c: WalletAuthorityContext) => { c.binding.authorization.setup!.initializerHash = hash("b"); }],
] as const)("rejects substituted trusted context: %s", (_, mutate) => {
  const c = context(); mutate(c); expect(() => validateWalletAuthorityContext(c)).toThrowError(expect.objectContaining({ status: 400 }));
});
it("binds full enrollment, manifest, credential, and setup authorization commitments in identity", () => {
  const c = context(), a = identity(c); c.binding.authorization.digest = hash("3");
  const b = identity(c); expect(b.bindingAuthorizationDigest).toBe(hash("3")); expect(walletAuthorityIdentityDigest(b)).not.toBe(walletAuthorityIdentityDigest(a));
  for (const field of ["manifestCommitment", "manifestRevision", "enrollmentCommitment", "credentialCommitment", "bindingId", "creationCommitment", "initializerHash"] as const) {
    const o = observation(c); o.identity![field] = hash("9");
    expect(() => validateWalletAuthorityObservation(o, c)).toThrow();
  }
});
it.each(["-1", "01", "1.0", String(1n << 256n), "9".repeat(1000)])("rejects malformed session administration epoch %s", epoch => {
  expect(() => identity(context(), hash("b"), epoch)).toThrow();
});
it("accepts explicit zero and maximum uint256 administration epochs", () => {
  for (const epoch of ["0", String((1n << 256n) - 1n)]) expect(identity(context(), hash("b"), epoch).sessionAdministration.epoch).toBe(epoch);
});
it.each([
  ["fabricated unknown proof", (o: WalletAuthorityObservation) => { o.head = null; }],
  ["wrong chain", (o: WalletAuthorityObservation) => { o.head!.chainId = 1; }],
  ["unproved prior replacement", (o: WalletAuthorityObservation) => { o.priorAnchor.status = "replaced"; }],
  ["wrong context commitment", (o: WalletAuthorityObservation) => { o.contextDigest = hash("9"); }],
  ["extended validity", (o: WalletAuthorityObservation) => { o.validUntilMs = now + walletAuthorityMaximumAgeMs + 1; }],
  ["stale head", (o: WalletAuthorityObservation) => { o.head!.timestamp = String(now / 1000 - 301); }],
  ["future head", (o: WalletAuthorityObservation) => { o.head!.timestamp = String(now / 1000 + 31); }],
  ["unsafe reason", (o: WalletAuthorityObservation) => { o.reason = "https://secret.example"; }],
  ["unsafe clock", (o: WalletAuthorityObservation) => { o.observedAtMs = Number.MAX_SAFE_INTEGER; }],
] as const)("rejects malformed observation: %s", (_, mutate) => {
  const c = context(), o = observation(c); mutate(o); expect(() => validateWalletAuthorityObservation(o, c)).toThrow();
});
it("rejects accessors, proxies, hidden fields, custom JSON and oversized graphs without evaluating them", () => {
  let touched = false;
  const getter = context(); Object.defineProperty(getter.credential, "accountId", { enumerable: true, get() { touched = true; return base.accountId; } });
  const proxy = new Proxy(context(), { getPrototypeOf() { touched = true; throw new Error("trap"); } });
  const custom = context(); (custom.binding as any).toJSON = () => { touched = true; return {}; };
  const hidden = context(); Object.defineProperty(hidden, "secret", { value: true });
  const oversized = context(); (oversized.binding as any).extra = "x".repeat(262145);
  for (const value of [getter, proxy, custom, hidden, oversized]) expect(() => validateWalletAuthorityContext(value)).toThrow();
  expect(touched).toBe(false);
});
