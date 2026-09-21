import {
  jbControllerAbi,
  jbDirectoryAbi,
  jbFundAccessLimitsAbi,
  jbMultiTerminalAbi,
  jbPermissionsAbi,
  jbProjectsAbi,
  jbSplitsAbi,
  jbSuckerRegistryAbi,
  jbTerminalStoreAbi,
  jbTokensAbi,
} from '@bananapus/nana-sdk-core';
import {
  decodePermissionBitmap,
  getAllRulesets,
  getCurrentRuleset,
  getUpcomingRuleset,
  insertToSuckerOutboxEvent,
  jbSuckerV6ViewAbi,
  permissionKeyV6,
  v6Address,
  type JBAccountingContext,
  type JBRulesetWithMetadata,
} from '@bananapus/nana-sdk-core/v6';
import { erc20Abi, getAddress, isAddress, pad, parseAbi, zeroAddress, type Address } from 'viem';
import { DomainError, publicError } from '../domain/errors.js';
import type { Observation, ProjectRef, RpcProvider, RpcSnapshot } from '../domain/types.js';

const MAX_TERMINALS = 32;
const MAX_CONTEXTS = 32;
const MAX_SUCKERS = 32;
const MAX_LOG_BLOCKS = 2_000n;
const MAX_LOG_RESULTS = 500;
const approvalStatuses = [
  'empty',
  'upcoming',
  'active',
  'approvalExpected',
  'approved',
  'failed',
] as const;

// The SDK's common sucker ABI omits accounting gossip and lifecycle views.
// Signatures mirror nana-suckers-v6/src/interfaces/IJBSucker.sol and its structs.
const suckerAccountingAbi = parseAbi([
  'function state() view returns (uint8)',
  'function peerChainAccountsOf() view returns ((uint256 chainId, uint256 totalSupply, (bytes32 token, uint8 decimals, uint128 surplus, uint128 balance)[] contexts, uint256 timestamp)[])',
  'function amountToAddToBalanceOf(address token) view returns (uint256)',
  'function CCIP_ROUTER() view returns (address)',
  'function OPMESSENGER() view returns (address)',
  'function GATEWAYROUTER() view returns (address)',
]);

type Json<T> = T extends bigint
  ? string
  : T extends readonly (infer U)[]
    ? Json<U>[]
    : T extends object
      ? { [K in keyof T]: Json<T[K]> }
      : T;

/** Amounts and uint256 IDs never pass through JavaScript floating-point numbers. */
function json<T>(value: T): Json<T> {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? item.toString() : item,
    ),
  ) as Json<T>;
}
function known<T>(value: T): Observation<T> {
  return { status: 'known', value };
}
function unknown<T = never>(code: string, message: string): Observation<T> {
  return { status: 'unknown', error: { code, message, retryable: false } };
}
async function observe<T>(read: () => Promise<T>): Promise<Observation<T>> {
  try {
    return known(await read());
  } catch (error) {
    return { status: 'unknown', error: publicError(error) };
  }
}
function requireKnown<T>(observation: Observation<T>): T {
  if (observation.status === 'unknown')
    throw new DomainError(observation.error.code, observation.error.message, observation.error);
  return observation.value;
}
function uint(value: string, name: string, allowZero = true): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value))
    throw new DomainError('INVALID_INPUT', `${name} must be an unsigned integer string.`);
  const result = BigInt(value);
  if (result >= 1n << 256n || (!allowZero && result === 0n))
    throw new DomainError('INVALID_INPUT', `${name} is outside its supported range.`);
  return result;
}
function bounded<T>(values: readonly T[], limit: number, description: string): readonly T[] {
  if (values.length > limit)
    throw new DomainError(
      'READ_LIMIT_EXCEEDED',
      `${description} exceeds the bounded read limit of ${limit}; completeness is unknown.`,
    );
  return values;
}
function address(value: Address): Address {
  if (!isAddress(value)) throw new DomainError('INVALID_INPUT', 'A valid EVM address is required.');
  return getAddress(value);
}
function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
function requireController(controller: Observation<Address>, ref: ProjectRef): Address {
  const actual = requireKnown(controller);
  if (!sameAddress(actual, v6Address('JBController', ref.chainId))) {
    throw new DomainError(
      'UNSUPPORTED_CONTROLLER',
      actual === zeroAddress
        ? 'This project has no controller; canonical V6 economics cannot be inferred.'
        : 'The live directory selects a custom controller. This adapter cannot verify its rulesets, supply, or permissions semantics.',
    );
  }
  return actual;
}

export class ProjectService {
  constructor(private readonly rpc: RpcProvider) {}

  private async context(ref: ProjectRef) {
    if (ref.version !== undefined && ref.version !== 6)
      throw new DomainError('UNSUPPORTED_VERSION', 'This adapter supports Juicebox V6.');
    const projectId = uint(ref.projectId, 'projectId', false);
    const snapshot = await this.rpc.snapshot(ref.chainId);
    const { client } = snapshot;
    const [owner, controller, terminals] = await Promise.all([
      observe(() =>
        client.readContract({
          address: v6Address('JBProjects', ref.chainId),
          abi: jbProjectsAbi,
          functionName: 'ownerOf',
          args: [projectId],
        }),
      ),
      observe(() =>
        client.readContract({
          address: v6Address('JBDirectory', ref.chainId),
          abi: jbDirectoryAbi,
          functionName: 'controllerOf',
          args: [projectId],
        }),
      ),
      observe(async () =>
        bounded(
          await client.readContract({
            address: v6Address('JBDirectory', ref.chainId),
            abi: jbDirectoryAbi,
            functionName: 'terminalsOf',
            args: [projectId],
          }),
          MAX_TERMINALS,
          'Project terminal count',
        ),
      ),
    ]);
    return { ...snapshot, projectId, owner, controller, terminals };
  }

  async getProject(ref: ProjectRef) {
    const context = await this.context(ref);
    const { client, projectId, controller } = context;
    const canonicalController = await observe(async () => requireController(controller, ref));
    const readController = <T>(read: (controller: Address) => Promise<T>) =>
      observe(async () => read(requireKnown(canonicalController)));
    const [
      uri,
      currentRuleset,
      upcomingRuleset,
      latestQueuedRuleset,
      tokenStore,
      totalSupply,
      pendingReservedTokens,
      fundAccessLimits,
      splitsStore,
    ] = await Promise.all([
      readController((controller) =>
        client.readContract({
          address: controller,
          abi: jbControllerAbi,
          functionName: 'uriOf',
          args: [projectId],
        }),
      ),
      readController(() => getCurrentRuleset(client, { chainId: ref.chainId, projectId })),
      readController(() => getUpcomingRuleset(client, { chainId: ref.chainId, projectId })),
      readController(async (controller) => {
        const [ruleset, metadata, approvalStatus] = await client.readContract({
          address: controller,
          abi: jbControllerAbi,
          functionName: 'latestQueuedRulesetOf',
          args: [projectId],
        });
        return {
          ruleset,
          metadata,
          approvalStatus: approvalStatuses[approvalStatus] ?? 'unknown',
          approvalStatusId: approvalStatus,
        };
      }),
      readController((controller) =>
        client.readContract({ address: controller, abi: jbControllerAbi, functionName: 'TOKENS' }),
      ),
      readController((controller) =>
        client.readContract({
          address: controller,
          abi: jbControllerAbi,
          functionName: 'totalTokenSupplyWithReservedTokensOf',
          args: [projectId],
        }),
      ),
      readController((controller) =>
        client.readContract({
          address: controller,
          abi: jbControllerAbi,
          functionName: 'pendingReservedTokenBalanceOf',
          args: [projectId],
        }),
      ),
      readController((controller) =>
        client.readContract({
          address: controller,
          abi: jbControllerAbi,
          functionName: 'FUND_ACCESS_LIMITS',
        }),
      ),
      readController((controller) =>
        client.readContract({ address: controller, abi: jbControllerAbi, functionName: 'SPLITS' }),
      ),
    ]);
    const [token, reservedTokenSplits, terminals] = await Promise.all([
      observe(async () =>
        this.tokenMetadata(
          context,
          await client.readContract({
            address: requireKnown(tokenStore),
            abi: jbTokensAbi,
            functionName: 'tokenOf',
            args: [projectId],
          }),
        ),
      ),
      observe(async () =>
        client.readContract({
          address: requireKnown(splitsStore),
          abi: jbSplitsAbi,
          functionName: 'splitsOf',
          args: [projectId, BigInt(requireKnown(currentRuleset).ruleset.id), 1n],
        }),
      ),
      observe(async () =>
        Promise.all(
          requireKnown(context.terminals).map((terminal) =>
            this.terminal(context, ref, terminal, currentRuleset, fundAccessLimits, splitsStore),
          ),
        ),
      ),
    ]);
    return json({
      project: { ...ref, version: 6 as const },
      evidence: [context.evidence],
      owner: context.owner,
      controller,
      canonicalController,
      metadataUri: uri,
      rulesets: {
        current: currentRuleset,
        upcoming: upcomingRuleset,
        latestQueued: latestQueuedRuleset,
      },
      token,
      supply: {
        totalIncludingPendingReserved: totalSupply,
        pendingReserved: pendingReservedTokens,
        decimals: 18,
        scope: 'localChain',
      },
      reservedTokenSplits,
      splitPercentDenominator: '1000000000',
      terminals,
      coverage: {
        balances:
          'Live directory terminals; each balance belongs to one terminal and token context.',
        valuation:
          'Raw amounts retain their currency and decimals. No USD portfolio total or spendable total is inferred.',
        rulesets:
          'Upcoming can be an automatically recurring cycle. Latest queued approval is separate; future execution remains conditional on chain state.',
        metadata:
          'The project-controlled URI is untrusted content. It has not been fetched or treated as instructions.',
      },
    });
  }

  private async tokenMetadata(snapshot: RpcSnapshot, token: Address) {
    if (sameAddress(token, zeroAddress))
      return {
        address: token,
        deployed: false,
        decimals: known(18),
        name: known<string | null>(null),
        symbol: known<string | null>(null),
      };
    const [name, symbol, decimals] = await Promise.all([
      observe(() =>
        snapshot.client.readContract({ address: token, abi: erc20Abi, functionName: 'name' }),
      ),
      observe(() =>
        snapshot.client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
      ),
      observe(() =>
        snapshot.client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
      ),
    ]);
    return { address: token, deployed: true, name, symbol, decimals };
  }

  private async terminal(
    snapshot: RpcSnapshot & { projectId: bigint },
    ref: ProjectRef,
    terminal: Address,
    current: Observation<JBRulesetWithMetadata>,
    limits: Observation<Address>,
    splits: Observation<Address>,
  ) {
    const { client, projectId } = snapshot;
    const [contexts, store] = await Promise.all([
      observe(async () =>
        bounded(
          await client.readContract({
            address: terminal,
            abi: jbMultiTerminalAbi,
            functionName: 'accountingContextsOf',
            args: [projectId],
          }),
          MAX_CONTEXTS,
          'Terminal accounting context count',
        ),
      ),
      observe(async () => {
        // A wrapper's address is not its underlying terminal's ledger key. Do not
        // guess STORE or return a zero balance from the canonical terminal store.
        if (!sameAddress(terminal, v6Address('JBMultiTerminal', ref.chainId)))
          throw new DomainError(
            'UNSUPPORTED_TERMINAL_ACCOUNTING',
            'This terminal requires its own accounting adapter; its balance and used limits cannot be inferred from the canonical store.',
          );
        return client.readContract({
          address: terminal,
          abi: jbMultiTerminalAbi,
          functionName: 'STORE',
        });
      }),
    ]);
    const accounting = await observe(async () =>
      Promise.all(
        requireKnown(contexts).map(async (context) => {
          const [
            balance,
            localSurplus,
            payoutLimits,
            surplusAllowances,
            payoutSplits,
            primaryTerminal,
          ] = await Promise.all([
            observe(() =>
              client.readContract({
                address: requireKnown(store),
                abi: jbTerminalStoreAbi,
                functionName: 'balanceOf',
                args: [terminal, projectId, context.token],
              }),
            ),
            observe(() =>
              client.readContract({
                address: terminal,
                abi: jbMultiTerminalAbi,
                functionName: 'currentSurplusOf',
                args: [
                  projectId,
                  [context.token],
                  BigInt(context.decimals),
                  BigInt(context.currency),
                ],
              }),
            ),
            this.limits(snapshot, terminal, context, current, limits, store, 'payout'),
            this.limits(snapshot, terminal, context, current, limits, store, 'allowance'),
            observe(() =>
              client.readContract({
                address: requireKnown(splits),
                abi: jbSplitsAbi,
                functionName: 'splitsOf',
                args: [projectId, BigInt(requireKnown(current).ruleset.id), BigInt(context.token)],
              }),
            ),
            observe(() =>
              client.readContract({
                address: v6Address('JBDirectory', ref.chainId),
                abi: jbDirectoryAbi,
                functionName: 'primaryTerminalOf',
                args: [projectId, context.token],
              }),
            ),
          ]);
          return {
            ...context,
            balance,
            localSurplus,
            payoutLimits,
            surplusAllowances,
            payoutSplits,
            primaryTerminal,
            units: { amount: 'rawInteger', decimals: context.decimals, currency: context.currency },
            surplusScope:
              'Only this terminal and token; does not include remote gossip or other terminals.',
          };
        }),
      ),
    );
    return { address: terminal, accountingStore: store, contexts: accounting };
  }

  private async limits(
    snapshot: RpcSnapshot & { projectId: bigint },
    terminal: Address,
    context: JBAccountingContext,
    current: Observation<JBRulesetWithMetadata>,
    limits: Observation<Address>,
    store: Observation<Address>,
    kind: 'payout' | 'allowance',
  ) {
    return observe(async () => {
      const { client, projectId } = snapshot;
      const ruleset = requireKnown(current).ruleset;
      const configurations = await client.readContract({
        address: requireKnown(limits),
        abi: jbFundAccessLimitsAbi,
        functionName: kind === 'payout' ? 'payoutLimitsOf' : 'surplusAllowancesOf',
        args: [projectId, BigInt(ruleset.id), terminal, context.token],
      });
      return Promise.all(
        bounded(configurations, MAX_CONTEXTS, 'Fund access currency count').map(
          async (configuration) => {
            const used = await observe(() =>
              client.readContract({
                address: requireKnown(store),
                abi: jbTerminalStoreAbi,
                functionName: kind === 'payout' ? 'usedPayoutLimitOf' : 'usedSurplusAllowanceOf',
                args: [
                  terminal,
                  projectId,
                  context.token,
                  BigInt(kind === 'payout' ? ruleset.cycleNumber : ruleset.id),
                  BigInt(configuration.currency),
                ],
              }),
            );
            const remaining =
              used.status === 'known'
                ? known(configuration.amount > used.value ? configuration.amount - used.value : 0n)
                : used;
            return {
              configured: configuration.amount,
              currency: configuration.currency,
              decimals: context.decimals,
              used,
              remaining,
              resetScope: kind === 'payout' ? 'rulesetCycleNumber' : 'rulesetId',
              scopeId: kind === 'payout' ? ruleset.cycleNumber : ruleset.id,
              meaning:
                'Remaining configured capacity, not an executable payout quote; balance, price conversion, permissions, fees and hooks can constrain execution.',
            };
          },
        ),
      );
    });
  }

  async getRulesets(ref: ProjectRef, options: { limit?: number; startingId?: string } = {}) {
    const limit = options.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new DomainError('INVALID_INPUT', 'Ruleset page limit must be between 1 and 50.');
    const startingId = uint(options.startingId ?? '0', 'startingId');
    const context = await this.context(ref);
    const page = await observe(async () => {
      requireController(context.controller, ref);
      const items = await getAllRulesets(context.client, {
        chainId: ref.chainId,
        projectId: context.projectId,
        startingId,
        size: BigInt(limit),
      });
      const previousId = items.at(-1)?.ruleset.basedOnId ?? 0;
      return {
        items,
        nextStartingId: BigInt(previousId) === 0n ? null : BigInt(previousId).toString(),
        order: 'newestFirst',
      };
    });
    return json({
      project: { ...ref, version: 6 as const },
      evidence: [context.evidence],
      controller: context.controller,
      page,
      coverage:
        'Stored ruleset configurations, paginated through basedOnId. These are not every automatically recurring cycle; queued configurations may fail approval.',
    });
  }

  async getPosition(ref: ProjectRef, holderInput: Address) {
    const holder = address(holderInput);
    const context = await this.context(ref);
    const { client, projectId } = context;
    const tokenStore = await observe(async () =>
      client.readContract({
        address: requireController(context.controller, ref),
        abi: jbControllerAbi,
        functionName: 'TOKENS',
      }),
    );
    const [credits, tokenAddress, totalBalance] = await Promise.all([
      observe(() =>
        client.readContract({
          address: requireKnown(tokenStore),
          abi: jbTokensAbi,
          functionName: 'creditBalanceOf',
          args: [holder, projectId],
        }),
      ),
      observe(() =>
        client.readContract({
          address: requireKnown(tokenStore),
          abi: jbTokensAbi,
          functionName: 'tokenOf',
          args: [projectId],
        }),
      ),
      observe(() =>
        client.readContract({
          address: requireKnown(tokenStore),
          abi: jbTokensAbi,
          functionName: 'totalBalanceOf',
          args: [holder, projectId],
        }),
      ),
    ]);
    const erc20Balance = await observe(async () => {
      const token = requireKnown(tokenAddress);
      return sameAddress(token, zeroAddress)
        ? 0n
        : client.readContract({
            address: token,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [holder],
          });
    });
    return json({
      project: { ...ref, version: 6 as const },
      evidence: [context.evidence],
      holder,
      controller: context.controller,
      tokenAddress,
      credits,
      erc20Balance,
      totalBalance,
      decimals: 18,
      nfts: unknown(
        'INVENTORY_NOT_ENUMERATED',
        'Use indexed NFT inventory, then verify ownership against each collection. A data hook alone does not enumerate all project-related NFTs.',
      ),
      loans: unknown(
        'INVENTORY_NOT_ENUMERATED',
        'Use indexed Revnet loan discovery, then verify each loan on chain. No zero debt or borrowing eligibility is inferred.',
      ),
      coverage:
        'Local chain token balance includes internal credits and claimed ERC-20 tokens. No global position, cash-out entitlement, NFT inventory or loan inventory is inferred.',
    });
  }

  async getPermissions(
    ref: ProjectRef,
    options: { operator: Address; account: Address; permissionIds: number[] },
  ) {
    const operator = address(options.operator);
    const account = address(options.account);
    const permissionIds = [...new Set(options.permissionIds)];
    if (
      permissionIds.length === 0 ||
      permissionIds.length > 50 ||
      permissionIds.some((id) => !Number.isSafeInteger(id) || id < 1 || id > 255)
    )
      throw new DomainError(
        'INVALID_INPUT',
        'Provide between 1 and 50 permission IDs, each from 1 to 255.',
      );
    const context = await this.context(ref);
    const { client, projectId } = context;
    const permissions = v6Address('JBPermissions', ref.chainId);
    const [projectBitmap, wildcardBitmap, checks] = await Promise.all([
      observe(async () => {
        const bitmap = await client.readContract({
          address: permissions,
          abi: jbPermissionsAbi,
          functionName: 'permissionsOf',
          args: [operator, account, projectId],
        });
        return { bitmap, permissionIds: decodePermissionBitmap(bitmap, { includeUnknown: true }) };
      }),
      observe(async () => {
        const bitmap = await client.readContract({
          address: permissions,
          abi: jbPermissionsAbi,
          functionName: 'permissionsOf',
          args: [operator, account, 0n],
        });
        return { bitmap, permissionIds: decodePermissionBitmap(bitmap, { includeUnknown: true }) };
      }),
      Promise.all(
        permissionIds.map(async (id) => ({
          id,
          name: permissionKeyV6(id),
          granted: await observe(() =>
            client.readContract({
              address: permissions,
              abi: jbPermissionsAbi,
              functionName: 'hasPermission',
              args: [operator, account, projectId, BigInt(id), true, true],
            }),
          ),
        })),
      ),
    ]);
    return json({
      project: { ...ref, version: 6 as const },
      evidence: [context.evidence],
      operator,
      account,
      projectOwner: context.owner,
      controller: context.controller,
      registry: permissions,
      operatorIsAccount: sameAddress(operator, account),
      accountIsProjectOwner:
        context.owner.status === 'known'
          ? known(sameAddress(context.owner.value, account))
          : context.owner,
      projectBitmap,
      wildcardBitmap,
      checks,
      coverage:
        'Registry grants include ROOT and wildcard scope. Self-authorization and project ownership are separate facts. Contract-specific rules, account type, hook constraints and ruleset flags still apply; these checks do not authorize or guarantee a transaction.',
    });
  }

  async getBridgeStatus(
    ref: ProjectRef,
    options: { holder?: Address; fromBlock?: string; toBlock?: string } = {},
  ) {
    const holder = options.holder === undefined ? undefined : address(options.holder);
    if (options.toBlock !== undefined && options.fromBlock === undefined)
      throw new DomainError('INVALID_INPUT', 'fromBlock is required when toBlock is provided.');
    const context = await this.context(ref);
    const fromBlock =
      options.fromBlock === undefined ? undefined : uint(options.fromBlock, 'fromBlock');
    const toBlock =
      options.toBlock === undefined
        ? BigInt(context.evidence.blockNumber)
        : uint(options.toBlock, 'toBlock');
    if (
      fromBlock !== undefined &&
      (fromBlock > toBlock ||
        toBlock > BigInt(context.evidence.blockNumber) ||
        toBlock - fromBlock + 1n > MAX_LOG_BLOCKS)
    ) {
      throw new DomainError(
        'INVALID_INPUT',
        `Bridge log range must be ordered, end at or before the snapshot block and cover at most ${MAX_LOG_BLOCKS} blocks.`,
      );
    }
    const registry = v6Address('JBSuckerRegistry', ref.chainId);
    const [suckers, activeSuckers, toRemoteFee] = await Promise.all([
      observe(async () =>
        bounded(
          await context.client.readContract({
            address: registry,
            abi: jbSuckerRegistryAbi,
            functionName: 'allSuckersOf',
            args: [context.projectId],
          }),
          MAX_SUCKERS,
          'Registered sucker count',
        ),
      ),
      observe(() =>
        context.client.readContract({
          address: registry,
          abi: jbSuckerRegistryAbi,
          functionName: 'suckersOf',
          args: [context.projectId],
        }),
      ),
      observe(() =>
        context.client.readContract({
          address: registry,
          abi: jbSuckerRegistryAbi,
          functionName: 'toRemoteFee',
        }),
      ),
    ]);
    // Discover tokens once per project, not once per bridge. Remote snapshots
    // likewise share a block per chain for every peer read in this response.
    const tokenDiscovery: Observation<readonly Address[]> =
      suckers.status === 'unknown'
        ? suckers
        : suckers.value.length === 0
          ? known<readonly Address[]>([])
          : await observe(async () => {
              const lists = await Promise.all(
                requireKnown(context.terminals).map((terminal) =>
                  context.client.readContract({
                    address: terminal,
                    abi: jbMultiTerminalAbi,
                    functionName: 'accountingContextsOf',
                    args: [context.projectId],
                  }),
                ),
              );
              const tokens = [
                ...new Map(
                  lists.flatMap((contexts) =>
                    bounded(contexts, MAX_CONTEXTS, 'Terminal context count').map(
                      (context) => [context.token.toLowerCase(), context.token] as const,
                    ),
                  ),
                ).values(),
              ];
              return bounded(tokens, MAX_CONTEXTS, 'Bridge token context count');
            });
    const remoteSnapshots = new Map<ProjectRef['chainId'], Promise<RpcSnapshot>>();
    remoteSnapshots.set(ref.chainId, Promise.resolve(context));
    const bridges = await observe(async () =>
      Promise.all(
        requireKnown(suckers).map(async (sucker) => {
          const [identity, state, accountingGossip, transport, outboxEvents] = await Promise.all([
            this.bridgeIdentity(context, ref, sucker, remoteSnapshots),
            observe(async () => {
              const id = await context.client.readContract({
                address: sucker,
                abi: suckerAccountingAbi,
                functionName: 'state',
              });
              return {
                id,
                name:
                  ['enabled', 'deprecationPending', 'sendingDisabled', 'deprecated'][id] ??
                  'unknown',
              };
            }),
            observe(() =>
              context.client.readContract({
                address: sucker,
                abi: suckerAccountingAbi,
                functionName: 'peerChainAccountsOf',
              }),
            ),
            this.bridgeTransport(context, sucker),
            fromBlock === undefined
              ? Promise.resolve(
                  unknown(
                    'LOG_RANGE_REQUIRED',
                    'No history was scanned. Provide an explicit bounded block range to inspect outbox insertions.',
                  ),
                )
              : observe(async () => {
                  const logs = await context.client.getLogs({
                    address: sucker,
                    event: insertToSuckerOutboxEvent,
                    ...(holder === undefined
                      ? {}
                      : { args: { beneficiary: pad(holder, { size: 32 }) } }),
                    fromBlock,
                    toBlock,
                    strict: true,
                  });
                  const items = bounded(logs, MAX_LOG_RESULTS, 'Outbox insertion log count').map(
                    (log) => ({
                      ...log.args,
                      blockNumber: log.blockNumber,
                      blockHash: log.blockHash,
                      transactionHash: log.transactionHash,
                      logIndex: log.logIndex,
                    }),
                  );
                  return {
                    items,
                    fromBlock,
                    toBlock,
                    completeWithinRange: true,
                    allHistory: false,
                    status:
                      'Source insertions only. They do not prove root delivery, a valid current proof, or destination claimability.',
                  };
                }),
          ]);
          const tokenStates = await observe(async () => {
            return Promise.all(
              requireKnown(tokenDiscovery).map(async (token) => {
                const [mapping, outbox, inbox, amountAwaitingTerminalCredit] = await Promise.all([
                  observe(() =>
                    context.client.readContract({
                      address: sucker,
                      abi: jbSuckerV6ViewAbi,
                      functionName: 'remoteTokenFor',
                      args: [token],
                    }),
                  ),
                  observe(async () => {
                    const value = await context.client.readContract({
                      address: sucker,
                      abi: jbSuckerV6ViewAbi,
                      functionName: 'outboxOf',
                      args: [token],
                    });
                    return {
                      nonce: value.nonce,
                      numberOfClaimsSent: value.numberOfClaimsSent,
                      balance: value.balance,
                      numberOfLeaves: value.tree.count,
                    };
                  }),
                  observe(() =>
                    context.client.readContract({
                      address: sucker,
                      abi: jbSuckerV6ViewAbi,
                      functionName: 'inboxOf',
                      args: [token],
                    }),
                  ),
                  observe(() =>
                    context.client.readContract({
                      address: sucker,
                      abi: suckerAccountingAbi,
                      functionName: 'amountToAddToBalanceOf',
                      args: [token],
                    }),
                  ),
                ]);
                return {
                  token,
                  mapping,
                  outbox,
                  inbox,
                  amountAwaitingTerminalCredit,
                  transportTokenCompatibility: unknown(
                    'BRIDGE_PAIR_NOT_VERIFIED',
                    'Registry token mapping is not proof that a native bridge delivers or burns the configured token; verify the exact transport pair before preparing a bridge.',
                  ),
                };
              }),
            );
          });
          return {
            address: sucker,
            activeRegistryMember:
              activeSuckers.status === 'known'
                ? known(activeSuckers.value.some((item) => sameAddress(item, sucker)))
                : activeSuckers,
            identity,
            state,
            accountingGossip,
            transport,
            tokenStates,
            outboxEvents,
          };
        }),
      ),
    );
    return json({
      project: { ...ref, version: 6 as const },
      evidence: [context.evidence],
      registry,
      holder: holder ?? null,
      registryFee: {
        amount: toRemoteFee,
        decimals: 18,
        asset: 'native',
        meaning: 'toRemote registry fee only; transport costs are additional and chain-specific.',
      },
      bridges,
      coverage: {
        discovery:
          'Includes deprecated suckers retained by allSuckersOf. Peer IDs are read remotely and reciprocal registry membership checked; chain-specific IDs are never assumed equal.',
        tokenStates:
          'Tokens currently present in directory terminal contexts. Old mappings or removed token contexts may require indexed discovery.',
        accounting:
          'Gossip is last received accounting with source freshness keys, not simultaneous live remote balances. Transitive gossip authenticates the direct peer, not every originating record.',
        history:
          'Only the explicit block range and beneficiary filter were scanned. No absence of pending claims is inferred.',
      },
    });
  }

  private async bridgeIdentity(
    snapshot: RpcSnapshot & { projectId: bigint },
    ref: ProjectRef,
    sucker: Address,
    remoteSnapshots: Map<ProjectRef['chainId'], Promise<RpcSnapshot>>,
  ) {
    return observe(async () => {
      const [localProjectId, peer, peerChainId] = await Promise.all([
        snapshot.client.readContract({
          address: sucker,
          abi: jbSuckerV6ViewAbi,
          functionName: 'projectId',
        }),
        snapshot.client.readContract({
          address: sucker,
          abi: jbSuckerV6ViewAbi,
          functionName: 'peer',
        }),
        snapshot.client.readContract({
          address: sucker,
          abi: jbSuckerV6ViewAbi,
          functionName: 'peerChainId',
        }),
      ]);
      if (localProjectId !== snapshot.projectId)
        throw new DomainError(
          'BRIDGE_IDENTITY_MISMATCH',
          'Registered sucker reports a different local project ID.',
        );
      const remote = await observe(async () => {
        if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(peer) || peer === pad(zeroAddress, { size: 32 }))
          throw new DomainError(
            'UNSUPPORTED_REMOTE_PEER',
            'Remote peer is not a nonzero EVM address.',
          );
        if (peerChainId > BigInt(Number.MAX_SAFE_INTEGER))
          throw new DomainError(
            'UNSUPPORTED_CHAIN',
            'Remote chain ID cannot be represented by this EVM adapter.',
          );
        const remoteAddress = getAddress(`0x${peer.slice(-40)}`);
        const remoteChainId = Number(peerChainId) as ProjectRef['chainId'];
        let remoteSnapshotPromise = remoteSnapshots.get(remoteChainId);
        if (!remoteSnapshotPromise) {
          remoteSnapshotPromise = this.rpc.snapshot(remoteChainId);
          remoteSnapshots.set(remoteChainId, remoteSnapshotPromise);
        }
        const remoteSnapshot = await remoteSnapshotPromise;
        const [remoteProjectId, returnPeer, returnChainId] = await Promise.all([
          remoteSnapshot.client.readContract({
            address: remoteAddress,
            abi: jbSuckerV6ViewAbi,
            functionName: 'projectId',
          }),
          remoteSnapshot.client.readContract({
            address: remoteAddress,
            abi: jbSuckerV6ViewAbi,
            functionName: 'peer',
          }),
          remoteSnapshot.client.readContract({
            address: remoteAddress,
            abi: jbSuckerV6ViewAbi,
            functionName: 'peerChainId',
          }),
        ]);
        const registered = await remoteSnapshot.client.readContract({
          address: v6Address('JBSuckerRegistry', remoteChainId),
          abi: jbSuckerRegistryAbi,
          functionName: 'isSuckerOf',
          args: [remoteProjectId, remoteAddress],
        });
        if (
          remoteProjectId === 0n ||
          !registered ||
          returnPeer.toLowerCase() !== pad(sucker, { size: 32 }).toLowerCase() ||
          returnChainId !== BigInt(ref.chainId)
        ) {
          throw new DomainError(
            'BRIDGE_IDENTITY_MISMATCH',
            'Remote sucker membership or reciprocal peer/chain linkage does not match.',
          );
        }
        return {
          project: { chainId: remoteChainId, projectId: remoteProjectId, version: 6 },
          sucker: remoteAddress,
          reciprocalRegistryMembershipVerified: true,
          evidence: remoteSnapshot.evidence,
          codeAuthenticity:
            'Registry membership and reciprocal configuration verified; peer bytecode equivalence has not been attested.',
        };
      });
      return { localProjectId, peer, peerChainId, remote };
    });
  }

  private async bridgeTransport(snapshot: RpcSnapshot, sucker: Address) {
    const probes = await Promise.all(
      (['CCIP_ROUTER', 'OPMESSENGER', 'GATEWAYROUTER'] as const).map(async (functionName) => ({
        functionName,
        result: await observe(() =>
          snapshot.client.readContract({ address: sucker, abi: suckerAccountingAbi, functionName }),
        ),
      })),
    );
    const positive = probes.filter(
      (probe) => probe.result.status === 'known' && !sameAddress(probe.result.value, zeroAddress),
    );
    if (positive.length !== 1)
      return unknown(
        'TRANSPORT_NOT_IDENTIFIED',
        'A unique transport could not be positively identified from contract probes. Failed probes do not establish a zero-cost lane.',
      );
    const probe = positive[0]!;
    return known({
      type: ({ CCIP_ROUTER: 'ccip', OPMESSENGER: 'optimism', GATEWAYROUTER: 'arbitrum' } as const)[
        probe.functionName
      ],
      contract: requireKnown(probe.result),
      evidenceFunction: probe.functionName,
      costs: 'Transport fees require a fresh route-specific simulation.',
    });
  }
}
