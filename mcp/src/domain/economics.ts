import { z } from 'zod';
import { uintSchema } from './schemas.js';
import { DomainError } from './errors.js';
import { cashOutCurve, decayedWeight, rulesetConfigSchema, uint } from './rulesets.js';

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
