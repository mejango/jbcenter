import { Hono, type Context } from "hono";
import { RestAuthError, type RestPrincipal } from "./store.js";
import type { SignedRequestInput } from "./signatures.js";
import type { RegisterBotInput, RestAuth } from "./service.js";

export async function readSignedRequest(
  request: Request,
  rawRequestTarget: string,
  maximumBodyBytes = 64 * 1_024,
  bodyTimeoutMs = 15_000,
): Promise<SignedRequestInput> {
  if (!Number.isSafeInteger(maximumBodyBytes) || maximumBodyBytes < 0 || maximumBodyBytes > 2 * 1024 * 1024) {
    throw new Error("Invalid signed request body limit");
  }
  if (!Number.isSafeInteger(bodyTimeoutMs) || bodyTimeoutMs < 1 || bodyTimeoutMs > 30_000) {
    throw new Error("Invalid signed request body timeout");
  }
  const encoding = request.headers.get("content-encoding");
  if (encoding && encoding !== "identity") {
    throw new RestAuthError("UNSUPPORTED_ENCODING", 415, "Signed requests require an uncompressed body");
  }
  const declared = request.headers.get("content-length");
  if (declared && (!/^[0-9]+$/.test(declared) || Number(declared) > maximumBodyBytes)) {
    throw new RestAuthError("BODY_TOO_LARGE", 413, "Signed request body exceeds the size limit");
  }
  if (["GET", "HEAD"].includes(request.method) && ((declared && Number(declared) !== 0) || request.headers.has("transfer-encoding"))) {
    throw new RestAuthError("INVALID_INPUT", 400, "GET and HEAD requests cannot contain a body");
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = request.body?.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new RestAuthError("REQUEST_ABORTED", 408, "Request body reading was interrupted"));
    timer = setTimeout(() => reject(new RestAuthError("BODY_TIMEOUT", 408, "Request body did not complete in time")), bodyTimeoutMs);
    request.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    if (request.signal.aborted) throw new RestAuthError("REQUEST_ABORTED", 408, "Request body reading was interrupted");
    if (reader) {
      for (;;) {
        const chunk = await Promise.race([reader.read(), interrupted]);
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > maximumBodyBytes) {
          throw new RestAuthError("BODY_TOO_LARGE", 413, "Signed request body exceeds the size limit");
        }
        chunks.push(chunk.value);
      }
    }
  } catch (error) {
    void reader?.cancel().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
    if (onAbort) request.signal.removeEventListener("abort", onAbort);
    reader?.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return {
    method: request.method,
    requestTarget: rawRequestTarget,
    contentType: request.headers.get("content-type") ?? "",
    headers: request.headers,
    body,
    signal: request.signal,
  };
}

function jsonBody(input: SignedRequestInput): Record<string, unknown> {
  if (input.contentType.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new RestAuthError("UNSUPPORTED_MEDIA_TYPE", 415, "Expected application/json");
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.body));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* Safe input error below. */ }
  throw new RestAuthError("INVALID_JSON", 400, "Expected a JSON object");
}

export type RestAuthRouterOptions = {
  /** Return Node IncomingMessage.url, including the mounted /api/v1 prefix and exact query. */
  requestTarget: (context: Context) => string;
  maximumBodyBytes?: number;
  onError?: (error: Error, context: Context) => Response | Promise<Response>;
  /** Charge the shared account budget after signature verification and before protected mutations. */
  onAuthenticated?: (principal: RestPrincipal, context: Context) => void | Promise<void>;
};

/** Mount with app.route('/api/v1', router); signatures cover the actual mounted path. */
export function createRestAuthRouter(auth: RestAuth, options: RestAuthRouterOptions): Hono {
  const router = new Hono();
  const read = (context: Context) => {
    const target = options.requestTarget(context);
    if (target.includes("?")) throw new RestAuthError("INVALID_INPUT", 400, "Account routes do not accept query parameters");
    return readSignedRequest(context.req.raw, target, options.maximumBodyBytes);
  };
  router.onError(options.onError ?? ((error, context) => {
    if (error instanceof RestAuthError) {
      return context.json({ error: { code: error.code, message: error.message } }, error.status as 400);
    }
    return context.json({ error: { code: "INTERNAL_ERROR", message: "The account operation could not be completed" } }, 500);
  }));
  const authenticate = async (context: Context, input: SignedRequestInput, ownerOnly = false) => {
    const principal = await auth.authenticate(input, ownerOnly ? [] : ["read"], ownerOnly);
    await options.onAuthenticated?.(principal, context);
    return principal;
  };
  router.post("/accounts/enroll", async (context) => {
    const input = await read(context);
    const document = jsonBody(input);
    if (Object.keys(document).length) throw new RestAuthError("INVALID_INPUT", 400, "Enrollment body must be an empty JSON object");
    const principal = await auth.enroll(input);
    await options.onAuthenticated?.(principal, context);
    return context.json({ account: principal.account });
  });
  router.get("/accounts/me", async (context) => {
    const principal = await authenticate(context, await read(context));
    return context.json({ account: await auth.getProfile(principal) });
  });
  router.patch("/accounts/me", async (context) => {
    const input = await read(context);
    const principal = await authenticate(context, input, true);
    return context.json({ account: await auth.updateProfile(principal, jsonBody(input)) });
  });
  router.get("/accounts/me/bots", async (context) => {
    const principal = await authenticate(context, await read(context), true);
    return context.json({ bots: await auth.listBots(principal) });
  });
  router.post("/accounts/me/bots", async (context) => {
    const input = await read(context);
    const principal = await authenticate(context, input, true);
    return context.json({ bot: await auth.registerBot(principal, jsonBody(input) as RegisterBotInput) }, 201);
  });
  router.delete("/accounts/me/bots/:grantId", async (context) => {
    const principal = await authenticate(context, await read(context), true);
    return context.json({ bot: await auth.revokeBot(principal, context.req.param("grantId")) });
  });
  return router;
}
