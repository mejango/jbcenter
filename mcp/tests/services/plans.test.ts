import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  parseAbiItem,
  zeroAddress,
  zeroHash,
  type Abi,
  type AbiEvent,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import {
  NATIVE_TOKEN,
  jb721TiersHookAbi,
  jb721TiersHookDeployerAbi,
  jb721TiersHookProjectDeployerAbi,
  jbBuybackHookAbi,
  jbBuybackHookRegistryAbi,
  jbControllerAbi,
  jbMultiTerminalAbi,
  jbPermissionsAbi,
  jbProjectsAbi,
  jbRouterTerminalRegistryAbi,
  revDeployerAbi,
  revLoansAbi,
  revOwnerAbi,
} from '@bananapus/nana-sdk-core';
import { jbSuckerV6Abi, uniswapV4PoolId, v6Address } from '@bananapus/nana-sdk-core/v6';
import { PlanService } from '../../src/services/plans.js';
import { deploymentAddress, deploymentAddresses } from '../../src/services/rollout.js';
import { canonicalJson } from '../../src/domain/json.js';
import type {
  BlockEvidence,
  PlanDraft,
  PreparedCall,
  RpcProvider,
} from '../../src/domain/types.js';

const SECRET = 'test-secret-with-at-least-32-bytes-of-entropy';
const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address;
const OTHER = '0x2222222222222222222222222222222222222222' as Address;
const TOKEN = '0x3333333333333333333333333333333333333333' as Address;
const TERMINAL = v6Address('JBMultiTerminal', 1);
const CONTROLLER = v6Address('JBController', 1);
const PROJECTS = v6Address('JBProjects', 1);
const HASH = `0x${'a'.repeat(64)}` as Hex;
const HASH2 = `0x${'b'.repeat(64)}` as Hex;
const BLOCK100 = `0x${'1'.repeat(64)}` as Hex;
const BLOCK101 = `0x${'2'.repeat(64)}` as Hex;
const NOW = Date.parse('2026-09-06T12:00:00.000Z');
const evidence: BlockEvidence = {
  chainId: 1,
  blockNumber: '101',
  blockHash: BLOCK101,
  timestamp: '1788696000',
  source: 'rpc',
};

const payCall = (): PreparedCall => ({
  chainId: 1,
  to: TERMINAL,
  data: encodeFunctionData({
    abi: jbMultiTerminalAbi,
    functionName: 'pay',
    args: [7n, TOKEN, 100n, ACCOUNT, 5n, '', '0x'],
  }),
  value: '0',
  label: 'Pay project 7',
  decoded: { functionName: 'pay', args: ['7', TOKEN, '100', ACCOUNT, '5', '', '0x'] },
  dependsOn: [],
});
const draft = (calls: PreparedCall[] = [payCall()]): PlanDraft => ({
  operation: 'pay',
  account: ACCOUNT,
  project: { chainId: 1, projectId: '7', version: 6 },
  calls,
  evidence: [{ ...evidence, blockNumber: '99' }],
  summary: { amount: '100' },
  warnings: [],
});

function eventLog(
  signature: string,
  args: Record<string, unknown>,
  address: Address,
  logIndex = 0,
) {
  const event = parseAbiItem(signature) as AbiEvent;
  return encodedLog(event, args, address, logIndex);
}
function abiLog(
  abi: Abi,
  eventName: string,
  args: Record<string, unknown>,
  address: Address,
  logIndex = 0,
) {
  const event = abi.find((item) => item.type === 'event' && item.name === eventName) as AbiEvent;
  if (!event) throw new Error(`Test ABI missing ${eventName}`);
  return encodedLog(event, args, address, logIndex);
}
function encodedLog(
  event: AbiEvent,
  args: Record<string, unknown>,
  address: Address,
  logIndex = 0,
) {
  const nonIndexed = event.inputs.filter((input) => !input.indexed);
  return {
    address,
    data: encodeAbiParameters(
      nonIndexed,
      nonIndexed.map((input) => args[input.name!]),
    ),
    topics: encodeEventTopics({ abi: [event], eventName: event.name, args }),
    logIndex,
    removed: false,
    transactionHash: HASH,
    transactionIndex: 0,
    blockNumber: 100n,
    blockHash: BLOCK100,
  };
}
function payLog(overrides: Record<string, unknown> = {}, emitter = TERMINAL) {
  return eventLog(
    'event Pay(uint256 indexed rulesetId,uint256 indexed rulesetCycleNumber,uint256 indexed projectId,address payer,address beneficiary,uint256 amount,uint256 newlyIssuedTokenCount,string memo,bytes metadata,address caller)',
    {
      rulesetId: 1n,
      rulesetCycleNumber: 1n,
      projectId: 7n,
      payer: ACCOUNT,
      beneficiary: ACCOUNT,
      amount: 100n,
      newlyIssuedTokenCount: 10n,
      memo: '',
      metadata: '0x',
      caller: ACCOUNT,
      ...overrides,
    },
    emitter,
  );
}
function setup(planDraft = draft()) {
  let now = NOW;
  const call = planDraft.calls[0]!;
  const transaction = {
    hash: HASH,
    chainId: 1,
    from: ACCOUNT,
    to: call.to,
    input: call.data,
    value: BigInt(call.value),
    blockNumber: 100n,
    blockHash: BLOCK100,
  };
  const receipt = {
    transactionHash: HASH,
    from: ACCOUNT,
    to: call.to,
    blockNumber: 100n,
    blockHash: BLOCK100,
    transactionIndex: 0,
    status: 'success',
    logs: [payLog()],
  };
  const client = {
    getChainId: vi.fn(async () => 1),
    getTransaction: vi.fn(async () => transaction),
    getTransactionReceipt: vi.fn(async () => receipt),
    getBytecode: vi.fn(async (): Promise<Hex | undefined> => undefined),
    getBlock: vi.fn(async (input: { blockNumber?: bigint; blockTag?: string }) => ({
      number: input.blockNumber ?? 101n,
      hash: input.blockNumber === 100n ? BLOCK100 : BLOCK101,
      timestamp: 1788696000n,
    })),
    call: vi.fn(async (_parameters: unknown) => ({ data: '0x' as Hex })),
    estimateGas: vi.fn(async (_parameters: unknown) => 100000n),
  };
  const rpc: RpcProvider = {
    client: () => client as unknown as PublicClient,
    snapshot: vi.fn(async () => ({ client: client as unknown as PublicClient, evidence })),
  };
  const service = new PlanService({ rpc, secret: SECRET, now: () => now, ttlSeconds: 60 });
  const sealed = service.seal(planDraft);
  return {
    service,
    sealed,
    rpc,
    client,
    transaction,
    receipt,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe('stateless authenticated plans', () => {
  it('seals a canonical immutable review and authenticates the same plan on another replica', () => {
    const { service, sealed, rpc } = setup();
    const inspected = service.inspect(sealed.token);
    expect(inspected.contentHash).toBe(sealed.contentHash);
    expect(inspected.draft).toEqual(sealed.review);
    expect(Object.isFrozen(inspected.draft.calls[0])).toBe(true);
    expect(() => {
      inspected.draft.calls[0]!.value = '1';
    }).toThrow();
    expect(new PlanService({ rpc, secret: SECRET, now: () => NOW }).inspect(sealed.token)).toEqual(
      inspected,
    );
  });

  it('hashes the reviewed content independently of issuance time', () => {
    const { service, sealed, setNow } = setup();
    setNow(NOW + 1000);
    const next = service.seal(draft());
    expect(next.contentHash).toBe(sealed.contentHash);
    expect(next.token).not.toBe(sealed.token);
  });

  it('rejects tampering, a different authentication key, and noncanonical signatures', () => {
    const { service, sealed, rpc } = setup();
    const parts = sealed.token.split('.');
    const raw = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
    raw.draft.calls[0].value = '1000';
    expect(() =>
      service.inspect(
        `${parts[0]}.${Buffer.from(JSON.stringify(raw)).toString('base64url')}.${parts[2]}`,
      ),
    ).toThrow('signature');
    expect(() =>
      new PlanService({
        rpc,
        secret: 'different-secret-at-least-32-bytes-long',
        now: () => NOW,
      }).inspect(sealed.token),
    ).toThrow('signature');
    expect(() => service.inspect(`${sealed.token}=`)).toThrow();
  });

  it('rejects signed noncanonical JSON and schema bounds independently of HMAC validity', () => {
    const { service, sealed } = setup();
    const raw = JSON.parse(Buffer.from(sealed.token.split('.')[1]!, 'base64url').toString());
    const resign = (payload: string) => {
      const encoded = Buffer.from(payload).toString('base64url');
      return `jbplan1.${encoded}.${createHmac('sha256', SECRET).update(`jbplan1.${encoded}`).digest('base64url')}`;
    };
    expect(() => service.inspect(resign(JSON.stringify(raw, null, 2)))).toThrow('canonical');
    raw.draft.calls[0].value = '-1';
    expect(() => service.inspect(resign(canonicalJson(raw)))).toThrow('validation');
  });

  it('rejects expired simulation but permits read-only receipt verification', async () => {
    const { service, sealed, setNow } = setup();
    setNow(NOW + 60_000);
    expect(() => service.inspect(sealed.token)).toThrow('expired');
    await expect(service.simulate({ token: sealed.token })).rejects.toThrow('expired');
    const result = await service.verify({
      token: sealed.token,
      transactions: [{ step: 0, hash: HASH }],
    });
    expect(result.expired).toBe(true);
    expect(result.outcomeVerified).toBe(true);
  });

  it('bounds plan structure, requires chain evidence and backward-only dependencies', () => {
    const { service, rpc } = setup();
    expect(() => new PlanService({ rpc, secret: 'too-short' })).toThrow('32 bytes');
    expect(() => service.seal({ ...draft(), evidence: [] })).toThrow('validation');
    expect(() => service.seal(draft([{ ...payCall(), dependsOn: [0] }]))).toThrow('validation');
    expect(() => service.seal(draft(Array.from({ length: 33 }, payCall)))).toThrow('validation');
    expect(() =>
      service.seal({ ...draft(), summary: { amount: Number.MAX_SAFE_INTEGER + 1 } }),
    ).toThrow('exact integers');
    const nested: unknown = Array.from({ length: 25 }).reduce<unknown>((value) => [value], 'deep');
    expect(() => service.seal({ ...draft(), summary: nested })).toThrow('structural limits');
    expect(() => service.seal({ ...draft(), summary: 'x'.repeat(128 * 1024 + 1) })).toThrow(
      'maximum payload',
    );
  });
});

describe('direct transaction and canonical receipt verification', () => {
  it('verifies a matching direct transaction and canonical project Pay evidence', async () => {
    const { service, sealed } = setup();
    const result = await service.verify({
      token: sealed.token,
      transactions: [{ step: 0, hash: HASH }],
    });
    expect(result.transactionConfirmed).toBe(true);
    expect(result.outcomeVerified).toBe(true);
    expect(result.steps[0]).toMatchObject({
      status: 'confirmed',
      confirmations: '2',
      outcome: [{ event: 'Pay', emitter: TERMINAL, args: { projectId: '7', amount: '100' } }],
    });
  });

  it.each([
    ['sender', { from: OTHER }],
    ['destination', { to: OTHER }],
    ['calldata', { input: '0x1234' }],
    ['value', { value: 1n }],
    ['chain', { chainId: 10 }],
  ])('rejects a transaction with a mismatched %s', async (_label, overrides) => {
    const { service, sealed, transaction } = setup();
    Object.assign(transaction, overrides);
    const result = await service.verify({
      token: sealed.token,
      transactions: [{ step: 0, hash: HASH }],
    });
    expect(result.steps[0]!.status).toBe('mismatch');
    expect(result.transactionConfirmed).toBe(false);
    expect(result.outcomeVerified).toBe(false);
  });

  it('distinguishes a pending transaction, an unavailable receipt, and a revert', async () => {
    const { service, sealed, client, receipt, transaction } = setup();
    const params = { token: sealed.token, transactions: [{ step: 0, hash: HASH }] };
    Object.assign(transaction, { blockNumber: null, blockHash: null });
    expect((await service.verify(params)).steps[0]!.status).toBe('pending');
    Object.assign(transaction, { blockNumber: 100n, blockHash: BLOCK100 });
    const missing = new Error('missing');
    missing.name = 'TransactionReceiptNotFoundError';
    client.getTransactionReceipt.mockRejectedValueOnce(missing);
    expect((await service.verify(params)).steps[0]!.status).toBe('pending');
    client.getTransactionReceipt.mockRejectedValueOnce(
      new Error('wrapped RPC error', { cause: missing }),
    );
    expect((await service.verify(params)).steps[0]!.status).toBe('pending');
    receipt.status = 'reverted';
    expect((await service.verify(params)).steps[0]!.status).toBe('reverted');
  });

  it('does not turn RPC failures into pending or expose RPC credentials', async () => {
    const { service, sealed, client } = setup();
    client.getTransaction.mockRejectedValueOnce(
      new Error('https://secret-token@example.com unexpected RPC failure'),
    );
    const result = await service.verify({
      token: sealed.token,
      transactions: [{ step: 0, hash: HASH }],
    });
    expect(result.steps[0]!.status).toBe('unverified');
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  it('requires requested confirmations and canonical block agreement', async () => {
    const { service, sealed, client } = setup();
    const params = { token: sealed.token, transactions: [{ step: 0, hash: HASH }] };
    expect((await service.verify({ ...params, minimumConfirmations: 3 })).steps[0]).toMatchObject({
      status: 'pending',
      transactionConfirmed: false,
      confirmations: '2',
    });
    client.getBlock.mockImplementation(async (input) => ({
      number: input.blockNumber ?? 101n,
      hash: BLOCK101,
      timestamp: 1788696000n,
    }));
    expect((await service.verify(params)).steps[0]).toMatchObject({
      status: 'unverified',
      transactionConfirmed: false,
    });
  });

  it('does not treat smart-account/delegated or nested Safe execution as verified direct execution', async () => {
    const { service, sealed, client, transaction } = setup();
    const params = { token: sealed.token, transactions: [{ step: 0, hash: HASH }] };
    client.getBytecode.mockResolvedValueOnce('0xef0100');
    expect((await service.verify(params)).steps[0]!.status).toBe('unverified');
    transaction.to = ACCOUNT;
    transaction.from = OTHER;
    expect((await service.verify(params)).steps[0]!.reason).toContain('Nested wallet');
  });

  it('rejects a provider serving the wrong chain before inspecting transaction evidence', async () => {
    const { service, sealed, client } = setup();
    client.getChainId.mockResolvedValue(10);
    const result = await service.verify({
      token: sealed.token,
      transactions: [{ step: 0, hash: HASH }],
    });
    expect(result.steps[0]).toMatchObject({ status: 'unverified', transactionConfirmed: false });
    expect(client.getTransaction).not.toHaveBeenCalled();
    expect((await service.simulate({ token: sealed.token })).status).toBe('unverified');
    expect(client.call).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong emitter', payLog({}, OTHER)],
    ['wrong project', payLog({ projectId: 8n })],
    ['wrong beneficiary', payLog({ beneficiary: OTHER })],
    ['wrong caller', payLog({ caller: OTHER })],
  ])('separates transaction confirmation from %s event evidence', async (_label, log) => {
    const { service, sealed, receipt } = setup();
    receipt.logs = [log];
    const result = await service.verify({
      token: sealed.token,
      transactions: [{ step: 0, hash: HASH }],
    });
    expect(result.transactionConfirmed).toBe(true);
    expect(result.outcomeVerified).toBe(false);
  });

  it('does not confuse newly minted tokens with the complete token balance delta enforced by pay', async () => {
    const { service, sealed, receipt } = setup();
    receipt.logs = [payLog({ newlyIssuedTokenCount: 0n })];
    const result = await service.verify({
      token: sealed.token,
      transactions: [{ step: 0, hash: HASH }],
    });
    expect(result.outcomeVerified).toBe(true);
    expect(result.steps[0]!.outcome![0]!.args).toMatchObject({ newlyIssuedTokenCount: '0' });
  });

  it('does not reuse a matching historical transaction as execution of a new plan', async () => {
    const plan = draft();
    plan.evidence[0]!.blockNumber = '100';
    const { service, sealed } = setup(plan);
    const result = await service.verify({
      token: sealed.token,
      transactions: [{ step: 0, hash: HASH }],
    });
    expect(result.steps[0]).toMatchObject({
      status: 'mismatch',
      transactionConfirmed: false,
      outcomeVerified: false,
    });
    expect(result.steps[0]!.reason).toContain('predates');
  });

  it('does not claim semantic completion when event parsing is unsupported', async () => {
    const { service, sealed, receipt } = setup(
      draft([{ ...payCall(), to: OTHER, data: '0x12345678' }]),
    );
    receipt.logs = [];
    const result = await service.verify({
      token: sealed.token,
      transactions: [{ step: 0, hash: HASH }],
    });
    expect(result.transactionConfirmed).toBe(true);
    expect(result.outcomeVerified).toBe(false);
  });

  it('rejects duplicate hashes, duplicate steps, and references outside the plan', async () => {
    const { service, sealed } = setup(draft([payCall(), { ...payCall(), dependsOn: [0] }]));
    await expect(
      service.verify({
        token: sealed.token,
        transactions: [
          { step: 0, hash: HASH },
          { step: 1, hash: HASH },
        ],
      }),
    ).rejects.toThrow('unique');
    await expect(
      service.verify({
        token: sealed.token,
        transactions: [
          { step: 0, hash: HASH },
          { step: 0, hash: HASH2 },
        ],
      }),
    ).rejects.toThrow('unique');
    await expect(
      service.verify({ token: sealed.token, transactions: [{ step: 2, hash: HASH }] }),
    ).rejects.toThrow('unique');
  });

  it('does not complete a plan when a dependent call was mined before its prerequisite', async () => {
    const { service, sealed, client, transaction, receipt } = setup(
      draft([payCall(), { ...payCall(), dependsOn: [0] }]),
    );
    client.getTransaction
      .mockResolvedValueOnce({ ...transaction, hash: HASH })
      .mockResolvedValueOnce({ ...transaction, hash: HASH2 });
    client.getTransactionReceipt
      .mockResolvedValueOnce({ ...receipt, transactionHash: HASH, transactionIndex: 1 })
      .mockResolvedValueOnce({ ...receipt, transactionHash: HASH2, transactionIndex: 0 });
    const result = await service.verify({
      token: sealed.token,
      transactions: [
        { step: 0, hash: HASH },
        { step: 1, hash: HASH2 },
      ],
    });
    expect(result.transactionConfirmed).toBe(true);
    expect(result.outcomeVerified).toBe(false);
    expect(result.steps[1]!.reason).toContain('not mined before');
  });
});

describe('re-simulation and dependency verification', () => {
  const approval = (): PreparedCall => ({
    chainId: 1,
    to: TOKEN,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [TERMINAL, 100n] }),
    value: '0',
    label: 'Approve exactly 100',
    decoded: { functionName: 'approve', args: [TERMINAL, '100'] },
    dependsOn: [],
  });

  it('uses the exact sender/calldata/value and bounded gas at one real-state block', async () => {
    const { service, sealed, client } = setup();
    const result = await service.simulate({ token: sealed.token });
    expect(result.status).toBe('simulated');
    expect(client.call).toHaveBeenCalledWith({
      account: ACCOUNT,
      to: getAddress(TERMINAL),
      data: payCall().data,
      value: 0n,
      gas: 30_000_000n,
      blockNumber: 101n,
    });
    expect(client.estimateGas).toHaveBeenCalledWith(client.call.mock.calls[0]![0]);
  });

  it('blocks dependent calls until exact approval transactions are confirmed', async () => {
    const { service, sealed, client, transaction } = setup(
      draft([approval(), { ...payCall(), dependsOn: [0] }]),
    );
    expect((await service.simulate({ token: sealed.token, step: 1 })).status).toBe('blocked');
    expect(client.call).not.toHaveBeenCalled();
    transaction.value = 1n;
    expect(
      (
        await service.simulate({
          token: sealed.token,
          step: 1,
          confirmedTransactions: [{ step: 0, hash: HASH }],
        })
      ).status,
    ).toBe('blocked');
    expect(client.call).not.toHaveBeenCalled();
    transaction.value = 0n;
    expect(
      (
        await service.simulate({
          token: sealed.token,
          step: 1,
          confirmedTransactions: [{ step: 0, hash: HASH }],
        })
      ).status,
    ).toBe('simulated');
    expect(client.call).toHaveBeenCalledExactlyOnceWith({
      account: ACCOUNT,
      to: getAddress(TERMINAL),
      data: payCall().data,
      value: 0n,
      gas: 30_000_000n,
      blockNumber: 101n,
    });
    expect(client.call.mock.calls[0]![0]).not.toHaveProperty('stateOverride');
  });

  it('does not accept caller-supplied state overrides or forged dependency status', async () => {
    const { service, sealed } = setup();
    await expect(
      service.simulate({ token: sealed.token, stateOverride: [] } as never),
    ).rejects.toThrow('validation');
    await expect(
      service.simulate({
        token: sealed.token,
        confirmedTransactions: [{ step: 0, hash: HASH, confirmed: true }],
      } as never),
    ).rejects.toThrow('validation');
  });

  it('requires all transitive dependencies, even when the immediate dependency is provided', async () => {
    const calls = [approval(), { ...approval(), dependsOn: [0] }, { ...payCall(), dependsOn: [1] }];
    const { service, sealed, client } = setup(draft(calls));
    const result = await service.simulate({
      token: sealed.token,
      step: 2,
      confirmedTransactions: [{ step: 1, hash: HASH }],
    });
    expect(result.status).toBe('blocked');
    expect(result.dependencies[0]).toMatchObject({ step: 0, status: 'pending' });
    expect(client.call).not.toHaveBeenCalled();
  });

  it('rejects a dependency that reorgs while the next call is being simulated', async () => {
    const { service, sealed, client } = setup(
      draft([approval(), { ...payCall(), dependsOn: [0] }]),
    );
    let dependencyReads = 0;
    client.getBlock.mockImplementation(async (input) => {
      if (input.blockNumber === 100n) {
        dependencyReads++;
        return {
          number: 100n,
          hash: dependencyReads === 1 ? BLOCK100 : BLOCK101,
          timestamp: 1788696000n,
        };
      }
      return { number: input.blockNumber ?? 101n, hash: BLOCK101, timestamp: 1788696000n };
    });
    const result = await service.simulate({
      token: sealed.token,
      step: 1,
      confirmedTransactions: [{ step: 0, hash: HASH }],
    });
    expect(result.status).toBe('unverified');
    expect(result).toHaveProperty('error.code', 'CHAIN_REORG');
  });

  it('detects a reorg of the simulation block and expiration during RPC work', async () => {
    const { service, sealed, client, setNow } = setup();
    client.getBlock.mockResolvedValueOnce({ number: 101n, hash: BLOCK100, timestamp: 1788696000n });
    expect((await service.simulate({ token: sealed.token })).status).toBe('unverified');
    client.call.mockImplementationOnce(async () => {
      setNow(NOW + 60_000);
      return { data: '0x' };
    });
    expect((await service.simulate({ token: sealed.token })).status).toBe('unverified');
  });

  it('reports execution reverts without claiming simulation success', async () => {
    const { service, sealed, client } = setup();
    client.call.mockRejectedValueOnce(new Error('reverted'));
    expect((await service.simulate({ token: sealed.token })).status).toBe('unverified');
    expect(client.estimateGas).not.toHaveBeenCalled();
  });
});

describe('canonical launch and payout operation evidence', () => {
  it('verifies exact cash-out holder, project, beneficiary, burned amount and reclaimed minimum', async () => {
    const call: PreparedCall = {
      ...payCall(),
      data: encodeFunctionData({
        abi: jbMultiTerminalAbi,
        functionName: 'cashOutTokensOf',
        args: [ACCOUNT, 7n, 100n, TOKEN, 10n, OTHER, '0x'],
      }),
      decoded: {
        functionName: 'cashOutTokensOf',
        args: [ACCOUNT, '7', '100', TOKEN, '10', OTHER, '0x'],
      },
    };
    const { service, sealed, receipt } = setup(draft([call]));
    const cashOut = (overrides = {}) =>
      eventLog(
        'event CashOutTokens(uint256 indexed rulesetId,uint256 indexed rulesetCycleNumber,uint256 indexed projectId,address holder,address beneficiary,uint256 cashOutCount,uint256 cashOutTaxRate,uint256 reclaimAmount,bytes metadata,address caller)',
        {
          rulesetId: 1n,
          rulesetCycleNumber: 1n,
          projectId: 7n,
          holder: ACCOUNT,
          beneficiary: OTHER,
          cashOutCount: 100n,
          cashOutTaxRate: 0n,
          reclaimAmount: 10n,
          metadata: '0x',
          caller: ACCOUNT,
          ...overrides,
        },
        TERMINAL,
      );
    const params = { token: sealed.token, transactions: [{ step: 0, hash: HASH }] };
    receipt.logs = [cashOut()];
    expect((await service.verify(params)).outcomeVerified).toBe(true);
    for (const override of [
      { holder: OTHER },
      { projectId: 8n },
      { beneficiary: ACCOUNT },
      { cashOutCount: 99n },
      { reclaimAmount: 9n },
    ]) {
      receipt.logs = [cashOut(override)];
      expect((await service.verify(params)).outcomeVerified).toBe(false);
    }
  });

  function launchSetup() {
    const call: PreparedCall = {
      chainId: 1,
      to: CONTROLLER,
      data: encodeFunctionData({
        abi: jbControllerAbi,
        functionName: 'launchProjectFor',
        args: [OTHER, 'ipfs://project', [], [], ''],
      }),
      value: '10',
      label: 'Launch a project',
      decoded: { functionName: 'launchProjectFor', args: [OTHER, 'ipfs://project', [], [], ''] },
      dependsOn: [],
    };
    const launchDraft = { ...draft([call]), operation: 'launch' };
    delete launchDraft.project;
    const setupResult = setup(launchDraft);
    const create = eventLog(
      'event Create(uint256 indexed projectId,address indexed owner,address caller)',
      { projectId: 12n, owner: OTHER, caller: CONTROLLER },
      PROJECTS,
    );
    const launch = eventLog(
      'event LaunchProject(uint256 rulesetId,uint256 projectId,string projectUri,string memo,address caller)',
      { rulesetId: 1n, projectId: 12n, projectUri: 'ipfs://project', memo: '', caller: ACCOUNT },
      CONTROLLER,
      1,
    );
    setupResult.receipt.logs = [create, launch];
    return { ...setupResult, create, launch };
  }

  it('verifies the matching newly-created project ID and requested owner on canonical emitters', async () => {
    const { service, sealed } = launchSetup();
    const result = await service.verify({
      token: sealed.token,
      transactions: [{ step: 0, hash: HASH }],
    });
    expect(result.outcomeVerified).toBe(true);
    expect(result.steps[0]!.outcome).toHaveLength(2);
  });

  it('refuses launch completion without Create, with wrong Create emitter, or mismatched project ID', async () => {
    const { service, sealed, receipt, launch, create } = launchSetup();
    const params = { token: sealed.token, transactions: [{ step: 0, hash: HASH }] };
    receipt.logs = [launch];
    expect((await service.verify(params)).outcomeVerified).toBe(false);
    receipt.logs = [{ ...create, address: OTHER }, launch];
    expect((await service.verify(params)).outcomeVerified).toBe(false);
    receipt.logs = [
      eventLog(
        'event Create(uint256 indexed projectId,address indexed owner,address caller)',
        { projectId: 13n, owner: OTHER, caller: CONTROLLER },
        PROJECTS,
      ),
      launch,
    ];
    expect((await service.verify(params)).outcomeVerified).toBe(false);
    receipt.logs = [
      eventLog(
        'event Create(uint256 indexed projectId,address indexed owner,address caller)',
        { projectId: 12n, owner: ACCOUNT, caller: CONTROLLER },
        PROJECTS,
      ),
      launch,
    ];
    expect((await service.verify(params)).outcomeVerified).toBe(false);
    receipt.logs = [
      create,
      eventLog(
        'event LaunchRulesets(uint256 rulesetId,uint256 projectId,string projectUri,string memo,address caller)',
        { rulesetId: 1n, projectId: 12n, projectUri: 'ipfs://project', memo: '', caller: ACCOUNT },
        CONTROLLER,
        1,
      ),
    ];
    expect((await service.verify(params)).outcomeVerified).toBe(false);
  });

  it('reports partial payout failures even when the exact transaction succeeds', async () => {
    const call: PreparedCall = {
      ...payCall(),
      data: encodeFunctionData({
        abi: jbMultiTerminalAbi,
        functionName: 'sendPayoutsOf',
        args: [7n, TOKEN, 100n, 1n, 1n],
      }),
      decoded: { functionName: 'sendPayoutsOf', args: ['7', TOKEN, '100', '1', '1'] },
    };
    const { service, sealed, receipt } = setup(draft([call]));
    receipt.logs = [
      eventLog(
        'event SendPayouts(uint256 indexed rulesetId,uint256 indexed rulesetCycleNumber,uint256 indexed projectId,address projectOwner,uint256 amount,uint256 amountPaidOut,uint256 fee,uint256 netLeftoverPayoutAmount,address caller)',
        {
          rulesetId: 1n,
          rulesetCycleNumber: 1n,
          projectId: 7n,
          projectOwner: OTHER,
          amount: 100n,
          amountPaidOut: 100n,
          fee: 0n,
          netLeftoverPayoutAmount: 0n,
          caller: ACCOUNT,
        },
        TERMINAL,
      ),
      eventLog(
        'event PayoutTransferReverted(uint256 indexed projectId,address addr,address token,uint256 amount,uint256 fee,bytes reason,address caller)',
        {
          projectId: 7n,
          addr: OTHER,
          token: TOKEN,
          amount: 100n,
          fee: 0n,
          reason: '0x',
          caller: ACCOUNT,
        },
        TERMINAL,
        1,
      ),
    ];
    const result = await service.verify({
      token: sealed.token,
      transactions: [{ step: 0, hash: HASH }],
    });
    expect(result.transactionConfirmed).toBe(true);
    expect(result.outcomeVerified).toBe(false);
    expect(result.steps[0]!.reason).toContain('partial completion');
  });
});

describe('extension receipt evidence', () => {
  const planFor = (
    to: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[],
    operation = functionName,
  ) => ({
    ...draft([
      {
        chainId: 1,
        to,
        data: encodeFunctionData({ abi, functionName, args }),
        value: '0',
        label: functionName,
        decoded: { functionName, args },
        dependsOn: [],
      },
    ]),
    operation,
  });
  const params = (token: string) => ({ token, transactions: [{ step: 0, hash: HASH }] });

  it('proves exact operator permission bitmaps and refuses a changed operator', async () => {
    const permissions = v6Address('JBPermissions', 1);
    const plan = planFor(permissions, jbPermissionsAbi, 'setPermissionsFor', [
      ACCOUNT,
      { operator: OTHER, projectId: 7n, permissionIds: [1, 11] },
    ]);
    const { service, sealed, receipt } = setup(plan);
    const args = {
      operator: OTHER,
      account: ACCOUNT,
      projectId: 7n,
      permissionIds: [1, 11],
      packed: (1n << 1n) | (1n << 11n),
      caller: ACCOUNT,
    };
    receipt.logs = [abiLog(jbPermissionsAbi, 'OperatorPermissionsSet', args, permissions)];
    expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(true);
    receipt.logs = [
      abiLog(jbPermissionsAbi, 'OperatorPermissionsSet', { ...args, operator: TOKEN }, permissions),
    ];
    expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(false);
  });

  it('verifies borrowed debt and collateral plus loan NFT delivery to the holder', async () => {
    const loans = v6Address('REVLoans', 1);
    const plan = planFor(loans, revLoansAbi, 'borrowFrom', [
      7n,
      TOKEN,
      90n,
      1000n,
      OTHER,
      25n,
      ACCOUNT,
    ]);
    const { service, sealed, receipt } = setup(plan);
    const loan = {
      amount: 100n,
      collateral: 1000n,
      createdAt: 1000,
      prepaidFeePercent: 25,
      prepaidDuration: 1000,
      sourceToken: TOKEN,
    };
    const borrowed = abiLog(
      revLoansAbi,
      'Borrow',
      {
        loanId: 12n,
        revnetId: 7n,
        loan,
        token: TOKEN,
        borrowAmount: 100n,
        collateralCount: 1000n,
        sourceFeeAmount: 1n,
        beneficiary: OTHER,
        caller: ACCOUNT,
      },
      loans,
    );
    receipt.logs = [borrowed];
    expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(false);
    receipt.logs.push(
      abiLog(revLoansAbi, 'Transfer', { from: zeroAddress, to: ACCOUNT, tokenId: 12n }, loans, 1),
    );
    expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(true);
    receipt.logs[1] = abiLog(
      revLoansAbi,
      'Transfer',
      { from: zeroAddress, to: OTHER, tokenId: 12n },
      loans,
      1,
    );
    expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(false);
  });

  it('allows full collateral return when repayment rounds remaining debt to zero', async () => {
    const loans = v6Address('REVLoans', 1);
    const allowance = { sigDeadline: 0n, amount: 0n, expiration: 0, nonce: 0, signature: '0x' };
    const plan = planFor(loans, revLoansAbi, 'repayLoan', [12n, 110n, 900n, OTHER, allowance]);
    const { service, sealed, receipt } = setup(plan);
    const loan = {
      amount: 100n,
      collateral: 1000n,
      createdAt: 1000,
      prepaidFeePercent: 25,
      prepaidDuration: 1000,
      sourceToken: TOKEN,
    };
    const args = {
      loanId: 12n,
      revnetId: 7n,
      paidOffLoanId: 12n,
      loan,
      paidOffLoan: { ...loan, amount: 0n, collateral: 0n },
      repayBorrowAmount: 100n,
      sourceFeeAmount: 0n,
      collateralCountToReturn: 1000n,
      beneficiary: OTHER,
      caller: ACCOUNT,
    };
    receipt.logs = [abiLog(revLoansAbi, 'RepayLoan', args, loans)];
    expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(true);
    receipt.logs = [abiLog(revLoansAbi, 'RepayLoan', { ...args, repayBorrowAmount: 111n }, loans)];
    expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(false);
  });

  it('verifies auto-issuance for the requested stage and beneficiary', async () => {
    const owner = v6Address('REVOwner', 1);
    const { service, sealed, receipt } = setup(
      planFor(owner, revOwnerAbi, 'autoIssueFor', [7n, 123n, OTHER]),
    );
    const args = { revnetId: 7n, stageId: 123n, beneficiary: OTHER, count: 100n, caller: ACCOUNT };
    receipt.logs = [abiLog(revOwnerAbi, 'AutoIssue', args, owner)];
    expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(true);
    receipt.logs = [abiLog(revOwnerAbi, 'AutoIssue', { ...args, stageId: 124n }, owner)];
    expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(false);
  });

  it('verifies a single bridge leaf with all exact committed fields', async () => {
    const leaf = {
      index: 10n,
      beneficiary: `0x${'0'.repeat(24)}${ACCOUNT.slice(2)}`,
      projectTokenCount: 100n,
      terminalTokenAmount: 25n,
      metadata: zeroHash,
    };
    const claim = { token: TOKEN, leaf, proof: Array(32).fill(zeroHash) };
    const { service, sealed, receipt } = setup(
      planFor(OTHER, jbSuckerV6Abi, 'claim', [claim], 'bridge_claim'),
    );
    const log = (override = {}) =>
      eventLog(
        'event Claimed(bytes32 beneficiary,address token,uint256 projectTokenCount,uint256 terminalTokenAmount,uint256 index,bytes32 metadata,address caller)',
        { ...leaf, token: TOKEN, caller: ACCOUNT, ...override },
        OTHER,
      );
    receipt.logs = [log()];
    expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(true);
    receipt.logs = [log({ index: 11n })];
    expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(false);
    receipt.logs = [{ ...log(), address: TOKEN }];
    expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(false);
  });

  it('reports only source-side accounting send, without claiming remote delivery', async () => {
    const { service, sealed, receipt } = setup(
      planFor(OTHER, jbSuckerV6Abi, 'syncAccountingData', [], 'sync_accounting'),
    );
    receipt.logs = [
      eventLog(
        'event AccountingDataSynced(uint256 sourceTimestamp,address caller)',
        { sourceTimestamp: 123n, caller: ACCOUNT },
        OTHER,
      ),
    ];
    const result = await service.verify(params(sealed.token));
    expect(result.outcomeVerified).toBe(true);
    expect(result.steps[0]!.reason).toContain(
      'Destination delivery and freshness are not verified',
    );
  });

  it('requires canonical new-revnet creation, deployment, initialization and final ownership', async () => {
    const deployer = v6Address('REVDeployer', 1);
    const owner = v6Address('REVOwner', 1);
    const configuration = {
      description: { name: 'Revnet', ticker: 'REV', uri: 'ipfs://rev', salt: zeroHash },
      baseCurrency: 1,
      operator: ACCOUNT,
      scopeCashOutsToLocalBalances: false,
      stageConfigurations: [],
    };
    const suckerConfiguration = { deployerConfigurations: [], salt: zeroHash };
    const plan = planFor(
      deployer,
      revDeployerAbi,
      'deployFor',
      [0n, configuration, [], suckerConfiguration],
      'revnet_deploy',
    );
    delete plan.project;
    const { service, sealed, receipt } = setup(plan);
    receipt.logs = [
      abiLog(
        revDeployerAbi,
        'DeployRevnet',
        {
          revnetId: 12n,
          configuration,
          terminalConfigurations: [],
          suckerDeploymentConfiguration: suckerConfiguration,
          rulesetConfigurations: [],
          encodedConfigurationHash: HASH2,
          caller: ACCOUNT,
        },
        deployer,
      ),
      abiLog(
        jbProjectsAbi,
        'Create',
        { projectId: 12n, owner: deployer, caller: deployer },
        PROJECTS,
        1,
      ),
      abiLog(revOwnerAbi, 'InitializeRevnet', { revnetId: 12n, caller: deployer }, owner, 2),
      abiLog(jbProjectsAbi, 'Transfer', { from: deployer, to: owner, tokenId: 12n }, PROJECTS, 3),
    ];
    expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(true);
    receipt.logs.pop();
    expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(false);
  });

  it('verifies every NFT tier removal from the authenticated project hook', async () => {
    const plan = planFor(
      OTHER,
      jb721TiersHookAbi,
      'adjustTiers',
      [[], [1n, 2n]],
      '721_adjust_tiers',
    );
    plan.summary = { operation: '721_adjust_tiers', project: plan.project, hook: OTHER };
    const { service, sealed, receipt } = setup(plan);
    receipt.logs = [
      abiLog(jb721TiersHookAbi, 'RemoveTier', { tierId: 1n, caller: ACCOUNT }, OTHER),
      abiLog(jb721TiersHookAbi, 'RemoveTier', { tierId: 2n, caller: ACCOUNT }, OTHER, 1),
    ];
    expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(true);
    receipt.logs.pop();
    expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(false);
  });

  it('verifies the complete added NFT tier configuration, including economic flags', async () => {
    const tier = {
      price: 100n,
      initialSupply: 10,
      votingUnits: 0,
      reserveFrequency: 0,
      reserveBeneficiary: zeroAddress,
      encodedIpfsUri: zeroHash,
      category: 1,
      discountPercent: 0,
      flags: {
        allowOwnerMint: false,
        useReserveBeneficiaryAsDefault: false,
        transfersPausable: false,
        useVotingUnits: false,
        cantBeRemoved: false,
        cantIncreaseDiscountPercent: false,
        cantBuyWithCredits: false,
      },
      splitPercent: 0,
      splits: [],
    };
    const plan = planFor(OTHER, jb721TiersHookAbi, 'adjustTiers', [[tier], []], '721_adjust_tiers');
    plan.summary = { operation: '721_adjust_tiers', project: plan.project, hook: OTHER };
    const { service, sealed, receipt } = setup(plan);
    receipt.logs = [
      abiLog(jb721TiersHookAbi, 'AddTier', { tierId: 3n, tier, caller: ACCOUNT }, OTHER),
    ];
    expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(true);
    receipt.logs = [
      abiLog(
        jb721TiersHookAbi,
        'AddTier',
        {
          tierId: 3n,
          tier: { ...tier, flags: { ...tier.flags, allowOwnerMint: true } },
          caller: ACCOUNT,
        },
        OTHER,
      ),
    ];
    expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(false);
  });

  it('verifies factory NFT project launches using LaunchRulesets and the requested project-NFT owner', async () => {
    const factory = v6Address('JB721TiersHookProjectDeployer', 1);
    const hookDeployer = v6Address('JB721TiersHookDeployer', 1);
    const hookConfiguration = {
      name: 'Shop',
      symbol: 'SHOP',
      baseUri: 'ipfs://',
      tokenUriResolver: zeroAddress,
      contractUri: 'ipfs://shop',
      tiersConfig: { tiers: [], currency: 61166, decimals: 18 },
      flags: {
        noNewTiersWithReserves: false,
        noNewTiersWithVotes: false,
        noNewTiersWithOwnerMinting: false,
        preventOverspending: false,
        issueTokensForSplits: false,
      },
    };
    const launchConfiguration = {
      projectUri: 'ipfs://project',
      rulesetConfigurations: [],
      terminalConfigurations: [],
      memo: 'launch',
    };
    const plan = planFor(
      factory,
      jb721TiersHookProjectDeployerAbi,
      'launchProjectFor',
      [OTHER, hookConfiguration, launchConfiguration, CONTROLLER, zeroHash],
      '721_launch',
    );
    delete plan.project;
    const { service, sealed, receipt } = setup(plan);
    receipt.logs = [
      abiLog(
        jbProjectsAbi,
        'Create',
        { projectId: 12n, owner: factory, caller: factory },
        PROJECTS,
      ),
      abiLog(
        jb721TiersHookDeployerAbi,
        'HookDeployed',
        { projectId: 12n, hook: TOKEN, caller: factory },
        hookDeployer,
        1,
      ),
      abiLog(
        jbControllerAbi,
        'LaunchRulesets',
        {
          rulesetId: 100n,
          projectId: 12n,
          projectUri: 'ipfs://project',
          memo: 'launch',
          caller: factory,
        },
        CONTROLLER,
        2,
      ),
      abiLog(jbProjectsAbi, 'Transfer', { from: factory, to: OTHER, tokenId: 12n }, PROJECTS, 3),
    ];
    expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(true);
    receipt.logs[3] = abiLog(
      jbProjectsAbi,
      'Transfer',
      { from: factory, to: ACCOUNT, tokenId: 12n },
      PROJECTS,
      3,
    );
    expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(false);
  });

  it.each([...deploymentAddresses('JBBuybackHook', 1), OTHER])(
    'checks failed-sell evidence from recorded hook generations and excludes alien emitter %s',
    async (hook) => {
      const call: PreparedCall = {
        ...payCall(),
        data: encodeFunctionData({
          abi: jbMultiTerminalAbi,
          functionName: 'cashOutTokensOf',
          args: [ACCOUNT, 7n, 100n, TOKEN, 0n, OTHER, '0x'],
        }),
        decoded: {
          functionName: 'cashOutTokensOf',
          args: [ACCOUNT, '7', '100', TOKEN, '0', OTHER, '0x'],
        },
      };
      const { service, sealed, receipt } = setup(draft([call]));
      receipt.logs = [
        abiLog(
          jbMultiTerminalAbi,
          'CashOutTokens',
          {
            rulesetId: 1n,
            rulesetCycleNumber: 1n,
            projectId: 7n,
            holder: ACCOUNT,
            beneficiary: OTHER,
            cashOutCount: 100n,
            cashOutTaxRate: 0n,
            reclaimAmount: 0n,
            metadata: '0x',
            caller: ACCOUNT,
          },
          TERMINAL,
        ),
        abiLog(
          jbBuybackHookAbi,
          'SellSwapReverted',
          { projectId: 7n, holder: ACCOUNT, amount: 100n, caller: TERMINAL },
          hook,
          1,
        ),
      ];
      const result = await service.verify(params(sealed.token));
      expect(result.transactionConfirmed).toBe(true);
      expect(result.outcomeVerified).toBe(hook === OTHER);
      if (hook !== OTHER) expect(result.steps[0]!.reason).toContain('project tokens were returned');
      else
        expect(result.steps[0]!.outcome?.some((event) => event.event === 'SellSwapReverted')).toBe(
          false,
        );
    },
  );

  it('requires NFT Mint and ERC721 ownership Transfer, in addition to the payment event', async () => {
    const plan = {
      ...draft(),
      operation: '721_pay',
      summary: {
        operation: '721_pay',
        project: draft().project,
        hook: OTHER,
        beneficiary: ACCOUNT,
        tierIds: ['2'],
      },
    };
    const { service, sealed, receipt } = setup(plan);
    expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(false);
    receipt.logs.push(
      abiLog(
        jb721TiersHookAbi,
        'Mint',
        {
          tokenId: 2000000001n,
          tierId: 2n,
          beneficiary: ACCOUNT,
          totalAmountPaid: 100n,
          caller: TERMINAL,
        },
        OTHER,
        1,
      ),
    );
    expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(false);
    receipt.logs.push(
      abiLog(
        jb721TiersHookAbi,
        'Transfer',
        { from: zeroAddress, to: ACCOUNT, tokenId: 2000000001n },
        OTHER,
        2,
      ),
    );
    expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(true);
  });

  it('verifies canonical registry changes with the exact requested target', async () => {
    for (const [contract, abi, functionName, eventName, targetField] of [
      [
        'JBBuybackHookRegistry',
        jbBuybackHookRegistryAbi,
        'setHookFor',
        'JBBuybackHookRegistry_SetHook',
        'hook',
      ],
      [
        'JBRouterTerminalRegistry',
        jbRouterTerminalRegistryAbi,
        'setTerminalFor',
        'JBRouterTerminalRegistry_SetTerminal',
        'terminal',
      ],
    ] as const) {
      const target = v6Address(contract, 1);
      const { service, sealed, receipt } = setup(planFor(target, abi, functionName, [7n, OTHER]));
      receipt.logs = [
        abiLog(abi, eventName, { projectId: 7n, [targetField]: OTHER, caller: ACCOUNT }, target),
      ];
      expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(true);
      receipt.logs = [
        abiLog(abi, eventName, { projectId: 7n, [targetField]: TOKEN, caller: ACCOUNT }, target),
      ];
      expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(false);
    }
  });

  it.each(deploymentAddresses('JBBuybackHook', 1))(
    'verifies native-token TWAP windows on recorded hook %s using the exact emitter',
    async (hook) => {
      const { service, sealed, receipt } = setup(
        planFor(hook, jbBuybackHookAbi, 'setTwapWindowOf', [7n, NATIVE_TOKEN, 172800n]),
      );
      receipt.logs = [
        abiLog(
          jbBuybackHookAbi,
          'TwapWindowChanged',
          {
            projectId: 7n,
            terminalToken: zeroAddress,
            oldWindow: 1800n,
            newWindow: 172800n,
            caller: ACCOUNT,
          },
          hook,
        ),
      ];
      expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(true);
      receipt.logs = receipt.logs.map((log) => ({ ...log, address: OTHER }));
      expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(false);
    },
  );

  it.each(deploymentAddresses('JBBuybackHook', 1))(
    'verifies the pool-registration key and generation-specific TWAP sentinel on hook %s',
    async (hook) => {
      const key = {
        currency0: zeroAddress,
        currency1: TOKEN,
        fee: 10000,
        tickSpacing: 200,
        hooks: OTHER,
      };
      const plan = planFor(hook, jbBuybackHookAbi, 'setPoolFor', [
        7n,
        10000,
        200,
        172800n,
        NATIVE_TOKEN,
      ]);
      plan.summary = { key };
      const { service, sealed, receipt } = setup(plan);
      receipt.logs = [
        abiLog(
          jbBuybackHookAbi,
          'PoolAdded',
          {
            projectId: 7n,
            terminalToken: zeroAddress,
            poolId: uniswapV4PoolId(key),
            caller: ACCOUNT,
          },
          hook,
        ),
        abiLog(
          jbBuybackHookAbi,
          'TwapWindowChanged',
          {
            projectId: 7n,
            terminalToken: zeroAddress,
            oldWindow: 0n,
            newWindow: hook === deploymentAddress('JBBuybackHook', 1) ? 1800n : 172800n,
            caller: ACCOUNT,
          },
          hook,
          1,
        ),
      ];
      expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(true);
      receipt.logs[0] = abiLog(
        jbBuybackHookAbi,
        'PoolAdded',
        { projectId: 7n, terminalToken: zeroAddress, poolId: zeroHash, caller: ACCOUNT },
        hook,
      );
      expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(false);
    },
  );

  it('verifies queued rulesets without claiming that they are already active', async () => {
    const { service, sealed, receipt } = setup(
      planFor(CONTROLLER, jbControllerAbi, 'queueRulesetsOf', [7n, [], 'reviewed']),
    );
    receipt.logs = [
      abiLog(
        jbControllerAbi,
        'QueueRulesets',
        { rulesetId: 123n, projectId: 7n, memo: 'reviewed', caller: ACCOUNT },
        CONTROLLER,
      ),
    ];
    const result = await service.verify(params(sealed.token));
    expect(result.outcomeVerified).toBe(true);
    expect(result.steps[0]!.reason).toContain('does not assert approval or activation');
  });

  it.each([
    ...deploymentAddresses('JBRouterTerminal', 1),
    ...deploymentAddresses('JBRouterTerminalGateway', 1),
    v6Address('JBRouterTerminalRegistry', 1),
  ])(
    'verifies routed payments through recorded target %s using the canonical immediate caller as payer',
    async (target) => {
      const router = deploymentAddresses('JBRouterTerminal', 1).includes(target)
        ? target
        : deploymentAddress('JBRouterTerminal', 1)!;
      const { service, sealed, receipt } = setup(draft([{ ...payCall(), to: target }]));
      receipt.logs = [payLog({ caller: router, payer: router })];
      expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(true);
      receipt.logs = [payLog({ caller: OTHER, payer: OTHER })];
      expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(false);
      receipt.logs = [payLog({ caller: router, payer: ACCOUNT })];
      expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(false);
      receipt.logs = [payLog({ caller: router, payer: router }, OTHER)];
      expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(false);
      receipt.logs = [];
      expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(false);
    },
  );

  it('does not verify a copied routed-payment event for an unrecorded outer target', async () => {
    const { service, sealed, receipt } = setup(draft([{ ...payCall(), to: OTHER }]));
    const router = deploymentAddress('JBRouterTerminal', 1)!;
    receipt.logs = [payLog({ caller: router, payer: router })];
    expect((await service.verify(params(sealed.token))).outcomeVerified).toBe(false);
  });
});
