import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { MemoryAccountStore } from '../src/rest/auth/memory.js';
import type { RestActor } from '../src/rest/core.js';
import { MemorySponsorshipStore } from '../src/rest/sponsorship/memory.js';
import type { SponsorshipRecord } from '../src/rest/sponsorship/types.js';
import { digest } from '../src/rest/sponsorship/validation.js';
import { MemoryTransportReservations } from '../src/rest/transactions/transport-reservations.js';

const now = 2_000_000;
const sender = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as Address;
const forwarder = '0xbcdefabcdefabcdefabcdefabcdefabcdefabcde' as Address;
const target = '0x3333333333333333333333333333333333333333' as Address;
const upper = (value: Address): Address => `0x${value.slice(2).toUpperCase()}`;

async function setup() {
  const accounts = new MemoryAccountStore();
  const actors: RestActor[] = [];
  for (const chainId of [1, 10]) {
    const id = `eip155:${chainId}:${sender}`;
    await accounts.enroll(
      {
        id,
        ownerAddress: sender,
        authorityChainId: chainId,
        profile: { displayName: '', bio: '', avatarUri: null },
        createdAt: now / 1000,
        updatedAt: now / 1000,
      },
      {
        accountId: id,
        signer: sender,
        grantId: null,
        nonce: digest({ chainId }),
        issuedAt: now / 1000,
        expiresAt: now / 1000 + 60,
        idempotencyKey: null,
        requiredScopes: [],
        ownerOnly: true,
        now: now / 1000,
      },
    );
    actors.push({ accountId: id, principalId: `owner:${id}` });
  }
  const transports = new MemoryTransportReservations();
  const store = new MemorySponsorshipStore(accounts, transports);
  return { store, transports, owner: actors[0]!, alias: actors[1]! };
}

function preparation(id: string, actor: RestActor, nonces = ['0']): SponsorshipRecord {
  return {
    id,
    actor,
    planId: `plan:${id}`,
    preparationKey: `prepare:${id}`,
    planCommitment: digest({ plan: id }),
    inputHash: digest({ id, actor, nonces }),
    commitment: digest({ commitment: id }),
    createdAt: now,
    expiresAt: now + 60_000,
    revision: 0,
    state: 'prepared',
    observations: [],
    requests: nonces.map((nonce, index) => ({
      stepIndex: index,
      chainId: 1,
      forwarder,
      forwarderCodeHash: digest('forwarder'),
      targetCodeHash: digest('target'),
      domain: { name: 'FixtureForwarder', version: '1', chainId: 1, verifyingContract: forwarder },
      message: {
        from: sender,
        to: target,
        value: '0',
        gas: '100000',
        nonce,
        deadline: '2060',
        data: '0x',
      },
      evidence: {
        chainId: 1,
        blockNumber: '1',
        blockHash: digest('block'),
        timestamp: '2000',
        source: 'onchain',
      },
    })),
  };
}

function claim(record: SponsorshipRecord, at = now) {
  return {
    actor: record.actor,
    id: record.id,
    key: `submit:${record.id}`,
    hash: digest({ submission: record.id }),
    now: at,
    entries: record.requests.map((request) => ({
      chain: request.chainId,
      target: request.forwarder,
      data: '0x' as const,
      value: '0',
      virtual_nonce: 0 as const,
    })),
  };
}

describe('Permanent forwarding nonce reservations', () => {
  it('admits one global key across account aliases and address casing under separate account locks', async () => {
    const { store, transports, owner, alias } = await setup();
    const records = [preparation('first', owner), preparation('alias', alias)];
    records[1]!.requests[0]!.forwarder = upper(forwarder);
    records[1]!.requests[0]!.message.from = upper(sender);
    await Promise.all(records.map((record) => store.create(record, now)));
    const results = await Promise.allSettled(records.map((record) => store.claim(claim(record))));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ status: 409, code: 'FORWARD_NONCE_CONFLICT' }),
      }),
    ]);
    const admittedIndex = results.findIndex((result) => result.status === 'fulfilled');
    const winner = records[admittedIndex]!;
    const loser = records[1 - admittedIndex]!;
    expect((await store.claim(claim(winner))).dispatch).toBe(false);
    expect(await store.get(loser.actor, loser.id)).toEqual(loser);
    expect(transports.list(loser.planId)).toEqual([]);
  });

  it('preflights every nonce before mutating transport or nonce maps', async () => {
    const { store, transports, owner } = await setup();
    const source = preparation('reserved', owner, ['1']);
    await store.create(source, now);
    await store.claim(claim(source));
    const competing = preparation('competing', owner, ['0', '1']);
    await store.create(competing, now);
    await expect(store.claim(claim(competing))).rejects.toMatchObject({
      code: 'FORWARD_NONCE_CONFLICT',
    });
    expect(await store.get(owner, competing.id)).toEqual(competing);
    expect(transports.list(competing.planId)).toEqual([]);
    const unconsumed = preparation('unconsumed', owner, ['0']);
    await store.create(unconsumed, now);
    expect((await store.claim(claim(unconsumed))).dispatch).toBe(true);
  });

  it('does not reserve any forwarding nonce when a step transport conflicts', async () => {
    const { store, transports, owner } = await setup();
    const blocked = preparation('direct-step', owner, ['5']);
    await store.create(blocked, now);
    transports.claim(blocked.planId, [0], 'direct', digest('direct transaction'));
    await expect(store.claim(claim(blocked))).rejects.toMatchObject({ code: 'TRANSPORT_CONFLICT' });
    expect(await store.get(owner, blocked.id)).toEqual(blocked);
    const differentPlan = preparation('different-plan', owner, ['5']);
    await store.create(differentPlan, now);
    expect((await store.claim(claim(differentPlan))).dispatch).toBe(true);
  });

  it('retains an ambiguous reservation after expiry and permits the next onchain nonce', async () => {
    const { store, owner } = await setup();
    const source = preparation('ambiguous', owner, ['0']);
    await store.create(source, now);
    await store.claim(claim(source));
    const unknown = await store.settle(source.id, claim(source).hash);
    const later = now + 120_000;
    expect(await store.claim(claim(source, later))).toEqual({ record: unknown, dispatch: false });
    const competing = preparation('expired-competitor', owner, ['0']);
    competing.createdAt = later;
    competing.expiresAt = later + 60_000;
    await store.create(competing, later);
    await expect(store.claim(claim(competing, later))).rejects.toMatchObject({
      code: 'FORWARD_NONCE_CONFLICT',
    });
    const progressed = preparation('progressed', owner, ['1']);
    progressed.createdAt = later;
    progressed.expiresAt = later + 60_000;
    await store.create(progressed, later);
    expect((await store.claim(claim(progressed, later))).dispatch).toBe(true);
  });

  it('keeps chain, forwarder and sender separate in the global key', async () => {
    const { store, owner } = await setup();
    const records = ['original', 'other-chain', 'other-forwarder', 'other-sender'].map((id) =>
      preparation(id, owner),
    );
    records[1]!.requests[0]!.chainId = 10;
    records[2]!.requests[0]!.forwarder = target;
    records[3]!.requests[0]!.message.from = target;
    for (const record of records) {
      await store.create(record, now);
      expect((await store.claim(claim(record))).dispatch).toBe(true);
    }
  });

  it.each(['00', '-1', '1.5', (1n << 256n).toString()])(
    'rejects invalid nonce %s before reserving any step',
    async (nonce) => {
      const { store, transports, owner } = await setup();
      const invalid = preparation('invalid', owner, ['0', nonce]);
      await store.create(invalid, now);
      await expect(store.claim(claim(invalid))).rejects.toMatchObject({
        code: 'INVALID_SPONSORSHIP_INTEGER',
      });
      expect(await store.get(owner, invalid.id)).toEqual(invalid);
      expect(transports.list(invalid.planId)).toEqual([]);
      const valid = preparation('valid', owner);
      await store.create(valid, now);
      expect((await store.claim(claim(valid))).dispatch).toBe(true);
    },
  );

  it('rejects duplicate normalized keys inside one record and accepts the maximum uint256 nonce', async () => {
    const { store, transports, owner } = await setup();
    const duplicate = preparation('duplicate', owner, ['0', '0']);
    duplicate.requests[1]!.forwarder = upper(forwarder);
    duplicate.requests[1]!.message.from = upper(sender);
    await store.create(duplicate, now);
    await expect(store.claim(claim(duplicate))).rejects.toMatchObject({
      code: 'INVALID_SPONSORSHIP_RECORD',
    });
    expect(transports.list(duplicate.planId)).toEqual([]);
    const maximum = preparation('maximum', owner, [((1n << 256n) - 1n).toString()]);
    await store.create(maximum, now);
    expect((await store.claim(claim(maximum))).dispatch).toBe(true);
  });
});
