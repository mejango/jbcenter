import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/postgres.js';
import { PostgresAccountStore, assertRestActorActive } from '../src/rest/auth/postgres.js';
import { PostgresSmartAccountRegistry } from '../src/rest/smartAccounts/postgres.js';
import { PostgresTransactionStore } from '../src/rest/transactions/postgres.js';
import { claimPostgresTransport } from '../src/rest/transactions/transport-reservations.js';
import { PostgresUserOperationStore } from '../src/rest/userOperations/postgres.js';
import { PostgresSessionStore } from '../src/rest/sessions/postgres.js';
import { recoveryCursor, type UserOperationRecord } from '../src/rest/userOperations/store.js';
import type { RestActor } from '../src/rest/core.js';
import type { StoredPlan } from '../src/rest/transactions/types.js';
import type { SmartAccountBinding } from '../src/rest/smartAccounts/types.js';
import {
  sessionBinding,
  sessionClaim,
  sessionFixture,
  sessionObservation,
} from './fixtures/sessions.js';
import {
  account,
  binding,
  claim,
  h,
  owner,
  ownerKey,
  plan,
  record,
  safe,
  target,
} from './fixtures/user-operations.js';

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const schema = `rest_user_operations_test_${randomUUID().replaceAll('-', '')}`;
const admin = connectionString ? createPool(connectionString) : null;
let pool: Pool;
let accounts: PostgresAccountStore;
let registry: PostgresSmartAccountRegistry;
let plans: PostgresTransactionStore;
let store: PostgresUserOperationStore;
let actor: RestActor;
const bindings = new Map<string, SmartAccountBinding>();

async function enroll(authorityChain = 1) {
  const now = Date.now();
  const value = account(now, authorityChain);
  await accounts.enroll(value, {
    accountId: value.id,
    signer: ownerKey.address,
    grantId: null,
    nonce: h(`enroll:${authorityChain}`),
    issuedAt: Math.floor(now / 1000),
    expiresAt: Math.floor(now / 1000) + 60,
    idempotencyKey: null,
    requiredScopes: [],
    ownerOnly: true,
    now: Math.floor(now / 1000),
  });
  const linked = binding(value, now);
  // Real SmartAccountService bindings keep execution evidence operation-specific.
  linked.state.executionVerified = false;
  await registry.bind(linked);
  bindings.set(value.id, linked);
  return owner(value);
}
async function prepare(id: string, nonce: bigint, principal = actor, steps = 1, persist = true) {
  const now = Date.now();
  const value = plan(id, principal, bindings.get(principal.accountId)!, now, steps);
  await plans.create(value, { key: `plan:${id}`, operation: 'prepare', requestHash: h(id) }, now);
  const operation = record(value, nonce);
  if (persist) await store.create(operation, now);
  return { plan: value, record: operation };
}
async function transportRows(id: string) {
  return (
    await pool.query(
      'SELECT step_index,transport,binding_id FROM rest_transaction_transports WHERE plan_id=$1 ORDER BY step_index',
      [id],
    )
  ).rows;
}
async function expectUnclaimed(value: { plan: StoredPlan; record: UserOperationRecord }) {
  expect(await store.get(value.record.actor, value.record.id)).toEqual(value.record);
  expect(await transportRows(value.plan.id)).toEqual([]);
  expect(
    (
      await pool.query('SELECT 1 FROM rest_user_operation_nonces WHERE user_operation_id=$1', [
        value.record.id,
      ])
    ).rowCount,
  ).toBe(0);
  const row = await pool.query(
    'SELECT submission_key,revision::text FROM rest_user_operations WHERE id=$1',
    [value.record.id],
  );
  expect(row.rows).toEqual([{ submission_key: null, revision: '0' }]);
  expect(await plans.get(value.plan.actor, value.plan.id)).toEqual(value.plan);
}
async function dbSeconds(client: PoolClient) {
  return Number(
    (
      await client.query<{ now: string }>(
        'SELECT floor(extract(epoch FROM clock_timestamp()))::text AS now',
      )
    ).rows[0]!.now,
  );
}
async function waitUntilBlocked(client: PoolClient, pid: number) {
  const deadline = performance.now() + 1000;
  for (;;) {
    await client.query('SELECT pg_stat_clear_snapshot()');
    const result = await client.query<{ query: string }>(
      'SELECT query FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))',
      [pid],
    );
    if (result.rows.length) return result.rows.map((row) => row.query);
    if (performance.now() >= deadline)
      throw new Error('Claim did not reach the expected database wait.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

suite('PostgreSQL UserOperation persistence', () => {
  beforeAll(async () => {
    await admin!.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    await migrate(pool);
    accounts = new PostgresAccountStore(pool);
    registry = new PostgresSmartAccountRegistry(pool);
    plans = new PostgresTransactionStore(pool);
    store = new PostgresUserOperationStore(pool);
    actor = await enroll();
  });
  afterAll(async () => {
    await pool?.end();
    await admin!.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin!.end();
  });

  it('admits verified module bindings without claiming account-wide execution and rejects missing module proof', async () => {
    expect(bindings.get(actor.accountId)!.state).toMatchObject({ moduleConfigurationVerified: true, executionVerified: false });
    const value = await prepare('operation-specific-execution-evidence', 9001n);
    await pool.query(
      "UPDATE rest_smart_account_bindings SET document=jsonb_set(jsonb_set(document,'{state,moduleConfigurationVerified}','false'::jsonb),'{state,executionVerified}','true'::jsonb) WHERE account_id=$1 AND id=$2",
      [actor.accountId, value.record.accountBindingId],
    );
    try {
      await expect(store.claim(claim(value.record, Date.now()))).rejects.toMatchObject({ code: 'USER_OPERATION_BINDING_STALE' });
      await expectUnclaimed(value);
      const newValue = await prepare('missing-module-proof', 9002n, actor, 1, false);
      await expect(store.create(newValue.record, Date.now())).rejects.toMatchObject({ code: 'USER_OPERATION_BINDING_STALE' });
    } finally {
      await pool.query(
        "UPDATE rest_smart_account_bindings SET document=jsonb_set(jsonb_set(document,'{state,moduleConfigurationVerified}','true'::jsonb),'{state,executionVerified}','false'::jsonb) WHERE account_id=$1 AND id=$2",
        [actor.accountId, value.record.accountBindingId],
      );
    }
    expect((await store.claim(claim(value.record, Date.now()))).dispatch).toBe(true);
  });

  it('creates one immutable preparation across competing clients and rejects same-key changed input', async () => {
    const value = await prepare('create', 1n, actor, 1, false);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        new PostgresUserOperationStore(pool).create(
          { ...value.record, id: `create:${index}` },
          Date.now(),
        ),
      ),
    );
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(await store.find(actor, value.record.preparationKey, value.record.inputHash)).toEqual(
      results[0],
    );
    await expect(
      store.create({ ...value.record, inputHash: h('changed') }, Date.now()),
    ).rejects.toMatchObject({ code: 'USER_OPERATION_CONFLICT' });
  });
  it('dispatches once across replicas and never blindly resubmits an ambiguous durable operation', async () => {
    const value = await prepare('submit', 2n);
    const input = claim(value.record, Date.now());
    const results = await Promise.all(
      Array.from({ length: 20 }, () => new PostgresUserOperationStore(pool).claim(input)),
    );
    expect(results.filter((result) => result.dispatch)).toHaveLength(1);
    const unknown = await store.settle(
      value.record.id,
      input.signedCommitment,
      'submission_unknown',
    );
    expect(unknown.submission!.operation).toEqual(input.operation);
    expect(
      await new PostgresUserOperationStore(pool).claim({
        ...input,
        authorization: { issuedAt: 1, expiresAt: 2 },
      }),
    ).toEqual({ record: unknown, dispatch: false });
    expect(await transportRows(value.plan.id)).toEqual([
      { step_index: 0, transport: 'erc4337', binding_id: value.record.id },
    ]);
    expect((await store.recoverable(100)).some((record) => record.id === value.record.id)).toBe(
      true,
    );
  });
  it('rejects changed signatures and changed transaction fields against the immutable signed commitment', async () => {
    const value = await prepare('signed-identity', 3n);
    const input = claim(value.record, Date.now());
    await store.claim(input);
    await expect(store.claim(claim(value.record, Date.now(), '0x5678'))).rejects.toMatchObject({
      code: 'USER_OPERATION_CONFLICT',
    });
    await expect(
      store.claim({ ...input, operation: { ...input.operation, callData: '0xabcd' } }),
    ).rejects.toMatchObject({ code: 'USER_OPERATION_CONFLICT' });
    expect((await store.get(actor, value.record.id))!.submission!.operation).toEqual(
      input.operation,
    );
  });
  it('globally reserves the full uint256 sender nonce across account aliases and different plans', async () => {
    const alternate = await enroll(10);
    const nonce = (1n << 200n) + 42n;
    const values = await Promise.all([
      prepare('nonce-main', nonce),
      prepare('nonce-alias', nonce, alternate),
    ]);
    const outcomes = await Promise.allSettled(
      values.map((value) =>
        new PostgresUserOperationStore(pool).claim(claim(value.record, Date.now())),
      ),
    );
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const [index, result] of outcomes.entries())
      if (result.status === 'rejected') {
        expect(result.reason).toMatchObject({ code: 'USER_OPERATION_NONCE_CONFLICT', status: 409 });
        await expectUnclaimed(values[index]!);
      }
    const rows = await pool.query<{ nonce: string }>(
      'SELECT nonce FROM rest_user_operation_nonces WHERE chain_id=1 AND sender=$1 AND nonce=$2',
      [safe, nonce.toString()],
    );
    expect(rows.rows).toEqual([{ nonce: nonce.toString() }]);
    const next = await prepare('nonce-next', nonce + 1n);
    expect((await store.claim(claim(next.record, Date.now()))).dispatch).toBe(true);
  });
  it('rolls back all UserOperation transport steps and nonce writes when another transport already won', async () => {
    for (const [index, transport] of (['direct', 'relayr'] as const).entries()) {
      const value = await prepare(`transport:${transport}`, 100n + BigInt(index), actor, 2);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await assertRestActorActive(client, actor, ['relay'], Math.floor(Date.now() / 1000));
        await claimPostgresTransport(
          client,
          value.plan.id,
          [1],
          transport,
          transport === 'direct' ? h('direct') : 'relayr-binding',
        );
        await client.query('COMMIT');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      await expect(store.claim(claim(value.record, Date.now()))).rejects.toMatchObject({
        code: 'TRANSPORT_CONFLICT',
      });
      expect(await store.get(actor, value.record.id)).toEqual(value.record);
      expect(await transportRows(value.plan.id)).toHaveLength(1);
      expect(
        (
          await pool.query('SELECT 1 FROM rest_user_operation_nonces WHERE user_operation_id=$1', [
            value.record.id,
          ])
        ).rowCount,
      ).toBe(0);
      const retry = await prepare(`transport-retry:${transport}`, 100n + BigInt(index));
      expect((await store.claim(claim(retry.record, Date.now()))).dispatch).toBe(true);
    }
  });
  it('rejects revoked bots before admission while owner inspection cannot borrow bot mutation authority', async () => {
    const now = Math.floor(Date.now() / 1000);
    const botId = 'uo-revoked';
    const bot = { accountId: actor.accountId, principalId: `bot:${botId}` };
    await accounts.registerBot({
      id: botId,
      accountId: actor.accountId,
      botAddress: target,
      scopes: ['read', 'plan', 'relay'],
      label: '',
      createdAt: now,
      expiresAt: now + 300,
      revokedAt: null,
    });
    const value = await prepare('revoked-bot', 200n, bot);
    await expect(store.claim({ ...claim(value.record, Date.now()), actor })).rejects.toMatchObject({
      status: 404,
    });
    await accounts.revokeBot(actor.accountId, botId, now);
    await expect(store.claim(claim(value.record, Date.now()))).rejects.toMatchObject({
      status: 403,
    });
    expect(await store.get(actor, value.record.id)).toEqual(value.record);
    await expectUnclaimed(value);
  });
  it('binds session generation, refreshes observation proof, and immediately rejects session revocation', async () => {
    const sessions = new PostgresSessionStore(pool);
    const fixture = sessionFixture(Date.now(), { generation: '73' });
    await accounts.registerBot(fixture.grant);
    const created = await sessions.create(
      fixture.record,
      { key: 'uo-session', requestHash: h('uo-session') },
      Date.now(),
    );
    const activationPlan = plan(randomUUID(), actor, bindings.get(actor.accountId)!, Date.now());
    activationPlan.draft.operation = 'activate_smart_account_session';
    activationPlan.draft.summary = {
      sessionId: created.id,
      compiledHash: created.compiled.compiledHash,
      setup: {},
    };
    await plans.create(
      activationPlan,
      { key: 'owner-activation', operation: 'fixture', requestHash: h('owner-activation') },
      Date.now(),
    );
    const activationOperation = record(activationPlan, 801n);
    await expect(store.create(activationOperation, Date.now())).rejects.toMatchObject({
      code: 'SESSION_LIFECYCLE_PLAN_UNADMITTED',
    });
    expect(await store.get(actor, activationOperation.id)).toBeUndefined();
    const activation = sessionClaim(created);
    activation.approval.planId = activationPlan.id;
    activation.approval.planCommitment = activationPlan.commitment;
    const installing = (await sessions.claimActivation(activation)).record;
    await store.create(activationOperation, Date.now());
    const active = (
      await sessions.observe({
        actor: fixture.actor,
        id: installing.id,
        expectedRevision: installing.revision,
        expectedObservationHash: null,
        observation: sessionObservation(installing),
        now: Date.now(),
      })
    ).record;
    expect(active.state).toBe('active');
    await expect(store.claim(claim(activationOperation, Date.now()))).rejects.toMatchObject({
      code: 'SESSION_LIFECYCLE_PLAN_UNADMITTED',
    });
    await expectUnclaimed({ plan: activationPlan, record: activationOperation });
    const originalBinding = sessionBinding(active);
    const pending = await prepare('session-proof', 810n, fixture.bot, 1, false);
    pending.record.session = originalBinding;
    await store.create(pending.record, Date.now());
    const forged = await prepare('session-generation', 811n, fixture.bot, 1, false);
    forged.record.session = { ...originalBinding, generation: '74' };
    await expect(store.create(forged.record, Date.now())).rejects.toMatchObject({
      code: 'SESSION_OPERATION_BINDING_MISMATCH',
    });
    expect(await store.get(fixture.bot, forged.record.id)).toBeUndefined();
    expect(await transportRows(forged.plan.id)).toEqual([]);

    const now = Date.now();
    const refreshed = (
      await sessions.observe({
        actor: fixture.actor,
        id: active.id,
        expectedRevision: active.revision,
        expectedObservationHash: active.observation!.proofHash,
        observation: sessionObservation(active, now, {
          evidence: {
            chainId: active.compiled.chainId,
            blockNumber: '101',
            blockHash: h('101'),
            timestamp: String(Math.floor(now / 1000)),
            source: 'onchain',
          },
        }),
        now,
      })
    ).record;
    const freshBinding = sessionBinding(refreshed);
    expect(freshBinding.observationHash).not.toBe(originalBinding.observationHash);
    await expect(
      store.claim({
        ...claim(pending.record, now),
        sessionObservationHash: originalBinding.observationHash,
      }),
    ).rejects.toMatchObject({
      code: 'SESSION_EXECUTION_UNAVAILABLE',
    });
    await expectUnclaimed(pending);
    const admittedInput = {
      ...claim(pending.record, Date.now()),
      sessionObservationHash: freshBinding.observationHash,
    };
    const admitted = await store.claim(admittedInput);
    expect(admitted.dispatch).toBe(true);
    expect(admitted.record.session).toEqual(originalBinding);
    expect(admitted.record.submission!.sessionObservationHash).toBe(freshBinding.observationHash);

    const revoked = await prepare('session-revocation', 812n, fixture.bot, 1, false);
    revoked.record.session = freshBinding;
    await store.create(revoked.record, Date.now());
    const revocationPlan = plan(randomUUID(), actor, bindings.get(actor.accountId)!, Date.now());
    revocationPlan.draft.operation = 'revoke_smart_account_session';
    revocationPlan.draft.summary = {
      sessionId: created.id,
      compiledHash: created.compiled.compiledHash,
      setup: {},
    };
    await plans.create(
      revocationPlan,
      { key: 'owner-revocation', operation: 'fixture', requestHash: h('owner-revocation') },
      Date.now(),
    );
    const revocationOperation = record(revocationPlan, 802n);
    await expect(store.create(revocationOperation, Date.now())).rejects.toMatchObject({
      code: 'SESSION_LIFECYCLE_PLAN_UNADMITTED',
    });
    const revocation = sessionClaim(refreshed, Date.now(), 'revocation');
    revocation.approval.planId = revocationPlan.id;
    revocation.approval.planCommitment = revocationPlan.commitment;
    const revoking = (await sessions.claimRevocation(revocation)).record;
    expect(revoking.state).toBe('revoking');
    await store.create(revocationOperation, Date.now());
    expect((await store.claim(claim(revocationOperation, Date.now()))).dispatch).toBe(true);
    await expect(
      store.claim({
        ...claim(revoked.record, Date.now()),
        sessionObservationHash: freshBinding.observationHash,
      }),
    ).rejects.toMatchObject({
      code: 'SESSION_EXECUTION_UNAVAILABLE',
    });
    await expectUnclaimed(revoked);
    expect((await store.claim(admittedInput)).dispatch).toBe(false);
    expect(
      (await store.settle(admitted.record.id, admittedInput.signedCommitment, 'submission_unknown'))
        .state,
    ).toBe('submission_unknown');
  });
  it('rejects changed smart-account state or a plain EOA plan before making reservations', async () => {
    const value = await prepare('binding-changed', 201n);
    await pool.query(
      "UPDATE rest_smart_account_bindings SET document=jsonb_set(document,'{state,stateHash}',to_jsonb($2::text)) WHERE account_id=$1",
      [actor.accountId, h('changed-state')],
    );
    await expect(store.claim(claim(value.record, Date.now()))).rejects.toMatchObject({
      code: 'USER_OPERATION_BINDING_STALE',
    });
    await expectUnclaimed(value);
    await pool.query(
      "UPDATE rest_smart_account_bindings SET document=jsonb_set(document,'{state,stateHash}',to_jsonb($2::text)) WHERE account_id=$1",
      [actor.accountId, bindings.get(actor.accountId)!.state.stateHash],
    );
    const plain = await prepare('plain-eoa', 202n, actor, 1, false);
    await pool.query(
      "UPDATE rest_transaction_plans SET document=document-'smartAccount' WHERE id=$1",
      [plain.plan.id],
    );
    await expect(store.create(plain.record, Date.now())).rejects.toMatchObject({
      code: 'USER_OPERATION_CONFLICT',
    });
    expect(await store.get(actor, plain.record.id)).toBeUndefined();
  });
  it('rechecks approval after a global nonce wait and rolls back transport, nonce, and submission together', async () => {
    const value = await prepare('expiry-nonce', 300n);
    const blocker = await prepare('expiry-blocker', 301n);
    const input = claim(value.record, Date.now());
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // A different record avoids blocking the target's earlier FOR UPDATE through the FK.
      await client.query(
        'INSERT INTO rest_user_operation_nonces(chain_id,sender,nonce,entry_point,operation_hash,signed_commitment,user_operation_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          value.record.chainId,
          safe,
          '300',
          value.record.entryPoint,
          value.record.operationHash,
          input.signedCommitment,
          blocker.record.id,
        ],
      );
      const pid = Number(
        (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid,
      );
      const issuedAt = await dbSeconds(client);
      const expiresAt = issuedAt + 2;
      const pending = store.claim({ ...input, authorization: { issuedAt, expiresAt } }).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      expect(await waitUntilBlocked(client, pid)).toEqual(
        expect.arrayContaining([expect.stringMatching(/^INSERT INTO rest_user_operation_nonces/)]),
      );
      await client.query(
        'SELECT pg_sleep(GREATEST(0,$1::double precision-extract(epoch FROM clock_timestamp())::double precision+0.005))',
        [expiresAt],
      );
      await client.query('ROLLBACK');
      expect(await pending).toMatchObject({ error: { code: 'AUTH_EXPIRED', status: 401 } });
      await expectUnclaimed(value);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
  it('keeps observations revision-safe and recovers pending records without retaining stale proof', async () => {
    const value = await prepare('observe', 400n);
    const input = claim(value.record, Date.now());
    const admitted = await store.claim(input);
    const observation = {
      state: 'confirmed' as const,
      operationHash: value.record.operationHash,
      transactionHash: h('transaction'),
      receipt: {
        transactionHash: h('transaction'),
        blockHash: h('block'),
        blockNumber: '100',
        status: 'success' as const,
        canonical: true,
        confirmations: 2,
        observedAt: Date.now(),
        logs: [],
      },
      semantic: { status: 'verified' as const },
    };
    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        new PostgresUserOperationStore(pool).observe(
          value.record.id,
          admitted.record.revision,
          observation,
        ),
      ),
    );
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const current = (await store.get(actor, value.record.id))!;
    await expect(
      store.observe(value.record.id, current.revision, {
        ...observation,
        transactionHash: h('other'),
      }),
    ).rejects.toMatchObject({ status: 400 });
    const pending = await store.observe(value.record.id, current.revision, {
      state: 'unknown',
      operationHash: value.record.operationHash,
    });
    expect(pending.observation!.receipt).toBeUndefined();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await store.recoverable(2, cursor);
      if (!page.length) break;
      seen.push(...page.map((record) => record.id));
      cursor = recoveryCursor(page.at(-1)!);
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain(value.record.id);
    expect(
      await store.settle(value.record.id, input.signedCommitment, 'submission_unknown'),
    ).toEqual(pending);
  });
});
