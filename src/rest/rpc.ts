import {
  createRpcGateway,
  parseRpcRequest,
  RPC_BODY_LIMIT,
  type RpcGateway,
  type RpcUpstreams,
} from "../rpc.js";
import { RestError, type RestRpc } from "./core.js";

export class RestRpcError extends RestError {
  constructor(
    code: string,
    message: string,
    readonly rpcCode?: number,
    readonly data?: `0x${string}`,
  ) {
    super(502, code, message, {
      ...(rpcCode === undefined ? {} : { rpcCode }),
      ...(data === undefined ? {} : { revertData: data }),
    });
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function result(envelope: unknown): unknown {
  if (!record(envelope)) throw new RestRpcError("RPC_INVALID_RESPONSE", "RPC response is invalid");
  if (record(envelope.error)) {
    throw new RestRpcError(
      "RPC_REJECTED",
      "The configured RPC rejected the request",
      Number(envelope.error.code),
      typeof envelope.error.data === "string" ? (envelope.error.data as `0x${string}`) : undefined,
    );
  }
  if (!Object.hasOwn(envelope, "result"))
    throw new RestRpcError("RPC_INVALID_RESPONSE", "RPC response has no result");
  return envelope.result;
}

/** Private application adapter. There is deliberately no public arbitrary RPC route here. */
export function createRestRpc(options: {
  upstreams: RpcUpstreams;
  fetcher?: typeof fetch;
  /** Shared durable site quota, charged for each upstream request including chain verification. */
  consume?: () => Promise<void>;
}): RestRpc {
  const gateways = new Map<number, { verifiedUntil: number; verifying: Promise<boolean> | null; reads: RpcGateway }[]>();
  const verificationWindowMs = 60_000;
  for (const [chain, urls] of options.upstreams) {
    if (!Number.isSafeInteger(chain) || chain <= 0 || !urls.length)
      throw new Error("Invalid REST RPC configuration");
    gateways.set(
      chain,
      urls.map((url) => {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
          throw new Error("REST RPC upstreams must use HTTPS without credentials in userinfo");
        }
        const upstream = new Map([[chain, [url]]]);
        return {
          // The endpoint's chain, once verified, holds for a minute: an endpoint does not change
          // chains between calls, and a failed read drops the verification so the next call checks.
          verifiedUntil: 0,
          verifying: null,
          reads: createRpcGateway(upstream, options.fetcher),

        };
      }),
    );
  }
  let sequence = 0;
  const nextId = () => ++sequence;
  return {
    async request(chainId, method, params, signal) {
      signal?.throwIfAborted();
      const candidates = gateways.get(chainId);
      if (!candidates)
        throw new RestError(400, "UNSUPPORTED_CHAIN", "The requested chain is not configured");
      params = structuredClone(params);
      const request = {
        jsonrpc: "2.0" as const,
        id: nextId(),
        method,
        params,
      };
      try { parseRpcRequest(request); }
      catch { throw new RestError(400, "RPC_METHOD_NOT_ALLOWED", "Only bounded read RPC methods are supported"); }
      if (Buffer.byteLength(JSON.stringify(request)) > RPC_BODY_LIMIT) {
        throw new RestError(413, "RPC_REQUEST_TOO_LARGE", "The RPC request exceeds its size limit");
      }
      for (const candidate of candidates) {
        signal?.throwIfAborted();
        // Check the same configured endpoint that will receive the actual call.
        // A verified chain ID on a different failover endpoint is insufficient.
        if (candidate.verifiedUntil <= Date.now()) {
          try {
            // Concurrent callers share one probe, so it runs under the gateway's own timeout
            // rather than the first caller's signal; each caller checks its own signal after.
            candidate.verifying ??= (async () => {
              await options.consume?.();
              const observed = result(
                await candidate.reads.request(
                  chainId,
                  { jsonrpc: "2.0", id: nextId(), method: "eth_chainId", params: [] },
                ),
              );
              return observed === `0x${chainId.toString(16)}`;
            })().finally(() => { candidate.verifying = null; });
            const verified = await candidate.verifying;
            signal?.throwIfAborted();
            if (!verified) continue;
            candidate.verifiedUntil = Date.now() + verificationWindowMs;
          } catch (error) {
            signal?.throwIfAborted();
            if (error instanceof RestError && error.status === 429) throw error;
            continue;
          }
        }
        await options.consume?.();
        try {
          return result(
            await candidate.reads.request(chainId, request, signal),
          );
        } catch (error) {
          signal?.throwIfAborted();
          // A JSON-RPC error is an answer from the right chain; anything else is re-verified.
          if (error instanceof RestRpcError) throw error;
          candidate.verifiedUntil = 0;

        }
      }
      throw new RestRpcError(
        "RPC_UNAVAILABLE",
        "No verified RPC upstream could complete the request",
      );
    },
  };
}
