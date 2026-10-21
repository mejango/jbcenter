import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, getAddress, zeroAddress, type Address, type PublicClient } from 'viem';
import {
  jbContractAddress,
  jbControllerAbi,
  jbOmnichainDeployerAbi,
  NATIVE_TOKEN,
} from '@bananapus/nana-sdk-core';
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
  type Request = { functionName: string; args?: readonly unknown[]; blockNumber?: bigint };
  const readContract = vi.fn(async (request: Request) => {
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
      tokenOf: zeroAddress,
      ...overrides,
    };
    const value = values[request.functionName];
    if (typeof value === 'function') return (value as (request: Request) => unknown)(request);
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

  it('names the canonical JBDeadline hooks and keeps any other approval hook unknown', async () => {
    const launch = (approvalHook: Address) =>
      mockRpc().service.prepareLaunch({
        chainId: 1,
        account,
        owner: another,
        composition: 'core',
        projectUri: '',
        rulesetConfigurations: [{ ...configuration(), approvalHook }],
        terminalConfigurations: [],
      });
    const deadline = (
      await launch(getAddress(jbContractAddress['6'].JBDeadline3Days[1]))
    ).warnings.join(' ');
    expect(deadline).toContain('the approval hook is the canonical JBDeadline3Days');
    expect(deadline).not.toContain('custom approval hook');
    expect((await launch(another)).warnings.join(' ')).toContain('custom approval hook');
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

describe('revnet modeling source', () => {
  const scenario = { label: 'one', contributionInBaseCurrency18: '1000000000000000000' };
  const owner = v6Address('REVOwner', 8453);

  it('reads a revnet project through the revnet reader, and nothing else', async () => {
    const { service } = mockRpc();
    const read = vi.fn(async () => ({
      current: {
        ruleset: { id: '5', start: '100', duration: '0', weight: '7', weightCutPercent: '0' },
        metadata: {
          reservedPercent: 0,
          cashOutTaxRate: 0,
          baseCurrency: 1,
          pausePay: false,
          dataHook: owner,
        },
      },
      stages: [],
      cashOutDelay: { until: '0', active: false },
      evidence: [],
    }));
    const project = { chainId: 8453 as const, projectId: '6' };
    const result = await service.modelEconomics(
      { revnet: { project }, completedCycles: 0, scenarios: [scenario] },
      read,
    );
    expect(read).toHaveBeenCalledWith({ ...project, version: 6 });
    expect(result.effectiveWeight).toBe('7');
    await expect(
      service.modelEconomics({ revnet: { project }, completedCycles: 0, scenarios: [scenario] }),
    ).rejects.toThrow(/reader/);
  });
});

describe('project ERC-20 and URI preparation', () => {
  const project = { chainId: 1 as const, projectId: '7' };
  const erc20 = { project, account, name: 'Lattice', symbol: 'LATT' };

  it('prepares deployERC20For for the owner with the salt and names the follow-up', async () => {
    const plan = await mockRpc().service.prepareDeployErc20({
      ...erc20,
      salt: `0x${'cd'.repeat(32)}`,
    });
    const decoded = decodeFunctionData({ abi: jbControllerAbi, data: plan.calls[0]!.data });
    expect(plan.calls[0]!.to).toBe(v6Address('JBController', 1));
    expect(decoded.functionName).toBe('deployERC20For');
    expect(decoded.args).toEqual([7n, 'Lattice', 'LATT', `0x${'cd'.repeat(32)}`]);
    expect(plan.summary).toMatchObject({
      permission: { required: 'DEPLOY_ERC20', id: 8, authorizedByOwner: true },
    });
  });

  it('accepts a DEPLOY_ERC20 holder and refuses everyone else or a second token', async () => {
    const holder = mockRpc({ ownerOf: another, hasPermissions: true });
    const plan = await holder.service.prepareDeployErc20(erc20);
    expect(plan.summary).toMatchObject({ permission: { authorizedByPermission: true } });
    const request = holder.readContract.mock.calls.find(
      ([call]) => call.functionName === 'hasPermissions',
    )![0] as unknown as { args: unknown[] };
    expect(request.args).toEqual([account, another, 7n, [8n], true, true]);
    await expect(
      mockRpc({ ownerOf: another }).service.prepareDeployErc20(erc20),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      mockRpc({ tokenOf: another }).service.prepareDeployErc20(erc20),
    ).rejects.toMatchObject({ code: 'PROJECT_ALREADY_HAS_ERC20' });
    await expect(mockRpc().service.prepareDeployErc20({ ...erc20, symbol: '' })).rejects.toThrow();
  });

  it('prepares setUriOf for the owner and warns on a non-IPFS URI', async () => {
    const plan = await mockRpc().service.prepareSetProjectUri({
      project,
      account,
      uri: 'https://example.com/x.json',
    });
    const decoded = decodeFunctionData({ abi: jbControllerAbi, data: plan.calls[0]!.data });
    expect(decoded.functionName).toBe('setUriOf');
    expect(decoded.args).toEqual([7n, 'https://example.com/x.json']);
    expect(plan.summary).toMatchObject({ permission: { required: 'SET_PROJECT_URI', id: 7 } });
    expect(plan.warnings.join(' ')).toContain('ipfs://');
  });

  it('routes a revnet URI change through its operator', async () => {
    const revOwner = v6Address('REVOwner', 1);
    const operator = mockRpc({ ownerOf: revOwner, hasPermissions: true });
    const plan = await operator.service.prepareSetProjectUri({ project, account, uri: 'ipfs://x' });
    expect(plan.summary).toMatchObject({ owner: revOwner });
    await expect(
      mockRpc({ ownerOf: revOwner }).service.prepareSetProjectUri({
        project,
        account,
        uri: 'ipfs://x',
      }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      message: expect.stringContaining('operator'),
    });
  });

  it('tells a launch with no URI how to name it and add an ERC-20 later', async () => {
    const plan = await mockRpc().service.prepareLaunch({
      chainId: 1,
      account,
      owner: account,
      composition: 'core',
      projectUri: '',
      rulesetConfigurations: [configuration()],
      terminalConfigurations: [],
    });
    const text = plan.warnings.join(' ');
    expect(text).toContain('jb_prepare_set_project_uri');
    expect(text).toContain('jb_prepare_deploy_erc20');
    expect(text).toContain('jb_prepare_omnichain_launch');
  });
});

describe('current ruleset as preview input', () => {
  const terminal = v6Address('JBMultiTerminal', 1);
  const reservedSplit = {
    percent: 500_000_000,
    projectId: 0n,
    beneficiary: another,
    preferAddToBalance: false,
    lockedUntil: 0,
    hook: zeroAddress,
  };
  const fallbackSplit = { ...reservedSplit, percent: 1_000_000_000, beneficiary: account };
  const live = {
    currentRulesetOf: [
      { ...stored, weight: 987654321987654321987n, weightCutPercent: 50_000_000 },
      { ...metadata, reservedPercent: 2000, cashOutTaxRate: 3000, baseCurrency: 2, holdFees: true },
    ],
    terminalsOf: [terminal],
    accountingContextsOf: [{ token: NATIVE_TOKEN, decimals: 18, currency: 61166 }],
    // Group 1 is stored, with an empty fallback. Group 61166 reads equal to its fallback: either an explicit table
    // that matches the fallback, or none stored and splitsOf resolving ruleset 0. Both states read identically.
    splitsOf: ({ args }: { args: readonly bigint[] }) =>
      args[2] === 1n ? (args[1] === 0n ? [] : [reservedSplit]) : [fallbackSplit],
    payoutLimitsOf: [{ amount: 2_000_000_000_000_000_000n, currency: 1 }],
  };

  it('returns the active ruleset in the input shape, keeps an explicit table that equals the fallback, and reports what it omits', async () => {
    const { service } = mockRpc(live);
    const project = { chainId: 1 as const, projectId: '7' };
    const current = await service.currentRulesetInput(project, 12345n);
    const input = current!.rulesetConfiguration;
    expect(input).toMatchObject({
      mustStartAtOrAfter: '0',
      duration: '86400',
      weight: '987654321987654321987',
      weightCutPercent: '50000000',
      metadata: { reservedPercent: '2000', baseCurrency: '2', holdFees: true },
      fundAccessLimitGroups: [
        {
          terminal,
          token: NATIVE_TOKEN,
          payoutLimits: [{ amount: '2000000000000000000', currency: '1' }],
          surplusAllowances: [],
        },
      ],
    });
    // Equality does not prove inheritance: the group stays, preserving today's recipients, and is marked unknown.
    expect(input.splitGroups).toEqual([
      expect.objectContaining({
        groupId: '1',
        splits: [expect.objectContaining({ beneficiary: another })],
      }),
      expect.objectContaining({
        groupId: '61166',
        splits: [expect.objectContaining({ beneficiary: account })],
      }),
    ]);
    expect(current!.coverage).toMatchObject({
      status: 'incomplete',
      splitGroupsRead: ['1', '61166'],
      splitGroupProvenance: [
        { groupId: '1', provenance: 'stored' },
        { groupId: '61166', provenance: 'unknown' },
      ],
      fundAccessLimitPairsRead: [{ terminal, token: NATIVE_TOKEN }],
    });
    expect(current!.coverage.notCovered.join(' ')).toContain('hook-defined group IDs');
    const preview = await service.previewRulesetChange({
      project,
      account,
      rulesetConfigurations: [input],
    });
    // economicChanges compares scalar fields only; the split tables are checked through lockChanges.
    expect(preview.economicChanges[0]!.changes).toEqual([]);
    expect(preview.lockChanges).toMatchObject([
      {
        groups: [
          { groupId: '1', usesFallbackSplits: false },
          { groupId: '61166', usesFallbackSplits: false },
        ],
      },
    ]);
    // Edit one field: only that field differs.
    const edited = { ...input, metadata: { ...input.metadata, reservedPercent: '1000' } };
    const changed = await service.previewRulesetChange({
      project,
      account,
      rulesetConfigurations: [edited],
    });
    expect(changed.economicChanges[0]!.changes).toEqual([
      { field: 'metadata.reservedPercent', current: '2000', proposed: '1000' },
    ]);
  });

  it('returns null when no ruleset is active', async () => {
    const { service } = mockRpc({ currentRulesetOf: [{ ...stored, id: 0 }, metadata] });
    await expect(
      service.currentRulesetInput({ chainId: 1, projectId: '7' }, 12345n),
    ).resolves.toBeNull();
  });
});

describe('ruleset changes on projects launched through JBOmnichainDeployer', () => {
  // Shaped like Base project 14: deployer-wired, NFT hook recorded, duration 0, no approval hook.
  const chainId = 8453 as const;
  const deployer = v6Address('JBOmnichainDeployer', chainId);
  const owner = getAddress('0x5138a42C3D5065debE950deBDa10C1f38150a908');
  const nft = getAddress('0x5a834cdB371bF649188cad912dFeFEe9966773Ab');
  const extraHook = getAddress('0x3333333333333333333333333333333333333333');
  const live = { ...stored, id: 1500, start: 1500, duration: 0 };
  const wired = {
    ...metadata,
    useDataHookForPay: true,
    useDataHookForCashOut: true,
    dataHook: deployer,
  };
  const noExtra = { dataHook: zeroAddress, useDataHookForPay: false, useDataHookForCashOut: false };
  const project = { chainId, projectId: '14' };
  function omnichain(overrides: Record<string, unknown> = {}) {
    return mockRpc(
      {
        ownerOf: owner,
        currentRulesetOf: [live, wired],
        allRulesetsOf: [{ ruleset: live, metadata: wired }],
        currentApprovalStatusForLatestRulesetOf: 0,
        OMNICHAIN_RULESET_OPERATOR: deployer,
        tiered721HookOf: [nft, false],
        extraDataHookOf: noExtra,
        ...overrides,
      },
      chainId,
    );
  }
  // A copy of the live ruleset, as get_rulesets currentAsInput returns it.
  const copy = () => ({
    ...configuration(),
    duration: '0',
    metadata: {
      ...configuration().metadata,
      useDataHookForPay: true,
      useDataHookForCashOut: true,
      dataHook: deployer,
    },
  });

  it('queues through the deployer, keeps the NFT hook and the extra hook, and starts at execution', async () => {
    const { service, readContract } = omnichain();
    const plan = await service.prepareRulesetChange({
      project,
      account: owner,
      rulesetConfigurations: [copy()],
      memo: 'choo',
    });
    const call = plan.calls[0]!;
    expect(call.to).toBe(deployer);
    expect(call.label).toContain('JBOmnichainDeployer');
    const decoded = decodeFunctionData({ abi: jbOmnichainDeployerAbi, data: call.data });
    expect(decoded.functionName).toBe('queueRulesetsOf');
    const args = decoded.args as readonly unknown[];
    expect(args).toHaveLength(3);
    expect(args[0]).toBe(14n);
    expect(args[2]).toBe('choo');
    const sent = (args[1] as readonly { metadata: Record<string, unknown> }[])[0]!.metadata;
    expect(sent).toMatchObject({ dataHook: zeroAddress, useDataHookForPay: false });
    const summary = plan.summary as Awaited<ReturnType<typeof service.previewRulesetChange>>;
    expect(summary.route).toMatchObject({
      via: 'JBOmnichainDeployer',
      tiered721Hook: nft,
      tiered721HookSource: { ruleset: 'latest', id: '1500' },
    });
    expect(summary.timing.status).toBe('at-execution');
    expect(summary.economicChanges[0]!.changes.map((change) => change.field)).not.toContain(
      'metadata.dataHook',
    );
    const warnings = plan.warnings.join(' ');
    expect(warnings).toContain('JBOmnichainDeployer.queueRulesetsOf');
    expect(warnings).not.toContain('a data hook is configured');
    expect(readContract.mock.calls.every(([request]) => request.blockNumber === 12345n)).toBe(true);
  });

  it('passes a new extra data hook through and names it', async () => {
    const { service } = omnichain();
    const config = copy();
    const preview = await service.previewRulesetChange({
      project,
      account: owner,
      rulesetConfigurations: [{ ...config, metadata: { ...config.metadata, dataHook: extraHook } }],
    });
    expect(preview.proposed[0]!.metadata.dataHook).toBe(extraHook);
    expect(preview.warnings.join(' ')).toContain(`runs ${extraHook} behind it`);
  });

  it('checks the signer the way the deployer does', async () => {
    const input = { project, account, rulesetConfigurations: [copy()] };
    await expect(omnichain().service.prepareRulesetChange(input)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    const permitted = await omnichain({ hasPermissions: true }).service.prepareRulesetChange(input);
    expect(permitted.calls[0]!.to).toBe(deployer);
  });

  it('refuses a queue the deployer would revert', async () => {
    const input = { project, account: owner, rulesetConfigurations: [copy()] };
    await expect(
      omnichain({ tiered721HookOf: [zeroAddress, false] }).service.prepareRulesetChange(input),
    ).rejects.toMatchObject({ code: 'OMNICHAIN_HOOK_MISSING' });
    await expect(
      omnichain({ OMNICHAIN_RULESET_OPERATOR: another }).service.prepareRulesetChange(input),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTROLLER' });
  });

  it('carries the current hook when the latest ruleset is not approved', async () => {
    const queued = { ...live, id: 1600, start: 5000 };
    const { service } = omnichain({
      allRulesetsOf: [{ ruleset: queued, metadata: wired }],
      currentApprovalStatusForLatestRulesetOf: 3,
      tiered721HookOf: ({ args }: { args: readonly bigint[] }) =>
        args[1] === 1600n ? [extraHook, false] : [nft, true],
    });
    const preview = await service.previewRulesetChange({
      project,
      account: owner,
      rulesetConfigurations: [copy()],
    });
    expect(preview.route).toMatchObject({
      tiered721Hook: nft,
      tiered721HookSource: { ruleset: 'current', id: '1500' },
      useTiered721HookForCashOut: true,
    });
    expect(preview.timing.status).toBe('unresolved-until-execution');
  });

  it('keeps JBController for other projects', async () => {
    const { service } = mockRpc();
    const preview = await service.previewRulesetChange({
      project: { chainId: 1, projectId: '7' },
      account,
      rulesetConfigurations: [configuration()],
    });
    expect(preview.route).toEqual({ via: 'JBController', address: v6Address('JBController', 1) });
  });
});
