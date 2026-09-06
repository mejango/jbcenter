import { describe, expect, it, vi } from 'vitest';
import { pad, zeroAddress, zeroHash, type Address, type PublicClient } from 'viem';
import { v6Address } from '@bananapus/nana-sdk-core/v6';
import { ProjectService } from '../../src/services/projects.js';
import type { ProjectRef, RpcProvider } from '../../src/domain/types.js';

const ref: ProjectRef = { chainId: 1, projectId: '42' };
const holder = '0x1111111111111111111111111111111111111111' as const;
const erc20 = '0x2222222222222222222222222222222222222222' as const;
const custom = '0x3333333333333333333333333333333333333333' as const;
const tokenStore = '0x4444444444444444444444444444444444444444' as const;
const terminalStore = '0x5555555555555555555555555555555555555555' as const;
const limitsStore = '0x6666666666666666666666666666666666666666' as const;
const splitStore = '0x7777777777777777777777777777777777777777' as const;
const native = '0x000000000000000000000000000000000000EEEe' as const;
const usdc = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const;
const nativeContext = { token: native, decimals: 18, currency: 61166 };
const usdcContext = { token: usdc, decimals: 6, currency: 1042887240 };
const ruleset = {
  id: 1700000000,
  cycleNumber: 17,
  basedOnId: 1600000000,
  start: 1700000020,
  duration: 86400,
  weight: 10n ** 24n,
  weightCutPercent: 10000000,
  approvalHook: zeroAddress,
  metadata: 0n,
};
const metadata = {
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
  useDataHookForPay: false,
  useDataHookForCashOut: false,
  dataHook: zeroAddress,
  metadata: 0,
};

type Read = { address: Address; functionName: string; args?: readonly unknown[] };
type Override = (request: Read, chainId: number) => unknown;
const passthrough = Symbol('fixture passthrough');

function fixture(override: Override = () => passthrough) {
  const reads: (Read & { chainId: number })[] = [];
  const logs = vi.fn(async () => []);
  const makeClient = (chainId: number) =>
    ({
      readContract: vi.fn(async (request: Read) => {
        reads.push({ ...request, chainId });
        const result = override(request, chainId);
        if (result !== passthrough) return result;
        switch (request.functionName) {
          case 'ownerOf':
            return holder;
          case 'controllerOf':
            return v6Address('JBController', chainId as ProjectRef['chainId']);
          case 'terminalsOf':
            return [v6Address('JBMultiTerminal', chainId as ProjectRef['chainId'])];
          case 'uriOf':
            return 'ipfs://untrusted-metadata';
          case 'currentRulesetOf':
            return [ruleset, metadata];
          case 'upcomingRulesetOf':
            return [{ ...ruleset, cycleNumber: 18, start: ruleset.start + 86400 }, metadata];
          case 'latestQueuedRulesetOf':
            return [ruleset, metadata, 3];
          case 'allRulesetsOf':
            return [{ ruleset, metadata }];
          case 'TOKENS':
            return tokenStore;
          case 'FUND_ACCESS_LIMITS':
            return limitsStore;
          case 'SPLITS':
            return splitStore;
          case 'STORE':
            return terminalStore;
          case 'tokenOf':
            return erc20;
          case 'name':
            return 'Fixture Project';
          case 'symbol':
            return 'FIX';
          case 'decimals':
            return 18;
          case 'creditBalanceOf':
            return 7n * 10n ** 18n;
          case 'totalBalanceOf':
            return 10n * 10n ** 18n;
          case 'totalTokenSupplyWithReservedTokensOf':
            return 110n * 10n ** 18n;
          case 'pendingReservedTokenBalanceOf':
            return 10n * 10n ** 18n;
          case 'accountingContextsOf':
            return [nativeContext, usdcContext];
          case 'balanceOf':
            return request.address === erc20
              ? 3n * 10n ** 18n
              : request.args?.[2] === usdc
                ? 900000000n
                : 2n * 10n ** 18n;
          case 'currentSurplusOf':
            return request.args?.[2] === 6n ? 400000000n : 10n ** 18n;
          case 'payoutLimitsOf':
            return request.args?.[3] === usdc
              ? [
                  { amount: 500000000n, currency: 2 },
                  { amount: 10000000n, currency: usdcContext.currency },
                ]
              : [];
          case 'surplusAllowancesOf':
            return [{ amount: 1000000n, currency: 2 }];
          case 'usedPayoutLimitOf':
            return 120000000n;
          case 'usedSurplusAllowanceOf':
            return 100000n;
          case 'splitsOf':
            return [];
          case 'primaryTerminalOf':
            return v6Address('JBMultiTerminal', chainId as ProjectRef['chainId']);
          case 'permissionsOf':
            return request.args?.[2] === 0n ? 1n << 1n : 1n << 2n;
          case 'hasPermission':
            return true;
          case 'allSuckersOf':
          case 'suckersOf':
            return [];
          case 'toRemoteFee':
            return 1000000000000000n;
          default:
            throw new Error(`Unhandled fixture read ${request.functionName}`);
        }
      }),
      getLogs: logs,
    }) as unknown as PublicClient;
  const clients = new Map<number, PublicClient>();
  const rpc: RpcProvider = {
    client(chainId) {
      let client = clients.get(chainId);
      if (!client) {
        client = makeClient(chainId);
        clients.set(chainId, client);
      }
      return client;
    },
    async snapshot(chainId) {
      return {
        client: this.client(chainId),
        evidence: {
          chainId,
          blockNumber: '20000000',
          blockHash: zeroHash,
          timestamp: '1700000100',
          source: 'rpc',
        },
      };
    },
  };
  return { service: new ProjectService(rpc), reads, logs };
}

describe('ProjectService project intelligence', () => {
  it('preserves currency and token decimals, and uses cycles for payouts versus ruleset IDs for allowances', async () => {
    const { service, reads } = fixture();
    const result = await service.getProject(ref);
    expect(result.supply).toMatchObject({
      totalIncludingPendingReserved: { status: 'known', value: '110000000000000000000' },
      pendingReserved: { value: '10000000000000000000' },
      scope: 'localChain',
    });
    expect(result.rulesets.latestQueued).toMatchObject({
      value: { approvalStatus: 'approvalExpected' },
    });
    expect(result.terminals.status).toBe('known');
    if (result.terminals.status !== 'known') throw new Error('Expected terminal discovery');
    const contexts = result.terminals.value[0]!.contexts;
    if (contexts.status !== 'known') throw new Error('Expected context accounting');
    const usd = contexts.value.find((item) => item.token === usdc)!;
    expect(usd).toMatchObject({
      currency: usdcContext.currency,
      decimals: 6,
      balance: { value: '900000000' },
      localSurplus: { value: '400000000' },
    });
    expect(usd.payoutLimits).toMatchObject({
      status: 'known',
      value: [
        {
          configured: '500000000',
          currency: 2,
          decimals: 6,
          remaining: { value: '380000000' },
          resetScope: 'rulesetCycleNumber',
          scopeId: 17,
        },
        { remaining: { value: '0' } },
      ],
    });
    expect(
      reads
        .filter((read) => read.functionName === 'usedPayoutLimitOf')
        .every((read) => read.args?.[3] === 17n),
    ).toBe(true);
    expect(
      reads
        .filter((read) => read.functionName === 'usedSurplusAllowanceOf')
        .every((read) => read.args?.[3] === 1700000000n),
    ).toBe(true);
    expect(
      reads.find((read) => read.functionName === 'currentSurplusOf' && read.args?.[2] === 6n)?.args,
    ).toEqual([42n, [usdc], 6n, BigInt(usdcContext.currency)]);
    expect(
      reads
        .filter((read) => read.functionName === 'balanceOf')
        .every((read) => read.address === terminalStore),
    ).toBe(true);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('keeps individual failed accounting reads unknown and retains successful currencies', async () => {
    const { service } = fixture((request) => {
      if (request.functionName === 'balanceOf' && request.args?.[2] === usdc)
        throw new Error('https://secret-provider?apiKey=secret');
      if (request.functionName === 'usedPayoutLimitOf' && request.args?.[4] === 2n)
        throw new Error('unavailable');
      return passthrough;
    });
    const result = await service.getProject(ref);
    if (
      result.terminals.status !== 'known' ||
      result.terminals.value[0]!.contexts.status !== 'known'
    )
      throw new Error('Expected partial contexts');
    const contexts = result.terminals.value[0]!.contexts.value;
    expect(contexts[0]!.balance).toMatchObject({ status: 'known', value: '2000000000000000000' });
    expect(contexts[1]!.balance).toMatchObject({
      status: 'unknown',
      error: { code: 'UPSTREAM_FAILURE' },
    });
    expect(contexts[1]!.payoutLimits).toMatchObject({
      value: [
        { used: { status: 'unknown' }, remaining: { status: 'unknown' } },
        { remaining: { status: 'known' } },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('apiKey');
  });

  it('does not fetch canonical controller economics for a migrated custom controller', async () => {
    const { service, reads } = fixture((request) =>
      request.functionName === 'controllerOf' ? custom : passthrough,
    );
    const result = await service.getProject(ref);
    expect(result.controller).toEqual({ status: 'known', value: custom });
    expect(result.rulesets.current).toMatchObject({
      status: 'unknown',
      error: { code: 'UNSUPPORTED_CONTROLLER' },
    });
    expect(result.supply.totalIncludingPendingReserved.status).toBe('unknown');
    expect(
      reads.some(
        (read) => read.functionName === 'currentRulesetOf' || read.functionName === 'TOKENS',
      ),
    ).toBe(false);
  });

  it('discovers custom terminals without fabricating their canonical store balances', async () => {
    const { service, reads } = fixture((request) =>
      request.functionName === 'terminalsOf' ? [custom] : passthrough,
    );
    const result = await service.getProject(ref);
    expect(result.terminals).toMatchObject({
      status: 'known',
      value: [
        {
          address: custom,
          accountingStore: {
            status: 'unknown',
            error: { code: 'UNSUPPORTED_TERMINAL_ACCOUNTING' },
          },
          contexts: {
            status: 'known',
            value: [{ balance: { status: 'unknown' } }, { balance: { status: 'unknown' } }],
          },
        },
      ],
    });
    expect(
      reads.some((read) => read.functionName === 'STORE' || read.functionName === 'balanceOf'),
    ).toBe(false);
  });

  it('returns credits and ERC-20 separately without pretending NFT and loan discovery is complete', async () => {
    const { service, reads } = fixture();
    const result = await service.getPosition(ref, holder);
    expect(result).toMatchObject({
      credits: { value: '7000000000000000000' },
      erc20Balance: { value: '3000000000000000000' },
      totalBalance: { value: '10000000000000000000' },
      nfts: { status: 'unknown' },
      loans: { status: 'unknown' },
    });
    expect(reads.find((read) => read.functionName === 'creditBalanceOf')).toMatchObject({
      address: tokenStore,
      args: [holder, 42n],
    });
  });

  it('reports a confirmed absent ERC-20 as zero while preserving unclaimed credits', async () => {
    const { service, reads } = fixture((request) =>
      request.functionName === 'tokenOf'
        ? zeroAddress
        : request.functionName === 'totalBalanceOf'
          ? 7n * 10n ** 18n
          : passthrough,
    );
    const result = await service.getPosition(ref, holder);
    expect(result.erc20Balance).toEqual({ status: 'known', value: '0' });
    expect(result.credits).toEqual({ status: 'known', value: '7000000000000000000' });
    expect(reads.some((read) => read.functionName === 'balanceOf')).toBe(false);
  });

  it('paginates by basedOnId rather than arithmetic on timestamp IDs', async () => {
    const { service, reads } = fixture();
    const result = await service.getRulesets(ref, { limit: 1, startingId: '1700000000' });
    expect(result.page).toMatchObject({
      status: 'known',
      value: { nextStartingId: '1600000000', order: 'newestFirst' },
    });
    expect(reads.find((read) => read.functionName === 'allRulesetsOf')?.args).toEqual([
      42n,
      1700000000n,
      1n,
    ]);
    await expect(service.getRulesets(ref, { limit: 51 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('keeps failed permission checks unknown even for the owner account and checks root/wildcard explicitly', async () => {
    const { service, reads } = fixture((request) => {
      if (request.functionName === 'hasPermission') throw new Error('RPC outage');
      return passthrough;
    });
    const result = await service.getPermissions(ref, {
      operator: holder,
      account: holder,
      permissionIds: [2],
    });
    expect(result.operatorIsAccount).toBe(true);
    expect(result.checks).toEqual([
      { id: 2, name: 'QUEUE_RULESETS', granted: expect.objectContaining({ status: 'unknown' }) },
    ]);
    expect(result.wildcardBitmap).toMatchObject({ value: { permissionIds: [1] } });
    expect(reads.find((read) => read.functionName === 'hasPermission')?.args).toEqual([
      holder,
      holder,
      42n,
      2n,
      true,
      true,
    ]);
  });
});

describe('ProjectService bridge evidence', () => {
  const sucker = '0x8888888888888888888888888888888888888888' as const;
  const remoteSucker = '0x9999999999999999999999999999999999999999' as const;
  function bridgeFixture(mismatch = false) {
    return fixture((request, chainId) => {
      switch (request.functionName) {
        case 'allSuckersOf':
          return [sucker];
        case 'suckersOf':
          return []; // Deprecated discovery remains visible.
        case 'projectId':
          return chainId === 1 ? 42n : 17n;
        case 'peer':
          return chainId === 1
            ? pad(remoteSucker, { size: 32 })
            : pad(mismatch ? custom : sucker, { size: 32 });
        case 'peerChainId':
          return chainId === 1 ? 10n : 1n;
        case 'isSuckerOf':
          return true;
        case 'state':
          return 3;
        case 'peerChainAccountsOf':
          return [
            {
              chainId: 10n,
              totalSupply: 500n,
              timestamp: 1699999999n,
              contexts: [
                { token: pad(native, { size: 32 }), decimals: 18, surplus: 20n, balance: 40n },
              ],
            },
          ];
        case 'CCIP_ROUTER':
          return custom;
        case 'OPMESSENGER':
        case 'GATEWAYROUTER':
          throw new Error('unsupported probe');
        case 'remoteTokenFor':
          return {
            enabled: false,
            emergencyHatch: false,
            minGas: 200000,
            addr: pad(native, { size: 32 }),
          };
        case 'outboxOf':
          return {
            nonce: 1n,
            numberOfClaimsSent: 5n,
            balance: 0n,
            tree: { branch: [], count: 5n },
          };
        case 'inboxOf':
          return { nonce: 2n, root: zeroHash };
        case 'amountToAddToBalanceOf':
          return 25n;
        default:
          return passthrough;
      }
    });
  }

  it('verifies remote per-chain project IDs and reciprocal registry membership, retains deprecated bridges and gossip freshness', async () => {
    const { service, logs, reads } = bridgeFixture();
    const result = await service.getBridgeStatus(ref, { holder });
    expect(result.bridges).toMatchObject({
      status: 'known',
      value: [
        {
          activeRegistryMember: { value: false },
          identity: {
            value: {
              peerChainId: '10',
              remote: {
                status: 'known',
                value: { project: { chainId: 10, projectId: '17' }, evidence: { chainId: 10 } },
              },
            },
          },
          state: { value: { name: 'deprecated' } },
          accountingGossip: { value: [{ timestamp: '1699999999' }] },
          transport: { value: { type: 'ccip' } },
          outboxEvents: { status: 'unknown', error: { code: 'LOG_RANGE_REQUIRED' } },
        },
      ],
    });
    expect(
      reads.find((read) => read.chainId === 10 && read.functionName === 'isSuckerOf')?.args,
    ).toEqual([17n, remoteSucker]);
    expect(logs).not.toHaveBeenCalled();
  });

  it('does not identify a mismatched remote peer as a verified group member', async () => {
    const { service } = bridgeFixture(true);
    expect((await service.getBridgeStatus(ref)).bridges).toMatchObject({
      value: [
        {
          identity: {
            value: { remote: { status: 'unknown', error: { code: 'BRIDGE_IDENTITY_MISMATCH' } } },
          },
        },
      ],
    });
  });

  it('requires bounded history and labels empty ranges without implying no outstanding claims', async () => {
    const { service, logs } = bridgeFixture();
    await expect(service.getBridgeStatus(ref, { fromBlock: '0' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    const result = await service.getBridgeStatus(ref, {
      holder,
      fromBlock: '19999900',
      toBlock: '20000000',
    });
    expect(logs).toHaveBeenCalledWith(
      expect.objectContaining({
        fromBlock: 19999900n,
        toBlock: 20000000n,
        args: { beneficiary: pad(holder, { size: 32 }) },
      }),
    );
    expect(result.bridges).toMatchObject({
      value: [
        {
          outboxEvents: {
            status: 'known',
            value: { items: [], completeWithinRange: true, allHistory: false },
          },
        },
      ],
    });
  });
});
