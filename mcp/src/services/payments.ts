import {
  NATIVE_TOKEN,
  jbBuybackHookRegistryAbi,
  jbDirectoryAbi,
  jbMultiTerminalAbi,
  jbOmnichainDeployerAbi,
  revOwnerAbi,
} from '@bananapus/nana-sdk-core';
import {
  buildPayTx,
  getCurrentRuleset,
  prepareHookAwareCashOut,
  previewPay,
  resolvePaymentTerminal,
  slippageFloor,
  v6Address,
} from '@bananapus/nana-sdk-core/v6';
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  parseAbi,
  parseAbiParameters,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { DomainError } from '../domain/errors.js';
import { jsonSafe } from '../domain/json.js';
import { verify721Hook } from '../domain/products.js';
import { resolveRouterTerminal } from '../domain/routing.js';
import { deploymentAddresses } from './rollout.js';
import type {
  ChainId,
  PlanDraft,
  PreparedCall,
  ProjectRef,
  RpcProvider,
  RpcSnapshot,
} from '../domain/types.js';

export interface PayInput {
  project: ProjectRef;
  /** Required even for previews: data hooks may depend on the payer. */
  account: Address;
  token: Address;
  amount: string;
  beneficiary: Address;
  slippageBps?: number;
  metadata?: Hex;
}

export interface CashOutInput {
  project: ProjectRef;
  holder: Address;
  cashOutCount: string;
  tokenToReclaim: Address;
  beneficiary: Address;
  /** Quotes default to holder; operators must provide their actual account. */
  account?: Address;
  slippageBps?: number;
  terminal?: Address;
}

export interface PayoutInput {
  project: ProjectRef;
  account: Address;
  token: Address;
  /** Integer in accounting-token decimals, denominated in `currency`. */
  amount: string;
  currency: number;
  slippageBps?: number;
  terminal?: Address;
}

type HookSpec = { hook: Address; noop: boolean; amount: bigint; metadata: Hex };
type RulesetContext = Awaited<ReturnType<typeof getCurrentRuleset>> & {
  controller: Address;
  buybackHook: Address;
  revOwner: Address | undefined;
  tieredHook: Address | undefined;
};

const feelessAbi = parseAbi([
  'function isFeelessFor(address addr, uint256 projectId, address caller) view returns (bool)',
]);
// This exact V6 tuple is emitted by canonical JBBuybackHook.beforePayRecordedWith.
// Its rawSwapQuote is diagnostic. Only beneficiary/reserved amounts are used here.
const buybackPaySpecParameters = parseAbiParameters(
  'bool projectTokenIs0, uint256 amountToMintWith, uint256 minimumSwapAmountOut, bool hasUserSpecifiedQuote, address controller, uint256 tokenCountWithoutHook, uint256 weightRatio, uint256 amountToSwapWith, int24 twapTick, uint128 twapLiquidity, bytes32 poolId, uint256 minimumBeneficiaryTokenCount, uint256 minimumReservedTokenCount, uint256 rawSwapQuote, bool oracleUnseeded, bool skipSplits, uint256 reservedPercent',
);

function same(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
function isNative(token: Address): boolean {
  return same(token, NATIVE_TOKEN);
}
function unsupported(message: string): never {
  throw new DomainError('UNSUPPORTED_CONFIGURATION', message);
}
function uint(value: string, name: string, positive = true): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78) {
    throw new DomainError('INVALID_AMOUNT', `${name} must be a base-10 integer string.`);
  }
  const result = BigInt(value);
  if (result >= 1n << 256n || (positive && result === 0n)) {
    throw new DomainError('INVALID_AMOUNT', `${name} is outside the supported uint256 range.`);
  }
  return result;
}
function bps(value = 100): bigint {
  if (!Number.isInteger(value) || value < 0 || value > 1000) {
    throw new DomainError('INVALID_SLIPPAGE', 'Slippage must be between 0 and 1000 basis points.');
  }
  return BigInt(value);
}

/** Preserve RpcProvider's block pin while supplying the real msg.sender to SDK views. */
function asAccount(
  client: PublicClient,
  account: Address,
  observed?: (request: Record<string, unknown>, result: unknown) => void,
): PublicClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property !== 'readContract') return Reflect.get(target, property, receiver);
      return async (request: Record<string, unknown>) => {
        const result = await target.readContract({ ...request, account } as Parameters<
          PublicClient['readContract']
        >[0]);
        observed?.(request, result);
        return result;
      };
    },
  });
}

function call(
  chainId: ChainId,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
  label: string,
  value = 0n,
  dependsOn: number[] = [],
): PreparedCall {
  const data = encodeFunctionData({ abi, functionName, args });
  const decoded = decodeFunctionData({ abi, data });
  return {
    chainId,
    to: address,
    data,
    value: value.toString(),
    label,
    dependsOn,
    decoded: { functionName: decoded.functionName, args: jsonSafe(decoded.args) },
  };
}

/**
 * Financial quote and calldata boundary. RPC failures propagate as unavailable;
 * no price, allowance, fee flag, or failed preview is replaced by a zero.
 */
export class PaymentService {
  constructor(private readonly rpc: RpcProvider) {}

  async quotePay(input: PayInput) {
    return (await this.pay(input)).quote;
  }

  async preparePay(input: PayInput): Promise<PlanDraft> {
    const { quote, transaction, snapshot } = await this.pay(input);
    const calls: PreparedCall[] = [];
    if (!isNative(input.token)) {
      const amount = uint(input.amount, 'amount');
      const allowance = await snapshot.client.readContract({
        address: input.token,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [input.account, transaction.address],
      });
      if (allowance < amount) {
        if (allowance > 0n) {
          calls.push(
            call(
              input.project.chainId,
              input.token,
              erc20Abi,
              'approve',
              [transaction.address, 0n],
              'Reset the existing insufficient token allowance',
            ),
          );
        }
        calls.push(
          call(
            input.project.chainId,
            input.token,
            erc20Abi,
            'approve',
            [transaction.address, amount],
            'Approve exactly this payment amount',
            0n,
            calls.length ? [calls.length - 1] : [],
          ),
        );
      }
    }
    calls.push(
      call(
        input.project.chainId,
        transaction.address,
        transaction.abi,
        transaction.functionName,
        transaction.args,
        'Pay the project through its resolved terminal',
        transaction.value,
        calls.length ? [calls.length - 1] : [],
      ),
    );
    return {
      operation: 'pay',
      account: input.account,
      project: input.project,
      calls,
      evidence: quote.evidence,
      summary: quote,
      warnings: [
        ...quote.warnings,
        ...(calls.length > 1
          ? [
              'Confirm each approval and verify its resulting allowance before simulating the dependent step. The payment has not been simulated with artificial balances or allowances.',
            ]
          : []),
      ],
    };
  }

  async quoteCashOut(input: CashOutInput) {
    return (await this.cashOut(input)).quote;
  }

  async prepareCashOut(input: CashOutInput & { account: Address }): Promise<PlanDraft> {
    const { quote, prepared } = await this.cashOut(input);
    if (prepared.route.expectedReturn === 0n || prepared.route.minimumReturn === 0n) {
      throw new DomainError(
        'NOTHING_TO_RECLAIM',
        'The verified cash-out quote returns zero; no token-burning transaction was prepared.',
      );
    }
    const tx = prepared.transaction;
    return {
      operation: 'cash_out',
      account: input.account,
      project: input.project,
      calls: [
        call(
          input.project.chainId,
          tx.address,
          tx.abi,
          tx.functionName,
          tx.args,
          'Cash out project tokens',
        ),
      ],
      evidence: quote.evidence,
      summary: quote,
      warnings: quote.warnings,
    };
  }

  async quotePayout(input: PayoutInput) {
    return (await this.payout(input)).quote;
  }

  async preparePayout(input: PayoutInput): Promise<PlanDraft> {
    const { quote, transaction } = await this.payout(input);
    if (quote.grossAmountRecorded === '0') {
      throw new DomainError(
        'NOTHING_TO_PAY_OUT',
        'The verified payout simulation records zero; no payout transaction was prepared.',
      );
    }
    return {
      operation: 'payout',
      account: input.account,
      project: input.project,
      calls: [transaction],
      evidence: quote.evidence,
      summary: quote,
      warnings: quote.warnings,
    };
  }

  private async context(
    client: PublicClient,
    project: ProjectRef,
    operation: 'pay' | 'cashOut' | 'payout',
  ): Promise<RulesetContext> {
    const projectId = uint(project.projectId, 'projectId');
    const controller = await client.readContract({
      address: v6Address('JBDirectory', project.chainId),
      abi: jbDirectoryAbi,
      functionName: 'controllerOf',
      args: [projectId],
    });
    if (same(controller, zeroAddress))
      throw new DomainError('PROJECT_NOT_FOUND', 'The project has no current controller.');
    if (!same(controller, v6Address('JBController', project.chainId))) {
      unsupported(
        'The current directory controller is custom. Its economic semantics need an audited adapter before preparing transactions.',
      );
    }
    const current = await getCurrentRuleset(client, { chainId: project.chainId, projectId });
    if (BigInt(current.ruleset.id) === 0n)
      throw new DomainError(
        'NO_ACTIVE_RULESET',
        'The project has no active ruleset at the quoted block.',
      );
    let buybackHook: Address = zeroAddress;
    let revOwner: Address | undefined;
    let tieredHook: Address | undefined;
    const enabled =
      operation === 'pay'
        ? current.metadata.useDataHookForPay
        : operation === 'cashOut'
          ? current.metadata.useDataHookForCashOut
          : false;
    const verifyTiered = async (hook: Address) => {
      await verify721Hook(client, project, hook);
      if (tieredHook && !same(tieredHook, hook))
        unsupported(
          'Multiple NFT tiers hooks in one payment require a dedicated composition adapter.',
        );
      tieredHook = hook;
    };
    const inspectHook = async (hook: Address, depth = 0): Promise<void> => {
      if (same(hook, zeroAddress)) return;
      const knownBuybacks = deploymentAddresses('JBBuybackHook', project.chainId);
      const canonicalRegistry = v6Address('JBBuybackHookRegistry', project.chainId);
      if (knownBuybacks.some((address) => same(hook, address))) buybackHook = hook;
      else if (
        same(hook, canonicalRegistry) ||
        same(hook, v6Address('REVOwner', project.chainId))
      ) {
        if (same(hook, v6Address('REVOwner', project.chainId))) {
          revOwner = hook;
          const registry = await client.readContract({
            address: hook,
            abi: revOwnerAbi,
            functionName: 'BUYBACK_HOOK',
          });
          if (!same(registry, canonicalRegistry))
            unsupported('This revnet uses a custom buyback registry.');
          if (operation === 'pay') {
            const tiered = await client.readContract({
              address: hook,
              abi: revOwnerAbi,
              functionName: 'tiered721HookOf',
              args: [projectId],
            });
            if (!same(tiered, zeroAddress)) await verifyTiered(tiered);
          }
        }
        buybackHook = await client.readContract({
          address: canonicalRegistry,
          abi: jbBuybackHookRegistryAbi,
          functionName: 'hookOf',
          args: [projectId],
        });
        if (
          !same(buybackHook, zeroAddress) &&
          !knownBuybacks.some((address) => same(buybackHook, address))
        ) {
          unsupported(
            'The project resolves to a custom or historical buyback hook whose settlement format is not supported.',
          );
        }
      } else if (same(hook, v6Address('JBOmnichainDeployer', project.chainId))) {
        if (depth !== 0)
          unsupported(
            'Nested omnichain data-hook wrappers require a dedicated composition adapter.',
          );
        const rulesetId = BigInt(current.ruleset.id);
        const [[tiered, usesTieredCashOut], extra] = await Promise.all([
          client.readContract({
            address: hook,
            abi: jbOmnichainDeployerAbi,
            functionName: 'tiered721HookOf',
            args: [projectId, rulesetId],
          }),
          client.readContract({
            address: hook,
            abi: jbOmnichainDeployerAbi,
            functionName: 'extraDataHookOf',
            args: [projectId, rulesetId],
          }),
        ]);
        const hasTiered = !same(tiered, zeroAddress) && (operation === 'pay' || usesTieredCashOut);
        if (hasTiered) await verifyTiered(tiered);
        // The canonical wrapper deliberately skips extra cash-out hooks when
        // the NFT hook supplies the cash-out weight. Mirror that composition;
        // do not treat an inactive custom extra hook as part of this route.
        const usesExtra =
          operation === 'pay'
            ? extra.useDataHookForPay
            : operation === 'cashOut' && !hasTiered
              ? extra.useDataHookForCashOut
              : false;
        if (usesExtra) await inspectHook(extra.dataHook, depth + 1);
      } else {
        // Direct NFT data hooks are clone addresses. Match their actual runtime
        // to the canonical implementation and verify all immutable links; a
        // familiar ABI or a claimed STORE address alone cannot establish trust.
        try {
          await verifyTiered(hook);
        } catch (error) {
          if (
            error instanceof DomainError &&
            ['UNSUPPORTED_721_HOOK', 'INVALID_721_IDENTITY'].includes(error.code)
          ) {
            unsupported(
              'The active data hook is neither a supported canonical hook nor a verified canonical NFT tiers clone.',
            );
          }
          throw error;
        }
      }
    };
    if (enabled) await inspectHook(current.metadata.dataHook);
    return { ...current, controller, buybackHook, revOwner, tieredHook };
  }

  private async paymentTerminal(client: PublicClient, project: ProjectRef, token: Address) {
    const resolved = await resolvePaymentTerminal(client, {
      chainId: project.chainId,
      projectId: BigInt(project.projectId),
      token,
    });
    const multi = v6Address('JBMultiTerminal', project.chainId);
    const registry = v6Address('JBRouterTerminalRegistry', project.chainId);
    if (same(resolved.address, multi))
      return {
        address: resolved.address,
        isRouter: false,
        previewSemantics: 'issuance' as const,
        path: [resolved.address],
        gateway: null,
      };
    const route = await resolveRouterTerminal(client, project, resolved.address);
    if (same(route.terminal, zeroAddress))
      throw new DomainError(
        'NO_PAYMENT_ROUTE',
        'The router registry has no effective terminal for this project.',
      );
    const routers = deploymentAddresses('JBRouterTerminal', project.chainId);
    if (!same(route.router, multi) && !routers.some((address) => same(address, route.router)))
      unsupported('The resolved payment terminal is custom and has no supported quote adapter.');
    if (!same(route.router, multi)) {
      // A known outer forwarder does not establish the identity of its candidate destinations.
      const terminals = await client.readContract({
        address: v6Address('JBDirectory', project.chainId),
        abi: jbDirectoryAbi,
        functionName: 'terminalsOf',
        args: [BigInt(project.projectId)],
      });
      for (const terminal of terminals) {
        if (same(terminal, multi)) continue;
        const candidate = same(terminal, resolved.address)
          ? route
          : await resolveRouterTerminal(client, project, terminal);
        if (
          !same(candidate.router, zeroAddress) &&
          !same(candidate.router, multi) &&
          !routers.some((address) => same(address, candidate.router))
        )
          unsupported(
            same(terminal, registry)
              ? 'A candidate destination registry forwards to a custom terminal whose settlement is unsupported.'
              : 'The router can select a custom destination terminal; its settlement requires a dedicated adapter.',
          );
      }
    }
    return {
      address: resolved.address,
      isRouter: true,
      previewSemantics: same(route.router, multi)
        ? ('issuance' as const)
        : ('router-normalized' as const),
      path: route.path,
      gateway: route.gateway,
    };
  }

  private async balanceTerminal(
    client: PublicClient,
    project: ProjectRef,
    token: Address,
    requested?: Address,
  ) {
    const canonical = v6Address('JBMultiTerminal', project.chainId);
    const terminal = requested ?? canonical;
    if (!same(terminal, canonical))
      unsupported(
        'Cash-out and payout preparation currently require the canonical V6 multi-terminal.',
      );
    const registered = await client.readContract({
      address: v6Address('JBDirectory', project.chainId),
      abi: jbDirectoryAbi,
      functionName: 'isTerminalOf',
      args: [BigInt(project.projectId), terminal],
    });
    if (!registered)
      throw new DomainError(
        'TERMINAL_NOT_REGISTERED',
        'The requested treasury terminal is not registered for this project at the quoted block.',
      );
    const accounting = await client.readContract({
      address: terminal,
      abi: jbMultiTerminalAbi,
      functionName: 'accountingContextForTokenOf',
      args: [BigInt(project.projectId), token],
    });
    if (!same(accounting.token, token) || same(accounting.token, zeroAddress)) {
      throw new DomainError(
        'TOKEN_NOT_ACCEPTED',
        'The selected treasury terminal has no accounting context for this token.',
      );
    }
    return { terminal, accounting };
  }

  private async pay(input: PayInput) {
    const amount = uint(input.amount, 'amount');
    const slippage = bps(input.slippageBps);
    const snapshot = await this.rpc.snapshot(input.project.chainId);
    let fullPreview: readonly unknown[] | undefined;
    const client = asAccount(snapshot.client, input.account, (request, result) => {
      if (request.functionName === 'previewPayFor' && Array.isArray(result)) fullPreview = result;
    });
    const context = await this.context(client, input.project, 'pay');
    const terminal = await this.paymentTerminal(client, input.project, input.token);
    const metadata = input.metadata ?? '0x';
    const preview = await previewPay(client, {
      chainId: input.project.chainId,
      terminal: terminal.address,
      projectId: BigInt(input.project.projectId),
      token: input.token,
      amount,
      beneficiary: input.beneficiary,
      metadata,
    });
    if (!fullPreview || !Array.isArray(fullPreview[3]))
      throw new DomainError(
        'INVALID_PREVIEW',
        'The terminal did not provide a complete V6 payment preview.',
      );
    const previewRuleset = fullPreview[0];
    if (
      !previewRuleset ||
      typeof previewRuleset !== 'object' ||
      !('id' in previewRuleset) ||
      String(previewRuleset.id) !== String(context.ruleset.id)
    ) {
      throw new DomainError(
        'INVALID_PREVIEW',
        'The payment preview ruleset does not match the verified current ruleset.',
      );
    }
    const hooks = fullPreview[3] as HookSpec[];
    let beneficiaryTokenCount = preview.beneficiaryTokenCount;
    let reservedTokenCount = preview.reservedTokenCount;
    let quoteBasis: 'terminal-issuance-preview' | 'buyback-hook-indicative-output' =
      'terminal-issuance-preview';
    const warnings = [
      'This quote follows the project terminal route. Direct market acquisition has not been compared, so this is not a best-price claim.',
      'A terminal payment can route funds into a buyback pool or hooks. The full payment is not necessarily retained in the treasury.',
    ];
    if (terminal.gateway)
      warnings.push(
        'The registry-selected gateway takes custody before forwarding to its immutable router. Only failed zero-minimum calls with a valid source-project opt-in can be retained; ordinary failed payments revert. A queued fee is pending, not paid or forgiven.',
      );
    for (const spec of hooks) {
      if (spec.noop) continue;
      if (context.tieredHook && same(spec.hook, context.tieredHook)) {
        if (spec.amount > 0n)
          unsupported(
            'This NFT tiers hook forwards funds to tier splits, which can invoke nested project payments and arbitrary split hooks. Their economic effects require a dedicated quote adapter.',
          );
        warnings.push(
          'The revnet also invokes its registered NFT tiers hook without forwarding funds to tier splits. This quote describes fungible tokens; NFT allocation needs a separate review.',
        );
        continue;
      }
      if (same(context.buybackHook, zeroAddress) || !same(spec.hook, context.buybackHook))
        unsupported(
          'The pay preview includes an unrecognized active hook. Its final beneficiary output is unknown.',
        );
      if (spec.metadata.length !== 2 + 17 * 64)
        unsupported(
          'The selected historical buyback hook uses an unsupported settlement format; its address remains available in the contract catalog.',
        );
      const decoded = decodeAbiParameters(buybackPaySpecParameters, spec.metadata);
      const amountToMintWith = decoded[1];
      const previewController = decoded[4];
      const skipSplits = decoded[15];
      if (!same(previewController, context.controller))
        unsupported('The buyback preview names a different controller.');
      if (amountToMintWith !== 0n || skipSplits)
        unsupported(
          'Partial buyback payments and skip-reserved-split metadata need a dedicated quote adapter.',
        );
      if (quoteBasis === 'buyback-hook-indicative-output')
        unsupported('Multiple active buyback pay specifications are not supported.');
      // An active canonical buyback hook returns weight=0: all fungible output
      // comes through this hook. The router may already have normalized its
      // returned counts (even using raw TWAP diagnostics). Replace those counts
      // with this indicative executable quote basis; never add it a second time.
      beneficiaryTokenCount = decoded[11];
      reservedTokenCount = decoded[12];
      quoteBasis = 'buyback-hook-indicative-output';
      warnings.push(
        'Buyback output is indicative. Buyback 1.4.0 pay quotes encode three words (amountToSwapWith, minimumSwapAmountOut, skipSplits); two-word quotes revert. A pool failure or swap below the TWAP floor falls back to issuance; the transaction reverts if the final beneficiary balance increase is below its reviewed minimum.',
      );
    }
    const minimum = slippageFloor(beneficiaryTokenCount, slippage);
    if (beneficiaryTokenCount === 0n)
      warnings.push(
        'The verified preview returns zero fungible project tokens for the beneficiary. The payment has a zero minimum and may still transfer funds.',
      );
    const transaction = buildPayTx({
      chainId: input.project.chainId,
      terminal: terminal.address,
      projectId: BigInt(input.project.projectId),
      token: input.token,
      amount,
      beneficiary: input.beneficiary,
      minReturnedTokens: minimum,
      metadata,
    });
    const quote = {
      operation: 'pay' as const,
      project: input.project,
      account: input.account,
      terminal: terminal.address,
      terminalPath: terminal.path,
      routerGateway: terminal.gateway,
      route: terminal.isRouter ? 'router-terminal' : 'multi-terminal',
      quoteBasis,
      payment: { token: input.token, amount: amount.toString(), unit: 'token-base-units' },
      beneficiary: input.beneficiary,
      projectTokenDecimals: 18,
      beneficiaryTokenCount: beneficiaryTokenCount.toString(),
      reservedTokenCount: reservedTokenCount.toString(),
      rawTerminalPreview: {
        semantics: terminal.previewSemantics,
        beneficiaryTokenCount: preview.beneficiaryTokenCount.toString(),
        reservedTokenCount: preview.reservedTokenCount.toString(),
      },
      minimumBeneficiaryTokenCount: minimum.toString(),
      slippageBps: Number(slippage),
      metadata,
      hooks: jsonSafe(hooks),
      rulesetId: context.ruleset.id.toString(),
      evidence: [snapshot.evidence],
      warnings,
    };
    return { quote, transaction, snapshot };
  }

  private async cashOut(input: CashOutInput) {
    const cashOutCount = uint(input.cashOutCount, 'cashOutCount');
    const slippage = bps(input.slippageBps);
    const account = input.account ?? input.holder;
    const snapshot = await this.rpc.snapshot(input.project.chainId);
    const client = asAccount(snapshot.client, account);
    const context = await this.context(client, input.project, 'cashOut');
    const { terminal, accounting } = await this.balanceTerminal(
      client,
      input.project,
      input.tokenToReclaim,
      input.terminal,
    );
    const feelessRegistry = await client.readContract({
      address: terminal,
      abi: jbMultiTerminalAbi,
      functionName: 'FEELESS_ADDRESSES',
    });
    const beneficiaryIsFeeless = await client.readContract({
      address: feelessRegistry,
      abi: feelessAbi,
      functionName: 'isFeelessFor',
      args: [input.beneficiary, BigInt(input.project.projectId), account],
    });
    const prepared = await prepareHookAwareCashOut(client, {
      chainId: input.project.chainId,
      projectId: BigInt(input.project.projectId),
      holder: input.holder,
      cashOutCount,
      tokenToReclaim: input.tokenToReclaim,
      beneficiary: input.beneficiary,
      terminal,
      buybackHookAddress: context.buybackHook,
      beneficiaryIsFeeless,
      slippageBps: slippage,
    });
    for (const preview of [prepared.preview, prepared.lockedPreview]) {
      if (!preview) continue;
      if (preview.rulesetId !== BigInt(context.ruleset.id))
        throw new DomainError(
          'INVALID_PREVIEW',
          'The cash-out preview ruleset does not match the verified current ruleset.',
        );
      for (const spec of preview.hookSpecifications) {
        if (spec.noop) continue;
        const buyback =
          !same(context.buybackHook, zeroAddress) && same(spec.hook, context.buybackHook);
        const revFee = context.revOwner !== undefined && same(spec.hook, context.revOwner);
        if (!buyback && !revFee)
          unsupported(
            'The cash-out preview includes an unrecognized active hook; its return cannot safely be inferred.',
          );
      }
    }
    const activeBuyback = prepared.preview.hookSpecifications.some(
      (spec) => !spec.noop && same(spec.hook, context.buybackHook),
    );
    // SDK resolution may choose its zero treasury fallback when applying user
    // slippage to an active pool preview no longer beats the direct route.
    // That pool preview does not contain a fresh treasury quote. Never emit its
    // zero terminal minimum with empty metadata as if it protected a cash-out.
    if (activeBuyback && prepared.route.route !== 'amm') {
      throw new DomainError(
        'CASH_OUT_ROUTE_REQUIRES_REQUOTE',
        'The protected buyback quote no longer selects the pool. A new explicit treasury-route quote is required; no floorless cash-out was prepared.',
        { retryable: true },
      );
    }
    const route = prepared.route;
    const warnings = [
      'The quote uses the terminal cash-out path and recognized hooks. Direct market sales have not been compared.',
      'Cash-out preview does not prove the caller has burn permission or the holder has sufficient tokens. The exact transaction must be simulated as the stated account.',
    ];
    if (context.revOwner)
      warnings.push(
        'Revnet fee-hook outflow is already reflected in the hook-aware preview. It is not subtracted again as a flat fee from the beneficiary quote.',
      );
    if (route.route === 'amm')
      warnings.push(
        'The protected minimum is enforced by buyback cash-out metadata; the terminal minimum is zero for this route. Re-quote if the route changes.',
      );
    if (!isNative(input.tokenToReclaim))
      warnings.push(
        'ERC-20 transfer taxes and rebases are not modeled. The treasury minimum protects the terminal net transfer amount, which can differ from the recipient balance increase for such tokens.',
      );
    const quote = {
      operation: 'cash_out' as const,
      project: input.project,
      account,
      holder: input.holder,
      cashOutCount: cashOutCount.toString(),
      projectTokenDecimals: 18,
      terminal,
      tokenToReclaim: input.tokenToReclaim,
      tokenDecimals: accounting.decimals,
      accountingCurrency: accounting.currency,
      beneficiary: input.beneficiary,
      beneficiaryIsFeeless,
      route: route.route,
      quoteBasis:
        route.route === 'amm'
          ? 'buyback-hook-indicative-output'
          : 'terminal-preview-after-protocol-fee',
      expectedReturn: route.expectedReturn.toString(),
      ...(route.buyback
        ? { buybackExecutableQuote: route.buyback.minimumSwapAmountOut.toString() }
        : {}),
      minimumReturn: route.minimumReturn.toString(),
      terminalMinimum: route.terminalMinimum.toString(),
      metadata: route.metadata,
      slippageBps: Number(slippage),
      treasuryGross: route.treasuryGross.toString(),
      treasuryProtocolFee: route.treasuryProtocolFee.toString(),
      treasuryNet: route.treasuryNet.toString(),
      cashOutTaxRate: prepared.preview.cashOutTaxRate.toString(),
      hooks: jsonSafe(prepared.preview.hookSpecifications),
      rulesetId: context.ruleset.id.toString(),
      evidence: [snapshot.evidence],
      warnings,
    };
    return { quote, prepared };
  }

  private async payout(input: PayoutInput) {
    const amount = uint(input.amount, 'amount');
    const slippage = bps(input.slippageBps);
    if (
      !Number.isSafeInteger(input.currency) ||
      input.currency < 0 ||
      input.currency > 0xffff_ffff
    ) {
      throw new DomainError('INVALID_CURRENCY', 'Payout currency must fit uint32.');
    }
    const snapshot: RpcSnapshot = await this.rpc.snapshot(input.project.chainId);
    const client = asAccount(snapshot.client, input.account);
    const context = await this.context(client, input.project, 'payout');
    const { terminal, accounting } = await this.balanceTerminal(
      client,
      input.project,
      input.token,
      input.terminal,
    );
    const args = [
      BigInt(input.project.projectId),
      input.token,
      amount,
      BigInt(input.currency),
      0n,
    ] as const;
    const simulated = await client.simulateContract({
      address: terminal,
      abi: jbMultiTerminalAbi,
      functionName: 'sendPayoutsOf',
      args,
      account: input.account,
      blockNumber: BigInt(snapshot.evidence.blockNumber),
      gas: 10_000_000n,
    });
    const gross = simulated.result;
    const isCurrencyConversion = input.currency !== accounting.currency;
    const minimum = isCurrencyConversion ? slippageFloor(gross, slippage) : gross;
    const transaction = call(
      input.project.chainId,
      terminal,
      jbMultiTerminalAbi,
      'sendPayoutsOf',
      [args[0], args[1], args[2], args[3], minimum],
      'Send the current ruleset payout splits',
    );
    const quote = {
      operation: 'payout' as const,
      project: input.project,
      account: input.account,
      terminal,
      token: input.token,
      tokenDecimals: accounting.decimals,
      amount: amount.toString(),
      currency: input.currency,
      accountingCurrency: accounting.currency,
      isCurrencyConversion,
      grossAmountRecorded: gross.toString(),
      minimumGrossAmountRecorded: minimum.toString(),
      slippageBps: isCurrencyConversion ? Number(slippage) : 0,
      quoteBasis: 'sendPayoutsOf-simulation-return' as const,
      rulesetId: context.ruleset.id.toString(),
      evidence: [snapshot.evidence],
      warnings: [
        'The return and minimum are the gross payout amount recorded against the limit, before recipient fees. They do not guarantee delivery to every split recipient.',
        'Failed split or owner transfers can be caught and returned to the project balance while consuming the payout limit. Verify payout-transfer events and recipient outcomes after execution.',
        'Recipient amounts, hook effects, wildcard caller shares, held fees, and actual protocol fees require receipt evidence; they cannot be inferred from the gross return.',
      ],
    };
    return { quote, transaction };
  }
}
