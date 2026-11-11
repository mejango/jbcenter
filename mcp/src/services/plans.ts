import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  decodeFunctionData,
  decodeFunctionResult,
  getAbiItem,
  numberToHex,
  type AbiFunction,
  type Hex,
} from 'viem';
import {
  verifyV6OperationEvidence,
  type V6OperationEvidence as OperationEvidence,
  type V6OperationReceipt as OperationReceipt,
  type V6OutcomeEvidence as OutcomeEvidence,
} from '@bananapus/nana-sdk-core/v6/operation-evidence';
export type { OperationEvidence, OperationReceipt, OutcomeEvidence };
import {
  DomainError,
  payFailureOf,
  type PayFailureContext,
  publicError,
  publicPayError,
  revertOf,
} from '../domain/errors.js';
import { canonicalJson, jsonSafe } from '../domain/json.js';
import {
  addressSchema,
  chainIdSchema,
  hashSchema,
  hexSchema,
  projectSchema,
  uintSchema,
} from '../domain/schemas.js';
import type {
  BlockEvidence,
  PlanDraft,
  PreparedCall,
  RpcProvider,
  RpcSnapshot,
} from '../domain/types.js';
import { abiAt } from './contracts.js';

// Fit token + review in MCP result limits, and token + references in the HTTP request limit.
const MAX_TOKEN_BYTES = 192 * 1024;
const MAX_PAYLOAD_BYTES = 128 * 1024;
const MAX_CALLS = 32;
const MAX_GAS = 30_000_000n;
const PREFIX = 'jbplan1';
const digest = (value: unknown) =>
  `0x${createHash('sha256').update(canonicalJson(value)).digest('hex')}` as Hex;
const same = (left: unknown, right: unknown) =>
  typeof left === 'string' &&
  typeof right === 'string' &&
  left.toLowerCase() === right.toLowerCase();
/** A simulated call's named return values, when its destination is a known canonical contract. */
function decodedReturn(call: PreparedCall, returnData: Hex) {
  const abi = abiAt(call.chainId, call.to);
  if (!abi || returnData === '0x') return undefined;
  try {
    const { functionName, args } = decodeFunctionData({ abi, data: call.data });
    const item = getAbiItem({ abi, name: functionName, args } as never) as AbiFunction | undefined;
    if (!item?.outputs.length) return undefined;
    const result = decodeFunctionResult({ abi: [item], functionName, data: returnData } as never);
    const values = item.outputs.length === 1 ? [result] : (result as readonly unknown[]);
    return {
      functionName,
      values: Object.fromEntries(
        item.outputs.map((output, i) => [output.name || `output${i}`, jsonSafe(values[i])]),
      ),
    };
  } catch {
    return undefined;
  }
}
const withDecodedReturn = (call: PreparedCall, returnData: Hex) => {
  const decoded = decodedReturn(call, returnData);
  return decoded ? { decodedReturn: decoded } : {};
};
const timestampSchema = z
  .string()
  .datetime({ offset: false })
  .refine((value) => new Date(value).toISOString() === value);

const evidenceSchema = z
  .object({
    chainId: chainIdSchema,
    blockNumber: uintSchema,
    blockHash: hashSchema,
    timestamp: uintSchema,
    source: z.literal('rpc'),
  })
  .strict();
const callSchema = z
  .object({
    chainId: chainIdSchema,
    to: addressSchema,
    data: hexSchema,
    value: uintSchema,
    label: z.string().min(1).max(500),
    decoded: z.object({ functionName: z.string().min(1).max(100), args: z.unknown() }).strict(),
    dependsOn: z
      .array(
        z
          .number()
          .int()
          .min(0)
          .max(MAX_CALLS - 1),
      )
      .max(MAX_CALLS - 1),
  })
  .strict();
const draftSchema = z
  .object({
    operation: z.string().min(1).max(100),
    account: addressSchema,
    project: projectSchema.optional(),
    calls: z.array(callSchema).min(1).max(MAX_CALLS),
    evidence: z.array(evidenceSchema).min(1).max(MAX_CALLS),
    summary: z.unknown(),
    warnings: z.array(z.string().max(4000)).max(64),
  })
  .strict()
  .superRefine((draft, ctx) => {
    draft.calls.forEach((call, index) => {
      if (
        new Set(call.dependsOn).size !== call.dependsOn.length ||
        call.dependsOn.some((dep) => dep >= index)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['calls', index, 'dependsOn'],
          message: 'Dependencies must be unique earlier step indices.',
        });
      }
      if (!draft.evidence.some((evidence) => evidence.chainId === call.chainId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['calls', index, 'chainId'],
          message: 'Every call requires evidence for its chain.',
        });
      }
    });
  });
const envelopeSchema = z
  .object({
    version: z.literal(1),
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    contentHash: hashSchema,
    draft: draftSchema,
  })
  .strict();
const transactionSchema = z
  .object({
    step: z
      .number()
      .int()
      .min(0)
      .max(MAX_CALLS - 1),
    hash: hashSchema,
  })
  .strict();
const verifySchema = z
  .object({
    token: z.string().max(MAX_TOKEN_BYTES),
    transactions: z.array(transactionSchema).max(MAX_CALLS),
    minimumConfirmations: z.number().int().min(1).max(100).default(2),
  })
  .strict();
const simulateSchema = z
  .object({
    token: z.string().max(MAX_TOKEN_BYTES),
    step: z
      .number()
      .int()
      .min(0)
      .max(MAX_CALLS - 1)
      .default(0),
    confirmedTransactions: z.array(transactionSchema).max(MAX_CALLS).default([]),
    chained: z.boolean().default(false),
  })
  .strict();
const chainedCallSchema = z.object({
  status: z.enum(['0x0', '0x1']),
  gasUsed: z.string().regex(/^0x[0-9a-f]+$/i),
  returnData: hexSchema,
  error: z.object({ data: z.unknown().optional() }).passthrough().optional(),
});

export interface PlanEnvelope {
  version: 1;
  issuedAt: string;
  expiresAt: string;
  contentHash: Hex;
  draft: PlanDraft;
}
export interface TransactionReference {
  step: number;
  hash: Hex;
}
export interface StepVerification {
  step: number;
  hash?: Hex;
  status: 'pending' | 'reverted' | 'mismatch' | 'confirmed' | 'unverified';
  transactionConfirmed: boolean;
  outcomeVerified: boolean;
  dependenciesVerified?: boolean;
  reason?: string;
  confirmations?: string;
  transactionIndex?: number;
  evidence?: BlockEvidence;
  outcome?: OutcomeEvidence[];
  error?: ReturnType<typeof publicError>;
}

const paying = (plan: PlanEnvelope) =>
  plan.draft.operation === 'pay' || plan.draft.operation === '721_pay';
/** What the plan's quote summary says about its minimums, for the retry hint. */
const payContext = (plan: PlanEnvelope): PayFailureContext => {
  const top = (plan.draft.summary ?? {}) as Record<string, unknown>;
  // A 721 payment keeps its payment quote beside the NFT one.
  const summary = (
    plan.draft.operation === '721_pay' && top.paymentQuote && typeof top.paymentQuote === 'object'
      ? top.paymentQuote
      : top
  ) as Record<string, unknown>;
  const bps = summary.slippageBps;
  const source = summary.hookMinimumSource;
  return {
    ...(Number.isSafeInteger(bps) && (bps as number) >= 0
      ? { slippageBps: BigInt(bps as number) }
      : {}),
    explicitMinimum: summary.minimumBasis === 'explicit',
    nft: plan.draft.operation === '721_pay',
    ...(source === 'slippageBps' || source === 'caller metadata'
      ? { hookMinimumSource: source }
      : {}),
  };
};

/** Reject non-JSON values, ambiguous objects, and pathological input before canonicalization. */
function boundedJson(value: unknown, depth = 0, budget = { nodes: 0 }): void {
  if (++budget.nodes > 50_000 || depth > 24)
    throw new DomainError('INVALID_PLAN', 'Plan JSON exceeds structural limits.');
  if (typeof value === 'string' && value.length > MAX_PAYLOAD_BYTES)
    throw new DomainError('INVALID_PLAN', 'Plan string exceeds the maximum payload size.');
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    typeof value === 'bigint'
  )
    return;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return;
  if (Array.isArray(value)) {
    value.forEach((item) => boundedJson(item, depth + 1, budget));
    return;
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key))
        throw new DomainError('INVALID_PLAN', 'Unsafe JSON object key.');
      if (item !== undefined) boundedJson(item, depth + 1, budget);
    }
    return;
  }
  throw new DomainError(
    'INVALID_PLAN',
    'Plan must contain bounded JSON values and exact integers.',
  );
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new DomainError('INVALID_PLAN', 'Plan input failed validation.', {
      details: result.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    });
  return result.data;
}
function missing(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    if (['TransactionNotFoundError', 'TransactionReceiptNotFoundError'].includes(current.name))
      return true;
    current = current.cause;
  }
  return false;
}

/** Shared validation for immutable unsigned plans, independent of any transport or token issuer. */
export function normalizePlanDraft(draft: PlanDraft): PlanDraft {
  boundedJson(draft);
  const normalized = parse(draftSchema, jsonSafe(draft));
  if (Buffer.byteLength(canonicalJson(normalized)) > MAX_PAYLOAD_BYTES)
    throw new DomainError('INVALID_PLAN', 'Plan exceeds the maximum payload size.');
  return freeze(normalized);
}

/** Every step `step` transitively depends on, ascending. */
function requiredSteps(draft: PlanDraft, step: number): number[] {
  const required = new Set<number>();
  const visit = (index: number) => {
    for (const dependency of draft.calls[index]!.dependsOn) {
      if (!required.has(dependency)) {
        required.add(dependency);
        visit(dependency);
      }
    }
  };
  visit(step);
  return [...required].sort((a, b) => a - b);
}

/** Stateless, authenticated transaction plans. This service never signs or broadcasts transactions. */
export class PlanService {
  private readonly rpc: RpcProvider;
  private readonly secret: Buffer;
  private readonly ttlSeconds: number;
  private readonly now: () => number;

  constructor({
    rpc,
    secret,
    ttlSeconds = 900,
    now = Date.now,
  }: {
    rpc: RpcProvider;
    secret: string;
    ttlSeconds?: number;
    now?: () => number;
  }) {
    if (Buffer.byteLength(secret, 'utf8') < 32)
      throw new DomainError(
        'INVALID_CONFIG',
        'The plan authentication secret must contain at least 32 bytes.',
      );
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86_400)
      throw new DomainError('INVALID_CONFIG', 'Plan TTL must be 1–86400 seconds.');
    this.rpc = rpc;
    this.secret = Buffer.from(secret, 'utf8');
    this.ttlSeconds = ttlSeconds;
    this.now = now;
  }

  seal(draft: PlanDraft) {
    const normalized = normalizePlanDraft(draft);
    const issuedAt = new Date(this.now()).toISOString();
    const envelope: PlanEnvelope = {
      version: 1,
      issuedAt,
      expiresAt: new Date(Date.parse(issuedAt) + this.ttlSeconds * 1000).toISOString(),
      contentHash: digest(normalized),
      draft: normalized,
    };
    const payload = canonicalJson(envelope);
    if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES)
      throw new DomainError('INVALID_PLAN', 'Plan exceeds the maximum payload size.');
    const encoded = Buffer.from(payload).toString('base64url');
    const signature = this.sign(encoded).toString('base64url');
    return freeze({
      token: `${PREFIX}.${encoded}.${signature}`,
      review: normalized,
      contentHash: envelope.contentHash,
      expiresAt: envelope.expiresAt,
    });
  }

  inspect(token: string, { allowExpired = false }: { allowExpired?: boolean } = {}): PlanEnvelope {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_BYTES)
      throw new DomainError('INVALID_PLAN_TOKEN', 'Invalid plan token.');
    const parts = token.split('.');
    const [prefix, encoded, signature] = parts;
    if (
      parts.length !== 3 ||
      prefix !== PREFIX ||
      !encoded ||
      !signature ||
      !/^[A-Za-z0-9_-]+$/.test(encoded) ||
      !/^[A-Za-z0-9_-]{43}$/.test(signature)
    ) {
      throw new DomainError('INVALID_PLAN_TOKEN', 'Invalid plan token.');
    }
    const signatureBytes = Buffer.from(signature, 'base64url');
    if (
      signatureBytes.length !== 32 ||
      signatureBytes.toString('base64url') !== signature ||
      !timingSafeEqual(signatureBytes, this.sign(encoded))
    ) {
      throw new DomainError('INVALID_PLAN_TOKEN', 'Plan signature is invalid.');
    }
    const payload = Buffer.from(encoded, 'base64url');
    if (payload.length > MAX_PAYLOAD_BYTES || payload.toString('base64url') !== encoded)
      throw new DomainError('INVALID_PLAN_TOKEN', 'Invalid plan payload encoding.');
    let raw: unknown;
    try {
      raw = JSON.parse(payload.toString('utf8'));
    } catch {
      throw new DomainError('INVALID_PLAN_TOKEN', 'Plan payload is not valid JSON.');
    }
    boundedJson(raw);
    const envelope = parse(envelopeSchema, raw);
    if (
      canonicalJson(envelope) !== payload.toString('utf8') ||
      envelope.contentHash !== digest(envelope.draft)
    ) {
      throw new DomainError(
        'INVALID_PLAN_TOKEN',
        'Plan content is not canonical or its content hash is invalid.',
      );
    }
    const issuedAt = Date.parse(envelope.issuedAt);
    const expiresAt = Date.parse(envelope.expiresAt);
    if (
      issuedAt > this.now() + 30_000 ||
      expiresAt <= issuedAt ||
      expiresAt - issuedAt > 86_400_000
    )
      throw new DomainError('INVALID_PLAN_TOKEN', 'Plan timestamps are invalid.');
    if (!allowExpired && this.now() >= expiresAt)
      throw new DomainError(
        'PLAN_EXPIRED',
        'The plan expired. Prepare and review a fresh plan before simulating or executing.',
      );
    return freeze(envelope);
  }

  /** jb_inspect_plan: the authenticated envelope, with what authentication proved and what it did not. */
  review(token: string) {
    const plan = this.inspect(token, { allowExpired: true });
    return {
      authentic: true as const,
      expired: this.now() >= Date.parse(plan.expiresAt),
      checks: {
        signature: 'This service issued the token: its HMAC signature matches.',
        contentHash: 'The plan content matches its contentHash and is canonical.',
        timestamps:
          'issuedAt and expiresAt are well formed; expired says whether the plan is past expiresAt.',
      },
      notChecked:
        'Chain state. Authentication does not simulate, and it does not authorize execution. Call jb_simulate_plan before signing.',
      ...plan,
    };
  }

  async simulate(input: {
    token: string;
    step?: number;
    confirmedTransactions?: TransactionReference[];
    chained?: boolean;
  }) {
    const { token, step, confirmedTransactions, chained } = parse(simulateSchema, input);
    const plan = this.inspect(token);
    this.validateReferences(plan, confirmedTransactions);
    const call = plan.draft.calls[step];
    if (!call)
      throw new DomainError('INVALID_PLAN_STEP', 'The requested step is not in this plan.');
    let fallback: { chained: { available: false; reason: string } } | undefined;
    if (chained) {
      if (confirmedTransactions.length)
        throw new DomainError(
          'INVALID_PLAN_TRANSACTIONS',
          'Chained mode is for unconfirmed steps. Omit confirmedTransactions, or drop chained once steps confirm.',
        );
      const result = await this.simulateChained(token, plan, step);
      if (result.status) return { contentHash: plan.contentHash, step, ...result };
      fallback = { chained: { available: false, reason: result.reason } };
    }
    const required = requiredSteps(plan.draft, step);
    const references = new Map(
      confirmedTransactions.map((reference) => [reference.step, reference.hash]),
    );
    const dependencies: StepVerification[] = [];
    for (const dependency of required) {
      const hash = references.get(dependency);
      dependencies.push(
        hash
          ? await this.verifyStep(plan, dependency, hash, 2)
          : this.pending(dependency, 'A required prior step has no transaction hash.'),
      );
    }
    this.applyDependencyOrdering(plan, dependencies);
    if (
      dependencies.some(
        (dependency) =>
          !dependency.transactionConfirmed || dependency.dependenciesVerified === false,
      )
    ) {
      return {
        contentHash: plan.contentHash,
        step,
        status: 'blocked' as const,
        dependencies,
        reason:
          'Required prior steps must match the signed plan and have at least two canonical block confirmations. No allowance or state overrides are applied. To check this step before signing earlier steps, call again with chained: true.',
        ...fallback,
      };
    }
    try {
      // Use one block for both calls. Re-simulation sees real allowance/state after confirmed dependencies.
      const snapshot = await this.rpc.snapshot(call.chainId);
      if (
        snapshot.evidence.chainId !== call.chainId ||
        (await snapshot.client.getChainId()) !== call.chainId
      )
        throw new DomainError('RPC_CHAIN_MISMATCH', 'RPC chain does not match the signed plan.');
      const parameters = {
        account: plan.draft.account,
        to: call.to,
        data: call.data,
        value: BigInt(call.value),
        gas: MAX_GAS,
        blockNumber: BigInt(snapshot.evidence.blockNumber),
      };
      const result = await snapshot.client.call(parameters);
      const gasEstimate = await snapshot.client.estimateGas(parameters);
      const canonical = await snapshot.client.getBlock({ blockNumber: parameters.blockNumber });
      if (!same(canonical.hash, snapshot.evidence.blockHash))
        throw new DomainError(
          'CHAIN_REORG',
          'The simulation block changed. Retry the simulation.',
          { retryable: true },
        );
      // Dependencies may have disappeared during an RPC read or a reorg. Validate against the simulation's canonical history again.
      for (const dependency of dependencies) {
        if (
          dependency.evidence?.chainId === call.chainId &&
          BigInt(dependency.evidence.blockNumber) > parameters.blockNumber
        )
          throw new DomainError(
            'STALE_RPC',
            'The simulation snapshot predates a required transaction.',
            { retryable: true },
          );
        const evidence = dependency.evidence!;
        const block = await this.rpc
          .client(evidence.chainId)
          .getBlock({ blockNumber: BigInt(evidence.blockNumber) });
        if (!same(block.hash, evidence.blockHash))
          throw new DomainError('CHAIN_REORG', 'A dependency block changed. Retry verification.', {
            retryable: true,
          });
      }
      if (gasEstimate > MAX_GAS)
        throw new DomainError(
          'GAS_LIMIT_EXCEEDED',
          'Estimated gas exceeds this service’s simulation limit.',
        );
      this.inspect(token); // Do not return a valid simulation after a plan expired during RPC calls.
      return {
        contentHash: plan.contentHash,
        step,
        status: 'simulated' as const,
        evidence: snapshot.evidence,
        gasEstimate: gasEstimate.toString(),
        returnData: result.data ?? '0x',
        ...withDecodedReturn(call, result.data ?? '0x'),
        dependencies,
        warning:
          'Simulation is a block-specific observation, not an execution guarantee. Your wallet must review the exact signed calls and enforce the plan expiry.',
        ...fallback,
      };
    } catch (error) {
      return {
        contentHash: plan.contentHash,
        step,
        status: 'unverified' as const,
        dependencies,
        error: paying(plan) ? publicPayError(error, payContext(plan)) : publicError(error),
        ...fallback,
      };
    }
  }

  /**
   * Run this chain's steps 0..step in order in one simulated block on real state, from the plan
   * account, with no overrides. Earlier steps are unconfirmed, so nothing here is `simulated`.
   * Returns a bare reason when chaining is unavailable and the caller should fall back.
   */
  private async simulateChained(token: string, plan: PlanEnvelope, step: number) {
    const target = plan.draft.calls[step]!;
    const indexes = plan.draft.calls
      .map((call, index) => (index <= step && call.chainId === target.chainId ? index : -1))
      .filter((index) => index >= 0);
    if (
      requiredSteps(plan.draft, step).some(
        (index) => plan.draft.calls[index]!.chainId !== target.chainId,
      )
    )
      return {
        status: undefined,
        reason: 'A required step is on another chain; it cannot be chained.',
      };
    if (indexes.length > 16)
      return {
        status: undefined,
        reason: 'More than 16 steps on this chain; chaining is limited to 16.',
      };
    let snapshot: RpcSnapshot;
    let raw: unknown;
    try {
      snapshot = await this.rpc.snapshot(target.chainId);
      if (
        snapshot.evidence.chainId !== target.chainId ||
        (await snapshot.client.getChainId()) !== target.chainId
      )
        throw new DomainError('RPC_CHAIN_MISMATCH', 'RPC chain does not match the signed plan.');
    } catch (error) {
      return { status: 'unverified' as const, error: publicError(error) };
    }
    try {
      raw = await snapshot.client.request({
        method: 'eth_simulateV1',
        params: [
          {
            blockStateCalls: [
              {
                calls: indexes.map((index) => {
                  const call = plan.draft.calls[index]!;
                  return {
                    from: plan.draft.account,
                    to: call.to,
                    data: call.data,
                    value: numberToHex(BigInt(call.value)),
                  };
                }),
              },
            ],
            validation: false,
          },
          'latest',
        ],
      } as never);
    } catch (error) {
      return {
        status: undefined,
        reason: `The RPC does not support or rejected eth_simulateV1 (${publicError(error).code}). Showing the standard simulation.`,
      };
    }
    try {
      const block = Array.isArray(raw) && raw.length === 1 ? (raw[0] as { calls?: unknown }) : {};
      const results = z.array(chainedCallSchema).length(indexes.length).safeParse(block.calls);
      if (!results.success)
        throw new DomainError(
          'RPC_INVALID_RESPONSE',
          'The RPC returned an invalid eth_simulateV1 response.',
        );
      const canonical = await snapshot.client.getBlock({
        blockNumber: BigInt(snapshot.evidence.blockNumber),
      });
      if (!same(canonical.hash, snapshot.evidence.blockHash))
        throw new DomainError(
          'CHAIN_REORG',
          'The simulation block changed. Retry the simulation.',
          { retryable: true },
        );
      this.inspect(token); // Do not return a valid simulation after a plan expired during RPC calls.
      const steps = results.data.map((result, position) => {
        const gasUsed = BigInt(result.gasUsed);
        const reverted = result.status === '0x0';
        const revert = { code: 3, data: result.error?.data };
        const payFailure =
          reverted && paying(plan) ? payFailureOf(revert, payContext(plan)) : undefined;
        const error = reverted
          ? {
              ...publicError(
                revertOf(revert)
                  ? revert
                  : new DomainError('CALL_REVERTED', 'This step reverts at this block.'),
              ),
              ...(payFailure ? { payFailure } : {}),
            }
          : gasUsed > MAX_GAS
            ? publicError(
                new DomainError(
                  'GAS_LIMIT_EXCEEDED',
                  'Gas used exceeds this service’s simulation limit.',
                ),
              )
            : undefined;
        return {
          step: indexes[position]!,
          status: reverted
            ? ('reverted' as const)
            : error
              ? ('unverified' as const)
              : ('chained-simulated' as const),
          gasUsed: gasUsed.toString(),
          returnData: result.returnData,
          ...(reverted
            ? {}
            : withDecodedReturn(plan.draft.calls[indexes[position]!]!, result.returnData)),
          ...(error ? { error } : {}),
        };
      });
      const failed = steps.find((item) => item.error);
      return {
        status: failed ? ('unverified' as const) : ('chained-simulated' as const),
        evidence: snapshot.evidence,
        steps,
        ...(failed ? { error: { ...failed.error!, step: failed.step } } : {}),
        warning:
          'Earlier steps ran unconfirmed in the same simulated block. Sign in order; gasUsed is not a gas limit. This is a block-specific observation, not an execution guarantee.',
      };
    } catch (error) {
      return {
        status: 'unverified' as const,
        evidence: snapshot.evidence,
        error: publicError(error),
      };
    }
  }

  async verify(input: {
    token: string;
    transactions: TransactionReference[];
    minimumConfirmations?: number;
  }) {
    const { token, transactions, minimumConfirmations } = parse(verifySchema, input);
    const plan = this.inspect(token, { allowExpired: true });
    this.validateReferences(plan, transactions);
    const references = new Map(transactions.map((reference) => [reference.step, reference.hash]));
    const steps: StepVerification[] = [];
    for (let step = 0; step < plan.draft.calls.length; step++) {
      const hash = references.get(step);
      steps.push(
        hash
          ? await this.verifyStep(plan, step, hash, minimumConfirmations)
          : this.pending(step, 'No transaction hash was provided for this step.'),
      );
    }
    this.applyDependencyOrdering(plan, steps);
    // A complete plan needs every signed call; a successful receipt alone is not operation evidence.
    return {
      contentHash: plan.contentHash,
      expired: this.now() >= Date.parse(plan.expiresAt),
      minimumConfirmations,
      transactionConfirmed: steps.every((step) => step.transactionConfirmed),
      outcomeVerified: steps.every((step) => step.transactionConfirmed && step.outcomeVerified),
      steps,
      finality:
        'Confirmations reflect the currently observed canonical chain. This does not assert economic finality or cross-chain settlement.',
    };
  }

  private applyDependencyOrdering(plan: PlanEnvelope, steps: StepVerification[]): void {
    const byIndex = new Map(steps.map((step) => [step.step, step]));
    for (const step of steps) {
      if (!step.transactionConfirmed) continue;
      step.dependenciesVerified = true;
      const call = plan.draft.calls[step.step]!;
      for (const dependencyIndex of call.dependsOn) {
        const dependency = byIndex.get(dependencyIndex);
        const sameChain = dependency?.evidence?.chainId === step.evidence?.chainId;
        const ordered =
          !!dependency &&
          (!sameChain ||
            BigInt(dependency.evidence!.blockNumber) < BigInt(step.evidence!.blockNumber) ||
            (dependency.evidence!.blockNumber === step.evidence!.blockNumber &&
              dependency.transactionIndex !== undefined &&
              step.transactionIndex !== undefined &&
              dependency.transactionIndex < step.transactionIndex));
        if (
          !dependency?.transactionConfirmed ||
          dependency.dependenciesVerified === false ||
          !ordered
        ) {
          step.dependenciesVerified = false;
          step.outcomeVerified = false;
          step.reason =
            'A required dependency is missing, unconfirmed, or was not mined before this step. Transaction confirmation alone does not complete the planned sequence.';
        }
      }
    }
  }

  private sign(encoded: string): Buffer {
    return createHmac('sha256', this.secret).update(`${PREFIX}.${encoded}`).digest();
  }
  private pending(step: number, reason: string, hash?: Hex): StepVerification {
    return {
      step,
      ...(hash ? { hash } : {}),
      status: 'pending',
      transactionConfirmed: false,
      outcomeVerified: false,
      reason,
    };
  }
  private validateReferences(plan: PlanEnvelope, references: TransactionReference[]): void {
    if (
      references.some((reference) => reference.step >= plan.draft.calls.length) ||
      new Set(references.map((reference) => reference.step)).size !== references.length ||
      new Set(references.map((reference) => reference.hash.toLowerCase())).size !==
        references.length
    ) {
      throw new DomainError(
        'INVALID_PLAN_TRANSACTIONS',
        'Transaction references must use unique plan steps and transaction hashes.',
      );
    }
  }

  private async verifyStep(
    plan: PlanEnvelope,
    step: number,
    hash: Hex,
    minimumConfirmations: number,
  ): Promise<StepVerification> {
    const call = plan.draft.calls[step]!;
    const base = { step, hash, transactionConfirmed: false, outcomeVerified: false };
    try {
      const client = this.rpc.client(call.chainId);
      if ((await client.getChainId()) !== call.chainId)
        return {
          ...base,
          status: 'unverified',
          reason: 'RPC chain does not match the signed plan.',
        };
      const transaction = await client.getTransaction({ hash });
      if (!same(transaction.hash, hash))
        return {
          ...base,
          status: 'mismatch',
          reason: 'RPC transaction hash does not match the requested transaction.',
        };
      if (same(transaction.to, plan.draft.account) && !same(transaction.to, call.to))
        return {
          ...base,
          status: 'unverified',
          reason:
            'Nested wallet execution requires wallet-specific verification. Only direct EOA transactions are supported.',
        };
      if (
        (transaction.chainId !== undefined && transaction.chainId !== call.chainId) ||
        !same(transaction.from, plan.draft.account) ||
        !same(transaction.to, call.to) ||
        !same(transaction.input, call.data) ||
        transaction.value !== BigInt(call.value)
      ) {
        return {
          ...base,
          status: 'mismatch',
          reason:
            'Transaction chain, sender, destination, calldata, or value does not exactly match the signed step.',
        };
      }
      if (transaction.blockNumber === null || transaction.blockHash === null)
        return this.pending(step, 'The matching transaction is not yet mined.', hash);
      const receipt = await client.getTransactionReceipt({ hash });
      if (
        !same(receipt.transactionHash, hash) ||
        !same(receipt.from, plan.draft.account) ||
        !same(receipt.to, call.to)
      )
        return {
          ...base,
          status: 'mismatch',
          reason: 'Receipt does not match the signed transaction.',
        };
      const [canonical, head, code] = await Promise.all([
        client.getBlock({ blockNumber: receipt.blockNumber }),
        client.getBlock({ blockTag: 'latest' }),
        client.getBytecode({ address: plan.draft.account, blockNumber: receipt.blockNumber }),
      ]);
      if (
        !same(canonical.hash, receipt.blockHash) ||
        !same(transaction.blockHash, receipt.blockHash) ||
        transaction.blockNumber !== receipt.blockNumber ||
        head.number === null ||
        head.number < receipt.blockNumber
      ) {
        return {
          ...base,
          status: 'unverified',
          reason:
            'Receipt is not in the currently observed canonical history, or RPC observations disagree. Retry after the chain settles.',
        };
      }
      const evidence: BlockEvidence = {
        chainId: call.chainId,
        blockNumber: receipt.blockNumber.toString(),
        blockHash: receipt.blockHash,
        timestamp: canonical.timestamp.toString(),
        source: 'rpc',
      };
      const preparationBlock = plan.draft.evidence
        .filter((item) => item.chainId === call.chainId)
        .reduce(
          (highest, item) =>
            BigInt(item.blockNumber) > highest ? BigInt(item.blockNumber) : highest,
          -1n,
        );
      if (receipt.blockNumber <= preparationBlock)
        return {
          ...base,
          status: 'mismatch',
          evidence,
          reason:
            'This transaction predates the reviewed plan snapshot. A historical matching transaction is not execution of this plan.',
        };
      const confirmations = head.number - receipt.blockNumber + 1n;
      if (receipt.status === 'reverted') {
        return {
          ...base,
          status: 'reverted',
          evidence,
          confirmations: confirmations.toString(),
          reason: 'The exact transaction reverted; it did not complete the planned operation.',
        };
      }
      if (receipt.status !== 'success')
        return {
          ...base,
          status: 'unverified',
          evidence,
          reason: 'RPC did not return a recognized receipt status.',
        };
      if (code && code !== '0x')
        return {
          ...base,
          status: 'unverified',
          evidence,
          reason:
            'The sender has contract/delegation code. Smart-account and nested execution are outside direct EOA verification.',
        };
      if (confirmations < BigInt(minimumConfirmations))
        return {
          ...base,
          status: 'pending',
          evidence,
          confirmations: confirmations.toString(),
          reason: 'The successful transaction has fewer than the requested confirmations.',
        };
      const outcome = verifyV6OperationEvidence(plan.draft, step, receipt);
      return {
        ...base,
        status: 'confirmed',
        transactionConfirmed: true,
        outcomeVerified: outcome.verified,
        evidence,
        transactionIndex: receipt.transactionIndex,
        confirmations: confirmations.toString(),
        outcome: outcome.events,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
      };
    } catch (error) {
      if (missing(error))
        return this.pending(
          step,
          'Transaction or receipt is not currently available. This does not prove failure or permit resubmission.',
          hash,
        );
      return { ...base, status: 'unverified', error: publicError(error) };
    }
  }

  /** Semantic evidence only. The host must independently verify exact execution and canonicality. */
  verifyOperationEvidence(
    draft: PlanDraft,
    step: number,
    receipt: OperationReceipt,
  ): OperationEvidence {
    const normalized = normalizePlanDraft(draft);
    if (!Number.isSafeInteger(step) || step < 0 || step >= normalized.calls.length)
      throw new DomainError(
        'INVALID_PLAN',
        'The semantic verification step is outside the validated plan.',
      );
    if (receipt.status !== 'success')
      return {
        verified: false,
        events: [],
        reason: 'A reverted or unrecognized receipt cannot establish the planned outcome.',
      };
    return verifyV6OperationEvidence(normalized, step, receipt);
  }
}
