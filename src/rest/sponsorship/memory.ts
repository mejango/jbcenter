import type { Hex } from 'viem';
import type { RestActor } from '../core.js';
import { MemoryTransportReservations } from '../transactions/transport-reservations.js';
import { assertActor, assertText, type ActiveActorGuard } from '../transactions/store.js';
import { RELAYR_LIMITS } from './constants.js';
import { forwardNonceConflict, forwardNonceId, forwardNonceKeys } from './nonces.js';
import {
  assertClaim,
  assertNew,
  canRead,
  claimed,
  conflict,
  missing,
  settled,
  type SponsorshipClaim,
  type SponsorshipStore,
} from './store.js';
import type { DestinationObservation, RelayrQuote, SponsorshipRecord } from './types.js';
import { assertKey, clone, fail, same } from './validation.js';

/** Tests/local hosting only. Production uses PostgreSQL with the same atomic boundaries. */
export class MemorySponsorshipStore implements SponsorshipStore {
  private readonly records = new Map<string, SponsorshipRecord>();
  // Permanent across plans, principals and authority-chain account aliases.
  private readonly nonces = new Map<string, string>();
  constructor(
    private readonly authority: ActiveActorGuard,
    private readonly transports: MemoryTransportReservations,
  ) {}
  async find(actor: RestActor, key: string, inputHash: Hex) {
    assertActor(actor);
    assertKey(key);
    const record = [...this.records.values()].find(
      (r) =>
        r.actor.accountId === actor.accountId &&
        r.actor.principalId === actor.principalId &&
        r.preparationKey === key,
    );
    if (record && !same(record.inputHash, inputHash)) conflict();
    return record ? clone(record) : undefined;
  }
  async create(record: SponsorshipRecord, now: number) {
    assertNew(record, now);
    record = clone(record);
    const started = performance.now();
    return this.authority.withActiveActor(
      record.actor,
      ['plan'],
      Math.floor(now / 1000),
      async () => {
        const existing = [...this.records.values()].find(
          (r) =>
            r.actor.accountId === record.actor.accountId &&
            r.actor.principalId === record.actor.principalId &&
            r.preparationKey === record.preparationKey,
        );
        if (existing) {
          if (!same(existing.inputHash, record.inputHash)) conflict();
          return clone(existing);
        }
        if (this.records.has(record.id)) conflict();
        if (
          [...this.records.values()].filter((r) => r.actor.accountId === record.actor.accountId)
            .length >= RELAYR_LIMITS.recordsPerAccount
        )
          fail('SPONSORSHIP_STORAGE_LIMIT', 'Sponsorship record limit reached.', 429);
        assertNew(record, now + Math.floor(performance.now() - started));
        this.records.set(record.id, record);
        return clone(record);
      },
    );
  }
  async get(actor: RestActor, id: string) {
    assertActor(actor);
    assertText(id);
    const record = this.records.get(id);
    return record && canRead(record, actor) ? clone(record) : undefined;
  }
  async claim(input: SponsorshipClaim) {
    assertClaim(input);
    input = clone(input);
    const started = performance.now();
    return this.authority.withActiveActor(
      input.actor,
      ['relay'],
      Math.floor(input.now / 1000),
      async () => {
        const record = this.records.get(input.id) ?? missing();
        if (
          [...this.records.values()].some(
            (r) =>
              r.id !== input.id &&
              r.actor.accountId === input.actor.accountId &&
              r.actor.principalId === input.actor.principalId &&
              r.submission?.key === input.key,
          )
        )
          conflict();
        const result = claimed(record, {
          ...input,
          now: input.now + Math.floor(performance.now() - started),
        });
        // All fallible validation/cloning precedes the permanent, synchronous claim.
        const stored = clone(result.record);
        if (result.dispatch) {
          const nonces = forwardNonceKeys(record.requests).map(forwardNonceId);
          for (const nonce of nonces) {
            const binding = this.nonces.get(nonce);
            if (binding !== undefined && binding !== record.id) forwardNonceConflict();
          }
          // No awaits or fallible work after transport mutation: nonce and step
          // reservations commit together even across different account mutexes.
          this.transports.claim(
            record.planId,
            record.requests.map((r) => r.stepIndex),
            'relayr',
            record.id,
          );
          for (const nonce of nonces) this.nonces.set(nonce, record.id);
        }
        this.records.set(record.id, stored);
        return result;
      },
    );
  }
  async settle(id: string, submissionHash: Hex, quote?: RelayrQuote, runtimeVerified = true) {
    const record = settled(
      this.records.get(id) ?? missing(),
      submissionHash,
      quote,
      runtimeVerified,
    );
    this.records.set(id, record);
    return clone(record);
  }
  async observe(id: string, revision: number, observations: DestinationObservation[]) {
    const record = this.records.get(id) ?? missing();
    if (record.revision !== revision) return clone(record);
    const next = clone({ ...record, revision: revision + 1, observations });
    this.records.set(id, next);
    return clone(next);
  }
}
