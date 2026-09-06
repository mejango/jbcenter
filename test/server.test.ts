import { createHash } from "node:crypto";
import { request } from "node:http";
import { connect } from "node:net";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createHttpHandler,
  createMcpServer,
  createServices,
  loadConfig,
  type HttpOptions,
} from "@juicebox/mcp/host";
import { createApp, type AppOptions } from "../src/app.js";
import type { PinningService } from "../src/ipfs.js";
import type { RpcGateway } from "../src/rpc.js";
import { createCenterServer, type CenterServer } from "../src/server.js";
import type { NewDeployment, NewIntent, StorageLimits, Store } from "../src/store.js";

const CID = "QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR";
const mcpHeaders = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};
const toolsList = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
const servers: CenterServer[] = [];
const clients: Client[] = [];

class ServerStore implements Store {
  health = vi.fn(async () => {});
  consumeRequest = vi.fn(async (_client: string, limit: number) => ({
    allowed: true,
    remaining: limit - 1,
  }));
  async createIntent(_value: NewIntent, _limits: StorageLimits): Promise<never> {
    throw new Error("This transport fixture does not publish intents");
  }
  async getIntent() {
    return null;
  }
  async search() {
    return { items: [], totalCount: 0, nextCursor: null };
  }
  async recordDeployment(_id: string, _value: NewDeployment): Promise<never> {
    throw new Error("This transport fixture does not record deployments");
  }
}

function fixtureServer() {
  const server = new McpServer({ name: "center-transport-fixture", version: "1.0.0" });
  server.registerTool("echo", {}, async () => ({ content: [{ type: "text", text: "ready" }] }));
  return server;
}

async function start(
  options: {
    store?: ServerStore;
    app?: AppOptions;
    factory?: () => McpServer;
    http?: HttpOptions;
    grace?: number;
  } = {},
) {
  const store = options.store ?? new ServerStore();
  const config = loadConfig({ PORT: "0" });
  const mcp = createHttpHandler(config, options.factory ?? fixtureServer, {
    ...options.http,
    healthPath: "/mcp/healthz",
    readinessPath: "/mcp/readyz",
    indexPath: false,
  });
  const app = createApp(store, options.app);
  const server = createCenterServer(app.fetch, mcp, {
    port: 0,
    hostname: "127.0.0.1",
    shutdownGraceMs: options.grace ?? 100,
  });
  servers.push(server);
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  return { server, store, mcp, base, url: new URL(`${base}/mcp`) };
}

async function post(
  url: URL | string,
  body: unknown = toolsList,
  headers: Record<string, string> = {},
) {
  return fetch(url, {
    method: "POST",
    headers: { ...mcpHeaders, ...headers },
    body: JSON.stringify(body),
  });
}

function rawPost(url: URL, host: string) {
  return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const req = request(url, { method: "POST", headers: { ...mcpHeaders, host } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.once("end", () =>
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }),
      );
    });
    req.once("error", reject);
    req.end(JSON.stringify(toolsList));
  });
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("Center and MCP share one HTTP listener", () => {
  it("serves the complete MCP through the official client alongside Center", async () => {
    const originalRequest = globalThis.Request;
    const originalResponse = globalThis.Response;
    const services = createServices(loadConfig({ PORT: "0" }));
    const { url, base, mcp } = await start({ factory: () => createMcpServer(services) });
    expect(globalThis.Request).toBe(originalRequest);
    expect(globalThis.Response).toBe(originalResponse);
    const client = new Client({ name: "center-integration-client", version: "1.0.0" });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(url);
    // The SDK declares sessionId?: string on Transport but its stateless getter
    // returns string | undefined, which conflicts with exactOptionalPropertyTypes.
    await client.connect(transport as Parameters<Client["connect"]>[0]);
    expect(client.getServerVersion()?.name).toBe("juicebox-mcp");
    expect(transport.sessionId).toBeUndefined();
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "jb_list_capabilities",
        "jb_get_project",
        "jb_prepare_project_metadata",
        "jb_pin_project_metadata",
      ]),
    );
    const capabilities = await client.callTool({ name: "jb_list_capabilities", arguments: {} });
    expect(capabilities.isError).not.toBe(true);
    expect((await client.listResources()).resources.map((resource) => resource.uri)).toContain(
      "juicebox://capabilities",
    );
    expect(
      (await client.readResource({ uri: "juicebox://capabilities" })).contents[0],
    ).toHaveProperty("text");
    expect((await client.listPrompts()).prompts.map((prompt) => prompt.name)).toContain(
      "build-webclient",
    );
    expect(
      (
        await client.getPrompt({
          name: "build-webclient",
          arguments: { request: "Build a V6 contribution page" },
        })
      ).messages[0]?.role,
    ).toBe("user");
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true });
    await vi.waitFor(() => expect(mcp.activeRequests()).toBe(0));
  });

  it("keeps Center readiness database-backed and its metrics bearer-protected", async () => {
    const store = new ServerStore();
    const { base } = await start({ store, app: { metricsToken: "test-metrics-token" } });
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true });
    expect(store.health).not.toHaveBeenCalled();
    expect(await (await fetch(`${base}/readyz`)).json()).toEqual({ ok: true });
    expect(store.health).toHaveBeenCalledOnce();
    expect(await (await fetch(`${base}/mcp/readyz`)).json()).toMatchObject({
      status: "ready",
      upstreamHealth: "not_checked",
    });
    expect(store.health).toHaveBeenCalledOnce();
    expect((await fetch(`${base}/metrics`)).status).toBe(404);
    expect(
      (await fetch(`${base}/metrics`, { headers: { authorization: "Bearer incorrect" } })).status,
    ).toBe(404);
    const metrics = await fetch(`${base}/metrics`, {
      headers: { authorization: "Bearer test-metrics-token" },
    });
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain("jbcenter_http_requests_total");
    store.health.mockRejectedValueOnce(new Error("fixture database unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await fetch(`${base}/readyz`)).status).toBe(500);
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      expect((await fetch(`${base}/mcp/readyz`)).status).toBe(200);
    } finally {
      log.mockRestore();
    }
  });

  it("preserves Center origin authorization and public RPC request bodies", async () => {
    const rpc: RpcGateway = {
      supports: () => true,
      request: vi.fn(async (_chainId, body) => ({ jsonrpc: "2.0", id: body.id, result: "0x2105" })),
    };
    const { base, url, store } = await start({ app: { rpc } });
    expect((await fetch(`${base}/v1/search`)).status).toBe(403);
    expect(
      (await fetch(`${base}/v1/search`, { headers: { origin: "https://evil.example" } })).status,
    ).toBe(403);
    expect(
      (await fetch(`${base}/v1/search`, { headers: { origin: "https://juicebox.money" } })).status,
    ).toBe(200);
    const body = { jsonrpc: "2.0", id: "wire-id", method: "eth_chainId", params: [] };
    const response = await post(`${base}/v1/rpc/8453`, body, {
      origin: "https://ipfs-client.example",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: "wire-id", result: "0x2105" });
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(rpc.request).toHaveBeenCalledWith(8453, body);
    expect(store.consumeRequest.mock.calls.some(([client]) => client.startsWith("public:"))).toBe(
      true,
    );
    expect((await post(url, toolsList, { origin: "https://ipfs-client.example" })).status).toBe(
      403,
    );
    expect((await post(url)).status).toBe(200);
  });

  it("keeps the Center JSON upload limit independent from MCP and preserves exact bytes", async () => {
    let received: Buffer | undefined;
    const pinning: PinningService = {
      pin: vi.fn(async (content) => {
        received = Buffer.from(await content.arrayBuffer());
        return { cid: CID, status: "queued" as const };
      }),
      pinStream: vi.fn(async () => {
        throw new Error("Unexpected stream path");
      }),
    };
    const { base, url } = await start({ app: { pinning } });
    const body = JSON.stringify({ name: "Fixture metadata", description: "x".repeat(300_000) });
    const response = await fetch(`${base}/v1/pins/json`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://juicebox.money" },
      body,
    });
    expect(response.status).toBe(201);
    expect(received?.equals(Buffer.from(body))).toBe(true);
    expect(pinning.pin).toHaveBeenCalledOnce();
    expect((await post(url, JSON.parse(body))).status).toBe(413);
    const denied = await post(`${base}/v1/pins/json`, { name: "not authorized" });
    expect(denied.status).toBe(403);
    expect(pinning.pin).toHaveBeenCalledOnce();
  });

  it("streams multipart media intact to a local fake pinning backend", async () => {
    const bytes = Uint8Array.from({ length: 350_000 }, (_, index) => index % 251);
    let receivedBytes = 0;
    let receivedHash = "";
    const pinning: PinningService = {
      pin: vi.fn(async () => {
        throw new Error("Unexpected buffered pin path");
      }),
      pinStream: vi.fn(async (content: Readable) => {
        const hash = createHash("sha256");
        for await (const chunk of content) {
          const buffer = Buffer.from(chunk);
          receivedBytes += buffer.length;
          hash.update(buffer);
        }
        receivedHash = hash.digest("hex");
        return { cid: CID, status: "queued" as const };
      }),
    };
    const { base } = await start({ app: { pinning } });
    const body = new FormData();
    body.set("file", new Blob([bytes], { type: "video/mp4" }), "fixture.mp4");
    const response = await fetch(`${base}/v1/pins/media`, {
      method: "POST",
      headers: { origin: "https://juicebox.money" },
      body,
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ cid: CID, uri: `ipfs://${CID}` });
    expect(receivedBytes).toBe(bytes.length);
    expect(receivedHash).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(pinning.pinStream).toHaveBeenCalledOnce();
    expect(pinning.pin).not.toHaveBeenCalled();
  });

  it("dispatches only the MCP path boundary and isolates its Host and method checks", async () => {
    const { url, base } = await start();
    expect((await post(`${base}/mcp?client=test`)).status).toBe(200);
    expect((await post(`${base}/mcp/`)).status).toBe(200);
    for (const path of ["/mcpx", "/mcp.json", "/MCP", "/%6dcp"]) {
      const response = await post(`${base}${path}`);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("text/plain");
    }
    const unknownMcp = await post(`${base}/mcp/unknown`);
    expect(unknownMcp.status).toBe(404);
    expect(await unknownMcp.json()).toMatchObject({ error: { message: "Not found." } });
    expect((await fetch(url)).status).toBe(405);
    expect((await rawPost(url, "attacker.example")).status).toBe(403);
    expect((await rawPost(new URL(`${base}/healthz`), "attacker.example")).status).toBe(404);
  });

  it("allows an active MCP operation to finish during shared shutdown", async () => {
    let complete: (() => void) | undefined;
    const { server, url, mcp } = await start({
      grace: 1000,
      factory: () => {
        const protocol = fixtureServer();
        protocol.registerTool("wait", {}, async () => {
          await new Promise<void>((resolve) => {
            complete = resolve;
          });
          return { content: [{ type: "text", text: "completed" }] };
        });
        return protocol;
      },
    });
    const pending = post(url, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "wait", arguments: {} },
    });
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    const forceClose = vi.spyOn(server.server, "closeAllConnections");
    const closing = server.close();
    expect(mcp.isDraining()).toBe(true);
    complete!();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { content: [{ text: "completed" }] } });
    await closing;
    expect(forceClose).not.toHaveBeenCalled();
    expect(mcp.activeRequests()).toBe(0);
    await expect(server.listen()).rejects.toThrow("cannot be restarted");
  });

  it("cancels hanging MCP operations at the shared shutdown deadline", async () => {
    let started = false;
    let cancelled = false;
    const { server, url, mcp } = await start({
      grace: 30,
      factory: () => {
        const protocol = fixtureServer();
        protocol.registerTool("wait", {}, async (extra) => {
          started = true;
          await new Promise<void>((resolve) => {
            extra.signal.addEventListener(
              "abort",
              () => {
                cancelled = true;
                resolve();
              },
              { once: true },
            );
          });
          return { content: [] };
        });
        return protocol;
      },
    });
    const pending = post(url, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "wait", arguments: {} },
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(started).toBe(true));
    await Promise.all([server.close(), server.close()]);
    await pending;
    expect(cancelled).toBe(true);
    expect(mcp.activeRequests()).toBe(0);
    expect(server.server.listening).toBe(false);
  });

  it("reports forced protocol disposal failures without an unhandled rejection", async () => {
    let started = false;
    const { server, url, mcp } = await start({
      grace: 30,
      factory: () => {
        const protocol = fixtureServer();
        protocol.registerTool("wait", {}, async (extra) => {
          started = true;
          await new Promise<void>((resolve) => {
            extra.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return { content: [] };
        });
        return protocol;
      },
    });
    // This runtime intentionally rejects close, so manage its cleanup within this test.
    servers.splice(servers.indexOf(server), 1);
    const dispose = mcp.close.bind(mcp);
    const failure = new Error("fixture protocol disposal failed");
    const close = vi.spyOn(mcp, "close").mockImplementation(async () => {
      await dispose();
      throw failure;
    });
    const pending = post(url, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "wait", arguments: {} },
    }).catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(started).toBe(true));
      await expect(server.close()).rejects.toBe(failure);
      await pending;
      expect(close).toHaveBeenCalledOnce();
      expect(mcp.activeRequests()).toBe(0);
      expect(server.server.listening).toBe(false);
    } finally {
      await server.close().catch(() => {});
      await dispose();
    }
  });

  it("rejects a pipelined readiness request during draining while existing Center work finishes", async () => {
    let finishRpc: (() => void) | undefined;
    const rpc: RpcGateway = {
      supports: () => true,
      request: async (_chainId, body) => {
        await new Promise<void>((resolve) => {
          finishRpc = resolve;
        });
        return { jsonrpc: "2.0", id: body.id, result: "0x2105" };
      },
    };
    const { server, url, store } = await start({ app: { rpc }, grace: 1000 });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
    const socket = connect(Number(url.port), "127.0.0.1");
    const result = new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      socket.once("error", reject);
      socket.once("end", () => resolve(Buffer.concat(chunks).toString()));
    });
    socket.write(
      `POST /v1/rpc/8453 HTTP/1.1\r\nHost: 127.0.0.1:${url.port}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    await vi.waitFor(() => expect(finishRpc).toBeTypeOf("function"));
    const closing = server.close();
    socket.write(
      `GET /readyz HTTP/1.1\r\nHost: 127.0.0.1:${url.port}\r\nConnection: close\r\n\r\n`,
    );
    // Allow Node to dispatch the pipelined request before releasing the earlier response.
    await new Promise((resolve) => setTimeout(resolve, 20));
    finishRpc!();
    const responses = await result;
    expect(responses).toContain("HTTP/1.1 200 OK");
    expect(responses).toContain("HTTP/1.1 503 Service Unavailable");
    expect(responses).toContain('"code":"draining"');
    expect(store.health).not.toHaveBeenCalled();
    await closing;
  });
});
