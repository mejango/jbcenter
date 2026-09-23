import { PIN_LIMITS, safeIpfsPath } from "./ipfs.js";
import type { CachedIpfsEntry, IpfsDiskCache } from "./ipfsCache.js";

const GATEWAYS = [
  "https://ipfs.filebase.io/ipfs",
  "https://gateway.pinata.cloud/ipfs",
];
const SAFE_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range, ETag, X-IPFS-Cache",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "X-Content-Type-Options": "nosniff",
};
const IMMUTABLE = "public, max-age=31536000, s-maxage=31536000, immutable";

function failure(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, {
    status, headers: { ...SAFE_HEADERS, "Cache-Control": "no-store", "X-IPFS-Cache": "BYPASS" },
  });
}

function mediaHeaders(type: string): Headers {
  const download = /^(?:text\/(?:html|xml|css|javascript|ecmascript)|application\/(?:xhtml\+xml|xml|javascript|ecmascript|pdf|wasm))/iu.test(type);
  return new Headers({
    "Content-Type": download ? "application/octet-stream" : type,
    ...(download ? { "Content-Disposition": "attachment; filename=ipfs-asset" } : {}),
  });
}

function notModified(request: Request, etag: string): boolean {
  return !!request.headers.get("if-none-match")?.split(",")
    .some(value => value.trim() === "*" || value.trim().replace(/^W\//u, "") === etag);
}

/** Ignore malformed/multipart ranges; reject a valid range which cannot select any bytes. */
function byteRange(value: string | null, size: number): [number, number] | "unsatisfiable" | null {
  const match = value?.match(/^bytes=(\d*)-(\d*)$/u);
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ([first, last].some(part => part !== null && !Number.isSafeInteger(part))) return null;
  if (first !== null && last !== null && last < first) return null;
  if (!size || (first !== null && first >= size) || (first === null && last === 0)) return "unsatisfiable";
  return first === null
    ? [Math.max(0, size - last!), size - 1]
    : [first, Math.min(last ?? size - 1, size - 1)];
}

function contentRangeLength(value: string | null, length: number | null, requested: string): number | null {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/u);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === "*" ? null : Number(match[3]);
  const size = end - start + 1;
  if (![start, end, total, size].every(part => part === null || Number.isSafeInteger(part)) ||
    start > end || (total !== null && total <= end) || (length !== null && length !== size)) return null;
  const expected = byteRange(requested, total ?? end + 1);
  return Array.isArray(expected) && expected[0] === start && expected[1] === end ? size : null;
}

function cancelBody(response: Response): void {
  // A provider's cancellation hook must not hold fallback or cache cleanup open.
  void response.body?.cancel().catch(() => undefined);
}

async function cachedResponse(entry: CachedIpfsEntry, request: Request, etag: string): Promise<Response> {
  const headers = new Headers(entry.headers);
  for (const [key, value] of Object.entries(SAFE_HEADERS)) headers.set(key, value);
  headers.set("Cache-Control", IMMUTABLE);
  headers.set("ETag", etag);
  headers.set("X-IPFS-Cache", "HIT");
  headers.set("Accept-Ranges", "bytes");
  if (notModified(request, etag)) return new Response(null, { status: 304, headers });
  const ifRange = request.headers.get("if-range");
  const range = request.method === "GET" && (!ifRange || ifRange === etag)
    ? byteRange(request.headers.get("range"), entry.size) : null;
  if (range === "unsatisfiable") {
    headers.set("Cache-Control", "no-store");
    headers.set("Content-Range", `bytes */${entry.size}`);
    headers.delete("Content-Length");
    return new Response(null, { status: 416, headers });
  }
  const [start, end] = range ?? [0, entry.size - 1];
  headers.set("Content-Length", String(range ? end - start + 1 : entry.size));
  if (range) headers.set("Content-Range", `bytes ${start}-${end}/${entry.size}`);
  return new Response(request.method === "HEAD" ? null : await entry.body(start, end), {
    status: range ? 206 : 200, headers,
  });
}

/** One gateway boundary for browser, CDN and disk-cache responses. */
export function createIpfsGateway(options: { cache?: IpfsDiskCache; fetcher?: typeof fetch } = {}) {
  const fetcher = options.fetcher ?? fetch;
  return async (request: Request): Promise<Response> => {
    const path = safeIpfsPath(new URL(request.url).pathname.slice("/ipfs/".length));
    if (!path) return failure(400, "bad_request", "IPFS path is invalid");
    const etag = `"ipfs:${path}"`;
    if (options.cache) {
      const entry = await options.cache.get(path);
      if (entry) {
        try { return await cachedResponse(entry, request, etag); }
        catch { /* An evicted file is an ordinary cache miss. */ }
      }
    }

    // A cold range/HEAD stays small and is never retained as a complete object.
    const unchanged = notModified(request, etag), ifRange = request.headers.get("if-range");
    const requestedRange = request.method === "GET" && !unchanged && (!ifRange || ifRange === etag)
      ? request.headers.get("range") : null;
    const range = requestedRange && /^bytes=(?:\d+-\d*|-\d+)$/u.test(requestedRange) ? requestedRange : null;
    const readUpstream = async (): Promise<Response> => {
      let lastStatus = 502;
      for (const gateway of GATEWAYS) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        // Bound streaming time as well as header latency; a stalled response must not hold a fill forever.
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300_000), request.signal]);
        try {
          const response = await fetcher(`${gateway}/${path}`, {
            method: request.method === "HEAD" ? "HEAD" : "GET",
            headers: {
              "Accept-Encoding": "identity",
              ...(range ? { Range: range } : {}),
            },
            signal,
          });
          clearTimeout(timer);
          if (!response.ok) {
            lastStatus = response.status;
            cancelBody(response);
            continue;
          }
          if (response.status !== 200 && !(range && response.status === 206)) {
            cancelBody(response);
            lastStatus = 502;
            continue;
          }
          // Node fetch decompresses bodies. Never retain or forward the compressed byte length.
          const encoded = response.headers.get("content-encoding");
          if (response.status === 206 && encoded && encoded !== "identity") {
            cancelBody(response);
            lastStatus = 502;
            continue;
          }
          const rawLength = encoded && encoded !== "identity" ? null : response.headers.get("content-length");
          let length = rawLength === null ? null : Number(rawLength);
          if (length !== null && (!/^\d+$/u.test(rawLength!) || !Number.isSafeInteger(length) || length < 0)) {
            cancelBody(response);
            lastStatus = 502;
            continue;
          }
          const contentRange = response.headers.get("content-range");
          if (response.status === 206) length = contentRangeLength(contentRange, length, range!);
          if (response.status === 206 ? length === null : contentRange !== null) {
            cancelBody(response);
            lastStatus = 502;
            continue;
          }
          if (length !== null && length > PIN_LIMITS.gateway) {
            cancelBody(response);
            return failure(413, "content_too_large", "IPFS asset is too large");
          }
          const headers = mediaHeaders(response.headers.get("content-type") ?? "application/octet-stream");
          if (response.status === 206) headers.set("Accept-Ranges", "bytes");
          if (length !== null) headers.set("Content-Length", String(length));
          for (const name of ["accept-ranges", "content-range"]) {
            const value = response.headers.get(name);
            if (value) headers.set(name, value);
          }
          if (unchanged || request.method === "HEAD") {
            cancelBody(response);
            return new Response(null, { status: unchanged ? 304 : response.status, headers });
          }
          let streamed = 0;
          const body = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, stream) {
              streamed += chunk.byteLength;
              if (streamed > PIN_LIMITS.gateway || (length !== null && streamed > length)) {
                stream.error(new Error("IPFS asset exceeded its byte limit"));
              } else stream.enqueue(chunk);
            },
            flush() {
              if (length !== null && length !== streamed) throw new Error("IPFS asset is incomplete");
            },
          }), { signal });
          return new Response(body, { status: response.status, headers });
        } catch {
          if (request.signal.aborted) break;
        } finally { clearTimeout(timer); }
      }
      return failure(lastStatus >= 400 && lastStatus < 600 ? lastStatus : 502,
        "gateway_unavailable", "IPFS gateways are unavailable");
    };

    const response = options.cache && request.method === "GET" && !range
      ? await options.cache.fetch(path, readUpstream, AbortSignal.any([request.signal, AbortSignal.timeout(300_000)]))
      : await readUpstream();
    const headers = new Headers(response.headers);
    const status = unchanged && response.ok ? 304 : response.status;
    if (status === 304) {
      cancelBody(response);
      headers.delete("Content-Length");
      headers.delete("Content-Range");
    }
    for (const [key, value] of Object.entries(SAFE_HEADERS)) headers.set(key, value);
    if (response.ok || status === 304) {
      headers.set("Cache-Control", IMMUTABLE);
      headers.set("ETag", etag);
    } else headers.set("Cache-Control", "no-store");
    if (!headers.has("X-IPFS-Cache")) headers.set("X-IPFS-Cache", "BYPASS");
    return new Response(status === 304 ? null : response.body, { status, headers });
  };
}
