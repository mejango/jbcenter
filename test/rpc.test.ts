import { describe, expect, it, vi } from "vitest";
import {
  createRpcGateway,
  dwellirRpcUpstreams,
  parseRpcRequest,
  RPC_TIMEOUT_MS,
  RpcBadRequest,
  RpcUnavailable,
} from "../src/rpc.js";

const chainIdRequest = { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] } as const;

describe("RPC configuration", () => {
  it("builds every reviewed Dwellir URL from one key", () => {
    const config = dwellirRpcUpstreams("test-key-1234567890");
    expect(config.size).toBe(8);
    expect(config.get(1)).toEqual([
      "https://api-ethereum-mainnet.n.dwellir.com/test-key-1234567890",
      "https://ethereum-rpc.publicnode.com",
    ]);
    expect(config.get(421614)).toEqual([
      "https://api-arbitrum-sepolia.n.dwellir.com/test-key-1234567890",
      "https://arbitrum-sepolia-rpc.publicnode.com",
    ]);
  });

  it.each([undefined, "short", "unsafe/key/with/slashes"])("rejects unsafe RPC key %s", (key) => {
    expect(() => dwellirRpcUpstreams(key)).toThrow(/DWELLIR_API_KEY/u);
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
      new Map([[1, ["https://primary.example/secret", "https://fallback.example/key"]]]),
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

  it("fails over before a stalled primary consumes the client request budget", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementationOnce((_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
        )
        .mockResolvedValueOnce(Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" }));
      const gateway = createRpcGateway(
        new Map([[1, ["https://slow.example", "https://fallback.example"]]]),
        fetcher,
      );

      const request = gateway.request(1, chainIdRequest);
      await vi.advanceTimersByTimeAsync(RPC_TIMEOUT_MS);
      await expect(request).resolves.toEqual({ jsonrpc: "2.0", id: 1, result: "0x1" });
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a mismatched chain, malformed envelope, and oversized response", async () => {
    const cases = [
      Response.json({ jsonrpc: "2.0", id: 1, result: "0xa" }),
      Response.json({ jsonrpc: "2.0", id: 2, result: "0x1" }),
      new Response("{}", { headers: { "content-length": String(6 * 1024 * 1024) } }),
    ];
    for (const response of cases) {
      const gateway = createRpcGateway(
        new Map([[1, ["https://rpc.example"]]]),
        vi.fn<typeof fetch>().mockResolvedValue(response),
      );
      await expect(gateway.request(1, chainIdRequest)).rejects.toBeInstanceOf(RpcUnavailable);
    }
  });

  it("sanitizes upstream errors while preserving bounded hex revert data", async () => {
    const gateway = createRpcGateway(
      new Map([[1, ["https://rpc.example/credential"]]]),
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
