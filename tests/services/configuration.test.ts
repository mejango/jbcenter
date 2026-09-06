import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, zeroAddress, type Address, type PublicClient } from 'viem';
import { jbControllerAbi, NATIVE_TOKEN } from '@bananapus/nana-sdk-core';
import { buildRulesetMetadata, v6Address } from '@bananapus/nana-sdk-core/v6';
import { ConfigurationService, changedLockedSplits } from '../../src/services/configuration.js';
import type { ChainId, RpcProvider } from '../../src/domain/types.js';

const account = '0x1111111111111111111111111111111111111111' as const;
const another = '0x2222222222222222222222222222222222222222' as const;
const metadata = buildRulesetMetadata();
const stored = {
  cycleNumber: 1,
  id: 1000,
  basedOnId: 0,
  start: 1000,
  duration: 86400,
  weight: 1000n,
  weightCutPercent: 0,
  approvalHook: zeroAddress,
  metadata: 0n,
};
function configuration() {
  return {
    mustStartAtOrAfter: '0',
    duration: '86400',
    weight: '1000000000000000000000',
    weightCutPercent: '0',
    approvalHook: zeroAddress,
    metadata: {
      ...metadata,
      reservedPercent: '2500',
      cashOutTaxRate: '5000',
      baseCurrency: '1',
      metadata: '0',
    },
    splitGroups: [],
    fundAccessLimitGroups: [],
  };
}
function mockRpc(overrides: Record<string, unknown> = {}, chainId: ChainId = 1) {
  const readContract = vi.fn(async (request: { functionName: string; blockNumber?: bigint }) => {
    const values: Record<string, unknown> = {
      controllerOf: v6Address('JBController', chainId),
      ownerOf: account,
      currentRulesetOf: [stored, metadata],
      upcomingRulesetOf: [{ ...stored, id: 0 }, metadata],
      allRulesetsOf: [{ ruleset: stored, metadata }],
      currentApprovalStatusForLatestRulesetOf: 4,
      OMNICHAIN_RULESET_OPERATOR: another,
      terminalsOf: [],
      hasPermissions: false,
      splitsOf: [],
      payoutLimitsOf: [],
      surplusAllowancesOf: [],
      creationFee: 123456789n,
      accountingContextsOf: [],
      ...overrides,
    };
    const value = values[request.functionName];
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error(`Missing mock ${request.functionName}`);
    return value;
  });
  const getCode = vi.fn(async () => '0x6000');
  const client = { readContract, getCode } as unknown as PublicClient;
  const rpc: RpcProvider = {
    client: () => client,
    snapshot: async () => ({
      client,
      evidence: {
        chainId,
        blockNumber: '12345',
        blockHash: `0x${'ab'.repeat(32)}`,
        timestamp: '2000',
        source: 'rpc',
      },
    }),
  };
  return { rpc, readContract, getCode, service: new ConfigurationService(rpc) };
}

describe('configuration planning', () => {
  it('prepares canonical exact launch calldata with the observed fee and explicit owner', async () => {
    const { service, readContract, getCode } = mockRpc();
    const plan = await service.prepareLaunch({
      chainId: 1,
      account,
      owner: another,
      composition: 'core',
      projectUri: 'ipfs://example',
      rulesetConfigurations: [configuration()],
      terminalConfigurations: [],
      memo: 'launch',
    });
    const call = plan.calls[0]!;
    expect(call.to).toBe(v6Address('JBController', 1));
    expect(call.value).toBe('123456789');
    const decoded = decodeFunctionData({ abi: jbControllerAbi, data: call.data });
    expect(decoded.functionName).toBe('launchProjectFor');
    if (decoded.functionName !== 'launchProjectFor') throw new Error('wrong function');
    expect(decoded.args[0]).toBe(another);
    expect(decoded.args[2][0]?.weight).toBe(1000000000000000000000n);
    expect(decoded.args[4]).toBe('launch');
    expect(call.decoded.functionName).toBe('launchProjectFor');
    expect(plan.warnings.join(' ')).toMatch(/not proof/);
    expect(readContract.mock.calls.every(([request]) => request.blockNumber === 12345n)).toBe(true);
    expect(getCode).toHaveBeenCalledWith({
      address: v6Address('JBController', 1),
      blockNumber: 12345n,
    });
  });

  it('uses independent live creation fees and independent chain payout budgets', async () => {
    const mainnet = mockRpc({ creationFee: 11n }, 1);
    const optimism = mockRpc({ creationFee: 99n }, 10);
    const prepare = async (service: ConfigurationService, chainId: 1 | 10) => {
      const terminal = v6Address('JBMultiTerminal', chainId);
      const group = {
        terminal,
        token: NATIVE_TOKEN,
        payoutLimits: [{ currency: '2', amount: '1000000' }],
        surplusAllowances: [],
      };
      return service.prepareLaunch({
        chainId,
        account,
        owner: account,
        composition: 'core',
        projectUri: '',
        rulesetConfigurations: [{ ...configuration(), fundAccessLimitGroups: [group] }],
        terminalConfigurations: [
          {
            terminal,
            accountingContextsToAccept: [
              { token: NATIVE_TOKEN, decimals: '18', currency: '61166' },
            ],
          },
        ],
      });
    };
    const [first, second] = await Promise.all([
      prepare(mainnet.service, 1),
      prepare(optimism.service, 10),
    ]);
    expect(first.calls[0]?.value).toBe('11');
    expect(second.calls[0]?.value).toBe('99');
    for (const plan of [first, second]) {
      const decoded = decodeFunctionData({ abi: jbControllerAbi, data: plan.calls[0]!.data });
      if (decoded.functionName !== 'launchProjectFor') throw new Error('wrong function');
      expect(decoded.args[2][0]?.fundAccessLimitGroups[0]?.payoutLimits[0]?.amount).toBe(1000000n);
      expect(plan.warnings.join(' ')).toContain('separate for each chain');
    }
  });

  it('fails closed on unreadable fee, unavailable deployment, or custom controller', async () => {
    const launch = {
      chainId: 1 as const,
      account,
      owner: account,
      composition: 'core' as const,
      projectUri: '',
      rulesetConfigurations: [configuration()],
      terminalConfigurations: [],
    };
    await expect(
      mockRpc({ creationFee: new Error('RPC unavailable') }).service.prepareLaunch(launch),
    ).rejects.toThrow('RPC unavailable');
    const absent = mockRpc();
    absent.getCode.mockResolvedValueOnce('0x');
    await expect(absent.service.prepareLaunch(launch)).rejects.toMatchObject({
      code: 'DEPLOYMENT_UNAVAILABLE',
    });
    await expect(
      mockRpc({ controllerOf: another }).service.prepareRulesetChange({
        project: { chainId: 1, projectId: '7' },
        account,
        rulesetConfigurations: [configuration()],
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTROLLER' });
  });

  it('previews authorization truthfully and prevents unauthorized preparation', async () => {
    const input = {
      project: { chainId: 1 as const, projectId: '7' },
      account,
      rulesetConfigurations: [configuration()],
    };
    const denied = mockRpc({ ownerOf: another, OMNICHAIN_RULESET_OPERATOR: zeroAddress });
    const preview = await denied.service.previewRulesetChange(input);
    expect(preview.permission.authorized).toBe(false);
    await expect(denied.service.prepareRulesetChange(input)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(denied.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'hasPermissions',
        args: [account, another, 7n, [2n], true, true],
        blockNumber: 12345n,
      }),
    );
    const permitted = mockRpc({
      ownerOf: another,
      OMNICHAIN_RULESET_OPERATOR: zeroAddress,
      hasPermissions: true,
    });
    expect((await permitted.service.prepareRulesetChange(input)).operation).toBe('ruleset-change');
    await expect(
      mockRpc({
        ownerOf: another,
        OMNICHAIN_RULESET_OPERATOR: zeroAddress,
        hasPermissions: new Error('unknown'),
      }).service.prepareRulesetChange(input),
    ).rejects.toThrow('unknown');
  });

  it('honors the controller omnichain operator override and never promises proposed dates', async () => {
    const { service } = mockRpc({
      ownerOf: another,
      OMNICHAIN_RULESET_OPERATOR: account,
      currentRulesetOf: [{ ...stored, approvalHook: another }, metadata],
    });
    const preview = await service.previewRulesetChange({
      project: { chainId: 1, projectId: '7' },
      account,
      rulesetConfigurations: [{ ...configuration(), mustStartAtOrAfter: '999999' }],
    });
    expect(preview.permission.authorizedByOmnichainOperator).toBe(true);
    expect(preview.timing.proposedStartTimes).toBeNull();
    expect(preview.timing.reason).toContain('custom hook');
    expect(preview.upcoming).toBeNull();
    expect(preview.warnings.join(' ')).toContain('zero. This does not mean unlimited payouts');
    expect(preview.economicChanges[0]?.changes).toContainEqual({
      field: 'metadata.reservedPercent',
      current: '0',
      proposed: '2500',
    });
    expect(preview.economicChanges[0]?.proposedStartLowerBound).toBe('999999');
  });

  it('encodes a queue with exact zero and sentinel weights and pinned evidence', async () => {
    const { service, readContract } = mockRpc();
    const plan = await service.prepareRulesetChange({
      project: { chainId: 1, projectId: '7' },
      account,
      rulesetConfigurations: [
        { ...configuration(), weight: '0' },
        { ...configuration(), weight: '1' },
      ],
      memo: 'new terms',
    });
    const decoded = decodeFunctionData({ abi: jbControllerAbi, data: plan.calls[0]!.data });
    expect(decoded.functionName).toBe('queueRulesetsOf');
    if (decoded.functionName !== 'queueRulesetsOf') throw new Error('wrong function');
    expect(decoded.args[0]).toBe(7n);
    expect(decoded.args[1].map((config) => config.weight)).toEqual([0n, 1n]);
    expect(decoded.args[2]).toBe('new terms');
    expect(plan.calls[0]?.value).toBe('0');
    expect(readContract.mock.calls.every(([request]) => request.blockNumber === 12345n)).toBe(true);
  });

  it('does not assert inheritance when a future initial configuration might be replaced without a predecessor', async () => {
    const { service } = mockRpc({
      currentRulesetOf: [{ ...stored, id: 0, cycleNumber: 0, weight: 0n }, metadata],
      upcomingRulesetOf: [{ ...stored, start: 9000 }, metadata],
    });
    const preview = await service.previewRulesetChange({
      project: { chainId: 1, projectId: '7' },
      account,
      rulesetConfigurations: [{ ...configuration(), weight: '1' }],
    });
    expect(preview.currentRulesetStatus).toBe('none-active');
    expect(preview.economicChanges[0]?.weightResolution).toContain('otherwise literal 1');
    expect(preview.warnings.join(' ')).toContain(
      'Replacing a future initial configuration can select no predecessor',
    );
    expect(preview.timing.proposedStartTimes).toBeNull();
  });

  it('reports fallback routing and changed locks without claiming new-table locks are enforced', async () => {
    const locked = {
      percent: 500000000,
      projectId: 0n,
      beneficiary: account,
      preferAddToBalance: false,
      lockedUntil: 3000,
      hook: zeroAddress,
    };
    const { service } = mockRpc({ splitsOf: [locked] });
    const preview = await service.previewRulesetChange({
      project: { chainId: 1, projectId: '7' },
      account,
      rulesetConfigurations: [
        {
          ...configuration(),
          splitGroups: [
            {
              groupId: '1',
              splits: [
                {
                  ...locked,
                  beneficiary: another,
                  percent: '500000000',
                  projectId: '0',
                  lockedUntil: '3000',
                },
              ],
            },
          ],
        },
      ],
    });
    expect(preview.lockChanges).toEqual([
      {
        configurationIndex: 0,
        groups: [
          {
            groupId: '1',
            removedOrWeakenedLockedSplits: [{ ...locked, projectId: '0' }],
            usesFallbackSplits: false,
          },
        ],
      },
    ]);
    expect(preview.warnings.join(' ')).toContain('Fallback split tables exist');
    expect(preview.warnings.join(' ')).toContain('A new ruleset table can permit this on-chain');
  });
});

describe('split-lock continuity comparison', () => {
  const locked = {
    percent: 250000000,
    projectId: 0n,
    beneficiary: account as Address,
    preferAddToBalance: false,
    lockedUntil: 3000,
    hook: zeroAddress,
  };
  it('preserves multiplicity and does not reuse one proposed split for two current locks', () => {
    expect(changedLockedSplits([locked, locked], [locked], 2000n)).toEqual([locked]);
    expect(changedLockedSplits([locked, locked], [locked, locked], 2000n)).toEqual([]);
  });
  it('allows extending locks but flags shorter locks and ignores expired locks', () => {
    expect(changedLockedSplits([locked], [{ ...locked, lockedUntil: 4000 }], 2000n)).toEqual([]);
    expect(changedLockedSplits([locked], [{ ...locked, lockedUntil: 2500 }], 2000n)).toEqual([
      locked,
    ]);
    expect(changedLockedSplits([locked], [], 3000n)).toEqual([]);
  });
});
