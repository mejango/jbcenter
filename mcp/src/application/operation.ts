import { z } from 'zod';
import type { Services } from '../app.js';
import type { PlanDraft } from '../domain/types.js';
import { normalizePlanDraft } from '../services/plans.js';
import { preparePlan } from './preparation.js';

export type OperationKind = 'read' | 'prepare' | 'reference' | 'metadata-write';
export type OperationSource =
  | 'onchain'
  | 'indexer'
  | 'center'
  | 'reference'
  | 'model'
  | 'plan'
  | 'publication';
export type SelectableOperationSource = 'onchain' | 'indexer';
export interface OperationOptions {
  signal?: AbortSignal;
  source?: SelectableOperationSource;
}
export interface OperationEffects {
  externalMutation: boolean;
  idempotent: boolean;
}
export interface ProtocolOperation {
  readonly id: string;
  readonly description: string;
  readonly kind: OperationKind;
  readonly sources: readonly OperationSource[];
  readonly transaction: boolean;
  readonly inputJsonSchema: Record<string, unknown>;
  readonly schema: z.ZodObject;
  readonly effects: Readonly<OperationEffects>;
  /** Validates input and calls typed services. Transports must provide a request budget. */
  readonly handler: (input: unknown) => Promise<unknown>;
  readonly sourceHandlers?: Readonly<
    Partial<Record<SelectableOperationSource, (input: unknown) => Promise<unknown>>>
  >;
  /** Present only for transaction builders; creates no token and performs no broadcast. */
  readonly prepareDraft?: (input: unknown) => Promise<PlanDraft>;
}

const REFERENCES = new Set([
  'plan_integration',
  'get_webclient_reference',
  'list_webclient_references',
  'search_reference',
  'get_reference',
  'get_contract',
  'decode_calldata',
  'list_references',
  'list_capabilities',
]);
const INDEXED = new Set([
  'get_account',
  'get_activity',
  'get_indexer_status',
  'get_omnichain_group',
]);
const PLANS = new Set(['inspect_plan', 'simulate_plan', 'verify_plan']);

function classification(id: string): { kind: OperationKind; sources: OperationSource[] } {
  if (id === 'pin_project_metadata') return { kind: 'metadata-write', sources: ['publication'] };
  if (REFERENCES.has(id)) return { kind: 'reference', sources: ['reference'] };
  if (id === 'prepare_project_metadata') return { kind: 'prepare', sources: ['model'] };
  if (id === 'get_intent' || id === 'prepare_intent')
    return { kind: id === 'get_intent' ? 'read' : 'prepare', sources: ['center'] };
  if (id === 'search_projects') return { kind: 'read', sources: ['indexer', 'center'] };
  if (id === 'get_project') return { kind: 'read', sources: ['onchain', 'indexer'] };
  if (id === 'resolve_project') return { kind: 'read', sources: ['model', 'indexer'] };
  if (INDEXED.has(id)) return { kind: 'read', sources: ['indexer'] };
  if (PLANS.has(id))
    return { kind: 'read', sources: id === 'inspect_plan' ? ['plan'] : ['plan', 'onchain'] };
  if (id === 'model_economics') return { kind: 'read', sources: ['model'] };
  return { kind: id.startsWith('prepare_') ? 'prepare' : 'read', sources: ['onchain'] };
}

export function operationWithSchema<S extends z.ZodObject>(
  id: string,
  description: string,
  schema: S,
  handler: (input: z.output<S>) => Promise<unknown>,
  effects: OperationEffects = { externalMutation: false, idempotent: true },
  sourceHandlers?: Partial<
    Record<SelectableOperationSource, (input: z.output<S>) => Promise<unknown>>
  >,
): ProtocolOperation {
  let inputJsonSchema: Record<string, unknown> | undefined;
  return Object.freeze({
    id,
    description,
    ...classification(id),
    transaction: false,
    schema,
    get inputJsonSchema() {
      return (inputJsonSchema ??= z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }));
    },
    effects: Object.freeze({ ...effects }),
    handler: async (input: unknown) => handler(schema.parse(input)),
    ...(sourceHandlers
      ? {
          sourceHandlers: Object.freeze(
            Object.fromEntries(
              Object.entries(sourceHandlers).map(([source, run]) => [
                source,
                async (input: unknown) => run(schema.parse(input)),
              ]),
            ),
          ),
        }
      : {}),
  });
}

export function defineOperation<S extends z.ZodRawShape>(
  id: string,
  description: string,
  shape: S,
  handler: (input: z.output<z.ZodObject<S>>) => Promise<unknown>,
  sourceHandlers?: Partial<
    Record<SelectableOperationSource, (input: z.output<z.ZodObject<S>>) => Promise<unknown>>
  >,
): ProtocolOperation {
  return operationWithSchema(
    id,
    description,
    z.object(shape).strict(),
    handler,
    undefined,
    sourceHandlers,
  );
}

export function transactionWithSchema<S extends z.ZodObject>(
  services: Services,
  id: string,
  description: string,
  schema: S,
  build: (input: z.output<S>) => Promise<PlanDraft>,
): ProtocolOperation {
  return Object.freeze({
    ...operationWithSchema(id, description, schema, async (input) =>
      preparePlan(services, await build(input)),
    ),
    transaction: true,
    prepareDraft: async (input: unknown) => normalizePlanDraft(await build(schema.parse(input))),
  });
}

export function defineTransaction<S extends z.ZodRawShape>(
  services: Services,
  id: string,
  description: string,
  shape: S,
  build: (input: z.output<z.ZodObject<S>>) => Promise<PlanDraft>,
): ProtocolOperation {
  return transactionWithSchema(services, id, description, z.object(shape).strict(), build);
}
