import {
  jbAddressRegistryAbi,
  jbBuybackHookAbi,
  jbBuybackHookRegistryAbi,
  jbControllerAbi,
  jbDirectoryAbi,
  jbMultiTerminalAbi,
  jbOmnichainDeployerAbi,
  jbPermissionsAbi,
  jbProjectsAbi,
  jbRouterTerminalAbi,
  jbRouterTerminalRegistryAbi,
  jbTokensAbi,
  revOwnerAbi,
} from '@bananapus/nana-sdk-core';
import {
  uniswapV4PoolId,
  uniswapV4PoolStateSlot,
  uniswapV4SqrtPriceX96FromSlot0,
  v6Address,
  type JBRulesetWithMetadata,
  type UniswapV4PoolKey,
} from '@bananapus/nana-sdk-core/v6';
import {
  encodeFunctionData,
  isAddressEqual,
  numberToHex,
  parseAbi,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from 'viem';
import type { z } from 'zod';
import { DomainError, publicError } from '../domain/errors.js';
import { jsonSafe } from '../domain/json.js';
import {
  prepareBuybackHookSchema,
  prepareBuybackPoolSchema,
  prepareBuybackTwapSchema,
  prepareRouterTerminalSchema,
  resolveRouterTerminal,
  routingSchema,
} from '../domain/routing.js';
import type {
  Observation,
  PlanDraft,
  ProjectRef,
  RpcProvider,
  RpcSnapshot,
} from '../domain/types.js';
import { deploymentAddress, deploymentAddresses, routerGatewayAbi } from './rollout.js';

const NATIVE = '0x000000000000000000000000000000000000EEEe' as const;
const oracleAbi = parseAbi([
  'function observationCoverageOf((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key) view returns (uint32)',
  'function observe((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint32[] secondsAgos) view returns (int56[], uint160[])',
]);
const storageAbi = parseAbi(['function extsload(bytes32 slot) view returns (bytes32)']);
const same = isAddressEqual;
const recordedBuyback = (address: Address, chainId: ProjectRef['chainId']) =>
  deploymentAddresses('JBBuybackHook', chainId).some((candidate) => same(candidate, address));
const known = <T>(value: T): Observation<T> => ({ status: 'known', value });
const unavailable = <T = never>(code: string, message: string): Observation<T> => ({
  status: 'unknown',
  error: { code, message, retryable: false },
});
async function observe<T>(read: () => Promise<T>): Promise<Observation<T>> {
  try {
    return known(await read());
  } catch (error) {
    return { status: 'unknown', error: publicError(error) };
  }
}
function required<T>(result: Observation<T>): T {
  if (result.status === 'unknown')
    throw new DomainError(result.error.code, result.error.message, result.error);
  return result.value;
}
function normalized(token: Address): Address {
  return same(token, NATIVE) ? zeroAddress : token;
}
function configured(key: UniswapV4PoolKey): boolean {
  return !same(key.currency0, zeroAddress) || !same(key.currency1, zeroAddress);
}
function bound<T>(items: readonly T[], max: number, label: string): readonly T[] {
  if (items.length > max)
    throw new DomainError(
      'ROUTING_READ_LIMIT',
      `${label} exceeds ${max}; request narrower routing context.`,
    );
  return items;
}

export interface ResolvedRoutingHooks {
  dataHook: Address;
  kind: 'none' | 'revnet' | 'omnichain' | 'buybackRegistry' | 'buyback' | 'nft';
  buyback: Address | null;
  buybackRegistry: Address | null;
  nft: Address | null;
  payHooks: Address[];
  cashOutHooks: Address[];
  buybackPayEnabled: boolean;
  buybackCashOutEnabled: boolean;
}

/** Follow known wrappers before consulting default-returning registry getters. */
export async function resolveRoutingHooks(
  snapshot: RpcSnapshot,
  project: ProjectRef,
  current: JBRulesetWithMetadata,
): Promise<ResolvedRoutingHooks> {
  const { client } = snapshot;
  const id = BigInt(project.projectId);
  const registry = v6Address('JBBuybackHookRegistry', project.chainId);
  const dataHook = current.metadata.dataHook;
  const result: ResolvedRoutingHooks = {
    dataHook,
    kind: 'none',
    buyback: null,
    buybackRegistry: null,
    nft: null,
    payHooks: [],
    cashOutHooks: [],
    buybackPayEnabled: false,
    buybackCashOutEnabled: false,
  };
  if (same(dataHook, zeroAddress)) return result;
  let hook = dataHook;
  let pay = current.metadata.useDataHookForPay;
  let cashOut = current.metadata.useDataHookForCashOut;
  if (same(hook, v6Address('REVOwner', project.chainId))) {
    result.kind = 'revnet';
    const [actualRegistry, nft] = await Promise.all([
      client.readContract({ address: hook, abi: revOwnerAbi, functionName: 'BUYBACK_HOOK' }),
      client.readContract({
        address: hook,
        abi: revOwnerAbi,
        functionName: 'tiered721HookOf',
        args: [id],
      }),
    ]);
    if (!same(actualRegistry, registry))
      throw new DomainError(
        'UNSUPPORTED_BUYBACK_REGISTRY',
        'REVOwner selects an unrecognized buyback registry.',
      );
    result.nft = same(nft, zeroAddress) ? null : nft;
    if (pay && result.nft) result.payHooks.push(result.nft);
    // Revnet NFTs never price cash-outs. REVOwner applies its separate fee/loan rules.
    hook = registry;
  } else if (same(hook, v6Address('JBOmnichainDeployer', project.chainId))) {
    result.kind = 'omnichain';
    const [nft, extra] = await Promise.all([
      client.readContract({
        address: hook,
        abi: jbOmnichainDeployerAbi,
        functionName: 'tiered721HookOf',
        args: [id, BigInt(current.ruleset.id)],
      }),
      client.readContract({
        address: hook,
        abi: jbOmnichainDeployerAbi,
        functionName: 'extraDataHookOf',
        args: [id, BigInt(current.ruleset.id)],
      }),
    ]);
    result.nft = same(nft[0], zeroAddress) ? null : nft[0];
    if (pay && result.nft) result.payHooks.push(result.nft);
    if (cashOut && result.nft && nft[1]) result.cashOutHooks.push(result.nft);
    pay = pay && extra.useDataHookForPay;
    cashOut = cashOut && !(result.nft && nft[1]) && extra.useDataHookForCashOut;
    hook = extra.dataHook;
  }
  if (same(hook, registry)) {
    if (result.kind === 'none') result.kind = 'buybackRegistry';
    result.buybackRegistry = registry;
    const resolved = await client.readContract({
      address: registry,
      abi: jbBuybackHookRegistryAbi,
      functionName: 'hookOf',
      args: [id],
    });
    result.buyback = same(resolved, zeroAddress) ? null : resolved;
  } else if (!same(hook, zeroAddress)) {
    const allowed =
      recordedBuyback(hook, project.chainId) ||
      (await client.readContract({
        address: registry,
        abi: jbBuybackHookRegistryAbi,
        functionName: 'isHookAllowed',
        args: [hook],
      }));
    if (allowed) {
      if (result.kind === 'none') result.kind = 'buyback';
      result.buyback = hook;
    } else {
      const deployer = await client.readContract({
        address: v6Address('JBAddressRegistry', project.chainId),
        abi: jbAddressRegistryAbi,
        functionName: 'deployerOf',
        args: [hook],
      });
      if (!same(deployer, v6Address('JB721TiersHookDeployer', project.chainId)))
        throw new DomainError(
          'UNSUPPORTED_DATA_HOOK',
          'The configured data hook is custom; no canonical buyback or NFT route is inferred.',
        );
      if (result.kind === 'none') result.kind = 'nft';
      result.nft ??= hook;
      if (pay) result.payHooks.push(hook);
      if (cashOut) result.cashOutHooks.push(hook);
    }
  }
  result.buybackPayEnabled = pay && result.buyback !== null;
  result.buybackCashOutEnabled = cashOut && result.buyback !== null;
  if (result.buybackPayEnabled) result.payHooks.push(result.buyback!);
  if (result.buybackCashOutEnabled) result.cashOutHooks.push(result.buyback!);
  if (result.kind === 'revnet' && current.metadata.useDataHookForCashOut)
    result.cashOutHooks.push(dataHook);
  return result;
}

export class RoutingService {
  constructor(private readonly rpc: RpcProvider) {}

  private async context(project: ProjectRef) {
    const snapshot = await this.rpc.snapshot(project.chainId);
    const projectId = BigInt(project.projectId);
    const controller = await snapshot.client.readContract({
      address: v6Address('JBDirectory', project.chainId),
      abi: jbDirectoryAbi,
      functionName: 'controllerOf',
      args: [projectId],
    });
    if (!same(controller, v6Address('JBController', project.chainId)))
      throw new DomainError(
        'UNSUPPORTED_CONTROLLER',
        'Routing requires a verified canonical V6 controller; the live directory selects a different controller.',
      );
    const [ruleset, metadata] = await snapshot.client.readContract({
      address: controller,
      abi: jbControllerAbi,
      functionName: 'currentRulesetOf',
      args: [projectId],
    });
    return { ...snapshot, projectId, controller, current: { ruleset, metadata } };
  }

  async getRouting(raw: z.input<typeof routingSchema>) {
    const input = routingSchema.parse(raw);
    const snapshot = await this.context(input.project);
    const { client, projectId } = snapshot;
    const registry = v6Address('JBRouterTerminalRegistry', input.project.chainId);
    const [hooks, terminals, resolvedRouter, defaultRouter, routerLocked] = await Promise.all([
      observe(() => resolveRoutingHooks(snapshot, input.project, snapshot.current)),
      observe(async () =>
        bound(
          await client.readContract({
            address: v6Address('JBDirectory', input.project.chainId),
            abi: jbDirectoryAbi,
            functionName: 'terminalsOf',
            args: [projectId],
          }),
          16,
          'Directory terminal count',
        ),
      ),
      observe(() =>
        client.readContract({
          address: registry,
          abi: jbRouterTerminalRegistryAbi,
          functionName: 'terminalOf',
          args: [projectId],
        }),
      ),
      observe(() =>
        client.readContract({
          address: registry,
          abi: jbRouterTerminalRegistryAbi,
          functionName: 'defaultTerminalFor',
          args: [projectId],
        }),
      ),
      observe(() =>
        client.readContract({
          address: registry,
          abi: jbRouterTerminalRegistryAbi,
          functionName: 'hasLockedTerminal',
          args: [projectId],
        }),
      ),
    ]);
    const route = await observe(async () => {
      const resolved = await resolveRouterTerminal(client, input.project, required(resolvedRouter));
      return { ...resolved, entryTerminal: registry, path: [registry, ...resolved.path] };
    });
    const pendingCalls = await observe(async () => {
      const gateway = required(route).gateway;
      if (!gateway) return null;
      const issuedIdCount = await observe(() =>
        client.readContract({
          address: gateway,
          abi: routerGatewayAbi,
          functionName: 'pendingCallCount',
        }),
      );
      const calls = await Promise.all(
        (input.pendingCallIds ?? []).map(async (id) => {
          const [commitment, failure] = await Promise.all([
            observe(() =>
              client.readContract({
                address: gateway,
                abi: routerGatewayAbi,
                functionName: 'pendingCallCommitmentOf',
                args: [id],
              }),
            ),
            observe(() =>
              client.readContract({
                address: gateway,
                abi: routerGatewayAbi,
                functionName: 'pendingCallFailureOf',
                args: [id],
              }),
            ),
          ]);
          return {
            id,
            commitment,
            failure,
            retained:
              commitment.status === 'known' ? known(commitment.value !== zeroHash) : commitment,
          };
        }),
      );
      return {
        gateway,
        issuedIdCount,
        calls,
        coverage:
          'The counter is the total identifiers ever issued, not the outstanding-call count. Only requested IDs are inspected. Queue-event call data must establish source project, token and amount and match the commitment.',
        custody:
          'Failed protocol-fee and protocol-payer router calls can remain in gateway custody for retry or accounted refund. A successful outer receipt or zero project-token return does not prove settlement. A zero commitment means no call is retained under that ID, not whether it settled, refunded or never existed.',
        recovery:
          'processPendingCallWithGas and finalizePendingCallWithGas require the exact queue-event call, memo and metadata. Match JBRouterTerminalGateway_QueuePendingCall, JBRouterTerminalGateway_ProcessPendingCall, JBRouterTerminalGateway_RefundPendingCall and JBRouterTerminalGateway_RecordTerminalCallFailure evidence; this read does not authorize recovery transactions.',
      };
    });
    const terminalContexts = await observe(async () =>
      Promise.all(
        required(terminals).map(async (terminal) => ({
          terminal,
          contexts: await observe(async () =>
            bound(
              await client.readContract({
                address: terminal,
                abi: jbMultiTerminalAbi,
                functionName: 'accountingContextsOf',
                args: [projectId],
              }),
              8,
              'Terminal token contexts',
            ),
          ),
        })),
      ),
    );
    const discovered =
      terminalContexts.status === 'known'
        ? terminalContexts.value.flatMap((item) =>
            item.contexts.status === 'known'
              ? item.contexts.value.map((context) => context.token)
              : [],
          )
        : [];
    const tokenMap = new Map(
      [...(input.tokens ?? []), ...discovered].map((token) => [token.toLowerCase(), token]),
    );
    const selected = [...tokenMap.values()].slice(0, 8);
    const [tokens, pools, routerPairs] = await Promise.all([
      Promise.all(
        selected.map(async (token) => ({
          token,
          primaryTerminal: await observe(() =>
            client.readContract({
              address: v6Address('JBDirectory', input.project.chainId),
              abi: jbDirectoryAbi,
              functionName: 'primaryTerminalOf',
              args: [projectId, token],
            }),
          ),
        })),
      ),
      observe(async () => {
        const hook = required(hooks).buyback;
        if (!hook) return [];
        if (!recordedBuyback(hook, input.project.chainId))
          throw new DomainError(
            'UNSUPPORTED_BUYBACK_IMPLEMENTATION',
            'Registry-selected custom buyback hook is identified, but its pool and oracle semantics require a separate adapter.',
          );
        return Promise.all(
          selected.map(async (terminalToken) => ({
            terminalToken,
            pool: await observe(() => this.pool(snapshot, hook, terminalToken)),
          })),
        );
      }),
      observe(async () => {
        if (!input.pairs?.length) return [];
        const router = required(route).router;
        if (
          !deploymentAddresses('JBRouterTerminal', input.project.chainId).some((candidate) =>
            same(candidate, router),
          )
        )
          throw new DomainError(
            'UNSUPPORTED_ROUTER_IMPLEMENTATION',
            'Pool discovery is supported only on the canonical router selected for this project.',
          );
        const wrappedNative = await client.readContract({
          address: router,
          abi: jbRouterTerminalAbi,
          functionName: 'wrappedNativeToken',
        });
        return Promise.all(
          input.pairs.map(async (pair) => {
            const tokenIn = same(pair.tokenIn, NATIVE) ? wrappedNative : pair.tokenIn;
            const tokenOut = same(pair.tokenOut, NATIVE) ? wrappedNative : pair.tokenOut;
            return {
              ...pair,
              normalizedTokenIn: tokenIn,
              normalizedTokenOut: tokenOut,
              discovery: same(tokenIn, tokenOut)
                ? known(null)
                : await observe(() =>
                    client.readContract({
                      address: router,
                      abi: jbRouterTerminalAbi,
                      functionName: 'discoverBestPool',
                      args: [tokenIn, tokenOut],
                    }),
                  ),
              quote: unavailable(
                'AMOUNT_PREVIEW_REQUIRED',
                'Pool discovery searches limited V3/V4 candidates and does not prove oracle coverage, liquidity at the trade size, or end-to-end payment output. Use a terminal payment preview with the amount and metadata.',
              ),
            };
          }),
        );
      }),
    ]);
    return jsonSafe({
      project: input.project,
      evidence: [snapshot.evidence],
      controller: snapshot.controller,
      rulesetId: snapshot.current.ruleset.id,
      hookFlags: {
        pay: snapshot.current.metadata.useDataHookForPay,
        cashOut: snapshot.current.metadata.useDataHookForCashOut,
      },
      hooks,
      router: {
        registry,
        resolved: resolvedRouter,
        path: route,
        pendingCalls,
        cohortDefault: defaultRouter,
        locked: routerLocked,
        directoryTerminals: terminals,
        terminalContexts,
        pairs: routerPairs,
      },
      tokens,
      buybackPools: pools,
      coverage: {
        tokenDiscoveryComplete:
          terminalContexts.status === 'known' &&
          terminalContexts.value.every((item) => item.contexts.status === 'known') &&
          tokenMap.size <= 8,
        tokenLimit: 8,
        discoveredTokenCount: tokenMap.size,
        routing:
          'An empty routing-terminal context list does not mean no accepted tokens. Primary-terminal discovery does not prove a payable route. Resolve registry terminalOf(projectId), then a recorded gateway ROUTER. Registries use project/cohort resolution; retired implementations can still serve existing projects even when disallowed for new selections.',
        prices:
          'Pool slot0 and liquidity are diagnostics. No spot price is presented as an executable or manipulation-resistant quote. Oracle age and actual observation success remain separate facts. JBPrices resolves project overrides and default feeds; JBRatioPriceFeed composes the relevant feeds for USDC/native and USDC/ETH conversions. Inspect live feed selection and exact currency/decimal inputs; a deployment record alone does not prove registration or a successful price read.',
        buybackPayMetadata:
          'The 1.4 buyback pay entry uses getId("pay", hook) and abi.encode(amountToSwapWith, minimumSwapAmountOut, skipSplits). Two-word pay entries revert on that implementation. A fill below its derived TWAP floor unwinds the swap and falls back to minting; an explicit minimum still constrains settlement. Resolve the project hook and its generation before encoding metadata.',
        slippageConfiguration:
          'V6 has no setDefaultSlippageToleranceOf. Buyback tolerance is derived from amount, liquidity, and fees; explicit minima are supplied in transaction metadata.',
      },
    });
  }

  private async pool(
    snapshot: RpcSnapshot & { projectId: bigint },
    hook: Address,
    terminalToken: Address,
  ) {
    const { client, projectId } = snapshot;
    const token = normalized(terminalToken);
    const [key, twapWindow, manager, configuredOracle] = await Promise.all([
      client.readContract({
        address: hook,
        abi: jbBuybackHookAbi,
        functionName: 'poolKeyOf',
        args: [projectId, token],
      }),
      client.readContract({
        address: hook,
        abi: jbBuybackHookAbi,
        functionName: 'twapWindowOf',
        args: [projectId, token],
      }),
      client.readContract({ address: hook, abi: jbBuybackHookAbi, functionName: 'poolManager' }),
      client.readContract({ address: hook, abi: jbBuybackHookAbi, functionName: 'oracleHook' }),
    ]);
    if (!configured(key))
      return {
        configured: false,
        key,
        twapWindowSeconds: twapWindow,
        manager,
        configuredOracle,
        state: known(null),
        oracle: known(null),
      };
    const poolId = uniswapV4PoolId(key);
    const [state, oracle] = await Promise.all([
      observe(() => this.poolState(snapshot, manager, key)),
      observe(async () => {
        if (same(key.hooks, zeroAddress))
          throw new DomainError(
            'ORACLE_MISSING',
            'This configured pool has no oracle hook; no retained TWAP is verified.',
          );
        const coverage = await observe(() =>
          client.readContract({
            address: key.hooks,
            abi: oracleAbi,
            functionName: 'observationCoverageOf',
            args: [key],
          }),
        );
        const requestedWindow = Number(twapWindow);
        if (
          !Number.isSafeInteger(requestedWindow) ||
          requestedWindow < 1 ||
          requestedWindow > 172800
        )
          throw new DomainError(
            'INVALID_ORACLE_WINDOW',
            'The configured TWAP window is outside the verified V6 range.',
          );
        const effectiveWindow =
          coverage.status === 'known' ? Math.min(coverage.value, requestedWindow) : requestedWindow;
        if (effectiveWindow === 0)
          return {
            coverage,
            requestedWindowSeconds: requestedWindow,
            observedWindowSeconds: 0,
            observations: known(null),
            quality: 'unseeded',
            matchesConfiguredOracle: same(key.hooks, configuredOracle),
            interpretation:
              'No retained observations. Buyback pay may use guarded bootstrap logic; cash-out cannot rely on that spot fallback.',
          };
        const observations = await observe(async () => {
          const [ticks, liquidity] = await client.readContract({
            address: key.hooks,
            abi: oracleAbi,
            functionName: 'observe',
            args: [key, [effectiveWindow, 0]],
          });
          if (ticks.length !== 2 || liquidity.length !== 2)
            throw new DomainError(
              'INVALID_ORACLE_RESPONSE',
              'Oracle cumulative arrays do not match the requested window.',
            );
          const tickDelta = ticks[1]! - ticks[0]!;
          const window = BigInt(effectiveWindow);
          const meanTick =
            tickDelta / window - (tickDelta < 0n && tickDelta % window !== 0n ? 1n : 0n);
          const liquidityDelta = liquidity[1]! - liquidity[0]!;
          if (liquidityDelta < 0n)
            throw new DomainError(
              'INVALID_ORACLE_RESPONSE',
              'Oracle liquidity cumulatives decreased; a wrap or invalid observation needs contract-level evaluation.',
            );
          const harmonicMeanLiquidity =
            liquidityDelta === 0n ? 0n : (window << 128n) / liquidityDelta;
          if (
            meanTick < -887272n ||
            meanTick > 887272n ||
            harmonicMeanLiquidity > (1n << 128n) - 1n
          )
            throw new DomainError(
              'INVALID_ORACLE_RESPONSE',
              'Oracle-derived tick or liquidity is outside Uniswap V4 bounds.',
            );
          return { arithmeticMeanTick: meanTick, harmonicMeanLiquidity };
        });
        const quality =
          observations.status === 'unknown'
            ? 'observationFailed'
            : observations.value.harmonicMeanLiquidity === 0n
              ? 'unseeded'
              : coverage.status === 'unknown'
                ? 'coverageUnknown'
                : effectiveWindow < requestedWindow
                  ? 'partialWindow'
                  : 'fullWindow';
        return {
          coverage,
          requestedWindowSeconds: requestedWindow,
          observedWindowSeconds: effectiveWindow,
          observations,
          quality,
          matchesConfiguredOracle: same(key.hooks, configuredOracle),
          interpretation:
            'Coverage and cumulative observations describe this block; amount-specific terminal previews determine actual route and enforceable output floors.',
        };
      }),
    ]);
    return {
      configured: true,
      key,
      poolId,
      twapWindowSeconds: twapWindow,
      manager,
      configuredOracle,
      state,
      oracle,
    };
  }

  private async poolState(snapshot: RpcSnapshot, manager: Address, key: UniswapV4PoolKey) {
    if (same(manager, zeroAddress))
      throw new DomainError('POOL_MANAGER_UNSET', 'The hook has no configured PoolManager.');
    const poolId = uniswapV4PoolId(key);
    const slot = uniswapV4PoolStateSlot(poolId);
    // Uniswap V4 StateLibrary: pools mapping at slot 6; liquidity at pool slot + 3.
    const liquiditySlot = numberToHex((BigInt(slot) + 3n) % (1n << 256n), { size: 32 });
    const [packedSlot0, packedLiquidity] = await Promise.all([
      snapshot.client.readContract({
        address: manager,
        abi: storageAbi,
        functionName: 'extsload',
        args: [slot],
      }),
      snapshot.client.readContract({
        address: manager,
        abi: storageAbi,
        functionName: 'extsload',
        args: [liquiditySlot],
      }),
    ]);
    const sqrtPriceX96 = uniswapV4SqrtPriceX96FromSlot0(packedSlot0);
    return {
      poolId,
      initialized: sqrtPriceX96 !== 0n,
      sqrtPriceX96,
      activeLiquidity: BigInt(packedLiquidity) & ((1n << 128n) - 1n),
      source: { manager, slot0: slot, liquiditySlot },
    };
  }

  private async authorize(
    snapshot: RpcSnapshot & { projectId: bigint },
    project: ProjectRef,
    account: Address,
    permissionId: number,
  ) {
    const owner = await snapshot.client.readContract({
      address: v6Address('JBProjects', project.chainId),
      abi: jbProjectsAbi,
      functionName: 'ownerOf',
      args: [snapshot.projectId],
    });
    if (same(owner, account)) return { owner, permissionId, authorizedBy: 'projectOwner' };
    const granted = await snapshot.client.readContract({
      address: v6Address('JBPermissions', project.chainId),
      abi: jbPermissionsAbi,
      functionName: 'hasPermission',
      args: [account, owner, snapshot.projectId, BigInt(permissionId), true, true],
    });
    if (!granted)
      throw new DomainError(
        'PERMISSION_REQUIRED',
        'The proposed account does not have the required project permission.',
      );
    return { owner, permissionId, authorizedBy: 'delegatedPermissionIncludingRootAndWildcard' };
  }

  private draft(
    project: ProjectRef,
    account: Address,
    snapshot: RpcSnapshot,
    to: Address,
    data: Hex,
    functionName: string,
    args: unknown,
    summary: unknown,
    warnings: string[],
  ): PlanDraft {
    return {
      operation: functionName,
      account,
      project,
      evidence: [snapshot.evidence],
      summary: jsonSafe(summary),
      warnings,
      calls: [
        {
          chainId: project.chainId,
          to,
          data,
          value: '0',
          label: functionName,
          decoded: { functionName, args: jsonSafe(args) },
          dependsOn: [],
        },
      ],
    };
  }

  async prepareBuybackPool(raw: z.input<typeof prepareBuybackPoolSchema>): Promise<PlanDraft> {
    const input = prepareBuybackPoolSchema.parse(raw);
    const snapshot = await this.context(input.project);
    const resolution = await resolveRoutingHooks(snapshot, input.project, snapshot.current);
    const hook = this.canonicalBuyback(resolution, input.project);
    const remapsRegistrationWindow =
      input.twapWindowSeconds === 172800 &&
      same(hook, deploymentAddress('JBBuybackHook', input.project.chainId)!);
    const authorization = await this.authorize(snapshot, input.project, input.account, 29);
    const [oldKey, manager, oracleHook, tokens] = await Promise.all([
      snapshot.client.readContract({
        address: hook,
        abi: jbBuybackHookAbi,
        functionName: 'poolKeyOf',
        args: [snapshot.projectId, normalized(input.terminalToken)],
      }),
      snapshot.client.readContract({
        address: hook,
        abi: jbBuybackHookAbi,
        functionName: 'poolManager',
      }),
      snapshot.client.readContract({
        address: hook,
        abi: jbBuybackHookAbi,
        functionName: 'oracleHook',
      }),
      snapshot.client.readContract({
        address: hook,
        abi: jbBuybackHookAbi,
        functionName: 'TOKENS',
      }),
    ]);
    if (configured(oldKey))
      throw new DomainError(
        'POOL_ALREADY_SET',
        'Buyback pool keys are immutable once configured for this project/token pair.',
      );
    if (same(oracleHook, zeroAddress))
      throw new DomainError(
        'ORACLE_UNSET',
        'The canonical buyback hook has no configured oracle. Its immutable pool selection cannot be prepared by this adapter.',
      );
    const projectToken = await snapshot.client.readContract({
      address: tokens,
      abi: jbTokensAbi,
      functionName: 'tokenOf',
      args: [snapshot.projectId],
    });
    const terminalToken = normalized(input.terminalToken);
    if (same(projectToken, zeroAddress) || same(projectToken, terminalToken))
      throw new DomainError(
        'INVALID_POOL_PAIR',
        'Pool setup requires an issued project ERC-20 distinct from the terminal token.',
      );
    const key: UniswapV4PoolKey =
      BigInt(projectToken) < BigInt(terminalToken)
        ? {
            currency0: projectToken,
            currency1: terminalToken,
            fee: input.fee,
            tickSpacing: input.tickSpacing,
            hooks: oracleHook,
          }
        : {
            currency0: terminalToken,
            currency1: projectToken,
            fee: input.fee,
            tickSpacing: input.tickSpacing,
            hooks: oracleHook,
          };
    const state = await this.poolState(snapshot, manager, key);
    if (!state.initialized)
      throw new DomainError(
        'POOL_NOT_INITIALIZED',
        'The exact V4 pool key must already be initialized in the configured PoolManager.',
      );
    const args = [
      snapshot.projectId,
      input.fee,
      input.tickSpacing,
      BigInt(input.twapWindowSeconds),
      input.terminalToken,
    ] as const;
    return this.draft(
      input.project,
      input.account,
      snapshot,
      hook,
      encodeFunctionData({ abi: jbBuybackHookAbi, functionName: 'setPoolFor', args }),
      'setPoolFor',
      args,
      {
        authorization,
        hookResolution: resolution,
        key,
        state,
        requestedTwapWindowSeconds: input.twapWindowSeconds,
        storedTwapWindowSeconds: remapsRegistrationWindow ? 1800 : input.twapWindowSeconds,
      },
      [
        'This permanently selects the pool key for this project and terminal token on this chain.',
        'Pool initialization does not establish oracle coverage or adequate trade-size liquidity. Fresh terminal previews are still required.',
        ...(remapsRegistrationWindow
          ? [
              'The contract registration sentinel 172800 stores 1800 seconds. Use a separate TWAP update to deliberately select 172800 seconds.',
            ]
          : []),
      ],
    );
  }

  async prepareBuybackTwap(raw: z.input<typeof prepareBuybackTwapSchema>): Promise<PlanDraft> {
    const input = prepareBuybackTwapSchema.parse(raw);
    const snapshot = await this.context(input.project);
    const resolution = await resolveRoutingHooks(snapshot, input.project, snapshot.current);
    const hook = this.canonicalBuyback(resolution, input.project);
    const authorization = await this.authorize(snapshot, input.project, input.account, 28);
    const [key, previousWindow] = await Promise.all([
      snapshot.client.readContract({
        address: hook,
        abi: jbBuybackHookAbi,
        functionName: 'poolKeyOf',
        args: [snapshot.projectId, normalized(input.terminalToken)],
      }),
      snapshot.client.readContract({
        address: hook,
        abi: jbBuybackHookAbi,
        functionName: 'twapWindowOf',
        args: [snapshot.projectId, normalized(input.terminalToken)],
      }),
    ]);
    if (!configured(key))
      throw new DomainError(
        'POOL_NOT_SET',
        'A buyback pool must be configured before its TWAP window can change.',
      );
    const args = [
      snapshot.projectId,
      input.terminalToken,
      BigInt(input.twapWindowSeconds),
    ] as const;
    return this.draft(
      input.project,
      input.account,
      snapshot,
      hook,
      encodeFunctionData({ abi: jbBuybackHookAbi, functionName: 'setTwapWindowOf', args }),
      'setTwapWindowOf',
      args,
      {
        authorization,
        hookResolution: resolution,
        key,
        previousWindowSeconds: previousWindow,
        nextWindowSeconds: input.twapWindowSeconds,
      },
      [
        'The requested window is stored exactly. Actual oracle coverage may be shorter and must be checked separately.',
        'This changes one chain and one terminal-token pair.',
      ],
    );
  }

  private canonicalBuyback(resolution: ResolvedRoutingHooks, project: ProjectRef): Address {
    if (!resolution.buyback)
      throw new DomainError(
        'BUYBACK_NOT_CONFIGURED',
        'No buyback hook belongs to the current project data-hook configuration.',
      );
    if (!recordedBuyback(resolution.buyback, project.chainId))
      throw new DomainError(
        'UNSUPPORTED_BUYBACK_IMPLEMENTATION',
        'Preparing pool or TWAP changes on a custom hook requires its own verified adapter.',
      );
    return resolution.buyback;
  }

  private async buybackCohortDefault(
    snapshot: RpcSnapshot & { projectId: bigint },
    registry: Address,
  ): Promise<Address> {
    const { client, projectId } = snapshot;
    const threshold = await client.readContract({
      address: registry,
      abi: jbBuybackHookRegistryAbi,
      functionName: 'defaultHookProjectIdThreshold',
    });
    if (projectId > threshold)
      return client.readContract({
        address: registry,
        abi: jbBuybackHookRegistryAbi,
        functionName: 'defaultHook',
      });
    const length = await client.readContract({
      address: registry,
      abi: jbBuybackHookRegistryAbi,
      functionName: 'defaultHookHistoryLength',
    });
    if (length > 32n)
      throw new DomainError(
        'ROUTING_READ_LIMIT',
        'The buyback default history exceeds the bounded read limit; the effective fallback is unknown.',
      );
    const segments = await Promise.all(
      Array.from({ length: Number(length) }, (_, index) =>
        client.readContract({
          address: registry,
          abi: jbBuybackHookRegistryAbi,
          functionName: 'defaultHookHistoryAt',
          args: [BigInt(index)],
        }),
      ),
    );
    return (
      segments.find(
        (segment) => projectId > segment.minProjectIdExclusive && projectId <= segment.maxProjectId,
      )?.hook ?? zeroAddress
    );
  }

  async prepareBuybackHook(raw: z.input<typeof prepareBuybackHookSchema>): Promise<PlanDraft> {
    const input = prepareBuybackHookSchema.parse(raw);
    const snapshot = await this.context(input.project);
    const resolution = await resolveRoutingHooks(snapshot, input.project, snapshot.current);
    const registry = v6Address('JBBuybackHookRegistry', input.project.chainId);
    if (!resolution.buybackRegistry || !same(resolution.buybackRegistry, registry))
      throw new DomainError(
        'REGISTRY_NOT_CONFIGURED',
        'The current project hook configuration does not forward through the canonical buyback registry.',
      );
    const [authorization, locked, allowed] = await Promise.all([
      this.authorize(snapshot, input.project, input.account, 30),
      snapshot.client.readContract({
        address: registry,
        abi: jbBuybackHookRegistryAbi,
        functionName: 'hasLockedHook',
        args: [snapshot.projectId],
      }),
      snapshot.client.readContract({
        address: registry,
        abi: jbBuybackHookRegistryAbi,
        functionName: 'isHookAllowed',
        args: [input.hook],
      }),
    ]);
    if (locked)
      throw new DomainError(
        'HOOK_LOCKED',
        'The project buyback implementation is permanently locked.',
      );
    if (!allowed)
      throw new DomainError(
        'HOOK_NOT_ALLOWED',
        'The requested hook is not allowed by the canonical buyback registry.',
      );
    const clearsOverride = same(input.hook, zeroAddress);
    const effectiveHookAfter = clearsOverride
      ? await observe(() => this.buybackCohortDefault(snapshot, registry))
      : known(input.hook);
    const meaning = !clearsOverride
      ? 'Pins the project buyback implementation.'
      : effectiveHookAfter.status === 'unknown'
        ? 'Clears the project override. The effective cohort fallback is unverified and may be zero; continued buyback routing is unknown.'
        : same(effectiveHookAfter.value, zeroAddress)
          ? 'Clears the project override. No fallback buyback hook resolves at the observed block.'
          : 'Clears the project override. The verified project cohort default becomes effective.';
    const args = [snapshot.projectId, input.hook] as const;
    return this.draft(
      input.project,
      input.account,
      snapshot,
      registry,
      encodeFunctionData({ abi: jbBuybackHookRegistryAbi, functionName: 'setHookFor', args }),
      'setHookFor',
      args,
      {
        authorization,
        previousHook: resolution.buyback,
        requestedHook: input.hook,
        effectiveHookAfter,
        meaning,
      },
      [
        'A registry-allowed custom hook can have different economic and oracle behavior. Its pool configuration is separate from the previous hook.',
        'The project data-hook wrapper and ruleset flags still determine which payment and cash-out calls reach this implementation.',
        'Migrating to buyback 1.4 requires three-word pay metadata and a separately configured pool/TWAP window. A retired hook can keep serving existing projects while being disallowed for a new selection.',
      ],
    );
  }

  async prepareRouterTerminal(
    raw: z.input<typeof prepareRouterTerminalSchema>,
  ): Promise<PlanDraft> {
    const input = prepareRouterTerminalSchema.parse(raw);
    const snapshot = await this.context(input.project);
    const registry = v6Address('JBRouterTerminalRegistry', input.project.chainId);
    if (same(input.terminal, registry))
      throw new DomainError('CIRCULAR_ROUTER', 'The router registry cannot forward into itself.');
    const [authorization, locked, allowed, previousTerminal, cohortDefault] = await Promise.all([
      this.authorize(snapshot, input.project, input.account, 31),
      snapshot.client.readContract({
        address: registry,
        abi: jbRouterTerminalRegistryAbi,
        functionName: 'hasLockedTerminal',
        args: [snapshot.projectId],
      }),
      snapshot.client.readContract({
        address: registry,
        abi: jbRouterTerminalRegistryAbi,
        functionName: 'isTerminalAllowed',
        args: [input.terminal],
      }),
      snapshot.client.readContract({
        address: registry,
        abi: jbRouterTerminalRegistryAbi,
        functionName: 'terminalOf',
        args: [snapshot.projectId],
      }),
      snapshot.client.readContract({
        address: registry,
        abi: jbRouterTerminalRegistryAbi,
        functionName: 'defaultTerminalFor',
        args: [snapshot.projectId],
      }),
    ]);
    if (locked)
      throw new DomainError(
        'TERMINAL_LOCKED',
        'The project router implementation is permanently locked.',
      );
    if (!allowed)
      throw new DomainError(
        'TERMINAL_NOT_ALLOWED',
        'The requested terminal is not allowed by the canonical router registry.',
      );
    const clearsOverride = same(input.terminal, zeroAddress);
    const effectiveTerminalAfter = clearsOverride ? cohortDefault : input.terminal;
    const effectivePathAfter = await observe(() =>
      resolveRouterTerminal(snapshot.client, input.project, effectiveTerminalAfter),
    );
    const args = [snapshot.projectId, input.terminal] as const;
    return this.draft(
      input.project,
      input.account,
      snapshot,
      registry,
      encodeFunctionData({
        abi: jbRouterTerminalRegistryAbi,
        functionName: 'setTerminalFor',
        args,
      }),
      'setTerminalFor',
      args,
      {
        authorization,
        previousTerminal,
        requestedTerminal: input.terminal,
        cohortDefault,
        effectiveTerminalAfter,
        effectivePathAfter,
        meaning: !clearsOverride
          ? 'Pins the project forwarding terminal.'
          : same(cohortDefault, zeroAddress)
            ? 'Clears the override. No fallback terminal resolves at the observed block; registry forwarding becomes unavailable.'
            : 'Clears the override. The verified project cohort default becomes the forwarding terminal.',
      },
      [
        'The contract simulation must validate nested forwarding and reject circular routes.',
        'This changes forwarding for this project on this chain; it does not migrate treasury balances or alter directory terminal registrations.',
        'A gateway is the registry-selectable forwarding terminal; its immutable router is a separate contract. Retained gateway fees remain in custody until a verified retry or accounted refund.',
      ],
    );
  }
}
