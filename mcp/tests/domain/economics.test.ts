import { describe, expect, it } from 'vitest';
import { zeroAddress, zeroHash } from 'viem';
import { buildRulesetMetadata, v6Address } from '@bananapus/nana-sdk-core/v6';
import { modelEconomics, revnetCashOut, type LiveRevnet } from '../../src/domain/economics.js';

const revOwner = v6Address('REVOwner', 8453);
const holder = '0x1111111111111111111111111111111111111111';
const e18 = 10n ** 18n;
const oneEth = e18.toString();
const t0 = 1_000_000;
const day = 86_400;

function split() {
  return {
    percent: '1000000000',
    projectId: '0',
    beneficiary: holder,
    preferAddToBalance: false,
    lockedUntil: '0',
    hook: zeroAddress,
  };
}
function stage(overrides: Record<string, unknown>) {
  return {
    startsAtOrAfter: String(t0),
    autoIssuances: [],
    splitPercent: '2000',
    splits: [split()],
    initialIssuance: (1000n * e18).toString(),
    issuanceCutFrequency: String(day),
    issuanceCutPercent: '100000000',
    cashOutTaxRate: '5000',
    extraMetadata: '4',
    ...overrides,
  };
}
function config() {
  return {
    description: { name: 'Model', ticker: 'MDL', uri: '', salt: zeroHash },
    baseCurrency: '1',
    operator: holder,
    scopeCashOutsToLocalBalances: false,
    stageConfigurations: [
      stage({}),
      // Not on a stage-0 cycle boundary: the stage starts on the next one, t0 + 4 days.
      stage({
        startsAtOrAfter: String(t0 + 3 * day + 100),
        initialIssuance: '1',
        splitPercent: '1000',
        cashOutTaxRate: '2000',
      }),
    ],
  };
}
const scenario = { label: 'one', contributionInBaseCurrency18: oneEth };

describe('revnet economics', () => {
  it('models a ruleset whose data hook is REVOwner, with the revnet cash-out fee', () => {
    const result = modelEconomics({
      rulesetConfiguration: {
        mustStartAtOrAfter: '0',
        duration: String(day),
        weight: (1000n * e18).toString(),
        weightCutPercent: '0',
        approvalHook: zeroAddress,
        metadata: {
          ...buildRulesetMetadata(),
          reservedPercent: '2000',
          cashOutTaxRate: '5000',
          baseCurrency: '1',
          metadata: '0',
          dataHook: revOwner,
          useDataHookForPay: true,
          useDataHookForCashOut: true,
        },
        splitGroups: [],
        fundAccessLimitGroups: [],
      },
      rulesetRole: 'initial',
      completedCycles: 0,
      scenarios: [
        {
          ...scenario,
          cashOut: { surplusAtomic: '10000', cashOutCount: '400', totalSupply: '1000' },
        },
      ],
    });
    expect(result.revnet).toEqual({ dataHook: 'REVOwner', source: 'rulesetConfiguration' });
    // 10 of 400 tokens go to the fee revnet. Holder: cashOutFrom(10000, 390, 1000, 5000) = 2710.
    // Fee: cashOutFrom(7290, 10, 610, 5000) = 60. Protocol fee: 2710 / 40 = 67.
    expect(result.scenarios[0]?.cashOut).toMatchObject({
      feeTokenCount: '10',
      holderReclaimBeforeProtocolFeeAtomic: '2710',
      revnetFeeAtomic: '60',
      protocolFeeAtomic: '67',
      holderReclaimAtomic: '2643',
    });
    expect(result.limitations.join(' ')).toContain('indicative');
  });

  it('takes no revnet fee at zero tax', () => {
    expect(revnetCashOut(1000n, 100n, 1000n, 0n)).toMatchObject({
      feeTokenCount: '0',
      holderReclaimBeforeProtocolFeeAtomic: '100',
      revnetFeeAtomic: '0',
    });
  });

  it('still refuses other data hooks', () => {
    expect(() =>
      modelEconomics({
        rulesetConfiguration: {
          mustStartAtOrAfter: '0',
          duration: '0',
          weight: '1',
          weightCutPercent: '0',
          approvalHook: zeroAddress,
          metadata: {
            ...buildRulesetMetadata(),
            reservedPercent: '0',
            cashOutTaxRate: '0',
            baseCurrency: '1',
            metadata: '0',
            dataHook: holder,
            useDataHookForCashOut: true,
          },
          splitGroups: [],
          fundAccessLimitGroups: [],
        },
        rulesetRole: 'initial',
        completedCycles: 0,
        scenarios: [scenario],
      }),
    ).toThrow(/hook/);
  });

  it('translates a stage into the ruleset REVDeployer builds', () => {
    const result = modelEconomics({
      revnet: { config: config(), stage: 0 },
      completedCycles: 3,
      scenarios: [scenario],
    });
    expect(result.revnet).toMatchObject({
      source: 'config',
      stage: 0,
      stageStart: String(t0),
      rulesetConfiguration: {
        mustStartAtOrAfter: String(t0),
        duration: String(day),
        weight: (1000n * e18).toString(),
        weightCutPercent: '100000000',
        approvalHook: zeroAddress,
        metadata: {
          reservedPercent: '2000',
          cashOutTaxRate: '5000',
          baseCurrency: '1',
          allowOwnerMinting: true,
          useDataHookForPay: true,
          useDataHookForCashOut: true,
          dataHook: revOwner,
          metadata: '4',
        },
        splitGroups: [{ groupId: '1', splits: [split()] }],
      },
    });
    // 1000 * 0.9^3 = 729 tokens per ETH; 20% to splits.
    expect(result.effectiveWeight).toBe((729n * e18).toString());
    expect(result.scenarios[0]?.issuance).toMatchObject({
      totalTokenCount: (729n * e18).toString(),
      beneficiaryTokenCount: ((729n * e18 * 8n) / 10n).toString(),
    });
  });

  it('resolves a later stage start and inherited issuance, and stops at stage boundaries', () => {
    const second = modelEconomics({
      revnet: { config: config(), stage: 1 },
      completedCycles: 0,
      scenarios: [scenario],
    });
    // Starts on stage 0's fourth boundary and inherits 1000 * 0.9^4 = 656.1.
    expect(second.revnet).toMatchObject({
      stageStart: String(t0 + 4 * day),
      stageStartingWeight: (6561n * 10n ** 17n).toString(),
    });
    expect(second.scenarios[0]?.issuance?.beneficiaryTokenCount).toBe(
      ((6561n * 10n ** 17n * 9n) / 10n).toString(),
    );
    expect(() =>
      modelEconomics({
        revnet: { config: config(), stage: 0 },
        completedCycles: 4,
        scenarios: [scenario],
      }),
    ).toThrow(/next stage/);
    expect(() =>
      modelEconomics({
        revnet: { config: config(), stage: 2 },
        completedCycles: 0,
        scenarios: [scenario],
      }),
    ).toThrow(/past the last stage/);
  });

  it('models a live revnet from its current ruleset', () => {
    const live: LiveRevnet = {
      current: {
        ruleset: {
          id: '10',
          start: String(t0 + 2 * day),
          duration: String(day),
          weight: (810n * e18).toString(),
          weightCutPercent: '100000000',
        },
        metadata: {
          reservedPercent: 2000,
          cashOutTaxRate: 5000,
          baseCurrency: 1,
          pausePay: false,
          dataHook: revOwner,
        },
      },
      stages: [
        { ruleset: { id: '11', start: String(t0 + 4 * day) } },
        { ruleset: { id: '10', start: String(t0) } },
      ],
      cashOutDelay: { until: '0', active: false },
      evidence: [],
    };
    const input = {
      revnet: { project: { chainId: 8453 as const, projectId: '6' } },
      completedCycles: 1,
      scenarios: [scenario],
    };
    const result = modelEconomics(input, live);
    expect(result.effectiveWeight).toBe((729n * e18).toString());
    expect(result.revnet).toMatchObject({
      source: 'project',
      nextStageStart: String(t0 + 4 * day),
    });
    expect(() => modelEconomics({ ...input, completedCycles: 2 }, live)).toThrow(/next stage/);
    expect(() =>
      modelEconomics(input, {
        ...live,
        current: { ...live.current, metadata: { ...live.current.metadata, dataHook: holder } },
      }),
    ).toThrow(/REVOwner/);
  });

  it('takes exactly one of a ruleset or a revnet', () => {
    expect(() => modelEconomics({ completedCycles: 0, scenarios: [scenario] })).toThrow(
      /exactly one/,
    );
    expect(() =>
      modelEconomics({
        revnet: { config: config() },
        rulesetRole: 'initial',
        completedCycles: 0,
        scenarios: [scenario],
      }),
    ).toThrow(/rulesetRole/);
  });
});
