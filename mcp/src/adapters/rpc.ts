import { createPublicClient, custom, numberToHex, type Hex, type PublicClient } from 'viem';
import {
  mainnet,
  optimism,
  base,
  arbitrum,
  sepolia,
  optimismSepolia,
  baseSepolia,
  arbitrumSepolia,
} from '@bananapus/nana-sdk-core/chains';
import { z } from 'zod';
import { fetchJson } from './http.js';
import { DomainError } from '../domain/errors.js';
import type { ChainId, RpcProvider, RpcSnapshot } from '../domain/types.js';

export const CHAINS = [
  mainnet,
  optimism,
  base,
  arbitrum,
  sepolia,
  optimismSepolia,
  baseSepolia,
  arbitrumSepolia,
];
const responseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.number(),
  result: z.unknown().optional(),
  error: z
    .object({ code: z.number(), message: z.string(), data: z.unknown().optional() })
    .optional(),
});
const READ_METHODS = new Set([
  'eth_call',
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBalance',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getLogs',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
]);

/** Replace implicit latest with one observed block for every nested SDK eth_call. */
export function pinRpcParameters(
  method: string,
  parameters: readonly unknown[],
  blockNumber: bigint,
  blockHash?: Hex,
): unknown[] {
  const params = [...parameters];
  const index =
    method === 'eth_getStorageAt'
      ? 2
      : ['eth_call', 'eth_getBalance', 'eth_getCode', 'eth_estimateGas'].includes(method)
        ? 1
        : method === 'eth_getBlockByNumber'
          ? 0
          : -1;
  if (index >= 0) {
    const requested = params[index];
    // Callers cannot accidentally escape the snapshot by providing pending/latest.
    if (
      !(
        requested === undefined ||
        requested === 'latest' ||
        requested === 'pending' ||
        requested === 'safe' ||
        requested === 'finalized' ||
        requested === numberToHex(blockNumber)
      )
    )
      throw new DomainError(
        'SNAPSHOT_CONFLICT',
        'This read requested a block outside its pinned snapshot.',
      );
    // EIP-1898 binds state reads to the same canonical block even during a reorg.
    params[index] =
      blockHash &&
      ['eth_call', 'eth_getBalance', 'eth_getCode', 'eth_getStorageAt'].includes(method)
        ? { blockHash, requireCanonical: true }
        : numberToHex(blockNumber);
  }
  return params;
}

export class RpcPool implements RpcProvider {
  private readonly clients = new Map<ChainId, PublicClient>();
  private requestId = 0;
  constructor(
    private readonly urls: Partial<Record<ChainId, string>>,
    private readonly fetcher: typeof fetchJson = fetchJson,
  ) {}

  private makeClient(chainId: ChainId, blockNumber?: bigint, blockHash?: Hex): PublicClient {
    const chain = CHAINS.find((value) => value.id === chainId);
    const url = this.urls[chainId];
    if (!chain || !url)
      throw new DomainError('CHAIN_UNAVAILABLE', 'This chain has no configured RPC endpoint.');
    return createPublicClient({
      chain,
      cacheTime: 0,
      batch: { multicall: false },
      transport: custom(
        {
          request: async ({ method, params }) => {
            if (!READ_METHODS.has(method))
              throw new DomainError(
                'RPC_METHOD_FORBIDDEN',
                'Only bounded read and simulation methods are available.',
              );
            if (blockNumber !== undefined && method === 'eth_blockNumber')
              return numberToHex(blockNumber);
            const parameters =
              blockNumber === undefined
                ? [...(params ?? [])]
                : pinRpcParameters(method, params ?? [], blockNumber, blockHash);
            if (method === 'eth_call' || method === 'eth_estimateGas') {
              const call = parameters[0];
              if (typeof call !== 'object' || call === null || Array.isArray(call))
                throw new DomainError('RPC_INVALID_CALL', 'Invalid simulation call.');
              const gas = (call as { gas?: unknown }).gas;
              if (gas !== undefined && (typeof gas !== 'string' || !/^0x[0-9a-f]+$/i.test(gas)))
                throw new DomainError('RPC_INVALID_CALL', 'Invalid simulation gas limit.');
              const requested = gas === undefined ? 30_000_000n : BigInt(gas as string);
              parameters[0] = {
                ...call,
                gas: numberToHex(requested > 30_000_000n ? 30_000_000n : requested),
              };
            }
            if (method === 'eth_getLogs') {
              const filter = parameters[0] as
                | { fromBlock?: string; toBlock?: string; blockHash?: string }
                | undefined;
              if (!filter?.blockHash) {
                if (
                  !filter?.fromBlock ||
                  !filter.toBlock ||
                  !/^0x[0-9a-f]+$/i.test(filter.fromBlock) ||
                  !/^0x[0-9a-f]+$/i.test(filter.toBlock)
                )
                  throw new DomainError(
                    'LOG_RANGE_REQUIRED',
                    'Log reads require explicit start and end blocks.',
                  );
                const range = BigInt(filter.toBlock) - BigInt(filter.fromBlock);
                if (range < 0n || range > 50_000n)
                  throw new DomainError(
                    'LOG_RANGE_TOO_LARGE',
                    'Read logs in ranges of at most 50,000 blocks.',
                  );
                if (blockNumber !== undefined && BigInt(filter.toBlock) > blockNumber)
                  throw new DomainError(
                    'SNAPSHOT_CONFLICT',
                    'Log history cannot extend beyond its snapshot block.',
                  );
              }
            }
            const id = ++this.requestId;
            const result = responseSchema.safeParse(
              await this.fetcher(url, {
                method: 'POST',
                body: { jsonrpc: '2.0', id, method, params: parameters },
                timeoutMs: 12_000,
                maxBytes: 5 * 1024 * 1024,
              }),
            );
            if (
              !result.success ||
              result.data.id !== id ||
              !!result.data.error === Object.hasOwn(result.data, 'result')
            )
              throw new DomainError(
                'RPC_INVALID_RESPONSE',
                'The RPC returned an invalid or mismatched response.',
              );
            if (result.data.error) {
              // viem needs a JSON-RPC code/data to classify contract reverts. Never forward messages/URLs.
              const data = result.data.error.data;
              throw Object.assign(new Error('RPC request failed.'), {
                code: result.data.error.code,
                ...(typeof data === 'string' && /^0x[0-9a-f]*$/i.test(data) && data.length < 65538
                  ? { data }
                  : {}),
              });
            }
            if (method === 'eth_getLogs' && blockNumber !== undefined && blockHash !== undefined) {
              const canonical = await this.client(chainId).getBlock({ blockNumber });
              if (canonical.hash?.toLowerCase() !== blockHash.toLowerCase())
                throw new DomainError(
                  'CHAIN_REORG',
                  'The snapshot changed while reading event history. Retry the read.',
                  { retryable: true },
                );
            }
            return result.data.result;
          },
        },
        { retryCount: 0 },
      ),
    }) as PublicClient;
  }

  client(chainId: ChainId): PublicClient {
    let client = this.clients.get(chainId);
    if (!client) {
      client = this.makeClient(chainId);
      this.clients.set(chainId, client);
    }
    return client;
  }

  async snapshot(chainId: ChainId, blockNumber?: bigint): Promise<RpcSnapshot> {
    const client = this.client(chainId);
    const [reportedChain, block] = await Promise.all([
      client.getChainId(),
      client.getBlock(blockNumber === undefined ? { blockTag: 'latest' } : { blockNumber }),
    ]);
    if (reportedChain !== chainId)
      throw new DomainError('RPC_CHAIN_MISMATCH', 'The configured RPC returned a different chain.');
    if (block.number === null || block.hash === null)
      throw new DomainError('BLOCK_UNAVAILABLE', 'The RPC did not return a mined block.');
    return {
      client: this.makeClient(chainId, block.number, block.hash),
      evidence: {
        source: 'rpc',
        chainId,
        blockNumber: block.number.toString(),
        blockHash: block.hash,
        timestamp: block.timestamp.toString(),
      },
    };
  }
}
