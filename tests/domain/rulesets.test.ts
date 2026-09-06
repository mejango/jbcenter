import { describe, expect, it } from 'vitest';
import { zeroAddress } from 'viem';
import { NATIVE_TOKEN } from '@bananapus/nana-sdk-core';
import { buildRulesetMetadata } from '@bananapus/nana-sdk-core/v6';
import {
  accountingContextSchema,
  cashOutCurve,
  decayedWeight,
  modelEconomics,
  prepareLaunchSchema,
  rulesetConfigSchema,
  rulesetConfigurationsSchema,
  splitSchema,
  terminalConfigurationsSchema,
  toRulesetConfig,
} from '../../src/domain/rulesets.js';

const owner = '0x1111111111111111111111111111111111111111';
const terminal = '0x2222222222222222222222222222222222222222';
function configuration() {
  return {
    mustStartAtOrAfter: '0',
    duration: '86400',
    weight: '1000000000000000000000',
    weightCutPercent: '100000000',
    approvalHook: zeroAddress,
    metadata: {
      ...buildRulesetMetadata(),
      reservedPercent: '2500',
      cashOutTaxRate: '5000',
      baseCurrency: '1',
      metadata: '0',
    },
    splitGroups: [],
    fundAccessLimitGroups: [],
  };
}
function split() {
  return {
    percent: '500000000',
    projectId: '0',
    beneficiary: owner,
    preferAddToBalance: false,
    lockedUntil: '0',
    hook: zeroAddress,
  };
}

describe('explicit V6 configuration schemas', () => {
  it('preserves full-width integer strings until ABI conversion and distinguishes zero from inheritance', () => {
    for (const weight of ['0', '1', ((1n << 112n) - 1n).toString()]) {
      const parsed = rulesetConfigSchema.parse({ ...configuration(), weight });
      expect(parsed.weight).toBe(weight);
      expect(toRulesetConfig(parsed).weight).toBe(BigInt(weight));
    }
    expect(
      rulesetConfigSchema.safeParse({ ...configuration(), weight: (1n << 112n).toString() })
        .success,
    ).toBe(false);
    expect(rulesetConfigSchema.safeParse({ ...configuration(), weight: 1000 }).success).toBe(false);
  });

  it.each(['1.2', '-1', '1e18', '00', '', '9'.repeat(10000)])(
    'rejects malformed integer strings without throwing outside Zod',
    (weight) => {
      expect(rulesetConfigSchema.safeParse({ ...configuration(), weight }).success).toBe(false);
    },
  );

  it.each([
    ['duration', (1n << 32n).toString()],
    ['mustStartAtOrAfter', (1n << 48n).toString()],
    ['weightCutPercent', '1000000001'],
  ])('rejects out-of-range %s', (key, value) => {
    expect(rulesetConfigSchema.safeParse({ ...configuration(), [key]: value }).success).toBe(false);
  });

  it('rejects end-time overflow and lossy application metadata bits', () => {
    expect(
      rulesetConfigSchema.safeParse({
        ...configuration(),
        mustStartAtOrAfter: ((1n << 48n) - 1n).toString(),
        duration: '1',
      }).success,
    ).toBe(false);
    expect(
      rulesetConfigSchema.safeParse({
        ...configuration(),
        metadata: { ...configuration().metadata, metadata: '16384' },
      }).success,
    ).toBe(false);
    expect(
      rulesetConfigSchema.safeParse({
        ...configuration(),
        metadata: { ...configuration().metadata, reservedPercent: '10001' },
      }).success,
    ).toBe(false);
    expect(
      rulesetConfigSchema.safeParse({
        ...configuration(),
        metadata: { ...configuration().metadata, cashOutTaxRate: '10001' },
      }).success,
    ).toBe(false);
  });

  it('requires complete typed configurations and real addresses for enabled hooks', () => {
    expect(rulesetConfigSchema.safeParse({ arbitrary: { economics: 'safe' } }).success).toBe(false);
    expect(
      rulesetConfigSchema.safeParse({
        ...configuration(),
        metadata: { ...configuration().metadata, useDataHookForPay: true },
      }).success,
    ).toBe(false);
    expect(rulesetConfigurationsSchema.safeParse([]).success).toBe(false);
    expect(rulesetConfigSchema.safeParse({ ...configuration(), surprise: true }).success).toBe(
      false,
    );
  });

  it('validates split percentages, recipient ambiguity, and integer widths', () => {
    const valid = {
      ...configuration(),
      splitGroups: [{ groupId: '1', splits: [split(), split()] }],
    };
    expect(rulesetConfigSchema.safeParse(valid).success).toBe(true);
    expect(
      rulesetConfigSchema.safeParse({
        ...valid,
        splitGroups: [{ groupId: '1', splits: [split(), { ...split(), percent: '500000001' }] }],
      }).success,
    ).toBe(false);
    expect(splitSchema.safeParse({ ...split(), percent: '0' }).success).toBe(false);
    expect(
      splitSchema.safeParse({ ...split(), beneficiary: zeroAddress, projectId: '123' }).success,
    ).toBe(false);
    expect(
      splitSchema.safeParse({
        ...split(),
        beneficiary: zeroAddress,
        projectId: '123',
        hook: terminal,
      }).success,
    ).toBe(false);
    expect(splitSchema.safeParse({ ...split(), projectId: (1n << 64n).toString() }).success).toBe(
      false,
    );
    expect(splitSchema.safeParse({ ...split(), lockedUntil: (1n << 48n).toString() }).success).toBe(
      false,
    );
    expect(
      rulesetConfigSchema.safeParse({
        ...valid,
        splitGroups: [...valid.splitGroups, ...valid.splitGroups],
      }).success,
    ).toBe(false);
  });

  it('accepts empty/zero payout configurations and enforces sorted currencies and unique pairs', () => {
    const group = {
      terminal,
      token: NATIVE_TOKEN,
      payoutLimits: [
        { currency: '1', amount: '0' },
        { currency: '2', amount: '1000000' },
      ],
      surplusAllowances: [],
    };
    expect(rulesetConfigSchema.safeParse(configuration()).success).toBe(true);
    expect(
      rulesetConfigSchema.safeParse({ ...configuration(), fundAccessLimitGroups: [group] }).success,
    ).toBe(true);
    expect(
      rulesetConfigSchema.safeParse({ ...configuration(), fundAccessLimitGroups: [group, group] })
        .success,
    ).toBe(false);
    expect(
      rulesetConfigSchema.safeParse({
        ...configuration(),
        fundAccessLimitGroups: [{ ...group, payoutLimits: [...group.payoutLimits].reverse() }],
      }).success,
    ).toBe(false);
    expect(
      rulesetConfigSchema.safeParse({
        ...configuration(),
        fundAccessLimitGroups: [
          { ...group, payoutLimits: [group.payoutLimits[0], group.payoutLimits[0]] },
        ],
      }).success,
    ).toBe(false);
    expect(
      rulesetConfigSchema.safeParse({
        ...configuration(),
        fundAccessLimitGroups: [
          { ...group, payoutLimits: [{ currency: '1', amount: (1n << 224n).toString() }] },
        ],
      }).success,
    ).toBe(false);
  });

  it('validates terminal accounting and requires an explicit core composition', () => {
    const context = { token: NATIVE_TOKEN, decimals: '18', currency: '61166' };
    expect(accountingContextSchema.safeParse(context).success).toBe(true);
    for (const invalid of [
      { ...context, decimals: '6' },
      { ...context, currency: '0' },
      { ...context, token: owner, decimals: '37' },
    ])
      expect(accountingContextSchema.safeParse(invalid).success).toBe(false);
    const terminalConfig = { terminal, accountingContextsToAccept: [context] };
    expect(terminalConfigurationsSchema.safeParse([terminalConfig, terminalConfig]).success).toBe(
      false,
    );
    expect(
      terminalConfigurationsSchema.safeParse([
        { terminal, accountingContextsToAccept: [context, context] },
      ]).success,
    ).toBe(false);
    const launch = {
      chainId: 1,
      account: owner,
      owner,
      projectUri: '',
      rulesetConfigurations: [configuration()],
      terminalConfigurations: [terminalConfig],
    };
    expect(prepareLaunchSchema.safeParse(launch).success).toBe(false);
    expect(prepareLaunchSchema.safeParse({ ...launch, composition: 'core' }).success).toBe(true);
    expect(prepareLaunchSchema.safeParse({ ...launch, composition: '721' }).success).toBe(false);
    expect(
      prepareLaunchSchema.safeParse({
        ...launch,
        composition: 'core',
        rulesetConfigurations: [
          {
            ...configuration(),
            fundAccessLimitGroups: [
              { terminal: owner, token: NATIVE_TOKEN, payoutLimits: [], surplusAllowances: [] },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('exact hypothetical economics', () => {
  it('rounds issuance beneficiary down and reserves the remainder', () => {
    const result = modelEconomics({
      rulesetConfiguration: { ...configuration(), weight: '3' },
      rulesetRole: 'initial',
      completedCycles: 0,
      scenarios: [{ label: 'rounding', contributionInBaseCurrency18: '1000000000000000000' }],
    });
    expect(result.scenarios[0]?.issuance).toEqual({
      totalTokenCount: '3',
      beneficiaryTokenCount: '2',
      pendingReservedTokenCount: '1',
      decimals: 18,
    });
  });

  it('does not turn zero into inherited issuance and distinguishes initial weight 1', () => {
    const base = {
      rulesetConfiguration: { ...configuration(), weight: '0' },
      rulesetRole: 'successor' as const,
      completedCycles: 0,
      scenarios: [{ label: 'zero', contributionInBaseCurrency18: '1000000000000000000' }],
    };
    expect(modelEconomics(base).effectiveWeight).toBe('0');
    expect(() =>
      modelEconomics({ ...base, rulesetConfiguration: { ...configuration(), weight: '1' } }),
    ).toThrow(/inherited|inherit/i);
    expect(
      modelEconomics({
        ...base,
        rulesetRole: 'initial',
        rulesetConfiguration: { ...configuration(), weight: '1' },
      }).effectiveWeight,
    ).toBe('1');
    expect(
      modelEconomics({
        ...base,
        rulesetConfiguration: { ...configuration(), weight: '1' },
        inheritedWeight: '999',
      }).effectiveWeight,
    ).toBe('999');
  });

  it('uses iterative contract rounding, handles complete decay and bounds work', () => {
    expect(decayedWeight(3n, 100_000_000n, 2)).toBe(1n); // floor(floor(3 * .9) * .9), not floor(3 * .9 ** 2).
    expect(decayedWeight(100n, 1_000_000_000n, 1)).toBe(0n);
    expect(() => decayedWeight(100n, 1n, 10_001)).toThrow();
    expect(() =>
      modelEconomics({
        rulesetConfiguration: { ...configuration(), duration: '0' },
        rulesetRole: 'initial',
        completedCycles: 1,
        scenarios: [{ label: 'invalid', contributionInBaseCurrency18: '1' }],
      }),
    ).toThrow(/automatic cycles/);
  });

  it('matches cash-out curve endpoints and staged floor rounding', () => {
    expect(cashOutCurve(1000n, 10n, 100n, 0n)).toBe(100n);
    expect(cashOutCurve(1000n, 10n, 100n, 5000n)).toBe(55n);
    expect(cashOutCurve(1000n, 100n, 100n, 9999n)).toBe(1000n);
    expect(cashOutCurve(1000n, 100n, 100n, 10000n)).toBe(0n);
    expect(cashOutCurve(1000n, 0n, 0n, 0n)).toBe(0n);
    expect(cashOutCurve(7n, 3n, 11n, 3333n)).toBe(0n);
    expect(() => cashOutCurve(1000n, 101n, 100n, 0n)).toThrow();
  });

  it('labels paused payments and refuses economics it cannot model', () => {
    const input = {
      rulesetConfiguration: configuration(),
      rulesetRole: 'initial' as const,
      completedCycles: 0,
      scenarios: [{ label: 'case', contributionInBaseCurrency18: '1000000000000000000' }],
    };
    const paused = modelEconomics({
      ...input,
      rulesetConfiguration: {
        ...configuration(),
        metadata: { ...configuration().metadata, pausePay: true },
      },
    });
    expect(paused.scenarios[0]?.issuance).toBeNull();
    expect(paused.scenarios[0]?.payAllowedByPauseFlag).toBe(false);
    expect(() =>
      modelEconomics({
        ...input,
        rulesetConfiguration: {
          ...configuration(),
          metadata: { ...configuration().metadata, dataHook: owner, useDataHookForPay: true },
        },
      }),
    ).toThrow(/hook/i);
    expect(() =>
      modelEconomics({
        ...input,
        rulesetConfiguration: { ...configuration(), weight: ((1n << 112n) - 1n).toString() },
        scenarios: [
          { label: 'overflow', contributionInBaseCurrency18: ((1n << 256n) - 1n).toString() },
        ],
      }),
    ).toThrow(/uint256/);
    expect(paused.limitations.join(' ')).toContain('not an RPC simulation');
  });
});
