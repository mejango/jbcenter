import { z } from 'zod';
import { zeroAddress, zeroHash } from 'viem';
import { NATIVE_TOKEN } from '@bananapus/nana-sdk-core';
import type { JBRulesetConfig, JBTerminalConfig } from '@bananapus/nana-sdk-core/v6';
import {
  addressSchema,
  chainIdSchema,
  hashSchema,
  projectSchema,
  smallUintSchema,
  uintSchema,
} from './schemas.js';
import { DomainError } from './errors.js';
import { UNITS } from './units.js';

/**
 * Wire integers remain decimal strings; only these converters construct ABI integers.
 * Fields bounded at or below 2^48 - 1 (percents, durations, timestamps, chain IDs, small counts) also take a
 * safe-integer JSON number; wider ones (amounts, weights, prices, IDs) take strings only.
 */
export const uint = (bits: number, max = (1n << BigInt(bits)) - 1n) =>
  (max < 1n << 48n ? smallUintSchema : uintSchema).pipe(
    z.string().refine((value) => BigInt(value) <= max, {
      message: `Must fit uint${bits} and be at most ${max}.`,
      abort: true,
    }),
  );
const nonzeroAddress = addressSchema.refine(
  (value) => value !== zeroAddress,
  'A nonzero address is required.',
);
const percent = uint(32, 1_000_000_000n);
const rate = uint(16, 10_000n);
const maxEntries = 32;

export const rulesetMetadataSchema = z
  .object({
    reservedPercent: rate.describe(UNITS.reservedPercent),
    cashOutTaxRate: rate.describe(UNITS.cashOutTaxRate),
    baseCurrency: uint(32).describe(UNITS.baseCurrency),
    pausePay: z.boolean(),
    pauseCreditTransfers: z.boolean(),
    allowOwnerMinting: z.boolean(),
    allowSetCustomToken: z.boolean(),
    allowTerminalMigration: z.boolean(),
    allowSetTerminals: z.boolean(),
    allowSetController: z.boolean(),
    allowAddAccountingContext: z.boolean(),
    allowAddPriceFeed: z.boolean(),
    ownerMustSendPayouts: z.boolean(),
    holdFees: z.boolean(),
    scopeCashOutsToLocalBalances: z.boolean().describe(UNITS.scopeCashOutsToLocalBalances),
    useDataHookForPay: z.boolean(),
    useDataHookForCashOut: z.boolean(),
    dataHook: addressSchema,
    // The ABI field is uint16, but the resolver preserves only its lower 14 bits.
    metadata: uint(16, 16_383n),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.useDataHookForPay || value.useDataHookForCashOut) &&
      value.dataHook === zeroAddress
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['dataHook'],
        message: 'An enabled data hook requires its explicit nonzero address.',
      });
    }
  });

export const splitSchema = z
  .object({
    percent: percent
      .refine((value) => BigInt(value) > 0n, 'Split percent must be positive.')
      .describe(UNITS.splitPercent),
    projectId: uint(64),
    beneficiary: addressSchema,
    preferAddToBalance: z.boolean(),
    lockedUntil: uint(48),
    hook: addressSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.beneficiary === zeroAddress &&
      (value.hook === zeroAddress || value.projectId !== '0')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['beneficiary'],
        message:
          'Specify the beneficiary: zero lets the transaction caller receive funds or project tokens.',
      });
    }
  });

export const splitGroupSchema = z
  .object({
    groupId: uintSchema.describe(UNITS.groupId),
    splits: z.array(splitSchema).max(maxEntries),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.splits.reduce((total, split) => total + BigInt(split.percent), 0n) > 1_000_000_000n) {
      ctx.addIssue({
        code: 'custom',
        path: ['splits'],
        message: 'The group total must not exceed 1,000,000,000 (100%).',
      });
    }
  });

export const currencyAmountSchema = z
  .object({ amount: uint(224), currency: uint(32).describe(UNITS.currency) })
  .strict();
const currencyAmountsSchema = z
  .array(currencyAmountSchema)
  .max(maxEntries)
  .superRefine((values, ctx) => {
    for (let i = 1; i < values.length; i++) {
      if (BigInt(values[i]!.currency) <= BigInt(values[i - 1]!.currency)) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'currency'],
          message:
            'Currencies must be unique and strictly increasing, as required by JBFundAccessLimits.',
        });
      }
    }
  });

export const fundAccessLimitGroupSchema = z
  .object({
    terminal: nonzeroAddress,
    token: nonzeroAddress.describe(UNITS.token),
    payoutLimits: currencyAmountsSchema,
    surplusAllowances: currencyAmountsSchema,
  })
  .strict();

function duplicates(values: string[], ctx: z.RefinementCtx, path: string, message: string) {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value.toLowerCase()))
      ctx.addIssue({ code: 'custom', path: [path, index], message });
    seen.add(value.toLowerCase());
  });
}

export const rulesetConfigSchema = z
  .object({
    mustStartAtOrAfter: uint(48).describe(
      'Unix seconds. A lower bound, not a promised start; 0 asks the contract to resolve timing.',
    ),
    duration: uint(32).describe('Seconds per cycle. Zero has no automatic cycles.'),
    weight: uint(112).describe(UNITS.weight),
    weightCutPercent: percent.describe(UNITS.weightCutPercent),
    approvalHook: addressSchema.describe('Gates the next ruleset, not this ruleset.'),
    metadata: rulesetMetadataSchema,
    splitGroups: z.array(splitGroupSchema).max(maxEntries),
    fundAccessLimitGroups: z.array(fundAccessLimitGroupSchema).max(maxEntries),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (BigInt(value.mustStartAtOrAfter) + BigInt(value.duration) > (1n << 48n) - 1n) {
      ctx.addIssue({
        code: 'custom',
        path: ['mustStartAtOrAfter'],
        message: 'Start plus duration must fit uint48.',
      });
    }
    duplicates(
      value.splitGroups.map((group) => group.groupId),
      ctx,
      'splitGroups',
      'Split group IDs must be unique.',
    );
    duplicates(
      value.fundAccessLimitGroups.map((group) => `${group.terminal}:${group.token}`),
      ctx,
      'fundAccessLimitGroups',
      'Each terminal/token pair must be unique.',
    );
  });

export const rulesetConfigurationsSchema = z.array(rulesetConfigSchema).min(1).max(16);
export const accountingContextSchema = z
  .object({
    token: nonzeroAddress.describe(UNITS.token),
    // JBTerminalStore enforces the narrower range in addition to the uint8 ABI width.
    decimals: uint(8, 36n).describe(UNITS.decimals),
    currency: uint(32)
      .refine((value) => BigInt(value) > 0n, 'Accounting currency must be nonzero.')
      .describe(UNITS.accountingCurrency),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.token.toLowerCase() === NATIVE_TOKEN.toLowerCase() && value.decimals !== '18') {
      ctx.addIssue({
        code: 'custom',
        path: ['decimals'],
        message: 'The native-token accounting context must use 18 decimals.',
      });
    }
  });
export const terminalConfigSchema = z
  .object({
    terminal: nonzeroAddress,
    accountingContextsToAccept: z.array(accountingContextSchema).max(maxEntries),
  })
  .strict()
  .superRefine((value, ctx) => {
    duplicates(
      value.accountingContextsToAccept.map((context) => context.token),
      ctx,
      'accountingContextsToAccept',
      'A terminal cannot have duplicate token contexts.',
    );
  });
export const terminalConfigurationsSchema = z
  .array(terminalConfigSchema)
  .max(maxEntries)
  .superRefine((values, ctx) => {
    const seen = new Set<string>();
    values.forEach((value, i) => {
      if (seen.has(value.terminal.toLowerCase()))
        ctx.addIssue({
          code: 'custom',
          path: [i, 'terminal'],
          message: 'Terminal addresses must be unique.',
        });
      seen.add(value.terminal.toLowerCase());
    });
  });
export const previewRulesetChangeSchema = z
  .object({
    project: projectSchema,
    account: nonzeroAddress,
    rulesetConfigurations: rulesetConfigurationsSchema,
  })
  .strict();
export const prepareRulesetChangeSchema = previewRulesetChangeSchema.extend({
  memo: z.string().max(4096).optional(),
});
/** Launch fund access limits must name a terminal/token context the launch also accepts. */
export function requireLimitsOnAcceptedContexts(
  value: {
    rulesetConfigurations: readonly {
      fundAccessLimitGroups: readonly { terminal: string; token: string }[];
    }[];
    terminalConfigurations: readonly {
      terminal: string;
      accountingContextsToAccept: readonly { token: string }[];
    }[];
  },
  ctx: z.RefinementCtx,
) {
  const accepted = new Set(
    value.terminalConfigurations.flatMap((terminal) =>
      terminal.accountingContextsToAccept.map((context) =>
        `${terminal.terminal}:${context.token}`.toLowerCase(),
      ),
    ),
  );
  value.rulesetConfigurations.forEach((config, i) =>
    config.fundAccessLimitGroups.forEach((group, j) => {
      if (!accepted.has(`${group.terminal}:${group.token}`.toLowerCase()))
        ctx.addIssue({
          code: 'custom',
          path: ['rulesetConfigurations', i, 'fundAccessLimitGroups', j],
          message:
            'A launch fund access limit must refer to an explicitly configured terminal/token context.',
        });
    }),
  );
}
export const prepareLaunchSchema = z
  .object({
    chainId: chainIdSchema,
    account: nonzeroAddress,
    owner: nonzeroAddress,
    composition: z
      .literal('core')
      .describe(
        'Explicit standard core launch. This does not deploy a 721 hook, revnet, or omnichain identity.',
      ),
    projectUri: z
      .string()
      .max(4096)
      .describe('Metadata URI; content is not fetched or treated as instructions.'),
    rulesetConfigurations: rulesetConfigurationsSchema,
    terminalConfigurations: terminalConfigurationsSchema,
    memo: z.string().max(4096).optional(),
  })
  .strict()
  .superRefine(requireLimitsOnAcceptedContexts);

export const prepareDeployErc20Schema = z
  .object({
    project: projectSchema,
    account: nonzeroAddress.describe('The address that will sign.'),
    name: z.string().min(1).max(256).describe('ERC-20 name, such as "Lattice".'),
    symbol: z.string().min(1).max(64).describe('ERC-20 symbol (ticker), such as "LATT".'),
    salt: hashSchema
      .default(zeroHash)
      .describe(
        'Zero for a one-off address. A nonzero salt gives a deterministic address from this salt and the signer; use the same salt and signer on every chain to get the same token address.',
      ),
  })
  .strict();
export const prepareSetProjectUriSchema = z
  .object({
    project: projectSchema,
    account: nonzeroAddress.describe('The address that will sign.'),
    uri: z
      .string()
      .max(4096)
      .describe(
        'Metadata URI the user already pinned, as ipfs://<cid> (jb_pin_project_metadata returns one). Not fetched.',
      ),
  })
  .strict();

export type RulesetConfigInput = z.output<typeof rulesetConfigSchema>;
export type PreviewRulesetChangeInput = z.output<typeof previewRulesetChangeSchema>;
export type PrepareRulesetChangeInput = z.output<typeof prepareRulesetChangeSchema>;
export type PrepareLaunchInput = z.output<typeof prepareLaunchSchema>;

export function toRulesetConfig(value: RulesetConfigInput): JBRulesetConfig {
  return {
    ...value,
    mustStartAtOrAfter: Number(value.mustStartAtOrAfter),
    duration: Number(value.duration),
    weight: BigInt(value.weight),
    weightCutPercent: Number(value.weightCutPercent),
    metadata: {
      ...value.metadata,
      reservedPercent: Number(value.metadata.reservedPercent),
      cashOutTaxRate: Number(value.metadata.cashOutTaxRate),
      baseCurrency: Number(value.metadata.baseCurrency),
      metadata: Number(value.metadata.metadata),
    },
    splitGroups: value.splitGroups.map((group) => ({
      groupId: BigInt(group.groupId),
      splits: group.splits.map((split) => ({
        ...split,
        percent: Number(split.percent),
        projectId: BigInt(split.projectId),
        lockedUntil: Number(split.lockedUntil),
      })),
    })),
    fundAccessLimitGroups: value.fundAccessLimitGroups.map((group) => ({
      ...group,
      payoutLimits: group.payoutLimits.map((amount) => ({
        amount: BigInt(amount.amount),
        currency: Number(amount.currency),
      })),
      surplusAllowances: group.surplusAllowances.map((amount) => ({
        amount: BigInt(amount.amount),
        currency: Number(amount.currency),
      })),
    })),
  };
}
type Int = number | bigint;
/**
 * A stored ruleset as one rulesetConfigurations entry, the inverse of toRulesetConfig, so an agent can copy it,
 * edit one field and preview. mustStartAtOrAfter is 0: the queue picks the start. Only non-empty split groups and
 * terminal/token pairs with limits are listed, exactly as stored.
 */
export function toRulesetInput(
  ruleset: { duration: Int; weight: Int; weightCutPercent: Int; approvalHook: string },
  metadata: Record<keyof RulesetConfigInput['metadata'], Int | boolean | string>,
  splitGroups: readonly {
    groupId: string;
    splits: readonly {
      percent: Int;
      projectId: Int;
      beneficiary: string;
      preferAddToBalance: boolean;
      lockedUntil: Int;
      hook: string;
    }[];
  }[],
  fundAccessLimitGroups: readonly {
    terminal: string;
    token: string;
    payoutLimits: readonly { amount: Int; currency: Int }[];
    surplusAllowances: readonly { amount: Int; currency: Int }[];
  }[],
): z.input<typeof rulesetConfigSchema> {
  const amounts = (values: readonly { amount: Int; currency: Int }[]) =>
    values.map((value) => ({ amount: String(value.amount), currency: String(value.currency) }));
  return {
    mustStartAtOrAfter: '0',
    duration: String(ruleset.duration),
    weight: String(ruleset.weight),
    weightCutPercent: String(ruleset.weightCutPercent),
    approvalHook: ruleset.approvalHook,
    metadata: Object.fromEntries(
      Object.keys(rulesetMetadataSchema.shape).map((key) => {
        const value = metadata[key as keyof typeof metadata];
        return [
          key,
          typeof value === 'boolean' || typeof value === 'string' ? value : String(value),
        ];
      }),
    ) as z.input<typeof rulesetMetadataSchema>,
    splitGroups: splitGroups
      .filter((group) => group.splits.length > 0)
      .map((group) => ({
        groupId: group.groupId,
        splits: group.splits.map((split) => ({
          percent: String(split.percent),
          projectId: String(split.projectId),
          beneficiary: split.beneficiary,
          preferAddToBalance: split.preferAddToBalance,
          lockedUntil: String(split.lockedUntil),
          hook: split.hook,
        })),
      })),
    fundAccessLimitGroups: fundAccessLimitGroups
      .filter((group) => group.payoutLimits.length + group.surplusAllowances.length > 0)
      .map((group) => ({
        terminal: group.terminal,
        token: group.token,
        payoutLimits: amounts(group.payoutLimits),
        surplusAllowances: amounts(group.surplusAllowances),
      })),
  };
}
export function toTerminalConfig(value: z.output<typeof terminalConfigSchema>): JBTerminalConfig {
  return {
    terminal: value.terminal,
    accountingContextsToAccept: value.accountingContextsToAccept.map((context) => ({
      ...context,
      decimals: Number(context.decimals),
      currency: Number(context.currency),
    })),
  };
}

/** Matches the floor-at-each-cycle core recurrence, rather than a floating-point power. */
export function decayedWeight(
  weight: bigint,
  weightCutPercent: bigint,
  completedCycles: number,
): bigint {
  if (
    weight < 0n ||
    weight >= 1n << 112n ||
    weightCutPercent < 0n ||
    weightCutPercent > 1_000_000_000n ||
    !Number.isInteger(completedCycles) ||
    completedCycles < 0 ||
    completedCycles > 10_000
  ) {
    throw new DomainError('INVALID_SCENARIO', 'Invalid or unbounded decay inputs.');
  }
  for (let i = 0; i < completedCycles && weight > 0n; i++)
    weight = (weight * (1_000_000_000n - weightCutPercent)) / 1_000_000_000n;
  return weight;
}

/** JBCashOuts.cashOutFrom: preserve the contract's two rounding steps and max-tax order. */
export function cashOutCurve(surplus: bigint, count: bigint, supply: bigint, tax: bigint): bigint {
  const max = (1n << 256n) - 1n;
  if (
    [surplus, count, supply].some((value) => value < 0n || value > max) ||
    count > supply ||
    tax < 0n ||
    tax > 10_000n
  )
    throw new DomainError('INVALID_SCENARIO', 'Invalid cash-out curve inputs.');
  if (count === 0n || tax === 10_000n) return 0n;
  if (count === supply) return surplus;
  const base = (surplus * count) / supply;
  return tax === 0n ? base : (base * (10_000n - tax + (tax * count) / supply)) / 10_000n;
}
