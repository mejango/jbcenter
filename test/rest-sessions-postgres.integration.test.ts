import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeAbiParameters, type Address, type Hex } from "viem";
import { assertRestActorActive } from "../src/rest/auth/postgres.js";
import type { RestActor } from "../src/rest/core.js";
import { compiledSessionHash } from "../src/rest/smartAccounts/compiler.js";
import { permissionIdOf } from "../src/rest/smartAccounts/compiler/encoding.js";
import type { CompiledSession } from "../src/rest/smartAccounts/compiler/types.js";
import { fingerprint } from "../src/rest/smartAccounts/service.js";
import { PostgresSessionStore, assertUserOperationSession, assertUserOperationLifecyclePlan } from "../src/rest/sessions/postgres.js";
import type { StoredPlan } from "../src/rest/transactions/types.js";
import { createSessionObservation, createSessionRecord } from "../src/rest/sessions/store.js";
import type { SessionClaim, StoredSession, UserOperationSessionBinding } from "../src/rest/sessions/types.js";

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const schema = `rest_sessions_test_${randomUUID().replaceAll("-", "")}`;
let admin: Pool, pool: Pool, store: PostgresSessionStore;
let sequence = 1000;
const addr = (n = sequence++) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const hash = (value: unknown): Hex => fingerprint(value);
const seconds = () => Math.floor(Date.now() / 1000);
const token = addr(11), siblingToken = addr(12), defaultKey = addr(13), ownerAddress = addr(14);
const accountId = `eip155:1:${ownerAddress}`;
const owner: RestActor = { accountId, principalId: `owner:${accountId}` };
const idem = (key = randomUUID()) => ({ key, requestHash: hash(key) });

async function seedAccount(actor: RestActor): Promise<void> {
  await pool.query(
    "INSERT INTO rest_accounts(id,owner_address,authority_chain_id,display_name,bio,created_at,updated_at) VALUES($1,$2,1,'','',1,1) ON CONFLICT(id) DO NOTHING",
    [actor.accountId, actor.accountId.split(":").at(-1)],
  );
}

/** Synthetic reviewed records and public addresses only; no keys, RPC or broadcasting. */
async function prepared(options: {
  actor?: RestActor; wallet?: Address; key?: Address; grantId?: string; generation?: string;
  validAfter?: number; days?: 7 | 30; asset?: Address; emptyAllocations?: boolean;
} = {}): Promise<StoredSession> {
  const actor = options.actor ?? owner, wallet = options.wallet ?? addr(), key = options.key ?? defaultKey;
  const grantId = options.grantId ?? randomUUID(), generation = options.generation ?? "1";
  await seedAccount(actor);
  const after = options.validAfter ?? seconds() - 1, until = after + (options.days ?? 7) * 86400;
  await pool.query(
    `INSERT INTO rest_bot_grants(id,account_id,bot_address,scopes,label,created_at,expires_at)
     VALUES($1,$2,$3,ARRAY['read','plan','relay'],'fixture',1,$4) ON CONFLICT(id) DO NOTHING`,
    [grantId, actor.accountId, key.toLowerCase(), Math.max(until + 86400, seconds() + 40 * 86400)],
  );
  const bindingId = hash({ ownerAccountId: actor.accountId, wallet, chainId: 1 });
  const digest = hash({ bindingId, fixture: true });
  const binding = { id: bindingId, ownerAccountId: actor.accountId, wallet: { chainId: 1, address: wallet },
    authorization: { digest, method: "safe-current-owner-threshold" } };
  await pool.query(
    `INSERT INTO rest_smart_account_bindings(account_id,id,chain_id,wallet_address,authorization_digest,created_at,updated_at,document)
     VALUES($1,$2,1,$3,$4,1,1,$5::jsonb) ON CONFLICT(account_id,id) DO NOTHING`,
    [actor.accountId, bindingId, wallet.toLowerCase(), digest, JSON.stringify(binding)],
  );
  const salt = hash(randomUUID()), nonce = hash(randomUUID());
  const pin = { address: addr(21), runtimeCodeHash: hash("runtime"), source: {
    repository: "https://github.com/example/session-test", commit: "a".repeat(40), artifactSha256: "b".repeat(64),
  } };
  const session = { sessionValidator: pin.address,
    sessionValidatorInitData: encodeAbiParameters([{ type: "uint256" }, { type: "address[]" }], [1n, [key]]), salt,
    userOpPolicies: [], erc7739Policies: { allowedERC7739Content: [] as [], erc1271Policies: [] as [] },
    actions: [], permitERC4337Paymaster: false };
  const identity = { ownerAccountId: actor.accountId, bindingId, grantId, sessionKey: key, chainId: 1,
    wallet, generation, nonce, validAfter: after, validUntil: until, salt };
  const reviewedPolicy = { ...identity, allocations: options.emptyAllocations ? [] : [{ id: "approved_group", assetIdentity: "test-token", decimals: 18, total: "200",
    allocations: [{ id: "local", chainId: 1, asset: options.asset ?? token, limit: "100", assetReviewId: "review-local" },
      { id: "sibling", chainId: 10, asset: siblingToken, limit: "100", assetReviewId: "review-sibling" }] }] };
  const compiled: CompiledSession = { schemaVersion: 1, stack: "legacy-f24dddf-safe7579-f22a194", ...identity,
    policyHash: hash(reviewedPolicy), compiledHash: hash("placeholder"), permissionId: permissionIdOf(session), manifestRevision: hash("manifest"),
    activationEnableNonce: "7", reviewedPolicy, smartSessions: pin, sessionValidator: pin, session, configurations: [] };
  compiled.compiledHash = compiledSessionHash(compiled);
  return createSessionRecord({ actor, compiled, preparedAdministration: { epoch: "0", hash: hash("empty") }, now: Date.now() });
}

async function save(record: StoredSession) { return store.create(record, idem(), Date.now()); }
function claim(record: StoredSession, kind: "activation" | "revocation" = "activation"): SessionClaim {
  const now = seconds();
  return { actor: record.actor, id: record.id, expectedRevision: record.revision,
    approval: { kind, accountId: record.actor.accountId, sessionId: record.id, policyHash: record.compiled.policyHash,
      compiledHash: record.compiled.compiledHash, planId: randomUUID(), planCommitment: hash(randomUUID()), digest: hash(randomUUID()),
      issuedAt: now, expiresAt: now + 120 }, idempotency: idem(), now: Date.now() };
}
function observation(record: StoredSession, options: { enabled?: boolean; nonce?: string; finalized?: boolean; block?: string; timestamp?: number } = {}) {
  return createSessionObservation({ permissionId: record.compiled.permissionId, compiledHash: record.compiled.compiledHash,
    account: record.compiled.wallet, chainId: record.compiled.chainId, enabled: options.enabled ?? true,
    enableNonce: options.nonce ?? record.compiled.activationEnableNonce, configurationHash: hash(record.compiled.configurations),
    administration: { epoch: "1", hash: hash(record.compiled.permissionId), lastInitialization: { epoch: "1", permissionIds: [record.compiled.permissionId] } },
    evidence: { chainId: record.compiled.chainId, blockNumber: options.block ?? "100", blockHash: hash(options.block ?? "100"),
      timestamp: String(options.timestamp ?? seconds()), source: "onchain" },
    counters: [{ policy: addr(21), configId: hash("config"), name: "calls", used: "0", limit: "100" }] }, Date.now(), options.finalized ?? false);
}
async function observe(record: StoredSession, options: Parameters<typeof observation>[1] = {}) {
  return store.observe({ actor: record.actor, id: record.id, expectedRevision: record.revision,
    expectedObservationHash: record.observation?.proofHash ?? null, observation: observation(record, options), now: Date.now() });
}
async function activate(record: StoredSession) {
  const installing = (await store.claimActivation(claim(record))).record;
  return (await observe(installing)).record;
}
async function reservations(id: string) {
  return (await pool.query<{ kind: string; coordinate: string; released_at: string | null }>(
    "SELECT kind,coordinate,released_at::text FROM rest_session_reservations WHERE session_id=$1 ORDER BY kind,coordinate", [id],
  )).rows;
}
function binding(record: StoredSession): UserOperationSessionBinding {
  const c = record.compiled;
  return { id: record.id, policyHash: c.policyHash, compiledHash: c.compiledHash, generation: c.generation,
    grantId: c.grantId, permissionId: c.permissionId, sessionKey: c.sessionKey, observationHash: record.observation!.proofHash };
}
async function guard(record: StoredSession, change: Partial<UserOperationSessionBinding> = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const actor = { accountId: record.actor.accountId, principalId: `bot:${record.compiled.grantId}` };
    await assertRestActorActive(client, actor, ["relay"], seconds());
    await assertUserOperationSession(client, actor, { ...binding(record), ...change }, record.compiled.bindingId,
      record.compiled.chainId, record.compiled.wallet, seconds());
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

suite("PostgreSQL session lifecycle", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 12 });
    // Verify migration009 has no dependency on transaction/sponsorship/UserOperation tables.
    for (const filename of ["004_rest_accounts.sql", "007_rest_smart_accounts.sql", "009_rest_sessions.sql"])
      await pool.query(await readFile(new URL(`../src/db/migrations/${filename}`, import.meta.url), "utf8"));
    // Lifecycle plan replacement additionally exercises the actual shared execution transport tables.
    for (const filename of ["005_rest_transactions.sql", "006_rest_sponsorship.sql", "008_rest_user_operations.sql"])
      await pool.query(await readFile(new URL(`../src/db/migrations/${filename}`, import.meta.url), "utf8"));
    store = new PostgresSessionStore(pool);
    await seedAccount(owner);
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  it("deduplicates concurrent creation across replicas without reserving allocations", async () => {
    const record = await prepared(), key = idem();
    const results = await Promise.all(Array.from({ length: 8 }, () => new PostgresSessionStore(pool).create(record, key, Date.now())));
    expect(results.every(r => r.id === record.id)).toBe(true);
    expect(await reservations(record.id)).toEqual([]);
    expect(await store.find(owner, key)).toEqual(record);
    await expect(store.find(owner, { ...key, requestHash: hash("changed") })).rejects.toMatchObject({ code: "SESSION_IDEMPOTENCY_CONFLICT" });
  });

  it("permanently rejects concurrent generation reuse through another API-account alias", async () => {
    const physicalWallet = addr(), otherId = `eip155:1:${addr()}`;
    const other: RestActor = { accountId: otherId, principalId: `owner:${otherId}` };
    const a = await prepared({ wallet: physicalWallet }), b = await prepared({ wallet: physicalWallet, actor: other });
    const results = await Promise.allSettled([save(a), save(b)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  });

  it("serializes overlapping asset admission across different keys, grants and account aliases", async () => {
    const physicalWallet = addr(), otherId = `eip155:1:${addr()}`;
    const other: RestActor = { accountId: otherId, principalId: `owner:${otherId}` };
    const a = await save(await prepared({ wallet: physicalWallet, key: addr() }));
    const b = await save(await prepared({ wallet: physicalWallet, key: addr(), actor: other }));
    const ca = claim(a), cb = claim(b);
    const results = await Promise.allSettled([store.claimActivation(ca), new PostgresSessionStore(pool).claimActivation(cb)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(r => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "SESSION_ALLOCATION_CONFLICT" });
    expect((await reservations(a.id)).length + (await reservations(b.id)).length).toBe(2);
    // Sibling chain allocations remain reviewable but are not fabricated as local authority.
    const all = await pool.query("SELECT 1 FROM rest_session_reservations WHERE chain_id=10");
    expect(all.rowCount).toBe(0);
  });

  it("blocks new generations even with distinct assets and adjacent windows until retirement", async () => {
    const wallet = addr(), after = seconds() - 7 * 86400 + 120;
    const a = await save(await prepared({ wallet, validAfter: after }));
    const b = await save(await prepared({ wallet, generation: "2", asset: addr(), validAfter: after + 60 }));
    const c = await save(await prepared({ wallet, generation: "3", asset: addr(), validAfter: a.compiled.validUntil }));
    await store.claimActivation(claim(a));
    await expect(store.claimActivation(claim(b))).rejects.toMatchObject({ code: "SESSION_ALLOCATION_CONFLICT" });
    await expect(store.claimActivation(claim(c))).rejects.toMatchObject({ code: "SESSION_ALLOCATION_CONFLICT" });
  });

  it("uses one idempotency namespace for creation, activation and revocation", async () => {
    const record = await prepared(), key = idem();
    await store.create(record, key, Date.now());
    await expect(store.claimActivation({ ...claim(record), idempotency: key })).rejects.toMatchObject({ code: "SESSION_IDEMPOTENCY_CONFLICT" });
    const activation = claim(record), installed = await store.claimActivation(activation);
    expect((await store.claimActivation(activation)).claimed).toBe(false);
    await expect(store.claimRevocation({ ...claim(installed.record, "revocation"), idempotency: activation.idempotency })).rejects.toMatchObject({ code: "SESSION_IDEMPOTENCY_CONFLICT" });
  });

  it("keeps reservations through nonfinal retirement and releases only finalized canonical retirement", async () => {
    let record = await activate(await save(await prepared()));
    record = (await store.claimRevocation(claim(record, "revocation"))).record;
    record = (await observe(record, { enabled: false, nonce: "8", block: "101" })).record;
    expect(record.state).toBe("revoked"); expect(record.reservationsReleased).toBe(false);
    expect((await reservations(record.id)).every(r => r.released_at === null)).toBe(true);
    const next = await save(await prepared({ wallet: record.compiled.wallet, generation: "2", key: addr() }));
    await expect(store.claimActivation(claim(next))).rejects.toMatchObject({ code: "SESSION_ALLOCATION_CONFLICT" });
    record = (await observe(record, { enabled: false, nonce: "8", block: "102", finalized: true })).record;
    expect(record.reservationsReleased).toBe(true);
    expect((await reservations(record.id)).every(r => r.released_at !== null)).toBe(true);
    expect((await store.claimActivation(claim(next))).claimed).toBe(true);
    const reused = await prepared({ wallet: record.compiled.wallet });
    await expect(save(reused)).rejects.toMatchObject({ code: "SESSION_CONFLICT" });
  });

  it("returns explicit stale CAS results and preserves reservations during reorg invalidation", async () => {
    const record = await activate(await save(await prepared()));
    const stale = await store.markStale({ actor: owner, id: record.id, expectedRevision: record.revision, reason: "reorg", now: Date.now() });
    expect(stale.applied).toBe(true); expect(stale.record.state).toBe("stale");
    const late = await observe(record, { block: "101" });
    expect(late.applied).toBe(false); expect(late.record).toEqual(stale.record);
    expect((await reservations(record.id)).every(r => r.released_at === null)).toBe(true);
    await expect(guard(record)).rejects.toMatchObject({ code: "SESSION_EXECUTION_UNAVAILABLE" });
    expect((await observe(stale.record, { block: "99" })).record.state).toBe("stale");
  });

  it("admits only current exact session bindings and rejects changed generation or unlinked wallets", async () => {
    const record = await activate(await save(await prepared()));
    await expect(guard(record)).resolves.toBeUndefined();
    await expect(guard(record, { generation: "2" })).rejects.toMatchObject({ code: "SESSION_OPERATION_BINDING_MISMATCH" });
    await pool.query("UPDATE rest_smart_account_bindings SET revoked_at=1 WHERE account_id=$1 AND id=$2", [record.actor.accountId, record.compiled.bindingId]);
    await expect(guard(record)).rejects.toMatchObject({ code: "SESSION_BINDING_INACTIVE" });
    expect((await observe(record, { block: "101" })).record.state).toBe("stale");
  });

  it("permits owner retirement after bot revocation but never restores API execution authority", async () => {
    let record = await activate(await save(await prepared()));
    await pool.query("UPDATE rest_bot_grants SET revoked_at=$2 WHERE id=$1", [record.compiled.grantId, seconds()]);
    await expect(guard(record)).rejects.toMatchObject({ code: "FORBIDDEN" });
    record = (await observe(record, { block: "101" })).record;
    expect(record.state).toBe("stale");
    record = (await store.claimRevocation(claim(record, "revocation"))).record;
    expect(record.state).toBe("revoking");
    expect((await reservations(record.id)).every(r => r.released_at === null)).toBe(true);
  });

  it("isolates owner/bound-bot reads, paginates deterministically, and reports onchain-only quota", async () => {
    const record = await save(await prepared({ days: 30 }));
    const bot: RestActor = { accountId, principalId: `bot:${record.compiled.grantId}` };
    expect(await store.get(bot, record.id)).toEqual(record);
    expect(await store.get({ accountId, principalId: `bot:${randomUUID()}` }, record.id)).toBeUndefined();
    const page = await store.list(owner, { limit: 2 });
    expect(page.items).toHaveLength(2); expect(page.nextCursor).toBe(page.items[1]!.id);
    const next = await store.list(owner, { limit: 2, cursor: page.nextCursor! });
    expect(next.items.every(r => r.id > page.nextCursor!)).toBe(true);
    expect((await store.list(bot, { limit: 100 })).items.map(r => r.id)).toEqual([record.id]);
    expect(await store.quota(bot, record.id)).toMatchObject({ executionAuthority: false, balanceSource: "onchain-only", atomicAcrossChains: false,
      counters: null, localAllocations: [{ chainId: 1, limit: "100" }] });
  });

  it("accepts policies without asset allocations while still reserving their key", async () => {
    const record = await save(await prepared({ emptyAllocations: true }));
    await store.claimActivation(claim(record));
    expect((await reservations(record.id)).map(r => r.kind)).toEqual(["key"]);
  });

  it("reserves observed enabled authority even when no activation claim was stored", async () => {
    const record = await save(await prepared({ emptyAllocations: true }));
    expect((await observe(record)).record.state).toBe("stale");
    expect((await reservations(record.id)).map(r => r.kind)).toEqual(["key"]);
    const next = await save(await prepared({ wallet: record.compiled.wallet, key: addr(), emptyAllocations: true }));
    await expect(store.claimActivation(claim(next))).rejects.toMatchObject({ code: "SESSION_ALLOCATION_CONFLICT" });
  });

  it("never releases expired onchain authority without disabled proof and nonce advancement", async () => {
    let record = await activate(await save(await prepared()));
    record = (await observe(record, { block: "101", timestamp: record.compiled.validUntil, finalized: true })).record;
    expect(record.state).toBe("expired"); expect(record.reservationsReleased).toBe(false);
    expect((await reservations(record.id)).every(r => r.released_at === null)).toBe(true);
    const next = await save(await prepared({ wallet: record.compiled.wallet, key: addr() }));
    await expect(store.claimActivation(claim(next))).rejects.toMatchObject({ code: "SESSION_ALLOCATION_CONFLICT" });
  });

  it("rejects mismatched immutable documents and database NULL identity bypasses", async () => {
    const record = await prepared(), altered = structuredClone(record);
    altered.compiled.generation = "2";
    await expect(save(altered)).rejects.toMatchObject({ code: "SESSION_INPUT_INVALID" });
    await save(record);
    await expect(pool.query("UPDATE rest_sessions SET document=jsonb_set(document,'{compiled,grantId}','null'::jsonb) WHERE id=$1", [record.id]))
      .rejects.toMatchObject({ code: "23514" });
    expect(await store.get(owner, record.id)).toEqual(record);
  });

  it("returns exact compiler documents only to the internal chain/wallet/permission lookup", async () => {
    const record = await save(await prepared()), c = record.compiled;
    const restored = await new PostgresSessionStore(pool).findCompiled(c.chainId, c.wallet, c.permissionId);
    expect(restored).toEqual(c);
    restored!.generation = "999";
    expect((await store.findCompiled(c.chainId, c.wallet, c.permissionId))!.generation).toBe(c.generation);
    expect(await store.findCompiled(10, c.wallet, c.permissionId)).toBeUndefined();
    expect(await store.findCompiled(c.chainId, addr(), c.permissionId)).toBeUndefined();
    expect(await store.findCompiled(c.chainId, c.wallet, hash("another permission"))).toBeUndefined();
    // Simulate damaged storage: relational identity still agrees but reviewed bytes do not.
    await pool.query("UPDATE rest_sessions SET document=jsonb_set(document,'{compiled,reviewedPolicy,unexpected}','true'::jsonb) WHERE id=$1", [record.id]);
    await expect(store.findCompiled(c.chainId, c.wallet, c.permissionId)).rejects.toMatchObject({ code: "SESSION_INPUT_INVALID" });
  });

  it("retains counter-reset invalidation and refuses to refresh consumed approval limits", async () => {
    let record = await activate(await save(await prepared()));
    const consumed = observation(record, { block: "101" });
    consumed.installed.counters[0]!.used = "5";
    const proof = createSessionObservation(consumed.installed, consumed.observedAt);
    record = (await store.observe({ actor: owner, id: record.id, expectedRevision: record.revision,
      expectedObservationHash: record.observation!.proofHash, observation: proof, now: Date.now() })).record;
    expect(record.state).toBe("active");
    record = (await observe(record, { block: "102" })).record;
    expect(record.state).toBe("stale"); expect(record.invalidation?.reason).toBe("counter-reset");
    record = (await observe(record, { block: "103" })).record;
    expect(record.state).toBe("stale");
    expect((await reservations(record.id)).every(r => r.released_at === null)).toBe(true);
    await expect(guard(record)).rejects.toMatchObject({ code: "SESSION_EXECUTION_UNAVAILABLE" });
  });

  it("atomically requires admitted lifecycle plans and preserves superseded approval history", async () => {
    const preparedRecord = await save(await prepared()), firstClaim = claim(preparedRecord);
    const original = await lifecyclePlan(preparedRecord, firstClaim, true);
    await expect(lifecycleGuard(original)).rejects.toMatchObject({ code: "SESSION_LIFECYCLE_PLAN_UNADMITTED" });
    const admitted = (await store.claimActivation(firstClaim)).record;
    await expect(lifecycleGuard(original)).resolves.toBeUndefined();
    const replacement = claim(admitted), newPlan = await lifecyclePlan(admitted, replacement, false);
    const updated = (await store.claimActivation(replacement)).record;
    expect(updated.activation!.planId).toBe(newPlan.id);
    expect(updated.supersededApprovals).toHaveLength(1);
    expect(updated.supersededApprovals![0]!.approval.planId).toBe(original.id);
    await expect(lifecycleGuard(original)).rejects.toMatchObject({ code: "SESSION_LIFECYCLE_PLAN_UNADMITTED" });
    await expect(lifecycleGuard(newPlan)).resolves.toBeUndefined();
    const revokeClaim = claim(updated, "revocation"), revokePlan = await lifecyclePlan(updated, revokeClaim, false);
    await store.claimRevocation(revokeClaim);
    await expect(lifecycleGuard(newPlan)).rejects.toMatchObject({ code: "SESSION_LIFECYCLE_PLAN_UNADMITTED" });
    await expect(lifecycleGuard(revokePlan)).resolves.toBeUndefined();
  });

  it("never supersedes plans with any admitted execution transport, even after expiry", async () => {
    for (const transport of ["direct", "relayr", "erc4337"]) {
      const record = await save(await prepared()), initial = claim(record);
      const original = await lifecyclePlan(record, initial, true);
      const admitted = (await store.claimActivation(initial)).record;
      await pool.query("INSERT INTO rest_transaction_transports(plan_id,step_index,transport,binding_id) VALUES($1,0,$2,$3)", [original.id, transport, hash(transport)]);
      const replacement = claim(admitted); await lifecyclePlan(admitted, replacement, false);
      await expect(store.claimActivation(replacement)).rejects.toMatchObject({ code: "SESSION_PLAN_NOT_SUPERSEDABLE" });
      expect((await store.get(owner, admitted.id))!.activation!.planId).toBe(original.id);
    }
  });

  it("rejects live plan replacement and serializes simultaneous expired-plan replacements", async () => {
    const record = await save(await prepared()), initial = claim(record);
    const original = await lifecyclePlan(record, initial, false);
    const admitted = (await store.claimActivation(initial)).record;
    const early = claim(admitted); await lifecyclePlan(admitted, early, false);
    await expect(store.claimActivation(early)).rejects.toMatchObject({ code: "SESSION_PLAN_NOT_SUPERSEDABLE" });
    const expired = { ...original, expiresAt: Date.now() - 1 };
    await pool.query("UPDATE rest_transaction_plans SET expires_at=$2,document=$3::jsonb WHERE id=$1", [original.id, expired.expiresAt, JSON.stringify(expired)]);
    const a = claim(admitted), b = claim(admitted);
    await lifecyclePlan(admitted, a, false); await lifecyclePlan(admitted, b, false);
    const outcomes = await Promise.allSettled([store.claimActivation(a), new PostgresSessionStore(pool).claimActivation(b)]);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((await store.get(owner, record.id))!.supersededApprovals).toHaveLength(1);
  });

  it("detects unobserved counter resets from complete session administration history", async () => {
    const record = await activate(await save(await prepared()));
    const reset = observation(record, { block: "101" });
    reset.installed.administration = { epoch: "3", hash: hash("reinitialize-spend"), lastInitialization: { epoch: "3", permissionIds: [record.compiled.permissionId] } };
    const outcome = await store.observe({ actor: owner, id: record.id, expectedRevision: record.revision,
      expectedObservationHash: record.observation!.proofHash, observation: createSessionObservation(reset.installed, reset.observedAt), now: Date.now() });
    expect(outcome.record).toMatchObject({ state: "stale", invalidation: { reason: "configuration-changed" } });
    expect(outcome.record.observation!.installed.counters[0]!.used).toBe("0");
  });

  it("rejects approval expiry after a cross-account wallet-lock wait and rolls back reservations", async () => {
    const record = await save(await prepared()), input = claim(record);
    const lock = await pool.connect();
    let pending: ReturnType<PostgresSessionStore["claimActivation"]> | undefined;
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`rest-session-wallet:1:${record.compiled.wallet.toLowerCase()}`]);
      input.approval.expiresAt = seconds() + 2;
      pending = store.claimActivation(input);
      // Attach immediately so the deliberate expiry rejection is never unhandled.
      const outcome = pending.then(value => ({ value }), error => ({ error }));
      await waitForLock(lock);
      await lock.query("SELECT pg_sleep(GREATEST(0,$1::double precision-extract(epoch FROM clock_timestamp())::double precision+0.01))", [input.approval.expiresAt]);
      await lock.query("COMMIT");
      expect(await outcome).toMatchObject({ error: { code: "SESSION_OWNER_APPROVAL_EXPIRED" } });
      expect(await store.get(owner, record.id)).toEqual(record);
      expect(await reservations(record.id)).toEqual([]);
    } finally { await lock.query("ROLLBACK"); lock.release(); }
  });
});

async function lifecyclePlan(record: StoredSession, input: SessionClaim, expired: boolean): Promise<StoredPlan> {
  const now = Date.now(), c = record.compiled;
  const plan: StoredPlan = { id: input.approval.planId, actor: owner, commitment: input.approval.planCommitment, createdAt: now - 400_000,
    expiresAt: expired ? now - 1000 : now + 300_000, revision: 0,
    draft: { operation: input.approval.kind === "activation" ? "activate_smart_account_session" : "revoke_smart_account_session",
      account: c.wallet, calls: [{ chainId: c.chainId, to: c.smartSessions.address, data: "0x1234", value: "0", label: "fixture", dependsOn: [], decoded: {} }],
      evidence: [], summary: { sessionId: record.id, compiledHash: c.compiledHash, setup: {} }, warnings: [] },
    smartAccount: { bindingId: c.bindingId, chainId: c.chainId, address: c.wallet, stateHash: hash("state"), manifestRevision: c.manifestRevision },
    steps: [{ index: 0, state: "waiting" }] };
  await pool.query("INSERT INTO rest_transaction_plans(id,account_id,principal_id,account_address,created_at,expires_at,revision,document) VALUES($1,$2,$3,$4,$5,$6,0,$7::jsonb)",
    [plan.id, owner.accountId, owner.principalId, c.wallet.toLowerCase(), plan.createdAt, plan.expiresAt, JSON.stringify(plan)]);
  return plan;
}
async function lifecycleGuard(plan: StoredPlan) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assertRestActorActive(client, owner, ["relay"], seconds());
    await client.query("SELECT id FROM rest_transaction_plans WHERE id=$1 FOR UPDATE", [plan.id]);
    await assertUserOperationLifecyclePlan(client, owner, plan, seconds());
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

async function waitForLock(lock: PoolClient) {
  const pid = (await lock.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
  const deadline = performance.now() + 2000;
  for (;;) {
    await lock.query("SELECT pg_stat_clear_snapshot()");
    const waiting = await lock.query("SELECT 1 FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))", [pid]);
    if (waiting.rowCount) return;
    if (performance.now() >= deadline) throw new Error("Session claim never waited for wallet lock");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
