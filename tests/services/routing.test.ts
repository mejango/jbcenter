import { describe, expect, it, vi } from 'vitest';
import {
  jbBuybackHookAbi,
  jbBuybackHookRegistryAbi,
  jbRouterTerminalRegistryAbi,
} from '@bananapus/nana-sdk-core';
import {
  uniswapV4PoolId,
  uniswapV4PoolStateSlot,
  v6Address,
  type JBRulesetWithMetadata,
} from '@bananapus/nana-sdk-core/v6';
import {
  decodeFunctionData,
  numberToHex,
  zeroAddress,
  zeroHash,
  type Address,
  type PublicClient,
} from 'viem';
import { RoutingService, resolveRoutingHooks } from '../../src/services/routing.js';
import type { ProjectRef, RpcProvider, RpcSnapshot } from '../../src/domain/types.js';

const project = { chainId: 1, projectId: '42', version: 6 } as const;
const owner = '0x1111111111111111111111111111111111111111' as const;
const operator = '0x2222222222222222222222222222222222222222' as const;
const projectToken = '0x3333333333333333333333333333333333333333' as const;
const custom = '0x4444444444444444444444444444444444444444' as const;
const manager = '0x5555555555555555555555555555555555555555' as const;
const oracle = '0x6666666666666666666666666666666666666666' as const;
const nft = '0x7777777777777777777777777777777777777777' as const;
const native = '0x000000000000000000000000000000000000EEEe' as const;
const buyback = v6Address('JBBuybackHook', 1);
const registry = v6Address('JBBuybackHookRegistry', 1);
const key = {
  currency0: zeroAddress,
  currency1: projectToken,
  fee: 3000,
  tickSpacing: 60,
  hooks: oracle,
};
const emptyKey = {
  currency0: zeroAddress,
  currency1: zeroAddress,
  fee: 0,
  tickSpacing: 0,
  hooks: zeroAddress,
};
const current: JBRulesetWithMetadata = {
  ruleset: {
    id: 1700000000,
    cycleNumber: 2,
    basedOnId: 1600000000,
    start: 1700000100,
    duration: 86400,
    weight: 10n ** 24n,
    weightCutPercent: 0,
    approvalHook: zeroAddress,
    metadata: 0n,
  },
  metadata: {
    reservedPercent: 1000,
    cashOutTaxRate: 2500,
    baseCurrency: 2,
    pausePay: false,
    pauseCreditTransfers: false,
    allowOwnerMinting: false,
    allowSetCustomToken: false,
    allowTerminalMigration: false,
    allowSetTerminals: false,
    allowSetController: false,
    allowAddAccountingContext: false,
    allowAddPriceFeed: false,
    ownerMustSendPayouts: false,
    holdFees: false,
    scopeCashOutsToLocalBalances: false,
    useDataHookForPay: true,
    useDataHookForCashOut: true,
    dataHook: registry,
    metadata: 0,
  },
};
type Read = { address: Address; functionName: string; args?: readonly unknown[] };
const pass = Symbol('passthrough');
function fixture(override: (request: Read) => unknown = () => pass) {
  const reads: Read[] = [];
  const client = {
    readContract: vi.fn(async (request: Read) => {
      reads.push(request);
      const result = override(request);
      if (result !== pass) return result;
      switch (request.functionName) {
        case 'controllerOf':
          return v6Address('JBController', 1);
        case 'currentRulesetOf':
          return [current.ruleset, current.metadata];
        case 'ownerOf':
          return owner;
        case 'hasPermission':
          return true;
        case 'terminalsOf':
          return [v6Address('JBMultiTerminal', 1), v6Address('JBRouterTerminalRegistry', 1)];
        case 'accountingContextsOf':
          return request.address === v6Address('JBMultiTerminal', 1)
            ? [{ token: native, currency: 61166, decimals: 18 }]
            : [];
        case 'terminalOf':
        case 'defaultTerminalFor':
          return v6Address('JBRouterTerminal', 1);
        case 'hasLockedTerminal':
        case 'hasLockedHook':
          return false;
        case 'isTerminalAllowed':
        case 'isHookAllowed':
          return true;
        case 'hookOf':
          return buyback;
        case 'defaultHookProjectIdThreshold':
          return 0n;
        case 'defaultHook':
          return buyback;
        case 'defaultHookHistoryLength':
          return 0n;
        case 'BUYBACK_HOOK':
          return registry;
        case 'tiered721HookOf':
          return request.args?.length === 2 ? [nft, true] : nft;
        case 'extraDataHookOf':
          return { dataHook: registry, useDataHookForPay: true, useDataHookForCashOut: true };
        case 'poolKeyOf':
          return key;
        case 'twapWindowOf':
          return 1800n;
        case 'poolManager':
          return manager;
        case 'oracleHook':
          return oracle;
        case 'TOKENS':
          return v6Address('JBTokens', 1);
        case 'tokenOf':
          return projectToken;
        case 'primaryTerminalOf':
          return v6Address('JBMultiTerminal', 1);
        case 'extsload':
          return request.args?.[0] === uniswapV4PoolStateSlot(uniswapV4PoolId(key))
            ? numberToHex(1n << 96n, { size: 32 })
            : numberToHex(1000000n, { size: 32 });
        case 'observationCoverageOf':
          return 120;
        case 'observe': {
          const window = (request.args?.[1] as number[])[0]!;
          return [
            [0n, BigInt(window) * 100n],
            [0n, (BigInt(window) << 128n) / 1000000n],
          ];
        }
        case 'wrappedNativeToken':
          return custom;
        case 'discoverBestPool':
          return { isV4: true, v3Pool: zeroAddress, v4Key: key };
        case 'deployerOf':
          return zeroAddress;
        default:
          throw new Error(`Unhandled routing fixture read ${request.functionName}`);
      }
    }),
  } as unknown as PublicClient;
  const snapshot: RpcSnapshot = {
    client,
    evidence: {
      chainId: 1,
      blockNumber: '20000000',
      blockHash: zeroHash,
      timestamp: '1700000100',
      source: 'rpc',
    },
  };
  const rpc: RpcProvider = { client: () => client, snapshot: async () => snapshot };
  return { service: new RoutingService(rpc), snapshot, reads };
}

describe('routing hook resolution', () => {
  it('does not use a registry default for an unrelated custom data hook', async () => {
    const { snapshot, reads } = fixture((request) =>
      request.functionName === 'isHookAllowed' ? false : pass,
    );
    await expect(
      resolveRoutingHooks(snapshot, project, {
        ...current,
        metadata: { ...current.metadata, dataHook: custom },
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_DATA_HOOK' });
    expect(reads.some((read) => read.functionName === 'hookOf')).toBe(false);
  });

  it('resolves Revnet NFTs on pay and buyback plus REVOwner on cash-out', async () => {
    const { snapshot } = fixture();
    const revOwner = v6Address('REVOwner', 1);
    const result = await resolveRoutingHooks(snapshot, project, {
      ...current,
      metadata: { ...current.metadata, dataHook: revOwner },
    });
    expect(result).toMatchObject({
      kind: 'revnet',
      nft,
      buyback,
      buybackRegistry: registry,
      payHooks: [nft, buyback],
      cashOutHooks: [buyback, revOwner],
    });
    expect(result.cashOutHooks).not.toContain(nft);
  });

  it('respects omnichain NFT cash-out precedence over an extra buyback hook', async () => {
    const { snapshot } = fixture();
    const result = await resolveRoutingHooks(snapshot, project, {
      ...current,
      metadata: { ...current.metadata, dataHook: v6Address('JBOmnichainDeployer', 1) },
    });
    expect(result).toMatchObject({
      kind: 'omnichain',
      nft,
      buyback,
      payHooks: [nft, buyback],
      cashOutHooks: [nft],
      buybackPayEnabled: true,
      buybackCashOutEnabled: false,
    });
  });

  it('retains configured hook identity while disabled flags leave both call paths inactive', async () => {
    const { snapshot } = fixture();
    expect(
      await resolveRoutingHooks(snapshot, project, {
        ...current,
        metadata: { ...current.metadata, useDataHookForPay: false, useDataHookForCashOut: false },
      }),
    ).toMatchObject({
      buyback,
      payHooks: [],
      cashOutHooks: [],
      buybackPayEnabled: false,
      buybackCashOutEnabled: false,
    });
  });
});

describe('routing diagnostics', () => {
  it('normalizes native storage keys and distinguishes partial oracle history from its requested window', async () => {
    const { service, reads } = fixture();
    const result = await service.getRouting({ project });
    expect(result).toMatchObject({
      buybackPools: {
        status: 'known',
        value: [
          {
            terminalToken: native,
            pool: {
              status: 'known',
              value: {
                configured: true,
                twapWindowSeconds: '1800',
                state: { value: { initialized: true, activeLiquidity: '1000000' } },
                oracle: {
                  value: {
                    quality: 'partialWindow',
                    requestedWindowSeconds: 1800,
                    observedWindowSeconds: 120,
                    observations: {
                      value: { arithmeticMeanTick: '100', harmonicMeanLiquidity: '1000000' },
                    },
                  },
                },
              },
            },
          },
        ],
      },
    });
    expect(
      reads
        .filter((read) => ['poolKeyOf', 'twapWindowOf'].includes(read.functionName))
        .every((read) => read.args?.[1] === zeroAddress),
    ).toBe(true);
    expect(reads.find((read) => read.functionName === 'observe')?.args?.[1]).toEqual([120, 0]);
  });

  it('reports missing oracle hooks and unseeded histories without fabricating a spot quote', async () => {
    const missing = fixture((request) =>
      request.functionName === 'poolKeyOf' ? { ...key, hooks: zeroAddress } : pass,
    );
    expect(await missing.service.getRouting({ project })).toMatchObject({
      buybackPools: {
        value: [
          { pool: { value: { oracle: { status: 'unknown', error: { code: 'ORACLE_MISSING' } } } } },
        ],
      },
    });
    const unseeded = fixture((request) =>
      request.functionName === 'observationCoverageOf' ? 0 : pass,
    );
    expect(await unseeded.service.getRouting({ project })).toMatchObject({
      buybackPools: {
        value: [
          {
            pool: {
              value: {
                oracle: {
                  value: {
                    quality: 'unseeded',
                    observedWindowSeconds: 0,
                    observations: { value: null },
                  },
                },
              },
            },
          },
        ],
      },
    });
    expect(unseeded.reads.some((read) => read.functionName === 'observe')).toBe(false);
  });

  it('keeps unknown coverage separate from successful cumulative reads', async () => {
    const { service } = fixture((request) => {
      if (request.functionName === 'observationCoverageOf')
        throw new Error('coverage method unsupported');
      return pass;
    });
    expect(await service.getRouting({ project })).toMatchObject({
      buybackPools: {
        value: [
          {
            pool: {
              value: {
                oracle: {
                  value: {
                    quality: 'coverageUnknown',
                    coverage: { status: 'unknown' },
                    observedWindowSeconds: 1800,
                    observations: { status: 'known' },
                  },
                },
              },
            },
          },
        ],
      },
    });
  });

  it('reports custom router discovery as unsupported while preserving its verified project override', async () => {
    const { service } = fixture((request) =>
      request.functionName === 'terminalOf' ? custom : pass,
    );
    expect(
      await service.getRouting({ project, pairs: [{ tokenIn: native, tokenOut: projectToken }] }),
    ).toMatchObject({
      router: {
        resolved: { value: custom },
        pairs: { status: 'unknown', error: { code: 'UNSUPPORTED_ROUTER_IMPLEMENTATION' } },
      },
    });
  });

  it('uses the project-selected router and normalizes its wrapped-native token only for AMM discovery', async () => {
    const { service, reads } = fixture();
    const result = await service.getRouting({
      project,
      pairs: [{ tokenIn: native, tokenOut: projectToken }],
    });
    expect(reads.find((read) => read.functionName === 'discoverBestPool')).toMatchObject({
      address: v6Address('JBRouterTerminal', 1),
      args: [custom, projectToken],
    });
    expect(result).toMatchObject({
      router: {
        pairs: {
          value: [{ quote: { status: 'unknown', error: { code: 'AMOUNT_PREVIEW_REQUIRED' } } }],
        },
      },
    });
  });
});

describe('routing configuration plans', () => {
  it('prepares exact TWAP calldata using a delegated wildcard/root-aware permission read', async () => {
    const { service, reads } = fixture();
    const plan = await service.prepareBuybackTwap({
      project,
      account: operator,
      terminalToken: native,
      twapWindowSeconds: 172800,
    });
    expect(plan.calls[0]).toMatchObject({ to: buyback, value: '0', dependsOn: [] });
    expect(decodeFunctionData({ abi: jbBuybackHookAbi, data: plan.calls[0]!.data })).toEqual({
      functionName: 'setTwapWindowOf',
      args: [42n, native, 172800n],
    });
    expect(reads.find((read) => read.functionName === 'hasPermission')?.args).toEqual([
      operator,
      owner,
      42n,
      28n,
      true,
      true,
    ]);
    expect(plan.summary).toMatchObject({ nextWindowSeconds: 172800 });
  });

  it('rejects both denied and unknown permissions before producing a plan', async () => {
    const denied = fixture((request) => (request.functionName === 'hasPermission' ? false : pass));
    await expect(
      denied.service.prepareBuybackTwap({
        project,
        account: operator,
        terminalToken: native,
        twapWindowSeconds: 600,
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
    const failed = fixture((request) => {
      if (request.functionName === 'hasPermission') throw new Error('unavailable');
      return pass;
    });
    await expect(
      failed.service.prepareBuybackTwap({
        project,
        account: operator,
        terminalToken: native,
        twapWindowSeconds: 600,
      }),
    ).rejects.toThrow('unavailable');
  });

  it('registers an initialized exact pool key with the canonical oracle and exposes the max-window sentinel', async () => {
    const { service } = fixture((request) =>
      request.functionName === 'poolKeyOf' ? emptyKey : pass,
    );
    const plan = await service.prepareBuybackPool({
      project,
      account: owner,
      terminalToken: native,
      fee: 3000,
      tickSpacing: 60,
      twapWindowSeconds: 172800,
    });
    expect(decodeFunctionData({ abi: jbBuybackHookAbi, data: plan.calls[0]!.data })).toEqual({
      functionName: 'setPoolFor',
      args: [42n, 3000, 60, 172800n, native],
    });
    expect(plan.summary).toMatchObject({
      key,
      storedTwapWindowSeconds: 1800,
      requestedTwapWindowSeconds: 172800,
    });
  });

  it('rejects immutable existing pools and uninitialized proposed pools', async () => {
    const input = {
      project,
      account: owner,
      terminalToken: native,
      fee: 3000,
      tickSpacing: 60,
      twapWindowSeconds: 1800,
    };
    await expect(fixture().service.prepareBuybackPool(input)).rejects.toMatchObject({
      code: 'POOL_ALREADY_SET',
    });
    const empty = fixture((request) =>
      request.functionName === 'poolKeyOf'
        ? emptyKey
        : request.functionName === 'extsload'
          ? zeroHash
          : pass,
    );
    await expect(empty.service.prepareBuybackPool(input)).rejects.toMatchObject({
      code: 'POOL_NOT_INITIALIZED',
    });
  });

  it('allows a registry-approved custom hook override but refuses canonical TWAP semantics for that custom implementation', async () => {
    const { service, reads } = fixture();
    const plan = await service.prepareBuybackHook({ project, account: operator, hook: custom });
    expect(
      decodeFunctionData({ abi: jbBuybackHookRegistryAbi, data: plan.calls[0]!.data }),
    ).toEqual({ functionName: 'setHookFor', args: [42n, custom] });
    expect(reads.find((read) => read.functionName === 'hasPermission')?.args?.[3]).toBe(30n);
    const selectedCustom = fixture((request) =>
      request.functionName === 'hookOf' ? custom : pass,
    );
    await expect(
      selectedCustom.service.prepareBuybackTwap({
        project,
        account: owner,
        terminalToken: native,
        twapWindowSeconds: 600,
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_BUYBACK_IMPLEMENTATION' });
  });

  it('prepares project router overrides with permission31, and rejects locked or disallowed terminals', async () => {
    const { service, reads } = fixture();
    const plan = await service.prepareRouterTerminal({
      project,
      account: operator,
      terminal: custom,
    });
    expect(
      decodeFunctionData({ abi: jbRouterTerminalRegistryAbi, data: plan.calls[0]!.data }),
    ).toEqual({ functionName: 'setTerminalFor', args: [42n, custom] });
    expect(reads.find((read) => read.functionName === 'hasPermission')?.args?.[3]).toBe(31n);
    await expect(
      fixture((request) =>
        request.functionName === 'hasLockedTerminal' ? true : pass,
      ).service.prepareRouterTerminal({ project, account: owner, terminal: custom }),
    ).rejects.toMatchObject({ code: 'TERMINAL_LOCKED' });
    await expect(
      fixture((request) =>
        request.functionName === 'isTerminalAllowed' ? false : pass,
      ).service.prepareRouterTerminal({ project, account: owner, terminal: custom }),
    ).rejects.toMatchObject({ code: 'TERMINAL_NOT_ALLOWED' });
  });

  it('describes clearing a router override as returning to the cohort default', async () => {
    const { service, reads } = fixture();
    const plan = await service.prepareRouterTerminal({
      project,
      account: owner,
      terminal: zeroAddress,
    });
    expect(plan.summary).toMatchObject({
      cohortDefault: v6Address('JBRouterTerminal', 1),
      effectiveTerminalAfter: v6Address('JBRouterTerminal', 1),
      meaning:
        'Clears the override. The verified project cohort default becomes the forwarding terminal.',
    });
    expect(reads.find((read) => read.functionName === 'defaultTerminalFor')?.args).toEqual([42n]);
    await expect(
      service.prepareRouterTerminal({
        project,
        account: owner,
        terminal: v6Address('JBRouterTerminalRegistry', 1),
      }),
    ).rejects.toMatchObject({ code: 'CIRCULAR_ROUTER' });
  });

  it('reports unavailable registry forwarding when clearing a router override with no default', async () => {
    const { service } = fixture((request) =>
      request.functionName === 'defaultTerminalFor' ? zeroAddress : pass,
    );
    const plan = await service.prepareRouterTerminal({
      project,
      account: owner,
      terminal: zeroAddress,
    });
    expect(plan.summary).toMatchObject({
      cohortDefault: zeroAddress,
      effectiveTerminalAfter: zeroAddress,
      meaning:
        'Clears the override. No fallback terminal resolves at the observed block; registry forwarding becomes unavailable.',
    });
  });

  it('reports a zero buyback fallback when no default exists instead of claiming routing stays enabled', async () => {
    const { service } = fixture((request) =>
      request.functionName === 'defaultHook' ? zeroAddress : pass,
    );
    const plan = await service.prepareBuybackHook({ project, account: owner, hook: zeroAddress });
    expect(plan.summary).toMatchObject({
      previousHook: buyback,
      effectiveHookAfter: { status: 'known', value: zeroAddress },
      meaning:
        'Clears the project override. No fallback buyback hook resolves at the observed block.',
    });
  });

  it('resolves the buyback cohort history rather than substituting the newest global default', async () => {
    const { service, reads } = fixture((request) => {
      if (request.functionName === 'defaultHookProjectIdThreshold') return 100n;
      if (request.functionName === 'defaultHookHistoryLength') return 1n;
      if (request.functionName === 'defaultHookHistoryAt')
        return { minProjectIdExclusive: 0n, maxProjectId: 100n, hook: custom };
      return pass;
    });
    const plan = await service.prepareBuybackHook({ project, account: owner, hook: zeroAddress });
    expect(plan.summary).toMatchObject({ effectiveHookAfter: { status: 'known', value: custom } });
    expect(reads.some((read) => read.functionName === 'defaultHook')).toBe(false);
  });

  it('qualifies buyback clearing when fallback history cannot be verified', async () => {
    const { service } = fixture((request) => {
      if (request.functionName === 'defaultHookProjectIdThreshold') throw new Error('unavailable');
      return pass;
    });
    const plan = await service.prepareBuybackHook({ project, account: owner, hook: zeroAddress });
    expect(plan.summary).toMatchObject({
      effectiveHookAfter: { status: 'unknown' },
      meaning:
        'Clears the project override. The effective cohort fallback is unverified and may be zero; continued buyback routing is unknown.',
    });
  });
});
