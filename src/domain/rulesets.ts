import { z } from 'zod';
import { zeroAddress } from 'viem';
import { NATIVE_TOKEN } from '@bananapus/nana-sdk-core';
import type { JBRulesetConfig, JBTerminalConfig } from '@bananapus/nana-sdk-core/v6';
import { addressSchema, chainIdSchema, projectSchema, uintSchema } from './schemas.js';
import { DomainError } from './errors.js';

/** Wire integers remain decimal strings; only these converters construct ABI integers. */
const uint = (bits: number, max = (1n << BigInt(bits)) - 1n) =>
  uintSchema.pipe(
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
    reservedPercent: rate,
    cashOutTaxRate: rate,
    baseCurrency: uint(32),
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
    scopeCashOutsToLocalBalances: z.boolean(),
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
    percent: percent.refine((value) => BigInt(value) > 0n, 'Split percent must be positive.'),
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
    groupId: uintSchema,
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

export const currencyAmountSchema = z.object({ amount: uint(224), currency: uint(32) }).strict();
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
    token: nonzeroAddress,
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
    weight: uint(112).describe(
      '18-decimal issuance weight. 0 means zero issuance; 1 inherits decayed weight when a prior ruleset exists.',
    ),
    weightCutPercent: percent,
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
    token: nonzeroAddress,
    // JBTerminalStore enforces the narrower range in addition to the uint8 ABI width.
    decimals: uint(8, 36n),
    currency: uint(32).refine(
      (value) => BigInt(value) > 0n,
      'Accounting currency must be nonzero.',
    ),
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
  .superRefine((value, ctx) => {
    const accepted = new Set(
      value.terminalConfigurations.flatMap((terminal) =>
        terminal.accountingContextsToAccept.map((context) =>
          `${terminal.terminal}:${context.token}`.toLowerCase(),
        ),
      ),
    );
    value.rulesetConfigurations.forEach((config, i) =>
      config.fundAccessLimitGroups.forEach((group, j) => {
        if (!accepted.has(`${group.terminal}:${group.token}`.toLowerCase())) {
          ctx.addIssue({
            code: 'custom',
            path: ['rulesetConfigurations', i, 'fundAccessLimitGroups', j],
            message:
              'A launch fund access limit must refer to an explicitly configured terminal/token context.',
          });
        }
      }),
    );
  });

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

export const modelEconomicsSchema = z
  .object({
    rulesetConfiguration: rulesetConfigSchema,
    rulesetRole: z
      .enum(['initial', 'successor'])
      .describe(
        'An initial ruleset has no predecessor; successor weight=1 is an inheritance sentinel.',
      ),
    inheritedWeight: uint(112)
      .optional()
      .describe(
        'Explicit hypothetical already resolved starting weight, required for successor weight=1.',
      ),
    completedCycles: z.number().int().min(0).max(10_000),
    scenarios: z
      .array(
        z
          .object({
            label: z.string().min(1).max(160),
            contributionInBaseCurrency18: uintSchema.describe(
              'Hypothetical contribution denominated in the ruleset base currency, with 18 decimals; no price-feed conversion is assumed.',
            ),
            cashOut: z
              .object({
                surplusAtomic: uintSchema,
                cashOutCount: uintSchema,
                totalSupply: uintSchema,
              })
              .strict()
              .superRefine((value, ctx) => {
                if (BigInt(value.cashOutCount) > BigInt(value.totalSupply))
                  ctx.addIssue({
                    code: 'custom',
                    path: ['cashOutCount'],
                    message: 'Cash-out count must not exceed the hypothetical total supply.',
                  });
              })
              .optional()
              .describe(
                'Independent hypothetical pre-fee cash-out inputs; supply must include pending reserved tokens and is not automatically changed by contribution.',
              ),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.rulesetConfiguration.weight === '1' &&
      value.rulesetRole === 'successor' &&
      value.inheritedWeight === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['inheritedWeight'],
        message:
          'A successor weight of 1 inherits a prior resolved weight; provide that hypothetical weight explicitly.',
      });
    }
    if (
      value.inheritedWeight !== undefined &&
      !(value.rulesetConfiguration.weight === '1' && value.rulesetRole === 'successor')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['inheritedWeight'],
        message: 'Inherited weight applies only to successor configurations with weight=1.',
      });
    }
    if (value.rulesetConfiguration.duration === '0' && value.completedCycles !== 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['completedCycles'],
        message: 'Duration 0 has no automatic cycles. Model a successor separately.',
      });
    }
  });

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

export function modelEconomics(raw: z.input<typeof modelEconomicsSchema>) {
  const value = modelEconomicsSchema.parse(raw);
  const config = value.rulesetConfiguration;
  if (config.metadata.useDataHookForPay || config.metadata.useDataHookForCashOut) {
    throw new DomainError(
      'CUSTOM_HOOK_MODEL_UNSUPPORTED',
      'Enabled data hooks can override issuance or cash-outs; the core-only scenario model cannot represent their economics.',
    );
  }
  const startingWeight =
    config.weight === '1' && value.rulesetRole === 'successor'
      ? BigInt(value.inheritedWeight!)
      : BigInt(config.weight);
  const weight = decayedWeight(
    startingWeight,
    BigInt(config.weightCutPercent),
    value.completedCycles,
  );
  return {
    kind: 'hypothetical-core-economic-scenarios' as const,
    baseCurrency: config.metadata.baseCurrency,
    effectiveWeight: weight.toString(),
    completedCycles: value.completedCycles,
    arithmetic:
      'Exact integer core formulas with contract rounding, within the explicitly stated hypothetical inputs.',
    scenarios: value.scenarios.map((scenario) => {
      const total = (BigInt(scenario.contributionInBaseCurrency18) * weight) / 10n ** 18n;
      if (total >= 1n << 256n)
        throw new DomainError('SCENARIO_OVERFLOW', 'Hypothetical token issuance exceeds uint256.');
      const beneficiary = (total * (10_000n - BigInt(config.metadata.reservedPercent))) / 10_000n;
      return {
        label: scenario.label,
        contributionInBaseCurrency18: scenario.contributionInBaseCurrency18,
        payAllowedByPauseFlag: !config.metadata.pausePay,
        issuance: config.metadata.pausePay
          ? null
          : {
              totalTokenCount: total.toString(),
              beneficiaryTokenCount: beneficiary.toString(),
              pendingReservedTokenCount: (total - beneficiary).toString(),
              decimals: 18,
            },
        cashOut: scenario.cashOut
          ? {
              ...scenario.cashOut,
              reclaimBeforeProtocolFeesAtomic: cashOutCurve(
                BigInt(scenario.cashOut.surplusAtomic),
                BigInt(scenario.cashOut.cashOutCount),
                BigInt(scenario.cashOut.totalSupply),
                BigInt(config.metadata.cashOutTaxRate),
              ).toString(),
            }
          : null,
      };
    }),
    payoutBudgets: config.fundAccessLimitGroups,
    limitations: [
      'This is a deterministic hypothetical calculation, not an RPC simulation, contribution quote, market forecast, or claim of spendable funds.',
      'Contribution inputs are already denominated in base currency at 18 decimals. No token exchange rate, terminal routing, market purchase, fee, or hook result is assumed.',
      'Cash-out inputs are independent of contribution inputs. Supply must include pending reserved tokens and relevant cross-chain supply; surplus is supplied explicitly and is not treasury balance.',
      'Payout limits and surplus allowances are independent per chain, terminal, token, currency, and reset window. Empty fund-access groups mean zero payout limits and zero surplus allowances.',
      'Split routing, fee exemptions, recipient hooks, liquidity availability, transaction gas, ruleset approvals, and timestamp selection require live transaction simulation.',
      'Repeated decay matches core integer math; long-lived on-chain rulesets may require weight-cache maintenance before execution.',
    ],
    sources: [
      'nana-core-v6/src/JBRulesets.sol:deriveWeightFrom',
      'nana-core-v6/src/JBTerminalStore.sol:_computePayFrom',
      'nana-core-v6/src/JBController.sol:_splitTokenCount',
      'nana-core-v6/src/libraries/JBCashOuts.sol:cashOutFrom',
    ],
  };
}
