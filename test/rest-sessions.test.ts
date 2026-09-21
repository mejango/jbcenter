import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryAccountStore } from "../src/rest/auth/memory.js";
import type { BotGrant } from "../src/rest/auth/store.js";
import { MemorySessionStore } from "../src/rest/sessions/memory.js";
import { createSessionRecord, createSessionObservation } from "../src/rest/sessions/store.js";
import type { StoredSession } from "../src/rest/sessions/types.js";
import { compiledSessionHash } from "../src/rest/smartAccounts/compiler.js";
import { fingerprint } from "../src/rest/smartAccounts/service.js";
import { RestError } from "../src/rest/core.js";
import { sessionFixture, sessionClaim, sessionObservation, sessionBinding } from "./fixtures/sessions.js";

const fixedNow = 1_900_000_000_000;
const idem = () => ({ key: randomUUID(), requestHash: fingerprint(randomUUID()) });
async function setup() {
  let now = fixedNow, linked = true;
  const fixture = sessionFixture(now), accounts = new MemoryAccountStore(), grants = new Map<string, BotGrant>();
  await accounts.enroll(fixture.account, { accountId: fixture.account.id, signer: fixture.account.ownerAddress, grantId: null,
    nonce: fingerprint("enrollment"), issuedAt: Math.floor(now / 1000), expiresAt: Math.floor(now / 1000) + 60,
    idempotencyKey: null, requiredScopes: [], ownerOnly: true, now: Math.floor(now / 1000) });
  async function add(value = fixture) { grants.set(value.grant.id, value.grant); await accounts.registerBot(value.grant); return value; }
  await add();
  const store = new MemorySessionStore(accounts, { now: () => now, grant: record => grants.get(record.compiled.grantId) ?? null,
    assertBinding: () => { if (!linked) throw new RestError(409, "SESSION_BINDING_INACTIVE", "unlinked"); } });
  const save = (record = fixture.record, claim = idem()) => store.create(record, claim, now);
  async function observe(record: StoredSession, observation = sessionObservation(record, now)) {
    return (await store.observe({ actor: fixture.actor, id: record.id, expectedRevision: record.revision,
      expectedObservationHash: record.observation?.proofHash ?? null, observation, now })).record;
  }
  async function activate(record = fixture.record) {
    const prepared = await save(record);
    return observe((await store.claimActivation(sessionClaim(prepared, now))).record);
  }
  return { ...fixture, store, accounts, grants, add, save, observe, activate, get now() { return now; },
    setNow: (value: number) => { now = value; }, unlink: () => { linked = false; } };
}

describe("durable session invariants in memory", () => {
  it("requires synchronous authority adapters and immutable complete hashes", async () => {
    const h = await setup();
    expect(() => new MemorySessionStore(h.accounts, {} as never)).toThrow(/synchronous/);
    const changed = structuredClone(h.record); changed.compiled.session.actions[0]!.actionTargetSelector = "0xffffffff";
    await expect(h.save(changed)).rejects.toMatchObject({ code: "SESSION_INPUT_INVALID" });
    const groups = structuredClone(h.record); groups.allocationGroups[0]!.total = "999";
    await expect(h.save(groups)).rejects.toMatchObject({ code: "SESSION_INPUT_INVALID" });
  });
  it("deduplicates concurrent exact preparation and isolates principals", async () => {
    const h = await setup(), key = idem();
    const records = await Promise.all(Array.from({ length: 12 }, () => h.save(h.record, key)));
    expect(records.every(record => record.id === h.record.id)).toBe(true);
    expect(await h.store.find(h.actor, key)).toEqual(h.record);
    await expect(h.store.find(h.actor, { ...key, requestHash: fingerprint("other") })).rejects.toMatchObject({ code: "SESSION_IDEMPOTENCY_CONFLICT" });
    expect(await h.store.get({ ...h.actor, principalId: `bot:${randomUUID()}` }, h.record.id)).toBeUndefined();
    const output = await h.store.get(h.actor, h.record.id); output!.compiled.generation = "999";
    expect((await h.store.get(h.actor, h.record.id))!.compiled.generation).toBe("1");
  });
  it("permits owner administration of bot-created policies and rejects expired consent", async () => {
    const h = await setup(), botRecord = createSessionRecord({ actor: h.bot, compiled: h.record.compiled, preparedAdministration: h.record.preparedAdministration, now: h.now });
    const prepared = await h.save(botRecord), expired = sessionClaim(prepared, h.now - 200_000);
    await expect(h.store.claimActivation(expired)).rejects.toMatchObject({ code: "SESSION_OWNER_APPROVAL_EXPIRED" });
    const admitted = await h.store.claimActivation(sessionClaim(prepared, h.now));
    expect(admitted.record.state).toBe("installing");
    expect(admitted.record.actor.principalId).toBe(h.bot.principalId);
  });
  it("requires exact zero-counter activation and fresh observation for execution", async () => {
    const h = await setup(), active = await h.activate(), binding = sessionBinding(active);
    expect(active.state).toBe("active");
    expect(() => h.store.assertUserOperationSession(h.bot, binding, active.compiled.bindingId, active.compiled.chainId, active.compiled.wallet, h.now / 1000)).not.toThrow();
    expect(() => h.store.assertUserOperationSession(h.bot, { ...binding, generation: "2" }, active.compiled.bindingId, active.compiled.chainId, active.compiled.wallet, h.now / 1000)).toThrow(/differs/);
    h.setNow(h.now + 61_000);
    expect(() => h.store.assertUserOperationSession(h.bot, binding, active.compiled.bindingId, active.compiled.chainId, active.compiled.wallet, h.now / 1000)).toThrow(/current canonical/);
  });
  it("rejects already spent first observations without fabricating available balance", async () => {
    const h = await setup(), prepared = await h.save(), admitted = (await h.store.claimActivation(sessionClaim(prepared, h.now))).record;
    const proof = sessionObservation(admitted, h.now);
    proof.installed.counters[0]!.used = "1";
    const result = await h.observe(admitted, createSessionObservation(proof.installed, h.now));
    expect(result.state).toBe("stale"); expect(result.invalidation?.reason).toBe("counter-reset");
    const quota = await h.store.quota(h.actor, result.id);
    expect(quota).toMatchObject({ executionAuthority: false, atomicAcrossChains: false, balanceSource: "onchain-only" });
    expect(quota.approvedGroups[0]!.allocations).toHaveLength(2);
    expect(quota.localAllocations).toHaveLength(1);
    expect(quota).not.toHaveProperty("remainingBalance");
  });
  it("requires exactly one canonical initialization of the prepared permission", async () => {
    for (const change of ["extra-initialization", "different-permission", "missing-administration"]) {
      const h = await setup(), prepared = await h.save(), admitted = (await h.store.claimActivation(sessionClaim(prepared, h.now))).record;
      const proof = sessionObservation(admitted, h.now);
      if (change === "missing-administration") delete proof.installed.administration;
      else if (change === "extra-initialization") proof.installed.administration = { epoch: "2", hash: fingerprint("reset"), lastInitialization: { epoch: "2", permissionIds: [admitted.compiled.permissionId] } };
      else proof.installed.administration!.lastInitialization!.permissionIds = [fingerprint("another-permission")];
      const result = h.observe(admitted, createSessionObservation(proof.installed, h.now));
      if (change === "missing-administration") await expect(result).rejects.toMatchObject({ code: "SESSION_INPUT_INVALID" });
      else expect(await result).toMatchObject({ state: "stale", invalidation: { reason: "configuration-changed" } });
    }
  });
  it("poisons counter rollback and cannot erase it with later temporary verification errors", async () => {
    const h = await setup(), active = await h.activate();
    const spentProof = sessionObservation(active, h.now); spentProof.installed.counters[0]!.used = "40";
    const spent = await h.observe(active, createSessionObservation(spentProof.installed, h.now));
    expect(spent.state).toBe("active");
    const reset = await h.observe(spent, sessionObservation(spent, h.now));
    expect(reset).toMatchObject({ state: "stale", invalidation: { reason: "counter-reset" }, reservationsReleased: false });
    const unavailable = (await h.store.markStale({ actor: h.actor, id: reset.id, expectedRevision: reset.revision, reason: "verification-unavailable", now: h.now })).record;
    expect(unavailable.invalidation?.reason).toBe("counter-reset");
    const refreshed = await h.observe(unavailable);
    expect(refreshed.state).toBe("stale");
    expect(refreshed.invalidation?.reason).toBe("counter-reset");
  });
  it("rejects stale proof CAS and permanently invalidates a reorg", async () => {
    const h = await setup(), active = await h.activate();
    const update = { actor: h.actor, id: active.id, expectedRevision: active.revision, expectedObservationHash: active.observation!.proofHash,
      observation: sessionObservation(active, h.now), now: h.now };
    expect((await h.store.observe(update)).applied).toBe(true);
    expect((await h.store.observe(update)).applied).toBe(false);
    const current = (await h.store.get(h.actor, active.id))!;
    const bad = sessionObservation(current, h.now, { evidence: { ...current.observation!.installed.evidence, blockHash: fingerprint("reorg") } });
    await expect(h.observe(current, bad)).rejects.toMatchObject({ code: "SESSION_OBSERVATION_STALE" });
    const stale = (await h.store.markStale({ actor: h.actor, id: current.id, expectedRevision: current.revision, reason: "reorg", now: h.now })).record;
    expect((await h.observe(stale, bad)).state).toBe("stale");
  });
  it("serializes wallet admission across generations even when allocations are empty", async () => {
    const h = await setup(), second = await h.add(sessionFixture(h.now, { generation: "2", emptyAllocations: true }));
    const a = await h.save(), b = await h.save(second.record);
    const results = await Promise.allSettled([h.store.claimActivation(sessionClaim(a, h.now)), h.store.claimActivation(sessionClaim(b, h.now))]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "SESSION_ALLOCATION_CONFLICT" } });
  });
  it("never releases authority at expiry or before finalized nonce-advanced removal", async () => {
    const h = await setup(), active = await h.activate();
    const expiry = sessionObservation(active, h.now, { evidence: { ...active.observation!.installed.evidence, timestamp: String(active.compiled.validUntil) } }, true);
    const expired = await h.observe(active, expiry);
    expect(expired).toMatchObject({ state: "expired", reservationsReleased: false });
    const retired = await h.observe(expired, sessionObservation(expired, h.now, { enabled: false, enableNonce: "1" }));
    expect(retired).toMatchObject({ state: "revoked", reservationsReleased: false });
    const finalized = await h.observe(retired, sessionObservation(retired, h.now, { enabled: false, enableNonce: "1" }, true));
    expect(finalized).toMatchObject({ state: "revoked", reservationsReleased: true });
    const replacement = await h.add(sessionFixture(h.now, { generation: "2" }));
    const next = await h.save(replacement.record);
    expect((await h.store.claimActivation(sessionClaim(next, h.now))).record.state).toBe("installing");
  });
  it("keeps partial owner revocation pending until the enable nonce advances", async () => {
    const h = await setup(), active = await h.activate();
    const revoking = (await h.store.claimRevocation(sessionClaim(active, h.now, "revocation"))).record;
    const removed = await h.observe(revoking, sessionObservation(revoking, h.now, { enabled: false, counters: [] }));
    expect(removed).toMatchObject({ state: "revoking", reservationsReleased: false });
    expect(removed.invalidation).toBeUndefined();
    const retired = await h.observe(removed, sessionObservation(removed, h.now, { enabled: false, enableNonce: "1", counters: [] }, true));
    expect(retired).toMatchObject({ state: "revoked", reservationsReleased: true });
  });
  it("retains permanent salt, permission and generation tombstones after retirement", async () => {
    const h = await setup(); await h.save();
    const duplicate = structuredClone(h.record); duplicate.id = randomUUID();
    await expect(h.save(duplicate)).rejects.toMatchObject({ code: "SESSION_CONFLICT" });
    const changed = structuredClone(h.record.compiled);
    changed.salt = fingerprint("changed-salt"); changed.permissionId = fingerprint("changed-permission"); changed.nonce = fingerprint("changed-nonce");
    changed.reviewedPolicy = { ...(changed.reviewedPolicy as object), salt: changed.salt, nonce: changed.nonce };
    changed.policyHash = fingerprint(changed.reviewedPolicy); changed.compiledHash = compiledSessionHash(changed);
    await expect(h.save(createSessionRecord({ actor: h.actor, compiled: changed, preparedAdministration: h.record.preparedAdministration, now: h.now }))).rejects.toMatchObject({ code: "SESSION_CONFLICT" });
  });
  it("revocation and live grant/binding checks immediately prevent further UserOperation admission", async () => {
    const h = await setup(), active = await h.activate();
    h.unlink();
    expect(() => h.store.assertUserOperationSession(h.bot, sessionBinding(active), active.compiled.bindingId, 1, active.compiled.wallet, h.now / 1000)).toThrow(/unlinked/);
    h.grants.set(h.grant.id, { ...h.grant, revokedAt: h.now / 1000 });
    await h.accounts.revokeBot(h.account.id, h.grant.id, h.now / 1000);
    const revoking = await h.store.claimRevocation(sessionClaim(active, h.now, "revocation"));
    expect(revoking.record.state).toBe("revoking");
    expect(revoking.record.reservationsReleased).toBe(false);
  });
  it("returns verified immutable compiled records for the internal installed-policy lookup", async () => {
    const h = await setup(); await h.save();
    const c = h.record.compiled;
    expect(await h.store.findCompiled(c.chainId, c.wallet, c.permissionId)).toEqual(c);
    expect(await h.store.findCompiled(10, c.wallet, c.permissionId)).toBeUndefined();
    const result = await h.store.findCompiled(c.chainId, c.wallet, c.permissionId); result!.generation = "99";
    expect((await h.store.findCompiled(c.chainId, c.wallet, c.permissionId))!.generation).toBe("1");
  });
});
