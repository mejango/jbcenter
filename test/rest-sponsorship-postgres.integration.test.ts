import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccak256, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/postgres.js";
import { PostgresAccountStore } from "../src/rest/auth/postgres.js";
import type { Account } from "../src/rest/auth/store.js";
import type { RestActor } from "../src/rest/core.js";
import { PostgresSponsorshipStore } from "../src/rest/sponsorship/postgres.js";
import type { SponsorshipClaim } from "../src/rest/sponsorship/store.js";
import type {
  RelayrEntry,
  RelayrQuote,
  SponsorshipRecord,
} from "../src/rest/sponsorship/types.js";
import { digest } from "../src/rest/sponsorship/validation.js";
import { PostgresTransactionStore } from "../src/rest/transactions/postgres.js";
import type {
  SignedAttempt,
  StoredPlan,
  SubmissionClaim,
} from "../src/rest/transactions/types.js";

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const schema = `rest_sponsorship_test_${randomUUID().replaceAll("-", "")}`;
const admin = connectionString ? createPool(connectionString) : null;
let pool: Pool;
let accounts: PostgresAccountStore;
let plans: PostgresTransactionStore;
let sponsorships: PostgresSponsorshipStore;
let nextForwardingNonce = 10_000n;

// Public fixture key. Signing produces local test bytes; no test calls a relay or broadcasts.
const wallet = privateKeyToAccount(`0x${"11".repeat(32)}`);
const target = "0x2222222222222222222222222222222222222222" as Address;
const forwarder = "0x3333333333333333333333333333333333333333" as Address;
const accountId = `eip155:1:${wallet.address.toLowerCase()}`;
const owner: RestActor = { accountId, principalId: `owner:${accountId}` };
const milliseconds = () => Date.now();
const seconds = () => Math.floor(milliseconds() / 1_000);
const idem = (key: string, operation = "prepare") => ({
  key,
  operation,
  requestHash: digest({ key, operation }),
});

async function createPlan(
  id: string,
  actor = owner,
  stepCount = 1,
  chainId = 1,
): Promise<StoredPlan> {
  const now = milliseconds();
  const plan: StoredPlan = {
    id,
    actor,
    commitment: digest({ id, actor, stepCount }),
    createdAt: now,
    expiresAt: now + 300_000,
    revision: 0,
    draft: {
      operation: "fixture",
      account: wallet.address,
      calls: Array.from({ length: stepCount }, (_, index) => ({
        chainId,
        to: target,
        data: "0x",
        value: "1",
        label: `Fixture ${index}`,
        dependsOn: [],
        decoded: {},
      })),
      evidence: [],
      summary: {},
      warnings: [],
    },
    steps: Array.from({ length: stepCount }, (_, index) => ({
      index,
      state: "waiting",
    })),
  };
  return plans.create(plan, idem(`plan:${id}`), now);
}

function preparation(
  plan: StoredPlan,
  id = `sponsor:${plan.id}`,
  stepIndexes = [0],
): SponsorshipRecord {
  const now = milliseconds();
  return {
    id,
    actor: plan.actor,
    planId: plan.id,
    planCommitment: plan.commitment,
    preparationKey: `prepare:${id}`,
    inputHash: digest({ planId: plan.id, stepIndexes }),
    commitment: digest({ id, planCommitment: plan.commitment, stepIndexes }),
    requests: stepIndexes.map((stepIndex) => ({
      stepIndex,
      chainId: plan.draft.calls[stepIndex]!.chainId,
      forwarder,
      forwarderCodeHash: digest("forwarder fixture"),
      targetCodeHash: digest("target fixture"),
      domain: {
        name: "FixtureForwarder",
        version: "1",
        chainId: plan.draft.calls[stepIndex]!.chainId,
        verifyingContract: forwarder,
      },
      message: {
        from: wallet.address,
        to: target,
        value: "1",
        gas: "100000",
        nonce: String(nextForwardingNonce++),
        deadline: String(Math.floor((now + 300_000) / 1_000)),
        data: "0x",
      },
      evidence: {
        chainId: plan.draft.calls[stepIndex]!.chainId,
        blockNumber: "1",
        blockHash: digest("block fixture"),
        timestamp: String(Math.floor(now / 1_000)),
        source: "onchain",
      },
    })),
    createdAt: now,
    expiresAt: now + 300_000,
    revision: 0,
    state: "prepared",
    observations: [],
  };
}

const entriesFor = (record: SponsorshipRecord): RelayrEntry[] =>
  record.requests.map((request) => ({
    chain: request.chainId,
    target: request.forwarder,
    data: "0x1234",
    value: request.message.value,
    virtual_nonce: 0,
  }));

function claim(record: SponsorshipRecord): SponsorshipClaim {
  const entries = entriesFor(record);
  return {
    actor: record.actor,
    id: record.id,
    key: `submit:${record.id}`,
    hash: digest({ commitment: record.commitment, entries }),
    entries,
    now: milliseconds(),
  };
}

async function directClaim(
  plan: StoredPlan,
  nonce: number,
  stepIndex = 0,
): Promise<SubmissionClaim> {
  const rawTransaction = await wallet.signTransaction({
    chainId: 1,
    type: "eip1559",
    nonce,
    gas: 21_000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
    to: target,
    value: 1n,
  });
  const now = milliseconds();
  const attempt: SignedAttempt = {
    hash: keccak256(rawTransaction),
    rawTransaction,
    sender: wallet.address,
    chainId: 1,
    nonce: String(nonce),
    type: "eip1559",
    gas: "21000",
    maximumFeePerGas: "2",
    maximumCost: "42001",
    reservedAt: now,
    leaseToken: randomUUID(),
    leaseUntil: now + 30_000,
    dispatchCount: 1,
  };
  return {
    actor: plan.actor,
    planId: plan.id,
    stepIndex,
    expectedRevision: plan.revision,
    attempt,
    idempotency: idem(`direct:${plan.id}:${stepIndex}`, "submit"),
    now,
    dispatch: true,
  };
}

async function transportRows(planId: string) {
  const result = await pool.query<{
    step_index: number;
    transport: string;
    binding_id: string;
  }>(
    "SELECT step_index, transport, binding_id FROM rest_transaction_transports WHERE plan_id=$1 ORDER BY step_index",
    [planId],
  );
  return result.rows;
}

async function forwardingNonceRows(sponsorshipId: string) {
  const result = await pool.query<{
    chain_id: string;
    forwarder: string;
    sender: string;
    nonce: string;
    sponsorship_id: string;
  }>(
    "SELECT chain_id::text, forwarder, sender, nonce, sponsorship_id FROM rest_sponsorship_nonces WHERE sponsorship_id=$1 ORDER BY chain_id, forwarder, sender, nonce",
    [sponsorshipId],
  );
  return result.rows;
}

async function databaseSeconds(client: Pool | PoolClient): Promise<number> {
  const result = await client.query<{ now: string }>(
    "SELECT floor(extract(epoch FROM clock_timestamp()))::text AS now",
  );
  return Number(result.rows[0]!.now);
}

async function waitForDatabaseLock(
  lock: PoolClient,
  backendPid: number,
): Promise<string[]> {
  const deadline = performance.now() + 1_000;
  for (;;) {
    // PostgreSQL caches activity snapshots within transactions; refresh the query text too.
    await lock.query("SELECT pg_stat_clear_snapshot()");
    const blocked = await lock.query<{ query: string }>(
      "SELECT query FROM pg_stat_activity WHERE $1::integer = ANY(pg_blocking_pids(pid))",
      [backendPid],
    );
    if (blocked.rows.length) return blocked.rows.map((row) => row.query);
    if (performance.now() >= deadline)
      throw new Error(
        "Sponsorship publication did not wait for its fixture lock.",
      );
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForDatabaseExpiry(
  lock: PoolClient,
  expiresAt: number,
): Promise<void> {
  // At most two seconds, measured by the same database clock used for admission.
  await lock.query(
    "SELECT pg_sleep(GREATEST(0, $1::double precision - extract(epoch FROM clock_timestamp())::double precision + 0.005))",
    [expiresAt],
  );
  expect(await databaseSeconds(lock)).toBeGreaterThanOrEqual(expiresAt);
}

async function expectUnclaimed(
  record: SponsorshipRecord,
  plan: StoredPlan,
): Promise<void> {
  const fresh = new PostgresSponsorshipStore(pool);
  expect(await fresh.get(record.actor, record.id)).toEqual(record);
  expect(await transportRows(plan.id)).toEqual([]);
  expect(await forwardingNonceRows(record.id)).toEqual([]);
  expect(await plans.get(plan.actor, plan.id)).toEqual(plan);
  const row = await pool.query<{
    submission_key: string | null;
    revision: string;
  }>(
    "SELECT submission_key, revision::text AS revision FROM rest_sponsorships WHERE id=$1",
    [record.id],
  );
  expect(row.rows).toEqual([{ submission_key: null, revision: "0" }]);
}

suite("PostgreSQL sponsorship persistence", () => {
  beforeAll(async () => {
    await admin!.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    await migrate(pool);
    accounts = new PostgresAccountStore(pool);
    plans = new PostgresTransactionStore(pool);
    sponsorships = new PostgresSponsorshipStore(pool);
    const now = seconds();
    const account: Account = {
      id: accountId,
      ownerAddress: wallet.address,
      authorityChainId: 1,
      profile: { displayName: "", bio: "", avatarUri: null },
      createdAt: now,
      updatedAt: now,
    };
    await accounts.enroll(account, {
      accountId,
      signer: wallet.address,
      grantId: null,
      nonce: `0x${"01".repeat(32)}`,
      issuedAt: now,
      expiresAt: now + 60,
      idempotencyKey: null,
      requiredScopes: [],
      ownerOnly: true,
      now,
    });
  });

  afterAll(async () => {
    await pool?.end();
    await admin!.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin!.end();
  });

  it("deduplicates creation across replicas and rejects a changed body for the preparation key", async () => {
    const original = preparation(await createPlan("create"));
    const records = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        new PostgresSponsorshipStore(pool).create(
          { ...original, id: `${original.id}:${index}` },
          milliseconds(),
        ),
      ),
    );
    expect(new Set(records.map((record) => record.id)).size).toBe(1);
    const fresh = new PostgresSponsorshipStore(pool);
    expect(
      await fresh.find(owner, original.preparationKey, original.inputHash),
    ).toEqual(records[0]);
    expect(await fresh.get(owner, records[0]!.id)).toEqual(records[0]);
    await expect(
      fresh.find(
        owner,
        original.preparationKey,
        digest("different preparation body"),
      ),
    ).rejects.toMatchObject({ status: 409, code: "SPONSORSHIP_CONFLICT" });
    await expect(
      fresh.create(
        {
          ...original,
          id: "conflicting-create",
          inputHash: digest("different preparation body"),
        },
        milliseconds(),
      ),
    ).rejects.toMatchObject({ status: 409, code: "SPONSORSHIP_CONFLICT" });
    expect(await fresh.get(owner, "conflicting-create")).toBeUndefined();
    const count = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM rest_sponsorships WHERE preparation_key=$1",
      [original.preparationKey],
    );
    expect(count.rows[0]!.count).toBe("1");
  });

  it("rejects a revoked bot before reserving submission identity or transport", async () => {
    const now = seconds();
    const grantId = "revoked-sponsorship-bot";
    await accounts.registerBot({
      id: grantId,
      accountId,
      botAddress: target,
      scopes: ["read", "plan", "relay"],
      label: "",
      createdAt: now,
      expiresAt: now + 300,
      revokedAt: null,
    });
    const bot: RestActor = { accountId, principalId: `bot:${grantId}` };
    const original = preparation(await createPlan("revoked", bot));
    await sponsorships.create(original, milliseconds());
    await accounts.revokeBot(accountId, grantId, seconds());
    await expect(sponsorships.claim(claim(original))).rejects.toMatchObject({
      status: 403,
    });
    expect(await sponsorships.get(owner, original.id)).toEqual(original);
    expect(await transportRows(original.planId)).toEqual([]);
    const row = await pool.query<{ submission_key: string | null }>(
      "SELECT submission_key FROM rest_sponsorships WHERE id=$1",
      [original.id],
    );
    expect(row.rows[0]!.submission_key).toBeNull();
  });

  it("admits one competing dispatch and persists the exact claim before a replica restarts", async () => {
    const original = preparation(await createPlan("dispatch-race"));
    await sponsorships.create(original, milliseconds());
    const input = claim(original);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        new PostgresSponsorshipStore(pool).claim(input),
      ),
    );
    expect(results.filter((result) => result.dispatch)).toHaveLength(1);
    const fresh = new PostgresSponsorshipStore(pool);
    const persisted = (await fresh.get(owner, original.id))!;
    expect(persisted).toMatchObject({
      state: "submitting",
      revision: 1,
      submission: { key: input.key, hash: input.hash, entries: input.entries },
    });
    expect(await fresh.claim(input)).toEqual({
      record: persisted,
      dispatch: false,
    });
    await expect(
      fresh.claim({ ...input, hash: digest("changed signed entries") }),
    ).rejects.toMatchObject({
      code: "SPONSORSHIP_CONFLICT",
    });
    await expect(
      fresh.claim({ ...input, key: "replacement-submission" }),
    ).rejects.toMatchObject({
      code: "SPONSORSHIP_CONFLICT",
    });
    expect(await fresh.get(owner, original.id)).toEqual(persisted);
    expect(await transportRows(original.planId)).toEqual([
      { step_index: 0, transport: "relayr", binding_id: original.id },
    ]);
  });

  it("retains an ambiguous submission permanently without redispatching after reconstruction", async () => {
    const original = preparation(await createPlan("ambiguous"));
    await sponsorships.create(original, milliseconds());
    const input = claim(original);
    await sponsorships.claim(input);
    const unknown = await sponsorships.settle(original.id, input.hash);
    expect(unknown).toMatchObject({ state: "submission_unknown", revision: 2 });
    const fresh = new PostgresSponsorshipStore(pool);
    expect(
      await fresh.claim({ ...input, now: milliseconds() + 1_000_000 }),
    ).toEqual({
      record: unknown,
      dispatch: false,
    });
    expect(await fresh.settle(original.id, input.hash)).toEqual(unknown);
    const replacement = preparation(
      (await plans.get(owner, original.planId))!,
      "ambiguous-replacement",
    );
    await fresh.create(replacement, milliseconds());
    await expect(fresh.claim(claim(replacement))).rejects.toMatchObject({
      code: "TRANSPORT_CONFLICT",
    });
    expect(await fresh.get(owner, replacement.id)).toEqual(replacement);
    expect(await transportRows(original.planId)).toEqual([
      { step_index: 0, transport: "relayr", binding_id: original.id },
    ]);
  });

  it("settles only the reserved submission and preserves the first committed quote exactly", async () => {
    const original = preparation(await createPlan("quote"));
    await sponsorships.create(original, milliseconds());
    const input = claim(original);
    const submitting = await sponsorships.claim(input);
    const quote: RelayrQuote = {
      bundleUuid: randomUUID(),
      entries: input.entries.map((entry) => ({ txUuid: randomUUID(), entry })),
      payments: [
        {
          chainId: 1,
          to: target,
          data: "0x1234",
          value: "100",
          deadline: String(seconds() + 300),
        },
      ],
      commitment: digest("first reviewed quote"),
      observedAt: milliseconds(),
    };
    await expect(
      sponsorships.settle(original.id, digest("wrong submission"), quote),
    ).rejects.toMatchObject({
      code: "SPONSORSHIP_CONFLICT",
    });
    expect(await sponsorships.get(owner, original.id)).toEqual(
      submitting.record,
    );
    const settled = await sponsorships.settle(original.id, input.hash, quote);
    expect(settled).toMatchObject({ state: "quoted", revision: 2, quote });
    const fresh = new PostgresSponsorshipStore(pool);
    expect(await fresh.settle(original.id, input.hash, quote)).toEqual(settled);
    expect(await fresh.settle(original.id, input.hash)).toEqual(settled);
    await expect(
      fresh.settle(original.id, input.hash, {
        ...quote,
        commitment: digest("replacement quote"),
      }),
    ).rejects.toMatchObject({ code: "SPONSORSHIP_CONFLICT" });
    const changedPayload = structuredClone(quote);
    changedPayload.payments[0]!.value = "999999";
    expect(await fresh.settle(original.id, input.hash, changedPayload)).toEqual(
      settled,
    );
    expect(await fresh.get(owner, original.id)).toEqual(settled);
  });

  it("rejects either transport after the other has permanently reserved the same plan step", async () => {
    for (const [index, winner] of ["direct", "relayr"].entries()) {
      const plan = await createPlan(`transport-first:${winner}`);
      const record = preparation(plan);
      await sponsorships.create(record, milliseconds());
      const direct = await directClaim(plan, 100 + index);
      if (winner === "direct") {
        expect((await plans.claimSubmission(direct)).dispatch).toBe(true);
        await expect(sponsorships.claim(claim(record))).rejects.toMatchObject({
          code: "TRANSPORT_CONFLICT",
        });
        expect(await sponsorships.get(owner, record.id)).toEqual(record);
      } else {
        expect((await sponsorships.claim(claim(record))).dispatch).toBe(true);
        await expect(plans.claimSubmission(direct)).rejects.toMatchObject({
          code: "TRANSPORT_CONFLICT",
        });
        expect(await plans.get(owner, plan.id)).toEqual(plan);
        expect(
          await plans.findIdempotentPlan(owner, direct.idempotency),
        ).toBeUndefined();
        const nonce = await pool.query(
          "SELECT 1 FROM rest_transaction_nonces WHERE nonce=$1",
          [direct.attempt.nonce],
        );
        expect(nonce.rowCount).toBe(0);
      }
      expect(await transportRows(plan.id)).toEqual([
        {
          step_index: 0,
          transport: winner,
          binding_id: winner === "direct" ? direct.attempt.hash : record.id,
        },
      ]);
    }
  });

  it("admits exactly one actual direct or sponsorship store when their claims race", async () => {
    const plan = await createPlan("transport-concurrent");
    const record = preparation(plan);
    await sponsorships.create(record, milliseconds());
    const direct = await directClaim(plan, 200);
    const outcomes = await Promise.allSettled([
      new PostgresSponsorshipStore(pool).claim(claim(record)),
      new PostgresTransactionStore(pool).claimSubmission(direct),
    ]);
    expect(
      outcomes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.find((result) => result.status === "rejected"),
    ).toMatchObject({
      reason: { status: 409, code: "TRANSPORT_CONFLICT" },
    });
    const rows = await transportRows(plan.id);
    expect(rows).toHaveLength(1);
    const directWon = rows[0]!.transport === "direct";
    expect((await plans.get(owner, plan.id))!.revision).toBe(directWon ? 1 : 0);
    expect((await sponsorships.get(owner, record.id))!.state).toBe(
      directWon ? "prepared" : "submitting",
    );
  });

  it("rolls back earlier steps and submission metadata when a multi-step sponsorship conflicts", async () => {
    const plan = await createPlan("transport-multistep", owner, 2);
    const record = preparation(plan, "sponsor:transport-multistep", [0, 1]);
    await sponsorships.create(record, milliseconds());
    const direct = await directClaim(plan, 201, 1);
    await plans.claimSubmission(direct);
    await expect(sponsorships.claim(claim(record))).rejects.toMatchObject({
      code: "TRANSPORT_CONFLICT",
    });
    expect(await sponsorships.get(owner, record.id)).toEqual(record);
    expect(await transportRows(plan.id)).toEqual([
      { step_index: 1, transport: "direct", binding_id: direct.attempt.hash },
    ]);
    const other = preparation(plan, "sponsor:unclaimed-step", [0]);
    await sponsorships.create(other, milliseconds());
    expect((await sponsorships.claim(claim(other))).dispatch).toBe(true);
    expect(await transportRows(plan.id)).toEqual([
      { step_index: 0, transport: "relayr", binding_id: other.id },
      { step_index: 1, transport: "direct", binding_id: direct.attempt.hash },
    ]);
  });

  it("rejects publication approval that expires behind the account lock without leaving reservations", async () => {
    const plan = await createPlan("authorization-account-lock");
    const record = preparation(plan);
    await sponsorships.create(record, milliseconds());
    const lock = await pool.connect();
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT id FROM rest_accounts WHERE id=$1 FOR UPDATE", [
        accountId,
      ]);
      const pid = await lock.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const issuedAt = await databaseSeconds(lock);
      const authorization = { issuedAt, expiresAt: issuedAt + 2 };
      const pending = sponsorships
        .claim({ ...claim(record), authorization })
        .then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
      expect(await waitForDatabaseLock(lock, pid.rows[0]!.pid)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/FROM rest_accounts.*FOR UPDATE/),
        ]),
      );
      await waitForDatabaseExpiry(lock, authorization.expiresAt);
      await lock.query("COMMIT");
      expect(await pending).toMatchObject({
        error: { status: 401, code: "AUTH_EXPIRED" },
      });
      await expectUnclaimed(record, plan);
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
    }
  });

  it("rechecks publication approval after transport I/O and rolls back every step in the claim", async () => {
    const plan = await createPlan("authorization-transport-lock", owner, 2);
    const record = preparation(
      plan,
      "sponsor:authorization-transport-lock",
      [0, 1],
    );
    await sponsorships.create(record, milliseconds());
    const lock = await pool.connect();
    try {
      await lock.query("BEGIN");
      // No account lock: the claimant must pass its first authorization check.
      // Its sorted multi-step insert can write step 0 before waiting on this uncommitted step 1.
      await lock.query(
        "INSERT INTO rest_transaction_transports (plan_id,step_index,transport,binding_id) VALUES($1,1,$2,$3)",
        [plan.id, "relayr", record.id],
      );
      const pid = await lock.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const issuedAt = await databaseSeconds(lock);
      const authorization = { issuedAt, expiresAt: issuedAt + 2 };
      const pending = sponsorships
        .claim({ ...claim(record), authorization })
        .then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
      expect(await waitForDatabaseLock(lock, pid.rows[0]!.pid)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^INSERT INTO rest_transaction_transports/),
        ]),
      );
      await waitForDatabaseExpiry(lock, authorization.expiresAt);
      // Allow both real reservations to finish; the final check must undo the claimant's writes.
      await lock.query("ROLLBACK");
      expect(await pending).toMatchObject({
        error: { status: 401, code: "AUTH_EXPIRED" },
      });
      await expectUnclaimed(record, plan);
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
    }
  });

  it("returns admitted submissions without dispatch when replayed with expired approval", async () => {
    const plan = await createPlan("authorization-replay");
    const record = preparation(plan);
    await sponsorships.create(record, milliseconds());
    const issuedAt = await databaseSeconds(pool);
    const input = {
      ...claim(record),
      authorization: { issuedAt, expiresAt: issuedAt + 60 },
    };
    const admitted = await sponsorships.claim(input);
    expect(admitted.dispatch).toBe(true);
    const expiredReplay = {
      ...input,
      authorization: { issuedAt: issuedAt - 120, expiresAt: issuedAt - 60 },
    };
    const fresh = new PostgresSponsorshipStore(pool);
    expect(await fresh.claim(expiredReplay)).toEqual({
      record: admitted.record,
      dispatch: false,
    });
    const unknown = await fresh.settle(record.id, input.hash);
    expect(
      await new PostgresSponsorshipStore(pool).claim(expiredReplay),
    ).toEqual({
      record: unknown,
      dispatch: false,
    });
    expect(await transportRows(plan.id)).toEqual([
      { step_index: 0, transport: "relayr", binding_id: record.id },
    ]);
  });

  it("rejects preparation already expired on the database clock even if a slow replica accepts it", async () => {
    const plan = await createPlan("preparation-slow-clock");
    const record = preparation(plan);
    const databaseNow = (await databaseSeconds(pool)) * 1_000;
    const expired: SponsorshipRecord = {
      ...record,
      createdAt: databaseNow - 120_000,
      expiresAt: databaseNow - 1_000,
    };
    await expect(
      sponsorships.create(expired, databaseNow - 60_000),
    ).rejects.toMatchObject({
      status: 400,
      code: "INVALID_SPONSORSHIP_RECORD",
    });
    expect(await sponsorships.get(owner, record.id)).toBeUndefined();
    expect(
      await sponsorships.find(owner, record.preparationKey, record.inputHash),
    ).toBeUndefined();
    expect(await transportRows(plan.id)).toEqual([]);
    expect(await plans.get(owner, plan.id)).toEqual(plan);
    // An expired attempt must not consume the preparation's idempotency key.
    const fresh = preparation(plan);
    expect(await sponsorships.create(fresh, milliseconds())).toEqual(fresh);
  });

  it("reserves one normalized forwarding nonce globally across competing plans and actor namespaces", async () => {
    const now = seconds();
    const alternateAccountId = `eip155:10:${wallet.address.toLowerCase()}`;
    const alternateOwner: RestActor = {
      accountId: alternateAccountId,
      principalId: `owner:${alternateAccountId}`,
    };
    await accounts.enroll(
      {
        id: alternateAccountId,
        ownerAddress: wallet.address,
        authorityChainId: 10,
        profile: { displayName: "", bio: "", avatarUri: null },
        createdAt: now,
        updatedAt: now,
      },
      {
        accountId: alternateAccountId,
        signer: wallet.address,
        grantId: null,
        nonce: `0x${"02".repeat(32)}`,
        issuedAt: now,
        expiresAt: now + 60,
        idempotencyKey: null,
        requiredScopes: [],
        ownerOnly: true,
        now,
      },
    );
    const botId = "forwarding-nonce-bot";
    await accounts.registerBot({
      id: botId,
      accountId,
      botAddress: target,
      scopes: ["read", "plan", "relay"],
      label: "",
      createdAt: now,
      expiresAt: now + 300,
      revokedAt: null,
    });
    const actors = [
      owner,
      { accountId, principalId: `bot:${botId}` },
      alternateOwner,
    ];
    const originalPlans = await Promise.all(
      actors.map((actor, index) =>
        createPlan(`forwarding-nonce-race:${index}`, actor),
      ),
    );
    const records = originalPlans.map((plan) => preparation(plan));
    const nonce = records[0]!.requests[0]!.message.nonce;
    const normalizedForwarder = `0x${"ab".repeat(20)}`;
    for (const [index, record] of records.entries()) {
      const request = record.requests[0]!;
      request.forwarder = (
        index % 2 === 0
          ? normalizedForwarder
          : `0x${normalizedForwarder.slice(2).toUpperCase()}`
      ) as Address;
      request.domain.verifyingContract = request.forwarder;
      request.message.from = (
        index === 2
          ? `0x${wallet.address.slice(2).toUpperCase()}`
          : wallet.address.toLowerCase()
      ) as Address;
      request.message.nonce = nonce;
      record.commitment = digest({
        planCommitment: record.planCommitment,
        requests: record.requests,
      });
      await sponsorships.create(record, milliseconds());
    }
    const inputs = records.map((record) => claim(record));
    const outcomes = await Promise.allSettled(
      inputs.map((input) => new PostgresSponsorshipStore(pool).claim(input)),
    );
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    for (const [index, outcome] of outcomes.entries()) {
      const record = records[index]!;
      if (outcome.status === "fulfilled") {
        expect(outcome.value.dispatch).toBe(true);
        expect(await forwardingNonceRows(record.id)).toEqual([
          {
            chain_id: "1",
            forwarder: normalizedForwarder,
            sender: wallet.address.toLowerCase(),
            nonce,
            sponsorship_id: record.id,
          },
        ]);
        expect(
          await new PostgresSponsorshipStore(pool).claim(inputs[index]!),
        ).toEqual({
          record: outcome.value.record,
          dispatch: false,
        });
      } else {
        expect(outcome.reason).toMatchObject({
          status: 409,
          code: "FORWARD_NONCE_CONFLICT",
        });
        await expectUnclaimed(record, originalPlans[index]!);
      }
    }
    const reservationCount = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM rest_sponsorship_nonces WHERE chain_id=1 AND forwarder=$1 AND sender=$2 AND nonce=$3",
      [normalizedForwarder, wallet.address.toLowerCase(), nonce],
    );
    expect(reservationCount.rows[0]!.count).toBe("1");
  });

  it("rolls back new forwarding nonces, transports, and submission state after a later nonce collides", async () => {
    const collisionForwarder = `0x${"cd".repeat(20)}` as Address;
    const sourcePlan = await createPlan("forwarding-nonce-source");
    const source = preparation(sourcePlan);
    source.requests[0]!.forwarder = collisionForwarder;
    source.requests[0]!.domain.verifyingContract = collisionForwarder;
    source.requests[0]!.message.nonce = "1";
    source.commitment = digest({
      planCommitment: source.planCommitment,
      requests: source.requests,
    });
    await sponsorships.create(source, milliseconds());
    const originalClaim = claim(source);
    await sponsorships.claim(originalClaim);
    const unknown = await sponsorships.settle(source.id, originalClaim.hash);

    const destinationPlan = await createPlan(
      "forwarding-nonce-partial",
      owner,
      2,
    );
    const destination = preparation(
      destinationPlan,
      "sponsor:forwarding-nonce-partial",
      [0, 1],
    );
    for (const [index, request] of destination.requests.entries()) {
      request.forwarder = collisionForwarder;
      request.domain.verifyingContract = collisionForwarder;
      // The sorted key for nonce 0 is acquired before the colliding nonce 1.
      request.message.nonce = String(index);
    }
    destination.commitment = digest({
      planCommitment: destination.planCommitment,
      requests: destination.requests,
    });
    await sponsorships.create(destination, milliseconds());
    await expect(sponsorships.claim(claim(destination))).rejects.toMatchObject({
      status: 409,
      code: "FORWARD_NONCE_CONFLICT",
    });
    await expectUnclaimed(destination, destinationPlan);
    expect(await sponsorships.get(owner, source.id)).toEqual(unknown);
    expect(await forwardingNonceRows(source.id)).toEqual([
      {
        chain_id: "1",
        forwarder: collisionForwarder,
        sender: wallet.address.toLowerCase(),
        nonce: "1",
        sponsorship_id: source.id,
      },
    ]);
    const unclaimedKey = await pool.query(
      "SELECT 1 FROM rest_sponsorship_nonces WHERE chain_id=1 AND forwarder=$1 AND sender=$2 AND nonce=$3",
      [collisionForwarder, wallet.address.toLowerCase(), "0"],
    );
    expect(unclaimedKey.rowCount).toBe(0);
    expect(
      await new PostgresSponsorshipStore(pool).claim(originalClaim),
    ).toEqual({
      record: unknown,
      dispatch: false,
    });
    // A fresh plan can still use the first key from the entirely rolled-back batch.
    const retry = preparation(await createPlan("forwarding-nonce-reusable"));
    retry.requests[0]!.forwarder = collisionForwarder;
    retry.requests[0]!.domain.verifyingContract = collisionForwarder;
    retry.requests[0]!.message.nonce = "0";
    retry.commitment = digest({
      planCommitment: retry.planCommitment,
      requests: retry.requests,
    });
    await sponsorships.create(retry, milliseconds());
    expect((await sponsorships.claim(claim(retry))).dispatch).toBe(true);
    expect((await forwardingNonceRows(retry.id))[0]!.nonce).toBe("0");
  });

  it("keeps forwarding nonce reservations separate across execution chains, forwarders, and later nonces", async () => {
    const domains = [
      { chainId: 1, forwarder: `0x${"e1".repeat(20)}` as Address, nonce: "5" },
      { chainId: 10, forwarder: `0x${"e1".repeat(20)}` as Address, nonce: "5" },
      { chainId: 1, forwarder: `0x${"e2".repeat(20)}` as Address, nonce: "5" },
      { chainId: 1, forwarder: `0x${"e1".repeat(20)}` as Address, nonce: "6" },
    ];
    for (const [index, domain] of domains.entries()) {
      const plan = await createPlan(
        `forwarding-nonce-domain:${index}`,
        owner,
        1,
        domain.chainId,
      );
      const record = preparation(plan);
      const request = record.requests[0]!;
      request.forwarder = domain.forwarder;
      request.domain.verifyingContract = domain.forwarder;
      request.message.nonce = domain.nonce;
      record.commitment = digest({
        planCommitment: record.planCommitment,
        requests: record.requests,
      });
      await sponsorships.create(record, milliseconds());
      const input = claim(record);
      expect(
        (await new PostgresSponsorshipStore(pool).claim(input)).dispatch,
      ).toBe(true);
      if (index === 0) {
        expect((await sponsorships.settle(record.id, input.hash)).state).toBe(
          "submission_unknown",
        );
      }
      expect(await forwardingNonceRows(record.id)).toEqual([
        {
          chain_id: String(domain.chainId),
          forwarder: domain.forwarder,
          sender: wallet.address.toLowerCase(),
          nonce: domain.nonce,
          sponsorship_id: record.id,
        },
      ]);
    }
    const progressed = await pool.query<{ nonce: string }>(
      "SELECT nonce FROM rest_sponsorship_nonces WHERE chain_id=1 AND forwarder=$1 AND sender=$2 ORDER BY nonce",
      [domains[0]!.forwarder, wallet.address.toLowerCase()],
    );
    expect(progressed.rows).toEqual([{ nonce: "5" }, { nonce: "6" }]);
  });

  it("rechecks publication approval after forwarding nonce I/O and rolls back the entire claim", async () => {
    const plan = await createPlan("authorization-forwarding-nonce-lock");
    const record = preparation(plan);
    await sponsorships.create(record, milliseconds());
    const blocker = preparation(
      await createPlan("authorization-forwarding-nonce-fixture"),
    );
    const request = record.requests[0]!;
    blocker.requests[0]!.message.nonce = request.message.nonce;
    blocker.commitment = digest({
      planCommitment: blocker.planCommitment,
      requests: blocker.requests,
    });
    await sponsorships.create(blocker, milliseconds());
    const lock = await pool.connect();
    try {
      await lock.query("BEGIN");
      // Reference the OTHER preparation: the FK lock must not block the target's
      // earlier sponsorship-row lock, account authorization, or transport reservation.
      await lock.query(
        "INSERT INTO rest_sponsorship_nonces (chain_id,forwarder,sender,nonce,sponsorship_id) VALUES($1,$2,$3,$4,$5)",
        [
          request.chainId,
          request.forwarder.toLowerCase(),
          request.message.from.toLowerCase(),
          request.message.nonce,
          blocker.id,
        ],
      );
      const pid = await lock.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const issuedAt = await databaseSeconds(lock);
      const authorization = { issuedAt, expiresAt: issuedAt + 2 };
      const pending = sponsorships
        .claim({ ...claim(record), authorization })
        .then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
      expect(await waitForDatabaseLock(lock, pid.rows[0]!.pid)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^INSERT INTO rest_sponsorship_nonces/),
        ]),
      );
      await waitForDatabaseExpiry(lock, authorization.expiresAt);
      await lock.query("ROLLBACK");
      expect(await pending).toMatchObject({
        error: { status: 401, code: "AUTH_EXPIRED" },
      });
      await expectUnclaimed(record, plan);
      expect(await forwardingNonceRows(blocker.id)).toEqual([]);
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
    }
  });
});
