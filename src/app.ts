import { bodyLimit } from "hono/body-limit";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import Busboy from "busboy";
import { Readable, Transform } from "node:stream";
import { isHex, size, verifyMessage, type Hex } from "viem";
import { authenticate } from "./auth.js";
import {
  DeploymentVerificationError,
  type DeploymentVerifier,
} from "./deploymentVerifier.js";
import {
  address,
  contentHash,
  normalizeEnvelope,
  signingMessage,
} from "./intent.js";
import { extractMetadata } from "./metadata.js";
import { Metrics } from "./observability.js";
import {
  parseRpcRequest,
  RPC_BODY_LIMIT,
  RpcBadRequest,
  type RpcGateway,
  RpcUnavailable,
} from "./rpc.js";
import {
  PIN_LIMITS,
  safeIpfsPath,
  type PinResult,
  type PinningService,
} from "./ipfs.js";
import { ConflictError, StorageLimitError, type Store } from "./store.js";
import type { JbcenterEnv } from "./types.js";

const MAX_BODY_BYTES = 16_800_000;
const PRODUCTION_ORIGINS = [
  "https://juicebox.money",
  "https://revnet.money",
  "https://eth.shop",
  "https://succulent.money",
] as const;
const DEV_ORIGINS = [
  "https://dev.juicebox.money",
  "https://dev.revnet.money",
  "http://localhost:3001",
  "http://localhost:3002",
  "https://dev.eth.shop",
  "http://localhost:3003",
  "https://dev.succulent.money",
  "http://localhost:3004",
] as const;

export function originsForEnvironment(environment = process.env.RAILWAY_ENVIRONMENT_NAME) {
  return environment === "dev" ? DEV_ORIGINS : PRODUCTION_ORIGINS;
}

export const ALLOWED_ORIGINS = originsForEnvironment();
const PIN_WINDOW_SECONDS = 10 * 60;
const PIN_PER_CALLER = 10;
const PIN_PER_SITE = 200;
const IPFS_GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs",
  "https://dweb.link/ipfs",
  "https://ipfs.io/ipfs",
] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TX_HASH = /^0x[0-9a-f]{64}$/iu;

class BadRequest extends Error {}
class PayloadTooLarge extends Error {}
class UnsupportedMedia extends Error {}
class PinFailed extends Error {}

export type AppOptions = {
  allowedOrigins?: readonly string[];
  deploymentVerifier?: DeploymentVerifier;
  requestLimitPerMinute?: number;
  maxIntentsPerClient?: number;
  maxStorageBytesPerClient?: number;
  metricsToken?: string;
  pinning?: PinningService;
  gatewayFetch?: typeof fetch;
  maxMediaBytes?: number;
  rpc?: RpcGateway;
  rpcRequestLimitPerMinute?: number;
  rpcSiteLimitPerMinute?: number;
  /** Keyless RPC from any origin (IPFS-hosted sites like juicescan): per-IP and shared budgets. */
  rpcPublicRequestLimitPerMinute?: number;
  rpcPublicSiteLimitPerMinute?: number;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequest("Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

async function json(c: Context): Promise<Record<string, unknown>> {
  try {
    return record(await c.req.json());
  } catch (error) {
    if (error instanceof BadRequest) throw error;
    throw new BadRequest("Request body must be valid JSON");
  }
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || Number(parsed) <= 0) {
    throw new BadRequest(`${name} must be a positive safe integer`);
  }
  return Number(parsed);
}

function projectId(value: unknown): string {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== "string" || !/^[1-9]\d{0,77}$/u.test(text)) {
    throw new BadRequest("projectId must be a positive decimal string");
  }
  return text;
}

function signature(value: unknown): Hex {
  if (typeof value !== "string" || !isHex(value) || ![64, 65].includes(size(value))) {
    throw new BadRequest("signature must be a 64- or 65-byte hex signature");
  }
  return value;
}

function cursor(value: string | undefined): number {
  if (!value) return 0;
  if (!/^\d+$/u.test(value)) throw new BadRequest("cursor is invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new BadRequest("cursor is invalid");
  return parsed;
}

const pinPath = (path: string) => path.startsWith("/v1/pins/");
const rpcPath = (path: string) => path.startsWith("/v1/rpc/");
function callerIp(c: Context): string {
  return (
    c.req.header("x-real-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  ).slice(0, 128);
}

function pinPayload(result: PinResult) {
  return {
    ...result,
    uri: `ipfs://${result.cid}`,
    gatewayUrl: `/ipfs/${result.cid}`,
  };
}

async function multipartFile(c: Context, maxBytes: number): Promise<File> {
  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    throw new BadRequest("Request body must be multipart form data");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw new BadRequest("A file field is required");
  if (file.size < 1 || file.size > maxBytes) {
    throw new PayloadTooLarge(`file must contain 1-${maxBytes} bytes`);
  }
  return file;
}

function mediaAllowed(type: string, name: string): boolean {
  return (
    type.startsWith("image/") ||
    type.startsWith("video/") ||
    type.startsWith("audio/") ||
    type === "application/pdf" ||
    type.startsWith("text/") ||
    /\.(?:md|markdown|txt)$/iu.test(name)
  );
}

async function streamMedia(
  c: Context,
  pinning: PinningService,
  maxBytes: number,
): Promise<PinResult> {
  const body = c.req.raw.body;
  if (!body) throw new BadRequest("A multipart request body is required");

  let parser: ReturnType<typeof Busboy>;
  try {
    parser = Busboy({
      headers: Object.fromEntries(c.req.raw.headers.entries()),
      // Busboy emits `limit` when the configured byte count is reached. Give it
      // one sentinel byte so an exactly-at-limit file remains valid.
      // The count-limit events fire when the configured count is reached, so
      // use one sentinel slot and enforce the single `file` part ourselves.
      limits: { files: 2, fields: 1, parts: 2, fileSize: maxBytes + 1 },
    });
  } catch {
    throw new BadRequest("Request body must be multipart form data");
  }

  const source = Readable.fromWeb(body as import("node:stream/web").ReadableStream<Uint8Array>);
  return new Promise<PinResult>((resolve, reject) => {
    let fileSeen = false;
    let fileBytes = 0;
    let settled = false;
    let upload: Promise<PinResult> | null = null;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      source.unpipe(parser);
      source.destroy();
      reject(error);
    };

    parser.on("file", (field, file, info) => {
      if (field !== "file" || fileSeen) {
        file.resume();
        fail(new BadRequest("Exactly one file field is required"));
        return;
      }
      fileSeen = true;
      if (!mediaAllowed(info.mimeType, info.filename)) {
        file.resume();
        fail(new UnsupportedMedia("Images, video, audio, PDF, or text only"));
        return;
      }
      // Count bytes inside the pipeline rather than with a `data` listener: a
      // listener would put the part into flowing mode and drain it before the
      // uploader starts pulling, so Filebase would receive an empty body.
      const counted = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          fileBytes += chunk.byteLength;
          callback(null, chunk);
        },
      });
      file.once("limit", () => {
        const error = new PayloadTooLarge(`file must not exceed ${maxBytes} bytes`);
        file.destroy(error);
        counted.destroy(error);
        fail(error);
      });
      file.once("error", (error) => counted.destroy(error));
      file.pipe(counted);
      upload = pinning.pinStream(counted, "media", info.mimeType);
      void upload.catch(() => fail(new PinFailed("Failed to pin media")));
    });
    parser.on("field", () => fail(new BadRequest("Only the file field is allowed")));
    parser.once("filesLimit", () => fail(new BadRequest("Exactly one file is allowed")));
    parser.once("fieldsLimit", () => fail(new BadRequest("Only the file field is allowed")));
    parser.once("partsLimit", () => fail(new BadRequest("Exactly one file field is required")));
    parser.once("error", (error) =>
      fail(error instanceof Error ? error : new BadRequest("Invalid multipart body")),
    );
    source.once("error", (error) => fail(error));
    parser.once("close", async () => {
      if (settled) return;
      if (!fileSeen || !upload) {
        fail(new BadRequest("A file field is required"));
        return;
      }
      if (fileBytes === 0) {
        fail(new PayloadTooLarge(`file must contain 1-${maxBytes} bytes`));
        return;
      }
      try {
        const result = await upload;
        if (settled) return;
        settled = true;
        resolve(result);
      } catch (error) {
        fail(error instanceof PinFailed ? error : new PinFailed("Failed to pin media"));
      }
    });
    source.pipe(parser);
  });
}

const SAFE_GATEWAY_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range, ETag",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "X-Content-Type-Options": "nosniff",
} as const;

function downloadable(type: string): boolean {
  return /^(?:text\/(?:html|xml|css|javascript|ecmascript)|application\/(?:xhtml\+xml|xml|javascript|ecmascript|pdf|wasm))/iu.test(
    type,
  );
}

export function createApp(
  store: Store,
  options: AppOptions = {},
): Hono<JbcenterEnv> {
  const app = new Hono<JbcenterEnv>();
  const metrics = new Metrics();
  const allowedOrigins = options.allowedOrigins ?? ALLOWED_ORIGINS;

  app.onError((error, c) => {
    if (
      error instanceof BadRequest ||
      error.message.startsWith("chainIds") ||
      error.message.startsWith("deploymentCalls") ||
      error.message.startsWith("format") ||
      error.message.startsWith("version") ||
      error.message.startsWith("deploymentVersion") ||
      error.message.startsWith("jb") ||
      error.message.startsWith("request") ||
      error.message.startsWith("publisher")
    ) {
      return c.json({ error: { code: "bad_request", message: error.message } }, 400);
    }
    if (error instanceof PayloadTooLarge) {
      return c.json({ error: { code: "body_too_large", message: error.message } }, 413);
    }
    if (error instanceof UnsupportedMedia) {
      return c.json({ error: { code: "unsupported_media", message: error.message } }, 415);
    }
    if (error instanceof PinFailed) {
      return c.json({ error: { code: "pin_failed", message: error.message } }, 502);
    }
    if (error instanceof RpcBadRequest) {
      return c.json({ error: { code: "rpc_bad_request", message: error.message } }, 400);
    }
    if (error instanceof RpcUnavailable) {
      return c.json({ error: { code: "rpc_unavailable", message: error.message } }, 502);
    }
    if (error instanceof ConflictError) {
      return c.json({ error: { code: "conflict", message: error.message } }, 409);
    }
    if (error instanceof DeploymentVerificationError) {
      return c.json({ error: { code: "deployment_unverified", message: error.message } }, 422);
    }
    if (error instanceof StorageLimitError) {
      return c.json({ error: { code: "storage_limit", message: error.message } }, 429);
    }
    console.error(JSON.stringify({ level: "error", message: "request_failed", error: error.message }));
    return c.json({ error: { code: "internal_error", message: "Internal server error" } }, 500);
  });

  app.use("*", metrics.middleware());

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.get("/readyz", async (c) => {
    await store.health();
    return c.json({ ok: true });
  });

  app.get("/metrics", (c) => {
    if (
      !options.metricsToken ||
      !authenticate(options.metricsToken, c.req.header("authorization"))
    ) {
      return c.json({ error: { code: "not_found", message: "Not found" } }, 404);
    }
    return c.text(metrics.render(), 200, { "Content-Type": "text/plain; version=0.0.4" });
  });

  app.get("/ipfs/*", async (c) => {
    const path = safeIpfsPath(c.req.path.slice("/ipfs/".length));
    if (!path) {
      return c.json(
        { error: { code: "bad_request", message: "IPFS path is invalid" } },
        400,
        SAFE_GATEWAY_HEADERS,
      );
    }
    const etag = `"ipfs:${path}"`;
    const cache = "public, max-age=31536000, s-maxage=31536000, immutable";
    const headers = { ...SAFE_GATEWAY_HEADERS, "Cache-Control": cache, ETag: etag };
    const range = c.req.header("range");
    if (
      !range &&
      c.req.header("if-none-match")?.split(",").map((value) => value.trim()).includes(etag)
    ) {
      return new Response(null, { status: 304, headers });
    }

    const gatewayFetch = options.gatewayFetch ?? fetch;
    let upstream: Response | null = null;
    let lastStatus = 502;
    for (const gateway of IPFS_GATEWAYS) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await gatewayFetch(`${gateway}/${path}`, {
          headers: {
            ...(range ? { Range: range } : {}),
            ...(c.req.header("if-range") ? { "If-Range": c.req.header("if-range")! } : {}),
          },
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (response.ok) {
          upstream = response;
          break;
        }
        lastStatus = response.status;
        await response.body?.cancel();
      } catch {
        // Try the next independent public gateway.
      } finally {
        clearTimeout(timeout);
      }
    }
    if (!upstream) {
      return new Response(
        JSON.stringify({
          error: { code: "gateway_unavailable", message: "IPFS gateways are unavailable" },
        }),
        {
          status: lastStatus,
          headers: { ...SAFE_GATEWAY_HEADERS, "Content-Type": "application/json" },
        },
      );
    }
    const declaredLength = Number(upstream.headers.get("content-length") ?? 0);
    if (!Number.isFinite(declaredLength) || declaredLength < 0) {
      return c.json(
        { error: { code: "bad_gateway", message: "IPFS response is invalid" } },
        502,
        SAFE_GATEWAY_HEADERS,
      );
    }
    if (declaredLength > PIN_LIMITS.gateway) {
      return c.json(
        { error: { code: "content_too_large", message: "IPFS asset is too large" } },
        413,
        SAFE_GATEWAY_HEADERS,
      );
    }

    const upstreamType = upstream.headers.get("content-type") ?? "application/octet-stream";
    const download = downloadable(upstreamType);
    let streamed = 0;
    const body = upstream.body?.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          streamed += chunk.byteLength;
          if (streamed > PIN_LIMITS.gateway) {
            controller.error(new Error("IPFS asset exceeded the gateway limit"));
            return;
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(body, {
      status: upstream.status,
      headers: {
        ...headers,
        "Content-Type": download ? "application/octet-stream" : upstreamType,
        ...(download ? { "Content-Disposition": "attachment; filename=ipfs-asset" } : {}),
        ...(declaredLength > 0 ? { "Content-Length": String(declaredLength) } : {}),
        ...(upstream.headers.get("accept-ranges") || upstream.status === 206
          ? { "Accept-Ranges": upstream.headers.get("accept-ranges") ?? "bytes" }
          : {}),
        ...(upstream.headers.get("content-range")
          ? { "Content-Range": upstream.headers.get("content-range")! }
          : {}),
      },
    });
  });

  app.use("/v1/*", async (c, next) => {
    const origin = c.req.header("origin");
    const trustedOrigin = origin && allowedOrigins.some((allowed) => allowed === origin);
    if (!trustedOrigin) {
      // The read-only RPC gateway is open to any origin — sites served from IPFS have no stable
      // origin to allowlist — under its own tighter budgets, keyed by IP.
      if (rpcPath(c.req.path)) {
        c.set("client", `public:${callerIp(c)}`);
        await next();
        return;
      }
      return c.json(
        { error: { code: "forbidden_origin", message: "Origin is not allowed" } },
        403,
      );
    }
    c.set("client", `browser:${new URL(origin!).hostname}:${callerIp(c)}`);
    await next();
  });
  app.use(
    "/v1/*",
    cors({
      origin: (origin, c) =>
        allowedOrigins.some((allowed) => allowed === origin)
          ? origin
          : rpcPath(c.req.path)
            ? "*"
            : null,
      allowHeaders: ["Authorization", "Content-Type"],
      allowMethods: ["GET", "POST", "OPTIONS"],
      maxAge: 86_400,
    }),
  );
  const intentBodyLimit = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) =>
      c.json({ error: { code: "body_too_large", message: "Request body is too large" } }, 413),
  });
  app.use("/v1/intents", intentBodyLimit);
  app.use("/v1/intents/*", intentBodyLimit);
  app.use(
    "/v1/pins/json",
    bodyLimit({
      maxSize: PIN_LIMITS.json,
      onError: (c) =>
        c.json({ error: { code: "body_too_large", message: "Request body is too large" } }, 413),
    }),
  );
  app.use(
    "/v1/pins/file",
    bodyLimit({
      maxSize: PIN_LIMITS.image + PIN_LIMITS.multipartOverhead,
      onError: (c) =>
        c.json({ error: { code: "body_too_large", message: "Request body is too large" } }, 413),
    }),
  );
  app.use(
    "/v1/rpc/*",
    bodyLimit({
      maxSize: RPC_BODY_LIMIT,
      onError: (c) =>
        c.json({ error: { code: "body_too_large", message: "Request body is too large" } }, 413),
    }),
  );
  app.use("/v1/*", async (c, next) => {
    const pin = pinPath(c.req.path);
    const rpc = rpcPath(c.req.path);
    const publicRpc = rpc && c.get("client").startsWith("public:");
    const limit = pin
      ? PIN_PER_CALLER
      : publicRpc
        ? (options.rpcPublicRequestLimitPerMinute ?? 120)
        : rpc
          ? (options.rpcRequestLimitPerMinute ?? 600)
          : (options.requestLimitPerMinute ?? 600);
    const result = await store.consumeRequest(c.get("client"), limit, pin ? PIN_WINDOW_SECONDS : 60);
    c.header("X-RateLimit-Limit", String(limit));
    c.header("X-RateLimit-Remaining", String(result.remaining));
    if (!result.allowed) {
      c.header("Retry-After", "60");
      return c.json(
        { error: { code: "rate_limit", message: "Request limit exceeded" } },
        429,
      );
    }
    if (pin) {
      const site = await store.consumeRequest("pin:site", PIN_PER_SITE, PIN_WINDOW_SECONDS);
      if (!site.allowed) {
        c.header("Retry-After", String(PIN_WINDOW_SECONDS));
        return c.json(
          { error: { code: "pin_budget", message: "The shared pin budget is spent" } },
          429,
        );
      }
    }
    if (rpc) {
      // Public traffic spends its own shared budget so it can never starve the trusted sites.
      const site = await store.consumeRequest(
        publicRpc ? "rpc:public" : "rpc:site",
        publicRpc
          ? (options.rpcPublicSiteLimitPerMinute ?? 5_000)
          : (options.rpcSiteLimitPerMinute ?? 20_000),
        60,
      );
      if (!site.allowed) {
        c.header("Retry-After", "60");
        return c.json(
          { error: { code: "rpc_budget", message: "The shared RPC budget is spent" } },
          429,
        );
      }
    }
    await next();
  });

  app.post("/v1/rpc/:chainId", async (c) => {
    if (!options.rpc) {
      return c.json({ error: { code: "unavailable", message: "RPC gateway is unavailable" } }, 503);
    }
    let value: unknown;
    try {
      value = await c.req.json();
    } catch {
      throw new RpcBadRequest("Request body must be valid JSON");
    }
    const request = parseRpcRequest(value);
    const result = await options.rpc.request(positiveInteger(c.req.param("chainId"), "chainId"), request);
    return c.body(JSON.stringify(result), 200, { "Content-Type": "application/json" });
  });

  app.post("/v1/pins/json", async (c) => {
    if (!options.pinning) {
      return c.json({ error: { code: "unavailable", message: "IPFS pinning is unavailable" } }, 503);
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new BadRequest("Request body must be valid JSON");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new BadRequest("Request body must be a JSON object");
    }
    try {
      const result = await options.pinning.pin(
        new Blob([bytes], { type: "application/json" }),
        "metadata.json",
      );
      return c.json(pinPayload(result), 201);
    } catch {
      return c.json({ error: { code: "pin_failed", message: "Failed to pin JSON" } }, 502);
    }
  });

  app.post("/v1/pins/file", async (c) => {
    if (!options.pinning) {
      return c.json({ error: { code: "unavailable", message: "IPFS pinning is unavailable" } }, 503);
    }
    const file = await multipartFile(c, PIN_LIMITS.image);
    if (!file.type.startsWith("image/")) {
      return c.json({ error: { code: "unsupported_media", message: "Only images are allowed" } }, 415);
    }
    try {
      return c.json(pinPayload(await options.pinning.pin(file, "image")), 201);
    } catch {
      return c.json({ error: { code: "pin_failed", message: "Failed to pin image" } }, 502);
    }
  });

  app.post("/v1/pins/media", async (c) => {
    if (!options.pinning) {
      return c.json({ error: { code: "unavailable", message: "IPFS pinning is unavailable" } }, 503);
    }
    return c.json(
      pinPayload(
        await streamMedia(c, options.pinning, options.maxMediaBytes ?? PIN_LIMITS.media),
      ),
      201,
    );
  });

  app.post("/v1/intents/message", async (c) => {
    const envelope = normalizeEnvelope(await json(c));
    const hash = contentHash(envelope);
    return c.json({ contentHash: hash, message: signingMessage(hash), envelope });
  });

  app.post("/v1/intents", async (c) => {
    const body = await json(c);
    const envelope = normalizeEnvelope(body);
    const hash = contentHash(envelope);
    const publisher = address(body.publisher, "publisher");
    const signed = signature(body.signature);
    const valid = await verifyMessage({
      address: publisher,
      message: signingMessage(hash),
      signature: signed,
    });
    if (!valid) throw new BadRequest("signature does not match publisher and project intent");
    const result = await store.createIntent({
      ...extractMetadata(envelope.jb),
      contentHash: hash,
      envelope,
      publisher,
      signature: signed,
      submittedBy: c.get("client"),
      jbBytes: Buffer.byteLength(JSON.stringify(envelope)),
    }, {
      maxIntents: options.maxIntentsPerClient ?? 10_000,
      maxBytes: options.maxStorageBytesPerClient ?? 1_073_741_824,
    });
    return c.json(result.intent, result.created ? 201 : 200);
  });

  app.get("/v1/intents/:id", async (c) => {
    const id = c.req.param("id");
    if (!UUID.test(id)) throw new BadRequest("intent id is invalid");
    const intent = await store.getIntent(id);
    return intent
      ? c.json(intent)
      : c.json({ error: { code: "not_found", message: "Intent not found" } }, 404);
  });

  app.get("/v1/search", async (c) => {
    const query = (c.req.query("q") ?? "").trim();
    if (query.length > 200) throw new BadRequest("q must not exceed 200 characters");
    const rawLimit = c.req.query("limit") ?? "20";
    const limit = positiveInteger(rawLimit, "limit");
    if (limit > 100) throw new BadRequest("limit must not exceed 100");
    return c.json(await store.search(query, limit, cursor(c.req.query("cursor"))));
  });

  app.post("/v1/intents/:id/deployments", async (c) => {
    if (!options.deploymentVerifier) {
      return c.json(
        { error: { code: "unavailable", message: "Deployment verification is not configured" } },
        503,
      );
    }
    const id = c.req.param("id");
    if (!UUID.test(id)) throw new BadRequest("intent id is invalid");
    const intent = await store.getIntent(id);
    if (!intent) return c.json({ error: { code: "not_found", message: "Intent not found" } }, 404);
    const body = await json(c);
    const chainId = positiveInteger(body.chainId, "chainId");
    if (!intent.envelope.chainIds.includes(chainId)) {
      throw new BadRequest("chainId is not part of this intent");
    }
    const call = intent.envelope.deploymentCalls.find((item) => item.chainId === chainId);
    if (!call) {
      throw new DeploymentVerificationError("Intent has no deployment call for this chain");
    }
    if (typeof body.transactionHash !== "string" || !TX_HASH.test(body.transactionHash)) {
      throw new BadRequest("transactionHash must be a 32-byte hex value");
    }
    const claim = {
      chainId,
      projectId: projectId(body.projectId),
      transactionHash: body.transactionHash as Hex,
      deploymentVersion: intent.envelope.deploymentVersion,
      call,
    };
    await options.deploymentVerifier.verify(claim);
    const deployment = await store.recordDeployment(id, claim);
    return c.json(deployment, 201);
  });

  return app;
}
