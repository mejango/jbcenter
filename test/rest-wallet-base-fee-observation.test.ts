import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toHex, type Hex } from "viem";
import type { RestBlockEvidence, RestRpc } from "../src/rest/core.js";
import { observeBaseReceiptFees } from "../src/rest/wallet/baseFeeObservation.js";
import { operationRpc } from "../src/rest/wallet/operationRpc.js";

const vectors = JSON.parse(readFileSync(new URL("./fixtures/base-fee-receipts.json", import.meta.url), "utf8")) as {
  transactions: { hash: Hex; raw: Hex; block: { hash: Hex; number: Hex; timestamp: Hex; transactions: Hex[] };
    receipt: Record<string, unknown>; attributes: Record<string, unknown>; expected: { totalWei: string } }[];
};
const limits = { rpcCalls: 7, rpcTimeoutMs: 100, totalTimeoutMs: 1000, responseBytes: 100_000 };
const vector = vectors.transactions[0]!;
const inclusion: RestBlockEvidence = { chainId: 8453, blockHash: vector.block.hash, blockNumber: String(BigInt(vector.block.number)),
  timestamp: String(BigInt(vector.block.timestamp)), source: "onchain" };

function fixture(change?: (method: string, occurrence: number, original: unknown) => unknown) {
  const calls: { chain: number; method: string; params: readonly unknown[] }[] = [];
  const occurrences = new Map<string, number>();
  const transport = { request: async (chain: number, method: string, params: readonly unknown[]) => {
    calls.push({ chain, method, params });
    const occurrence = (occurrences.get(method) ?? 0) + 1; occurrences.set(method, occurrence);
    let original: unknown;
    if (chain !== 8453) throw new Error("Wrong chain requested");
    if (method === "eth_chainId") { expect(params).toEqual([]); original = "0x2105"; }
    else if (method === "eth_getTransactionReceipt") { expect(params).toEqual([vector.hash]); original = vector.receipt; }
    else if (method === "eth_getBlockByNumber") { expect(params).toEqual([vector.block.number, false]); original = vector.block; }
    else if (method === "eth_getTransactionByHash") { expect(params).toEqual([vector.attributes.hash]); original = vector.attributes; }
    else throw new Error("Unexpected method");
    return change ? change(method, occurrence, structuredClone(original)) : structuredClone(original);
  } } as unknown as RestRpc;
  return { calls, transport };
}
async function run(change?: Parameters<typeof fixture>[0], override = {}, signal?: AbortSignal) {
  const { calls, transport } = fixture(change), rpc = operationRpc(transport, { ...limits, ...override }, signal, true);
  try { return { result: await observeBaseReceiptFees(rpc, vector.raw, inclusion), calls }; }
  finally { rpc.close(); }
}

describe("bounded Base fee observation at the retained canonical inclusion", () => {
  it("rechecks chain, inclusion and receipt before returning exact fees from a real Base vector", async () => {
    const { result, calls } = await run();
    expect(result).toMatchObject({ transactionHash: vector.hash, blockHash: vector.block.hash,
      totalWei: BigInt(vector.expected.totalWei), futureFeeCeiling: null });
    expect(calls).toHaveLength(7);
    expect(calls.every(call => call.method.startsWith("eth_get") || call.method === "eth_chainId")).toBe(true);
  });
  it.each([1, 2])("refuses wrong chain identity on observation %s", async occurrence => {
    await expect(run((method, n, value) => method === "eth_chainId" && n === occurrence ? "0xa" : value)).rejects.toMatchObject({ status: 502 });
  });
  it.each([1, 2])("never promotes an absent receipt on observation %s", async occurrence => {
    await expect(run((method, n, value) => method === "eth_getTransactionReceipt" && n === occurrence ? null : value)).rejects.toMatchObject({ status: 502 });
  });
  it.each(["block", "receipt", "attributes"])("rejects replaced %s evidence", async target => {
    await expect(run((method, n, value) => {
      if (target === "block" && method === "eth_getBlockByNumber" && n === 2)
        return { ...value as object, hash: `0x${"ab".repeat(32)}` };
      if (target === "receipt" && method === "eth_getTransactionReceipt" && n === 2)
        return { ...value as object, blockHash: `0x${"ab".repeat(32)}` };
      if (target === "attributes" && method === "eth_getTransactionByHash")
        return { ...value as object, blockNumber: toHex(BigInt(vector.block.number) + 1n) };
      return value;
    })).rejects.toMatchObject({ status: 502 });
  });
  it("rejects a changed receipt even if its new fee arithmetic is internally valid", async () => {
    await expect(run((method, n, value) => method === "eth_getTransactionReceipt" && n === 2
      ? { ...value as object, gasUsed: toHex(BigInt(vector.receipt.gasUsed as string) - 1n) } : value)).rejects.toMatchObject({ status: 502 });
  });
  it("binds the caller's retained height, timestamp and Base chain before returning fees", async () => {
    for (const changed of [{ ...inclusion, timestamp: String(BigInt(inclusion.timestamp) + 1n) },
      { ...inclusion, blockHash: `0x${"ab".repeat(32)}` }, { ...inclusion, chainId: 10 },
      { ...inclusion, blockNumber: "00" }, { ...inclusion, blockNumber: Number(inclusion.blockNumber) },
      { ...inclusion, timestamp: Number(inclusion.timestamp) }]) {
      const { transport } = fixture(), rpc = operationRpc(transport, limits, undefined, true);
      try { await expect(observeBaseReceiptFees(rpc, vector.raw, changed as RestBlockEvidence)).rejects.toMatchObject({ status: 502 }); }
      finally { rpc.close(); }
    }
  });
  it("preserves the caller's RPC limits and cancellation instead of falling back or returning partial fees", async () => {
    await expect(run(undefined, { rpcCalls: 6 })).rejects.toMatchObject({ code: "WALLET_DEPLOYMENT_RPC_BUDGET" });
    await expect(run(undefined, { responseBytes: 500 })).rejects.toMatchObject({ code: "WALLET_DEPLOYMENT_RPC_BYTES" });
    const controller = new AbortController(); controller.abort();
    await expect(run(undefined, {}, controller.signal)).rejects.toMatchObject({ code: "WALLET_DEPLOYMENT_CANCELLED" });
  });
  it("propagates a failed final canonical read without returning cached fee evidence", async () => {
    await expect(run((method, n, value) => {
      if (method === "eth_getBlockByNumber" && n === 2) throw new Error("Provider unavailable");
      return value;
    })).rejects.toThrow();
  });
});
