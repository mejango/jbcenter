import {
  jbControllerAbi,
  jbDirectoryAbi,
  jbFundAccessLimitsAbi,
  jbMultiTerminalAbi,
  jbOmnichainDeployerAbi,
  jbPermissionsAbi,
  jbProjectsAbi,
  jbRulesetsAbi,
  jbSplitsAbi,
  jbTokensAbi,
} from '@bananapus/nana-sdk-core';
import {
  buildDeployErc20Tx,
  buildLaunchProjectTx,
  buildOmnichainQueueRulesetsTx,
  buildQueueRulesetsTx,
  hasPermissions,
  JBPermissionIdsV6,
  v6Address,
} from '@bananapus/nana-sdk-core/v6';
import {
  decodeFunctionData,
  encodeFunctionData,
  isAddressEqual,
  zeroAddress,
  type Abi,
  type Address,
  type PublicClient,
} from 'viem';
import type { z } from 'zod';
import { DomainError } from '../domain/errors.js';
import { jsonSafe } from '../domain/json.js';
import {
  prepareDeployErc20Schema,
  prepareLaunchSchema,
  prepareRulesetChangeSchema,
  prepareSetProjectUriSchema,
  previewRulesetChangeSchema,
  toRulesetConfig,
  toRulesetInput,
  toTerminalConfig,
  type PreviewRulesetChangeInput,
  type RulesetConfigInput,
} from '../domain/rulesets.js';
import { modelEconomics, modelEconomicsSchema, type LiveRevnet } from '../domain/economics.js';
import type { ChainId, PlanDraft, PreparedCall, ProjectRef, RpcProvider } from '../domain/types.js';
import { canonicalDeadline } from './contracts.js';

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

export function configurationWarnings(
  chainId: ChainId,
  configurations: RulesetConfigInput[],
  { omnichainDeployer = false }: { omnichainDeployer?: boolean } = {},
): string[] {
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
        omnichainDeployer
          ? `Configuration ${i}: JBOmnichainDeployer stays the data hook and runs ${config.metadata.dataHook} behind it as the extra data hook. Review that hook's behavior and permissions, and simulate.`
          : `Configuration ${i}: a data hook is configured. Enabled hook behavior and any embedded permissions require contract-specific review and simulation.`,
      );
    if (config.approvalHook !== zeroAddress) {
      const deadline = canonicalDeadline(chainId, config.approvalHook);
      warnings.push(
        deadline
          ? `Configuration ${i}: the approval hook is the canonical ${deadline}. A later ruleset must be queued at least that long before it starts, or it fails approval and this ruleset continues.`
          : `Configuration ${i}: a custom approval hook controls future changes. Its future decision and upgrade behavior are unknown.`,
      );
    }
    if (
      config.splitGroups.some((group) => group.splits.some((split) => split.hook !== zeroAddress))
    )
      warnings.push(
        `Configuration ${i}: split hooks can execute custom recipient behavior; recipient outcomes are not inferred from percentages.`,
      );
  });
  return warnings;
}

/** JBApprovalStatus values under which JBRulesets bases a new queue on the latest ruleset. */
const APPROVAL_EMPTY = 0;
const APPROVAL_APPROVED = 4;

/**
 * JBRulesets starts a new queue at max(execution, mustStartAtOrAfter) when the latest ruleset has started,
 * is approved (or needed no approval), has duration 0 and has no approval hook.
 */
function immediateStart(
  latest:
    | { ruleset: { start: number | bigint; duration: number | bigint; approvalHook: Address } }
    | undefined,
  approvalStatus: number,
  timestamp: bigint,
) {
  return (
    !!latest &&
    BigInt(latest.ruleset.start) <= timestamp &&
    BigInt(latest.ruleset.duration) === 0n &&
    isAddressEqual(latest.ruleset.approvalHook, zeroAddress) &&
    (approvalStatus === APPROVAL_EMPTY || approvalStatus === APPROVAL_APPROVED)
  );
}

/** Launch warnings that name the follow-up tools for an ERC-20 and a project URI. */
export function launchFollowUps(projectUri: string): string[] {
  return [
    projectUri === ''
      ? 'projectUri is empty, so the project has no name. After launch, set a pinned URI with jb_prepare_set_project_uri.'
      : 'To change the name later, pin new metadata and use jb_prepare_set_project_uri.',
    'No ERC-20 is deployed. For a token name and ticker, use jb_prepare_deploy_erc20 after launch.',
  ];
}

/** The project's owner, after checking it uses the canonical V6 controller. */
async function canonicalProject(client: PublicClient, project: ProjectRef, blockNumber: bigint) {
  const projectId = BigInt(project.projectId);
  const controller = v6Address('JBController', project.chainId);
  const [currentController, owner] = await Promise.all([
    client.readContract({
      address: v6Address('JBDirectory', project.chainId),
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
  return { controller, owner };
}

/** Owner or holder of the named owner-granted permission, read at the snapshot block. */
async function projectAuthority(
  client: PublicClient,
  project: ProjectRef,
  account: Address,
  blockNumber: bigint,
  permission: 'DEPLOY_ERC20' | 'SET_PROJECT_URI',
) {
  const { controller, owner } = await canonicalProject(client, project, blockNumber);
  const authorizedByOwner = isAddressEqual(owner, account);
  const authorizedByPermission =
    !authorizedByOwner &&
    (await hasPermissions(client, {
      chainId: project.chainId,
      operator: account,
      account: owner,
      projectId: BigInt(project.projectId),
      permissionIds: [JBPermissionIdsV6[permission]],
      includeRoot: true,
      includeWildcardProjectId: true,
    }));
  const revnet = [
    v6Address('REVOwner', project.chainId),
    v6Address('REVDeployer', project.chainId),
  ].some((address) => isAddressEqual(owner, address));
  const result = {
    controller,
    owner,
    permission: {
      required: permission,
      id: JBPermissionIdsV6[permission],
      authorized: authorizedByOwner || authorizedByPermission,
      authorizedByOwner,
      authorizedByPermission,
      scope: 'Observed at this block; must remain valid at execution.',
    },
  };
  if (!result.permission.authorized)
    throw new DomainError(
      'PERMISSION_DENIED',
      revnet
        ? `This is a revnet. Only its operator can do this (it holds ${permission} from REVOwner); jb_get_revnet names the operator.`
        : `The account is neither the project owner nor holds ${permission} (${JBPermissionIdsV6[permission]}) from the owner.`,
      { details: { owner, ...result.permission } },
    );
  return result;
}

function controllerCall(
  chainId: ChainId,
  request: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] },
  label: string,
): PreparedCall {
  const data = encodeFunctionData(request);
  const decoded = decodeFunctionData({ abi: request.abi, data });
  return {
    chainId,
    to: request.address,
    data,
    value: '0',
    label,
    decoded: { functionName: decoded.functionName, args: jsonSafe(decoded.args) },
    dependsOn: [],
  };
}

export class ConfigurationService {
  constructor(private readonly rpc: RpcProvider) {}

  /** A revnet project is read through `readRevnet` (jb_get_revnet's reader) at one snapshot block. */
  async modelEconomics(
    input: z.input<typeof modelEconomicsSchema>,
    readRevnet?: (project: ProjectRef) => Promise<unknown>,
  ) {
    const parsed = modelEconomicsSchema.parse(input);
    const project = parsed.revnet && 'project' in parsed.revnet ? parsed.revnet.project : undefined;
    if (project && !readRevnet)
      throw new DomainError('UNSUPPORTED_SOURCE', 'No revnet reader is configured.');
    const live = project ? ((await readRevnet!(project)) as LiveRevnet) : undefined;
    return modelEconomics(input, live);
  }

  async previewRulesetChange(raw: z.input<typeof previewRulesetChangeSchema>) {
    return this.readChange(previewRulesetChangeSchema.parse(raw));
  }

  private async readChange(input: PreviewRulesetChangeInput) {
    const { project, account } = input;
    const projectId = BigInt(project.projectId);
    const { client, evidence } = await this.rpc.snapshot(project.chainId);
    const blockNumber = BigInt(evidence.blockNumber);
    const directory = v6Address('JBDirectory', project.chainId);
    const { controller, owner } = await canonicalProject(client, project, blockNumber);

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
    const deployer = await this.omnichainRoute(client, project, blockNumber, {
      current,
      latest: latest[0],
      latestApprovalStatus: Number(latestApprovalStatus),
      omnichainOperator,
    });
    // Through the deployer, a dataHook equal to the deployer (a copy of the live ruleset) keeps the current extra hook.
    const rulesetConfigurations = deployer
      ? input.rulesetConfigurations.map((config) =>
          isAddressEqual(config.metadata.dataHook, deployer.address)
            ? { ...config, metadata: { ...config.metadata, ...deployer.extraDataHook } }
            : config,
        )
      : input.rulesetConfigurations;
    // What the queue stores: the deployer rewrites every ruleset to point at itself.
    const effective = deployer
      ? rulesetConfigurations.map((config) => ({
          ...config,
          metadata: {
            ...config.metadata,
            dataHook: deployer.address,
            useDataHookForPay: true,
            useDataHookForCashOut: true,
          },
        }))
      : rulesetConfigurations;
    const authorizedByOwner = isAddressEqual(owner, account);
    const authorizedByOmnichainOperator = !deployer && isAddressEqual(omnichainOperator, account);
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
    const { terminalContexts, splitGroups, fundAccessLimitGroups } = await this.rulesetTables(
      client,
      project.chainId,
      projectId,
      BigInt(current[0].id),
      blockNumber,
      terminals,
      rulesetConfigurations,
    );
    const lockChanges = effective.map((config, configurationIndex) => {
      const proposed = toRulesetConfig(config);
      return {
        configurationIndex,
        groups: splitGroups.map((group) => {
          const specified = proposed.splitGroups.find(
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
      };
    });
    const warnings = configurationWarnings(project.chainId, rulesetConfigurations, {
      omnichainDeployer: !!deployer,
    });
    if (deployer)
      warnings.unshift(
        `This project's rulesets run through JBOmnichainDeployer, so the queue goes through JBOmnichainDeployer.queueRulesetsOf. It keeps the deployer as the data hook and carries the NFT hook ${deployer.tiered721Hook} forward. Queueing on JBController directly would drop that wiring and make later deployer queues revert.`,
      );
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
    const economicChanges = effective.map((config, configurationIndex) => {
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
      route: deployer
        ? {
            via: 'JBOmnichainDeployer' as const,
            address: deployer.address,
            call: 'queueRulesetsOf(projectId, rulesetConfigurations, memo)',
            tiered721Hook: deployer.tiered721Hook,
            tiered721HookSource: deployer.tiered721HookSource,
            useTiered721HookForCashOut: deployer.useTiered721HookForCashOut,
            currentExtraDataHook: deployer.extraDataHook,
            rule: 'The deployer stores the carried NFT hook and each extra data hook per new ruleset, then queues on JBController with itself as the data hook (pay and cash-out). A dataHook in the input is the extra hook; one equal to the deployer keeps currentExtraDataHook. The controller trusts the deployer as its OMNICHAIN_RULESET_OPERATOR.',
          }
        : { via: 'JBController' as const, address: controller },
      permission: {
        required: 'QUEUE_RULESETS',
        id: JBPermissionIdsV6.QUEUE_RULESETS,
        authorized: authorizedByOwner || authorizedByOmnichainOperator || authorizedByPermission,
        ...(deployer
          ? {
              checkedBy:
                'JBOmnichainDeployer checks the signer against the owner and its QUEUE_RULESETS grant; no grant to the deployer is needed.',
            }
          : {}),
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
      timing: immediateStart(latest[0], Number(latestApprovalStatus), BigInt(evidence.timestamp))
        ? {
            status: 'at-execution' as const,
            currentAndUpcomingStartsAreOnchain: true,
            proposedStartTimes: null,
            firstConfigurationStarts:
              'At execution, or at its mustStartAtOrAfter if that is later. Later configurations follow it by its duration.',
            reason:
              'The latest ruleset has started, has duration 0 (no cycles) and no approval hook, so nothing holds the queue: the first configuration applies as soon as the transaction executes.',
          }
        : {
            status: 'unresolved-until-execution' as const,
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

  /**
   * The JBOmnichainDeployer route, when the project's rulesets run through it. Mirrors the deployer's
   * carry-forward: the latest ruleset's NFT hook when it is approved (or needed no approval), else the current one's.
   */
  private async omnichainRoute(
    client: PublicClient,
    project: ProjectRef,
    blockNumber: bigint,
    state: {
      current: readonly [{ id: number | bigint }, { dataHook: Address }];
      latest: { ruleset: { id: number | bigint }; metadata: { dataHook: Address } } | undefined;
      latestApprovalStatus: number;
      omnichainOperator: Address;
    },
  ) {
    const address = v6Address('JBOmnichainDeployer', project.chainId);
    if (
      !isAddressEqual(state.current[1].dataHook, address) &&
      !(state.latest && isAddressEqual(state.latest.metadata.dataHook, address))
    )
      return undefined;
    if (!isAddressEqual(state.omnichainOperator, address))
      throw new DomainError(
        'UNSUPPORTED_CONTROLLER',
        'The controller does not trust this JBOmnichainDeployer as its omnichain ruleset operator, so a queue through it would revert.',
        { details: { omnichainOperator: state.omnichainOperator, deployer: address } },
      );
    const projectId = BigInt(project.projectId);
    const currentId = BigInt(state.current[0].id);
    const latestId = state.latest ? BigInt(state.latest.ruleset.id) : 0n;
    const read = <T>(functionName: 'tiered721HookOf' | 'extraDataHookOf', rulesetId: bigint) =>
      client.readContract({
        address,
        abi: jbOmnichainDeployerAbi,
        functionName,
        args: [projectId, rulesetId],
        blockNumber,
      }) as Promise<T>;
    const [latestHook, currentHook, extra] = await Promise.all([
      latestId === 0n
        ? Promise.resolve([zeroAddress, false] as const)
        : read<readonly [Address, boolean]>('tiered721HookOf', latestId),
      read<readonly [Address, boolean]>('tiered721HookOf', currentId),
      read<{ dataHook: Address; useDataHookForPay: boolean; useDataHookForCashOut: boolean }>(
        'extraDataHookOf',
        currentId,
      ),
    ]);
    const useLatest =
      latestId !== 0n &&
      (state.latestApprovalStatus === APPROVAL_EMPTY ||
        state.latestApprovalStatus === APPROVAL_APPROVED) &&
      !isAddressEqual(latestHook[0], zeroAddress);
    const [hook, useForCashOut] = useLatest ? latestHook : currentHook;
    if (isAddressEqual(hook, zeroAddress))
      throw new DomainError(
        'OMNICHAIN_HOOK_MISSING',
        'This project runs through JBOmnichainDeployer, but neither its latest approved ruleset nor its current one has an NFT hook recorded there, so JBOmnichainDeployer.queueRulesetsOf would revert (JBOmnichainDeployer_InvalidHook).',
        {
          details: {
            deployer: address,
            currentRulesetId: String(currentId),
            latestRulesetId: String(latestId),
          },
        },
      );
    return {
      address,
      tiered721Hook: hook,
      tiered721HookSource: useLatest
        ? { ruleset: 'latest' as const, id: String(latestId) }
        : { ruleset: 'current' as const, id: String(currentId) },
      useTiered721HookForCashOut: useForCashOut,
      extraDataHook: {
        dataHook: extra.dataHook,
        useDataHookForPay: extra.useDataHookForPay,
        useDataHookForCashOut: extra.useDataHookForCashOut,
      },
    };
  }

  /** The active ruleset as one rulesetConfigurations entry, at a block. Null when no ruleset is active. */
  async currentRulesetInput(project: ProjectRef, blockNumber?: bigint) {
    const projectId = BigInt(project.projectId);
    const { client, evidence } = await this.rpc.snapshot(project.chainId, blockNumber);
    const at = BigInt(evidence.blockNumber);
    const { controller } = await canonicalProject(client, project, at);
    const [[ruleset, metadata], terminals] = await Promise.all([
      client.readContract({
        address: controller,
        abi: jbControllerAbi,
        functionName: 'currentRulesetOf',
        args: [projectId],
        blockNumber: at,
      }),
      client.readContract({
        address: v6Address('JBDirectory', project.chainId),
        abi: jbDirectoryAbi,
        functionName: 'terminalsOf',
        args: [projectId],
        blockNumber: at,
      }),
    ]);
    if (BigInt(ruleset.id) === 0n) return null;
    const tables = await this.rulesetTables(
      client,
      project.chainId,
      projectId,
      BigInt(ruleset.id),
      at,
      terminals,
      [],
    );
    // splitsOf returns the fallback table (ruleset 0) when this ruleset stores none, so a table equal to a
    // nonempty fallback may be stored or inherited; reads cannot tell. Keep it, which preserves the recipients.
    const splitGroupProvenance = tables.splitGroups
      .filter((group) => group.splits.length > 0)
      .map((group) => ({
        groupId: group.groupId,
        provenance:
          JSON.stringify(jsonSafe(group.splits)) === JSON.stringify(jsonSafe(group.fallbackSplits))
            ? ('unknown' as const)
            : ('stored' as const),
      }));
    return {
      rulesetConfiguration: toRulesetInput(
        ruleset,
        metadata,
        tables.splitGroups,
        tables.fundAccessLimitGroups,
      ),
      coverage: {
        status: 'incomplete' as const,
        splitGroupsRead: tables.splitGroups.map((group) => group.groupId),
        fundAccessLimitPairsRead: tables.fundAccessLimitGroups.map(({ terminal, token }) => ({
          terminal,
          token,
        })),
        splitGroupProvenance,
        notCovered: [
          'Split groups other than reserved tokens (1) and the payout groups of current accounting tokens, such as hook-defined group IDs: contract reads cannot enumerate them, so they are omitted and the new ruleset would not have them.',
          "Payout limits and surplus allowances for terminal/token pairs outside the current terminals' accounting contexts.",
        ],
        provenanceUse:
          "stored: this ruleset stores the table. unknown: the table equals the fallback table (ruleset 0), so it is either stored or inherited. Unknown groups are kept in rulesetConfiguration, which freezes today's recipients; choose: keep the group to preserve them, or remove it so the new ruleset inherits later fallback changes.",
      },
    };
  }

  /** Each terminal's accounting contexts, and the split tables and fund access limits stored for one ruleset. */
  private async rulesetTables(
    client: PublicClient,
    chainId: ChainId,
    projectId: bigint,
    rulesetId: bigint,
    blockNumber: bigint,
    terminals: readonly Address[],
    proposed: readonly RulesetConfigInput[],
  ) {
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
    for (const config of proposed)
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
      ...proposed.flatMap((config) => config.splitGroups.map((group) => group.groupId)),
    ]);
    const [splitGroups, fundAccessLimitGroups] = await Promise.all([
      Promise.all(
        [...groupIds].map(async (groupId) => {
          const [splits, fallbackSplits] = await Promise.all([
            client.readContract({
              address: v6Address('JBSplits', chainId),
              abi: jbSplitsAbi,
              functionName: 'splitsOf',
              args: [projectId, rulesetId, BigInt(groupId)],
              blockNumber,
            }),
            client.readContract({
              address: v6Address('JBSplits', chainId),
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
              address: v6Address('JBFundAccessLimits', chainId),
              abi: jbFundAccessLimitsAbi,
              functionName: 'payoutLimitsOf',
              args: [projectId, rulesetId, pair.terminal, pair.token],
              blockNumber,
            }),
            client.readContract({
              address: v6Address('JBFundAccessLimits', chainId),
              abi: jbFundAccessLimitsAbi,
              functionName: 'surplusAllowancesOf',
              args: [projectId, rulesetId, pair.terminal, pair.token],
              blockNumber,
            }),
          ]);
          return { ...pair, payoutLimits, surplusAllowances };
        }),
      ),
    ]);
    return { terminalContexts, splitGroups, fundAccessLimitGroups };
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
    const queue = {
      chainId: input.project.chainId,
      projectId: BigInt(input.project.projectId),
      rulesetConfigurations: preview.proposed.map(toRulesetConfig),
      memo: input.memo,
    };
    const call =
      preview.route.via === 'JBOmnichainDeployer'
        ? controllerCall(
            queue.chainId,
            buildOmnichainQueueRulesetsTx(queue),
            'Queue project rulesets through JBOmnichainDeployer',
          )
        : controllerCall(queue.chainId, buildQueueRulesetsTx(queue), 'Queue project rulesets');
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
    const warnings = configurationWarnings(input.chainId, input.rulesetConfigurations);
    warnings.push(
      'The creation fee is dynamic and must match exactly at execution. A stale fee can revert; refresh the prepared plan before signing.',
    );
    warnings.push(
      'This core launch has no NFT hook and no suckers. To link chains as one project, use jb_prepare_omnichain_launch.',
      ...launchFollowUps(input.projectUri),
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

  async prepareDeployErc20(raw: z.input<typeof prepareDeployErc20Schema>): Promise<PlanDraft> {
    const input = prepareDeployErc20Schema.parse(raw);
    const { project, account } = input;
    const { client, evidence } = await this.rpc.snapshot(project.chainId);
    const blockNumber = BigInt(evidence.blockNumber);
    const [authority, existing] = await Promise.all([
      projectAuthority(client, project, account, blockNumber, 'DEPLOY_ERC20'),
      client.readContract({
        address: v6Address('JBTokens', project.chainId),
        abi: jbTokensAbi,
        functionName: 'tokenOf',
        args: [BigInt(project.projectId)],
        blockNumber,
      }),
    ]);
    if (!isAddressEqual(existing, zeroAddress))
      throw new DomainError(
        'PROJECT_ALREADY_HAS_ERC20',
        `This project already has an ERC-20 at ${existing}. A project can have only one.`,
        { details: { token: existing } },
      );
    const request = buildDeployErc20Tx({
      chainId: project.chainId,
      projectId: BigInt(project.projectId),
      name: input.name,
      symbol: input.symbol,
      salt: input.salt,
    });
    return {
      operation: 'deploy_erc20',
      account,
      project,
      calls: [controllerCall(project.chainId, request, `Deploy the ${input.symbol} ERC-20`)],
      evidence: [evidence],
      summary: { ...authority, name: input.name, symbol: input.symbol, salt: input.salt },
      warnings: [
        'This chain only. Repeat on each chain of an omnichain project; the same nonzero salt and signer give the same token address on every chain.',
        'Holders keep their credits; each holder claims ERC-20s separately.',
      ],
    };
  }

  async prepareSetProjectUri(raw: z.input<typeof prepareSetProjectUriSchema>): Promise<PlanDraft> {
    const input = prepareSetProjectUriSchema.parse(raw);
    const { project, account } = input;
    const { client, evidence } = await this.rpc.snapshot(project.chainId);
    const authority = await projectAuthority(
      client,
      project,
      account,
      BigInt(evidence.blockNumber),
      'SET_PROJECT_URI',
    );
    const controller = v6Address('JBController', project.chainId);
    const warnings = [
      'This chain only. Repeat on each chain of an omnichain project.',
      'The URI replaces the current one. Its content is not fetched or checked.',
    ];
    if (input.uri === '') warnings.push('The URI is empty: the project will have no name.');
    else if (!input.uri.startsWith('ipfs://'))
      warnings.push('Juicebox clients read ipfs:// URIs. Other schemes may not show a name.');
    return {
      operation: 'set_project_uri',
      account,
      project,
      calls: [
        controllerCall(
          project.chainId,
          {
            address: controller,
            abi: jbControllerAbi,
            functionName: 'setUriOf',
            args: [BigInt(project.projectId), input.uri],
          },
          'Set the project metadata URI',
        ),
      ],
      evidence: [evidence],
      summary: { ...authority, uri: input.uri },
      warnings,
    };
  }
}
