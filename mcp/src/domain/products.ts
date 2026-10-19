import { z } from 'zod';
import { jb721TiersHookAbi } from '@bananapus/nana-sdk-core';
import {
  v6Address,
  type REVConfig,
  type REVDeploy721TiersHookConfig,
  type REVSuckerDeploymentConfig,
} from '@bananapus/nana-sdk-core/v6';
import { zeroAddress, zeroHash, type Address, type PublicClient } from 'viem';
import {
  addressSchema,
  chainIdSchema,
  hashSchema,
  positiveUintSchema,
  projectSchema,
  slippageSchema,
  uintSchema,
} from './schemas.js';
import {
  accountingContextSchema,
  requireLimitsOnAcceptedContexts,
  rulesetConfigSchema,
  rulesetConfigurationsSchema,
  rulesetMetadataSchema,
  splitSchema,
  terminalConfigurationsSchema,
  toRulesetConfig,
  uint,
} from './rulesets.js';
import { DomainError } from './errors.js';
import { UNITS } from './units.js';
import type { ProjectRef } from './types.js';

const nonzero = addressSchema.refine(
  (value) => value !== zeroAddress,
  'A nonzero address is required.',
);
const splits = z
  .array(splitSchema)
  .max(32)
  .refine(
    (items) => items.reduce((sum, item) => sum + BigInt(item.percent), 0n) <= 1_000_000_000n,
    'Split total exceeds 1,000,000,000.',
  );
export const tierConfigSchema = z
  .object({
    price: uint(104).describe(UNITS.tierPrice),
    initialSupply: uint(32, 999_999_999n).refine((v) => BigInt(v) > 0n),
    votingUnits: uint(32),
    reserveFrequency: uint(16),
    reserveBeneficiary: addressSchema,
    encodedIpfsUri: hashSchema,
    category: uint(24),
    discountPercent: uint(8, 200n).describe(UNITS.discountPercent),
    flags: z
      .object({
        allowOwnerMint: z.boolean(),
        useReserveBeneficiaryAsDefault: z.boolean(),
        transfersPausable: z.boolean(),
        useVotingUnits: z.boolean(),
        cantBeRemoved: z.boolean(),
        cantIncreaseDiscountPercent: z.boolean(),
        cantBuyWithCredits: z.boolean(),
      })
      .strict(),
    splitPercent: uint(32, 1_000_000_000n).describe(UNITS.tierSplitPercent),
    splits,
  })
  .strict()
  .superRefine((tier, ctx) => {
    if (tier.initialSupply === '1' && tier.reserveFrequency !== '0')
      ctx.addIssue({
        code: 'custom',
        path: ['reserveFrequency'],
        message: 'Supply 1 with reserves deadlocks paid minting and is rejected by the store.',
      });
  });
export const tiersConfigArraySchema = z
  .array(tierConfigSchema)
  .max(32)
  .superRefine((tiers, ctx) => {
    tiers.forEach((tier, index) => {
      if (index && BigInt(tier.category) < BigInt(tiers[index - 1]!.category))
        ctx.addIssue({
          code: 'custom',
          path: [index, 'category'],
          message:
            'Tiers must be sorted by category ascending. Input order determines assigned tier IDs.',
        });
    });
  });
export const get721ShopSchema = z
  .object({
    project: projectSchema,
    startingId: uintSchema.default('0'),
    size: z.number().int().min(1).max(32).default(20),
    categories: z
      .array(uint(24))
      .max(16)
      .refine(
        (values) => values.every((v, i) => !i || BigInt(v) > BigInt(values[i - 1]!)),
        'Categories must be unique and ascending.',
      )
      .default([]),
    includeResolvedUri: z.boolean().default(false),
  })
  .strict();
export const pay721Schema = z
  .object({
    project: projectSchema,
    account: nonzero,
    token: nonzero.describe(UNITS.token),
    amount: uintSchema.describe(
      'Fresh payment amount in the token’s smallest units. Use 0 for free tiers or eligible NFT-credit purchases.',
    ),
    beneficiary: nonzero,
    tierIds: z
      .array(uint(16).refine((v) => BigInt(v) > 0n))
      .min(1)
      .max(32),
    slippageBps: slippageSchema,
    allowOverspending: z.boolean().default(false),
  })
  .strict();
export const getRevnetSchema = z
  .object({
    project: projectSchema,
    startingId: uintSchema.default('0'),
    size: z.number().int().min(1).max(32).default(16),
    operator: nonzero.optional(),
  })
  .strict();
export const prepareAutoIssueSchema = z
  .object({
    project: projectSchema,
    account: nonzero,
    stageId: positiveUintSchema,
    beneficiary: nonzero,
  })
  .strict();
export const prepareAdjustTiersSchema = z
  .object({
    project: projectSchema,
    account: nonzero,
    tiersToAdd: tiersConfigArraySchema,
    tierIdsToRemove: z
      .array(uint(16).refine((v) => BigInt(v) > 0n))
      .max(32)
      .refine((v) => new Set(v).size === v.length, 'Removal IDs must be unique.'),
  })
  .strict()
  .refine(
    (v) => v.tiersToAdd.length + v.tierIdsToRemove.length > 0,
    'Specify at least one addition or removal.',
  );

export const revStageSchema = z
  .object({
    startsAtOrAfter: uint(48).refine(
      (v) => BigInt(v) > 0n,
      'Use one explicit absolute timestamp across chains.',
    ),
    autoIssuances: z
      .array(
        z
          .object({
            chainId: uint(32).refine((v) => BigInt(v) > 0n),
            count: uint(104),
            beneficiary: nonzero,
          })
          .strict(),
      )
      .max(32),
    splitPercent: uint(16, 10_000n).describe(UNITS.revnetSplitPercent),
    splits,
    initialIssuance: uint(112).describe(UNITS.initialIssuance),
    issuanceCutFrequency: uint(32).describe(UNITS.issuanceCutFrequency),
    issuanceCutPercent: uint(32, 1_000_000_000n).describe(UNITS.issuanceCutPercent),
    cashOutTaxRate: uint(16, 9_999n).describe(UNITS.revnetCashOutTaxRate),
    extraMetadata: uint(16, 16_383n).describe(UNITS.extraMetadata),
  })
  .strict()
  .refine(
    (v) => v.splitPercent === '0' || v.splits.length > 0,
    'A positive splitPercent requires recipients.',
  );
export const revConfigSchema = z
  .object({
    description: z
      .object({
        name: z.string().min(1).max(256),
        ticker: z.string().min(1).max(32),
        uri: z.string().max(4096),
        salt: hashSchema,
      })
      .strict(),
    baseCurrency: uint(32)
      .refine((v) => BigInt(v) > 0n)
      .describe(UNITS.baseCurrency),
    operator: addressSchema,
    scopeCashOutsToLocalBalances: z.boolean().describe(UNITS.scopeCashOutsToLocalBalances),
    stageConfigurations: z.array(revStageSchema).min(1).max(16),
  })
  .strict()
  .superRefine((config, ctx) => {
    config.stageConfigurations.forEach((stage, i) => {
      if (
        i &&
        BigInt(stage.startsAtOrAfter) <= BigInt(config.stageConfigurations[i - 1]!.startsAtOrAfter)
      )
        ctx.addIssue({
          code: 'custom',
          path: ['stageConfigurations', i, 'startsAtOrAfter'],
          message: 'Absolute stage starts must strictly increase.',
        });
    });
  });
export const suggestRevnetStartSchema = z
  .object({
    chainIds: z
      .array(chainIdSchema)
      .min(1)
      .max(8)
      .refine((v) => new Set(v).size === v.length, 'Chain IDs must be unique.')
      .describe('Every chain the revnet launches on.'),
  })
  .strict();

/** Time to sign and land one chain's deploy after its plan expires; the prepare-time warning threshold. */
export const REVNET_SIGNING_MARGIN_SECONDS = 180;

/** Product choice for comfortable human review across every chain, not a contract fact. */
export const REVNET_START_LEAD_SECONDS = 3600;

/** One first-stage start for every chain: now + REVNET_START_LEAD_SECONDS, rounded up to the minute. */
export function suggestedRevnetStart(now: bigint) {
  const earliest = now + BigInt(REVNET_START_LEAD_SECONDS);
  return ((earliest + 59n) / 60n) * 60n;
}

/**
 * REVDeployer._computeCashOutDelayIfNeeded: a deploy landing after the first stage start
 * (0 < startsAtOrAfter < block.timestamp) blocks ordinary cash outs and loans until deploy time + CASH_OUT_DELAY.
 */
export function revnetStartWarning(
  start: bigint,
  now: bigint,
  planTtlSeconds: number,
  cashOutDelay: bigint,
) {
  const delay = `${cashOutDelay} seconds (${Number(cashOutDelay) / 86_400} days)`;
  if (start < now)
    return `The first stage started at ${start}, before this block. Deployed now, this chain blocks ordinary cash outs and loans for ${delay}. That is expected when adding a chain to an existing revnet. For a new revnet, use jb_suggest_revnet_start.`;
  if (start < now + BigInt(planTtlSeconds + REVNET_SIGNING_MARGIN_SECONDS))
    return `The first stage starts at ${start}, inside this plan's expiry plus a ${REVNET_SIGNING_MARGIN_SECONDS}-second signing margin. If the deploy lands after ${start}, this chain blocks ordinary cash outs and loans for ${delay}. For one start that works on every chain, call jb_suggest_revnet_start.`;
}

export const suckerBridgeSchema = z
  .enum(['ccip', 'native', 'both'])
  .describe(
    'ccip links any chain pair. native links Ethereum with one L2 and maps native ETH only. both adds a native sucker where one exists.',
  );
export const revSuckerConfigSchema = z
  .object({
    salt: hashSchema,
    deployerConfigurations: z
      .array(
        z
          .object({
            deployer: nonzero,
            peer: hashSchema,
            mappings: z
              .array(
                z
                  .object({ localToken: nonzero, minGas: uint(32), remoteToken: hashSchema })
                  .strict(),
              )
              .min(1)
              .max(16),
          })
          .strict(),
      )
      .max(16),
  })
  .strict();
export const revTieredConfigSchema = z
  .object({
    baseline721HookConfiguration: z
      .object({
        name: z.string().min(1).max(256),
        symbol: z.string().min(1).max(32),
        baseUri: z.string().max(4096),
        tokenUriResolver: addressSchema,
        contractUri: z.string().max(4096),
        tiersConfig: z
          .object({
            tiers: tiersConfigArraySchema,
            currency: uint(32)
              .refine((v) => BigInt(v) > 0n)
              .describe(UNITS.currency),
            decimals: uint(8, 18n).describe('Decimals of tier prices.'),
          })
          .strict(),
        flags: z
          .object({
            noNewTiersWithReserves: z.boolean(),
            noNewTiersWithVotes: z.boolean(),
            noNewTiersWithOwnerMinting: z.boolean(),
            preventOverspending: z.boolean(),
          })
          .strict(),
      })
      .strict(),
    salt: hashSchema,
    preventOperatorAdjustingTiers: z.boolean(),
    preventOperatorUpdatingMetadata: z.boolean(),
    preventOperatorMinting: z.boolean(),
    preventOperatorIncreasingDiscountPercent: z.boolean(),
  })
  .strict();
export const revAllowedPostSchema = z
  .object({
    category: uint(24),
    minimumPrice: uint(104),
    minimumTotalSupply: uint(32, 999_999_999n).refine(
      (v) => BigInt(v) > 0n,
      'Minimum posting supply must be positive.',
    ),
    maximumTotalSupply: uint(32).describe(
      '0 means unlimited; actual minted NFT tiers remain subject to the store supply cap.',
    ),
    maximumSplitPercent: uint(32, 1_000_000_000n).describe(UNITS.maximumSplitPercent),
    allowedAddresses: z.array(nonzero).max(32),
  })
  .strict()
  .refine(
    (v) =>
      v.maximumTotalSupply === '0' || BigInt(v.minimumTotalSupply) <= BigInt(v.maximumTotalSupply),
    'Minimum supply exceeds the nonzero maximum supply.',
  );
export const prepareRevnetDeploySchema = z
  .object({
    chainId: chainIdSchema,
    account: nonzero,
    config: revConfigSchema,
    accountingContexts: z.array(accountingContextSchema).min(1).max(16),
    chainIds: suggestRevnetStartSchema.shape.chainIds
      .optional()
      .describe(
        'Every chain the revnet launches on, including chainId. Instead of suckerConfig: the sucker registry fills the bridges to the other chains, salted with config.description.salt, mapping native ETH and USDC when accepted.',
      ),
    bridge: suckerBridgeSchema
      .optional()
      .describe('With chainIds. Default ccip. ' + suckerBridgeSchema.description),
    suckerConfig: revSuckerConfigSchema
      .optional()
      .describe(
        'Explicit bridges, instead of chainIds. Use { salt, deployerConfigurations: [] } for one chain.',
      ),
    tiered721Config: revTieredConfigSchema.optional(),
    allowedPosts: z.array(revAllowedPostSchema).max(16).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.tiered721Config && value.allowedPosts.length)
      ctx.addIssue({
        code: 'custom',
        path: ['allowedPosts'],
        message: 'Allowed posts require the explicit tiered 721 configuration.',
      });
    if (!value.chainIds === !value.suckerConfig)
      ctx.addIssue({
        code: 'custom',
        path: ['chainIds'],
        message:
          'Pass chainIds (every chain the revnet launches on) to fill the bridges from the registry, or an explicit suckerConfig, not both.',
      });
    if (value.chainIds && !value.chainIds.includes(value.chainId))
      ctx.addIssue({
        code: 'custom',
        path: ['chainIds'],
        message: 'chainIds must include chainId.',
      });
    if (value.bridge && !value.chainIds)
      ctx.addIssue({ code: 'custom', path: ['bridge'], message: 'bridge needs chainIds.' });
    const crossChain = value.suckerConfig
      ? value.suckerConfig.deployerConfigurations.length > 0
      : (value.chainIds?.length ?? 0) > 1;
    if (crossChain && value.chainIds && value.config.description.salt === zeroHash)
      ctx.addIssue({
        code: 'custom',
        path: ['config', 'description', 'salt'],
        message:
          'A nonzero salt is required: with chainIds it also salts the suckers, and the deployer skips them when it is zero.',
      });
    if (value.suckerConfig?.deployerConfigurations.length && value.suckerConfig.salt === zeroHash)
      ctx.addIssue({
        code: 'custom',
        path: ['suckerConfig', 'salt'],
        message:
          'A nonzero sucker salt is required: the deployer skips sucker creation when it is zero.',
      });
    if (
      new Set(value.accountingContexts.map((c) => c.token.toLowerCase())).size !==
      value.accountingContexts.length
    )
      ctx.addIssue({
        code: 'custom',
        path: ['accountingContexts'],
        message: 'Accounting tokens must be unique.',
      });
    if (crossChain)
      value.config.stageConfigurations.forEach((stage, i) => {
        if ((BigInt(stage.extraMetadata) & 4n) === 0n)
          ctx.addIssue({
            code: 'custom',
            path: ['config', 'stageConfigurations', i, 'extraMetadata'],
            message: 'Every cross-chain stage must permit sucker deployment with metadata bit 2.',
          });
      });
  });

/** The project deployer attaches its new hook. Its ABI has no user-supplied dataHook or pay-hook flag. */
const {
  dataHook: _dataHook,
  useDataHookForPay: _useDataHookForPay,
  ...payHookMetadataFields
} = rulesetMetadataSchema.shape;
export const payHookRulesetSchema = z
  .object({ ...rulesetConfigSchema.shape, metadata: z.object(payHookMetadataFields).strict() })
  .strict()
  .superRefine((value, ctx) => {
    // Reuse all core duration, split, limit and scalar invariants using inert fields absent from this ABI.
    const result = rulesetConfigSchema.safeParse({
      ...value,
      metadata: {
        ...value.metadata,
        dataHook: zeroAddress,
        useDataHookForPay: false,
        useDataHookForCashOut: false,
      },
    });
    if (!result.success)
      result.error.issues.forEach((issue) =>
        ctx.addIssue({ ...issue, code: 'custom', message: issue.message }),
      );
  });
export const deploy721HookSchema = z
  .object({
    ...revTieredConfigSchema.shape.baseline721HookConfiguration.shape,
    flags: revTieredConfigSchema.shape.baseline721HookConfiguration.shape.flags.extend({
      issueTokensForSplits: z.boolean(),
    }),
  })
  .strict();
export const prepare721LaunchSchema = z
  .object({
    chainId: chainIdSchema,
    account: nonzero,
    owner: nonzero,
    deployTiersHookConfig: deploy721HookSchema,
    projectUri: z.string().max(4096),
    rulesetConfigurations: z.array(payHookRulesetSchema).min(1).max(16),
    terminalConfigurations: terminalConfigurationsSchema,
    memo: z.string().max(4096).default(''),
    salt: hashSchema,
  })
  .strict()
  .superRefine(requireLimitsOnAcceptedContexts);
export const prepareOmnichainLaunchSchema = z
  .object({
    chainIds: z
      .array(chainIdSchema)
      .min(2)
      .max(4)
      .refine((ids) => new Set(ids).size === ids.length, 'Chain IDs must be unique.')
      .describe('Every chain the project launches on, all mainnets or all testnets.'),
    account: nonzero.describe('The one address that signs on every chain.'),
    owner: nonzero,
    projectUri: z
      .string()
      .max(4096)
      .describe('Pinned metadata URI (ipfs://<cid>), or empty to set it later.'),
    rulesetConfigurations: rulesetConfigurationsSchema,
    terminalConfigurations: terminalConfigurationsSchema,
    memo: z.string().max(4096).default(''),
    salt: hashSchema
      .refine((value) => value !== zeroHash, 'A nonzero salt is required: zero skips suckers.')
      .describe(
        'One random salt shared by every chain. Suckers pair only with the same salt and signer.',
      ),
    bridge: suckerBridgeSchema.default('ccip'),
    deployTiersHookConfig: deploy721HookSchema
      .optional()
      .describe(
        'NFT tiers collection. Omitted: an empty collection priced in the first baseCurrency.',
      ),
    useDataHookForCashOut: z
      .boolean()
      .default(false)
      .describe('Let NFTs cash out for surplus. Needs deployTiersHookConfig.'),
  })
  .strict()
  .superRefine(requireLimitsOnAcceptedContexts)
  .refine((value) => !value.useDataHookForCashOut || value.deployTiersHookConfig, {
    path: ['useDataHookForCashOut'],
    message: 'useDataHookForCashOut needs deployTiersHookConfig.',
  });
export function toPayHookRuleset(value: z.output<typeof payHookRulesetSchema>) {
  const converted = toRulesetConfig({
    ...value,
    metadata: { ...value.metadata, dataHook: zeroAddress, useDataHookForPay: false },
  });
  const { dataHook: _hook, useDataHookForPay: _pay, ...metadata } = converted.metadata;
  return { ...converted, metadata };
}
export function toDeploy721Hook(value: z.output<typeof deploy721HookSchema>) {
  return {
    ...value,
    tiersConfig: {
      tiers: value.tiersConfig.tiers.map(toTier),
      currency: Number(value.tiersConfig.currency),
      decimals: Number(value.tiersConfig.decimals),
    },
  };
}

const toSplit = (s: z.output<typeof splitSchema>) => ({
  ...s,
  percent: Number(s.percent),
  projectId: BigInt(s.projectId),
  lockedUntil: Number(s.lockedUntil),
});
export function toTier(t: z.output<typeof tierConfigSchema>) {
  return {
    ...t,
    price: BigInt(t.price),
    initialSupply: Number(t.initialSupply),
    votingUnits: Number(t.votingUnits),
    reserveFrequency: Number(t.reserveFrequency),
    category: Number(t.category),
    discountPercent: Number(t.discountPercent),
    splitPercent: Number(t.splitPercent),
    splits: t.splits.map(toSplit),
  };
}
export function toRevConfig(c: z.output<typeof revConfigSchema>): REVConfig {
  return {
    ...c,
    baseCurrency: Number(c.baseCurrency),
    stageConfigurations: c.stageConfigurations.map((s) => ({
      ...s,
      startsAtOrAfter: Number(s.startsAtOrAfter),
      autoIssuances: s.autoIssuances.map((a) => ({
        ...a,
        chainId: Number(a.chainId),
        count: BigInt(a.count),
      })),
      splitPercent: Number(s.splitPercent),
      splits: s.splits.map(toSplit),
      initialIssuance: BigInt(s.initialIssuance),
      issuanceCutFrequency: Number(s.issuanceCutFrequency),
      issuanceCutPercent: Number(s.issuanceCutPercent),
      cashOutTaxRate: Number(s.cashOutTaxRate),
      extraMetadata: Number(s.extraMetadata),
    })),
  };
}
export function toRevSucker(c: z.output<typeof revSuckerConfigSchema>): REVSuckerDeploymentConfig {
  return {
    ...c,
    deployerConfigurations: c.deployerConfigurations.map((d) => ({
      ...d,
      mappings: d.mappings.map((m) => ({ ...m, minGas: Number(m.minGas) })),
    })),
  };
}
export function toRevTiered(
  c: z.output<typeof revTieredConfigSchema>,
): REVDeploy721TiersHookConfig {
  const b = c.baseline721HookConfiguration;
  return {
    ...c,
    baseline721HookConfiguration: {
      ...b,
      tiersConfig: {
        tiers: b.tiersConfig.tiers.map(toTier),
        currency: Number(b.tiersConfig.currency),
        decimals: Number(b.tiersConfig.decimals),
      },
    },
  };
}

/** Validate the exact factory clone runtime, then immutable links and project association. A STORE getter alone proves nothing. */
export async function verify721Hook(client: PublicClient, project: ProjectRef, hook: Address) {
  const implementation = v6Address('JB721TiersHook', project.chainId);
  const code = await client.getBytecode({ address: hook });
  const expected =
    `0x3d3d3d3d363d3d37363d73${implementation.slice(2)}5af43d3d93803e602a57fd5bf3`.toLowerCase();
  if (!code || code.toLowerCase() !== expected)
    throw new DomainError(
      'UNSUPPORTED_721_HOOK',
      'The project hook is not an exact canonical V6 tiers implementation clone.',
    );
  const implementationCode = await client.getBytecode({ address: implementation });
  if (!implementationCode || implementationCode === '0x')
    throw new DomainError(
      'DEPLOYMENT_UNAVAILABLE',
      'The canonical NFT implementation has no bytecode at this block.',
    );
  const [store, directory, actualProjectId, metadataIdTarget, pricing] = await Promise.all([
    client.readContract({ address: hook, abi: jb721TiersHookAbi, functionName: 'STORE' }),
    client.readContract({ address: hook, abi: jb721TiersHookAbi, functionName: 'DIRECTORY' }),
    client.readContract({ address: hook, abi: jb721TiersHookAbi, functionName: 'projectId' }),
    client.readContract({
      address: hook,
      abi: jb721TiersHookAbi,
      functionName: 'METADATA_ID_TARGET',
    }),
    client.readContract({ address: hook, abi: jb721TiersHookAbi, functionName: 'pricingContext' }),
  ]);
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (
    !eq(store, v6Address('JB721TiersHookStore', project.chainId)) ||
    !eq(directory, v6Address('JBDirectory', project.chainId)) ||
    actualProjectId !== BigInt(project.projectId) ||
    !eq(metadataIdTarget, implementation)
  )
    throw new DomainError(
      'INVALID_721_IDENTITY',
      'The NFT hook does not match the canonical store, directory, implementation metadata target, and project.',
    );
  return {
    hook,
    store,
    metadataIdTarget,
    pricing: { currency: Number(pricing[0]), decimals: Number(pricing[1]) },
  };
}
