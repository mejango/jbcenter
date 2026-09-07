import type { Pool, PoolClient } from 'pg';
import type { Hex } from 'viem';
import { assertRestActorActive } from '../auth/postgres.js';
import type { RestActor } from '../core.js';
import { claimPostgresTransport } from '../transactions/transport-reservations.js';
import { assertActor, assertText } from '../transactions/store.js';
import { RELAYR_LIMITS } from './constants.js';
import { forwardNonceConflict, forwardNonceKeys, type ForwardNonceKey } from './nonces.js';
import {
  assertClaim,
  assertNew,
  claimed,
  conflict,
  missing,
  settled,
  type SponsorshipClaim,
  type SponsorshipStore,
} from './store.js';
import type { DestinationObservation, RelayrQuote, SponsorshipRecord } from './types.js';
import { assertKey, clone, fail, same } from './validation.js';

/** Caller holds its account lock and transaction; claims never expire or release. */
async function claimForwardNonces(
  client: PoolClient,
  keys: readonly ForwardNonceKey[],
  binding: string,
): Promise<void> {
  const parameters = [
    keys.map((key) => String(key.chainId)),
    keys.map((key) => key.forwarder),
    keys.map((key) => key.sender),
    keys.map((key) => key.nonce),
    binding,
  ];
  await client.query(
    `INSERT INTO rest_sponsorship_nonces (chain_id,forwarder,sender,nonce,sponsorship_id)
     SELECT chain_id,forwarder,sender,nonce,$5 FROM unnest($1::bigint[],$2::text[],$3::text[],$4::text[]) AS requested(chain_id,forwarder,sender,nonce)
     ORDER BY chain_id,forwarder COLLATE "C",sender COLLATE "C",nonce COLLATE "C"
     ON CONFLICT (chain_id,forwarder,sender,nonce) DO NOTHING`,
    parameters,
  );
  const reserved = await client.query<{ sponsorship_id: string }>(
    `SELECT reserved.sponsorship_id FROM rest_sponsorship_nonces AS reserved
     JOIN unnest($1::bigint[],$2::text[],$3::text[],$4::text[]) AS requested(chain_id,forwarder,sender,nonce)
     USING (chain_id,forwarder,sender,nonce)
     ORDER BY reserved.chain_id,reserved.forwarder COLLATE "C",reserved.sender COLLATE "C",reserved.nonce COLLATE "C"
     FOR UPDATE OF reserved`,
    parameters.slice(0, 4),
  );
  if (
    reserved.rows.length !== keys.length ||
    reserved.rows.some((row) => row.sponsorship_id !== binding)
  )
    forwardNonceConflict();
}

export class PostgresSponsorshipStore implements SponsorshipStore {
  constructor(private readonly pool: Pool) {}
  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  private async required(client: PoolClient, id: string) {
    assertText(id);
    const result = await client.query<{ document: SponsorshipRecord }>(
      'SELECT document FROM rest_sponsorships WHERE id=$1 FOR UPDATE',
      [id],
    );
    return result.rows[0] ? clone(result.rows[0].document) : missing();
  }
  private async save(client: PoolClient, record: SponsorshipRecord) {
    const copy = clone(record);
    await client.query(
      'UPDATE rest_sponsorships SET document=$2::jsonb,revision=$3,submission_key=$4 WHERE id=$1',
      [copy.id, JSON.stringify(copy), copy.revision, copy.submission?.key ?? null],
    );
    return copy;
  }
  async find(actor: RestActor, key: string, inputHash: Hex) {
    assertActor(actor);
    assertKey(key);
    const result = await this.pool.query<{ document: SponsorshipRecord }>(
      'SELECT document FROM rest_sponsorships WHERE account_id=$1 AND principal_id=$2 AND preparation_key=$3',
      [actor.accountId, actor.principalId, key],
    );
    const record = result.rows[0]?.document;
    if (record && !same(record.inputHash, inputHash)) conflict();
    return record ? clone(record) : undefined;
  }
  async create(record: SponsorshipRecord, now: number) {
    assertNew(record, now);
    record = clone(record);
    return this.transaction(async (client) => {
      await assertRestActorActive(client, record.actor, ['plan'], Math.floor(now / 1000));
      const previous = await client.query<{ document: SponsorshipRecord }>(
        'SELECT document FROM rest_sponsorships WHERE account_id=$1 AND principal_id=$2 AND preparation_key=$3',
        [record.actor.accountId, record.actor.principalId, record.preparationKey],
      );
      if (previous.rows[0]) {
        if (!same(previous.rows[0].document.inputHash, record.inputHash)) conflict();
        return clone(previous.rows[0].document);
      }
      const count = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM rest_sponsorships WHERE account_id=$1',
        [record.actor.accountId],
      );
      if (Number(count.rows[0]!.count) >= RELAYR_LIMITS.recordsPerAccount)
        fail('SPONSORSHIP_STORAGE_LIMIT', 'Sponsorship record limit reached.', 429);
      const clock = await client.query<{ now: string }>(
        'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now',
      );
      assertNew(record, Number(clock.rows[0]!.now));
      await client.query(
        'INSERT INTO rest_sponsorships(id,account_id,principal_id,plan_id,preparation_key,created_at,revision,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
        [
          record.id,
          record.actor.accountId,
          record.actor.principalId,
          record.planId,
          record.preparationKey,
          record.createdAt,
          record.revision,
          JSON.stringify(record),
        ],
      );
      return clone(record);
    });
  }
  async get(actor: RestActor, id: string) {
    assertActor(actor);
    assertText(id);
    const owner = actor.principalId === `owner:${actor.accountId}`;
    const result = await this.pool.query<{ document: SponsorshipRecord }>(
      'SELECT document FROM rest_sponsorships WHERE id=$1 AND account_id=$2 AND ($4::boolean OR principal_id=$3)',
      [id, actor.accountId, actor.principalId, owner],
    );
    return result.rows[0] ? clone(result.rows[0].document) : undefined;
  }
  async claim(input: SponsorshipClaim) {
    assertClaim(input);
    input = clone(input);
    return this.transaction(async (client) => {
      await assertRestActorActive(client, input.actor, ['relay'], Math.floor(input.now / 1000));
      const record = await this.required(client, input.id);
      const duplicate = await client.query(
        'SELECT id FROM rest_sponsorships WHERE account_id=$1 AND principal_id=$2 AND submission_key=$3 AND id<>$4',
        [input.actor.accountId, input.actor.principalId, input.key, input.id],
      );
      if (duplicate.rowCount) conflict();
      const clock = await client.query<{ now: string }>(
        'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now',
      );
      input.now = Number(clock.rows[0]!.now);
      const result = claimed(record, input);
      if (result.dispatch) {
        const nonces = forwardNonceKeys(record.requests);
        await claimPostgresTransport(
          client,
          record.planId,
          record.requests.map((r) => r.stepIndex),
          'relayr',
          record.id,
        );
        await claimForwardNonces(client, nonces, record.id);
        // Locks may have waited. Recheck wall-clock authority and preparation
        // lifetime after every reservation, immediately before publishing the claim.
        await assertRestActorActive(client, input.actor, ['relay'], Math.floor(input.now / 1000));
        const after = await client.query<{ now: string }>(
          'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now',
        );
        input.now = Number(after.rows[0]!.now);
        result.record = claimed(record, input).record;
        result.record = await this.save(client, result.record);
      }
      return result;
    });
  }
  async settle(id: string, submissionHash: Hex, quote?: RelayrQuote, runtimeVerified = true) {
    return this.transaction(async (client) =>
      this.save(
        client,
        settled(await this.required(client, id), submissionHash, quote, runtimeVerified),
      ),
    );
  }
  async observe(id: string, revision: number, observations: DestinationObservation[]) {
    return this.transaction(async (client) => {
      const record = await this.required(client, id);
      if (record.revision !== revision) return record;
      return this.save(client, { ...record, revision: revision + 1, observations });
    });
  }
}
