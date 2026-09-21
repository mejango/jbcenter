import {
  jbControllerAbi,
  jbDirectoryAbi,
  jbFundAccessLimitsAbi,
  jbMultiTerminalAbi,
  jbPermissionsAbi,
  jbProjectsAbi,
  jbRulesetsAbi,
  jbSplitsAbi,
} from '@bananapus/nana-sdk-core';
import {
  buildLaunchProjectTx,
  buildQueueRulesetsTx,
  JBPermissionIdsV6,
  v6Address,
} from '@bananapus/nana-sdk-core/v6';
import {
  decodeFunctionData,
  encodeFunctionData,
  isAddressEqual,
  zeroAddress,
  type Address,
} from 'viem';
import type { z } from 'zod';
import { DomainError } from '../domain/errors.js';
import { jsonSafe } from '../domain/json.js';
import {
  modelEconomics,
  modelEconomicsSchema,
  prepareLaunchSchema,
  prepareRulesetChangeSchema,
  previewRulesetChangeSchema,
  toRulesetConfig,
  toTerminalConfig,
  type PreviewRulesetChangeInput,
  type RulesetConfigInput,
} from '../domain/rulesets.js';
import type { PlanDraft, PreparedCall, RpcProvider } from '../domain/types.js';

type StoredSplit = {
  percent: number;
  projectId: bigint;
  beneficiary: Address;
  preferAddToBalance: boolean;
  lockedUntil: number;
  hook: Address;
};

/** Cross-ruleset continuity is a governance comparison, not a lock enforced on a new split table. */
export function changedLockedSplits(
  current: readonly StoredSplit[],
  proposed: readonly StoredSplit[],
  timestamp: bigint,
): StoredSplit[] {
  const available = proposed.slice();
  const changed: StoredSplit[] = [];
  // Largest required lock first makes matching deterministic when otherwise identical locks differ.
  for (const locked of current
    .filter((split) => BigInt(split.lockedUntil) > timestamp)
    .sort((a, b) => b.lockedUntil - a.lockedUntil)) {
    const index = available.findIndex(
      (split) =>
        split.percent === locked.percent &&
        split.projectId === locked.projectId &&
        isAddressEqual(split.beneficiary, locked.beneficiary) &&
        split.preferAddToBalance === locked.preferAddToBalance &&
        isAddressEqual(split.hook, locked.hook) &&
        split.lockedUntil >= locked.lockedUntil,
    );
    if (index === -1) changed.push(locked);
    else available.splice(index, 1);
  }
  return changed;
}

function configurationWarnings(configurations: RulesetConfigInput[]): string[] {
  const warnings = [
    'This action configures one chain only. An omnichain project requires coordinated, separately reviewed chain actions; this call does not synchronize remote projects or payout budgets.',
    'A configured mustStartAtOrAfter is a lower bound. Queue selection, existing duration, approval hooks, and the execution block determine actual start times.',
    'The approvalHook in a proposed configuration gates its successor. Existing rulesets and their hooks determine whether this proposal takes effect.',
    'Queueing can replace an unapproved upcoming ruleset or append after an approved one. The proposed start bounds alone do not determine which existing queue entries remain active.',
    'Split locks protect rewriting the same ruleset/group table. A newly queued ruleset can change future routing before an old lock expires.',
    'Payout limits and surplus allowances reset independently within their contract-defined windows and are separate for each chain, terminal, token, and currency.',
  ];
  configurations.forEach((config, i) => {
    if (
      config.fundAccessLimitGroups.every((group) =>
        group.payoutLimits.every((limit) => limit.amount === '0'),
      )
    ) {
      warnings.push(
        `Configuration ${i}: all payout limits are zero. This does not mean unlimited payouts; surplus allowances, cash-outs, and enabled migrations have separate rules.`,
      );
    }
    if (config.weight === '0')
      warnings.push(
        `Configuration ${i}: payments issue zero project tokens before any enabled data-hook override.`,
      );
    if (config.weight === '1')
      warnings.push(
        `Configuration ${i}: weight=1 inherits the selected predecessor's decayed weight when that predecessor exists; otherwise it is literal 1. Replacing a future initial configuration can select no predecessor.`,
      );
    if (config.metadata.dataHook !== zeroAddress)
      warnings.push(
        `Configuration ${i}: a data hook is configured. Enabled hook behavior and any embedded permissions require contract-specific review and simulation.`,
      );
    if (config.approvalHook !== zeroAddress)
      warnings.push(
        `Configuration ${i}: a custom approval hook controls future changes. Its future decision and upgrade behavior are unknown.`,
      );
    if (
      config.splitGroups.some((group) => group.splits.some((split) => split.hook !== zeroAddress))
    )
      warnings.push(
        `Configuration ${i}: split hooks can execute custom recipient behavior; recipient outcomes are not inferred from percentages.`,
      );
  });
  return warnings;
}

export class ConfigurationService {
  constructor(private readonly rpc: RpcProvider) {}

  modelEconomics(input: z.input<typeof modelEconomicsSchema>) {
    return modelEconomics(input);
  }

  async previewRulesetChange(raw: z.input<typeof previewRulesetChangeSchema>) {
    return this.readChange(previewRulesetChangeSchema.parse(raw));
  }

  private async readChange(input: PreviewRulesetChangeInput) {
    const { project, account, rulesetConfigurations } = input;
    const projectId = BigInt(project.projectId);
    const { client, evidence } = await this.rpc.snapshot(project.chainId);
    const blockNumber = BigInt(evidence.blockNumber);
    const controller = v6Address('JBController', project.chainId);
    const directory = v6Address('JBDirectory', project.chainId);
    const [currentController, owner] = await Promise.all([
      client.readContract({
        address: directory,
        abi: jbDirectoryAbi,
        functionName: 'controllerOf',
        args: [projectId],
        blockNumber,
      }),
      client.readContract({
        address: v6Address('JBProjects', project.chainId),
        abi: jbProjectsAbi,
        functionName: 'ownerOf',
        args: [projectId],
        blockNumber,
      }),
    ]);
    if (!isAddressEqual(currentController, controller))
      throw new DomainError(
        'UNSUPPORTED_CONTROLLER',
        'This project does not use the canonical V6 controller. Preparing canonical calldata would be incorrect.',
        { details: { currentController, canonicalController: controller } },
      );

    const [current, upcoming, latest, latestApprovalStatus, omnichainOperator, terminals] =
      await Promise.all([
        client.readContract({
          address: controller,
          abi: jbControllerAbi,
          functionName: 'currentRulesetOf',
          args: [projectId],
          blockNumber,
        }),
        client.readContract({
          address: controller,
          abi: jbControllerAbi,
          functionName: 'upcomingRulesetOf',
          args: [projectId],
          blockNumber,
        }),
        client.readContract({
          address: controller,
          abi: jbControllerAbi,
          functionName: 'allRulesetsOf',
          args: [projectId, 0n, 17n],
          blockNumber,
        }),
        client.readContract({
          address: v6Address('JBRulesets', project.chainId),
          abi: jbRulesetsAbi,
          functionName: 'currentApprovalStatusForLatestRulesetOf',
          args: [projectId],
          blockNumber,
        }),
        client.readContract({
          address: controller,
          abi: jbControllerAbi,
          functionName: 'OMNICHAIN_RULESET_OPERATOR',
          blockNumber,
        }),
        client.readContract({
          address: directory,
          abi: jbDirectoryAbi,
          functionName: 'terminalsOf',
          args: [projectId],
          blockNumber,
        }),
      ]);
    if (terminals.length > 32)
      throw new DomainError(
        'CONFIGURATION_TOO_LARGE',
        'More than 32 terminals require a scoped configuration review.',
      );
    const authorizedByOwner = isAddressEqual(owner, account);
    const authorizedByOmnichainOperator = isAddressEqual(omnichainOperator, account);
    const authorizedByPermission =
      authorizedByOwner || authorizedByOmnichainOperator
        ? false
        : await client.readContract({
            address: v6Address('JBPermissions', project.chainId),
            abi: jbPermissionsAbi,
            functionName: 'hasPermissions',
            args: [
              account,
              owner,
              projectId,
              [BigInt(JBPermissionIdsV6.QUEUE_RULESETS)],
              true,
              true,
            ],
            blockNumber,
          });
    const terminalContexts = await Promise.all(
      terminals.map(async (terminal) => {
        const contexts = await client.readContract({
          address: terminal,
          abi: jbMultiTerminalAbi,
          functionName: 'accountingContextsOf',
          args: [projectId],
          blockNumber,
        });
        if (contexts.length > 32)
          throw new DomainError(
            'CONFIGURATION_TOO_LARGE',
            'More than 32 token contexts in a terminal require a scoped configuration review.',
          );
        return { terminal, contexts };
      }),
    );
    const contextPairs = terminalContexts.flatMap(({ terminal, contexts }) =>
      contexts.map((context) => ({ terminal, token: context.token })),
    );
    const pairs = new Map(
      contextPairs.map((pair) => [`${pair.terminal}:${pair.token}`.toLowerCase(), pair]),
    );
    for (const config of rulesetConfigurations)
      for (const group of config.fundAccessLimitGroups)
        pairs.set(`${group.terminal}:${group.token}`.toLowerCase(), {
          terminal: group.terminal,
          token: group.token,
        });
    if (pairs.size > 128)
      throw new DomainError(
        'CONFIGURATION_TOO_LARGE',
        'More than 128 terminal/token pairs require a scoped configuration review.',
      );
    const groupIds = new Set([
      '1',
      ...contextPairs.map((pair) => BigInt(pair.token).toString()),
      ...rulesetConfigurations.flatMap((config) =>
        config.splitGroups.map((group) => group.groupId),
      ),
    ]);
    const [splitGroups, fundAccessLimitGroups] = await Promise.all([
      Promise.all(
        [...groupIds].map(async (groupId) => {
          const [splits, fallbackSplits] = await Promise.all([
            client.readContract({
              address: v6Address('JBSplits', project.chainId),
              abi: jbSplitsAbi,
              functionName: 'splitsOf',
              args: [projectId, BigInt(current[0].id), BigInt(groupId)],
              blockNumber,
            }),
            client.readContract({
              address: v6Address('JBSplits', project.chainId),
              abi: jbSplitsAbi,
              functionName: 'splitsOf',
              args: [projectId, 0n, BigInt(groupId)],
              blockNumber,
            }),
          ]);
          return { groupId, splits, fallbackSplits };
        }),
      ),
      Promise.all(
        [...pairs.values()].map(async (pair) => {
          const [payoutLimits, surplusAllowances] = await Promise.all([
            client.readContract({
              address: v6Address('JBFundAccessLimits', project.chainId),
              abi: jbFundAccessLimitsAbi,
              functionName: 'payoutLimitsOf',
              args: [projectId, BigInt(current[0].id), pair.terminal, pair.token],
              blockNumber,
            }),
            client.readContract({
              address: v6Address('JBFundAccessLimits', project.chainId),
              abi: jbFundAccessLimitsAbi,
              functionName: 'surplusAllowancesOf',
              args: [projectId, BigInt(current[0].id), pair.terminal, pair.token],
              blockNumber,
            }),
          ]);
          return { ...pair, payoutLimits, surplusAllowances };
        }),
      ),
    ]);
    const lockChanges = rulesetConfigurations.map((config, configurationIndex) => ({
      configurationIndex,
      groups: splitGroups.map((group) => {
        const specified = toRulesetConfig(config).splitGroups.find(
          (item) => item.groupId === BigInt(group.groupId),
        );
        const effective =
          specified && specified.splits.length > 0 ? specified.splits : group.fallbackSplits;
        return {
          groupId: group.groupId,
          removedOrWeakenedLockedSplits: changedLockedSplits(
            group.splits,
            effective,
            BigInt(evidence.timestamp),
          ),
          usesFallbackSplits: !specified || specified.splits.length === 0,
        };
      }),
    }));
    const warnings = configurationWarnings(rulesetConfigurations);
    if (
      lockChanges.some((config) =>
        config.groups.some((group) => group.removedOrWeakenedLockedSplits.length > 0),
      )
    )
      warnings.push(
        'At least one proposed configuration removes or weakens a currently locked split. A new ruleset table can permit this on-chain; review the explicit lockChanges before signing.',
      );
    if (splitGroups.some((group) => group.fallbackSplits.length > 0))
      warnings.push(
        'Fallback split tables exist. Omitted or empty groups inherit fallback recipients rather than automatically sending the whole group to the owner.',
      );
    const comparable = (value: string | number | bigint | boolean) =>
      typeof value === 'boolean' ? value : String(value).toLowerCase();
    const economicChanges = rulesetConfigurations.map((config, configurationIndex) => {
      const changes: { field: string; current: string | boolean; proposed: string | boolean }[] =
        [];
      for (const field of ['duration', 'weight', 'weightCutPercent', 'approvalHook'] as const) {
        const before = comparable(current[0][field]);
        const after = comparable(config[field]);
        if (before !== after) changes.push({ field, current: before, proposed: after });
      }
      for (const field of Object.keys(
        config.metadata,
      ) as (keyof RulesetConfigInput['metadata'])[]) {
        const before = comparable(current[1][field]);
        const after = comparable(config.metadata[field]);
        if (before !== after)
          changes.push({ field: `metadata.${field}`, current: before, proposed: after });
      }
      return {
        configurationIndex,
        comparedWith:
          BigInt(current[0].id) === 0n
            ? 'no currently active ruleset; zero-valued contract defaults'
            : 'currently active ruleset',
        changes,
        weightResolution:
          config.weight === '1'
            ? 'Inherits when the selected predecessor exists; otherwise literal 1. The selected predecessor and resolved weight depend on execution.'
            : 'Explicit issuance weight before future cycle cuts or data-hook overrides.',
        proposedStartLowerBound: config.mustStartAtOrAfter,
      };
    });
    return {
      project,
      account,
      owner,
      controller,
      permission: {
        required: 'QUEUE_RULESETS',
        id: JBPermissionIdsV6.QUEUE_RULESETS,
        authorized: authorizedByOwner || authorizedByOmnichainOperator || authorizedByPermission,
        authorizedByOwner,
        authorizedByOmnichainOperator,
        authorizedByPermission,
        scope: 'Observed at this block; must remain valid at execution.',
      },
      currentRulesetStatus: BigInt(current[0].id) === 0n ? 'none-active' : 'active',
      current: jsonSafe({
        ruleset: current[0],
        metadata: current[1],
        splitGroups,
        fundAccessLimitGroups,
        terminalContexts,
      }),
      upcoming:
        BigInt(upcoming[0].id) === 0n
          ? null
          : jsonSafe({ ruleset: upcoming[0], metadata: upcoming[1] }),
      latestRulesets: jsonSafe(latest.slice(0, 16)),
      latestRulesetsTruncated: latest.length > 16,
      latestApprovalStatus: {
        value: Number(latestApprovalStatus),
        names: ['Empty', 'Upcoming', 'Active', 'ApprovalExpected', 'Approved', 'Failed'],
        scope: 'Latest stored ruleset only; this does not approve the new configurations.',
      },
      proposed: rulesetConfigurations,
      economicChanges,
      lockChanges: jsonSafe(lockChanges),
      timing: {
        status: 'unresolved-until-execution',
        currentAndUpcomingStartsAreOnchain: true,
        proposedStartTimes: null,
        reason:
          'Existing queue state, hook approval and DURATION(), cycle boundaries, and the execution timestamp determine the selected base ruleset and starts. A custom hook can change its answer.',
      },
      comparisonScope:
        'Current standard reserved-token group, current terminal-token payout groups, all proposed group IDs, and fallback tables. Arbitrary historical custom group IDs are not enumerable; this is not a complete audit of hook-defined storage.',
      evidence: [evidence],
      warnings,
    };
  }

  async prepareRulesetChange(raw: z.input<typeof prepareRulesetChangeSchema>): Promise<PlanDraft> {
    const input = prepareRulesetChangeSchema.parse(raw);
    const preview = await this.readChange(input);
    if (!preview.permission.authorized)
      throw new DomainError(
        'PERMISSION_DENIED',
        'The proposed signing account lacks QUEUE_RULESETS permission for this project.',
        { details: preview.permission },
      );
    const request = buildQueueRulesetsTx({
      chainId: input.project.chainId,
      projectId: BigInt(input.project.projectId),
      rulesetConfigurations: input.rulesetConfigurations.map(toRulesetConfig),
      memo: input.memo,
    });
    const data = encodeFunctionData(request);
    const decoded = decodeFunctionData({ abi: request.abi, data });
    const call: PreparedCall = {
      chainId: input.project.chainId,
      to: request.address,
      data,
      value: '0',
      label: 'Queue project rulesets',
      decoded: { functionName: decoded.functionName, args: jsonSafe(decoded.args) },
      dependsOn: [],
    };
    return {
      operation: 'ruleset-change',
      account: input.account,
      project: input.project,
      calls: [call],
      evidence: preview.evidence,
      summary: preview,
      warnings: preview.warnings,
    };
  }

  async prepareLaunch(raw: z.input<typeof prepareLaunchSchema>): Promise<PlanDraft> {
    const input = prepareLaunchSchema.parse(raw);
    const { client, evidence } = await this.rpc.snapshot(input.chainId);
    const blockNumber = BigInt(evidence.blockNumber);
    const controller = v6Address('JBController', input.chainId);
    const [creationFee, code] = await Promise.all([
      client.readContract({
        address: v6Address('JBProjects', input.chainId),
        abi: jbProjectsAbi,
        functionName: 'creationFee',
        blockNumber,
      }),
      client.getCode({ address: controller, blockNumber }),
    ]);
    if (!code || code === '0x')
      throw new DomainError(
        'DEPLOYMENT_UNAVAILABLE',
        'The canonical V6 controller has no bytecode at the observed block.',
      );
    const request = buildLaunchProjectTx({
      chainId: input.chainId,
      owner: input.owner,
      projectUri: input.projectUri,
      rulesetConfigurations: input.rulesetConfigurations.map(toRulesetConfig),
      terminalConfigurations: input.terminalConfigurations.map(toTerminalConfig),
      memo: input.memo,
      creationFee,
    });
    const data = encodeFunctionData(request);
    const decoded = decodeFunctionData({ abi: request.abi, data });
    const warnings = configurationWarnings(input.rulesetConfigurations);
    warnings.push(
      'The creation fee is dynamic and must match exactly at execution. A stale fee can revert; refresh the prepared plan before signing.',
    );
    warnings.push(
      'This explicitly selected core composition does not deploy an NFT hook, revnet, token contract, sucker pair, or omnichain project. Future NFT support depends on configured permissions and an actual attached hook; it is not guaranteed.',
    );
    if (!isAddressEqual(input.owner, input.account))
      warnings.push(
        'The signing account differs from the project NFT owner. Core allows anyone to launch for an owner; naming that owner is not proof that the owner endorsed these terms.',
      );
    if (input.terminalConfigurations.length === 0)
      warnings.push(
        'No terminals are attached. The project will have no configured payment terminal at launch.',
      );
    return {
      operation: 'launch',
      account: input.account,
      calls: [
        {
          chainId: input.chainId,
          to: request.address,
          data,
          value: creationFee.toString(),
          label: 'Launch standard core project',
          decoded: { functionName: decoded.functionName, args: jsonSafe(decoded.args) },
          dependsOn: [],
        },
      ],
      evidence: [evidence],
      summary: {
        composition: input.composition,
        chainId: input.chainId,
        owner: input.owner,
        account: input.account,
        controller,
        projectUri: input.projectUri,
        projectId: null,
        creationFeeWei: creationFee.toString(),
        configuration: {
          rulesetConfigurations: input.rulesetConfigurations,
          terminalConfigurations: input.terminalConfigurations,
        },
        permission: 'Core launch is permissionless; owner endorsement is not inferred.',
        timing:
          'Initial mustStartAtOrAfter=0 resolves to execution timestamp; later configurations depend on the preceding ruleset, duration and approval hook.',
        projectIdResolution:
          'Read canonical JBController.LaunchProject / JBProjects.Create logs after a successful receipt; do not predict the next ID.',
      },
      warnings,
    };
  }
}
