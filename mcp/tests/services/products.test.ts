import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  NATIVE_TOKEN,
  jb721TiersHookAbi,
  jb721TiersHookProjectDeployerAbi,
  jbMultiTerminalAbi,
  revDeployerAbi,
  revOwnerAbi,
} from '@bananapus/nana-sdk-core';
import { build721PayMetadata, buildRulesetMetadata, v6Address } from '@bananapus/nana-sdk-core/v6';
import {
  decodeFunctionData,
  getContractAddress,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { ProductService } from '../../src/services/products.js';
import { deploymentAddress, deploymentAddresses } from '../../src/services/rollout.js';
import {
  get721ShopSchema,
  pay721Schema,
  prepare721LaunchSchema,
  prepareAdjustTiersSchema,
  prepareRevnetDeploySchema,
  revAllowedPostSchema,
  tierConfigSchema,
  verify721Hook,
} from '../../src/domain/products.js';
import type { BlockEvidence, ChainId, RpcProvider } from '../../src/domain/types.js';

const currentResolverRuntime =
  `0x${gunzipSync(Buffer.from(JSON.parse(readFileSync(new URL('./fixtures/router-resolver-1.3.json', import.meta.url), 'utf8')).runtimeGzipBase64, 'base64')).toString('hex')}` as Hex;

// Offline canonical JBPayRouteResolver runtime fixture (deploy-all-v6 artifact, DIRECTORY immutables patched).
// Keep the real bytes so converted-route tests exercise the production code-hash check.
const resolverRuntime =
  `0x${gunzipSync(Buffer.from('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', 'base64')).toString('hex')}` as Hex;

const account = '0x1111111111111111111111111111111111111111' as const;
const beneficiary = '0x2222222222222222222222222222222222222222' as const;
const hook = '0x3333333333333333333333333333333333333333' as const;
const project = { chainId: 8453, projectId: '12', version: 6 } as const;
const hash = `0x${'ab'.repeat(32)}` as Hex;
const tierFlags = {
  allowOwnerMint: false,
  useReserveBeneficiaryAsDefault: false,
  transfersPausable: true,
  useVotingUnits: false,
  cantBeRemoved: false,
  cantIncreaseDiscountPercent: false,
  cantBuyWithCredits: false,
};
const collectionFlags = {
  noNewTiersWithVotes: false,
  noNewTiersWithReserves: false,
  noNewTiersWithOwnerMinting: false,
  preventOverspending: false,
  issueTokensForSplits: false,
};
const tierConfig = {
  price: '100',
  initialSupply: '10',
  votingUnits: '0',
  reserveFrequency: '0',
  reserveBeneficiary: zeroAddress,
  encodedIpfsUri: hash,
  category: '1',
  discountPercent: '25',
  flags: tierFlags,
  splitPercent: '0',
  splits: [],
};
const tier = {
  id: 1,
  price: 100n,
  remainingSupply: 10,
  initialSupply: 10,
  votingUnits: 100n,
  reserveFrequency: 0,
  reserveBeneficiary: zeroAddress,
  encodedIpfsUri: hash,
  category: 1,
  discountPercent: 25,
  flags: {
    allowOwnerMint: false,
    transfersPausable: true,
    cantBeRemoved: false,
    cantIncreaseDiscountPercent: false,
    cantBuyWithCredits: false,
  },
  splitPercent: 0,
  resolvedUri: '',
};
const pay = { project, account, beneficiary, token: NATIVE_TOKEN, amount: '88', tierIds: ['1'] };
const stage = {
  startsAtOrAfter: '2000',
  autoIssuances: [],
  splitPercent: '0',
  splits: [],
  initialIssuance: '1000000000000000000000',
  issuanceCutFrequency: '86400',
  issuanceCutPercent: '100000000',
  cashOutTaxRate: '1000',
  extraMetadata: '4',
};
const deploy = {
  chainId: 8453 as const,
  account,
  config: {
    description: { name: 'Fruit', ticker: 'FRUIT', uri: 'ipfs://fruit', salt: hash },
    baseCurrency: '1',
    operator: account,
    scopeCashOutsToLocalBalances: false,
    stageConfigurations: [stage],
  },
  accountingContexts: [{ token: NATIVE_TOKEN, decimals: '18', currency: '61166' }],
  suckerConfig: { salt: hash, deployerConfigurations: [] },
};

type Request = {
  functionName: string;
  args?: readonly unknown[];
  account?: Address;
  address: Address;
};
function fixture(
  options: {
    chainId?: ChainId;
    revnet?: boolean;
    noHook?: boolean;
    falseOwner?: boolean;
    fakeCode?: boolean;
    metadataTarget?: Address;
    projectId?: bigint;
    store?: Address;
    errorOn?: string;
    flags?: Partial<typeof collectionFlags>;
    flagsTier?: Partial<typeof tier.flags>;
    normalized?: bigint;
    credits?: bigint;
    leftover?: bigint;
    restrictedCost?: bigint;
    mintError?: boolean;
    amountToIssue?: bigint;
    stageStart?: number;
    permission?: boolean;
    maxTier?: bigint;
    fee?: bigint;
    currency?: number;
    decimals?: number;
    pricingCurrency?: number;
    pricingDecimals?: number;
    prices?: Address;
    allowance?: bigint;
    primaryTerminal?: Address;
    registryTarget?: Address;
    sourceToken?: Address;
    noCode?: Address;
    convertedToken?: Address;
    convertedAmount?: bigint;
    wrongResolverCode?: boolean;
    currentResolverCode?: boolean;
    routeMismatch?: boolean;
    invalidPriceCurrency?: bigint;
  } = {},
) {
  const chainId = options.chainId ?? project.chainId;
  const implementation = v6Address('JB721TiersHook', chainId);
  const controller = v6Address('JBController', chainId);
  const owner = v6Address('REVOwner', chainId);
  const ruleset = {
    id: 3,
    cycleNumber: 1,
    basedOnId: 0,
    start: options.stageStart ?? 10,
    duration: 86400,
    weight: 1_000n,
    weightCutPercent: 100_000_000,
    approvalHook: zeroAddress,
    metadata: 0n,
  };
  const metadata = {
    useDataHookForPay: !options.noHook,
    useDataHookForCashOut: options.revnet ?? false,
    dataHook: options.noHook ? zeroAddress : options.revnet ? owner : hook,
  };
  const readContract = vi.fn(async (request: Request): Promise<unknown> => {
    if (options.errorOn === request.functionName) throw new Error('RPC unavailable');
    switch (request.functionName) {
      case 'controllerOf':
        return controller;
      case 'ownerOf':
        return options.revnet && !options.falseOwner ? owner : account;
      case 'owner':
        return beneficiary;
      case 'hashedEncodedConfigurationOf':
        return options.revnet ? hash : zeroHash;
      case 'currentRulesetOf':
        return [ruleset, metadata];
      case 'allRulesetsOf':
        return [{ ruleset, metadata }];
      case 'getRulesetOf':
        return [ruleset, metadata];
      case 'STORE':
        return options.store ?? v6Address('JB721TiersHookStore', chainId);
      case 'DIRECTORY':
        return v6Address('JBDirectory', chainId);
      case 'ROUTER':
        return deploymentAddress('JBRouterTerminal', chainId)!;
      case 'projectId':
        return options.projectId ?? 12n;
      case 'METADATA_ID_TARGET':
        return options.metadataTarget ?? implementation;
      case 'pricingContext':
        return [options.pricingCurrency ?? 61166, options.pricingDecimals ?? 18];
      case 'tiersOf':
        return [tier];
      case 'tierOf':
        return { ...tier, flags: { ...tier.flags, ...options.flagsTier } };
      case 'flagsOf':
        return { ...collectionFlags, ...options.flags };
      case 'tokenUriResolverOf':
        return zeroAddress;
      case 'baseURI':
        return 'ipfs://';
      case 'contractURI':
        return 'ipfs://shop';
      case 'primaryTerminalOf':
        return options.primaryTerminal ?? v6Address('JBMultiTerminal', chainId);
      case 'terminalOf':
        return options.registryTarget ?? v6Address('JBMultiTerminal', chainId);
      case 'wrappedNativeToken':
        return beneficiary;
      case 'previewBestPayRoute':
        return [
          v6Address('JBMultiTerminal', chainId),
          options.convertedToken ?? account,
          options.convertedAmount ?? 88n,
          ruleset,
          options.routeMismatch ? 999n : 101n,
          10n,
          [{ hook, noop: false, amount: 0n, metadata: '0x' }],
        ];
      case 'terminalsOf':
        return [v6Address('JBMultiTerminal', chainId)];
      case 'previewPayFor':
        return [ruleset, 101n, 10n, [{ hook, noop: false, amount: 0n, metadata: '0x' }]];
      case 'accountingContextForTokenOf':
        return {
          token: options.sourceToken ?? request.args?.[1],
          currency: options.currency ?? 61166,
          decimals: options.decimals ?? 18,
        };
      case 'PRICES':
        return options.prices ?? v6Address('JBPrices', chainId);
      case 'payCreditsOf':
        return options.credits ?? 0n;
      case 'pricePerUnitOf':
        return options.invalidPriceCurrency === request.args?.[2]
          ? 0n
          : (options.normalized ?? 10n ** 18n);
      case 'allowance':
        return options.allowance ?? 0n;
      case 'BUYBACK_HOOK':
        return v6Address('JBBuybackHookRegistry', chainId);
      case 'hookOf':
        return zeroAddress;
      case 'tiered721HookOf':
        return hook;
      case 'cashOutDelayOf':
        return 2000n;
      case 'LOANS':
        return v6Address('REVLoans', chainId);
      case 'HOOK_DEPLOYER':
        return v6Address('JB721TiersHookDeployer', chainId);
      case 'deployer':
        return v6Address('REVDeployer', chainId);
      case 'isOperatorOf':
        return true;
      case 'amountToAutoIssue':
        return options.amountToIssue ?? 150n;
      case 'hasPermissions':
        return options.permission ?? true;
      case 'maxTierIdOf':
        return options.maxTier ?? 3n;
      case 'reserveBeneficiaryOf':
        return zeroAddress;
      case 'creationFee':
        return options.fee ?? 17n;
      case 'decimals':
        return options.decimals ?? 18;
      case 'suckerDeployerIsAllowed':
        return true;
      default:
        throw new Error(`Unexpected read ${request.functionName}`);
    }
  });
  const simulateContract = vi.fn(async (request: Request) => {
    if (options.mintError) throw new Error('InsufficientSupplyRemaining');
    if (request.functionName !== 'recordMint')
      throw new Error(`Unexpected simulation ${request.functionName}`);
    return {
      result: [
        (request.args?.[1] as number[]).map((id, i) => BigInt(id) * 1_000_000_000n + BigInt(i + 1)),
        options.leftover ?? 0n,
        options.restrictedCost ?? 0n,
      ],
    };
  });
  const getBytecode = vi.fn(async ({ address }: { address: Address }) => {
    if (options.noCode?.toLowerCase() === address.toLowerCase()) return undefined;
    if (
      deploymentAddresses('JBRouterTerminal', chainId).some(
        (router) =>
          address.toLowerCase() === getContractAddress({ from: router, nonce: 1n }).toLowerCase(),
      )
    )
      return options.wrongResolverCode
        ? '0x6000'
        : options.currentResolverCode
          ? currentResolverRuntime
          : resolverRuntime;
    return address === hook
      ? options.fakeCode
        ? '0x6000'
        : `0x3d3d3d3d363d3d37363d73${implementation.slice(2)}5af43d3d93803e602a57fd5bf3`
      : '0x6000';
  });
  const client = { readContract, simulateContract, getBytecode } as unknown as PublicClient;
  const evidence: BlockEvidence = {
    chainId,
    blockNumber: '123',
    blockHash: hash,
    timestamp: '1000',
    source: 'rpc',
  };
  const snapshot = vi.fn(async () => ({ client, evidence }));
  const rpc: RpcProvider = { snapshot, client: () => client };
  return {
    service: new ProductService(rpc),
    client,
    readContract,
    simulateContract,
    snapshot,
    evidence,
  };
}

describe('verified per-chain NFT shops', () => {
  it('derives revnet identity and exposes complete tier economics with discount denominator 200', async () => {
    const f = fixture({ revnet: true });
    const shop = await f.service.get721Shop({
      project,
      categories: ['1'],
      startingId: '5',
      size: 7,
    });
    expect(shop.isRevnet).toBe(true);
    expect(shop.shop?.tiers[0]).toMatchObject({
      effectivePrice: '88',
      flags: tier.flags,
      remainingSupply: 10,
      splitPercent: 0,
    });
    expect(shop.shop?.metadataIdTarget).toBe(v6Address('JB721TiersHook', project.chainId));
    expect(shop.evidence).toEqual([f.evidence]);
    expect(f.readContract.mock.calls.find(([r]) => r.functionName === 'tiersOf')?.[0].args).toEqual(
      [hook, [1n], false, 5n, 7n],
    );
    expect(get721ShopSchema.safeParse({ project, isRevnet: false }).success).toBe(false);
    expect(pay721Schema.safeParse({ ...pay, metadataIdTarget: hook }).success).toBe(false);
  });
  it('rejects fake getters, wrong clone metadata target, store and project association', async () => {
    for (const options of [
      { fakeCode: true },
      { metadataTarget: hook },
      { store: account },
      { projectId: 13n },
    ]) {
      await expect(fixture(options).service.get721Shop({ project })).rejects.toThrow();
    }
    await expect(
      fixture({ revnet: true, falseOwner: true }).service.get721Shop({ project }),
    ).rejects.toThrow('deployer record');
    const f = fixture({ noCode: v6Address('JB721TiersHook', project.chainId) });
    await expect(verify721Hook(f.client, project, hook)).rejects.toThrow('no bytecode');
  });
  it('preserves authoritative no-shop and upstream failures as distinct states', async () => {
    expect((await fixture({ noHook: true }).service.get721Shop({ project })).shop).toBeNull();
    await expect(
      fixture({ errorOn: 'pricingContext' }).service.get721Shop({ project }),
    ).rejects.toThrow('RPC unavailable');
  });
});

describe('721 payment preparation', () => {
  it('uses implementation metadata target, pinned SDK payment route, and exact store feasibility', async () => {
    const f = fixture();
    const plan = await f.service.prepare721Pay(pay);
    const metadata = build721PayMetadata({
      metadataIdTarget: v6Address('JB721TiersHook', project.chainId),
      tierIdsToMint: [1n],
      allowOverspending: false,
    });
    expect(
      decodeFunctionData({ abi: jbMultiTerminalAbi, data: plan.calls[0]!.data }).args?.[6],
    ).toBe(metadata);
    expect(metadata).not.toBe(
      build721PayMetadata({
        metadataIdTarget: hook,
        tierIdsToMint: [1n],
        allowOverspending: false,
      }),
    );
    expect(f.snapshot).toHaveBeenCalledOnce();
    expect(f.simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({
        account: hook,
        functionName: 'recordMint',
        args: [88n, [1], false],
      }),
    );
    expect(plan.summary).toMatchObject({
      normalizedPayment: '88',
      usableNFTCredits: '0',
      indicativeTokenIds: ['1000000001'],
      metadata,
    });
  });
  it('applies NFT credits only when payer equals beneficiary and enforces fresh-credit restrictions', async () => {
    const gifts = fixture({ credits: 100n });
    await gifts.service.prepare721Pay(pay);
    expect(gifts.simulateContract.mock.calls[0]?.[0].args?.[0]).toBe(88n);
    const own = fixture({ credits: 100n });
    await own.service.prepare721Pay({ ...pay, beneficiary: account });
    expect(own.simulateContract.mock.calls[0]?.[0].args?.[0]).toBe(188n);
    await expect(fixture({ restrictedCost: 89n }).service.prepare721Pay(pay)).rejects.toThrow(
      'fresh payment',
    );
  });
  it('normalizes both decimal and currency conversion with canonical integer rounding', async () => {
    const decimals = fixture({ pricingDecimals: 6 });
    await decimals.service.prepare721Pay({ ...pay, amount: '88000000000001' });
    expect(decimals.simulateContract.mock.calls[0]?.[0].args?.[0]).toBe(88n);
    const currency = fixture({
      pricingCurrency: 2,
      pricingDecimals: 6,
      normalized: 2_000_000_000_000_000n,
    });
    await currency.service.prepare721Pay({ ...pay, amount: '1000000000000000000' });
    expect(currency.simulateContract.mock.calls[0]?.[0].args?.[0]).toBe(500_000_000n);
    expect(
      currency.readContract.mock.calls.find(([r]) => r.functionName === 'pricePerUnitOf')?.[0].args,
    ).toEqual([12n, 61166n, 2n, 18n]);
    await expect(
      fixture({ pricingCurrency: 2, prices: zeroAddress }).service.prepare721Pay(pay),
    ).rejects.toThrow('silently skip NFTs');
  });
  it('rejects reserve/supply failures and overspending; allows explicitly reviewed excess', async () => {
    await expect(fixture({ mintError: true }).service.prepare721Pay(pay)).rejects.toThrow(
      'InsufficientSupplyRemaining',
    );
    await expect(fixture({ leftover: 1n }).service.prepare721Pay(pay)).rejects.toThrow(
      'overspending',
    );
    await expect(
      fixture({ leftover: 1n, flags: { preventOverspending: true } }).service.prepare721Pay({
        ...pay,
        allowOverspending: true,
      }),
    ).rejects.toThrow('overspending');
    expect(
      (await fixture({ leftover: 1n }).service.prepare721Pay({ ...pay, allowOverspending: true }))
        .summary,
    ).toMatchObject({ leftoverNFTCredits: '1' });
  });
  it('resolves registry-forwarded accounting and approves the registry rather than its destination', async () => {
    const registry = v6Address('JBRouterTerminalRegistry', project.chainId);
    const f = fixture({ primaryTerminal: registry });
    const plan = await f.service.prepare721Pay({ ...pay, token: account });
    expect(plan.calls).toHaveLength(2);
    expect(plan.calls[1]!.to).toBe(registry);
    expect(plan.summary).toMatchObject({
      destination: {
        terminal: v6Address('JBMultiTerminal', project.chainId),
        token: account,
        amount: '88',
        route: 'registry-forward',
      },
    });
  });
  it('verifies the deterministic router resolver runtime and prices NFTs using its actual outgoing token and amount', async () => {
    const router = v6Address('JBRouterTerminal', project.chainId);
    const f = fixture({ primaryTerminal: router, convertedAmount: 88n, convertedToken: account });
    const plan = await f.service.prepare721Pay({ ...pay, amount: '123' });
    expect(f.snapshot).toHaveBeenCalledOnce();
    expect(plan.calls[0]!.value).toBe('123');
    expect(plan.calls[0]!.to).toBe(router);
    expect(
      f.readContract.mock.calls.find(([r]) => r.functionName === 'accountingContextForTokenOf')?.[0]
        .args,
    ).toEqual([12n, account]);
    expect(f.simulateContract.mock.calls[0]?.[0].args?.[0]).toBe(88n);
    expect(plan.summary).toMatchObject({
      destination: { route: 'router-conversion', token: account, amount: '88' },
      normalizedPayment: '88',
    });
    await expect(
      fixture({ primaryTerminal: router, wrongResolverCode: true }).service.prepare721Pay(pay),
    ).rejects.toThrow('route resolver');
    await expect(
      fixture({ primaryTerminal: router, routeMismatch: true }).service.prepare721Pay(pay),
    ).rejects.toThrow('disagrees');
  });
  it('uses the immediate terminal payer for routed NFT credits, preserving the beneficiary’s unused credits', async () => {
    for (const primaryTerminal of [
      v6Address('JBRouterTerminalRegistry', project.chainId),
      v6Address('JBRouterTerminal', project.chainId),
    ]) {
      const f = fixture({ primaryTerminal, credits: 100n, leftover: 0n });
      const plan = await f.service.prepare721Pay({ ...pay, beneficiary: account });
      expect(f.simulateContract.mock.calls[0]?.[0].args?.[0]).toBe(88n);
      expect(plan.summary).toMatchObject({
        usableNFTCredits: '0',
        resultingNFTCredits: '100',
        destination: { payer: primaryTerminal },
      });
    }
  });
  it('follows the executed gateway to its router for NFT conversion and preserves gateway custody warnings', async () => {
    const chainId = 11155111;
    const registry = v6Address('JBRouterTerminalRegistry', chainId);
    const gateway = deploymentAddress('JBRouterTerminalGateway', chainId)!;
    const router = deploymentAddress('JBRouterTerminal', chainId)!;
    const f = fixture({
      chainId,
      primaryTerminal: registry,
      registryTarget: gateway,
      convertedToken: account,
      convertedAmount: 88n,
      currentResolverCode: true,
    });
    const plan = await f.service.prepare721Pay({
      ...pay,
      project: { ...project, chainId },
      amount: '123',
    });
    expect(plan.calls[0]!.to).toBe(registry);
    expect(plan.summary).toMatchObject({
      destination: {
        gateway,
        terminalPath: [registry, gateway, router],
        payer: router,
        token: account,
        amount: '88',
      },
      normalizedPayment: '88',
    });
    expect(plan.warnings.some((warning) => warning.includes('remain in custody'))).toBe(true);
    expect(
      f.readContract.mock.calls.find(
        ([request]) => request.functionName === 'previewBestPayRoute',
      )?.[0].args?.[0],
    ).toBe(router);
  });
});

describe('revnet reads and auto-issuance', () => {
  it('reports immutable stage economics, candidate operator verification, and active delay without inventing operator history', async () => {
    const f = fixture({ revnet: true });
    const revnet = await f.service.getRevnet({ project, operator: account });
    expect(revnet).toMatchObject({
      configurationHash: hash,
      operator: { candidate: account, isOperator: true },
      cashOutDelay: { until: '2000', active: true, appliesToLoans: true },
    });
    expect((await f.service.getRevnet({ project })).operator).toMatchObject({ status: 'unknown' });
    await expect(fixture().service.getRevnet({ project })).rejects.toThrow('No canonical revnet');
  });
  it('encodes the ruleset stage ID and verifies pending claim/start before preparing', async () => {
    const input = { project, account, beneficiary, stageId: '3' };
    const plan = await fixture({ revnet: true }).service.prepareAutoIssue(input);
    expect(plan.summary).toMatchObject({ stageId: '3', amount: '150', beneficiary });
    expect(decodeFunctionData({ abi: revOwnerAbi, data: plan.calls[0]!.data })).toMatchObject({
      functionName: 'autoIssueFor',
      args: [12n, 3n, beneficiary],
    });
    await expect(
      fixture({ revnet: true, amountToIssue: 0n }).service.prepareAutoIssue(input),
    ).rejects.toThrow('no pending');
    await expect(
      fixture({ revnet: true, stageStart: 2000 }).service.prepareAutoIssue(input),
    ).rejects.toThrow('has not started');
    await expect(
      fixture({ revnet: true }).service.prepareAutoIssue({ ...input, stageId: '1' }),
    ).rejects.toThrow('exact stage');
  });
});

describe('NFT tier management validation', () => {
  const input = { project, account, tiersToAdd: [tierConfig], tierIdsToRemove: [] };
  it('preserves category order, full tier configuration, permission account and chain scope', async () => {
    const f = fixture();
    const plan = await f.service.prepareAdjustTiers(input);
    const decoded = decodeFunctionData({ abi: jb721TiersHookAbi, data: plan.calls[0]!.data });
    expect(decoded).toMatchObject({ functionName: 'adjustTiers' });
    expect(decoded.args?.[0]).toMatchObject([
      { price: 100n, discountPercent: 25, initialSupply: 10, category: 1 },
    ]);
    expect(plan.summary).toMatchObject({ firstNewTierId: '4', hook, project });
    expect(
      f.readContract.mock.calls.find(([r]) => r.functionName === 'hasPermissions')?.[0].args,
    ).toEqual([account, beneficiary, 12n, [24n], true, true]);
    expect(
      prepareAdjustTiersSchema.safeParse({
        ...input,
        tiersToAdd: [{ ...tierConfig, category: '2' }, tierConfig],
      }).success,
    ).toBe(false);
  });
  it('rejects lifetime limits, reserved singletons, excessive discounts, permission failures and protected tiers', async () => {
    expect(tierConfigSchema.safeParse({ ...tierConfig, initialSupply: '1000000000' }).success).toBe(
      false,
    );
    expect(
      tierConfigSchema.safeParse({ ...tierConfig, initialSupply: '1', reserveFrequency: '5' })
        .success,
    ).toBe(false);
    expect(tierConfigSchema.safeParse({ ...tierConfig, discountPercent: '201' }).success).toBe(
      false,
    );
    await expect(fixture({ maxTier: 65535n }).service.prepareAdjustTiers(input)).rejects.toThrow(
      '65,535',
    );
    await expect(fixture({ permission: false }).service.prepareAdjustTiers(input)).rejects.toThrow(
      'ADJUST_721_TIERS',
    );
    await expect(
      fixture({ flagsTier: { cantBeRemoved: true } }).service.prepareAdjustTiers({
        ...input,
        tiersToAdd: [],
        tierIdsToRemove: ['1'],
      }),
    ).rejects.toThrow('protected');
  });
  it('honors price-derived voting units and reserve beneficiary requirements', async () => {
    await expect(
      fixture({ flags: { noNewTiersWithVotes: true } }).service.prepareAdjustTiers(input),
    ).rejects.toThrow('price-derived');
    await expect(
      fixture().service.prepareAdjustTiers({
        ...input,
        tiersToAdd: [{ ...tierConfig, reserveFrequency: '5' }],
      }),
    ).rejects.toThrow('beneficiary');
    await expect(
      fixture().service.prepareAdjustTiers({
        ...input,
        tiersToAdd: [
          {
            ...tierConfig,
            reserveBeneficiary: account,
            flags: { ...tierFlags, useReserveBeneficiaryAsDefault: true },
          },
          { ...tierConfig, reserveFrequency: '5' },
        ],
      }),
    ).rejects.toThrow('beneficiary');
    await expect(
      fixture().service.prepareAdjustTiers({
        ...input,
        tiersToAdd: [
          {
            ...tierConfig,
            reserveFrequency: '5',
            reserveBeneficiary: account,
            flags: { ...tierFlags, useReserveBeneficiaryAsDefault: true },
          },
          { ...tierConfig, reserveFrequency: '5' },
        ],
      }),
    ).resolves.toMatchObject({ operation: '721_adjust_tiers' });
  });
});

describe('new revnet deployment', () => {
  it('reads each chain’s exact current creation fee and preserves complete immutable config', async () => {
    for (const [chainId, fee] of [
      [8453, 17n],
      [10, 43n],
    ] as const) {
      const plan = await fixture({ chainId, fee }).service.prepareRevnetDeploy({
        ...deploy,
        chainId,
      });
      expect(plan.calls[0]!.value).toBe(String(fee));
      expect(plan.calls[0]!.chainId).toBe(chainId);
      const decoded = decodeFunctionData({ abi: revDeployerAbi, data: plan.calls[0]!.data });
      expect(decoded.functionName).toBe('deployFor');
      expect(decoded.args?.[0]).toBe(0n);
      expect(decoded.args?.[1]).toMatchObject({
        baseCurrency: 1,
        stageConfigurations: [{ startsAtOrAfter: 2000, initialIssuance: 1000000000000000000000n }],
      });
    }
  });
  it('validates uint widths, exact stage starts, irreversible tax cap and full cross-chain stage rows', () => {
    const config = deploy.config;
    for (const patch of [
      { startsAtOrAfter: '0' },
      { cashOutTaxRate: '10000' },
      { initialIssuance: String(1n << 112n) },
      { splitPercent: '1' },
    ]) {
      expect(
        prepareRevnetDeploySchema.safeParse({
          ...deploy,
          config: { ...config, stageConfigurations: [{ ...stage, ...patch }] },
        }).success,
      ).toBe(false);
    }
    expect(
      prepareRevnetDeploySchema.safeParse({
        ...deploy,
        config: { ...config, stageConfigurations: [stage, stage] },
      }).success,
    ).toBe(false);
    expect(prepareRevnetDeploySchema.safeParse({ ...deploy, revnetId: '12' }).success).toBe(false);
    expect(
      prepareRevnetDeploySchema.safeParse({
        ...deploy,
        config: { ...config, stageConfigurations: [{ ...stage, extraMetadata: '0' }] },
        suckerConfig: {
          salt: hash,
          deployerConfigurations: [
            {
              deployer: account,
              peer: zeroHash,
              mappings: [{ localToken: NATIVE_TOKEN, minGas: '200000', remoteToken: hash }],
            },
          ],
        },
      }).success,
    ).toBe(false);
  });
  it('requires explicit non-ETH store pricing and detects missing price feeds', async () => {
    await expect(
      fixture().service.prepareRevnetDeploy({
        ...deploy,
        config: { ...deploy.config, baseCurrency: '2' },
      }),
    ).rejects.toThrow('explicit tiered721Config');
    await expect(fixture({ normalized: 0n }).service.prepareRevnetDeploy(deploy)).rejects.toThrow(
      'nonzero base-currency',
    );
    await expect(
      fixture().service.prepareRevnetDeploy({
        ...deploy,
        accountingContexts: [{ token: NATIVE_TOKEN, decimals: '18', currency: '1' }],
      }),
    ).resolves.toMatchObject({ operation: 'revnet_deploy' });
    await expect(
      fixture({ errorOn: 'creationFee' }).service.prepareRevnetDeploy(deploy),
    ).rejects.toThrow('RPC unavailable');
  });
  it('encodes full six-argument NFT revnets and rejects untyped extra fields', async () => {
    const tiered721Config = {
      baseline721HookConfiguration: {
        name: 'Store',
        symbol: 'STORE',
        baseUri: 'ipfs://',
        tokenUriResolver: zeroAddress,
        contractUri: 'ipfs://store',
        tiersConfig: { tiers: [tierConfig], currency: '2', decimals: '6' },
        flags: {
          noNewTiersWithReserves: false,
          noNewTiersWithVotes: false,
          noNewTiersWithOwnerMinting: false,
          preventOverspending: false,
        },
      },
      salt: hash,
      preventOperatorAdjustingTiers: false,
      preventOperatorUpdatingMetadata: false,
      preventOperatorMinting: true,
      preventOperatorIncreasingDiscountPercent: false,
    };
    const plan = await fixture().service.prepareRevnetDeploy({
      ...deploy,
      config: { ...deploy.config, baseCurrency: '2' },
      tiered721Config,
    });
    const decoded = decodeFunctionData({ abi: revDeployerAbi, data: plan.calls[0]!.data });
    expect(decoded.args).toHaveLength(6);
    expect(decoded.args?.[4]).toMatchObject({
      baseline721HookConfiguration: {
        tiersConfig: { currency: 2, decimals: 6, tiers: [{ discountPercent: 25 }] },
      },
      preventOperatorMinting: true,
    });
    expect(
      prepareRevnetDeploySchema.safeParse({
        ...deploy,
        tiered721Config: { ...tiered721Config, admin: account },
      }).success,
    ).toBe(false);
    const explicitPricing = {
      ...tiered721Config,
      baseline721HookConfiguration: {
        ...tiered721Config.baseline721HookConfiguration,
        tiersConfig: { ...tiered721Config.baseline721HookConfiguration.tiersConfig, currency: '3' },
      },
    };
    await expect(
      fixture({ invalidPriceCurrency: 3n }).service.prepareRevnetDeploy({
        ...deploy,
        tiered721Config: explicitPricing,
      }),
    ).rejects.toThrow('NFT-currency');
    const sharedCurrencies = [
      { token: NATIVE_TOKEN, decimals: '18', currency: '1' },
      { token: account, decimals: '6', currency: '2' },
    ];
    await expect(
      fixture({ decimals: 6 }).service.prepareRevnetDeploy({
        ...deploy,
        config: { ...deploy.config, baseCurrency: '2' },
        accountingContexts: sharedCurrencies,
        tiered721Config,
      }),
    ).resolves.toMatchObject({ operation: 'revnet_deploy' });
  });
  it('validates Croptop positive minimum supply and unlimited maximum sentinel', () => {
    const post = {
      category: '1',
      minimumPrice: '0',
      minimumTotalSupply: '1',
      maximumTotalSupply: '0',
      maximumSplitPercent: '0',
      allowedAddresses: [],
    };
    expect(revAllowedPostSchema.safeParse(post).success).toBe(true);
    expect(revAllowedPostSchema.safeParse({ ...post, minimumTotalSupply: '0' }).success).toBe(
      false,
    );
    expect(
      revAllowedPostSchema.safeParse({ ...post, minimumTotalSupply: '2', maximumTotalSupply: '1' })
        .success,
    ).toBe(false);
  });
});

describe('standard project launches with attached 721 tiers', () => {
  const {
    dataHook: _dataHook,
    useDataHookForPay: _usePay,
    ...sdkMetadata
  } = buildRulesetMetadata();
  const metadata = {
    ...sdkMetadata,
    reservedPercent: '0',
    cashOutTaxRate: '0',
    baseCurrency: '1',
    metadata: '0',
  };
  const launch = {
    chainId: 8453 as const,
    account,
    owner: beneficiary,
    salt: hash,
    projectUri: 'ipfs://project',
    deployTiersHookConfig: {
      name: 'Shop',
      symbol: 'SHOP',
      baseUri: 'ipfs://',
      tokenUriResolver: zeroAddress,
      contractUri: 'ipfs://shop',
      tiersConfig: { tiers: [tierConfig], currency: '61166', decimals: '18' },
      flags: { ...collectionFlags, noNewTiersWithVotes: true },
    },
    rulesetConfigurations: [
      {
        mustStartAtOrAfter: '0',
        duration: '0',
        weight: '1000000000000000000000',
        weightCutPercent: '0',
        approvalHook: zeroAddress,
        metadata,
        splitGroups: [],
        fundAccessLimitGroups: [],
      },
    ],
    terminalConfigurations: [
      {
        terminal: v6Address('JBMultiTerminal', 8453),
        accountingContextsToAccept: [{ token: NATIVE_TOKEN, decimals: '18', currency: '61166' }],
      },
    ],
  };
  it('encodes actual deployer metadata fields, exact fee and initial tiers before future noNew flags', async () => {
    const plan = await fixture({ fee: 39n }).service.prepare721Launch(launch);
    expect(plan.calls[0]!.to).toBe(v6Address('JB721TiersHookProjectDeployer', 8453));
    expect(plan.calls[0]!.value).toBe('39');
    const decoded = decodeFunctionData({
      abi: jb721TiersHookProjectDeployerAbi,
      data: plan.calls[0]!.data,
    });
    expect(decoded.functionName).toBe('launchProjectFor');
    if (decoded.functionName !== 'launchProjectFor') throw new Error('Wrong launch selector');
    expect(decoded.args?.[0]).toBe(beneficiary);
    expect(decoded.args?.[1]).toMatchObject({
      tiersConfig: { tiers: [{ price: 100n }] },
      flags: { noNewTiersWithVotes: true },
    });
    expect(decoded.args?.[2]).toMatchObject({
      rulesetConfigurations: [{ metadata: { reservedPercent: 0, useDataHookForCashOut: false } }],
    });
    expect(decoded.args?.[2].rulesetConfigurations[0]?.metadata).not.toHaveProperty('dataHook');
    expect(decoded.args?.[3].toLowerCase()).toBe(v6Address('JBController', 8453).toLowerCase());
    expect(plan.summary).toMatchObject({ owner: beneficiary, creationFee: '39' });
  });
  it('rejects pretending to supply a different pay hook and mismatched launch limits', () => {
    expect(
      prepare721LaunchSchema.safeParse({
        ...launch,
        rulesetConfigurations: [
          { ...launch.rulesetConfigurations[0], metadata: { ...metadata, dataHook: hook } },
        ],
      }).success,
    ).toBe(false);
    expect(
      prepare721LaunchSchema.safeParse({
        ...launch,
        rulesetConfigurations: [
          {
            ...launch.rulesetConfigurations[0],
            fundAccessLimitGroups: [
              { terminal: account, token: NATIVE_TOKEN, payoutLimits: [], surplusAllowances: [] },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });
  it('preserves explicit native ETH and stable USD accounting currencies after real price-path validation', async () => {
    const input = {
      ...launch,
      rulesetConfigurations: [
        { ...launch.rulesetConfigurations[0]!, metadata: { ...metadata, baseCurrency: '2' } },
      ],
      deployTiersHookConfig: {
        ...launch.deployTiersHookConfig,
        tiersConfig: { ...launch.deployTiersHookConfig.tiersConfig, currency: '2', decimals: '6' },
      },
      terminalConfigurations: [
        {
          terminal: v6Address('JBMultiTerminal', 8453),
          accountingContextsToAccept: [
            { token: NATIVE_TOKEN, decimals: '18', currency: '1' },
            { token: account, decimals: '6', currency: '2' },
          ],
        },
      ],
    };
    const f = fixture({ decimals: 6 });
    const plan = await f.service.prepare721Launch(input);
    expect(plan.summary).toMatchObject({
      terminalConfigurations: [
        { accountingContextsToAccept: input.terminalConfigurations[0]!.accountingContextsToAccept },
      ],
    });
    expect(
      f.readContract.mock.calls
        .filter(([r]) => r.functionName === 'pricePerUnitOf')
        .map(([r]) => r.args),
    ).toEqual([
      [0n, 1n, 2n, 18n],
      [0n, 2n, 2n, 6n],
    ]);
  });
  it('fails malformed scalars as validation issues instead of uncaught BigInt conversions', () => {
    expect(() => tierConfigSchema.safeParse({ ...tierConfig, price: 'abc' })).not.toThrow();
    expect(tierConfigSchema.safeParse({ ...tierConfig, price: 'abc' }).success).toBe(false);
    expect(() =>
      prepare721LaunchSchema.safeParse({
        ...launch,
        rulesetConfigurations: [{ ...launch.rulesetConfigurations[0], duration: 'abc' }],
      }),
    ).not.toThrow();
  });
});
