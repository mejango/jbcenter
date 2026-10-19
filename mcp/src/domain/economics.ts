import { z } from 'zod';
import { isAddressEqual, zeroAddress } from 'viem';
import { v6Address } from '@bananapus/nana-sdk-core/v6';
import { chainIdSchema, projectSchema, uintSchema } from './schemas.js';
import { DomainError } from './errors.js';
import { cashOutCurve, decayedWeight, rulesetConfigSchema, uint } from './rulesets.js';
import { revConfigSchema } from './products.js';
import type { BlockEvidence } from './types.js';

const revnetModelSchema = z.union([
  z
    .object({ project: projectSchema })
    .strict()
    .describe('A live revnet. Models its current ruleset at the snapshot block.'),
  z
    .object({
      config: revConfigSchema.describe('The same config object jb_prepare_revnet_deploy takes.'),
      stage: z.number().int().min(0).max(15).default(0).describe('Stage index, 0 = first stage.'),
    })
    .strict()
    .describe('A revnet config, to model before launch.'),
]);

export const modelEconomicsSchema = z
  .object({
    rulesetConfiguration: rulesetConfigSchema
      .optional()
      .describe('A core ruleset. Give this or revnet, not both.'),
    rulesetRole: z
      .enum(['initial', 'successor'])
      .optional()
      .describe(
        'Required with rulesetConfiguration. An initial ruleset has no predecessor; successor weight=1 is an inheritance sentinel.',
      ),
    inheritedWeight: uint(112)
      .optional()
      .describe(
        'Explicit hypothetical already resolved starting weight, required for successor weight=1.',
      ),
    revnet: revnetModelSchema
      .optional()
      .describe('A revnet project or stage config. Give this or rulesetConfiguration, not both.'),
    completedCycles: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .describe(
        'Issuance cuts already applied: cycles completed in the ruleset or stage. For a live revnet, cycles after the current one.',
      ),
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
    if (!value.rulesetConfiguration === !value.revnet) {
      ctx.addIssue({
        code: 'custom',
        path: ['revnet'],
        message: 'Give exactly one of rulesetConfiguration or revnet.',
      });
      return;
    }
    if (value.revnet) {
      if (value.rulesetRole !== undefined || value.inheritedWeight !== undefined)
        ctx.addIssue({
          code: 'custom',
          path: ['rulesetRole'],
          message: 'rulesetRole and inheritedWeight apply only to rulesetConfiguration.',
        });
      if (
        'config' in value.revnet &&
        value.revnet.stage >= value.revnet.config.stageConfigurations.length
      )
        ctx.addIssue({
          code: 'custom',
          path: ['revnet', 'stage'],
          message: 'Stage index is past the last stage.',
        });
      return;
    }
    const config = value.rulesetConfiguration!;
    if (value.rulesetRole === undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['rulesetRole'],
        message: 'rulesetRole is required with rulesetConfiguration.',
      });
    if (
      config.weight === '1' &&
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
      !(config.weight === '1' && value.rulesetRole === 'successor')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['inheritedWeight'],
        message: 'Inherited weight applies only to successor configurations with weight=1.',
      });
    }
    if (config.duration === '0' && value.completedCycles !== 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['completedCycles'],
        message: 'Duration 0 has no automatic cycles. Model a successor separately.',
      });
    }
  });

type ModelInput = z.output<typeof modelEconomicsSchema>;
type RevConfig = z.output<typeof revConfigSchema>;

/** REVOwner is the data hook of every revnet ruleset. It has one address on every supported chain. */
const REV_OWNERS = chainIdSchema.options.map((option) => v6Address('REVOwner', option.value));
const isRevOwner = (address: string) =>
  REV_OWNERS.some((owner) => isAddressEqual(owner, address as `0x${string}`));

/** A revnet as read by jb_get_revnet (decimal strings), narrowed to what the model needs. */
export interface LiveRevnet {
  current: {
    ruleset: { id: Int; start: Int; duration: Int; weight: Int; weightCutPercent: Int };
    metadata: {
      reservedPercent: Int;
      cashOutTaxRate: Int;
      baseCurrency: Int;
      pausePay: boolean;
      dataHook: string;
    };
  };
  stages: { ruleset: { id: Int; start: Int } }[];
  cashOutDelay: { until: string; active: boolean };
  evidence: BlockEvidence[];
}
/** jsonSafe keeps uint48 and smaller as numbers and turns bigints into decimal strings. */
type Int = number | string;

/** The terms the scenario engine needs, after any ruleset or stage resolution. */
interface Terms {
  weight: bigint;
  weightCutPercent: bigint;
  reservedPercent: bigint;
  cashOutTaxRate: bigint;
  baseCurrency: string;
  pausePay: boolean;
  fundAccessLimitGroups: unknown[];
  revnet: boolean;
}

/** REVDeployer._makeRulesetConfiguration, without the loan surplus allowances (they need the terminal and contexts). */
export function revnetStageRuleset(config: RevConfig, index: number) {
  const stage = config.stageConfigurations[index]!;
  return {
    mustStartAtOrAfter: stage.startsAtOrAfter,
    duration: stage.issuanceCutFrequency,
    weight: stage.initialIssuance,
    weightCutPercent: stage.issuanceCutPercent,
    approvalHook: zeroAddress,
    metadata: {
      reservedPercent: stage.splitPercent,
      cashOutTaxRate: stage.cashOutTaxRate,
      baseCurrency: config.baseCurrency,
      pausePay: false,
      pauseCreditTransfers: false,
      allowOwnerMinting: true,
      allowSetCustomToken: false,
      allowTerminalMigration: false,
      allowSetTerminals: false,
      allowSetController: false,
      allowAddAccountingContext: false,
      allowAddPriceFeed: false,
      ownerMustSendPayouts: false,
      holdFees: false,
      scopeCashOutsToLocalBalances: config.scopeCashOutsToLocalBalances,
      useDataHookForPay: true,
      useDataHookForCashOut: true,
      dataHook: REV_OWNERS[0]!,
      metadata: stage.extraMetadata,
    },
    splitGroups: [{ groupId: '1', splits: stage.splits }],
    fundAccessLimitGroups: [] as unknown[],
  };
}

/** JBRulesets.deriveStartFrom: a queued ruleset starts on a cycle boundary of the one before it. */
function deriveStart(baseStart: bigint, baseDuration: bigint, mustStartAtOrAfter: bigint) {
  if (baseDuration === 0n) return mustStartAtOrAfter;
  const next = baseStart + baseDuration;
  if (next >= mustStartAtOrAfter) return next;
  const cycles = (mustStartAtOrAfter - next + baseDuration - 1n) / baseDuration;
  return next + cycles * baseDuration;
}

/** Resolve every stage's start and starting weight the way launchRulesetsFor queues them. */
function resolveStages(config: RevConfig) {
  const resolved: { start: bigint; duration: bigint; weight: bigint; cut: bigint }[] = [];
  config.stageConfigurations.forEach((stage, i) => {
    const duration = BigInt(stage.issuanceCutFrequency);
    const cut = BigInt(stage.issuanceCutPercent);
    const prior = resolved[i - 1];
    if (!prior) {
      resolved.push({
        start: BigInt(stage.startsAtOrAfter),
        duration,
        weight: BigInt(stage.initialIssuance),
        cut,
      });
      return;
    }
    const start = deriveStart(prior.start, prior.duration, BigInt(stage.startsAtOrAfter));
    // JBRulesets.deriveWeightFrom: weight 1 inherits the prior stage's weight, cut once per elapsed cycle.
    const cuts =
      prior.duration === 0n
        ? 1
        : prior.cut === 0n
          ? 0
          : Number((start - prior.start) / prior.duration);
    const weight =
      stage.initialIssuance === '1'
        ? decayedWeight(prior.weight, prior.cut, cuts)
        : BigInt(stage.initialIssuance);
    resolved.push({ start, duration, weight, cut });
  });
  return resolved;
}

function stageBoundary(
  start: bigint,
  duration: bigint,
  nextStart: bigint | undefined,
  cycles: number,
) {
  if (nextStart === undefined) return;
  const available = duration === 0n ? 0n : (nextStart - start) / duration - 1n;
  if (BigInt(cycles) > available)
    throw new DomainError(
      'STAGE_BOUNDARY_CROSSED',
      `The next stage starts at ${nextStart}, after ${available} more cycles. Model that stage instead.`,
    );
}

/**
 * REVOwner.beforeCashOutRecordedWith for an ordinary holder: with a nonzero tax, 1/40 of the tokens go to the
 * fee revnet, then JBMultiTerminal takes its 2.5% protocol fee from the holder's reclaim.
 */
export function revnetCashOut(surplus: bigint, count: bigint, supply: bigint, tax: bigint) {
  const feeCount = tax === 0n ? 0n : count / 40n;
  const holderCount = count - feeCount;
  const gross = cashOutCurve(surplus, holderCount, supply, tax);
  const revnetFee =
    feeCount === 0n
      ? 0n
      : cashOutCurve(surplus > gross ? surplus - gross : 0n, feeCount, supply - holderCount, tax);
  const protocolFee = gross / 40n;
  return {
    feeTokenCount: feeCount.toString(),
    holderReclaimBeforeProtocolFeeAtomic: gross.toString(),
    revnetFeeAtomic: revnetFee.toString(),
    protocolFeeAtomic: protocolFee.toString(),
    holderReclaimAtomic: (gross - protocolFee).toString(),
    ...(tax === 0n
      ? {
          zeroTaxNote:
            'Zero tax: no revnet fee, and the protocol fee applies only up to the fee-free surplus, so the holder can receive up to holderReclaimBeforeProtocolFeeAtomic.',
        }
      : {}),
  };
}

/** Resolve the input to scenario terms. A live revnet must be supplied when the input names a project. */
function resolve(value: ModelInput, live?: LiveRevnet) {
  if (value.rulesetConfiguration) {
    const config = value.rulesetConfiguration;
    const hooked = config.metadata.useDataHookForPay || config.metadata.useDataHookForCashOut;
    if (hooked && !isRevOwner(config.metadata.dataHook)) {
      throw new DomainError(
        'CUSTOM_HOOK_MODEL_UNSUPPORTED',
        'Enabled data hooks can override issuance or cash-outs; the core-only scenario model cannot represent their economics.',
      );
    }
    const weight =
      config.weight === '1' && value.rulesetRole === 'successor'
        ? BigInt(value.inheritedWeight!)
        : BigInt(config.weight);
    return {
      terms: termsOf(
        config,
        decayedWeight(weight, BigInt(config.weightCutPercent), value.completedCycles),
        hooked,
      ),
      revnet: hooked ? { source: 'rulesetConfiguration' as const } : undefined,
    };
  }
  const revnet = value.revnet!;
  if ('config' in revnet) {
    const stages = resolveStages(revnet.config);
    const stage = stages[revnet.stage]!;
    if (stage.duration === 0n && value.completedCycles !== 0)
      throw new DomainError(
        'INVALID_SCENARIO',
        'This stage has no issuance cuts. Use completedCycles 0.',
      );
    stageBoundary(
      stage.start,
      stage.duration,
      stages[revnet.stage + 1]?.start,
      value.completedCycles,
    );
    const ruleset = revnetStageRuleset(revnet.config, revnet.stage);
    return {
      terms: termsOf(ruleset, decayedWeight(stage.weight, stage.cut, value.completedCycles), true),
      revnet: {
        source: 'config' as const,
        stage: revnet.stage,
        stageStart: stage.start.toString(),
        stageStartingWeight: stage.weight.toString(),
        rulesetConfiguration: ruleset,
      },
    };
  }
  if (!live) throw new DomainError('UPSTREAM_FAILURE', 'The revnet read is missing.');
  const { ruleset, metadata } = live.current;
  if (!isRevOwner(metadata.dataHook))
    throw new DomainError(
      'CUSTOM_HOOK_MODEL_UNSUPPORTED',
      'The current ruleset does not use REVOwner as its data hook.',
    );
  const duration = BigInt(ruleset.duration);
  if (duration === 0n && value.completedCycles !== 0)
    throw new DomainError(
      'INVALID_SCENARIO',
      'The current ruleset has no issuance cuts. Use completedCycles 0.',
    );
  const later = live.stages
    .filter((stage) => BigInt(stage.ruleset.id) > BigInt(ruleset.id))
    .map((stage) => BigInt(stage.ruleset.start))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  stageBoundary(BigInt(ruleset.start), duration, later[0], value.completedCycles);
  return {
    terms: {
      weight: decayedWeight(
        BigInt(ruleset.weight),
        BigInt(ruleset.weightCutPercent),
        value.completedCycles,
      ),
      weightCutPercent: BigInt(ruleset.weightCutPercent),
      reservedPercent: BigInt(metadata.reservedPercent),
      cashOutTaxRate: BigInt(metadata.cashOutTaxRate),
      baseCurrency: String(metadata.baseCurrency),
      pausePay: metadata.pausePay,
      fundAccessLimitGroups: [],
      revnet: true,
    },
    revnet: {
      source: 'project' as const,
      rulesetId: String(ruleset.id),
      cycleStart: String(ruleset.start),
      currentWeight: String(ruleset.weight),
      nextStageStart: later[0]?.toString() ?? null,
      cashOutDelay: live.cashOutDelay,
      evidence: live.evidence,
    },
  };
}

function termsOf(
  config: {
    weightCutPercent: string;
    metadata: {
      reservedPercent: string;
      cashOutTaxRate: string;
      baseCurrency: string;
      pausePay: boolean;
    };
    fundAccessLimitGroups: unknown[];
  },
  weight: bigint,
  revnet: boolean,
): Terms {
  return {
    weight,
    weightCutPercent: BigInt(config.weightCutPercent),
    reservedPercent: BigInt(config.metadata.reservedPercent),
    cashOutTaxRate: BigInt(config.metadata.cashOutTaxRate),
    baseCurrency: config.metadata.baseCurrency,
    pausePay: config.metadata.pausePay,
    fundAccessLimitGroups: config.fundAccessLimitGroups,
    revnet,
  };
}

export function modelEconomics(raw: z.input<typeof modelEconomicsSchema>, live?: LiveRevnet) {
  const value = modelEconomicsSchema.parse(raw);
  const { terms, revnet } = resolve(value, live);
  return {
    kind: 'hypothetical-core-economic-scenarios' as const,
    baseCurrency: terms.baseCurrency,
    effectiveWeight: terms.weight.toString(),
    completedCycles: value.completedCycles,
    arithmetic:
      'Exact integer core formulas with contract rounding, within the explicitly stated hypothetical inputs.',
    ...(revnet ? { revnet: { dataHook: 'REVOwner', ...revnet } } : {}),
    scenarios: value.scenarios.map((scenario) => {
      const total = (BigInt(scenario.contributionInBaseCurrency18) * terms.weight) / 10n ** 18n;
      if (total >= 1n << 256n)
        throw new DomainError('SCENARIO_OVERFLOW', 'Hypothetical token issuance exceeds uint256.');
      const beneficiary = (total * (10_000n - terms.reservedPercent)) / 10_000n;
      const cashOut = scenario.cashOut;
      const curve =
        cashOut &&
        ([
          BigInt(cashOut.surplusAtomic),
          BigInt(cashOut.cashOutCount),
          BigInt(cashOut.totalSupply),
          terms.cashOutTaxRate,
        ] as const);
      return {
        label: scenario.label,
        contributionInBaseCurrency18: scenario.contributionInBaseCurrency18,
        payAllowedByPauseFlag: !terms.pausePay,
        issuance: terms.pausePay
          ? null
          : {
              totalTokenCount: total.toString(),
              beneficiaryTokenCount: beneficiary.toString(),
              pendingReservedTokenCount: (total - beneficiary).toString(),
              decimals: 18,
            },
        cashOut: curve
          ? terms.revnet
            ? { ...cashOut, ...revnetCashOut(...curve) }
            : { ...cashOut, reclaimBeforeProtocolFeesAtomic: cashOutCurve(...curve).toString() }
          : null,
      };
    }),
    payoutBudgets: terms.fundAccessLimitGroups,
    limitations: [
      'This is a deterministic hypothetical calculation, not an RPC simulation, contribution quote, market forecast, or claim of spendable funds.',
      'Contribution inputs are already denominated in base currency at 18 decimals. No token exchange rate, terminal routing, market purchase, fee, or hook result is assumed.',
      'Cash-out inputs are independent of contribution inputs. Supply must include pending reserved tokens and relevant cross-chain supply; surplus is supplied explicitly and is not treasury balance.',
      'Payout limits and surplus allowances are independent per chain, terminal, token, currency, and reset window. Empty fund-access groups mean zero payout limits and zero surplus allowances.',
      'Split routing, fee exemptions, recipient hooks, liquidity availability, transaction gas, ruleset approvals, and timestamp selection require live transaction simulation.',
      'Repeated decay matches core integer math; long-lived on-chain rulesets may require weight-cache maintenance before execution.',
      ...(terms.revnet ? REVNET_LIMITS : []),
    ],
    sources: [
      'nana-core-v6/src/JBRulesets.sol:deriveWeightFrom',
      'nana-core-v6/src/JBTerminalStore.sol:_computePayFrom',
      'nana-core-v6/src/JBController.sol:_splitTokenCount',
      'nana-core-v6/src/libraries/JBCashOuts.sol:cashOutFrom',
      ...(terms.revnet ? REVNET_SOURCES : []),
    ],
  };
}

const REVNET_LIMITS = [
  'Revnet: issuance is the mint path. The buyback hook swaps instead when its pool gives the payer more tokens, so pay and cash-out results are indicative.',
  'Revnet: 721 tier splits reduce the weight for the part of a payment they take. Not modeled.',
  'Revnet: supply must include loan collateral and, unless cash outs are scoped to local balances, other chains. Surplus must include outstanding loans and other chains. Local liquidity is assumed to cover the reclaim.',
  'Revnet: REVLoans holds an unlimited surplus allowance per accepted token; revnets have no payout limits.',
  'Revnet: a chain deployed after its first stage starts blocks ordinary cash outs and loans for 7 days. See jb_suggest_revnet_start.',
];
const REVNET_SOURCES = [
  'revnet-core-v6/src/REVDeployer.sol:_makeRulesetConfiguration',
  'revnet-core-v6/src/REVOwner.sol:beforeCashOutRecordedWith',
  'nana-core-v6/src/JBRulesets.sol:deriveStartFrom',
  'nana-core-v6/src/JBMultiTerminal.sol:_cashOutTokensOf',
];
