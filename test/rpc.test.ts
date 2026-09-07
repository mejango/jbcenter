import { describe, expect, it, vi } from "vitest";
import {
  createRpcGateway,
  dwellirRpcUpstreams,
  parseRpcRequest,
  RPC_RESPONSE_LIMIT,
  RPC_TIMEOUT_MS,
  RpcBadRequest,
  RpcUnavailable,
} from "../src/rpc.js";

const chainIdRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "eth_chainId",
  params: [],
} as const;

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
    [{ ...chainIdRequest, method: "debug_traceBlockByNumber" }, /not allowed/u],
    [{ ...chainIdRequest, method: "debug_traceTransaction" }, /not allowed/u],
    [{ ...chainIdRequest, id: null }, /version or id/u],
    [{ ...chainIdRequest, params: {} }, /params/u],
  ])("rejects unsafe or malformed request %#", (request, message) => {
    expect(() => parseRpcRequest(request)).toThrow(message as RegExp);
  });

  it("bounds simulations to one block of a few calls", () => {
    const call = { to: `0x${"12".repeat(20)}`, data: "0x" };
    const simulate = (blockStateCalls: unknown) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_simulateV1",
      params: [{ blockStateCalls }, "latest"],
    });
    expect(parseRpcRequest(simulate([{ calls: [call, call] }])).method).toBe("eth_simulateV1");
    expect(() => parseRpcRequest(simulate([]))).toThrow(/exactly one block/u);
    expect(() => parseRpcRequest(simulate([{ calls: [call] }, { calls: [call] }]))).toThrow(
      /exactly one block/u,
    );
    expect(() => parseRpcRequest(simulate([{ calls: [] }]))).toThrow(/calls array/u);
    expect(() => parseRpcRequest(simulate([{ calls: Array(17).fill(call) }]))).toThrow(
      /must not exceed/u,
    );
    expect(() =>
      parseRpcRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_simulateV1",
        params: [],
      }),
    ).toThrow(/blockStateCalls/u);
  });

  it("requires bounded log queries", () => {
    expect(() =>
      parseRpcRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getLogs",
        params: [{}],
      }),
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
  it.each([
    { timeoutMs: 0 },
    { timeoutMs: 30_001 },
    { timeoutMs: NaN },
    { timeoutMs: 1.5 },
    { responseLimitBytes: 0 },
    { responseLimitBytes: 20 * 1024 * 1024 + 1 },
    { responseLimitBytes: Infinity },
    { responseLimitBytes: 1.5 },
  ])("rejects invalid trusted gateway limits %#", (limits) => {
    expect(() => createRpcGateway(new Map(), fetch, limits)).toThrow("bounded");
  });
  it("applies custom byte bounds to chunked responses and cancels a body that exceeds them", async () => {
    let cancelled = false;
    const fetcher: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(65));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    const gateway = createRpcGateway(new Map([[1, ["https://archive.example"]]]), fetcher, {
      timeoutMs: 15_000,
      responseLimitBytes: 64,
    });
    await expect(gateway.request(1, chainIdRequest)).rejects.toBeInstanceOf(RpcUnavailable);
    expect(cancelled).toBe(true);
  });
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

  it("fails over when the primary does not implement the method, and returns any other error", async () => {
    const simulate = {
      jsonrpc: "2.0",
      id: 7,
      method: "eth_simulateV1",
      params: [],
    } as const;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          jsonrpc: "2.0",
          id: 7,
          error: {
            code: -32601,
            message: "the method eth_simulateV1 does not exist",
          },
        }),
      )
      .mockResolvedValueOnce(Response.json({ jsonrpc: "2.0", id: 7, result: [] }))
      .mockResolvedValueOnce(
        Response.json({
          jsonrpc: "2.0",
          id: 7,
          error: { code: 3, message: "execution reverted" },
        }),
      );
    const gateway = createRpcGateway(
      new Map([[1, ["https://primary.example/secret", "https://fallback.example/key"]]]),
      fetcher,
    );

    await expect(gateway.request(1, simulate)).resolves.toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: [],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(gateway.request(1, simulate)).resolves.toMatchObject({
      error: { code: 3 },
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("fails over before a stalled primary consumes the client request budget", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(
          (_url, init) =>
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
      await expect(request).resolves.toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: "0x1",
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an already aborted caller without contacting an upstream", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Caller disconnected", "AbortError");
    controller.abort(reason);
    const fetcher = vi.fn<typeof fetch>();
    const gateway = createRpcGateway(
      new Map([[1, ["https://primary.example", "https://fallback.example"]]]),
      fetcher,
    );

    await expect(gateway.request(1, chainIdRequest, controller.signal)).rejects.toBe(reason);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("aborts the active provider without falling back when the caller disconnects", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Caller disconnected", "AbortError");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      )
      .mockResolvedValueOnce(Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" }));
    const gateway = createRpcGateway(
      new Map([[1, ["https://primary.example", "https://fallback.example"]]]),
      fetcher,
    );

    const request = gateway.request(1, chainIdRequest, controller.signal);
    const rejection = expect(request).rejects.toBe(reason);
    controller.abort(reason);
    await rejection;
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(fetcher.mock.calls[0]?.[1]?.signal?.reason).toBe(reason);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("cancels a stalled response reader on caller abort without waiting or falling back", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Caller disconnected", "AbortError");
    let reading!: () => void;
    const startedReading = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const stream = new ReadableStream<Uint8Array>(
      {
        pull: () => {
          reading();
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(stream))
      .mockResolvedValueOnce(Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" }));
    const gateway = createRpcGateway(
      new Map([[1, ["https://primary.example", "https://fallback.example"]]]),
      fetcher,
    );

    const request = gateway.request(1, chainIdRequest, controller.signal);
    const rejection = expect(request).rejects.toBe(reason);
    await startedReading;
    controller.abort(reason);
    await rejection;
    expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
    expect(stream.locked).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("cancels a stalled response reader and fails over when the provider times out", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(stream))
        .mockResolvedValueOnce(Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" }));
      const gateway = createRpcGateway(
        new Map([[1, ["https://primary.example", "https://fallback.example"]]]),
        fetcher,
      );

      const request = gateway.request(1, chainIdRequest);
      await vi.advanceTimersByTimeAsync(RPC_TIMEOUT_MS);
      await expect(request).resolves.toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: "0x1",
      });
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(stream.locked).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops reading chunked oversized responses as soon as the byte limit is exceeded", async () => {
    const chunkSize = 1024 * 1024;
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(new Uint8Array(chunkSize));
    });
    // An upstream cancellation hook may stall; it cannot prevent bounded failure.
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const gateway = createRpcGateway(
      new Map([[1, ["https://rpc.example"]]]),
      vi.fn<typeof fetch>().mockResolvedValue(new Response(stream)),
    );

    await expect(gateway.request(1, chainIdRequest)).rejects.toBeInstanceOf(RpcUnavailable);
    expect(pull).toHaveBeenCalledTimes(Math.floor(RPC_RESPONSE_LIMIT / chunkSize) + 1);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(expect.any(RpcUnavailable));
    expect(stream.locked).toBe(false);
  });

  it("accepts a chunked JSON response exactly at the response byte limit", async () => {
    const prefix = '{"jsonrpc":"2.0","id":1,"result":"';
    const suffix = '"}';
    const payloadSize = RPC_RESPONSE_LIMIT - prefix.length - suffix.length;
    const chunks = [prefix, "a".repeat(payloadSize), suffix];
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const chunk = chunks.shift();
          if (chunk === undefined) controller.close();
          else controller.enqueue(encoder.encode(chunk));
        },
      },
      { highWaterMark: 0 },
    );
    const gateway = createRpcGateway(
      new Map([[1, ["https://rpc.example"]]]),
      vi.fn<typeof fetch>().mockResolvedValue(new Response(stream)),
    );

    const result = await gateway.request(1, {
      ...chainIdRequest,
      method: "eth_call",
    });
    expect(result).toMatchObject({ jsonrpc: "2.0", id: 1 });
    expect((result as { result: string }).result).toHaveLength(payloadSize);
    expect(stream.locked).toBe(false);
  });

  it("rejects a mismatched chain, malformed envelope, and oversized response", async () => {
    const cases = [
      Response.json({ jsonrpc: "2.0", id: 1, result: "0xa" }),
      Response.json({ jsonrpc: "2.0", id: 2, result: "0x1" }),
      new Response("{}", {
        headers: { "content-length": String(6 * 1024 * 1024) },
      }),
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
