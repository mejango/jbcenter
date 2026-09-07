import { describe, expect, it, vi } from "vitest";
import {
  createRestRpc,
  PRIVATE_TRACE_RESPONSE_LIMIT,
  PRIVATE_TRACE_TIMEOUT_MS,
} from "../src/rest/rpc.js";
import { parseRpcRequest, RPC_RESPONSE_LIMIT, RPC_TIMEOUT_MS } from "../src/rpc.js";
import { RestError } from "../src/rest/core.js";

function fixture(handler: (url: string, method: string) => unknown) {
  const calls: Array<{ url: string; method: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
    };
    calls.push({ url, method: body.method });
    const value = handler(url, body.method);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...(value as object) }));
  };
  return {
    calls,
    rpc: createRestRpc({
      upstreams: new Map([[1, ["https://first.example", "https://second.example"]]]),
      fetcher,
    }),
  };
}

describe("private REST RPC", () => {
  it("never reads or broadcasts through an endpoint reporting a different chain", async () => {
    const { rpc, calls } = fixture((url, method) => ({
      result: method === "eth_chainId" ? (url.includes("first") ? "0xa" : "0x1") : "0x7",
    }));
    expect(await rpc.request(1, "eth_blockNumber", [])).toBe("0x7");
    expect(calls).toEqual([
      { url: "https://first.example", method: "eth_chainId" },
      { url: "https://second.example", method: "eth_chainId" },
      { url: "https://second.example", method: "eth_blockNumber" },
    ]);
  });
  it("does not automatically broadcast through another provider after an ambiguous response", async () => {
    const { rpc, calls } = fixture((_url, method) => {
      if (method === "eth_chainId") return { result: "0x1" };
      throw new Error("network failed after accepting bytes with secret upstream URL");
    });
    await expect(rpc.request(1, "eth_sendRawTransaction", ["0x01"])).rejects.toMatchObject({
      code: "BROADCAST_UNKNOWN",
    });
    expect(calls.filter((call) => call.method === "eth_sendRawTransaction")).toHaveLength(1);
  });
  it("retains bounded revert bytes, sanitizes provider errors and avoids fallback on a revert", async () => {
    const { rpc, calls } = fixture((_url, method) =>
      method === "eth_chainId"
        ? { result: "0x1" }
        : {
            error: {
              code: 3,
              message: "private provider details",
              data: "0xdeadbeef",
            },
          },
    );
    await expect(rpc.request(1, "eth_call", [{}, "latest"])).rejects.toMatchObject({
      code: "RPC_REJECTED",
      rpcCode: 3,
      data: "0xdeadbeef",
      message: "The configured RPC rejected the request",
    });
    expect(calls).toHaveLength(2);
  });
  it("rejects remote signing and unsupported chains before accessing an upstream", async () => {
    const { rpc, calls } = fixture(() => ({ result: "0x1" }));
    await expect(rpc.request(1, "eth_sendTransaction", [{}])).rejects.toMatchObject({
      code: "RPC_METHOD_NOT_ALLOWED",
    });
    await expect(rpc.request(137, "eth_chainId", [])).rejects.toMatchObject({
      code: "UNSUPPORTED_CHAIN",
    });
    expect(calls).toHaveLength(0);
  });
});

const trace = () => [
  "0x123",
  {
    tracer: "callTracer",
    timeout: "10s",
    tracerConfig: { onlyTopCall: false },
  },
];
describe("private bounded archive traces", () => {
  it("admits only an exact transaction hash and preserves the complete call tree", async () => {
    const consume = vi.fn(async () => {});
    const frame = {
      type: "CALL",
      from: `0x${"11".repeat(20)}`,
      to: `0x${"22".repeat(20)}`,
      calls: [{ type: "DELEGATECALL", input: "0x1234", output: "0x" }],
    };
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: request.method === "eth_chainId" ? "0x1" : frame,
      });
    });
    const rpc = createRestRpc({
      upstreams: new Map([[1, ["https://archive.example"]]]),
      fetcher,
      consume,
    });
    const params = [`0x${"AB".repeat(32)}`, trace()[1]];
    expect(await rpc.request(1, "debug_traceTransaction", params)).toEqual(frame);
    expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).method)).toEqual([
      "eth_chainId",
      "debug_traceTransaction",
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body)).params).toEqual([
      `0x${"ab".repeat(32)}`,
      trace()[1],
    ]);
    expect(consume).toHaveBeenCalledTimes(2);
    expect(() =>
      parseRpcRequest({ jsonrpc: "2.0", id: 1, method: "debug_traceTransaction", params }),
    ).toThrow("not allowed");
  });
  it.each(["latest", "0x123", `0x${"1".repeat(63)}`, `0x${"1".repeat(65)}`, `0x${"g".repeat(64)}`])(
    "rejects invalid transaction trace identity %s without upstream access",
    async (identity) => {
      const fetcher = vi.fn<typeof fetch>();
      const rpc = createRestRpc({
        upstreams: new Map([[1, ["https://archive.example"]]]),
        fetcher,
      });
      await expect(
        rpc.request(1, "debug_traceTransaction", [identity, trace()[1]]),
      ).rejects.toMatchObject({ code: "RPC_METHOD_NOT_ALLOWED" });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("rejects transaction traces with custom tracers or incomplete call trees", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const rpc = createRestRpc({ upstreams: new Map([[1, ["https://archive.example"]]]), fetcher });
    for (const config of [
      { tracer: "customJavascriptTracer", timeout: "10s", tracerConfig: { onlyTopCall: false } },
      { tracer: "callTracer", timeout: "10s", tracerConfig: { onlyTopCall: true } },
    ])
      await expect(
        rpc.request(1, "debug_traceTransaction", [`0x${"12".repeat(32)}`, config]),
      ).rejects.toMatchObject({ code: "RPC_METHOD_NOT_ALLOWED" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("verifies and charges the same endpoint for complete traces without exposing a public trace method", async () => {
    const consume = vi.fn(async () => {});
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const request = JSON.parse(String(init?.body));
      const chain = String(url).includes("wrong") ? "0xa" : "0x1";
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result:
          request.method === "eth_chainId"
            ? chain
            : [
                {
                  txHash: `0x${"12".repeat(32)}`,
                  result: { type: "CALL", calls: [] },
                },
              ],
      });
    });
    const rpc = createRestRpc({
      upstreams: new Map([[1, ["https://wrong.example", "https://archive.example"]]]),
      fetcher,
      consume,
    });
    const result = await rpc.request(1, "debug_traceBlockByNumber", trace());
    expect(result).toEqual([
      { txHash: `0x${"12".repeat(32)}`, result: { type: "CALL", calls: [] } },
    ]);
    expect(
      fetcher.mock.calls.map(([url, init]) => [String(url), JSON.parse(String(init?.body)).method]),
    ).toEqual([
      ["https://wrong.example", "eth_chainId"],
      ["https://archive.example", "eth_chainId"],
      ["https://archive.example", "debug_traceBlockByNumber"],
    ]);
    expect(JSON.parse(String(fetcher.mock.calls.at(-1)![1]!.body)).params).toEqual(trace());
    expect(consume).toHaveBeenCalledTimes(3);
    expect(() =>
      parseRpcRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "debug_traceBlockByNumber",
        params: trace(),
      }),
    ).toThrow("not allowed");
  });
  it.each([
    ["latest", trace()[1]],
    ["pending", trace()[1]],
    ["0x00", trace()[1]],
    ["0xABC", trace()[1]],
    [`0x${"1".repeat(17)}`, trace()[1]],
    ["0x1", {}],
    ["0x1", null],
    [
      "0x1",
      {
        tracer: "return function() {}",
        timeout: "10s",
        tracerConfig: { onlyTopCall: false },
      },
    ],
    [
      "0x1",
      {
        tracer: "callTracer",
        timeout: "100s",
        tracerConfig: { onlyTopCall: false },
      },
    ],
    [
      "0x1",
      {
        tracer: "callTracer",
        timeout: "10s",
        tracerConfig: { onlyTopCall: true },
      },
    ],
    [
      "0x1",
      {
        tracer: "callTracer",
        timeout: "10s",
        tracerConfig: { onlyTopCall: false, withLog: true },
      },
    ],
    [
      "0x1",
      {
        tracer: "callTracer",
        timeout: "10s",
        tracerConfig: { onlyTopCall: false },
        reexec: 1000000,
      },
    ],
    [...trace(), {}],
    [],
  ])(
    "rejects arbitrary or incomplete trace configuration %# before any upstream or quota work",
    async (...params) => {
      const fetcher = vi.fn<typeof fetch>();
      const consume = vi.fn(async () => {});
      const rpc = createRestRpc({
        upstreams: new Map([[1, ["https://archive.example"]]]),
        fetcher,
        consume,
      });
      await expect(rpc.request(1, "debug_traceBlockByNumber", params)).rejects.toMatchObject({
        code: "RPC_METHOD_NOT_ALLOWED",
      });
      expect(fetcher).not.toHaveBeenCalled();
      expect(consume).not.toHaveBeenCalled();
    },
  );
  it("copies the fixed trace configuration before waiting for quota admission", async () => {
    const params = trace();
    const requests: unknown[] = [];
    const rpc = createRestRpc({
      upstreams: new Map([[1, ["https://archive.example"]]]),
      consume: async () => {
        (params[1] as { tracer: string }).tracer = "arbitrary javascript";
      },
      fetcher: async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        requests.push(request);
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: request.method === "eth_chainId" ? "0x1" : [],
        });
      },
    });
    await rpc.request(1, "debug_traceBlockByNumber", params);
    expect(requests[1]).toMatchObject({ params: trace() });
  });
  it("permits a bounded trace larger than public read responses and rejects oversized declared responses", async () => {
    const payload = [{ result: { input: "x".repeat(RPC_RESPONSE_LIMIT + 128) } }];
    let oversized = false;
    let cancelled = false;
    const rpc = createRestRpc({
      upstreams: new Map([[1, ["https://archive.example"]]]),
      fetcher: async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        if (request.method === "eth_chainId")
          return Response.json({
            jsonrpc: "2.0",
            id: request.id,
            result: "0x1",
          });
        if (oversized)
          return new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            {
              headers: {
                "content-length": String(PRIVATE_TRACE_RESPONSE_LIMIT + 1),
              },
            },
          );
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: payload,
        });
      },
    });
    expect(await rpc.request(1, "debug_traceBlockByNumber", trace())).toEqual(payload);
    await expect(rpc.request(1, "eth_getBlockReceipts", ["0x123"])).rejects.toMatchObject({
      code: "RPC_UNAVAILABLE",
    });
    oversized = true;
    await expect(rpc.request(1, "debug_traceBlockByNumber", trace())).rejects.toMatchObject({
      code: "RPC_UNAVAILABLE",
    });
    expect(cancelled).toBe(true);
  });
  it("reverifies and charges a fallback endpoint when the first archive lacks the trace method", async () => {
    const methods: [string, string][] = [];
    const consume = vi.fn(async () => {});
    const rpc = createRestRpc({
      upstreams: new Map([[1, ["https://first.example", "https://archive.example"]]]),
      consume,
      fetcher: async (url, init) => {
        const request = JSON.parse(String(init?.body));
        methods.push([String(url), request.method]);
        if (request.method === "eth_chainId")
          return Response.json({
            jsonrpc: "2.0",
            id: request.id,
            result: "0x1",
          });
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          ...(String(url).includes("first")
            ? { error: { code: -32601, message: "not implemented" } }
            : { result: [] }),
        });
      },
    });
    expect(await rpc.request(1, "debug_traceBlockByNumber", trace())).toEqual([]);
    expect(methods).toEqual([
      ["https://first.example", "eth_chainId"],
      ["https://first.example", "debug_traceBlockByNumber"],
      ["https://archive.example", "eth_chainId"],
      ["https://archive.example", "debug_traceBlockByNumber"],
    ]);
    expect(consume).toHaveBeenCalledTimes(4);
  });
  it("does not trace or fail over when the shared site quota rejects the trace charge", async () => {
    const consume = vi.fn(async () => {
      if (consume.mock.calls.length === 2)
        throw new RestError(429, "QUOTA_EXCEEDED", "Fixture quota exhausted");
    });
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return Response.json({ jsonrpc: "2.0", id: request.id, result: "0x1" });
    });
    const rpc = createRestRpc({
      upstreams: new Map([[1, ["https://first.example", "https://second.example"]]]),
      consume,
      fetcher,
    });
    await expect(rpc.request(1, "debug_traceBlockByNumber", trace())).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledTimes(2);
  });
  it.each(["debug_traceBlockByNumber", "debug_traceTransaction"])(
    "leaves enough time for %s while enforcing its private deadline",
    async (method) => {
      vi.useFakeTimers();
      try {
        const pendingSignals: AbortSignal[] = [];
        const rpc = createRestRpc({
          upstreams: new Map([[1, ["https://archive.example"]]]),
          fetcher: async (_url, init) => {
            const request = JSON.parse(String(init?.body));
            if (request.method === "eth_chainId")
              return Response.json({
                jsonrpc: "2.0",
                id: request.id,
                result: "0x1",
              });
            return new Promise<Response>((_resolve, reject) => {
              pendingSignals.push(init!.signal!);
              init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), {
                once: true,
              });
            });
          },
        });
        const pending = rpc.request(
          1,
          method,
          method === "debug_traceTransaction" ? [`0x${"12".repeat(32)}`, trace()[1]] : trace(),
        );
        const rejected = expect(pending).rejects.toMatchObject({
          code: "RPC_UNAVAILABLE",
        });
        await vi.advanceTimersByTimeAsync(RPC_TIMEOUT_MS + 1);
        expect(pendingSignals).toHaveLength(1);
        expect(pendingSignals[0]!.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(PRIVATE_TRACE_TIMEOUT_MS - RPC_TIMEOUT_MS);
        await rejected;
        expect(pendingSignals[0]!.aborted).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it("propagates caller cancellation during tracing without failover or a second trace charge", async () => {
    const controller = new AbortController();
    const consume = vi.fn(async () => {});
    const methods: string[] = [];
    const rpc = createRestRpc({
      upstreams: new Map([[1, ["https://archive.example", "https://fallback.example"]]]),
      consume,
      fetcher: async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        methods.push(request.method);
        if (request.method === "eth_chainId")
          return Response.json({
            jsonrpc: "2.0",
            id: request.id,
            result: "0x1",
          });
        controller.abort(new Error("caller stopped"));
        init!.signal!.throwIfAborted();
        throw new Error("unreachable");
      },
    });
    await expect(
      rpc.request(1, "debug_traceBlockByNumber", trace(), controller.signal),
    ).rejects.toThrow("caller stopped");
    expect(methods).toEqual(["eth_chainId", "debug_traceBlockByNumber"]);
    expect(consume).toHaveBeenCalledTimes(2);
  });
});
