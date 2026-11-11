import { describe, expect, it, vi } from "vitest";
import {
  createRestRpc,
} from "../src/rest/rpc.js";

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
  it("verifies an endpoint's chain once per window rather than before every read, and again after a failed read", async () => {
    vi.useFakeTimers();
    try {
      let failNext = false, rejectNext = false;
      const { rpc, calls } = fixture((_url, method) => {
        if (method === "eth_chainId") return { result: "0x1" };
        if (failNext) { failNext = false; throw new Error("connection reset"); }
        if (rejectNext) { rejectNext = false; return { error: { code: 3, message: "execution reverted" } }; }
        return { result: "0x7" };
      });
      const probes = () => calls.filter((call) => call.method === "eth_chainId").length;
      await Promise.all([rpc.request(1, "eth_blockNumber", []), rpc.request(1, "eth_blockNumber", [])]);
      await rpc.request(1, "eth_blockNumber", []);
      expect(probes()).toBe(1);
      expect(calls.filter((call) => call.url === "https://second.example")).toHaveLength(0);
      vi.advanceTimersByTime(60_001);
      await rpc.request(1, "eth_blockNumber", []);
      expect(probes()).toBe(2);
      // A read the verified endpoint could not serve: the next attempt checks it again before trusting it.
      failNext = true;
      expect(await rpc.request(1, "eth_blockNumber", [])).toBe("0x7");
      expect(calls.slice(-3).map((call) => `${call.url.replace("https://", "").split(".")[0]} ${call.method}`)).toEqual([
        "first eth_blockNumber",
        "second eth_chainId",
        "second eth_blockNumber",
      ]);
      await rpc.request(1, "eth_blockNumber", []);
      expect(calls.at(-2)).toEqual({ url: "https://first.example", method: "eth_chainId" });
      // A JSON-RPC error is an answer from the verified endpoint; it does not force a new probe.
      rejectNext = true;
      await expect(rpc.request(1, "eth_call", [{}, "latest"])).rejects.toMatchObject({ code: "RPC_REJECTED" });
      const before = probes();
      await rpc.request(1, "eth_blockNumber", []);
      expect(probes()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(["eth_sendRawTransaction", "debug_traceTransaction", "debug_traceBlockByNumber"])("rejects %s before accessing a provider", async method => {
    const { rpc, calls } = fixture(() => { throw new Error("must not access upstream"); });
    await expect(rpc.request(1, method, ["0x01"])).rejects.toMatchObject({ code: "RPC_METHOD_NOT_ALLOWED" });
    expect(calls).toHaveLength(0);
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
  it.each([
    {
      method: "eth_call",
      params: [{ data: "0x1234" }, { blockHash: `0x${"11".repeat(32)}`, requireCanonical: true }],
      mutate: (params: unknown[]) => {
        (params[0] as { data: string }).data = "0xabcd";
        (params[1] as { requireCanonical: boolean }).requireCanonical = false;
      },
    },
  ])("snapshots $method parameters before waiting for quota and chain verification", async ({ method, params, mutate }) => {
    const expected = structuredClone(params);
    const requests: unknown[] = [];
    const rpc = createRestRpc({
      upstreams: new Map([[1, ["https://fixture.example"]]]),
      consume: async () => { mutate(params); },
      fetcher: async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        requests.push(request);
        return Response.json({ jsonrpc: "2.0", id: request.id, result: request.method === "eth_chainId" ? "0x1" : "0x" });
      },
    });
    await rpc.request(1, method, params);
    expect(requests[1]).toMatchObject({ method, params: expected });
  });
});
