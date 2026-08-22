import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import {
  PIN_LIMITS,
  RedundantIpfsPinning,
  isIpfsCid,
  safeIpfsPath,
  type PinningService,
} from "../src/ipfs.js";
import type { NewDeployment, NewIntent, StorageLimits, Store } from "../src/store.js";

const CID = "QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR";
const keys = [{ name: "server", secret: "server-secret", role: "client" as const }];

class PinStore implements Store {
  requests = new Map<string, number>();
  async health() {}
  async consumeRequest(client: string, limit: number) {
    const count = (this.requests.get(client) ?? 0) + 1;
    this.requests.set(client, count);
    return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
  }
  async createIntent(_value: NewIntent, _limits: StorageLimits): Promise<never> {
    throw new Error("not used");
  }
  async getIntent(): Promise<null> {
    return null;
  }
  async search() {
    return { items: [], totalCount: 0, nextCursor: null };
  }
  async recordDeployment(_intentId: string, _value: NewDeployment): Promise<never> {
    throw new Error("not used");
  }
}

function app(pinning?: PinningService, store = new PinStore()) {
  return createApp(store, keys, pinning ? { pinning } : {});
}

function pinningMock() {
  return { pin: vi.fn(async () => ({ cid: CID, status: "queued" as const })) };
}

function jsonRequest(value: string, origin = "https://juicebox.money") {
  return {
    method: "POST",
    headers: { origin, "content-type": "application/json", "x-real-ip": "203.0.113.1" },
    body: value,
  };
}

describe("IPFS pinning", () => {
  it("validates canonical CIDs and bounded paths", () => {
    expect(isIpfsCid(CID)).toBe(true);
    expect(isIpfsCid(`${CID}x`)).toBe(false);
    expect(safeIpfsPath(`${CID}/metadata.json`)).toBe(`${CID}/metadata.json`);
    expect(safeIpfsPath(`${CID}/../secret`)).toBeNull();
  });

  it("pins JSON directly from either trusted browser origin", async () => {
    for (const origin of ["https://juicebox.money", "https://revnet.money"]) {
      const pinning = pinningMock();
      const response = await app(pinning).request(
        "/v1/pins/json",
        jsonRequest('{"name":"Public goods"}', origin),
      );
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({
        cid: CID,
        status: "queued",
        uri: `ipfs://${CID}`,
        gatewayUrl: `/ipfs/${CID}`,
      });
      expect(pinning.pin).toHaveBeenCalledOnce();
    }
  });

  it("rejects foreign browsers while allowing authenticated originless servers", async () => {
    const pinning = pinningMock();
    const foreign = await app(pinning).request(
      "/v1/pins/json",
      jsonRequest("{}", "https://example.com"),
    );
    expect(foreign.status).toBe(403);

    const server = await app(pinning).request("/v1/pins/json", {
      method: "POST",
      headers: {
        authorization: "Bearer server-secret",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(server.status).toBe(201);
  });

  it("rejects missing providers, malformed JSON, and oversized JSON", async () => {
    expect((await app().request("/v1/pins/json", jsonRequest("{}"))).status).toBe(503);
    expect((await app(pinningMock()).request("/v1/pins/json", jsonRequest("{"))).status).toBe(400);
    const oversized = JSON.stringify({ value: "x".repeat(PIN_LIMITS.json) });
    expect(
      (await app(pinningMock()).request("/v1/pins/json", jsonRequest(oversized))).status,
    ).toBe(413);
  });

  it("accepts images and rejects unsupported media", async () => {
    const pinning = pinningMock();
    const image = new FormData();
    image.append("file", new File(["png"], "logo.png", { type: "image/png" }));
    const accepted = await app(pinning).request("/v1/pins/file", {
      method: "POST",
      headers: { origin: "https://revnet.money", "x-real-ip": "203.0.113.2" },
      body: image,
    });
    expect(accepted.status).toBe(201);

    const executable = new FormData();
    executable.append("file", new File(["alert(1)"], "x.js", { type: "text/javascript" }));
    const rejected = await app(pinning).request("/v1/pins/file", {
      method: "POST",
      headers: { origin: "https://revnet.money", "x-real-ip": "203.0.113.3" },
      body: executable,
    });
    expect(rejected.status).toBe(415);
  });

  it("accepts the image byte ceiling and rejects one byte beyond it", async () => {
    const pinning = pinningMock();
    const atLimit = new FormData();
    atLimit.append(
      "file",
      new File([new Uint8Array(PIN_LIMITS.image)], "limit.png", { type: "image/png" }),
    );
    const accepted = await app(pinning).request("/v1/pins/file", {
      method: "POST",
      headers: { origin: "https://juicebox.money", "x-real-ip": "203.0.113.4" },
      body: atLimit,
    });
    expect(accepted.status).toBe(201);

    const aboveLimit = new FormData();
    aboveLimit.append(
      "file",
      new File([new Uint8Array(PIN_LIMITS.image + 1)], "large.png", { type: "image/png" }),
    );
    const rejected = await app(pinning).request("/v1/pins/file", {
      method: "POST",
      headers: { origin: "https://juicebox.money", "x-real-ip": "203.0.113.5" },
      body: aboveLimit,
    });
    expect(rejected.status).toBe(413);
  });

  it("enforces caller pin budgets in shared storage", async () => {
    const service = app(pinningMock());
    const responses = [];
    for (let index = 0; index < 11; index += 1) {
      responses.push(await service.request("/v1/pins/json", jsonRequest("{}")));
    }
    expect(responses.slice(0, 10).every(({ status }) => status === 201)).toBe(true);
    expect(responses[10]?.status).toBe(429);
  });

  it("creates a CID with Filebase before asking Pinata to replicate that exact CID", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ Hash: CID }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { cid: CID, status: "retrieving" } }), { status: 200 }),
      );
    const service = new RedundantIpfsPinning("filebase-token", "pinata-token", fetcher);
    await expect(service.pin(new Blob(["hello"]), "hello.txt")).resolves.toEqual({
      cid: CID,
      status: "queued",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const pinataInit = fetcher.mock.calls[1]?.[1];
    expect(pinataInit?.body).toBe(JSON.stringify({ cid: CID, name: "hello.txt" }));
    expect((pinataInit?.headers as Record<string, string>).Authorization).toBe("Bearer pinata-token");
  });

  it("fails closed when a provider returns a mismatched CID", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ Hash: CID }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { cid: `${CID}x` } }), { status: 200 }));
    const service = new RedundantIpfsPinning("filebase-token", "pinata-token", fetcher);
    await expect(service.pin(new Blob(["hello"]), "hello.txt")).rejects.toThrow("mismatched");
  });
});

describe("public IPFS gateway", () => {
  it("needs no auth, falls back across gateways, and returns immutable CORS content", async () => {
    const gatewayFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(
        new Response('{"name":"Public goods"}', {
          headers: { "content-type": "application/json", "content-length": "23" },
        }),
      );
    const service = createApp(new PinStore(), keys, { gatewayFetch });
    const response = await service.request(`/ipfs/${CID}/metadata.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(await response.text()).toBe('{"name":"Public goods"}');
    expect(gatewayFetch).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid paths before contacting a gateway", async () => {
    const gatewayFetch = vi.fn<typeof fetch>();
    const response = await createApp(new PinStore(), keys, { gatewayFetch }).request(
      "/ipfs/not-a-cid/file",
    );
    expect(response.status).toBe(400);
    expect(gatewayFetch).not.toHaveBeenCalled();
  });
});
