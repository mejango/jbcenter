const RPC_METHODS: ReadonlySet<string> = new Set([
  "eth_blobBaseFee",
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_createAccessList",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getBlockReceipts",
  "eth_getBlockTransactionCountByHash",
  "eth_getBlockTransactionCountByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getProof",
  "eth_getStorageAt",
  "eth_getTransactionByBlockHashAndIndex",
  "eth_getTransactionByBlockNumberAndIndex",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "eth_simulateV1",
  "eth_syncing",
  "net_version",
] as const);

const BLOCK_QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/iu;
const MAX_LOG_BLOCK_RANGE = 50_000n;
export const RPC_BODY_LIMIT = 256 * 1024;
export const RPC_RESPONSE_LIMIT = 5 * 1024 * 1024;
// Two upstreams must fit inside the SDK's 15-second request budget. A slow
// provider should trigger failover before one read disables an entire UI.
export const RPC_TIMEOUT_MS = 4_000;
// One block of a handful of dependent calls (approve, then spend) is what a
// wallet flow needs; anything wider is a tracing workload, not a read.
export const MAX_SIMULATE_CALLS = 16;
// Codes a node returns for a method it does not implement; the next upstream
// may. Any other error is the answer.
const UNSUPPORTED_METHOD_CODES = new Set([-32601, -32004]);

type RpcId = number | string;

export type RpcRequest = {
  jsonrpc: "2.0";
  id: RpcId;
  method: string;
  params?: readonly unknown[];
};

export type RpcUpstreams = ReadonlyMap<number, readonly string[]>;

export type RpcGateway = {
  request(chainId: number, request: RpcRequest): Promise<unknown>;
  supports(chainId: number): boolean;
};

export class RpcBadRequest extends Error {}
export class RpcUnavailable extends Error {}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const DWELLIR_RPC_HOSTS: Readonly<Record<number, string>> = {
  1: "api-ethereum-mainnet.n.dwellir.com",
  10: "api-optimism-mainnet-archive.n.dwellir.com",
  8453: "api-base-mainnet-archive.n.dwellir.com",
  42161: "api-arbitrum-mainnet-archive.n.dwellir.com",
  84532: "api-base-sepolia-archive.n.dwellir.com",
  421614: "api-arbitrum-sepolia.n.dwellir.com",
  11155111: "api-ethereum-sepolia.n.dwellir.com",
  11155420: "api-optimism-sepolia.n.dwellir.com",
};

export const PUBLICNODE_RPC_URLS: Readonly<Record<number, string>> = {
  1: "https://ethereum-rpc.publicnode.com",
  10: "https://optimism-rpc.publicnode.com",
  8453: "https://base-rpc.publicnode.com",
  42161: "https://arbitrum-one-rpc.publicnode.com",
  84532: "https://base-sepolia-rpc.publicnode.com",
  421614: "https://arbitrum-sepolia-rpc.publicnode.com",
  11155111: "https://ethereum-sepolia-rpc.publicnode.com",
  11155420: "https://optimism-sepolia-rpc.publicnode.com",
};

export function dwellirRpcUpstreams(apiKey: string | undefined): RpcUpstreams {
  if (!apiKey || !/^[a-z0-9_-]{16,128}$/iu.test(apiKey)) {
    throw new Error("DWELLIR_API_KEY must be a 16-128 character URL-safe secret");
  }
  return new Map(
    Object.entries(DWELLIR_RPC_HOSTS).map(([chainId, host]) => [
      Number(chainId),
      [`https://${host}/${apiKey}`, PUBLICNODE_RPC_URLS[Number(chainId)]!],
    ]),
  );
}

function validId(value: unknown): value is RpcId {
  return (
    (Number.isSafeInteger(value) && Number(value) >= 0) ||
    (typeof value === "string" && value.length >= 1 && value.length <= 128)
  );
}

function validateSimulate(params: readonly unknown[]): void {
  const [payload] = params;
  if (!record(payload) || !Array.isArray(payload.blockStateCalls)) {
    throw new RpcBadRequest("eth_simulateV1 requires one blockStateCalls object");
  }
  if (payload.blockStateCalls.length !== 1) {
    throw new RpcBadRequest("eth_simulateV1 simulates exactly one block");
  }
  const block: unknown = payload.blockStateCalls[0];
  if (!record(block) || !Array.isArray(block.calls) || block.calls.length === 0) {
    throw new RpcBadRequest("eth_simulateV1 block requires a calls array");
  }
  if (block.calls.length > MAX_SIMULATE_CALLS) {
    throw new RpcBadRequest(`eth_simulateV1 block must not exceed ${MAX_SIMULATE_CALLS} calls`);
  }
}

function validateLogs(params: readonly unknown[]): void {
  const filter = params[0];
  if (!record(filter)) throw new RpcBadRequest("eth_getLogs requires one filter object");
  if (typeof filter.blockHash === "string") {
    if (!/^0x[0-9a-f]{64}$/iu.test(filter.blockHash)) {
      throw new RpcBadRequest("eth_getLogs blockHash is invalid");
    }
    if (filter.fromBlock !== undefined || filter.toBlock !== undefined) {
      throw new RpcBadRequest("eth_getLogs cannot mix blockHash with a block range");
    }
    return;
  }
  const from = filter.fromBlock;
  const to = filter.toBlock;
  if (from === "latest" && (to === undefined || to === "latest")) return;
  if (typeof from !== "string" || typeof to !== "string") {
    throw new RpcBadRequest("eth_getLogs requires a bounded block range");
  }
  if (!BLOCK_QUANTITY.test(from) || !BLOCK_QUANTITY.test(to)) {
    throw new RpcBadRequest("eth_getLogs block range must use hexadecimal quantities");
  }
  const start = BigInt(from);
  const end = BigInt(to);
  if (end < start || end - start > MAX_LOG_BLOCK_RANGE) {
    throw new RpcBadRequest(`eth_getLogs range must not exceed ${MAX_LOG_BLOCK_RANGE} blocks`);
  }
}

export function parseRpcRequest(value: unknown): RpcRequest {
  if (Array.isArray(value)) throw new RpcBadRequest("JSON-RPC batches are not supported");
  if (!record(value)) throw new RpcBadRequest("JSON-RPC request must be an object");
  if (value.jsonrpc !== "2.0" || !validId(value.id)) {
    throw new RpcBadRequest("JSON-RPC version or id is invalid");
  }
  if (typeof value.method !== "string" || !RPC_METHODS.has(value.method)) {
    throw new RpcBadRequest("JSON-RPC method is not allowed");
  }
  if (value.params !== undefined && (!Array.isArray(value.params) || value.params.length > 32)) {
    throw new RpcBadRequest("JSON-RPC params must be an array with at most 32 entries");
  }
  const request = {
    jsonrpc: "2.0" as const,
    id: value.id,
    method: value.method,
    ...(value.params === undefined ? {} : { params: value.params }),
  };
  if (request.method === "eth_getLogs") validateLogs(request.params ?? []);
  if (request.method === "eth_simulateV1") validateSimulate(request.params ?? []);
  return request;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (!Number.isFinite(declared) || declared < 0 || declared > RPC_RESPONSE_LIMIT) {
    throw new RpcUnavailable("RPC upstream response is too large");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > RPC_RESPONSE_LIMIT) {
    throw new RpcUnavailable("RPC upstream response is too large");
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RpcUnavailable("RPC upstream returned invalid JSON");
  }
}

function normalizeResponse(value: unknown, id: RpcId): Record<string, unknown> | null {
  if (!record(value) || value.jsonrpc !== "2.0" || value.id !== id) return null;
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  if (hasResult === hasError) return null;
  if (hasResult) return { jsonrpc: "2.0", id, result: value.result };
  if (!record(value.error) || !Number.isSafeInteger(value.error.code)) return null;
  const data = value.error.data;
  const safeData =
    typeof data === "string" && data.length <= 131_074 && /^0x(?:[0-9a-f]{2})*$/iu.test(data)
      ? data
      : undefined;
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: value.error.code,
      message: "RPC request failed",
      ...(safeData ? { data: safeData } : {}),
    },
  };
}

export function createRpcGateway(
  upstreams: RpcUpstreams,
  fetcher: typeof fetch = fetch,
): RpcGateway {
  return {
    supports(chainId) {
      return upstreams.has(chainId);
    },
    async request(chainId, request) {
      const urls = upstreams.get(chainId);
      if (!urls) throw new RpcBadRequest("RPC chain is not supported");
      const body = JSON.stringify(request);
      let lastError: unknown;
      for (const url of urls) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
        try {
          const response = await fetcher(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            redirect: "error",
            signal: controller.signal,
          });
          if (!response.ok) {
            await response.body?.cancel();
            lastError = new Error(`upstream status ${response.status}`);
            continue;
          }
          const value = normalizeResponse(await boundedJson(response), request.id);
          if (!value) {
            lastError = new Error("invalid upstream envelope");
            continue;
          }
          if (
            request.method === "eth_chainId" &&
            value.result !== `0x${chainId.toString(16)}`
          ) {
            lastError = new Error("upstream chain mismatch");
            continue;
          }
          if (record(value.error) && UNSUPPORTED_METHOD_CODES.has(Number(value.error.code))) {
            lastError = new Error("upstream does not implement the method");
            continue;
          }
          return value;
        } catch (error) {
          lastError = error;
        } finally {
          clearTimeout(timeout);
        }
      }
      void lastError;
      throw new RpcUnavailable("RPC upstreams are unavailable");
    },
  };
}
