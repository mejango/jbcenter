import { describe, expect, it, vi } from 'vitest';
import {
  NATIVE_TOKEN,
  createHookMetadata,
  hookMetadataId,
  jbMultiTerminalAbi,
  jbTerminalStoreAbi,
} from '@bananapus/nana-sdk-core';
import {
  build721PayMetadata,
  buildBuybackCashOutMetadata,
  buildBuybackPayMetadata,
  buildUserPayMetadata,
  prepareUserPay,
  slippageFloor,
  uniswapV4PoolId,
  v6Address,
  type UserPayTiers,
} from '@bananapus/nana-sdk-core/v6';
import {
  CallExecutionError,
  ContractFunctionRevertedError,
  RpcRequestError,
  concat,
  keccak256,
  pad,
  toHex,
  decodeFunctionData,
  encodeErrorResult,
  encodeAbiParameters,
  erc20Abi,
  getAddress,
  parseAbiParameters,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import {
  PaymentService,
  type CashOutInput,
  type PayInput,
  type PayoutInput,
} from '../../src/services/payments.js';
import { deploymentAddress, rollout } from '../../src/services/rollout.js';
import { DomainError, publicError } from '../../src/domain/errors.js';
import { RpcPool } from '../../src/adapters/rpc.js';
import type { BlockEvidence, RpcProvider } from '../../src/domain/types.js';

const project = { chainId: 8453, projectId: '12', version: 6 } as const;
const account = '0x1111111111111111111111111111111111111111' as const;
const beneficiary = '0x2222222222222222222222222222222222222222' as const;
const token = '0x3333333333333333333333333333333333333333' as const;
const feeless = '0x4444444444444444444444444444444444444444' as const;
const custom = '0x5555555555555555555555555555555555555555' as const;
const controller = v6Address('JBController', project.chainId);
const terminal = v6Address('JBMultiTerminal', project.chainId);
const buybackHook = deploymentAddress('JBBuybackHook', project.chainId)!;
const registry = v6Address('JBBuybackHookRegistry', project.chainId);
const omni = v6Address('JBOmnichainDeployer', project.chainId);
const nftImplementation = v6Address('JB721TiersHook', project.chainId);
const nftCloneCode =
  `0x3d3d3d3d363d3d37363d73${nftImplementation.slice(2)}5af43d3d93803e602a57fd5bf3` as Hex;
const hash = `0x${'ab'.repeat(32)}` as Hex;
// The project's buyback pool for the paid token (native), as the hook's poolKeyOf returns it.
const poolKey = {
  currency0: zeroAddress,
  currency1: token,
  fee: 10_000,
  tickSpacing: 200,
  hooks: zeroAddress,
} as const;
const ruleset = {
  id: 3,
  cycleNumber: 1,
  basedOnId: 0,
  start: 10,
  duration: 0,
  weight: 1_000n,
  weightCutPercent: 0,
  approvalHook: zeroAddress,
  // Reserved percent 1,667 of 10,000 at bits 4-19, as JBRulesetMetadataResolver packs it.
  metadata: 1_667n << 4n,
};
const evidence: BlockEvidence = {
  chainId: 8453,
  blockNumber: '123',
  blockHash: hash,
  timestamp: '1000',
  source: 'rpc',
};
// skipSplits unset: the default, on wherever the hook is buyback 1.4 through the registry.
const payInput: PayInput = {
  project,
  account,
  token: NATIVE_TOKEN,
  amount: '100',
  beneficiary,
};
// The split-honoring path, for fees or revenue routed into a project.
const splitPayInput: PayInput = { ...payInput, skipSplits: false };
// Caller metadata keeps this service's own path: the hook's spec, less slippage.
const ownPayInput: PayInput = { ...payInput, metadata: '0x1234' };
const cashInput: CashOutInput & { account: Address } = {
  project,
  account,
  holder: account,
  tokenToReclaim: NATIVE_TOKEN,
  cashOutCount: '100',
  beneficiary,
};
const payoutInput: PayoutInput = {
  project,
  account,
  token: NATIVE_TOKEN,
  amount: '100',
  currency: 61166,
};
type Request = {
  functionName: string;
  args?: readonly unknown[];
  account?: Address;
  address?: Address;
  blockNumber?: bigint;
  gas?: bigint;
};
type HookSpec = { hook: Address; noop: boolean; amount: bigint; metadata: Hex };

function fixture(
  options: {
    beneficiaryCount?: bigint;
    reservedCount?: bigint;
    allowance?: bigint;
    /** A function receives the pay metadata, so a preview depends on the bytes it was sent. */
    payHooks?: HookSpec[] | ((metadata: Hex) => HookSpec[]);
    dataHook?: Address;
    cashGross?: bigint;
    cashTax?: bigint;
    feeFreeSurplus?: bigint;
    beneficiaryIsFeeless?: boolean;
    cashPreview?: (metadata: Hex) => readonly unknown[];
    grossPayout?: bigint;
    payoutRevert?: Error;
    holderBalance?: bigint;
    resolvedBuyback?: Address;
    customController?: Address;
    errorOn?: string;
    /** What a read named by errorOn throws; a generic RPC error by default. */
    errorValue?: unknown;
    primaryTerminal?: Address;
    routerTarget?: Address;
    gatewayRouter?: Address;
    registered?: boolean;
    tieredHook?: Address;
    nftClone?: Address;
    nftProjectId?: bigint;
    extraDataHook?: Address;
    extraPayEnabled?: boolean;
    /** The beneficiary's fill for the pay metadata; a simulation reverts below its minimum. */
    payFill?: bigint | Error | ((metadata: Hex) => bigint);
    /** The V4 quoter's output for the buyback pool; unset, the hook has no readable pool. */
    poolQuote?: bigint;
  } = {},
) {
  const metadata = {
    useDataHookForPay: Boolean(options.dataHook),
    useDataHookForCashOut: Boolean(options.dataHook),
    dataHook: options.dataHook ?? zeroAddress,
  };
  const readContract = vi.fn(async (request: Request): Promise<unknown> => {
    if (options.errorOn === request.functionName)
      throw options.errorValue ?? new Error('RPC read unavailable');
    switch (request.functionName) {
      case 'controllerOf':
        return options.customController ?? controller;
      case 'currentRulesetOf':
        return [ruleset, metadata];
      case 'primaryTerminalOf':
        return options.primaryTerminal ?? terminal;
      case 'ROUTER':
        return options.gatewayRouter;
      case 'terminalOf':
        return options.routerTarget ?? v6Address('JBRouterTerminal', project.chainId);
      case 'terminalsOf':
        return [terminal, v6Address('JBRouterTerminalRegistry', project.chainId)];
      case 'isTerminalOf':
        return options.registered ?? true;
      case 'accountingContextForTokenOf':
        return { token: request.args?.[1], decimals: 18, currency: 61166 };
      case 'previewPayFor':
        return [
          // As on chain: useDataHookForPay (bit 80), useDataHookForCashOut (81), dataHook (82-241).
          options.dataHook
            ? {
                ...ruleset,
                metadata: ruleset.metadata | (3n << 80n) | (BigInt(options.dataHook) << 82n),
              }
            : ruleset,
          options.beneficiaryCount ?? 101n,
          options.reservedCount ?? 10n,
          typeof options.payHooks === 'function'
            ? options.payHooks(request.args?.[4] as Hex)
            : (options.payHooks ?? []),
        ];
      case 'allowance':
        return options.allowance ?? 0n;
      case 'BUYBACK_HOOK':
        return registry;
      case 'tiered721HookOf':
        return request.address === omni
          ? [options.tieredHook ?? zeroAddress, false]
          : (options.tieredHook ?? zeroAddress);
      case 'extraDataHookOf':
        return {
          dataHook: options.extraDataHook ?? zeroAddress,
          useDataHookForPay: options.extraPayEnabled ?? true,
          useDataHookForCashOut: true,
        };
      case 'STORE':
        return v6Address('JB721TiersHookStore', project.chainId);
      case 'DIRECTORY':
        return v6Address('JBDirectory', project.chainId);
      case 'projectId':
        return options.nftProjectId ?? BigInt(project.projectId);
      case 'METADATA_ID_TARGET':
        return nftImplementation;
      case 'pricingContext':
        return [61166, 18];
      case 'hookOf':
        return options.resolvedBuyback ?? buybackHook;
      case 'FEELESS_ADDRESSES':
        return feeless;
      case 'isFeelessFor':
        return options.beneficiaryIsFeeless ?? false;
      case 'previewCashOutFrom':
        return (
          options.cashPreview?.(request.args?.[5] as Hex) ?? [
            ruleset,
            options.cashGross ?? 101n,
            options.cashTax ?? 1n,
            [],
          ]
        );
      case 'feeFreeSurplusOf':
        return options.feeFreeSurplus ?? 0n;
      case 'totalBalanceOf':
        return options.holderBalance ?? 10n ** 30n;
      case 'poolKeyOf':
        if (options.poolQuote === undefined) throw new Error('No pool for this token');
        return poolKey;
      default:
        throw new Error(`Unexpected read ${request.functionName}`);
    }
  });
  const simulateContract = vi.fn(async (request: Request) => {
    if (request.functionName === 'pay') {
      if (options.payFill instanceof Error) throw options.payFill;
      const fill =
        typeof options.payFill === 'function'
          ? options.payFill(request.args?.[6] as Hex)
          : (options.payFill ?? 600n);
      if ((request.args?.[4] as bigint) > fill)
        throw new Error('JBMultiTerminal_UnderMinReturnedTokens');
      return { result: fill };
    }
    if (options.payoutRevert) throw options.payoutRevert;
    return { result: options.grossPayout ?? 101n };
  });
  const getBytecode = vi.fn(async ({ address }: { address: Address }) => {
    if (address === nftImplementation) return '0x6000';
    return address === options.nftClone || address === options.tieredHook ? nftCloneCode : '0x';
  });
  // The V4 quoter: (amountOut, gasEstimate).
  const call = vi.fn(async () => {
    if (options.poolQuote === undefined) throw new Error('No pool for this token');
    return {
      data: encodeAbiParameters(parseAbiParameters('uint256,uint256'), [options.poolQuote, 0n]),
    };
  });
  const client = { readContract, simulateContract, getBytecode, call } as unknown as PublicClient;
  const snapshot = vi.fn(async () => ({ client, evidence }));
  const rpc: RpcProvider = { snapshot, client: () => client };
  return {
    service: new PaymentService(rpc),
    client,
    readContract,
    simulateContract,
    getBytecode,
    snapshot,
  };
}

function payHookMetadata(
  overrides: {
    beneficiaryCount?: bigint;
    skipSplits?: boolean;
    partialMint?: bigint;
    /** Word 2: the TWAP-derived floor, or the caller's own minimum when `callerMinimum` is set. */
    minimum?: bigint;
    callerMinimum?: boolean;
  } = {},
): Hex {
  return encodeAbiParameters(
    parseAbiParameters(
      'bool,uint256,uint256,bool,address,uint256,uint256,uint256,int24,uint128,bytes32,uint256,uint256,uint256,bool,bool,uint256',
    ),
    [
      false,
      overrides.partialMint ?? 0n,
      overrides.minimum ?? 300n,
      overrides.callerMinimum ?? false,
      controller,
      // tokenCountWithoutHook: a 200-token gross mint. Skipping, buyback 1.4 reports the payer's
      // share of it (200 less 16.67%), as its Solidity does; otherwise the gross count.
      overrides.skipSplits ? 166n : 200n,
      1n,
      100n,
      0,
      1n,
      uniswapV4PoolId(poolKey),
      overrides.beneficiaryCount ?? 250n,
      50n,
      999n,
      false,
      overrides.skipSplits ?? false,
      1667n,
    ],
  );
}

/** The quote words buyback 1.4 reads from a registry or hook-keyed entry: (amount, minimum, skip). */
function sentQuote(sent: Hex) {
  const words = (sent.slice(2).match(/.{64}/g) ?? []).slice(-3).map((w) => BigInt(`0x${w}`));
  return words.length === 3 && sent !== '0x'
    ? { minimum: words[1]!, skip: words[2] === 1n }
    : { minimum: 0n, skip: false };
}
/** Buyback 1.4 as it previews whatever quote it is sent. */
const buyback14 =
  (overrides: Parameters<typeof payHookMetadata>[0] = {}) =>
  (sent: Hex): HookSpec[] => {
    const { minimum, skip } = sentQuote(sent);
    return [
      {
        hook: buybackHook,
        noop: false,
        amount: 100n,
        metadata: payHookMetadata({
          skipSplits: skip,
          ...(minimum ? { minimum, callerMinimum: true } : {}),
          ...overrides,
        }),
      },
    ];
  };

function cashHookMetadata(minimum: bigint, explicit: boolean, direct = 100n): Hex {
  return encodeAbiParameters(
    parseAbiParameters('uint256,uint256,uint256,int24,uint128,bytes32,uint256,bool'),
    [minimum, 100n, direct, 0, 1n, hash, explicit ? 0n : 250n, explicit],
  );
}

describe('payment quotes and approval plans', () => {
  it('preserves the caller-supplied canonical snapshot through ordinary payment preparation', async () => {
    const f = fixture();
    const { client } = await f.snapshot();
    f.snapshot.mockClear();
    const at: BlockEvidence = {
      ...evidence,
      blockNumber: '456',
      blockHash: `0x${'cd'.repeat(32)}`,
    };
    const snapshotAt = vi.fn(() => ({ client, evidence: at }));
    const service = new PaymentService({ snapshot: f.snapshot, snapshotAt, client: () => client });
    const plan = await service.preparePay(payInput, at);
    expect(snapshotAt).toHaveBeenCalledWith(project.chainId, at);
    expect(f.snapshot).not.toHaveBeenCalled();
    expect(plan.evidence).toEqual([at]);
  });
  it('quotes at a caller-supplied block, so a pool quote and the terminal quote share one block', async () => {
    const f = fixture();
    const { client } = await f.snapshot();
    f.snapshot.mockClear();
    const at: BlockEvidence = {
      ...evidence,
      blockNumber: '457',
      blockHash: `0x${'ce'.repeat(32)}`,
    };
    const snapshotAt = vi.fn(() => ({ client, evidence: at }));
    const service = new PaymentService({ snapshot: f.snapshot, snapshotAt, client: () => client });
    const quote = await service.quotePay(payInput, at);
    expect(snapshotAt).toHaveBeenCalledWith(project.chainId, at);
    expect(f.snapshot).not.toHaveBeenCalled();
    expect(quote.evidence).toEqual([at]);
  });
  it('reads the project context and terminal together, keeps them for minutes, and drops them when the live preview disagrees', async () => {
    const f = fixture();
    const names = () => f.readContract.mock.calls.map(([request]) => request.functionName);
    await f.service.preparePay(payInput);
    const first = names();
    expect(first).toContain('controllerOf');
    expect(first).toContain('primaryTerminalOf');
    // The controller, the ruleset and the terminal go out together, ahead of any dependent read.
    expect(first.slice(0, 3).sort()).toEqual([
      'controllerOf',
      'currentRulesetOf',
      'primaryTerminalOf',
    ]);
    {
      const held = fixture();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = held.readContract.getMockImplementation()!;
      held.readContract.mockImplementation(async (request) => {
        if (request.functionName === 'controllerOf') await gate;
        return original(request);
      });
      const quoting = held.service.preparePay(payInput);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const issued = held.readContract.mock.calls.map(([request]) => request.functionName);
      expect(issued).toContain('currentRulesetOf');
      expect(issued).toContain('primaryTerminalOf');
      release();
      await quoting;
    }
    f.readContract.mockClear();
    const { client: snapshotClient } = await f.snapshot();
    f.snapshot.mockResolvedValueOnce({
      client: snapshotClient,
      evidence: { ...evidence, blockNumber: '101', blockHash: `0x${'22'.repeat(32)}` },
    } as never);
    const hit = await f.service.preparePay(payInput);
    // A second payment for the same project within the window only previews; the plan still
    // carries one evidence entry (the quote's block) and names the route's block beside it.
    expect(names()).toEqual(['previewPayFor']);
    expect(hit.evidence).toHaveLength(1);
    expect(
      (hit.summary as { routeEvidence: { blockHash: string } }).routeEvidence.blockHash,
    ).not.toBe(hit.evidence[0]!.blockHash);
    // A ruleset change on chain shows in the live preview; the context is read again.
    f.readContract.mockClear();
    const original = f.readContract.getMockImplementation()!;
    let flips = 1;
    f.readContract.mockImplementation(async (request) => {
      const value = await original(request);
      if (request.functionName === 'previewPayFor' && flips-- > 0)
        return [
          { ...((value as unknown[])[0] as object), id: 999n },
          ...(value as unknown[]).slice(1),
        ];
      return value;
    });
    await f.service.preparePay(payInput);
    expect(names().filter((name) => name === 'controllerOf')).toHaveLength(1);
    expect(names().filter((name) => name === 'previewPayFor')).toHaveLength(2);
    // A fresh read that still disagrees with the live preview is a real mismatch, not a retry.
    const g = fixture();
    g.readContract.mockImplementation(async (request) => {
      const value = await original(request);
      return request.functionName === 'previewPayFor'
        ? [{ ...((value as unknown[])[0] as object), id: 999n }, ...(value as unknown[]).slice(1)]
        : value;
    });
    await expect(g.service.preparePay(payInput)).rejects.toMatchObject({ code: 'INVALID_PREVIEW' });
    expect(
      g.readContract.mock.calls.filter(([request]) => request.functionName === 'previewPayFor'),
    ).toHaveLength(1);
    // Expired entries leave the map as new ones arrive.
    const h = fixture();
    await h.service.preparePay(payInput);
    (
      h.service as unknown as { recentProjects: Map<string, { at: number }> }
    ).recentProjects.forEach((entry) => {
      entry.at -= 1_801_000;
    });
    await h.service.preparePay({
      ...payInput,
      token: '0x000000000000000000000000000000000000dEaD',
    });
    expect(
      (h.service as unknown as { recentProjects: Map<string, unknown> }).recentProjects.size,
    ).toBe(1);
  });
  it('warms a route that is missing or past half its life, and leaves a young one alone', async () => {
    const f = fixture();
    const names = () => f.readContract.mock.calls.map(([request]) => request.functionName);
    expect(await f.service.warm(payInput.project, payInput.token)).toBe(true);
    expect(names()).toContain('controllerOf');
    expect(names()).not.toContain('previewPayFor');
    f.readContract.mockClear();
    expect(await f.service.warm(payInput.project, payInput.token)).toBe(false);
    expect(names()).toEqual([]);
    (
      f.service as unknown as { recentProjects: Map<string, { at: number }> }
    ).recentProjects.forEach((entry) => {
      entry.at -= 900_000;
    });
    expect(await f.service.warm(payInput.project, payInput.token)).toBe(true);
    expect(names()).toContain('controllerOf');
    // The next quote finds the route warm.
    f.readContract.mockClear();
    await f.service.preparePay(payInput);
    expect(names()).toEqual(['previewPayFor']);
  });
  it('answers from a route past half its life and reads it again behind the quote', async () => {
    const f = fixture();
    const names = () => f.readContract.mock.calls.map(([request]) => request.functionName);
    await f.service.preparePay(payInput);
    const routes = (f.service as unknown as { recentProjects: Map<string, { at: number }> })
      .recentProjects;
    routes.forEach((entry) => {
      entry.at -= 900_000;
    });
    f.readContract.mockClear();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.readContract.getMockImplementation()!;
    f.readContract.mockImplementation(async (request) => {
      if (request.functionName === 'controllerOf') await held;
      return original(request);
    });
    // The quote does not wait on the re-read; a second quote meanwhile does not start another.
    await f.service.preparePay(payInput);
    await f.service.preparePay(payInput);
    expect(names().filter((name) => name === 'previewPayFor')).toHaveLength(2);
    expect(names().filter((name) => name === 'controllerOf')).toHaveLength(1);
    const before = [...routes.values()][0]!.at;
    release();
    await vi.waitFor(() => expect([...routes.values()][0]!.at).toBeGreaterThan(before));
    f.readContract.mockClear();
    await f.service.preparePay(payInput);
    expect(names()).toEqual(['previewPayFor']);
  });
  it('preserves an invoice memo in exact payment bytes and rejects oversized UTF-8 text', async () => {
    const plan = await fixture().service.preparePay({ ...payInput, memo: 'beep:invoice-123' });
    const decoded = decodeFunctionData({ abi: jbMultiTerminalAbi, data: plan.calls[0]!.data });
    expect(decoded.args?.[5]).toBe('beep:invoice-123');
    await expect(
      fixture().service.preparePay({ ...payInput, memo: '🌈'.repeat(65) }),
    ).rejects.toThrow('256 UTF-8 bytes');
  });
  it('binds SDK previews to the caller and block evidence and encodes the exact floor', async () => {
    const { service, readContract, snapshot } = fixture();
    const plan = await service.preparePay(payInput);
    expect(snapshot).toHaveBeenCalledOnce();
    expect(plan.evidence).toEqual([evidence]);
    const preview = readContract.mock.calls.find(
      ([request]) => request.functionName === 'previewPayFor',
    )?.[0];
    expect(preview).toMatchObject({ account, args: [12n, NATIVE_TOKEN, 100n, beneficiary, '0x'] });
    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0]?.value).toBe('100');
    expect(
      decodeFunctionData({ abi: jbMultiTerminalAbi, data: plan.calls[0]!.data }),
    ).toMatchObject({
      functionName: 'pay',
      args: [12n, NATIVE_TOKEN, 100n, beneficiary, 99n, '', '0x'],
    });
    expect(plan.calls[0]?.decoded.args).toEqual([
      '12',
      NATIVE_TOKEN,
      '100',
      beneficiary,
      '99',
      '',
      '0x',
    ]);
  });

  it('requires positive ordinary payments even when a verified NFT hook is configured', async () => {
    const { service, snapshot } = fixture({ dataHook: custom, nftClone: custom });
    await expect(service.quotePay({ ...payInput, amount: '0' })).rejects.toMatchObject({
      code: 'INVALID_AMOUNT',
    });
    await expect(service.preparePay({ ...payInput, amount: '0' })).rejects.toMatchObject({
      code: 'INVALID_AMOUNT',
    });
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('prepares zero-value NFT calls only for the matching active verified hook without token approval', async () => {
    const { service, readContract } = fixture({
      dataHook: custom,
      nftClone: custom,
      beneficiaryCount: 0n,
      payHooks: [{ hook: custom, noop: false, amount: 0n, metadata: '0x' }],
      errorOn: 'allowance',
    });
    const input = { ...payInput, token, amount: '0' };
    const plan = await service.prepareNftPay(input, custom);
    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0]?.value).toBe('0');
    expect(
      decodeFunctionData({ abi: jbMultiTerminalAbi, data: plan.calls[0]!.data }),
    ).toMatchObject({
      functionName: 'pay',
      args: [12n, token, 0n, beneficiary, 0n, '', '0x'],
    });
    expect(readContract.mock.calls.some(([request]) => request.functionName === 'allowance')).toBe(
      false,
    );
    await expect(service.prepareNftPay(input, beneficiary)).rejects.toMatchObject({
      code: 'NFT_HOOK_NOT_INVOKED',
    });
    for (const payHooks of [
      [],
      [{ hook: custom, noop: true, amount: 0n, metadata: '0x' as const }],
    ])
      await expect(
        fixture({ dataHook: custom, nftClone: custom, payHooks }).service.prepareNftPay(
          input,
          custom,
        ),
      ).rejects.toMatchObject({ code: 'NFT_HOOK_NOT_INVOKED' });
    await expect(fixture().service.prepareNftPay(input, custom)).rejects.toMatchObject({
      code: 'NFT_HOOK_NOT_INVOKED',
    });
  });

  it('refuses a default minimum that protects nothing, takes an explicit zero, and never converts a failed preview to zero', async () => {
    const quote = await fixture({ beneficiaryCount: 0n }).service.quotePay(payInput);
    expect(quote).toMatchObject({ beneficiaryTokenCount: '0', minimumBeneficiaryTokenCount: '0' });
    expect(quote.warnings.join(' ')).toContain('protects nothing');
    await expect(
      fixture({ beneficiaryCount: 0n }).service.preparePay(payInput),
    ).rejects.toMatchObject({
      code: 'PAY_MINIMUM_PROTECTS_NOTHING',
      retryable: false,
      details: { beneficiaryTokenCount: '0', defaultMinimum: '0' },
    });
    // One base unit less 1% floors to zero; slippageFloor keeps it at 1, an enforceable minimum.
    const one = await fixture({ beneficiaryCount: 1n }).service.preparePay(payInput);
    expect(
      decodeFunctionData({ abi: jbMultiTerminalAbi, data: one.calls[0]!.data }).args?.[4],
    ).toBe(1n);
    expect(one.warnings.join(' ')).not.toContain('protects nothing');
    // The explicit zero-output choice.
    const zero = await fixture({ beneficiaryCount: 0n }).service.preparePay({
      ...payInput,
      minReturnedTokens: '0',
    });
    expect(
      decodeFunctionData({ abi: jbMultiTerminalAbi, data: zero.calls[0]!.data }).args?.[4],
    ).toBe(0n);
    expect(zero.summary).toMatchObject({ minimumBasis: 'explicit' });
    expect(zero.warnings.join(' ')).toContain('receives no project tokens');
    await expect(
      fixture({ errorOn: 'previewPayFor' }).service.preparePay(payInput),
    ).rejects.toThrow('RPC read unavailable');
  });

  it('uses integer arithmetic for huge values and retains a one-unit floor for dust', async () => {
    const huge = (1n << 240n) + 913n;
    const quote = await fixture({ beneficiaryCount: huge }).service.quotePay({
      ...payInput,
      slippageBps: 17,
    });
    expect(quote.minimumBeneficiaryTokenCount).toBe(((huge * 9983n) / 10000n).toString());
    expect(
      (await fixture({ beneficiaryCount: 1n }).service.quotePay(payInput))
        .minimumBeneficiaryTokenCount,
    ).toBe('1');
  });

  it('makes reset, exact approval, and payment dependencies explicit without fictitious simulation state', async () => {
    const { service, simulateContract, readContract } = fixture({ allowance: 9n });
    const plan = await service.preparePay({ ...payInput, token });
    // The allowance goes out beside the preview rather than after it.
    {
      const held = fixture({ allowance: 9n });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = held.readContract.getMockImplementation()!;
      held.readContract.mockImplementation(async (request) => {
        if (request.functionName === 'previewPayFor') await gate;
        return original(request);
      });
      const preparing = held.service.preparePay({ ...payInput, token });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(held.readContract.mock.calls.map(([request]) => request.functionName)).toContain(
        'allowance',
      );
      release();
      await preparing;
    }
    expect(plan.calls.map((item) => item.dependsOn)).toEqual([[], [0], [1]]);
    expect(plan.calls.map((item) => item.value)).toEqual(['0', '0', '0']);
    expect(decodeFunctionData({ abi: erc20Abi, data: plan.calls[0]!.data }).args).toEqual([
      getAddress(terminal),
      0n,
    ]);
    expect(decodeFunctionData({ abi: erc20Abi, data: plan.calls[1]!.data }).args).toEqual([
      getAddress(terminal),
      100n,
    ]);
    expect(simulateContract).not.toHaveBeenCalled();
    const sufficient = await fixture({ allowance: 100n }).service.preparePay({
      ...payInput,
      token,
    });
    expect(sufficient.calls).toHaveLength(1);
    const noAllowance = await fixture().service.preparePay({ ...payInput, token });
    expect(noAllowance.calls.map((item) => item.dependsOn)).toEqual([[], [0]]);
    await expect(
      fixture({ errorOn: 'allowance' }).service.preparePay({ ...payInput, token }),
    ).rejects.toThrow();
  });

  it('approves the directly called router registry and preserves exact caller metadata', async () => {
    const registryTerminal = v6Address('JBRouterTerminalRegistry', project.chainId);
    const { service, readContract } = fixture({ primaryTerminal: registryTerminal });
    const metadata = '0x1234' as const;
    const plan = await service.preparePay({ ...payInput, token, metadata });
    expect(plan.calls[1]?.to).toBe(registryTerminal);
    expect(decodeFunctionData({ abi: erc20Abi, data: plan.calls[0]!.data }).args).toEqual([
      getAddress(registryTerminal),
      100n,
    ]);
    expect(
      decodeFunctionData({ abi: jbMultiTerminalAbi, data: plan.calls[1]!.data }).args?.[6],
    ).toBe(metadata);
    expect(
      readContract.mock.calls.find(([request]) => request.functionName === 'previewPayFor')?.[0]
        .args?.[4],
    ).toBe(metadata);
  });

  it('resolves registry -> gateway -> router on an executed chain and approves the outer terminal', async () => {
    const chainId = 84532;
    const registryTerminal = v6Address('JBRouterTerminalRegistry', chainId);
    const gateway = deploymentAddress('JBRouterTerminalGateway', chainId)!;
    const router = deploymentAddress('JBRouterTerminal', chainId)!;
    const input: PayInput = { ...payInput, project: { ...project, chainId }, token };
    const { service, readContract } = fixture({
      primaryTerminal: registryTerminal,
      routerTarget: gateway,
      gatewayRouter: router,
    });
    const plan = await service.preparePay(input);
    expect(plan.summary).toMatchObject({
      terminalPath: [registryTerminal, gateway, router],
      routerGateway: gateway,
    });
    expect(plan.calls.at(-1)?.to).toBe(registryTerminal);
    expect(decodeFunctionData({ abi: erc20Abi, data: plan.calls[0]!.data }).args).toEqual([
      getAddress(registryTerminal),
      100n,
    ]);
    expect(
      readContract.mock.calls.some(
        ([request]) => request.address === gateway && request.functionName === 'ROUTER',
      ),
    ).toBe(true);
    expect(plan.warnings.join(' ')).toContain('pending, not paid or forgiven');
    await expect(
      fixture({
        primaryTerminal: registryTerminal,
        routerTarget: gateway,
        gatewayRouter: custom,
      }).service.preparePay(input),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_ROUTER_GATEWAY' });
    await expect(
      fixture({
        primaryTerminal: registryTerminal,
        routerTarget: gateway,
        gatewayRouter: router,
        errorOn: 'ROUTER',
      }).service.preparePay(input),
    ).rejects.toThrow('RPC read unavailable');
  });

  it('reads buyback beneficiary output rather than treating zero terminal issuance or raw diagnostics as settlement', async () => {
    const { service } = fixture({
      dataHook: registry,
      beneficiaryCount: 0n,
      reservedCount: 0n,
      payHooks: [{ hook: buybackHook, noop: false, amount: 100n, metadata: payHookMetadata() }],
    });
    const plan = await service.preparePay(ownPayInput);
    expect(plan.summary).toMatchObject({
      quoteBasis: 'buyback-hook-indicative-output',
      beneficiaryTokenCount: '250',
      minimumBeneficiaryTokenCount: '247',
      // The terminal's own counts, never the SDK previewPay's fold of the hook spec.
      rawTerminalPreview: {
        semantics: 'issuance',
        beneficiaryTokenCount: '0',
        reservedTokenCount: '0',
      },
      buybackHook: { address: buybackHook, version: '1.4', status: 'current' },
      tokenCounts: {
        beneficiaryTokenCount: expect.stringMatching(
          /^A conditional swap figure: the payer's share of the buyback hook's TWAP-derived.*partial fill mints the unswapped remainder/,
        ),
        rawTerminalPreview: expect.stringContaining('The minimum does not use it.'),
        simulation: expect.stringContaining('pool spot price'),
      },
    });
    expect(
      decodeFunctionData({ abi: jbMultiTerminalAbi, data: plan.calls[0]!.data }).args?.[4],
    ).toBe(247n);
    expect(plan.warnings.join(' ')).toContain(
      'Buyback 1.4 unwinds a swap that misses its pro-rated TWAP floor and the whole payment falls back to issuance',
    );
    expect(plan.warnings.join(' ')).not.toContain('only a total swap failure');
    const plain = (await fixture().service.quotePay(ownPayInput)) as Record<string, unknown>;
    expect(plain.buybackHook).toBeUndefined();
    expect(plain.tokenCounts).toMatchObject({
      beneficiaryTokenCount: expect.stringContaining("terminal's issuance preview"),
    });
  });

  it('simulates the buyback fill at the quote block, and only on that route', async () => {
    const buyback = fixture({
      dataHook: registry,
      beneficiaryCount: 0n,
      payHooks: [{ hook: buybackHook, noop: false, amount: 100n, metadata: payHookMetadata() }],
    });
    const quote = (await buyback.service.quotePay(ownPayInput)) as Record<string, unknown>;
    expect(quote).toMatchObject({
      minimumBeneficiaryTokenCount: '247',
      minimumBasis: 'slippage',
      simulatedBeneficiaryTokenCount: { status: 'known', value: '600' },
      tokenCounts: {
        minimumBeneficiaryTokenCount: expect.stringContaining('share after the reserved split'),
        simulatedBeneficiaryTokenCount: expect.stringContaining('less N%'),
      },
    });
    const simulated = buyback.simulateContract.mock.calls[0]![0] as Request & {
      args: readonly unknown[];
      value: bigint;
    };
    expect(simulated).toMatchObject({
      functionName: 'pay',
      account,
      blockNumber: 123n,
      value: 100n,
    });
    expect(simulated.args[4]).toBe(0n);

    const plain = fixture();
    const issuance = (await plain.service.quotePay(ownPayInput)) as Record<string, unknown>;
    expect(issuance.simulatedBeneficiaryTokenCount).toBeUndefined();
    expect(plain.simulateContract).not.toHaveBeenCalled();
  });

  it('encodes an explicit minReturnedTokens and warns when it is above the fill or below the default', async () => {
    const buyback = (payFill?: bigint | Error) =>
      fixture({
        dataHook: registry,
        beneficiaryCount: 0n,
        payHooks: [{ hook: buybackHook, noop: false, amount: 100n, metadata: payHookMetadata() }],
        payFill,
      });
    const minimumOf = (plan: { calls: { data: Hex }[] }) =>
      decodeFunctionData({ abi: jbMultiTerminalAbi, data: plan.calls[0]!.data }).args?.[4];

    const within = await buyback().service.preparePay({
      ...ownPayInput,
      minReturnedTokens: '588',
    });
    expect(minimumOf(within)).toBe(588n);
    expect(within.summary).toMatchObject({
      minimumBeneficiaryTokenCount: '588',
      minimumBasis: 'explicit',
      tokenCounts: {
        minimumBeneficiaryTokenCount: expect.stringContaining('slippageBps does not change it'),
      },
    });
    expect(within.warnings.join(' ')).not.toContain('minReturnedTokens');

    const above = await buyback().service.preparePay({
      ...ownPayInput,
      minReturnedTokens: '601',
    });
    expect(minimumOf(above)).toBe(601n);
    expect(above.warnings.join(' ')).toContain('above the simulated fill of 600');

    const below = await buyback().service.preparePay({
      ...ownPayInput,
      minReturnedTokens: '100',
    });
    expect(below.warnings.join(' ')).toContain('below the default minimum of 247');

    const blind = await buyback(new Error('insufficient funds')).service.preparePay({
      ...ownPayInput,
      minReturnedTokens: '588',
    });
    expect(blind.summary).toMatchObject({ simulatedBeneficiaryTokenCount: { status: 'unknown' } });
    expect(blind.warnings.join(' ')).toContain('not checked against a fill');

    const none = await buyback().service.preparePay({ ...ownPayInput, minReturnedTokens: '0' });
    expect(minimumOf(none)).toBe(0n);
    expect(none.warnings.join(' ')).toContain('receives no project tokens');
    await expect(
      buyback().service.preparePay({ ...ownPayInput, minReturnedTokens: '-1' }),
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
  });

  it('supports the recorded 1.1.1 hook without accepting another generation or a partial buyback', async () => {
    const legacy = '0x77bee1ad2ac0ace98a9b5b58d75685c8b4d94948' as Address;
    const metadata = payHookMetadata().slice(0, 2 + 15 * 64) as Hex;
    const legacyFixture = (
      hookMetadata = metadata,
      hook = legacy,
      more: Parameters<typeof fixture>[0] = {},
    ) =>
      fixture({
        dataHook: registry,
        resolvedBuyback: hook,
        beneficiaryCount: 0n,
        payHooks: [{ hook, noop: false, amount: 100n, metadata: hookMetadata }],
        ...more,
      });
    // Through the registry the SDK's prepareUserPay sets the minimum on 1.1.1 too: the payer's share
    // of the 200-token mint under the ruleset's 16.67% reserved percent (166), less 2 for rounding,
    // less 1%. Its quote entry is the one the apps send; 1.1.1 reads two words of it and has no skip.
    const legacyPay = legacyFixture();
    const plan = await legacyPay.service.preparePay({ ...payInput, memo: 'beep:demo' });
    const sdk = await prepareUserPay(legacyPay.client, {
      chainId: project.chainId,
      terminal,
      projectId: BigInt(project.projectId),
      token: NATIVE_TOKEN,
      amount: 100n,
      beneficiary,
    });
    expect(sdk.minReturnedTokens).toBe(162n);
    expect(plan.summary).toMatchObject({
      beneficiaryTokenCount: sdk.preview.beneficiaryTokenCount.toString(),
      minimumBeneficiaryTokenCount: '162',
      minimumBasis: 'prepareUserPay',
      skipSplits: {
        requested: null,
        sent: false,
        applied: false,
        reason: expect.stringContaining('1.1.1'),
      },
    });
    expect(
      decodeFunctionData({ abi: jbMultiTerminalAbi, data: plan.calls[0]!.data }).args?.slice(4),
    ).toEqual([162n, 'beep:demo', sdk.metadata]);
    // With a pool quote, 1.1.1 gets the same treatment as 1.4: the hook must buy the floored quote
    // (396), and the payer's minimum is their 83.33% share of it (329), not the mint share.
    const legacyQuoted = fixture({
      dataHook: registry,
      resolvedBuyback: legacy,
      beneficiaryCount: 0n,
      reservedCount: 0n,
      poolQuote: 400n,
      payHooks: (sent) => {
        const { minimum } = sentQuote(sent);
        return [
          {
            hook: legacy,
            noop: false,
            amount: 100n,
            metadata: payHookMetadata(minimum ? { minimum, callerMinimum: true } : {}).slice(
              0,
              2 + 15 * 64,
            ) as Hex,
          },
        ];
      },
    });
    expect(await legacyQuoted.service.quotePay(payInput)).toMatchObject({
      minimumBeneficiaryTokenCount: '329',
      hookMinimumSwapAmountOut: '396',
      minimumBasis: 'prepareUserPay',
      buybackHook: { version: '1.1.1' },
    });
    // Codex's 1.1.1 registry-router fallback: a 170-token fill clears the SDK minimum, where the
    // conditional oracle figure less slippage (247) refused it.
    const routed = await legacyFixture(metadata, legacy, {
      primaryTerminal: v6Address('JBRouterTerminalRegistry', project.chainId),
      payFill: 170n,
    }).service.preparePay(payInput);
    expect(routed.summary).toMatchObject({
      route: 'router-terminal',
      minimumBeneficiaryTokenCount: '162',
      minimumBasis: 'prepareUserPay',
      simulatedBeneficiaryTokenCount: { status: 'known', value: '170' },
    });
    const legacyText = plan.warnings.join(' ');
    expect(legacyText).toContain(
      'Buyback 1.1.1 checks its oracle-derived minimum against the swap plus any leftover mint and reverts below it; only a total swap failure falls back to issuance.',
    );
    expect(legacyText).not.toContain('unwinds');
    expect(legacyText).not.toContain('TWAP floor');
    expect((plan.summary as { tokenCounts: Record<string, string> }).tokenCounts).toMatchObject({
      beneficiaryTokenCount: expect.stringContaining("prepareUserPay's preview"),
      minimumBeneficiaryTokenCount: expect.stringContaining(
        'oracle-derived minimum is a separate check on the swap plus leftover mint',
      ),
    });
    // A caller's raw minimum on 1.1.1 holds even after a total swap failure.
    const callerLegacy = (await legacyFixture(
      payHookMetadata({ minimum: 280n, callerMinimum: true }).slice(0, 2 + 15 * 64) as Hex,
    ).service.quotePay({ ...payInput, metadata: '0x1234' })) as {
      warnings: string[];
      tokenCounts: Record<string, string>;
    };
    expect(callerLegacy.warnings.join(' ')).toContain(
      "Buyback 1.1.1 checks the caller's minimumSwapAmountOut 280 against the swap plus any leftover mint and reverts below it, even after a total swap failure",
    );
    expect(callerLegacy.tokenCounts.beneficiaryTokenCount).toContain(
      "caller's own settlement minimum (minimumSwapAmountOut 280)",
    );
    expect(plan.summary).toMatchObject({ buybackHook: { address: legacy, version: '1.1.1' } });
    await expect(
      legacyFixture(metadata, buybackHook).service.preparePay(payInput),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONFIGURATION' });
    await expect(
      legacyFixture(payHookMetadata()).service.preparePay(payInput),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONFIGURATION' });
    await expect(
      legacyFixture(
        payHookMetadata({ partialMint: 1n }).slice(0, 2 + 15 * 64) as Hex,
      ).service.preparePay(payInput),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONFIGURATION' });
  });

  it('does not add buyback output twice when router previews have already normalized it', async () => {
    const { service } = fixture({
      dataHook: registry,
      beneficiaryCount: 832n,
      primaryTerminal: v6Address('JBRouterTerminalRegistry', project.chainId),
      payHooks: [{ hook: buybackHook, noop: false, amount: 100n, metadata: payHookMetadata() }],
    });
    // Honoring the split, prepareUserPay keeps the router's count once and requires the payer's
    // split mint entitlement, the same minimum as the default here (the pool is not quoted).
    expect(await service.quotePay(splitPayInput)).toMatchObject({
      beneficiaryTokenCount: '832',
      minimumBeneficiaryTokenCount: '162',
      minimumBasis: 'prepareUserPay',
      metadata: buildUserPayMetadata({ chainId: project.chainId, skipSplits: false }),
      rawTerminalPreview: { semantics: 'router-normalized', beneficiaryTokenCount: '832' },
    });
    // By default prepareUserPay keeps the router's count once and requires only the payer's mint
    // entitlement: 200 split by the hook's 16.67% reserved percent, less 2 for rounding, less 1%.
    expect(await service.quotePay(payInput)).toMatchObject({
      beneficiaryTokenCount: '832',
      reservedTokenCount: '10',
      minimumBeneficiaryTokenCount: '162',
      minimumBasis: 'prepareUserPay',
      rawTerminalPreview: { semantics: 'router-normalized', beneficiaryTokenCount: '832' },
    });
  });

  it("refuses the SDK's unreadable-spec case with its own text, and never forwards a revert's", async () => {
    // The SDK's own refusal: buyback 1.4 returns a spec of a length no generation uses.
    await expect(
      fixture({
        dataHook: registry,
        beneficiaryCount: 0n,
        payHooks: [
          {
            hook: buybackHook,
            noop: false,
            amount: 100n,
            metadata: payHookMetadata().slice(0, 2 + 16 * 64) as Hex,
          },
        ],
      }).service.preparePay(payInput),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONFIGURATION',
      message: expect.stringContaining('cannot read'),
    });
    // A node's revert carrying the same words, as RpcPool and viem deliver it to prepareUserPay.
    const reason = encodeErrorResult({
      abi: [{ type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] }],
      errorName: 'Error',
      args: ['unknown specification https://rpc.invalid/secret'],
    });
    const node = new RpcPool({ 8453: 'https://rpc.invalid/secret' }, async (_url, options) => ({
      jsonrpc: '2.0',
      id: (options!.body as { id: number }).id,
      error: { code: 3, message: 'execution reverted: unknown specification', data: reason },
    }));
    const revert = await node
      .client(8453)
      .readContract({
        address: terminal,
        abi: jbMultiTerminalAbi,
        functionName: 'previewPayFor',
        args: [12n, NATIVE_TOKEN, 100n, beneficiary, '0x'],
      })
      .catch((error: unknown) => error);
    expect((revert as Error).message).toContain('unknown specification');
    const caught = await fixture({
      dataHook: registry,
      errorOn: 'previewPayFor',
      errorValue: revert,
    })
      .service.preparePay(payInput)
      .catch((error: unknown) => error);
    expect(caught).not.toBeInstanceOf(DomainError);
    const shown = publicError(caught);
    expect(shown).toMatchObject({ code: 'CALL_REVERTED', details: { errorName: 'Error' } });
    expect(JSON.stringify(shown)).not.toMatch(/secret|unknown specification/);
  });

  it('refuses custom controllers, unknown active hooks, and historical buyback formats', async () => {
    await expect(
      fixture({ customController: custom }).service.preparePay(payInput),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONFIGURATION' });
    await expect(fixture({ dataHook: custom }).service.preparePay(payInput)).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONFIGURATION',
    });
    await expect(
      fixture({ dataHook: registry, resolvedBuyback: custom }).service.preparePay(payInput),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONFIGURATION' });
  });

  it("defaults skipSplits on for buyback 1.4 and takes metadata, counts and minimum from the SDK's prepareUserPay", async () => {
    // The pool quotes 400 for the payment; less 1% that is 396, above the 200-token mint entitlement.
    const quoted = (options: Parameters<typeof fixture>[0] = {}) =>
      fixture({
        dataHook: registry,
        // A swapping hook takes the whole payment: the terminal itself issues nothing.
        beneficiaryCount: 0n,
        reservedCount: 0n,
        payHooks: buyback14(),
        poolQuote: 400n,
        payFill: (sent) => (sentQuote(sent).skip ? 400n : 101n),
        ...options,
      });
    const direct = quoted();
    const plan = await direct.service.preparePay(payInput);
    const sdk = await prepareUserPay(direct.client, {
      chainId: project.chainId,
      terminal,
      projectId: BigInt(project.projectId),
      token: NATIVE_TOKEN,
      amount: 100n,
      beneficiary,
    });
    // The SDK's successful pool-quote branch: the floored quote is both minima.
    expect(sdk).toEqual({
      metadata: buildUserPayMetadata({ chainId: project.chainId, minimumSwapAmountOut: 396n }),
      preview: { beneficiaryTokenCount: 400n, reservedTokenCount: 0n },
      minReturnedTokens: 396n,
    });
    const payArgs = decodeFunctionData({
      abi: jbMultiTerminalAbi,
      data: plan.calls[0]!.data,
    }).args!;
    expect(payArgs[6]).toBe(sdk.metadata);
    expect(payArgs[4]).toBe(396n);
    expect(direct.simulateContract.mock.calls[0]![0]).toMatchObject({
      args: expect.arrayContaining([sdk.metadata]),
    });
    expect(plan.summary).toMatchObject({
      beneficiaryTokenCount: '400',
      reservedTokenCount: '0',
      minimumBeneficiaryTokenCount: '396',
      hookMinimumSwapAmountOut: '396',
      minimumBasis: 'prepareUserPay',
      metadata: sdk.metadata,
      skipSplits: {
        requested: null,
        sent: true,
        applied: true,
        reason: expect.stringContaining('On by default'),
      },
      buybackHook: { address: buybackHook, version: '1.4', skipSplits: true },
      tokenCounts: {
        minimumBeneficiaryTokenCount: expect.stringContaining(
          "The hook separately requires prepareUserPay's minimumSwapAmountOut 396",
        ),
      },
    });
    expect(plan.warnings.join(' ')).toContain('Nothing is issued for that part');
    // Summaries are JSON data (the Center's payment recognizer refuses undefined values).
    expect(JSON.parse(JSON.stringify(plan.summary))).toStrictEqual(plan.summary);
    const unset = (await fixture().service.preparePay(payInput)).summary;
    expect(JSON.parse(JSON.stringify(unset))).toStrictEqual(unset);
    // Asking for it explicitly is the same payment.
    const asked = await quoted().service.preparePay({ ...payInput, skipSplits: true });
    expect(asked.calls[0]!.data).toBe(plan.calls[0]!.data);

    // The router registry forwards the same bytes to the destination terminal.
    const registryTerminal = v6Address('JBRouterTerminalRegistry', project.chainId);
    const routedPlan = await quoted({
      primaryTerminal: registryTerminal,
      beneficiaryCount: 832n,
    }).service.preparePay(payInput);
    expect(routedPlan.calls[0]?.to).toBe(registryTerminal);
    expect(
      decodeFunctionData({ abi: jbMultiTerminalAbi, data: routedPlan.calls[0]!.data }).args?.[6],
    ).toBe(sdk.metadata);
    expect(routedPlan.summary).toMatchObject({
      skipSplits: { applied: true },
      rawTerminalPreview: { semantics: 'router-normalized' },
    });

    // skipSplits false honors the split through prepareUserPay's own option. The pool is still
    // quoted: the hook must buy at least the floored quote (396), and the payer's minimum is their
    // share of it after the 16.67% split (329), not the mint share.
    const split = quoted();
    const splitSdk = await prepareUserPay(split.client, {
      chainId: project.chainId,
      terminal,
      projectId: BigInt(project.projectId),
      token: NATIVE_TOKEN,
      amount: 100n,
      beneficiary,
      skipSplits: false,
    });
    expect(splitSdk.metadata).toBe(
      buildUserPayMetadata({
        chainId: project.chainId,
        skipSplits: false,
        minimumSwapAmountOut: 396n,
      }),
    );
    expect(splitSdk.minReturnedTokens).toBe(329n);
    expect(sentQuote(splitSdk.metadata).skip).toBe(false);
    expect(await split.service.quotePay(splitPayInput)).toMatchObject({
      metadata: splitSdk.metadata,
      beneficiaryTokenCount: splitSdk.preview.beneficiaryTokenCount.toString(),
      minimumBeneficiaryTokenCount: '329',
      hookMinimumSwapAmountOut: '396',
      minimumBasis: 'prepareUserPay',
      skipSplits: {
        requested: false,
        sent: false,
        applied: false,
        reason: expect.stringContaining('honors'),
      },
      buybackHook: { skipSplits: false },
    });
    // Sent, but the hook takes the issuance route at this block: applied reads the hook's spec.
    const issuance = await quoted({ payHooks: buyback14({ skipSplits: false }) }).service.quotePay(
      payInput,
    );
    expect(issuance).toMatchObject({
      skipSplits: { sent: true, applied: false, reason: expect.stringContaining('issuance route') },
    });
    expect(issuance.warnings.join(' ')).toContain('skipSplits has no effect at this block');
    // Unset falls back to off where skipping cannot apply, and says why.
    expect(await fixture().service.quotePay(payInput)).toMatchObject({
      metadata: '0x',
      skipSplits: { applied: false, reason: expect.stringContaining('no buyback hook') },
    });
    expect(await quoted().service.quotePay({ ...payInput, metadata: '0x1234' })).toMatchObject({
      metadata: '0x1234',
      skipSplits: { applied: false, reason: expect.stringContaining('own metadata') },
    });
  });

  it('keys the quote to buyback 1.4 when the ruleset calls it directly, alone or behind the omnichain deployer', async () => {
    const keyed = (skipSplits: boolean, tiers?: UserPayTiers) =>
      buildUserPayMetadata({
        chainId: project.chainId,
        hook: buybackHook,
        skipSplits,
        ...(tiers ? { tiers } : {}),
      });
    const hookId = hookMetadataId(buybackHook, 'pay').slice(2).toLowerCase();
    // The hook reads only an entry keyed to itself; without one it mints through the split.
    const direct = (options: Parameters<typeof fixture>[0]) =>
      fixture({
        ...options,
        beneficiaryCount: 0n,
        payHooks: (sent) => buyback14()(sent.toLowerCase().includes(hookId) ? sent : '0x'),
        payFill: (sent) =>
          sent.toLowerCase().includes(hookId) && sentQuote(sent).skip ? 300n : 166n,
      });
    for (const options of [
      { dataHook: buybackHook },
      { dataHook: omni, extraDataHook: buybackHook },
    ]) {
      const f = direct(options);
      const plan = await f.service.preparePay(payInput);
      expect(
        decodeFunctionData({ abi: jbMultiTerminalAbi, data: plan.calls[0]!.data }).args?.[6],
      ).toBe(keyed(true));
      // prepareUserPay's minimum with no pool quote: the payer's 166-token share of the 200-token
      // mint, which the skipping hook reports, less 2, less 1%.
      expect(plan.summary).toMatchObject({
        skipSplits: { sent: true, applied: true },
        buybackHook: { address: buybackHook, skipSplits: true },
        minimumBasis: 'prepareUserPay',
        minimumBeneficiaryTokenCount: '162',
      });
      // No registry on this route: its hookOf is never read.
      expect(f.readContract.mock.calls.some(([r]) => r.functionName === 'hookOf')).toBe(false);
      // Honoring the split keys a false entry to the hook.
      const split = await direct(options).service.preparePay(splitPayInput);
      expect(
        decodeFunctionData({ abi: jbMultiTerminalAbi, data: split.calls[0]!.data }).args?.[6],
      ).toBe(keyed(false));
      expect(split.summary).toMatchObject({
        skipSplits: { sent: false, applied: false },
        minimumBasis: 'prepareUserPay',
        minimumBeneficiaryTokenCount: '162',
      });
    }
    // NFT tiers compose with the hook-keyed skip entry.
    const tiers = {
      metadataIdTarget: nftImplementation,
      tierIdsToMint: [1n],
      allowOverspending: false,
    };
    const tiered = await direct({ dataHook: buybackHook }).service.quotePay({ ...payInput, tiers });
    expect(tiered).toMatchObject({
      metadata: keyed(true, tiers),
      skipSplits: { sent: true, applied: true },
    });
  });

  it('says why the fill simulation reverts and how to retry', async () => {
    const hookMiss = encodeErrorResult({
      abi: [
        {
          type: 'error',
          name: 'JBBuybackHook_SpecifiedSlippageExceeded',
          inputs: [
            { name: 'amount', type: 'uint256' },
            { name: 'minimum', type: 'uint256' },
          ],
        },
      ],
      errorName: 'JBBuybackHook_SpecifiedSlippageExceeded',
      args: [380n, 396n],
    });
    const quote = (await fixture({
      dataHook: registry,
      beneficiaryCount: 0n,
      reservedCount: 0n,
      payHooks: buyback14(),
      poolQuote: 400n,
      payFill: new CallExecutionError(
        new RpcRequestError({
          body: {},
          error: { code: 3, message: 'execution reverted', data: hookMiss },
          url: 'https://rpc.invalid/secret-key',
        }),
        {},
      ),
    }).service.quotePay(payInput)) as { warnings: string[] } & Record<string, unknown>;
    expect(quote.simulatedBeneficiaryTokenCount).toMatchObject({
      status: 'unknown',
      error: {
        code: 'CALL_REVERTED',
        payFailure: { reason: 'BUYBACK_SLIPPAGE_EXCEEDED', received: '380', minimum: '396' },
      },
    });
    expect(quote.warnings.join(' ')).toContain('BUYBACK_SLIPPAGE_EXCEEDED');
    expect(quote.warnings.join(' ')).toContain('higher slippageBps');
    expect(JSON.stringify(quote)).not.toContain('secret-key');
  });

  it("keeps the hook's minimum when minReturnedTokens is lowered, and says so", async () => {
    const quoted = () =>
      fixture({
        dataHook: registry,
        beneficiaryCount: 0n,
        payHooks: buyback14(),
        poolQuote: 400n,
        payFill: 400n,
      });
    const hookEntry = buildUserPayMetadata({
      chainId: project.chainId,
      minimumSwapAmountOut: 396n,
    });
    const zero = await quoted().service.preparePay({ ...payInput, minReturnedTokens: '0' });
    const args = decodeFunctionData({ abi: jbMultiTerminalAbi, data: zero.calls[0]!.data }).args!;
    expect([args[4], args[6]]).toEqual([0n, hookEntry]);
    expect(zero.summary).toMatchObject({
      minimumBeneficiaryTokenCount: '0',
      hookMinimumSwapAmountOut: '396',
      minimumBasis: 'explicit',
      tokenCounts: {
        minimumBeneficiaryTokenCount: expect.stringContaining(
          "slippageBps still sets the hook's minimumSwapAmountOut 396, which stays in force",
        ),
      },
    });
    const text = zero.warnings.join(' ');
    expect(text).toContain("minReturnedTokens 0 turns off only the terminal's check.");
    expect(text).toContain(
      "prepareUserPay's minimumSwapAmountOut 396 (the pool quote less slippageBps)",
    );
    expect(text).not.toContain('receives no project tokens');
    const lower = await quoted().service.preparePay({ ...payInput, minReturnedTokens: '300' });
    expect(lower.warnings.join(' ')).toContain('below the default minimum of 396 (');
    expect(lower.warnings.join(' ')).toContain(
      'so the terminal checks less. The hook still reverts',
    );
  });

  it('refuses skipSplits it cannot carry with named non-retryable errors, and says when it has no effect', async () => {
    const refusal = (code: string) => ({ code, retryable: false });
    await expect(
      fixture({ dataHook: registry }).service.quotePay({
        ...payInput,
        skipSplits: true,
        metadata: '0x1234',
      }),
    ).rejects.toMatchObject(refusal('SKIP_SPLITS_WITH_METADATA'));
    await expect(
      fixture().service.quotePay({ ...payInput, skipSplits: true }),
    ).rejects.toMatchObject(refusal('SKIP_SPLITS_WITHOUT_BUYBACK'));
    await expect(
      fixture({ dataHook: registry, resolvedBuyback: zeroAddress }).service.quotePay({
        ...payInput,
        skipSplits: true,
      }),
    ).rejects.toMatchObject(refusal('SKIP_SPLITS_WITHOUT_BUYBACK'));
    await expect(
      fixture({
        dataHook: registry,
        resolvedBuyback: '0x77bee1ad2ac0ace98a9b5b58d75685c8b4d94948',
      }).service.quotePay({ ...payInput, skipSplits: true }),
    ).rejects.toMatchObject(refusal('SKIP_SPLITS_UNSUPPORTED_BUYBACK'));
    const issuance = (await fixture({
      dataHook: registry,
      payHooks: [{ hook: buybackHook, noop: true, amount: 0n, metadata: payHookMetadata() }],
    }).service.quotePay({ ...payInput, skipSplits: true })) as { warnings: string[] };
    expect(issuance).toMatchObject({ beneficiaryTokenCount: '101', reservedTokenCount: '10' });
    expect(issuance.warnings.join(' ')).toContain('skipSplits has no effect at this block');
  });

  it('refuses skipSplits on buyback 1.0 and anything not recognized as 1.4, even when the preview would not invoke it', async () => {
    const v1 = '0xc7c8334b09e43a38c20b43cf0f824e074280b566' as Address;
    for (const payHooks of [[], [{ hook: v1, noop: true, amount: 0n, metadata: '0x' as Hex }]]) {
      const f = fixture({ dataHook: registry, resolvedBuyback: v1, payHooks });
      await expect(f.service.preparePay({ ...payInput, skipSplits: true })).rejects.toMatchObject({
        code: 'SKIP_SPLITS_UNSUPPORTED_BUYBACK',
        retryable: false,
        details: { buybackHook: v1, version: '1.0' },
      });
      expect(
        f.readContract.mock.calls.some(([request]) => request.functionName === 'previewPayFor'),
      ).toBe(false);
      // Without skipSplits a passing 1.0 hook still pays by issuance.
      expect(
        (await fixture({ dataHook: registry, resolvedBuyback: v1, payHooks }).service.quotePay(
          payInput,
        )) as Record<string, unknown>,
      ).toMatchObject({ beneficiaryTokenCount: '101', quoteBasis: 'terminal-issuance-preview' });
    }
    // An active 1.0 spec in the 1.4 shape is not decoded as 1.4.
    await expect(
      fixture({
        dataHook: registry,
        resolvedBuyback: v1,
        payHooks: [{ hook: v1, noop: false, amount: 100n, metadata: payHookMetadata() }],
      }).service.quotePay(payInput),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONFIGURATION' });
    // The pinned 1.4 address is the rollout catalog's only current buyback hook.
    const current = rollout.contracts.JBBuybackHook!.deployments.filter(
      (item) => item.generation === 'current',
    );
    expect(current.length).toBeGreaterThan(0);
    expect(new Set(current.map((item) => item.address.toLowerCase()))).toEqual(
      new Set([buybackHook.toLowerCase()]),
    );
  });

  it('refuses a default minimum the simulated fill misses: partial skip fills and issuance fallbacks', async () => {
    const skipEntry = (minimum: bigint) =>
      createHookMetadata(
        [hookMetadataId(buybackHook, 'pay')],
        [encodeAbiParameters(parseAbiParameters('uint256,uint256,bool'), [0n, minimum, true])],
      );
    // By default (skip on), a fill below prepareUserPay's minimum is refused with the fill as the
    // suggested floor. With no pool quote that minimum is the payer's 166-token share of the
    // 200-token mint less 2 for rounding, less 1%: 162. A partial swap plus split issuance fills 150.
    const partial = (fill: bigint) =>
      fixture({
        dataHook: registry,
        beneficiaryCount: 0n,
        payHooks: buyback14(),
        payFill: (sent) => (sentQuote(sent).skip ? fill : 101n),
      });
    const quote = (await partial(150n).service.quotePay(payInput)) as {
      warnings: string[];
    } & Record<string, unknown>;
    expect(quote).toMatchObject({
      minimumBeneficiaryTokenCount: '162',
      minimumBasis: 'prepareUserPay',
      simulatedBeneficiaryTokenCount: { status: 'known', value: '150' },
      skipSplits: { applied: true },
    });
    expect(quote.warnings.join(' ')).toContain('above the simulated fill of 150');
    await expect(partial(150n).service.preparePay(payInput)).rejects.toMatchObject({
      code: 'PAY_DEFAULT_MINIMUM_ABOVE_FILL',
      retryable: false,
      details: { defaultMinimum: '162', simulatedFill: '150', suggestedMinReturnedTokens: '148' },
    });
    const reviewed = await partial(150n).service.preparePay({
      ...payInput,
      minReturnedTokens: '148',
    });
    expect(
      decodeFunctionData({ abi: jbMultiTerminalAbi, data: reviewed.calls[0]!.data }).args?.[4],
    ).toBe(148n);
    // A fill at the SDK minimum prepares with it.
    expect((await partial(162n).service.preparePay(payInput)).summary).toMatchObject({
      minimumBeneficiaryTokenCount: '162',
    });

    // Honoring the split, prepareUserPay's minimum is the payer's split mint entitlement (162). A
    // missed TWAP floor that falls back to issuance fills only the 101 issuance share.
    await expect(
      fixture({
        dataHook: registry,
        beneficiaryCount: 0n,
        payHooks: buyback14(),
        payFill: 101n,
      }).service.preparePay(splitPayInput),
    ).rejects.toMatchObject({
      code: 'PAY_DEFAULT_MINIMUM_ABOVE_FILL',
      details: { defaultMinimum: '162', simulatedFill: '101', suggestedMinReturnedTokens: '99' },
    });
    // A fill at the minimum prepares.
    const filled = fixture({
      dataHook: registry,
      beneficiaryCount: 0n,
      payHooks: buyback14(),
      payFill: 162n,
    });
    expect((await filled.service.preparePay(splitPayInput)).summary).toMatchObject({
      minimumBeneficiaryTokenCount: '162',
    });

    // Raw metadata with a nonzero minimumSwapAmountOut: the caller's settlement minimum, not TWAP.
    const raw = skipEntry(280n);
    const explicit = (await fixture({
      dataHook: registry,
      beneficiaryCount: 0n,
      payHooks: (sent) => [
        {
          hook: buybackHook,
          noop: false,
          amount: 100n,
          metadata:
            sent === raw
              ? payHookMetadata({ skipSplits: true, minimum: 280n, callerMinimum: true })
              : payHookMetadata(),
        },
      ],
      payFill: 290n,
    }).service.quotePay({ ...payInput, metadata: raw })) as {
      warnings: string[];
      tokenCounts: Record<string, string>;
    } & Record<string, unknown>;
    expect(explicit).toMatchObject({
      beneficiaryTokenCount: '280',
      reservedTokenCount: '0',
      minimumBeneficiaryTokenCount: '277',
    });
    expect(explicit.tokenCounts.beneficiaryTokenCount).toContain(
      "caller's own settlement minimum (minimumSwapAmountOut 280)",
    );
    expect(explicit.tokenCounts.beneficiaryTokenCount).not.toContain('TWAP-derived');
    expect(explicit.tokenCounts.minimumBeneficiaryTokenCount).toContain('no TWAP floor applies');
    const text = explicit.warnings.join(' ');
    expect(text).toContain("caller's metadata sets minimumSwapAmountOut 280");
    expect(text).not.toContain('below the TWAP floor');
    expect(text).not.toContain('misses its TWAP floor');
  });

  it('checks registry forwarding targets even when the outer call goes directly to the canonical router', async () => {
    const { service } = fixture({
      primaryTerminal: v6Address('JBRouterTerminal', project.chainId),
      routerTarget: custom,
    });
    await expect(service.preparePay(payInput)).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONFIGURATION',
    });
  });

  it('allows a known NFT callback but refuses nested tier split money flows without an adapter', async () => {
    const options = { dataHook: v6Address('REVOwner', project.chainId), tieredHook: custom };
    const quote = await fixture({
      ...options,
      payHooks: [{ hook: custom, noop: false, amount: 0n, metadata: '0x' }],
    }).service.quotePay(payInput);
    expect(quote.warnings.join(' ')).toContain('NFT allocation');
    await expect(
      fixture({
        ...options,
        payHooks: [{ hook: custom, noop: false, amount: 1n, metadata: '0x' }],
      }).service.preparePay(payInput),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONFIGURATION' });
  });

  it('recognizes a verified direct NFT clone and preserves its implementation-keyed mint metadata', async () => {
    const metadata = build721PayMetadata({
      metadataIdTarget: nftImplementation,
      tierIdsToMint: [1n],
      allowOverspending: false,
    });
    const { service, getBytecode, readContract } = fixture({
      dataHook: custom,
      nftClone: custom,
      payHooks: [{ hook: custom, noop: false, amount: 0n, metadata: '0x' }],
    });
    const plan = await service.preparePay({ ...payInput, metadata });
    expect(getBytecode).toHaveBeenCalledWith({ address: custom });
    expect(
      readContract.mock.calls.find(
        ([request]) => request.functionName === 'METADATA_ID_TARGET',
      )?.[0].address,
    ).toBe(custom);
    expect(
      decodeFunctionData({ abi: jbMultiTerminalAbi, data: plan.calls[0]!.data }).args?.[6],
    ).toBe(metadata);
    await expect(fixture({ dataHook: custom }).service.preparePay(payInput)).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONFIGURATION',
    });
    await expect(
      fixture({ dataHook: custom, nftClone: custom, nftProjectId: 99n }).service.preparePay(
        payInput,
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONFIGURATION' });
  });

  it('checks the current omnichain wrapper NFT and extra hook instead of inferring base economics', async () => {
    const { service, readContract } = fixture({
      dataHook: omni,
      tieredHook: custom,
      extraDataHook: registry,
      beneficiaryCount: 0n,
      payHooks: [
        { hook: custom, noop: false, amount: 0n, metadata: '0x' },
        { hook: buybackHook, noop: false, amount: 100n, metadata: payHookMetadata() },
      ],
    });
    const quote = await service.quotePay(ownPayInput);
    expect(quote).toMatchObject({
      beneficiaryTokenCount: '250',
      minimumBeneficiaryTokenCount: '247',
    });
    expect(
      readContract.mock.calls.find(([request]) => request.functionName === 'extraDataHookOf')?.[0],
    ).toMatchObject({ address: omni, args: [12n, 3n] });
    await expect(
      fixture({ dataHook: omni, tieredHook: custom, extraDataHook: token }).service.preparePay(
        payInput,
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONFIGURATION' });
    const inactive = await fixture({
      dataHook: omni,
      tieredHook: custom,
      extraDataHook: token,
      extraPayEnabled: false,
    }).service.quotePay(ownPayInput);
    expect(inactive.beneficiaryTokenCount).toBe('101');
  });
});

describe('cash-out quotes', () => {
  it('floors final net using the preview tax, with caller-aware fee evidence', async () => {
    const { service, readContract } = fixture({ cashGross: 101n, cashTax: 1n });
    const plan = await service.prepareCashOut(cashInput);
    expect(plan.summary).toMatchObject({
      treasuryGross: '101',
      treasuryProtocolFee: '2',
      expectedReturn: '99',
      minimumReturn: '98',
    });
    expect(
      decodeFunctionData({ abi: jbMultiTerminalAbi, data: plan.calls[0]!.data }).args?.[4],
    ).toBe(98n);
    expect(
      readContract.mock.calls.find(([request]) => request.functionName === 'isFeelessFor')?.[0],
    ).toMatchObject({
      address: feeless,
      args: [beneficiary, 12n, account],
    });
    expect(
      readContract.mock.calls.find(
        ([request]) => request.functionName === 'previewCashOutFrom',
      )?.[0].account,
    ).toBe(account);
  });

  it('charges zero-tax round-trip fees only on tracked fee-free surplus and preserves feeless grants', async () => {
    const ordinary = await fixture({ cashTax: 0n, feeFreeSurplus: 40n }).service.quoteCashOut(
      cashInput,
    );
    expect(ordinary).toMatchObject({
      treasuryProtocolFee: '1',
      treasuryNet: '100',
      minimumReturn: '99',
    });
    const exempt = await fixture({ beneficiaryIsFeeless: true, cashTax: 1n }).service.quoteCashOut(
      cashInput,
    );
    expect(exempt).toMatchObject({ treasuryProtocolFee: '0', treasuryNet: '101' });
    await expect(
      fixture({ errorOn: 'isFeelessFor' }).service.quoteCashOut(cashInput),
    ).rejects.toThrow();
    await expect(
      fixture({ cashTax: 0n, errorOn: 'feeFreeSurplusOf' }).service.quoteCashOut(cashInput),
    ).rejects.toThrow();
  });

  it('locks AMM minima in metadata and submits exactly the re-previewed bytes', async () => {
    const minimum = 198n;
    const locked = buildBuybackCashOutMetadata({
      hook: buybackHook,
      minimumSwapAmountOut: minimum,
    });
    const { service, readContract } = fixture({
      dataHook: registry,
      cashPreview: (metadata) => [
        ruleset,
        0n,
        10000n,
        [
          {
            hook: buybackHook,
            noop: false,
            amount: 0n,
            metadata: cashHookMetadata(metadata === '0x' ? 200n : minimum, metadata !== '0x'),
          },
        ],
      ],
    });
    const plan = await service.prepareCashOut(cashInput);
    expect(plan.summary).toMatchObject({
      route: 'amm',
      terminalMinimum: '0',
      minimumReturn: '198',
      metadata: locked,
    });
    expect(
      readContract.mock.calls
        .filter(([request]) => request.functionName === 'previewCashOutFrom')
        .map(([request]) => request.args?.[5]),
    ).toEqual(['0x', locked]);
    expect(decodeFunctionData({ abi: jbMultiTerminalAbi, data: plan.calls[0]!.data }).args).toEqual(
      [account, 12n, 100n, NATIVE_TOKEN, 0n, beneficiary, locked],
    );
  });

  it('rejects SDK zero-floor fallback when a slippage-protected pool quote no longer beats direct cash-out', async () => {
    const { service } = fixture({
      dataHook: registry,
      cashPreview: () => [
        ruleset,
        0n,
        10000n,
        [
          {
            hook: buybackHook,
            noop: false,
            amount: 0n,
            metadata: cashHookMetadata(101n, false, 100n),
          },
        ],
      ],
    });
    await expect(service.prepareCashOut(cashInput)).rejects.toMatchObject({
      code: 'CASH_OUT_ROUTE_REQUIRES_REQUOTE',
    });
  });

  it('never prepares a zero-output burn and requires a registered treasury terminal', async () => {
    expect((await fixture({ cashGross: 0n }).service.quoteCashOut(cashInput)).expectedReturn).toBe(
      '0',
    );
    await expect(
      fixture({ cashGross: 0n }).service.prepareCashOut(cashInput),
    ).rejects.toMatchObject({ code: 'NOTHING_TO_RECLAIM' });
    await expect(
      fixture({ registered: false }).service.prepareCashOut(cashInput),
    ).rejects.toMatchObject({ code: 'TERMINAL_NOT_REGISTERED' });
  });

  it('refuses a cash out the holder cannot cover with a named, non-retryable error', async () => {
    const { service, readContract } = fixture({ holderBalance: 99n });
    await expect(service.prepareCashOut(cashInput)).rejects.toMatchObject({
      code: 'INSUFFICIENT_PROJECT_TOKENS',
      retryable: false,
      details: { balance: '99', cashOutCount: '100' },
    });
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'totalBalanceOf',
        address: v6Address('JBTokens', project.chainId),
        args: [account, 12n],
      }),
    );
    await expect(
      fixture({ holderBalance: 100n }).service.prepareCashOut(cashInput),
    ).resolves.toMatchObject({ operation: 'cash_out' });
  });
});

describe('payout quotes', () => {
  it('quotes with minimum zero at the evidence block then protects exact same-currency gross', async () => {
    const { service, simulateContract } = fixture();
    const plan = await service.preparePayout(payoutInput);
    expect(simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({
        account,
        blockNumber: 123n,
        functionName: 'sendPayoutsOf',
        args: [12n, NATIVE_TOKEN, 100n, 61166n, 0n],
      }),
    );
    expect(
      decodeFunctionData({ abi: jbMultiTerminalAbi, data: plan.calls[0]!.data }).args?.[4],
    ).toBe(101n);
    expect(plan.summary).toMatchObject({
      grossAmountRecorded: '101',
      minimumGrossAmountRecorded: '101',
      slippageBps: 0,
    });
    expect(plan.warnings.join(' ')).toContain('do not guarantee delivery');
  });

  it('applies slippage only to converted currency, and does not prepare zero-payout calls', async () => {
    const plan = await fixture().service.preparePayout({ ...payoutInput, currency: 2 });
    expect(
      decodeFunctionData({ abi: jbMultiTerminalAbi, data: plan.calls[0]!.data }).args?.[4],
    ).toBe(99n);
    expect(plan.summary).toMatchObject({
      isCurrencyConversion: true,
      minimumGrossAmountRecorded: '99',
    });
    expect(
      (await fixture({ grossPayout: 0n }).service.quotePayout(payoutInput)).grossAmountRecorded,
    ).toBe('0');
    await expect(
      fixture({ grossPayout: 0n }).service.preparePayout(payoutInput),
    ).rejects.toMatchObject({ code: 'NOTHING_TO_PAY_OUT' });
  });

  it('names an empty terminal balance instead of a retryable upstream failure', async () => {
    // The live base:17 revert: sendPayoutsOf(17, USDC, 1e6, ...) with a zero balance.
    const data = encodeErrorResult({
      abi: jbTerminalStoreAbi,
      errorName: 'JBTerminalStore_InadequateTerminalStoreBalance',
      args: [1_000_000n, 0n],
    });
    const payoutRevert = new ContractFunctionRevertedError({
      abi: jbMultiTerminalAbi,
      data,
      functionName: 'sendPayoutsOf',
    });
    for (const call of ['quotePayout', 'preparePayout'] as const)
      await expect(fixture({ payoutRevert }).service[call](payoutInput)).rejects.toMatchObject({
        code: 'NOTHING_TO_PAY_OUT',
        retryable: false,
        message: expect.stringContaining('balance in this terminal is 0'),
      });
    const other = new ContractFunctionRevertedError({
      abi: jbMultiTerminalAbi,
      data: encodeErrorResult({
        abi: jbTerminalStoreAbi,
        errorName: 'JBTerminalStore_RulesetNotFound',
        args: [12n],
      }),
      functionName: 'sendPayoutsOf',
    });
    const error = await fixture({ payoutRevert: other })
      .service.quotePayout(payoutInput)
      .catch((e: unknown) => e);
    expect(publicError(error)).toMatchObject({
      code: 'CALL_REVERTED',
      retryable: false,
      details: { errorName: 'JBTerminalStore_RulesetNotFound', args: ['12'] },
    });
  });
});
