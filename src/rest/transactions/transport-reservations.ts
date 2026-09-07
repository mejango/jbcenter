import type { PoolClient } from 'pg';
import { RestError } from '../core.js';
import { TRANSACTION_STORAGE_LIMITS, assertText, invalid } from './store.js';

export type ReservedTransport = 'direct' | 'relayr';
type Reservation = { transport: ReservedTransport; bindingId: string };
export interface TransportReservation extends Reservation {
  stepIndex: number;
}

function parameters(
  planId: string,
  stepIndexes: readonly number[],
  transport: ReservedTransport,
  bindingId: string,
): number[] {
  assertText(planId);
  assertText(bindingId);
  if (!['direct', 'relayr'].includes(transport)) invalid('Invalid transaction transport.');
  if (transport === 'direct' && !/^0x[0-9a-f]{64}$/.test(bindingId))
    invalid('Direct transaction transport requires the normalized transaction hash.');
  if (
    !Array.isArray(stepIndexes) ||
    stepIndexes.length < 1 ||
    stepIndexes.length > TRANSACTION_STORAGE_LIMITS.maximumSteps ||
    new Set(stepIndexes).size !== stepIndexes.length ||
    stepIndexes.some(
      (index) =>
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= TRANSACTION_STORAGE_LIMITS.maximumSteps,
    )
  )
    invalid('Invalid transaction transport step indexes.');
  return [...stepIndexes].sort((a, b) => a - b);
}

function matches(existing: Reservation, transport: ReservedTransport, bindingId: string): boolean {
  return existing.transport === transport && existing.bindingId === bindingId;
}

function conflict(stepIndex: number): never {
  throw new RestError(
    409,
    'TRANSPORT_CONFLICT',
    'A transaction step is permanently bound to a different transport or submission.',
    { stepIndex },
  );
}

/**
 * Share one instance between direct and sponsored stores. Call under the account mutex,
 * after all other validation/quota checks and before the remaining synchronous writes.
 * Claims never expire or release: another signed transaction could otherwise repeat an action.
 */
export class MemoryTransportReservations {
  private readonly reservations = new Map<string, Map<number, Reservation>>();

  claim(
    planId: string,
    stepIndexes: readonly number[],
    transport: ReservedTransport,
    bindingId: string,
  ): void {
    const indexes = parameters(planId, stepIndexes, transport, bindingId);
    const current = this.reservations.get(planId);
    for (const index of indexes) {
      const existing = current?.get(index);
      if (existing && !matches(existing, transport, bindingId)) conflict(index);
    }
    const reserved = current ?? new Map<number, Reservation>();
    for (const index of indexes) reserved.set(index, { transport, bindingId });
    this.reservations.set(planId, reserved);
  }

  list(planId: string): TransportReservation[] {
    assertText(planId);
    return [...(this.reservations.get(planId)?.entries() ?? [])]
      .map(([stepIndex, reservation]) => ({ stepIndex, ...reservation }))
      .sort((a, b) => a.stepIndex - b.stepIndex);
  }

  assertClaimed(
    planId: string,
    stepIndexes: readonly number[],
    transport: ReservedTransport,
    bindingId: string,
  ): void {
    for (const index of parameters(planId, stepIndexes, transport, bindingId)) {
      const existing = this.reservations.get(planId)?.get(index);
      if (!existing || !matches(existing, transport, bindingId)) conflict(index);
    }
  }
}

/** Read existing, permanent bindings; this grants no new execution authorization. */
export async function getPostgresTransports(
  client: PoolClient,
  planId: string,
): Promise<TransportReservation[]> {
  assertText(planId);
  const result = await client.query<{
    step_index: number;
    transport: ReservedTransport;
    binding_id: string;
  }>(
    'SELECT step_index, transport, binding_id FROM rest_transaction_transports WHERE plan_id = $1 ORDER BY step_index',
    [planId],
  );
  return result.rows.map((row) => ({
    stepIndex: row.step_index,
    transport: row.transport,
    bindingId: row.binding_id,
  }));
}

export async function assertPostgresTransport(
  client: PoolClient,
  planId: string,
  stepIndexes: readonly number[],
  transport: ReservedTransport,
  bindingId: string,
): Promise<void> {
  const indexes = parameters(planId, stepIndexes, transport, bindingId);
  const rows = new Map(
    (await getPostgresTransports(client, planId)).map((row) => [row.stepIndex, row]),
  );
  for (const index of indexes) {
    const row = rows.get(index);
    if (!row || !matches(row, transport, bindingId)) conflict(index);
  }
}

/**
 * The caller owns a PostgreSQL transaction and holds the plan account row lock used by
 * authorization/revocation. This helper neither commits nor releases that transaction.
 * Its savepoint additionally prevents partial multi-step claims if a caller catches a conflict.
 */
export async function claimPostgresTransport(
  client: PoolClient,
  planId: string,
  stepIndexes: readonly number[],
  transport: ReservedTransport,
  bindingId: string,
): Promise<void> {
  const indexes = parameters(planId, stepIndexes, transport, bindingId);
  await client.query('SAVEPOINT rest_transport_reservation');
  try {
    await client.query(
      `INSERT INTO rest_transaction_transports (plan_id, step_index, transport, binding_id)
       SELECT $1, step_index, $3, $4 FROM unnest($2::integer[]) AS requested(step_index)
       ORDER BY step_index
       ON CONFLICT (plan_id, step_index) DO NOTHING`,
      [planId, indexes, transport, bindingId],
    );
    const result = await client.query<{
      step_index: number;
      transport: ReservedTransport;
      binding_id: string;
    }>(
      'SELECT step_index, transport, binding_id FROM rest_transaction_transports WHERE plan_id = $1 AND step_index = ANY($2::integer[]) ORDER BY step_index FOR UPDATE',
      [planId, indexes],
    );
    const rows = new Map(result.rows.map((row) => [row.step_index, row]));
    for (const index of indexes) {
      const row = rows.get(index);
      if (!row || row.transport !== transport || row.binding_id !== bindingId) conflict(index);
    }
    await client.query('RELEASE SAVEPOINT rest_transport_reservation');
  } catch (error) {
    try {
      await client.query('ROLLBACK TO SAVEPOINT rest_transport_reservation');
      await client.query('RELEASE SAVEPOINT rest_transport_reservation');
    } catch {
      /* The outer transaction must roll back on a connection/storage failure. */
    }
    throw error;
  }
}
