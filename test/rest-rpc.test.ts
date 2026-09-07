import { describe, expect, it } from "vitest";
import { createRestRpc } from "../src/rest/rpc.js";

function fixture(handler: (url: string, method: string) => unknown) {
  const calls: Array<{url: string; method: string}> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as { id: number; method: string };
    calls.push({ url, method: body.method });
    const value = handler(url, body.method);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...value as object }));
  };
  return { calls, rpc: createRestRpc({ upstreams: new Map([[1, ["https://first.example", "https://second.example"]]]), fetcher }) };
}

describe("private REST RPC", () => {
  it("never reads or broadcasts through an endpoint reporting a different chain", async () => {
    const { rpc, calls } = fixture((url, method) => ({ result: method === "eth_chainId" ? (url.includes("first") ? "0xa" : "0x1") : "0x7" }));
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
    await expect(rpc.request(1, "eth_sendRawTransaction", ["0x01"])).rejects.toMatchObject({ code: "BROADCAST_UNKNOWN" });
    expect(calls.filter((call) => call.method === "eth_sendRawTransaction")).toHaveLength(1);
  });
  it("retains bounded revert bytes, sanitizes provider errors and avoids fallback on a revert", async () => {
    const { rpc, calls } = fixture((_url, method) => method === "eth_chainId" ? { result: "0x1" } : { error: { code: 3, message: "private provider details", data: "0xdeadbeef" } });
    await expect(rpc.request(1, "eth_call", [{}, "latest"])).rejects.toMatchObject({ code: "RPC_REJECTED", rpcCode: 3, data: "0xdeadbeef", message: "The configured RPC rejected the request" });
    expect(calls).toHaveLength(2);
  });
  it("rejects remote signing and unsupported chains before accessing an upstream", async () => {
    const { rpc, calls } = fixture(() => ({ result: "0x1" }));
    await expect(rpc.request(1, "eth_sendTransaction", [{}])).rejects.toMatchObject({ code: "RPC_METHOD_NOT_ALLOWED" });
    await expect(rpc.request(137, "eth_chainId", [])).rejects.toMatchObject({ code: "UNSUPPORTED_CHAIN" });
    expect(calls).toHaveLength(0);
  });
});
