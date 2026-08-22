import { describe, expect, it, vi } from "vitest";
import {
  createRpcGateway,
  parseRpcRequest,
  parseRpcUpstreams,
  RpcBadRequest,
  RpcUnavailable,
} from "../src/rpc.js";

const chainIdRequest = { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] } as const;

describe("RPC configuration", () => {
  it("parses bounded HTTPS upstream lists", () => {
    const config = parseRpcUpstreams(
      JSON.stringify({
        1: "https://primary.example/secret-path",
        10: ["https://primary.optimism.example", "https://fallback.optimism.example"],
      }),
    );
    expect(config.get(1)).toEqual(["https://primary.example/secret-path"]);
    expect(config.get(10)).toEqual([
      "https://primary.optimism.example/",
      "https://fallback.optimism.example/",
    ]);
  });

  it.each([
    "not-json",
    "[]",
    '{"0":"https://rpc.example"}',
    '{"1":"http://rpc.example"}',
    '{"1":"https://user:secret@rpc.example"}',
    '{"1":[]}',
    '{"1":["https://a.example","https://b.example","https://c.example","https://d.example"]}',
  ])("rejects unsafe RPC configuration %s", (raw) => {
    expect(() => parseRpcUpstreams(raw)).toThrow(/JBCENTER_RPC_URLS/u);
  });
});

describe("read-only JSON-RPC policy", () => {
  it("accepts ordinary viem reads", () => {
    expect(parseRpcRequest(chainIdRequest)).toEqual(chainIdRequest);
    expect(
      parseRpcRequest({
        jsonrpc: "2.0",
        id: "call-1",
        method: "eth_call",
        params: [{ to: `0x${"12".repeat(20)}`, data: "0x" }, "latest"],
      }).method,
    ).toBe("eth_call");
  });

  it.each([
    [[chainIdRequest], /batches/u],
    [{ ...chainIdRequest, method: "eth_sendRawTransaction" }, /not allowed/u],
    [{ ...chainIdRequest, method: "wallet_signTransaction" }, /not allowed/u],
    [{ ...chainIdRequest, method: "debug_traceCall" }, /not allowed/u],
    [{ ...chainIdRequest, id: null }, /version or id/u],
    [{ ...chainIdRequest, params: {} }, /params/u],
  ])("rejects unsafe or malformed request %#", (request, message) => {
    expect(() => parseRpcRequest(request)).toThrow(message as RegExp);
  });

  it("requires bounded log queries", () => {
    expect(() =>
      parseRpcRequest({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{}] }),
    ).toThrow(/bounded block range/u);
    expect(() =>
      parseRpcRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getLogs",
        params: [{ fromBlock: "0x1", toBlock: "0x100000" }],
      }),
    ).toThrow(/must not exceed/u);
    expect(
      parseRpcRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getLogs",
        params: [{ fromBlock: "0x10", toBlock: "0x20" }],
      }).method,
    ).toBe("eth_getLogs");
  });
});

describe("RPC upstream boundary", () => {
  it("fails over without exposing upstream details", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" }));
    const gateway = createRpcGateway(
      parseRpcUpstreams(
        JSON.stringify({ 1: ["https://primary.example/secret", "https://fallback.example/key"] }),
      ),
      fetcher,
    );

    await expect(gateway.request(1, chainIdRequest)).resolves.toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: "0x1",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      redirect: "error",
    });
  });

  it("rejects a mismatched chain, malformed envelope, and oversized response", async () => {
    const cases = [
      Response.json({ jsonrpc: "2.0", id: 1, result: "0xa" }),
      Response.json({ jsonrpc: "2.0", id: 2, result: "0x1" }),
      new Response("{}", { headers: { "content-length": String(6 * 1024 * 1024) } }),
    ];
    for (const response of cases) {
      const gateway = createRpcGateway(
        parseRpcUpstreams('{"1":"https://rpc.example"}'),
        vi.fn<typeof fetch>().mockResolvedValue(response),
      );
      await expect(gateway.request(1, chainIdRequest)).rejects.toBeInstanceOf(RpcUnavailable);
    }
  });

  it("sanitizes upstream errors while preserving bounded hex revert data", async () => {
    const gateway = createRpcGateway(
      parseRpcUpstreams('{"1":"https://rpc.example/credential"}'),
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32000,
            message: "provider credential https://rpc.example/credential failed",
            data: "0x1234",
            upstream: "https://rpc.example/credential",
          },
        }),
      ),
    );

    await expect(gateway.request(1, { ...chainIdRequest, method: "eth_call" })).resolves.toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "RPC request failed", data: "0x1234" },
    });
  });

  it("rejects unsupported chains before fetching", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const gateway = createRpcGateway(new Map(), fetcher);
    await expect(gateway.request(1, chainIdRequest)).rejects.toBeInstanceOf(RpcBadRequest);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
