import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  decodeEventLog,
  decodeFunctionData,
  encodeAbiParameters,
  erc20Abi,
  keccak256,
  parseAbi,
  toFunctionSelector,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import {
  NATIVE_TOKEN,
  jb721TiersHookAbi,
  jb721TiersHookDeployerAbi,
  jb721TiersHookProjectDeployerAbi,
  jbBuybackHookAbi,
  jbBuybackHookRegistryAbi,
  jbControllerAbi,
  jbMultiTerminalAbi,
  jbPermissionsAbi,
  jbProjectsAbi,
  jbRouterTerminalRegistryAbi,
  jbSuckerRegistryAbi,
  revDeployerAbi,
  revLoansAbi,
  revOwnerAbi,
} from '@bananapus/nana-sdk-core';
import { jbSuckerV6Abi, v6Address } from '@bananapus/nana-sdk-core/v6';
import { DomainError, publicError } from '../domain/errors.js';
import { canonicalJson, jsonSafe } from '../domain/json.js';
import {
  addressSchema,
  chainIdSchema,
  hashSchema,
  hexSchema,
  projectSchema,
  uintSchema,
} from '../domain/schemas.js';
import type { BlockEvidence, PlanDraft, PreparedCall, RpcProvider } from '../domain/types.js';

// Fit token + review in MCP result limits, and token + references in the HTTP request limit.
const MAX_TOKEN_BYTES = 192 * 1024;
const MAX_PAYLOAD_BYTES = 128 * 1024;
const MAX_CALLS = 32;
const MAX_GAS = 30_000_000n;
const PREFIX = 'jbplan1';
const PAY_SELECTOR = toFunctionSelector(
  'pay(uint256,address,uint256,address,uint256,string,bytes)',
);
const digest = (value: unknown) =>
  `0x${createHash('sha256').update(canonicalJson(value)).digest('hex')}` as Hex;
const same = (left: unknown, right: unknown) =>
  typeof left === 'string' &&
  typeof right === 'string' &&
  left.toLowerCase() === right.toLowerCase();
const equalData = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
// The SDK's common sucker ABI omits these two V6 receipt events. Exact IJBSucker definitions.
const suckerReceiptAbi = parseAbi([
  'event Claimed(bytes32 beneficiary,address token,uint256 projectTokenCount,uint256 terminalTokenAmount,uint256 index,bytes32 metadata,address caller)',
  'event AccountingDataSynced(uint256 sourceTimestamp,address caller)',
]);
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
  })
  .strict();

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
export interface OutcomeEvidence {
  emitter: Address;
  event: string;
  logIndex: number | null;
  args: unknown;
}
export type OperationReceipt = Pick<
  TransactionReceipt,
  'status' | 'transactionHash' | 'blockHash' | 'blockNumber' | 'logs'
>;
export interface OperationEvidence {
  verified: boolean;
  events: OutcomeEvidence[];
  reason?: string;
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

  async simulate(input: {
    token: string;
    step?: number;
    confirmedTransactions?: TransactionReference[];
  }) {
    const { token, step, confirmedTransactions } = parse(simulateSchema, input);
    const plan = this.inspect(token);
    this.validateReferences(plan, confirmedTransactions);
    const call = plan.draft.calls[step];
    if (!call)
      throw new DomainError('INVALID_PLAN_STEP', 'The requested step is not in this plan.');
    const required = new Set<number>();
    const addDependencies = (index: number) => {
      for (const dependency of plan.draft.calls[index]!.dependsOn) {
        if (!required.has(dependency)) {
          required.add(dependency);
          addDependencies(dependency);
        }
      }
    };
    addDependencies(step);
    const references = new Map(
      confirmedTransactions.map((reference) => [reference.step, reference.hash]),
    );
    const dependencies: StepVerification[] = [];
    for (const dependency of [...required].sort((a, b) => a - b)) {
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
          'Required prior steps must match the signed plan and have at least two canonical block confirmations. No allowance or state overrides are applied.',
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
        dependencies,
        warning:
          'Simulation is a block-specific observation, not an execution guarantee. Your wallet must review the exact signed calls and enforce the plan expiry.',
      };
    } catch (error) {
      return {
        contentHash: plan.contentHash,
        step,
        status: 'unverified' as const,
        dependencies,
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
      if (receipt.status === 'reverted')
        return {
          ...base,
          status: 'reverted',
          evidence,
          confirmations: confirmations.toString(),
          reason: 'The exact transaction reverted; it did not complete the planned operation.',
        };
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
      const outcome = this.operationEvidence(plan, call, receipt);
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
    return this.operationEvidence({ draft: normalized }, normalized.calls[step]!, receipt);
  }

  private operationEvidence(
    plan: Pick<PlanEnvelope, 'draft'>,
    call: PreparedCall,
    receipt: OperationReceipt,
  ): { verified: boolean; events: OutcomeEvidence[]; reason?: string } {
    const events: OutcomeEvidence[] = [];
    const sourceLogs = receipt.logs.filter(
      (log) =>
        !log.removed &&
        same(log.transactionHash, receipt.transactionHash) &&
        same(log.blockHash, receipt.blockHash) &&
        log.blockNumber === receipt.blockNumber &&
        log.logIndex !== null,
    );
    const append = (log: TransactionReceipt['logs'][number], event: string, args: unknown) =>
      events.push({ emitter: log.address, event, logIndex: log.logIndex, args: jsonSafe(args) });
    const unknown = (reason: string) => ({ verified: false, events, reason });
    try {
      // Canonical deployments matter: arbitrary contracts can copy a Juicebox event signature.
      const terminalEmitter = v6Address('JBMultiTerminal', call.chainId);
      const directTerminal = same(call.to, terminalEmitter);
      const router = v6Address('JBRouterTerminal', call.chainId);
      const routerRegistry = v6Address('JBRouterTerminalRegistry', call.chainId);
      if (
        directTerminal ||
        ((same(call.to, router) || same(call.to, routerRegistry)) &&
          same(call.data.slice(0, 10), PAY_SELECTOR))
      ) {
        const decoded = decodeFunctionData({ abi: jbMultiTerminalAbi, data: call.data });
        const args = decoded.args as readonly unknown[];
        const projectId = decoded.functionName === 'cashOutTokensOf' ? args[1] : args[0];
        if (
          !plan.draft.project ||
          plan.draft.project.chainId !== call.chainId ||
          projectId !== BigInt(plan.draft.project.projectId)
        )
          return unknown('The call does not match the signed project identity.');
        const eventName =
          decoded.functionName === 'pay'
            ? 'Pay'
            : decoded.functionName === 'cashOutTokensOf'
              ? 'CashOutTokens'
              : decoded.functionName === 'sendPayoutsOf'
                ? 'SendPayouts'
                : undefined;
        if (!eventName)
          return unknown('Semantic verification is not implemented for this terminal function.');
        let payoutFailed = false;
        for (const log of sourceLogs) {
          if (!same(log.address, terminalEmitter) || log.removed) continue;
          try {
            const event = decodeEventLog({
              abi: jbMultiTerminalAbi,
              data: log.data,
              topics: log.topics,
              strict: true,
            });
            const fields = event.args as unknown as Record<string, unknown>;
            if (fields.projectId !== projectId) continue;
            if (
              eventName === 'SendPayouts' &&
              ['PayoutReverted', 'PayoutTransferReverted'].includes(event.eventName)
            ) {
              payoutFailed = true;
              append(log, event.eventName, fields);
            }
            const callerMatches = directTerminal
              ? same(fields.caller, plan.draft.account)
              : same(fields.caller, router) || same(fields.caller, routerRegistry);
            if (event.eventName !== eventName || !callerMatches) continue;
            // Pay.newlyIssuedTokenCount is newly minted tokens only. The exact successful call
            // enforces minReturnedTokens against the beneficiary's complete balance delta, including hooks.
            if (
              eventName === 'Pay' &&
              (!same(fields.payer, plan.draft.account) || !same(fields.beneficiary, args[3]))
            )
              continue;
            if (
              eventName === 'CashOutTokens' &&
              (!same(fields.holder, args[0]) ||
                !same(fields.beneficiary, args[5]) ||
                fields.cashOutCount !== args[2] ||
                typeof fields.reclaimAmount !== 'bigint' ||
                fields.reclaimAmount < (args[4] as bigint))
            )
              continue;
            append(log, event.eventName, fields);
          } catch {
            /* Unrelated or malformed events are not outcome evidence. */
          }
        }
        if (payoutFailed)
          return unknown(
            'The transaction confirmed, but at least one payout transfer or hook reverted. Inspect the payout events for partial completion.',
          );
        let sellFailed = false;
        if (eventName === 'Pay' || eventName === 'CashOutTokens') {
          for (const log of sourceLogs) {
            if (!same(log.address, v6Address('JBBuybackHook', call.chainId))) continue;
            try {
              const event = decodeEventLog({
                abi: jbBuybackHookAbi,
                data: log.data,
                topics: log.topics,
                strict: true,
              });
              const fields = event.args as unknown as Record<string, unknown>;
              if (fields.projectId !== projectId || !same(fields.caller, terminalEmitter)) continue;
              if (eventName === 'Pay' && ['Swap', 'Mint'].includes(event.eventName))
                append(log, event.eventName, fields);
              if (
                eventName === 'CashOutTokens' &&
                ['CashOutSwap', 'SellSwapReverted'].includes(event.eventName)
              ) {
                append(log, event.eventName, fields);
                if (event.eventName === 'SellSwapReverted') sellFailed = true;
              }
            } catch {
              /* Hook legs are separate observed amounts; never add them to minted amounts blindly. */
            }
          }
        }
        if (sellFailed)
          return unknown(
            'The exact transaction confirmed, but the sell-side swap failed and project tokens were returned. The requested terminal-token cash-out outcome is not verified.',
          );
        if (
          eventName === 'Pay' &&
          plan.draft.operation === '721_pay' &&
          events.some((event) => event.event === 'Pay')
        ) {
          const nft = this.nftPaymentEvidence(plan, sourceLogs, terminalEmitter);
          return { ...nft, events: [...events, ...nft.events] };
        }
        return events.some((event) => event.event === eventName)
          ? { verified: true, events }
          : unknown(
              'The expected canonical project event is absent or does not match the planned beneficiary, holder, or minimum output.',
            );
      }
      if (same(call.to, v6Address('JBController', call.chainId))) {
        const decoded = decodeFunctionData({ abi: jbControllerAbi, data: call.data });
        if (decoded.functionName === 'queueRulesetsOf') {
          const [projectId, , memo] = decoded.args;
          if (
            !plan.draft.project ||
            plan.draft.project.chainId !== call.chainId ||
            projectId !== BigInt(plan.draft.project.projectId)
          )
            return unknown('The queued rulesets do not match the signed project identity.');
          for (const log of sourceLogs) {
            if (!same(log.address, call.to)) continue;
            try {
              const event = decodeEventLog({
                abi: jbControllerAbi,
                data: log.data,
                topics: log.topics,
                strict: true,
              });
              if (
                event.eventName === 'QueueRulesets' &&
                event.args.projectId === projectId &&
                same(event.args.caller, plan.draft.account) &&
                event.args.memo === memo
              )
                append(log, event.eventName, event.args);
            } catch {
              /* Only a canonical queue event proves that rulesets were queued. */
            }
          }
          return events.length
            ? {
                verified: true,
                events,
                reason:
                  'Rulesets were queued. This does not assert approval or activation; inspect their current status and effective dates separately.',
              }
            : unknown(
                'The canonical QueueRulesets event is absent or does not match the project/caller/memo.',
              );
        }
        if (decoded.functionName !== 'launchProjectFor')
          return unknown('Semantic verification is not implemented for this controller function.');
        const [owner, projectUri] = decoded.args;
        const creates = new Set<string>();
        const launches = new Set<string>();
        for (const log of sourceLogs) {
          if (log.removed) continue;
          try {
            if (same(log.address, v6Address('JBProjects', call.chainId))) {
              const event = decodeEventLog({
                abi: jbProjectsAbi,
                eventName: 'Create',
                data: log.data,
                topics: log.topics,
                strict: true,
              });
              if (
                event.eventName !== 'Create' ||
                !same(event.args.owner, owner) ||
                !same(event.args.caller, call.to)
              )
                continue;
              creates.add(event.args.projectId.toString());
              append(log, event.eventName, event.args);
            } else if (same(log.address, call.to)) {
              const event = decodeEventLog({
                abi: jbControllerAbi,
                eventName: 'LaunchProject',
                data: log.data,
                topics: log.topics,
                strict: true,
              });
              if (
                event.eventName !== 'LaunchProject' ||
                !same(event.args.caller, plan.draft.account) ||
                event.args.projectUri !== projectUri
              )
                continue;
              launches.add(event.args.projectId.toString());
              append(log, event.eventName, event.args);
            }
          } catch {
            /* Require both canonical emitter events for the same created ID. */
          }
        }
        return [...creates].some((id) => launches.has(id))
          ? { verified: true, events }
          : unknown(
              'A launch requires matching JBProjects.Create and JBController.LaunchProject logs from canonical deployments, with the requested owner and URI.',
            );
      }
      const extension = this.extensionEvidence(plan, call, sourceLogs);
      if (extension) return extension;
      const approval = decodeFunctionData({ abi: erc20Abi, data: call.data });
      if (approval.functionName === 'approve') {
        for (const log of sourceLogs) {
          if (!same(log.address, call.to) || log.removed) continue;
          try {
            const event = decodeEventLog({
              abi: erc20Abi,
              eventName: 'Approval',
              data: log.data,
              topics: log.topics,
              strict: true,
            });
            if (
              event.eventName === 'Approval' &&
              same(event.args.owner, plan.draft.account) &&
              same(event.args.spender, approval.args[0]) &&
              event.args.value === approval.args[1]
            )
              append(log, event.eventName, event.args);
          } catch {
            /* Tokens without matching Approval logs remain semantically unverified. */
          }
        }
        return events.length > 0
          ? {
              verified: true,
              events,
              reason:
                'The token emitted the exact Approval event. Re-simulate the dependent call against current chain state; this event does not prove a persistent allowance.',
            }
          : unknown(
              'No exact Approval event was found; use the next step’s real-state simulation to check allowance.',
            );
      }
    } catch {
      return unknown(
        'The confirmed transaction uses calldata or a deployment without a supported semantic verifier.',
      );
    }
    return unknown(
      'The direct transaction confirmed, but semantic outcome verification is not implemented for this operation.',
    );
  }

  private extensionEvidence(
    plan: Pick<PlanEnvelope, 'draft'>,
    call: PreparedCall,
    logs: TransactionReceipt['logs'],
  ): { verified: boolean; events: OutcomeEvidence[]; reason?: string } | undefined {
    const events: OutcomeEvidence[] = [];
    const projectMatches = (projectId: unknown) =>
      !!plan.draft.project &&
      plan.draft.project.chainId === call.chainId &&
      projectId === BigInt(plan.draft.project.projectId);
    const matching = (
      abi: Abi,
      eventName: string,
      emitter: Address,
      predicate: (args: Record<string, unknown>) => boolean,
    ): OutcomeEvidence[] => {
      const matches: OutcomeEvidence[] = [];
      for (const log of logs) {
        if (!same(log.address, emitter)) continue;
        try {
          const event = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true });
          const args = event.args as unknown as Record<string, unknown>;
          // `eventName` is only a TypeScript inference hint to viem, never a runtime filter.
          if (event.eventName === eventName && predicate(args))
            matches.push({
              emitter: log.address,
              event: eventName,
              logIndex: log.logIndex,
              args: jsonSafe(args),
            });
        } catch {
          /* No outcome evidence from malformed or unrelated logs. */
        }
      }
      events.push(...matches);
      return matches;
    };
    const done = (verified: boolean, reason?: string) => ({
      verified,
      events,
      reason:
        reason ??
        (verified
          ? undefined
          : 'Canonical operation events are absent or do not exactly match the signed call.'),
    });
    const fromCaller = (args: Record<string, unknown>) => same(args.caller, plan.draft.account);

    if (same(call.to, v6Address('JBPermissions', call.chainId))) {
      const decoded = decodeFunctionData({ abi: jbPermissionsAbi, data: call.data });
      if (decoded.functionName !== 'setPermissionsFor') return done(false);
      const [account, permission] = decoded.args;
      const packed = permission.permissionIds.reduce((bits, id) => bits | (1n << BigInt(id)), 0n);
      return done(
        matching(
          jbPermissionsAbi,
          'OperatorPermissionsSet',
          call.to,
          (args) =>
            fromCaller(args) &&
            same(args.account, account) &&
            same(args.operator, permission.operator) &&
            args.projectId === permission.projectId &&
            equalData(args.permissionIds, permission.permissionIds) &&
            args.packed === packed,
        ).length > 0,
      );
    }
    if (same(call.to, v6Address('REVLoans', call.chainId))) {
      const decoded = decodeFunctionData({ abi: revLoansAbi, data: call.data });
      if (decoded.functionName === 'borrowFrom') {
        const [projectId, token, minimumBorrow, collateral, beneficiary, prepaidFee, holder] =
          decoded.args;
        if (!projectMatches(projectId)) return done(false);
        const borrows = matching(revLoansAbi, 'Borrow', call.to, (args) => {
          const loan = args.loan as Record<string, unknown>;
          return (
            fromCaller(args) &&
            args.revnetId === projectId &&
            same(args.token, token) &&
            args.collateralCount === collateral &&
            same(args.beneficiary, beneficiary) &&
            typeof args.borrowAmount === 'bigint' &&
            args.borrowAmount >= minimumBorrow &&
            loan.collateral === collateral &&
            BigInt(loan.prepaidFeePercent as number) === prepaidFee &&
            same(loan.sourceToken, token)
          );
        });
        const ids = new Set(borrows.map((event) => (event.args as Record<string, unknown>).loanId));
        const ownership = matching(
          revLoansAbi,
          'Transfer',
          call.to,
          (args) =>
            same(args.from, zeroAddress) && same(args.to, holder) && ids.has(String(args.tokenId)),
        );
        return done(borrows.length > 0 && ownership.length > 0);
      }
      if (decoded.functionName === 'repayLoan') {
        const [loanId, maximumRepay, collateralReturned, beneficiary] = decoded.args;
        return done(
          matching(revLoansAbi, 'RepayLoan', call.to, (args) => {
            const loan = args.loan as Record<string, unknown>;
            const paidOff = args.paidOffLoan as Record<string, unknown>;
            // The contract returns all collateral if the remaining debt rounds down to zero.
            const returned =
              args.collateralCountToReturn === collateralReturned ||
              (paidOff.amount === 0n && args.collateralCountToReturn === loan.collateral);
            return (
              fromCaller(args) &&
              args.loanId === loanId &&
              projectMatches(args.revnetId) &&
              returned &&
              same(args.beneficiary, beneficiary) &&
              typeof args.repayBorrowAmount === 'bigint' &&
              args.repayBorrowAmount <= maximumRepay
            );
          }).length > 0,
        );
      }
      return done(false);
    }
    if (same(call.to, v6Address('REVOwner', call.chainId))) {
      const decoded = decodeFunctionData({ abi: revOwnerAbi, data: call.data });
      if (decoded.functionName !== 'autoIssueFor') return done(false);
      const [projectId, stageId, beneficiary] = decoded.args;
      return done(
        projectMatches(projectId) &&
          matching(
            revOwnerAbi,
            'AutoIssue',
            call.to,
            (args) =>
              fromCaller(args) &&
              args.revnetId === projectId &&
              args.stageId === stageId &&
              same(args.beneficiary, beneficiary) &&
              typeof args.count === 'bigint' &&
              args.count > 0n,
          ).length > 0,
      );
    }
    if (same(call.to, v6Address('JB721TiersHookProjectDeployer', call.chainId))) {
      const decoded = decodeFunctionData({
        abi: jb721TiersHookProjectDeployerAbi,
        data: call.data,
      });
      if (decoded.functionName !== 'launchProjectFor') return done(false);
      const [owner, , configuration, controller] = decoded.args;
      if (!same(controller, v6Address('JBController', call.chainId)))
        return done(
          false,
          'Only canonical-controller NFT project launches have a supported verifier.',
        );
      const created = matching(
        jbProjectsAbi,
        'Create',
        v6Address('JBProjects', call.chainId),
        (args) => same(args.owner, call.to) && same(args.caller, call.to),
      );
      const ids = new Set(
        created.map((event) => (event.args as Record<string, unknown>).projectId),
      );
      const hooks = matching(
        jb721TiersHookDeployerAbi,
        'HookDeployed',
        v6Address('JB721TiersHookDeployer', call.chainId),
        (args) =>
          ids.has(String(args.projectId)) &&
          same(args.caller, call.to) &&
          typeof args.hook === 'string' &&
          !same(args.hook, zeroAddress),
      );
      const rulesets = matching(
        jbControllerAbi,
        'LaunchRulesets',
        controller,
        (args) =>
          ids.has(String(args.projectId)) &&
          same(args.caller, call.to) &&
          args.projectUri === configuration.projectUri &&
          args.memo === configuration.memo,
      );
      const ownership = matching(
        jbProjectsAbi,
        'Transfer',
        v6Address('JBProjects', call.chainId),
        (args) => ids.has(String(args.tokenId)) && same(args.from, call.to) && same(args.to, owner),
      );
      const verified =
        created.length === 1 &&
        hooks.length === 1 &&
        rulesets.length === 1 &&
        ownership.length === 1;
      return done(
        verified,
        verified
          ? 'The project and its NFT hook were created on this chain, initial rulesets were launched, and the project NFT was delivered to the requested owner.'
          : 'The canonical project creation, hook association, launched rulesets and requested ownership transfer were not all verified.',
      );
    }
    if (same(call.to, v6Address('REVDeployer', call.chainId))) {
      const decoded = decodeFunctionData({ abi: revDeployerAbi, data: call.data });
      if (decoded.functionName !== 'deployFor' || decoded.args[0] !== 0n)
        return done(
          false,
          'Only new canonical revnet deployment receipts have a supported deployment verifier.',
        );
      const [, configuration, , suckerConfiguration] = decoded.args;
      const deployments = matching(
        revDeployerAbi,
        'DeployRevnet',
        call.to,
        (args) =>
          fromCaller(args) &&
          equalData(args.configuration, configuration) &&
          equalData(args.suckerDeploymentConfiguration, suckerConfiguration),
      );
      const ids = new Set(
        deployments.map((event) => (event.args as Record<string, unknown>).revnetId),
      );
      const created = matching(
        jbProjectsAbi,
        'Create',
        v6Address('JBProjects', call.chainId),
        (args) =>
          ids.has(String(args.projectId)) &&
          same(args.owner, call.to) &&
          same(args.caller, call.to),
      );
      const initialized = matching(
        revOwnerAbi,
        'InitializeRevnet',
        v6Address('REVOwner', call.chainId),
        (args) => ids.has(String(args.revnetId)) && same(args.caller, call.to),
      );
      const ownership = matching(
        jbProjectsAbi,
        'Transfer',
        v6Address('JBProjects', call.chainId),
        (args) =>
          ids.has(String(args.tokenId)) &&
          same(args.from, call.to) &&
          same(args.to, v6Address('REVOwner', call.chainId)),
      );
      const expectedSuckers = suckerConfiguration.deployerConfigurations;
      const suckers = matching(
        jbSuckerRegistryAbi,
        'SuckerDeployedFor',
        v6Address('JBSuckerRegistry', call.chainId),
        (args) =>
          ids.has(String(args.projectId)) &&
          same(args.caller, call.to) &&
          expectedSuckers.some((configuration) => equalData(args.configuration, configuration)),
      );
      const actualConfigurations = suckers
        .map((event) => canonicalJson((event.args as Record<string, unknown>).configuration))
        .sort();
      const expectedConfigurations = expectedSuckers
        .map((configuration) => canonicalJson(jsonSafe(configuration)))
        .sort();
      const verified =
        deployments.length === 1 &&
        created.length === 1 &&
        initialized.length === 1 &&
        ownership.length === 1 &&
        equalData(actualConfigurations, expectedConfigurations);
      return done(
        verified,
        verified
          ? 'The revnet, project ownership, and requested local suckers were created. Peer deployments, transport delivery, and cross-chain connectivity require separate verification.'
          : 'Required revnet creation, ownership, initialization, or requested local sucker-deployment events are missing.',
      );
    }
    if (['bridge_claim', 'sync_accounting'].includes(plan.draft.operation)) {
      // Plan producers prove canonical-registry membership + projectId before sealing a sucker call.
      // Restrict this instance-address verifier to those producer operations and the signed project chain.
      if (!plan.draft.project || plan.draft.project.chainId !== call.chainId) return done(false);
      const decoded = decodeFunctionData({ abi: jbSuckerV6Abi, data: call.data });
      if (plan.draft.operation === 'bridge_claim' && decoded.functionName === 'claim') {
        const [claim] = decoded.args;
        return done(
          matching(
            suckerReceiptAbi,
            'Claimed',
            call.to,
            (args) =>
              fromCaller(args) &&
              same(args.token, claim.token) &&
              same(args.beneficiary, claim.leaf.beneficiary) &&
              args.projectTokenCount === claim.leaf.projectTokenCount &&
              args.terminalTokenAmount === claim.leaf.terminalTokenAmount &&
              args.index === claim.leaf.index &&
              same(args.metadata, claim.leaf.metadata),
          ).length > 0,
        );
      }
      if (
        plan.draft.operation === 'sync_accounting' &&
        decoded.functionName === 'syncAccountingData'
      ) {
        const synced = matching(
          suckerReceiptAbi,
          'AccountingDataSynced',
          call.to,
          (args) =>
            fromCaller(args) &&
            typeof args.sourceTimestamp === 'bigint' &&
            args.sourceTimestamp > 0n,
        );
        return done(
          synced.length > 0,
          synced.length > 0
            ? 'The source sucker sent accounting data. Destination delivery and freshness are not verified by this source receipt.'
            : undefined,
        );
      }
      return done(false);
    }
    const summary = plan.draft.summary as Record<string, unknown> | null;
    if (summary?.operation === '721_adjust_tiers' && same(summary.hook, call.to)) {
      // The producer authenticates this exact Solady clone, immutable implementation, store and project.
      if (!plan.draft.project || !equalData(summary.project, plan.draft.project))
        return done(false);
      const decoded = decodeFunctionData({ abi: jb721TiersHookAbi, data: call.data });
      if (decoded.functionName !== 'adjustTiers') return done(false);
      const [tiers, removals] = decoded.args;
      const added = matching(
        jb721TiersHookAbi,
        'AddTier',
        call.to,
        (args) => fromCaller(args) && tiers.some((tier) => equalData(args.tier, tier)),
      );
      const removed = matching(
        jb721TiersHookAbi,
        'RemoveTier',
        call.to,
        (args) => fromCaller(args) && removals.includes(args.tierId as bigint),
      );
      const actualConfigurations = added
        .map((event) => canonicalJson((event.args as Record<string, unknown>).tier))
        .sort();
      const expectedConfigurations = tiers.map((tier) => canonicalJson(jsonSafe(tier))).sort();
      return done(
        equalData(actualConfigurations, expectedConfigurations) &&
          new Set(removed.map((event) => (event.args as Record<string, unknown>).tierId)).size ===
            removals.length,
      );
    }
    if (same(call.to, v6Address('JBBuybackHookRegistry', call.chainId))) {
      const decoded = decodeFunctionData({ abi: jbBuybackHookRegistryAbi, data: call.data });
      if (decoded.functionName !== 'setHookFor') return done(false);
      const [projectId, hook] = decoded.args;
      return done(
        projectMatches(projectId) &&
          matching(
            jbBuybackHookRegistryAbi,
            'JBBuybackHookRegistry_SetHook',
            call.to,
            (args) => fromCaller(args) && args.projectId === projectId && same(args.hook, hook),
          ).length > 0,
      );
    }
    if (same(call.to, v6Address('JBRouterTerminalRegistry', call.chainId))) {
      const decoded = decodeFunctionData({ abi: jbRouterTerminalRegistryAbi, data: call.data });
      if (decoded.functionName !== 'setTerminalFor') return done(false);
      const [projectId, terminal] = decoded.args;
      return done(
        projectMatches(projectId) &&
          matching(
            jbRouterTerminalRegistryAbi,
            'JBRouterTerminalRegistry_SetTerminal',
            call.to,
            (args) =>
              fromCaller(args) && args.projectId === projectId && same(args.terminal, terminal),
          ).length > 0,
      );
    }
    if (same(call.to, v6Address('JBBuybackHook', call.chainId))) {
      const decoded = decodeFunctionData({ abi: jbBuybackHookAbi, data: call.data });
      if (decoded.functionName === 'setTwapWindowOf') {
        const [projectId, terminalToken, window] = decoded.args;
        const normalized = same(terminalToken, NATIVE_TOKEN) ? zeroAddress : terminalToken;
        return done(
          projectMatches(projectId) &&
            matching(
              jbBuybackHookAbi,
              'TwapWindowChanged',
              call.to,
              (args) =>
                fromCaller(args) &&
                args.projectId === projectId &&
                same(args.terminalToken, normalized) &&
                args.newWindow === window,
            ).length > 0,
        );
      }
      if (decoded.functionName === 'setPoolFor') {
        const projectId = decoded.args[0];
        const window = decoded.args.length === 4 ? decoded.args[2] : decoded.args[3];
        const terminalToken = decoded.args.length === 4 ? decoded.args[3] : decoded.args[4];
        const keySchema = z
          .object({
            currency0: addressSchema,
            currency1: addressSchema,
            fee: z.number().int().min(0).max(16777215),
            tickSpacing: z.number().int().min(-8388608).max(8388607),
            hooks: addressSchema,
          })
          .strict();
        const parsed = keySchema.safeParse(
          decoded.args.length === 4 ? decoded.args[1] : summary?.key,
        );
        if (!parsed.success) return done(false, 'The reviewed pool key is unavailable or invalid.');
        const key = parsed.data;
        const normalized = same(terminalToken, NATIVE_TOKEN) ? zeroAddress : terminalToken;
        if (
          decoded.args.length === 5 &&
          (key.fee !== decoded.args[1] ||
            key.tickSpacing !== decoded.args[2] ||
            (!same(key.currency0, normalized) && !same(key.currency1, normalized)))
        )
          return done(
            false,
            'The reviewed pool key does not match the signed fee, tick spacing, or terminal token.',
          );
        const poolId = keccak256(
          encodeAbiParameters(
            [
              {
                type: 'tuple',
                components: [
                  { name: 'currency0', type: 'address' },
                  { name: 'currency1', type: 'address' },
                  { name: 'fee', type: 'uint24' },
                  { name: 'tickSpacing', type: 'int24' },
                  { name: 'hooks', type: 'address' },
                ],
              },
            ],
            [key],
          ),
        );
        const pools = matching(
          jbBuybackHookAbi,
          'PoolAdded',
          call.to,
          (args) =>
            fromCaller(args) &&
            projectMatches(args.projectId) &&
            args.projectId === projectId &&
            same(args.terminalToken, normalized) &&
            same(args.poolId, poolId),
        );
        // V6 normalizes MAX_TWAP_WINDOW (2 days) to its 30-minute deployment default on pool registration.
        const expectedWindow = window === 172800n ? 1800n : window;
        const windows = matching(
          jbBuybackHookAbi,
          'TwapWindowChanged',
          call.to,
          (args) =>
            fromCaller(args) &&
            args.projectId === projectId &&
            same(args.terminalToken, normalized) &&
            args.newWindow === expectedWindow,
        );
        return done(pools.length > 0 && windows.length > 0);
      }
      return done(false);
    }
    return undefined;
  }

  private nftPaymentEvidence(
    plan: Pick<PlanEnvelope, 'draft'>,
    logs: TransactionReceipt['logs'],
    terminal: Address,
  ) {
    const summary = plan.draft.summary as Record<string, unknown> | null;
    const events: OutcomeEvidence[] = [];
    if (
      !summary ||
      !same(summary.operation, '721_pay') ||
      !plan.draft.project ||
      !equalData(summary.project, plan.draft.project) ||
      typeof summary.hook !== 'string' ||
      !Array.isArray(summary.tierIds)
    )
      return {
        verified: false,
        events,
        reason: 'The signed NFT delivery specification is unavailable.',
      };
    const minted: string[] = [];
    const transferred = new Set<string>();
    const tokenIds = new Set<string>();
    for (const log of logs) {
      if (!same(log.address, summary.hook)) continue;
      try {
        const event = decodeEventLog({
          abi: jb721TiersHookAbi,
          data: log.data,
          topics: log.topics,
          strict: true,
        });
        if (
          event.eventName === 'Mint' &&
          same(event.args.beneficiary, summary.beneficiary) &&
          same(event.args.caller, terminal)
        ) {
          minted.push(event.args.tierId.toString());
          tokenIds.add(event.args.tokenId.toString());
          events.push({
            emitter: log.address,
            event: event.eventName,
            logIndex: log.logIndex,
            args: jsonSafe(event.args),
          });
        }
        if (
          event.eventName === 'Transfer' &&
          same(event.args.from, zeroAddress) &&
          same(event.args.to, summary.beneficiary)
        )
          transferred.add(event.args.tokenId.toString());
      } catch {
        /* Mint + ERC721 Transfer are both required from the authenticated clone. */
      }
    }
    const verified =
      equalData(minted.sort(), summary.tierIds.map(String).sort()) &&
      minted.length === tokenIds.size &&
      [...tokenIds].every((id) => transferred.has(id));
    return {
      verified,
      events,
      ...(verified
        ? {}
        : {
            reason:
              'Payment confirmed, but the expected NFT tier Mint and ownership Transfer events were not all verified for the planned beneficiary.',
          }),
    };
  }
}
