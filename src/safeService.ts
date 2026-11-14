import { boundedText } from "./boundedText.js";

export const SAFE_BODY_LIMIT = 256 * 1024;
export const SAFE_RESPONSE_LIMIT = 5 * 1024 * 1024;
export const SAFE_RESPONSE_HEADERS = ["Retry-After", "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset", "X-RateLimit-Plan", "X-RateLimit-Warning"] as const;
const PREFIXES = new Set(["eth", "oeth", "base", "arb1", "sep", "basesep"]);
const ADDRESS = "0x[0-9a-fA-F]{40}";
const HASH = "0x[0-9a-fA-F]{64}";
const QUEUE = new RegExp(`^safes/${ADDRESS}/multisig-transactions/$`);
const TRANSACTION = new RegExp(`^multisig-transactions/${HASH}/$`);
const CONFIRMATION = new RegExp(`^multisig-transactions/${HASH}/confirmations/$`);
const OWNER = new RegExp(`^owners/${ADDRESS}/safes/$`);
const CREATION = new RegExp(`^safes/${ADDRESS}/creation/$`);

export class SafeBadRequest extends Error {}
export class SafeUnavailable extends Error {}
export type SafeGateway = { request(request: Request): Promise<Response> };

/** Only the service operations used by the SDK. The caller never supplies a host or an upstream URL. */
function upstreamFor(request: Request): URL {
  const url = new URL(request.url);
  const match = /^\/v1\/safe\/([^/]+)\/api\/v1\/(.+)$/.exec(url.pathname);
  if (!match || !PREFIXES.has(match[1]!)) throw new SafeBadRequest("Safe service chain or path is not supported");
  const path = match[2]!;
  const queue = QUEUE.test(path);
  if (!(request.method === "GET" && (queue || TRANSACTION.test(path) || OWNER.test(path) || CREATION.test(path))) &&
      !(request.method === "POST" && (queue || CONFIRMATION.test(path)))) {
    throw new SafeBadRequest("Safe service operation is not supported");
  }
  const seen = new Set<string>();
  for (const [name, value] of url.searchParams) {
    if (!queue || request.method !== "GET" || seen.has(name)) throw new SafeBadRequest("Safe service query is not supported");
    seen.add(name);
    const valid = name === "executed" ? value === "false"
      : name === "trusted" ? value === "true"
      : name === "ordering" ? value === "nonce"
      : name === "limit" ? /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 50
      : name === "offset" ? /^\d+$/.test(value) && Number(value) <= 200
      : name === "nonce__gte" ? /^\d+$/.test(value) && Number.isSafeInteger(Number(value))
      : false;
    if (!valid) throw new SafeBadRequest("Safe service query is not supported");
  }
  return new URL(`https://api.safe.global/tx-service/${match[1]}/api/v1/${path}${url.search}`);
}

/** Shared account credential stays on the server. Upstream failures never carry fetch errors or headers back. */
export function createSafeGateway(apiKey: string, fetcher: typeof fetch = fetch, timeoutMs = 10_000): SafeGateway {
  if (!apiKey.trim() || /\s/.test(apiKey)) throw new Error("SAFE_API_KEY must be a nonempty token without whitespace");
  return {
    async request(request) {
      const url = upstreamFor(request);
      const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${apiKey}` };
      let body: string | undefined;
      if (request.method === "POST") {
        if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
          throw new SafeBadRequest("Safe service writes require application/json");
        }
        body = await boundedText(new Response(request.body), request.signal, SAFE_BODY_LIMIT, () => new SafeBadRequest("Safe service request body is too large"));
        let value: unknown;
        try { value = JSON.parse(body); } catch { throw new SafeBadRequest("Safe service request must be valid JSON"); }
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new SafeBadRequest("Safe service request must be a JSON object");
        headers["content-type"] = "application/json";
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, timeoutMs);
      try {
        request.signal.throwIfAborted();
        const response = await fetcher(url, { method: request.method, headers, ...(body === undefined ? {} : { body }), redirect: "error", signal: controller.signal });
        const text = await boundedText(response, controller.signal, SAFE_RESPONSE_LIMIT, (message) => new SafeUnavailable(`Safe ${message}`));
        // Safe returns JSON (or an empty successful POST). Never forward HTML, redirects or an echoed credential.
        if (response.status >= 300 && response.status < 400) throw new SafeUnavailable("Safe upstream redirected");
        if (text) { try { JSON.parse(text); } catch { throw new SafeUnavailable("Safe upstream returned invalid JSON"); } }
        const outgoing = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
        for (const name of SAFE_RESPONSE_HEADERS) {
          const value = response.headers.get(name);
          if (value) outgoing.set(name, value.replaceAll(apiKey, "[redacted]"));
        }
        return new Response(text ? text.replaceAll(apiKey, "[redacted]") : null, { status: response.status, headers: outgoing });
      } catch {
        throw new SafeUnavailable("Safe transaction service is unavailable");
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", abort);
      }
    },
  };
}
