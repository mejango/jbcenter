import { describe, expect, it } from 'vitest';
import { MemoryAccountStore } from '../src/rest/auth/memory.js';
import { MemoryTransportReservations } from '../src/rest/transactions/transport-reservations.js';
import { MemoryUserOperationStore } from '../src/rest/userOperations/memory.js';
import { assertPlan, fail, recoveryCursor } from '../src/rest/userOperations/store.js';
import type { StoredPlan } from '../src/rest/transactions/types.js';
import {
  account,
  binding,
  claim,
  h,
  owner,
  ownerKey,
  plan,
  record,
  target,
} from './fixtures/user-operations.js';

async function setup() {
  let now = 2_000_000;
  const value = account(now);
  const actor = owner(value);
  const walletBinding = binding(value, now);
  const authority = new MemoryAccountStore();
  await authority.enroll(value, {
    accountId: value.id,
    signer: ownerKey.address,
    grantId: null,
    nonce: h('enroll'),
    issuedAt: now / 1000,
    expiresAt: now / 1000 + 60,
    idempotencyKey: null,
    requiredScopes: [],
    ownerOnly: true,
    now: now / 1000,
  });
  const plans = new Map<string, StoredPlan>();
  let active = true;
  let generation = '1';
  const transports = new MemoryTransportReservations();
  const store = new MemoryUserOperationStore(authority, transports, {
    now: () => now,
    assertBindingAndSession: (record, clock) => {
      if (!active || (record.session && record.session.generation !== generation))
        fail('AUTHORITY_CHANGED', 'Fixture binding/session is no longer current.', 403);
      assertPlan(record, plans.get(record.planId)!, clock * 1000);
    },
  });
  async function prepare(id = 'fixture', nonce = 1n, principal = actor, steps = 1) {
    const original = plan(id, principal, walletBinding, now, steps);
    plans.set(id, original);
    const input = record(original, nonce);
    await store.create(input, now);
    return input;
  }
  return {
    authority,
    actor,
    value,
    walletBinding,
    store,
    transports,
    plans,
    prepare,
    now: () => now,
    tick: (milliseconds: number) => {
      now += milliseconds;
    },
    revoke: () => {
      active = false;
    },
    generation: (next: string) => {
      generation = next;
    },
  };
}

describe('UserOperation memory persistence', () => {
  it('deduplicates preparation and keeps the original immutable body', async () => {
    const s = await setup();
    const original = await s.prepare();
    expect(await s.store.create({ ...original, id: 'different' }, s.now())).toEqual(original);
    await expect(
      s.store.create({ ...original, id: 'different', inputHash: h('changed') }, s.now()),
    ).rejects.toMatchObject({ code: 'USER_OPERATION_CONFLICT' });
    expect(await s.store.find(s.actor, original.preparationKey, original.inputHash)).toEqual(
      original,
    );
  });
  it('admits one competing dispatch and permanently retains ambiguous signed bytes', async () => {
    const s = await setup();
    const original = await s.prepare();
    const input = claim(original, s.now());
    const results = await Promise.all(Array.from({ length: 20 }, () => s.store.claim(input)));
    expect(results.filter((result) => result.dispatch)).toHaveLength(1);
    const unknown = await s.store.settle(original.id, input.signedCommitment, 'submission_unknown');
    s.tick(1_000_000);
    expect(await s.store.claim(input)).toEqual({ record: unknown, dispatch: false });
    expect(unknown.submission!.operation).toEqual(input.operation);
  });
  it('binds signatures even though the EntryPoint hash excludes them', async () => {
    const s = await setup();
    const original = await s.prepare();
    await s.store.claim(claim(original, s.now(), '0x1234'));
    const changedSignature = claim(original, s.now(), '0x5678');
    await expect(s.store.claim(changedSignature)).rejects.toMatchObject({
      code: 'USER_OPERATION_CONFLICT',
    });
    await expect(
      s.store.claim({
        ...changedSignature,
        signedCommitment: claim(original, s.now()).signedCommitment,
      }),
    ).rejects.toMatchObject({ code: 'USER_OPERATION_CONFLICT' });
  });
  it('reserves the complete 256-bit sender nonce across different plans', async () => {
    const s = await setup();
    const nonce = (1n << 200n) + 1n;
    const first = await s.prepare('first', nonce);
    const second = await s.prepare('second', nonce);
    await s.store.claim(claim(first, s.now()));
    await expect(s.store.claim(claim(second, s.now()))).rejects.toMatchObject({
      code: 'USER_OPERATION_NONCE_CONFLICT',
    });
    expect(await s.store.get(s.actor, second.id)).toEqual(second);
    expect(s.transports.list(second.planId)).toEqual([]);
    const next = await s.prepare('next', nonce + 1n);
    expect((await s.store.claim(claim(next, s.now()))).dispatch).toBe(true);
  });
  it('rejects direct and Relayr transport collisions without consuming another nonce', async () => {
    for (const transport of ['direct', 'relayr'] as const) {
      const s = await setup();
      const original = await s.prepare('blocked', 5n, s.actor, 2);
      s.transports.claim(
        original.planId,
        [1],
        transport,
        transport === 'direct' ? h('direct') : 'sponsor',
      );
      await expect(s.store.claim(claim(original, s.now()))).rejects.toMatchObject({
        code: 'TRANSPORT_CONFLICT',
      });
      expect(s.transports.list(original.planId)).toHaveLength(1);
      const alternative = await s.prepare('alternative', 5n);
      expect((await s.store.claim(claim(alternative, s.now()))).dispatch).toBe(true);
    }
  });
  it('blocks expired fresh approval and a revoked current binding without leaving transport state', async () => {
    const s = await setup();
    const original = await s.prepare();
    const input = claim(original, s.now());
    s.tick(61_000);
    await expect(s.store.claim(input)).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
    s.revoke();
    await expect(s.store.claim(claim(original, s.now()))).rejects.toMatchObject({
      code: 'AUTHORITY_CHANGED',
    });
    expect(await s.store.get(s.actor, original.id)).toEqual(original);
    expect(s.transports.list(original.planId)).toEqual([]);
  });
  it('blocks a revoked bot while preserving owner inspection and exact-principal writes', async () => {
    const s = await setup();
    const grantId = 'uo-bot';
    const bot = { accountId: s.actor.accountId, principalId: `bot:${grantId}` };
    await s.authority.registerBot({
      id: grantId,
      accountId: s.value.id,
      botAddress: target,
      scopes: ['read', 'plan', 'relay'],
      label: '',
      createdAt: s.now() / 1000,
      expiresAt: s.now() / 1000 + 1000,
      revokedAt: null,
    });
    const original = await s.prepare('bot-plan', 1n, bot);
    expect(await s.store.get(s.actor, original.id)).toEqual(original);
    await expect(
      s.store.claim({ ...claim(original, s.now()), actor: s.actor }),
    ).rejects.toMatchObject({ status: 404 });
    await s.authority.revokeBot(s.value.id, grantId, s.now() / 1000);
    await expect(s.store.claim(claim(original, s.now()))).rejects.toMatchObject({ status: 403 });
    expect(s.transports.list(original.planId)).toEqual([]);
  });
  it('rejects plain EOA plans before reservation', async () => {
    const s = await setup();
    const original = await s.prepare();
    delete s.plans.get(original.planId)!.smartAccount;
    await expect(s.store.claim(claim(original, s.now()))).rejects.toMatchObject({
      code: 'USER_OPERATION_CONFLICT',
    });
    expect(s.transports.list(original.planId)).toEqual([]);
  });
  it('checks the exact session generation against fresh evidence while preserving prepared identity', async () => {
    const s = await setup();
    const grantId = 'session-bot';
    const bot = { accountId: s.value.id, principalId: `bot:${grantId}` };
    await s.authority.registerBot({
      id: grantId,
      accountId: s.value.id,
      botAddress: target,
      scopes: ['read', 'plan', 'relay'],
      label: '',
      createdAt: s.now() / 1000,
      expiresAt: s.now() / 1000 + 1000,
      revokedAt: null,
    });
    const value = plan('session-plan', bot, s.walletBinding, s.now());
    s.plans.set(value.id, value);
    const original = record(value, 300n);
    original.session = {
      id: 'fixture-session',
      policyHash: h('policy'),
      compiledHash: h('compiled'),
      generation: '1',
      grantId,
      permissionId: h('permission'),
      sessionKey: target,
      observationHash: h('old-observation'),
    };
    await s.store.create(original, s.now());
    const input = { ...claim(original, s.now()), sessionObservationHash: h('fresh-observation') };
    s.generation('2');
    await expect(s.store.claim(input)).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    expect(s.transports.list(value.id)).toEqual([]);
    s.generation('1');
    const admitted = await s.store.claim(input);
    expect(admitted.record.session).toEqual(original.session);
    expect(admitted.record.submission!.sessionObservationHash).toBe(input.sessionObservationHash);
    expect(admitted.record.submission!.operation).toEqual(input.operation);
  });
  it('uses observation CAS and clears stale receipt snapshots for pending/reorg reconciliation', async () => {
    const s = await setup();
    const original = await s.prepare();
    const admitted = await s.store.claim(claim(original, s.now()));
    const observation = {
      state: 'confirmed' as const,
      operationHash: original.operationHash,
      transactionHash: h('transaction'),
      receipt: {
        transactionHash: h('transaction'),
        blockHash: h('block'),
        blockNumber: '100',
        status: 'success' as const,
        canonical: true,
        confirmations: 2,
        observedAt: s.now(),
        logs: [],
      },
      semantic: { status: 'verified' as const },
    };
    const confirmed = await s.store.observe(original.id, admitted.record.revision, observation);
    await expect(
      s.store.observe(original.id, admitted.record.revision, observation),
    ).rejects.toMatchObject({ code: 'USER_OPERATION_CONFLICT' });
    await expect(
      s.store.observe(original.id, confirmed.revision, {
        ...observation,
        transactionHash: h('wrong'),
      }),
    ).rejects.toMatchObject({ status: 400 });
    const pending = await s.store.observe(original.id, confirmed.revision, {
      state: 'unknown',
      operationHash: original.operationHash,
    });
    expect(pending.observation!.receipt).toBeUndefined();
    expect(await s.store.recoverable(1)).toEqual([pending]);
    expect(await s.store.recoverable(1, recoveryCursor(pending))).toEqual([]);
  });
});
