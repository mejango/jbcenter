import { describe, expect, it, vi } from 'vitest';
import {
  jbBuybackHookAbi,
  jbBuybackHookRegistryAbi,
  jbRouterTerminalRegistryAbi,
} from '@bananapus/nana-sdk-core';
import {
  NATIVE_SWAP_BY_CHAIN,
  uniswapV4Deployment,
  uniswapV4PoolId,
  uniswapV4PoolStateSlot,
  v6Address,
  type JBRulesetWithMetadata,
} from '@bananapus/nana-sdk-core/v6';
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  numberToHex,
  parseAbi,
  parseAbiParameters,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { DomainError } from '../../src/domain/errors.js';
import { RoutingService, resolveRoutingHooks } from '../../src/services/routing.js';
import { resolveRouterTerminal, routingSchema } from '../../src/domain/routing.js';
import { deploymentAddress, deploymentAddresses } from '../../src/services/rollout.js';
import type { ChainId, ProjectRef, RpcProvider, RpcSnapshot } from '../../src/domain/types.js';

const project = { chainId: 1, projectId: '42', version: 6 } as const;
const owner = '0x1111111111111111111111111111111111111111' as const;
const operator = '0x2222222222222222222222222222222222222222' as const;
const projectToken = '0x3333333333333333333333333333333333333333' as const;
const custom = '0x4444444444444444444444444444444444444444' as const;
const manager = '0x5555555555555555555555555555555555555555' as const;
const oracle = '0x6666666666666666666666666666666666666666' as const;
const nft = '0x7777777777777777777777777777777777777777' as const;
const customHook = '0x9999999999999999999999999999999999999999' as const;
const native = '0x000000000000000000000000000000000000EEEe' as const;
const buyback = deploymentAddress('JBBuybackHook', 1)!;
const tokenImplementation = '0x8888888888888888888888888888888888888888' as const;
/** JBTokens deploys project ERC-20s as EIP-1167 clones of its TOKEN implementation. */
const cloneCode = (implementation: Address) =>
  `0x363d3d373d3d3d363d73${implementation.slice(2)}5af43d82803e903d91602b57fd5bf3` as Hex;
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
function fixture(override: (request: Read) => unknown = () => pass, chainId: ChainId = 1) {
  const reads: Read[] = [];
  const client = {
    getCode: vi.fn(async ({ address }: { address: Address }) =>
      address === projectToken ? cloneCode(tokenImplementation) : undefined,
    ),
    readContract: vi.fn(async (request: Read) => {
      reads.push(request);
      const result = override(request);
      if (result !== pass) return result;
      switch (request.functionName) {
        case 'controllerOf':
          return v6Address('JBController', chainId);
        case 'currentRulesetOf':
          return [current.ruleset, current.metadata];
        case 'ownerOf':
          return owner;
        case 'hasPermission':
          return true;
        case 'terminalsOf':
          return [
            v6Address('JBMultiTerminal', chainId),
            v6Address('JBRouterTerminalRegistry', chainId),
          ];
        case 'accountingContextsOf':
          return request.address === v6Address('JBMultiTerminal', chainId)
            ? [{ token: native, currency: 61166, decimals: 18 }]
            : [];
        case 'terminalOf':
        case 'defaultTerminalFor':
          return deploymentAddress('JBRouterTerminal', chainId)!;
        case 'ROUTER':
          return deploymentAddress('JBRouterTerminal', chainId)!;
        case 'DIRECTORY':
          return v6Address('JBDirectory', chainId);
        case 'pendingCallCount':
          return 8n;
        case 'pendingCallCommitmentOf':
          return request.args?.[0] === numberToHex(1n, { size: 32 })
            ? numberToHex(55n, { size: 32 })
            : zeroHash;
        case 'pendingCallFailureOf':
          return {
            errorHash: numberToHex(44n, { size: 32 }),
            count: 2,
            lastFailureAt: 1700000000,
            highestGasLimit: 1000000n,
          };
        case 'hasLockedTerminal':
        case 'hasLockedHook':
          return false;
        case 'isTerminalAllowed':
        case 'isHookAllowed':
          return true;
        case 'hookOf':
          return deploymentAddress('JBBuybackHook', chainId)!;
        case 'defaultHookProjectIdThreshold':
          return 0n;
        case 'defaultHook':
          return deploymentAddress('JBBuybackHook', chainId)!;
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
        case 'TOKEN':
          return tokenImplementation;
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
      chainId,
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
  it('shares pinned hook properties across token pools without combining their observations', async () => {
    const { service, reads } = fixture();
    const result = await service.getRouting({ project, tokens: [native, custom] });
    expect(reads.filter((read) => read.functionName === 'poolManager')).toHaveLength(1);
    expect(reads.filter((read) => read.functionName === 'oracleHook')).toHaveLength(1);
    expect(reads.filter((read) => read.functionName === 'poolKeyOf')).toHaveLength(2);
    expect(result).toMatchObject({
      buybackPools: {
        status: 'known',
        value: [
          { terminalToken: native, pool: { status: 'known' } },
          { terminalToken: custom, pool: { status: 'known' } },
        ],
      },
    });
  });

  it('keeps shared hook read failures unknown for every selected token', async () => {
    const { service, reads } = fixture((request) => {
      if (request.functionName === 'poolManager') throw new Error('manager unavailable');
      return pass;
    });
    const result = await service.getRouting({ project, tokens: [native, custom] });
    expect(reads.filter((read) => read.functionName === 'poolManager')).toHaveLength(1);
    expect(result).toMatchObject({
      buybackPools: {
        status: 'known',
        value: [
          { terminalToken: native, pool: { status: 'unknown' } },
          { terminalToken: custom, pool: { status: 'unknown' } },
        ],
      },
    });
  });

  it.each([1, 11155111] as const)(
    'resolves chain %i gateway and distinguishes issued IDs, retained custody and failed reads',
    async (chainId) => {
      const testProject = { ...project, chainId } as const;
      const gateway = deploymentAddress('JBRouterTerminalGateway', chainId)!;
      const router = deploymentAddress('JBRouterTerminal', chainId)!;
      const retainedId = numberToHex(1n, { size: 32 });
      const absentId = numberToHex(2n, { size: 32 });
      const unknownId = numberToHex(3n, { size: 32 });
      const { service, reads } = fixture((request) => {
        if (request.functionName === 'terminalOf') return gateway;
        if (request.functionName === 'pendingCallCommitmentOf' && request.args?.[0] === unknownId)
          throw new Error('pending commitment unavailable');
        return pass;
      }, chainId);
      const result = await service.getRouting({
        project: testProject,
        pendingCallIds: [retainedId, absentId, unknownId],
        pairs: [{ tokenIn: native, tokenOut: projectToken }],
      });
      expect(result).toMatchObject({
        router: {
          resolved: { value: gateway },
          path: {
            value: {
              gateway,
              router,
              path: [v6Address('JBRouterTerminalRegistry', chainId), gateway, router],
            },
          },
          pendingCalls: {
            value: {
              issuedIdCount: { value: '8' },
              calls: [
                {
                  id: retainedId,
                  retained: { value: true },
                  failure: { value: { count: 2, highestGasLimit: '1000000' } },
                },
                { id: absentId, retained: { value: false } },
                { id: unknownId, retained: { status: 'unknown' }, failure: { status: 'known' } },
              ],
            },
          },
        },
        buybackPools: { status: 'known' },
      });
      expect(reads.find((read) => read.functionName === 'discoverBestPool')?.address).toBe(router);
      expect(reads.filter((read) => read.functionName === 'pendingCallCommitmentOf')).toHaveLength(
        3,
      );
      expect(JSON.stringify(result)).toContain('not the outstanding-call count');
    },
  );

  it('preserves recorded retired router routes after the current gateway deploys', async () => {
    const retired = deploymentAddresses('JBRouterTerminal', 1).find(
      (address) => address !== deploymentAddress('JBRouterTerminal', 1),
    )!;
    const { service, reads } = fixture((request) =>
      request.functionName === 'terminalOf' ? retired : pass,
    );
    expect(
      await service.getRouting({ project, pairs: [{ tokenIn: native, tokenOut: projectToken }] }),
    ).toMatchObject({
      router: {
        resolved: { value: retired },
        pendingCalls: { value: null },
        pairs: { status: 'known' },
      },
    });
    expect(reads.find((read) => read.functionName === 'discoverBestPool')?.address).toBe(retired);
    expect(reads.some((read) => read.functionName === 'ROUTER')).toBe(false);
  });

  it('keeps the feed-only chain free of unexecuted gateway deployments', () => {
    expect(deploymentAddress('JBRatioPriceFeed', 11155420)).toBeDefined();
    expect(deploymentAddress('JBRouterTerminalGateway', 11155420)).toBeUndefined();
  });

  it('rejects a recorded gateway with an unrecognized immutable router', async () => {
    const chainId = 11155111;
    const gateway = deploymentAddress('JBRouterTerminalGateway', chainId)!;
    const { snapshot } = fixture(
      (request) => (request.functionName === 'ROUTER' ? custom : pass),
      chainId,
    );
    await expect(
      resolveRouterTerminal(snapshot.client, { ...project, chainId }, gateway),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_ROUTER_GATEWAY' });
    expect(
      routingSchema.safeParse({ project, pendingCallIds: [zeroHash, ...Array(8).fill(zeroHash)] })
        .success,
    ).toBe(false);
  });

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
      address: deploymentAddress('JBRouterTerminal', 1),
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

  it.each(deploymentAddresses('JBBuybackHook', 1))(
    'registers the exact pool key and applies the max-window sentinel only for the rollout hook: %s',
    async (hook) => {
      const { service } = fixture((request) =>
        request.functionName === 'poolKeyOf'
          ? emptyKey
          : request.functionName === 'hookOf'
            ? hook
            : pass,
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
        storedTwapWindowSeconds: hook === deploymentAddress('JBBuybackHook', 1) ? 1800 : 172800,
        requestedTwapWindowSeconds: 172800,
      });
      expect(plan.calls[0]!.to).toBe(hook);
      expect(plan.warnings.some((warning) => warning.includes('sentinel 172800 stores 1800'))).toBe(
        hook === deploymentAddress('JBBuybackHook', 1),
      );
    },
  );

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
      cohortDefault: deploymentAddress('JBRouterTerminal', 1),
      effectiveTerminalAfter: deploymentAddress('JBRouterTerminal', 1),
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

describe('direct pool-buy quote', () => {
  const evidence = {
    chainId: 1,
    blockNumber: '20000000',
    blockHash: zeroHash,
    timestamp: '1700000100',
    source: 'rpc',
  } as const;
  const usdc = NATIVE_SWAP_BY_CHAIN[1]!.bridgeToken;
  const terminalQuote = {
    route: 'multi-terminal',
    quoteBasis: 'terminal-issuance-preview',
    beneficiaryTokenCount: '900000000000000000',
    reservedTokenCount: '100000000000000000',
    minimumBeneficiaryTokenCount: '891000000000000000',
    slippageBps: 100,
  };
  const input = { project, account: owner, token: native, amount: '1000000000000000000' };
  // V4 quoter: exact input in, 97% out. V3 bridge quoter: 2,000 USDC per ETH.
  function withQuoters(service: ReturnType<typeof fixture>) {
    const calls: { to: Address; data: Hex }[] = [];
    (service.snapshot.client as unknown as { call: unknown }).call = vi.fn(
      async (request: { to: Address; data: Hex }) => {
        calls.push(request);
        if (request.to.toLowerCase() === NATIVE_SWAP_BY_CHAIN[1]!.v3Quoter.toLowerCase())
          return {
            data: encodeAbiParameters(parseAbiParameters('uint256, uint160, uint32, uint256'), [
              2_000_000_000n,
              0n,
              0,
              0n,
            ]),
          };
        const amount = (
          decodeAbiParameters(
            parseAbiParameters('((address,address,uint24,int24,address),bool,uint128,bytes)'),
            `0x${request.data.slice(10)}`,
          )[0] as readonly unknown[]
        )[2] as bigint;
        return {
          data: encodeAbiParameters(parseAbiParameters('uint256, uint256'), [
            (amount * 97n) / 100n,
            0n,
          ]),
        };
      },
    );
    return calls;
  }

  it('quotes the pool next to the terminal quote at the same block and names the pool hook', async () => {
    const routing = fixture();
    const calls = withQuoters(routing);
    const quoteTerminal = vi.fn(async () => terminalQuote);
    const result = await routing.service.quotePoolBuy(input, quoteTerminal);
    expect(quoteTerminal).toHaveBeenCalledWith(evidence);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to.toLowerCase()).toBe(uniswapV4Deployment(1)!.quoter!.toLowerCase());
    expect(result).toMatchObject({
      evidence: [evidence],
      projectToken,
      pool: {
        key,
        inputRoute: { kind: 'single-v4' },
        amountIn: '1000000000000000000',
        tokenCount: '970000000000000000',
        minimumTokenCount: '960300000000000000',
        slippageBps: 100,
        spotTokenCount: '1000000000000000000',
        priceImpactBps: '300',
      },
      terminal: { status: 'known', value: terminalQuote },
    });
    expect(result).toMatchObject({
      projectTokenIsJBERC20: true,
      pool: { hook: { address: oracle, kind: 'JBUniswapV4Hook' } },
    });
    const { warnings } = result as { warnings: string[] };
    expect(warnings[0]).toContain(
      'When the terminal gives more, the hook pays the project instead',
    );
    expect(warnings.join(' ')).not.toContain('Nothing is issued');
    expect(warnings.join(' ')).toContain('Neither route is a best-price claim');
    expect(warnings.join(' ')).toContain('jb_prepare_pool_buy prepares this swap');
  });

  it('takes slippageBps off the pool output', async () => {
    const routing = fixture();
    withQuoters(routing);
    const result = await routing.service.quotePoolBuy(
      { ...input, slippageBps: 250 },
      async () => terminalQuote,
    );
    expect(result).toMatchObject({
      pool: {
        tokenCount: '970000000000000000',
        minimumTokenCount: '945750000000000000',
        slippageBps: 250,
      },
    });
  });

  it('says a hookless pool issues nothing, and flags a custom token or an unknown pool hook', async () => {
    const hookless = fixture((request) =>
      request.functionName === 'poolKeyOf' ? { ...key, hooks: zeroAddress } : pass,
    );
    withQuoters(hookless);
    const plain = (await hookless.service.quotePoolBuy(input, async () => terminalQuote)) as {
      pool: { hook: unknown };
      warnings: string[];
    };
    expect(plain.pool.hook).toEqual({ address: zeroAddress, kind: 'none' });
    expect(plain.warnings[0]).toContain('Nothing is issued');

    const customToken = fixture();
    (customToken.snapshot.client as unknown as { getCode: unknown }).getCode = vi.fn(
      async () => '0x6080',
    );
    withQuoters(customToken);
    const custom = (await customToken.service.quotePoolBuy(input, async () => terminalQuote)) as {
      projectTokenIsJBERC20: boolean;
      warnings: string[];
    };
    expect(custom.projectTokenIsJBERC20).toBe(false);
    expect(custom.warnings.join(' ')).toContain('can deliver less than minimumTokenCount');

    const otherHook = fixture((request) =>
      request.functionName === 'poolKeyOf' ? { ...key, hooks: customHook } : pass,
    );
    withQuoters(otherHook);
    const unknownHook = (await otherHook.service.quotePoolBuy(
      input,
      async () => terminalQuote,
    )) as { pool: { hook: unknown }; warnings: string[] };
    expect(unknownHook.pool.hook).toEqual({ address: customHook, kind: 'unsupported' });
    expect(unknownHook.warnings[0]).toContain('jb_prepare_pool_buy refuses this pool');
  });

  it("names the router's TWAP floor as the reason its bridge amount sits below the V3 quote", async () => {
    const usdcKey = { ...key, currency0: projectToken, currency1: usdc };
    const routing = fixture((request) =>
      request.functionName === 'poolKeyOf'
        ? request.args?.[1] === zeroAddress
          ? emptyKey
          : usdcKey
        : pass,
    );
    withQuoters(routing);
    const routed = { ...terminalQuote, route: 'router-terminal' };
    const result = (await routing.service.quotePoolBuy(input, async () => routed)) as {
      warnings: string[];
    };
    expect(result.warnings.join(' ')).toContain('10-minute TWAP less its slippage buffer');
    const direct = (await routing.service.quotePoolBuy(input, async () => terminalQuote)) as {
      warnings: string[];
    };
    expect(direct.warnings.join(' ')).not.toContain('10-minute TWAP');
  });

  it('crosses the ETH/USDC bridge when only the USDC pool exists', async () => {
    const usdcKey = { ...key, currency0: projectToken, currency1: usdc };
    const routing = fixture((request) =>
      request.functionName === 'poolKeyOf'
        ? request.args?.[1] === zeroAddress
          ? emptyKey
          : usdcKey
        : request.functionName === 'extsload' &&
            request.args?.[0] === uniswapV4PoolStateSlot(uniswapV4PoolId(usdcKey))
          ? numberToHex(1n << 96n, { size: 32 })
          : pass,
    );
    withQuoters(routing);
    const result = await routing.service.quotePoolBuy(input, async () => terminalQuote);
    expect(result).toMatchObject({
      pool: {
        key: usdcKey,
        inputRoute: { kind: 'native-v3-v4', quotedBridgeAmount: '2000000000' },
        amountIn: '2000000000',
        tokenCount: '1940000000',
      },
    });
    expect((result as { warnings: string[] }).warnings.join(' ')).toContain(
      'Uniswap V3 ETH/USDC pool',
    );
  });

  it('keeps the pool quote when the terminal quote fails', async () => {
    const routing = fixture();
    withQuoters(routing);
    const result = await routing.service.quotePoolBuy(input, async () => {
      throw new DomainError('UNSUPPORTED_COMPOSITION', 'Unrecognized hook.');
    });
    expect(result).toMatchObject({
      pool: { tokenCount: '970000000000000000' },
      terminal: { status: 'unknown', error: { code: 'UNSUPPORTED_COMPOSITION' } },
    });
  });

  it('lets the quoter decide, and names an empty pool only when the quoter also fails', async () => {
    const empty = () =>
      fixture((request) =>
        request.functionName === 'extsload' &&
        request.args?.[0] !== uniswapV4PoolStateSlot(uniswapV4PoolId(key))
          ? zeroHash
          : pass,
      );
    const reverting = (service: ReturnType<typeof fixture>) => {
      const quoter = vi.fn(async () => {
        throw new Error('UnexpectedRevertBytes');
      });
      (service.snapshot.client as unknown as { call: unknown }).call = quoter;
      return quoter;
    };
    // Zero in-range liquidity, but the swap can cross into initialized ticks: the quote stands.
    const crossing = empty();
    withQuoters(crossing);
    await expect(
      crossing.service.quotePoolBuy(input, async () => terminalQuote),
    ).resolves.toMatchObject({ pool: { activeLiquidity: '0', tokenCount: '970000000000000000' } });

    const dry = empty();
    const quoter = reverting(dry);
    const error = await dry.service
      .quotePoolBuy(input, async () => terminalQuote)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'NO_POOL_LIQUIDITY', retryable: false });
    expect(quoter).toHaveBeenCalled();
    expect((error as Error).message).not.toContain('fills nothing');
    await expect(dry.service.preparePoolBuy(input)).rejects.toMatchObject({
      code: 'NO_POOL_LIQUIDITY',
    });

    // With liquidity, a quoter failure is passed on rather than relabeled.
    const liquid = fixture();
    reverting(liquid);
    await expect(
      liquid.service.quotePoolBuy(input, async () => terminalQuote),
    ).rejects.not.toMatchObject({ code: 'NO_POOL_LIQUIDITY' });
  });

  it('refuses projects without a buyback pool or with a pool for another token', async () => {
    const noHook = fixture((request) => (request.functionName === 'hookOf' ? zeroAddress : pass));
    await expect(
      noHook.service.quotePoolBuy(input, async () => terminalQuote),
    ).rejects.toMatchObject({ code: 'NO_BUYBACK_POOL' });
    const noPool = fixture((request) => (request.functionName === 'poolKeyOf' ? emptyKey : pass));
    await expect(
      noPool.service.quotePoolBuy(input, async () => terminalQuote),
    ).rejects.toMatchObject({ code: 'NO_BUYBACK_POOL' });
    const otherToken = fixture((request) => (request.functionName === 'tokenOf' ? custom : pass));
    await expect(
      otherToken.service.quotePoolBuy(input, async () => terminalQuote),
    ).rejects.toMatchObject({ code: 'POOL_PAIR_MISMATCH' });
  });
});

describe('direct pool-buy preparation', () => {
  const usdc = NATIVE_SWAP_BY_CHAIN[1]!.bridgeToken;
  const router = uniswapV4Deployment(1)!.universalRouter!;
  const permit2 = uniswapV4Deployment(1)!.permit2;
  const input = { project, account: owner, token: native, amount: '1000000000000000000' };
  const executeAbi = parseAbi([
    'function execute(bytes commands, bytes[] inputs, uint256 deadline)',
  ]);
  // Every quoter returns 2,000 of the output token per input token, as in the bridge test above.
  function quoting(service: ReturnType<typeof fixture>) {
    (service.snapshot.client as unknown as { call: unknown }).call = vi.fn(
      async (request: { to: Address; data: Hex }) => {
        if (request.to.toLowerCase() === NATIVE_SWAP_BY_CHAIN[1]!.v3Quoter.toLowerCase())
          return {
            data: encodeAbiParameters(parseAbiParameters('uint256, uint160, uint32, uint256'), [
              2_000_000_000n,
              0n,
              0,
              0n,
            ]),
          };
        const amount = (
          decodeAbiParameters(
            parseAbiParameters('((address,address,uint24,int24,address),bool,uint128,bytes)'),
            `0x${request.data.slice(10)}`,
          )[0] as readonly unknown[]
        )[2] as bigint;
        return {
          data: encodeAbiParameters(parseAbiParameters('uint256, uint256'), [
            (amount * 97n) / 100n,
            0n,
          ]),
        };
      },
    );
  }
  /** The V4 minimum the router enforces, read back out of the reviewed calldata. */
  function v4Minimum(data: Hex): bigint {
    const [, inputs] = decodeFunctionData({ abi: executeAbi, data }).args;
    const [, actions] = decodeAbiParameters(
      parseAbiParameters('bytes, bytes[]'),
      inputs[inputs.length - 1]!,
    );
    const swap = actions.find((action) => action.length > 600)!;
    const [params] = decodeAbiParameters(
      parseAbiParameters('((address,address,uint24,int24,address),bool,uint128,uint128,bytes)'),
      swap,
    );
    return params[3];
  }

  it('prepares the ETH to USDC to project-token route as one router call with the slippage minimum', async () => {
    const usdcKey = { ...key, currency0: projectToken, currency1: usdc };
    const routing = fixture((request) =>
      request.functionName === 'poolKeyOf'
        ? request.args?.[1] === zeroAddress
          ? emptyKey
          : usdcKey
        : pass,
    );
    quoting(routing);
    const plan = await routing.service.preparePoolBuy({ ...input, slippageBps: 200 });
    expect(plan.operation).toBe('pool_buy');
    expect(plan.calls).toHaveLength(1);
    const [swap] = plan.calls;
    expect(swap).toMatchObject({ to: router, value: '1000000000000000000' });
    expect(decodeFunctionData({ abi: executeAbi, data: swap!.data }).args).toMatchObject([
      '0x0b0010',
      expect.any(Array),
      1700000100n + 900n,
    ]);
    expect(v4Minimum(swap!.data)).toBe(1_901_200_000n);
    expect(plan.summary).toMatchObject({
      recipient: owner,
      projectToken,
      inputRoute: { kind: 'native-v3-v4', quotedBridgeAmount: '2000000000' },
      quotedTokenCount: '1940000000',
      minimumTokenCount: '1901200000',
      slippageBps: 200,
    });
    expect(plan.summary).toMatchObject({
      projectTokenIsJBERC20: true,
      poolHook: { kind: 'JBUniswapV4Hook' },
    });
    expect(plan.warnings.join(' ')).toContain('the hook pays the project instead');
    expect(plan.warnings.join(' ')).toContain('The V3 bridge leg has no minimum of its own');
  });

  it('approves Permit2 and the router for exactly an ERC-20 payment, and skips what is already granted', async () => {
    const usdcKey = { ...key, currency0: projectToken, currency1: usdc };
    const allowances = { erc20: 0n, permit2: [0n, 0, 0n] as const };
    const routing = fixture((request) => {
      if (request.functionName === 'poolKeyOf')
        return request.args?.[1] === usdc ? usdcKey : emptyKey;
      if (request.functionName === 'allowance')
        return request.args?.length === 3 ? allowances.permit2 : allowances.erc20;
      return pass;
    });
    quoting(routing);
    const usdcInput = { ...input, token: usdc, amount: '5000000' };
    const plan = await routing.service.preparePoolBuy(usdcInput);
    expect(plan.calls.map((call) => [call.to, call.decoded.functionName, call.dependsOn])).toEqual([
      [usdc, 'approve', []],
      [permit2, 'approve', [0]],
      [router, 'execute', [1]],
    ]);
    expect(plan.calls[0]!.decoded.args).toEqual([permit2, '5000000']);
    expect(plan.calls[1]!.decoded.args).toEqual([
      usdc,
      getAddress(router),
      '5000000',
      1700000100 + 2700,
    ]);
    expect(plan.calls[2]!.value).toBe('0');
    expect(v4Minimum(plan.calls[2]!.data)).toBe((5_000_000n * 97n * 99n) / 10_000n);
    expect(plan.warnings.join(' ')).toContain('chained: true');

    allowances.erc20 = 5_000_000n;
    allowances.permit2 = [
      5_000_000n,
      1700000100 + 7200,
      0n,
    ] as unknown as typeof allowances.permit2;
    const granted = await routing.service.preparePoolBuy(usdcInput);
    expect(granted.calls.map((call) => call.decoded.functionName)).toEqual(['execute']);

    // USDT-style tokens revert on nonzero-to-nonzero approvals: reset first, as jb_prepare_pay does.
    allowances.erc20 = 1n;
    const short = await routing.service.preparePoolBuy(usdcInput);
    expect(short.calls.map((call) => [call.to, call.decoded.args, call.dependsOn])).toEqual([
      [usdc, [permit2, '0'], []],
      [usdc, [permit2, '5000000'], [0]],
      [router, expect.any(Array), [1]],
    ]);
  });

  it('refuses a custom project token or an unrecognized pool hook', async () => {
    const customToken = fixture();
    (customToken.snapshot.client as unknown as { getCode: unknown }).getCode = vi.fn(async () =>
      cloneCode(custom),
    );
    quoting(customToken);
    await expect(customToken.service.preparePoolBuy(input)).rejects.toMatchObject({
      code: 'UNSUPPORTED_POOL_BUY',
      message: expect.stringContaining('can deliver less than minimumTokenCount'),
    });
    const otherHook = fixture((request) =>
      request.functionName === 'poolKeyOf' ? { ...key, hooks: customHook } : pass,
    );
    quoting(otherHook);
    await expect(otherHook.service.preparePoolBuy(input)).rejects.toMatchObject({
      code: 'UNSUPPORTED_POOL_BUY',
    });
    const hookless = fixture((request) =>
      request.functionName === 'poolKeyOf' ? { ...key, hooks: zeroAddress } : pass,
    );
    quoting(hookless);
    const plan = await hookless.service.preparePoolBuy(input);
    expect(plan.warnings[0]).toContain('Nothing is issued');
  });

  it('refuses a project without a pool, like the quote', async () => {
    const noPool = fixture((request) => (request.functionName === 'poolKeyOf' ? emptyKey : pass));
    await expect(noPool.service.preparePoolBuy(input)).rejects.toMatchObject({
      code: 'NO_BUYBACK_POOL',
    });
  });
});
