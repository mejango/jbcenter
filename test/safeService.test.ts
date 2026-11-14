import { describe, expect, it, vi } from "vitest";
import { createSafeGateway, SAFE_BODY_LIMIT, SAFE_RESPONSE_LIMIT } from "../src/safeService.js";
import { createApp } from "../src/app.js";
import { MemoryStore } from "./support/memoryStore.js";

const KEY = "server-only-safe-key";
const ADDRESS = `0x${"12".repeat(20)}`;
const HASH = `0x${"34".repeat(32)}`;
const BASE = "https://juicebox.center/v1/safe/base/api/v1/";
const TRANSACTION = `multisig-transactions/${HASH}/`;
const trusted = { origin: "https://revnet.money" };
const ok = () => new Response('{"safeTxHash":"' + HASH + '"}', { status: 200 });

function setup(fetcher = vi.fn(async () => ok())) {
  const gateway = createSafeGateway(KEY, fetcher);
  const app = createApp(new MemoryStore(), { safe: gateway, safeSiteLimitPerSecond: 100 });
  return { app, gateway, fetcher };
}

describe("trusted Safe service proxy", () => {
  it("keeps the key on the server, preserves the response and applies trusted-site CORS", async () => {
    const { app, fetcher } = setup();
    const response = await app.request(BASE + TRANSACTION, { headers: { ...trusted, Authorization: "Bearer browser-key", Cookie: "private=1" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ safeTxHash: HASH });
    expect(response.headers.get("access-control-allow-origin")).toBe(trusted.origin);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe(`https://api.safe.global/tx-service/base/api/v1/${TRANSACTION}`);
    expect(init.headers).toEqual({ accept: "application/json", authorization: `Bearer ${KEY}` });
    expect(init.redirect).toBe("error");
  });

  it("denies absent, untrusted and development origins before spending the upstream key", async () => {
    const { app, fetcher } = setup();
    for (const origin of [undefined, "https://evil.example", "https://dev.revnet.money", "https://revnet.money.evil.example", "https://bafy.ipfs.inbrowser.link"]) {
      const response = await app.request(BASE + TRANSACTION, { headers: origin ? { origin } : {} });
      expect(response.status).toBe(403);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not spend upstream quota on CORS preflight and returns503 if no server key is configured", async () => {
    const { app, fetcher } = setup();
    const response = await app.request(BASE + TRANSACTION, { method: "OPTIONS", headers: { ...trusted, "access-control-request-method": "GET" } });
    expect(response.status).toBe(204);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await createApp(new MemoryStore()).request(BASE + TRANSACTION, { headers: trusted })).status).toBe(503);
  });

  it("supports each SDK read and signed write while preserving exact proposal bytes", async () => {
    const { app, fetcher } = setup();
    const routes = [TRANSACTION, `owners/${ADDRESS}/safes/`, `safes/${ADDRESS}/creation/`, `safes/${ADDRESS}/multisig-transactions/?executed=false&trusted=true&ordering=nonce&limit=50&offset=200&nonce__gte=4`];
    for (const path of routes) expect((await app.request(BASE + path, { headers: trusted })).status).toBe(200);
    const body = '{ "signature": "0x1234", "nonce": 4 }';
    for (const path of [`safes/${ADDRESS}/multisig-transactions/`, TRANSACTION + "confirmations/"]) {
      const response = await app.request(BASE + path, { method: "POST", headers: { ...trusted, "content-type": "application/json" }, body });
      expect(response.status).toBe(200);
      expect((fetcher.mock.calls.at(-1) as unknown as [URL, RequestInit])[1].body).toBe(body);
    }
  });

  it("forwards a chunked POST after Hono has bounded and rebuilt its body", async () => {
    const { app, fetcher } = setup();
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"signature":'));
      controller.enqueue(new TextEncoder().encode('"0x1234"}'));
      controller.close();
    } });
    const request = new Request(BASE + `safes/${ADDRESS}/multisig-transactions/`, {
      method: "POST", headers: { ...trusted, "content-type": "application/json", "transfer-encoding": "chunked" },
      body, duplex: "half",
    } as RequestInit);
    expect((await app.request(request)).status).toBe(200);
    expect((fetcher.mock.calls[0] as unknown as [URL, RequestInit])[1].body).toBe('{"signature":"0x1234"}');
  });

  it("rejects unsupported methods, chain prefixes, paths, duplicate/oversized queries and bodies", async () => {
    const { app, fetcher } = setup();
    for (const url of [BASE.replace("/base/", "/opsepolia/") + TRANSACTION, BASE + "about/", BASE + "safes/not-an-address/creation/", BASE + TRANSACTION + "?url=https://evil.example", BASE + `safes/${ADDRESS}/multisig-transactions/?limit=51`, BASE + `safes/${ADDRESS}/multisig-transactions/?limit=1&limit=2`, BASE + `safes/${ADDRESS}/multisig-transactions/?nonce__gte=9007199254740992`, BASE + "safes/%2f%2fevil.example/creation/"]) {
      expect((await app.request(url, { headers: trusted })).status).toBe(400);
    }
    expect((await app.request(BASE + TRANSACTION, { method: "DELETE", headers: trusted })).status).toBe(404);
    expect((await app.request(BASE + TRANSACTION, { method: "POST", headers: trusted, body: "{}" })).status).toBe(400);
    const target = BASE + `safes/${ADDRESS}/multisig-transactions/`;
    for (const body of ["[]", "not json"]) expect((await app.request(target, { method: "POST", headers: { ...trusted, "content-type": "application/json" }, body })).status).toBe(400);
    expect((await app.request(target, { method: "POST", headers: { ...trusted, "content-type": "application/json" }, body: "x".repeat(SAFE_BODY_LIMIT + 1) })).status).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves upstream quota failure and reset headers without retrying or exposing cookies", async () => {
    const fetcher = vi.fn(async () => new Response('{"error_msg":"Monthly quota exceeded"}', { status: 429, headers: { "Retry-After": "1200", "X-RateLimit-Reset": "1200", "Set-Cookie": "private=1" } }));
    const { app } = setup(fetcher);
    const response = await app.request(BASE + TRANSACTION, { headers: trusted });
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error_msg: "Monthly quota exceeded" });
    expect(response.headers.get("retry-after")).toBe("1200");
    expect(response.headers.get("x-ratelimit-reset")).toBe("1200");
    expect(response.headers.get("access-control-expose-headers")).toContain("X-RateLimit-Reset");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("allows empty successful POST responses and redacts any echoed server credential", async () => {
    const { app } = setup(vi.fn(async () => new Response(null, { status: 201 })));
    expect((await app.request(BASE + `safes/${ADDRESS}/multisig-transactions/`, { method: "POST", headers: { ...trusted, "content-type": "application/json" }, body: "{}" })).status).toBe(201);
    const echo = setup(vi.fn(async () => new Response(JSON.stringify({ error_msg: KEY }), { status: 401, headers: { "X-RateLimit-Warning": KEY } })));
    const response = await echo.app.request(BASE + TRANSACTION, { headers: trusted });
    expect(await response.text()).not.toContain(KEY);
    expect([...response.headers.values()].join()).not.toContain(KEY);
  });

  it("refuses redirect, oversized and non-JSON responses and never returns credential-bearing fetch errors", async () => {
    for (const upstream of [new Response(null, { status: 302, headers: { location: "https://evil.example" } }), new Response("{}", { headers: { "Content-Length": String(SAFE_RESPONSE_LIMIT + 1) } }), new Response("x".repeat(SAFE_RESPONSE_LIMIT + 1)), new Response("<html>bad gateway</html>")]) {
      const { app } = setup(vi.fn(async () => upstream));
      expect((await app.request(BASE + TRANSACTION, { headers: trusted })).status).toBe(502);
    }
    const { app } = setup(vi.fn(async () => { throw new Error(KEY); }));
    const response = await app.request(BASE + TRANSACTION, { headers: trusted });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(KEY);
  });

  it("times out body reads and stops them when the caller aborts", async () => {
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } })));
    const timed = createSafeGateway(KEY, fetcher, 5);
    await expect(timed.request(new Request(BASE + TRANSACTION))).rejects.toThrow("Safe transaction service is unavailable");
    const controller = new AbortController();
    const pending = createSafeGateway(KEY, fetcher).request(new Request(BASE + TRANSACTION, { signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toThrow("Safe transaction service is unavailable");
  });

  it("uses separate per-caller and shared budgets before calling Safe", async () => {
    const fetcher = vi.fn(async () => ok());
    const app = createApp(new MemoryStore(), { safe: createSafeGateway(KEY, fetcher), safeRequestLimitPerMinute: 1, safeSiteLimitPerSecond: 1 });
    expect((await app.request(BASE + TRANSACTION, { headers: trusted })).status).toBe(200);
    expect((await app.request(BASE + TRANSACTION, { headers: trusted })).status).toBe(429);
    expect((await app.request(BASE + TRANSACTION, { headers: { origin: "https://juicebox.money" } })).status).toBe(429);
    expect((await app.request("https://juicebox.center/v1/search", { headers: trusted })).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
