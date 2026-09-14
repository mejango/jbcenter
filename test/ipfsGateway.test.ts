import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IpfsDiskCache } from "../src/ipfsCache.js";
import { createIpfsGateway } from "../src/ipfsGateway.js";

const CID = "QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR";
const PATH = `${CID}/logo.png`;
const ETAG = `"ipfs:${PATH}"`;
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const request = (init?: RequestInit, path = PATH) => new Request(`https://juicebox.center/ipfs/${path}`, init);
async function setup(fetcher: typeof fetch) {
  const directory = await mkdtemp(join(tmpdir(), "center-ipfs-gateway-"));
  directories.push(directory);
  const options = { directory, maxBytes: 1024, maxEntryBytes: 1024 };
  const cache = new IpfsDiskCache(options);
  await cache.ready();
  return { cache, options, gateway: createIpfsGateway({ cache, fetcher }) };
}
const upstream = () => new Response("0123456789", { headers: { "content-type": "image/png", "content-length": "10" } });

describe("persistent public IPFS gateway", () => {
  it("serves a persistent offline hit after restart, preserving response security and media headers", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => upstream());
    const { gateway, options } = await setup(fetcher);
    const first = await gateway(request());
    expect(first.headers.get("x-ipfs-cache")).toBe("MISS");
    expect(await first.text()).toBe("0123456789");
    const offline = vi.fn<typeof fetch>().mockRejectedValue(new Error("all gateways offline"));
    const restarted = createIpfsGateway({ cache: new IpfsDiskCache(options), fetcher: offline });
    const hit = await restarted(request());
    expect(hit.status).toBe(200);
    expect(hit.headers.get("x-ipfs-cache")).toBe("HIT");
    expect(await hit.text()).toBe("0123456789");
    for (const name of ["content-type", "content-length", "etag", "cache-control", "access-control-allow-origin", "access-control-expose-headers", "content-security-policy", "cross-origin-resource-policy", "x-content-type-options"]) {
      expect(hit.headers.get(name), name).toBe(first.headers.get(name));
    }
    expect(hit.headers.get("content-security-policy")).toContain("sandbox");
    expect(hit.headers.get("access-control-allow-origin")).toBe("*");
    expect(hit.headers.get("cache-control")).toContain("immutable");
    expect(hit.headers.get("etag")).toBe(ETAG);
    expect(offline).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("answers HEAD and bounded, open-ended and suffix ranges entirely from disk", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => upstream());
    const { gateway } = await setup(fetcher);
    await (await gateway(request())).text();
    const head = await gateway(request({ method: "HEAD", headers: { range: "bytes=1-3" } }));
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("10");
    expect(head.headers.get("content-range")).toBeNull();
    expect(head.headers.get("accept-ranges")).toBe("bytes");
    expect(await head.text()).toBe("");
    for (const [range, body, contentRange] of [
      ["bytes=1-3", "123", "bytes 1-3/10"],
      ["bytes=7-", "789", "bytes 7-9/10"],
      ["bytes=-4", "6789", "bytes 6-9/10"],
      ["bytes=8-999", "89", "bytes 8-9/10"],
    ]) {
      const response = await gateway(request({ headers: { range: range! } }));
      expect(response.status).toBe(206);
      expect(response.headers.get("x-ipfs-cache")).toBe("HIT");
      expect(response.headers.get("content-range")).toBe(contentRange);
      expect(response.headers.get("content-length")).toBe(String(body!.length));
      expect(await response.text()).toBe(body);
    }
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("honors If-Range and conditional validators, and safely rejects unsatisfiable ranges", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => upstream());
    const { gateway } = await setup(fetcher);
    await (await gateway(request())).text();
    const matching = await gateway(request({ headers: { range: "bytes=1-3", "if-range": ETAG } }));
    expect(matching.status).toBe(206);
    expect(await matching.text()).toBe("123");
    for (const validator of ['"other"', `W/${ETAG}`, "Wed, 21 Oct 2015 07:28:00 GMT"]) {
      const mismatch = await gateway(request({ headers: { range: "bytes=1-3", "if-range": validator } }));
      expect(mismatch.status).toBe(200);
      expect(mismatch.headers.has("content-range")).toBe(false);
      expect(await mismatch.text()).toBe("0123456789");
    }
    for (const validator of [ETAG, `"other", W/${ETAG}`, "*"]) {
      const unchanged = await gateway(request({ headers: { "if-none-match": validator, range: "bytes=1-3" } }));
      expect(unchanged.status).toBe(304);
      expect(unchanged.headers.get("etag")).toBe(ETAG);
      expect(await unchanged.text()).toBe("");
    }
    for (const range of ["bytes=10-", "bytes=-0"]) {
      const rejected = await gateway(request({ headers: { range } }));
      expect(rejected.status).toBe(416);
      expect(rejected.headers.get("content-range")).toBe("bytes */10");
      expect(rejected.headers.get("cache-control")).toBe("no-store");
      expect(await rejected.text()).toBe("");
    }
    const malformed = await gateway(request({ headers: { range: "bytes=0-1,4-5" } }));
    expect(malformed.status).toBe(200);
    expect(await malformed.text()).toBe("0123456789");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("retains empty assets and supplies correct empty HEAD and range responses", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response("", { headers: { "content-length": "0" } }));
    const { gateway } = await setup(fetcher);
    expect(await (await gateway(request())).text()).toBe("");
    const hit = await gateway(request());
    expect(hit.headers.get("x-ipfs-cache")).toBe("HIT");
    expect(hit.headers.get("content-length")).toBe("0");
    expect(await hit.text()).toBe("");
    const head = await gateway(request({ method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("0");
    const range = await gateway(request({ headers: { range: "bytes=0-" } }));
    expect(range.status).toBe(416);
    expect(range.headers.get("content-range")).toBe("bytes */0");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("forces navigable content to download on both the first request and disk hits", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response("<script>unsafe()</script>", { headers: { "content-type": "text/html", "set-cookie": "do-not-forward=1" } }));
    const { gateway } = await setup(fetcher);
    for (const expected of ["MISS", "HIT"]) {
      const response = await gateway(request());
      expect(response.headers.get("x-ipfs-cache")).toBe(expected);
      expect(response.headers.get("content-type")).toBe("application/octet-stream");
      expect(response.headers.get("content-disposition")).toBe("attachment; filename=ipfs-asset");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.has("set-cookie")).toBe(false);
      expect(await response.text()).toBe("<script>unsafe()</script>");
    }
  });

  it("does not retain errors or truncated streams and fetches fresh content after recovery", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response("limited", { status: 429 }));
    const { gateway, cache, options } = await setup(fetcher);
    const unavailable = await gateway(request());
    expect(unavailable.status).toBe(429);
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
    expect(unavailable.headers.get("x-ipfs-cache")).toBe("BYPASS");
    await unavailable.text();
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(await cache.get(PATH)).toBeNull();
    fetcher.mockImplementation(async () => new Response("short", { headers: { "content-length": "10" } }));
    await expect((await gateway(request())).text()).rejects.toThrow("incomplete");
    expect(await cache.get(PATH)).toBeNull();
    expect(await readdir(options.directory)).toEqual([]);
    fetcher.mockImplementation(async () => upstream());
    const recovered = await gateway(request());
    expect(recovered.headers.get("x-ipfs-cache")).toBe("MISS");
    expect(await recovered.text()).toBe("0123456789");
    const hit = await gateway(request());
    expect(hit.headers.get("x-ipfs-cache")).toBe("HIT");
    expect(await hit.text()).toBe("0123456789");
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it("forwards cold ranges without caching partial bodies and forwards cold HEAD without filling", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      if (init?.method === "HEAD") return new Response(null, { headers: { "content-length": "10", "content-type": "video/mp4" } });
      expect(new Headers(init?.headers).get("range")).toBe("bytes=1-3");
      expect(new Headers(init?.headers).get("if-range")).toBe(ETAG);
      return new Response("123", { status: 206, headers: { "content-type": "video/mp4", "content-length": "3", "content-range": "bytes 1-3/10" } });
    });
    const { gateway, cache } = await setup(fetcher);
    const range = await gateway(request({ headers: { range: "bytes=1-3", "if-range": ETAG } }));
    expect(range.status).toBe(206);
    expect(range.headers.get("x-ipfs-cache")).toBe("BYPASS");
    expect(range.headers.get("accept-ranges")).toBe("bytes");
    expect(range.headers.get("content-range")).toBe("bytes 1-3/10");
    expect(await range.text()).toBe("123");
    const head = await gateway(request({ method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("10");
    expect(head.headers.get("x-ipfs-cache")).toBe("BYPASS");
    expect(await head.text()).toBe("");
    expect(await cache.get(PATH)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retains decoded full content using the actual byte length", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response("decoded content", { headers: { "content-encoding": "gzip", "content-length": "4", "content-type": "text/plain" } }));
    const { gateway } = await setup(fetcher);
    const miss = await gateway(request());
    expect(miss.headers.has("content-encoding")).toBe(false);
    expect(miss.headers.has("content-length")).toBe(false);
    expect(await miss.text()).toBe("decoded content");
    const hit = await gateway(request());
    expect(hit.headers.get("content-length")).toBe("15");
    expect(await hit.text()).toBe("decoded content");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("falls back when partial responses have invalid ranges or compressed byte offsets", async () => {
    for (const badHeaders of [
      {},
      { "content-range": "bytes 3-1/10" },
      { "content-range": "bytes 1-3/3" },
      { "content-range": "bytes 1-4/10" },
      { "content-range": "bytes 1-3/10", "content-encoding": "gzip" },
    ]) {
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response("123", { status: 206, headers: { "content-length": "3", ...badHeaders } }))
        .mockResolvedValueOnce(new Response("123", { status: 206, headers: { "content-length": "3", "content-range": "bytes 1-3/10" } }));
      const { gateway, cache } = await setup(fetcher);
      const response = await gateway(request({ headers: { range: "bytes=1-3" } }));
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe("bytes 1-3/10");
      expect(await response.text()).toBe("123");
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(await cache.get(PATH)).toBeNull();
    }
  });

  it("releases aborted fills and waiters even when the first caller stops reading", async () => {
    for (const readFirstChunk of [false, true]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("first")); },
      }))).mockImplementation(async () => upstream());
      const { gateway, options } = await setup(fetcher);
      const controller = new AbortController();
      const first = await gateway(request({ signal: controller.signal }));
      const reader = first.body!.getReader();
      if (readFirstChunk) expect((await reader.read()).value).toHaveLength(5);
      const abandonedController = new AbortController();
      const abandoned = gateway(request({ signal: abandonedController.signal }));
      abandonedController.abort(new Error("waiter disconnected"));
      await expect(abandoned).rejects.toThrow("waiter disconnected");
      expect(fetcher).toHaveBeenCalledOnce();
      const waiter = gateway(request());
      controller.abort(new Error("stream deadline"));
      const recovered = await waiter;
      expect(await recovered.text()).toBe("0123456789");
      await expect(reader.read()).rejects.toThrow("stream deadline");
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect((await readdir(options.directory)).every((entry) => !entry.startsWith(".tmp-"))).toBe(true);
    }
  });
});
