import { describe, expect, it, vi } from 'vitest';
import { encodeErrorResult, erc20Abi, encodeFunctionResult, type Hex } from 'viem';
import { RpcPool, nativeBalanceRefusal, pinRpcParameters } from '../../src/adapters/rpc.js';
import type { fetchJson } from '../../src/adapters/http.js';
import { publicError } from '../../src/domain/errors.js';

const hash = `0x${'ab'.repeat(32)}` as Hex;
const address = `0x${'12'.repeat(20)}` as Hex;
function fixture(chainId = '0x1') {
  const calls: { method: string; params: unknown[] }[] = [];
  const fetcher: typeof fetchJson = vi.fn(async (_url, options) => {
    const request = options!.body as { id: number; method: string; params: unknown[] };
    calls.push(request);
    const result =
      request.method === 'eth_chainId'
        ? chainId
        : request.method === 'eth_getBlockByNumber'
          ? {
              number: '0xa',
              hash,
              timestamp: '0x64',
              transactions: [],
              gasLimit: '0x1c9c380',
              gasUsed: '0x0',
              difficulty: '0x0',
              size: '0x1',
              extraData: '0x',
            }
          : request.method === 'eth_call'
            ? encodeFunctionResult({
                abi: erc20Abi,
                functionName: 'balanceOf',
                result: 9007199254740993n,
              })
            : request.method === 'eth_getBalance'
              ? '0x20000000000001'
              : [];
    return { jsonrpc: '2.0', id: request.id, result };
  });
  return { pool: new RpcPool({ 1: 'https://rpc.example/private' }, fetcher), calls, fetcher };
}
describe('RPC snapshots', () => {
  it('pins nested SDK reads to one canonical block hash and preserves large integers', async () => {
    const { pool, calls } = fixture();
    const snapshot = await pool.snapshot(1);
    const value = await snapshot.client.readContract({
      address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [address],
    });
    expect(value).toBe(9007199254740993n);
    expect(snapshot.evidence).toEqual({
      chainId: 1,
      source: 'rpc',
      blockNumber: '10',
      blockHash: hash,
      timestamp: '100',
    });
    const call = calls.find((call) => call.method === 'eth_call')!;
    expect(call.params[1]).toEqual({ blockHash: hash, requireCanonical: true });
    expect(call.params[0]).toMatchObject({ gas: '0x1c9c380' });
  });
  it('fails closed on a misconfigured chain', async () => {
    await expect(fixture('0xa').pool.snapshot(1)).rejects.toMatchObject({
      code: 'RPC_CHAIN_MISMATCH',
    });
  });
  it('does not let an explicit conflicting block escape a snapshot', () => {
    expect(() => pinRpcParameters('eth_call', [{}, '0xb'], 10n, hash)).toThrow(
      'outside its pinned snapshot',
    );
    expect(pinRpcParameters('eth_getStorageAt', [address, '0x0', 'latest'], 10n, hash)[2]).toEqual({
      blockHash: hash,
      requireCanonical: true,
    });
    expect(pinRpcParameters('eth_estimateGas', [{}], 10n, hash)[1]).toBe('0xa');
  });
  it('rejects unbounded historical log scans before hitting upstream', async () => {
    const { pool, fetcher } = fixture();
    await expect(
      pool.client(1).getLogs({ address, fromBlock: 0n, toBlock: 50001n }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('pins eth_simulateV1 to the snapshot block and refuses overrides', async () => {
    const { pool, calls } = fixture();
    const snapshot = await pool.snapshot(1);
    const call = { from: address, to: address, data: '0x', value: '0x0' };
    const simulate = (block: object) =>
      snapshot.client.request({
        method: 'eth_simulateV1',
        params: [{ blockStateCalls: [block], validation: false }, 'latest'],
      } as never);
    await simulate({ calls: [call] });
    expect(calls.find((item) => item.method === 'eth_simulateV1')!.params[1]).toBe('0xa');
    const sent = calls.length;
    for (const block of [
      { calls: [call], stateOverrides: { [address]: { balance: '0x1' } } },
      { calls: [call], blockOverrides: { time: '0x1' } },
      { calls: [{ ...call, gas: '0xffffffffff' }] },
      { calls: Array(17).fill(call) },
    ])
      await expect(simulate(block)).rejects.toMatchObject({ cause: { code: 'RPC_INVALID_CALL' } });
    await expect(
      snapshot.client.request({
        method: 'eth_simulateV1',
        params: [{ blockStateCalls: [{ calls: [call] }, { calls: [call] }] }, 'latest'],
      } as never),
    ).rejects.toMatchObject({ cause: { code: 'RPC_INVALID_CALL' } });
    expect(calls.length).toBe(sent);
  });
  // What a payer sees after the node answers `error` to an eth_call or eth_estimateGas.
  async function nodeAnswer(
    error: { code: number; message: string; data?: string },
    run: 'call' | 'estimateGas' = 'call',
  ) {
    const pool = new RpcPool({ 1: 'https://rpc.example/secret-key' }, async (_url, options) => ({
      jsonrpc: '2.0',
      id: (options!.body as { id: number }).id,
      error,
    }));
    const caught = await pool
      .client(1)
      [run]({ account: address, to: address, value: 1n })
      .catch((thrown: unknown) => thrown);
    const result = publicError(caught);
    expect(JSON.stringify(result)).not.toMatch(/secret-key|9999|ERC20/);
    return result;
  }
  it.each([
    [-32000, 'insufficient funds for gas * price + value: balance 0', 'call'],
    [-32000, 'insufficient funds for transfer', 'estimateGas'],
    [-32003, 'EVM error: OutOfFunds', 'call'],
    [-32003, 'EVM error: OutOfFunds', 'estimateGas'],
  ] as const)(
    'names an underfunded payer (node code %i, %s) without forwarding node text',
    async (code, message, run) => {
      expect(
        await nodeAnswer({ code, message: `${message} from 0x${'99'.repeat(20)}` }, run),
      ).toMatchObject({ code: 'INSUFFICIENT_FUNDS', retryable: false });
    },
  );
  it('withholds a decoded string argument even when it looks like hex', async () => {
    const secret = `0x${'abcdef1234567890'.repeat(4)}`;
    const data = encodeErrorResult({
      abi: [{ type: 'error', name: 'StringTooLong', inputs: [{ name: 'str', type: 'string' }] }],
      errorName: 'StringTooLong',
      args: [secret],
    });
    const result = await nodeAnswer({ code: 3, message: 'execution reverted', data });
    expect(result).toMatchObject({
      code: 'CALL_REVERTED',
      details: { errorName: 'StringTooLong', args: ['[text withheld]'] },
    });
    expect(JSON.stringify(result)).not.toContain('abcdef1234567890');
  });
  it('never calls a contract revert, a provider failure or a URL an underfunded payer', async () => {
    const reason = encodeErrorResult({
      abi: [{ type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] }],
      errorName: 'Error',
      args: ['ERC20: insufficient funds'],
    });
    expect(
      await nodeAnswer({
        code: 3,
        message: 'execution reverted: ERC20: insufficient funds',
        data: reason,
      }),
    ).toMatchObject({ code: 'CALL_REVERTED', retryable: false });
    for (const error of [
      { code: -32000, message: 'execution reverted: ERC20: insufficient funds' },
      { code: -32603, message: 'insufficient funds for gas * price + value' },
      { code: -32603, message: 'EVM error: OutOfFunds' },
      { code: -32000, message: 'request to https://rpc.example/OutOfFunds failed' },
      { code: -32000, message: 'upstream said: insufficient funds for gas * price + value' },
    ])
      expect(await nodeAnswer(error)).toMatchObject({ code: 'UPSTREAM_FAILURE', retryable: true });
    // Reads are never a payer's funding problem.
    expect(
      nativeBalanceRefusal('eth_getBalance', {
        code: -32000,
        message: 'insufficient funds for transfer',
      }),
    ).toBe(false);
  });
  it('rejects a mismatched RPC response id', async () => {
    const pool = new RpcPool({ 1: 'https://rpc.example' }, async () => ({
      jsonrpc: '2.0',
      id: -1,
      result: '0x1',
    }));
    await expect(pool.client(1).getChainId()).rejects.toThrow();
  });
  it('rejects log history if its snapshot was reorged during the range read', async () => {
    let blockReads = 0;
    const fetcher: typeof fetchJson = async (_url, options) => {
      const request = options!.body as { id: number; method: string };
      const result =
        request.method === 'eth_chainId'
          ? '0x1'
          : request.method === 'eth_getBlockByNumber'
            ? {
                number: '0xa',
                hash: ++blockReads === 1 ? hash : `0x${'cd'.repeat(32)}`,
                timestamp: '0x64',
                transactions: [],
                gasLimit: '0x0',
                gasUsed: '0x0',
                difficulty: '0x0',
                size: '0x1',
                extraData: '0x',
              }
            : [];
      return { jsonrpc: '2.0', id: request.id, result };
    };
    const snapshot = await new RpcPool({ 1: 'https://rpc.example' }, fetcher).snapshot(1);
    await expect(
      snapshot.client.getLogs({ address, fromBlock: 1n, toBlock: 10n }),
    ).rejects.toThrow();
    expect(blockReads).toBe(2);
  });
});
