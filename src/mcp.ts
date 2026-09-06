import {
  CenterClient,
  DomainError,
  consumeRequest,
  createServices,
  loadConfig,
  type Config,
  type FetchJsonOptions,
  type PinProjectMetadataJson,
  type Services,
} from "@juicebox/mcp/host";
import { originsForEnvironment } from "./app.js";
import { isIpfsCid, type PinningService } from "./ipfs.js";
import {
  parseRpcRequest,
  RPC_BODY_LIMIT,
  RPC_RESPONSE_LIMIT,
  RpcBadRequest,
  type RpcGateway,
} from "./rpc.js";
import type { Store } from "./store.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const METADATA_LIMIT = 64 * 1024;
const READ_RESPONSE_LIMIT = 2 * 1024 * 1024;

export const MCP_BACKEND_LIMITS = {
  readsPerMinute: 600,
  rpcPerMinute: 5_000,
  rpcSitePerMinute: 20_000,
  pinsPerWindow: 10,
  pinsSitePerWindow: 200,
  pinWindowSeconds: 600,
} as const;

function invalidRequest(): never {
  throw new DomainError(
    "INVALID_INPUT",
    "This internal backend route or request is not supported.",
  );
}

function cancelled(): DomainError {
  return new DomainError(
    "UPSTREAM_TIMEOUT",
    "The upstream operation was cancelled or timed out.",
    {
      retryable: true,
    },
  );
}

function signalFor(options: FetchJsonOptions): AbortSignal {
  const timeout = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000)
    invalidRequest();
  const contextSignal = consumeRequest();
  return AbortSignal.any([
    AbortSignal.timeout(timeout),
    ...[options.signal, contextSignal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    ),
  ]);
}

/** Stop waiting on a disconnected tool, and never start the next backend operation after abort. */
async function cancellable<T>(
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw cancelled();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(cancelled());
    signal.addEventListener("abort", abort, { once: true });
    // Store has no cancellation parameter. An already-started query finishes there,
    // but a cancelled tool cannot start further backend work through this bridge.
    void Promise.resolve()
      .then(() => {
        if (signal.aborted) throw cancelled();
        return work();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

async function quota(
  store: Store,
  key: string,
  limit: number,
  windowSeconds: number,
  signal: AbortSignal,
): Promise<void> {
  const budget = await cancellable(signal, () =>
    store.consumeRequest(key, limit, windowSeconds),
  );
  if (!budget.allowed) {
    throw new DomainError(
      "RATE_LIMITED",
      "The shared MCP backend budget is spent. Retry later.",
      {
        retryable: true,
        details: { retryAfterSeconds: windowSeconds },
      },
    );
  }
}

function safeFailure(error: unknown, signal: AbortSignal): never {
  if (signal.aborted) throw cancelled();
  if (error instanceof DomainError) throw error;
  throw new DomainError(
    "UPSTREAM_UNAVAILABLE",
    "The configured backend could not complete the operation.",
    {
      retryable: true,
    },
  );
}

function boundedResult(
  value: unknown,
  requestedLimit: number | undefined,
  maximum: number,
): unknown {
  const limit = requestedLimit ?? maximum;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum)
    invalidRequest();
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new DomainError(
      "UPSTREAM_INVALID_RESPONSE",
      "The backend returned an invalid JSON result.",
    );
  }
  if (Buffer.byteLength(encoded) > limit) {
    throw new DomainError(
      "UPSTREAM_RESPONSE_TOO_LARGE",
      "The backend response exceeded its size limit. Narrow the query.",
    );
  }
  // Match an actual HTTP JSON boundary (plain values, no shared mutable store objects).
  return JSON.parse(encoded) as unknown;
}

function targetUrl(value: string | URL, base: URL): URL {
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    invalidRequest();
  }
  if (
    target.origin !== base.origin ||
    target.username ||
    target.password ||
    target.hash
  )
    invalidRequest();
  return target;
}

function baseUrl(value: string): URL {
  const base = new URL(value);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new DomainError(
      "INVALID_CONFIG",
      "The internal Center endpoint must be a plain HTTP(S) base URL.",
    );
  }
  return base;
}

/** Only the two Center read routes exist here. No HTTP request or browser Origin is fabricated. */
export function createCenterReadFetcher(store: Store, centerUrl: string) {
  const base = baseUrl(centerUrl);
  const prefix = base.pathname.replace(/\/$/u, "");
  return async (
    url: string | URL,
    options: FetchJsonOptions = {},
  ): Promise<unknown> => {
    const target = targetUrl(url, base);
    if ((options.method ?? "GET") !== "GET" || options.body !== undefined)
      invalidRequest();
    const pathname = target.pathname;
    let read: () => Promise<unknown>;
    if (pathname === `${prefix}/v1/search`) {
      const params = target.searchParams;
      if (
        [...params.keys()].some(
          (key) =>
            !["q", "limit", "cursor"].includes(key) ||
            params.getAll(key).length !== 1,
        )
      )
        invalidRequest();
      const query = (params.get("q") ?? "").trim();
      const limitText = params.get("limit") ?? "20";
      const cursorText = params.get("cursor") ?? "0";
      const limit = Number(limitText);
      const offset = Number(cursorText);
      if (
        query.length > 200 ||
        !/^[1-9]\d{0,2}$/u.test(limitText) ||
        limit > 100 ||
        !/^\d{1,16}$/u.test(cursorText) ||
        !Number.isSafeInteger(offset)
      )
        invalidRequest();
      read = () => store.search(query, limit, offset);
    } else if (pathname.startsWith(`${prefix}/v1/intents/`)) {
      const id = pathname.slice(`${prefix}/v1/intents/`.length);
      if (!UUID.test(id) || target.search) invalidRequest();
      read = async () => {
        const intent = await store.getIntent(id);
        if (!intent)
          throw new DomainError(
            "NOT_FOUND",
            "The requested JB Center intent was not found.",
          );
        return intent;
      };
    } else invalidRequest();
    const signal = signalFor(options);
    try {
      await quota(
        store,
        "center:mcp:reads",
        MCP_BACKEND_LIMITS.readsPerMinute,
        60,
        signal,
      );
      return boundedResult(
        await cancellable(signal, read),
        options.maxBytes,
        READ_RESPONSE_LIMIT,
      );
    } catch (error) {
      safeFailure(error, signal);
    }
  };
}

/** Retain the shared read-only gateway's provider failover, sanitization and streaming cap. */
export function createCenterRpcFetcher(
  store: Store,
  rpc: RpcGateway,
  rpcUrls: Config["rpcUrls"],
  siteLimitPerMinute: number = MCP_BACKEND_LIMITS.rpcSitePerMinute,
) {
  if (!Number.isSafeInteger(siteLimitPerMinute) || siteLimitPerMinute < 1) {
    throw new DomainError(
      "INVALID_CONFIG",
      "The shared RPC quota must be a positive safe integer.",
    );
  }
  const chainsByUrl = new Map<string, number>();
  for (const [chain, value] of Object.entries(rpcUrls)) {
    if (!value) continue;
    const target = baseUrl(value);
    if (
      target.pathname !== `/v1/rpc/${chain}` ||
      !rpc.supports(Number(chain))
    ) {
      throw new DomainError(
        "INVALID_CONFIG",
        "The MCP RPC endpoint must identify a supported internal chain route.",
      );
    }
    if (chainsByUrl.has(target.href))
      throw new DomainError("INVALID_CONFIG", "Duplicate MCP RPC endpoint.");
    chainsByUrl.set(target.href, Number(chain));
  }
  return async (
    url: string | URL,
    options: FetchJsonOptions = {},
  ): Promise<unknown> => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      invalidRequest();
    }
    const chain = chainsByUrl.get(target.href);
    if (
      !chain ||
      target.username ||
      target.password ||
      target.hash ||
      target.search ||
      (options.method ?? "POST") !== "POST"
    )
      invalidRequest();
    let request;
    try {
      const encoded =
        typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body);
      if (!encoded || Buffer.byteLength(encoded) > RPC_BODY_LIMIT)
        invalidRequest();
      request = parseRpcRequest(JSON.parse(encoded));
    } catch (error) {
      if (error instanceof RpcBadRequest || error instanceof SyntaxError)
        invalidRequest();
      throw error;
    }
    const signal = signalFor(options);
    try {
      await quota(
        store,
        "rpc:mcp",
        MCP_BACKEND_LIMITS.rpcPerMinute,
        60,
        signal,
      );
      await quota(store, "rpc:site", siteLimitPerMinute, 60, signal);
      const value = await cancellable(signal, () =>
        rpc.request(chain, request, signal),
      );
      return boundedResult(value, options.maxBytes, RPC_RESPONSE_LIMIT);
    } catch (error) {
      safeFailure(error, signal);
    }
  };
}

/** Called only after the metadata service verifies the exact reviewed V6 document and approval. */
export function createCenterPinJson(
  store: Store,
  pinning: PinningService,
): PinProjectMetadataJson {
  return async (jsonText, callerSignal) => {
    if (
      Buffer.byteLength(jsonText) < 2 ||
      Buffer.byteLength(jsonText) > METADATA_LIMIT
    )
      invalidRequest();
    let document: unknown;
    try {
      document = JSON.parse(jsonText);
    } catch {
      invalidRequest();
    }
    if (!document || typeof document !== "object" || Array.isArray(document))
      invalidRequest();
    const signal = signalFor({
      ...(callerSignal ? { signal: callerSignal } : {}),
      timeoutMs: 60_000,
    });
    try {
      await quota(
        store,
        "pin:mcp",
        MCP_BACKEND_LIMITS.pinsPerWindow,
        MCP_BACKEND_LIMITS.pinWindowSeconds,
        signal,
      );
      await quota(
        store,
        "pin:site",
        MCP_BACKEND_LIMITS.pinsSitePerWindow,
        MCP_BACKEND_LIMITS.pinWindowSeconds,
        signal,
      );
      const result = await cancellable(signal, () =>
        pinning.pin(
          new Blob([jsonText], { type: "application/json" }),
          "metadata.json",
          signal,
        ),
      );
      if (result.status !== "queued" || !isIpfsCid(result.cid)) {
        throw new DomainError(
          "UPSTREAM_INVALID_RESPONSE",
          "The pinning backend returned an invalid CID or status.",
        );
      }
      return { cid: result.cid, status: "queued" };
    } catch (error) {
      safeFailure(error, signal);
    }
  };
}

export function createCenterMcp(
  store: Store,
  options: {
    rpc: RpcGateway;
    pinning?: PinningService;
    env?: NodeJS.ProcessEnv;
    rpcSiteLimitPerMinute?: number;
  },
): { config: Config; services: Services } {
  const env = options.env ?? process.env;
  const publicOrigin = env.MCP_PUBLIC_ORIGIN ?? "https://juicebox.center";
  const allowedOrigins = [
    ...originsForEnvironment(env.RAILWAY_ENVIRONMENT_NAME),
    ...(env.MCP_ALLOWED_ORIGINS?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ?? []),
  ].join(",");
  // Namespace every MCP setting; the host's credentials/config never become adapter headers.
  const config = loadConfig({
    NODE_ENV: env.NODE_ENV,
    PORT: env.PORT,
    HOST: env.HOST,
    PUBLIC_ORIGIN: publicOrigin,
    JBCENTER_URL: publicOrigin,
    PLAN_SECRET: env.MCP_PLAN_SECRET,
    PLAN_TTL_SECONDS: env.MCP_PLAN_TTL_SECONDS,
    ALLOWED_HOSTS: env.MCP_ALLOWED_HOSTS,
    ALLOWED_ORIGINS: allowedOrigins,
    BENDYSTRAW_MAINNET_URL: env.MCP_BENDYSTRAW_MAINNET_URL,
    BENDYSTRAW_TESTNET_URL: env.MCP_BENDYSTRAW_TESTNET_URL,
    KNOWLEDGE_PATH: env.MCP_KNOWLEDGE_PATH,
    MAX_CONCURRENT_REQUESTS: env.MCP_MAX_CONCURRENT_REQUESTS,
  });
  const center = new CenterClient({
    baseUrl: config.centerUrl,
    fetchJson: createCenterReadFetcher(store, config.centerUrl),
  });
  const services = createServices(config, {
    rpcFetchJson: createCenterRpcFetcher(
      store,
      options.rpc,
      config.rpcUrls,
      options.rpcSiteLimitPerMinute,
    ),
    center,
    ...(options.pinning
      ? { pinJson: createCenterPinJson(store, options.pinning) }
      : {}),
  });
  return { config, services };
}
