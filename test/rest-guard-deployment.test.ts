import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

const { GUARD_FACTORY, GUARD_FACTORY_CODE, GUARD_RUNTIME_HASH, guardDeploymentTransaction, inspectGuardChain, loadGuardArtifact, verifyGuardReceipt } =
  await import(new URL("../scripts/rest/prepare-session-guard.mjs", import.meta.url).href);
const { artifact } = await loadGuardArtifact();
const sponsor = JSON.parse(await readFile(new URL("../src/rest/smartAccounts/stack/current-pimlico/artifacts/PimlicoSingletonPaymasterV7.json", import.meta.url), "utf8"));
const blockHash = `0x${"12".repeat(32)}`;
const deployment = guardDeploymentTransaction(artifact);

function rpcFixture(options: { chain?: number; factory?: string; guard?: string; sponsor?: string; simulatedAddress?: string; reorg?: boolean } = {}) {
  let blockReads = 0;
  return vi.fn(async (chainId: number, method: string, params: unknown[]) => {
    switch (method) {
      case "eth_chainId": return `0x${(options.chain ?? chainId).toString(16)}`;
      case "eth_getBlockByNumber": return { number: "0x100", hash: options.reorg && blockReads++ ? `0x${"34".repeat(32)}` : blockHash };
      case "eth_getCode": {
        expect(params[1]).toEqual({ blockHash, requireCanonical: true });
        if (params[0] === GUARD_FACTORY) return options.factory ?? GUARD_FACTORY_CODE;
        if (params[0] === deployment.address) return options.guard ?? "0x";
        if (params[0] === artifact.paymasterBinding.address) return options.sponsor ?? sponsor.deployedRuntimeBytecode;
        throw new Error("Unexpected code target");
      }
      case "eth_call": return options.simulatedAddress ?? deployment.address;
      case "eth_estimateGas": return "0xf4240";
      case "eth_gasPrice": return "0x3b9aca00";
      default: throw new Error(`Unexpected RPC method: ${method}`);
    }
  });
}

describe("unsigned guard deployment readiness", () => {
  it("pins identical zero-value deployments on each mainnet with canonical evidence and bounded fee estimates", async () => {
    for (const chainId of [1, 10, 8453, 42161]) {
      const rpc = rpcFixture();
      const result = await inspectGuardChain(chainId, artifact, rpc);
      expect(result.guardAddress).toBe("0x19Ba04Efc7284Af9248f52B453df9994579e20e1");
      expect(result.transaction).toEqual({ chainId, to: GUARD_FACTORY, data: deployment.data, value: "0x0" });
      expect(result.estimate).toMatchObject({ gas: "1000000", gasLimitWith25PercentMargin: "1250000", estimatedExecutionFeeWei: "1000000000000000", senderVerified: false });
      expect(result.evidence).toEqual({ blockNumber: "256", blockHash, canonical: true });
      expect(rpc.mock.calls.every(([, method]) => ["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call", "eth_estimateGas", "eth_gasPrice"].includes(method))).toBe(true);
    }
  });

  it("rejects changed creation bytes, wrong chains, runtimes, simulation results and reorganized evidence", async () => {
    expect(() => guardDeploymentTransaction({ ...artifact, bytecode: "0x6000" })).toThrow("creation bytecode mismatch");
    for (const options of [
      { chain: 137 }, { factory: "0x6000" }, { guard: "0x6000" }, { sponsor: "0x6000" },
      { simulatedAddress: `0x${"11".repeat(20)}` }, { reorg: true },
    ]) await expect(inspectGuardChain(1, artifact, rpcFixture(options))).rejects.toThrow();
  });

  it("recognizes an already deployed exact guard without proposing another transaction", async () => {
    const rpc = rpcFixture({ guard: artifact.deployedBytecode });
    const result = await inspectGuardChain(8453, artifact, rpc);
    expect(result).toMatchObject({ status: "already-deployed", runtimeCodeHash: GUARD_RUNTIME_HASH });
    expect(result).not.toHaveProperty("transaction");
    expect(result).not.toHaveProperty("estimate");
    expect(rpc.mock.calls.some(([, method]) => method === "eth_call" || method === "eth_estimateGas")).toBe(false);
  });

  it("accepts only a confirmed exact factory transaction and verifies runtime at its canonical receipt block", async () => {
    const transactionHash = `0x${"ab".repeat(32)}`;
    const receiptHash = `0x${"56".repeat(32)}`;
    const receipt = { transactionHash, status: "0x1", contractAddress: null, blockNumber: "0xff", blockHash: receiptHash };
    const tx = { hash: transactionHash, from: `0x${"cd".repeat(20)}`, to: GUARD_FACTORY, input: deployment.data, value: "0x0", blockNumber: receipt.blockNumber, blockHash: receiptHash };
    const fixture = (overrides: { tx?: Record<string, unknown>; receipt?: Record<string, unknown>; runtime?: string } = {}) => {
      const base = rpcFixture({ guard: artifact.deployedBytecode });
      return async (chainId: number, method: string, params: unknown[]) => {
        if (method === "eth_getTransactionReceipt") return { ...receipt, ...overrides.receipt };
        if (method === "eth_getTransactionByHash") return { ...tx, ...overrides.tx };
        if (method === "eth_getBlockByNumber" && params[0] === "0xff") return { number: "0xff", hash: receiptHash };
        if (method === "eth_getCode" && (params[1] as { blockHash?: string })?.blockHash === receiptHash) return overrides.runtime ?? artifact.deployedBytecode;
        return base(chainId, method, params);
      };
    };
    expect(await verifyGuardReceipt(1, artifact, transactionHash, fixture())).toMatchObject({
      transactionHash, sender: tx.from, blockNumber: "255", confirmations: "2", canonical: true, finalized: false,
      configurationAddition: { chainId: 1, sessionGuardAddress: deployment.address, sessionGuardVersion: "current-v2" },
    });
    for (const changes of [
      { tx: { input: "0x" } }, { tx: { value: "0x1" } }, { tx: { to: deployment.address } },
      { tx: { chainId: "0xa" } }, { receipt: { status: "0x0" } }, { receipt: { blockHash } }, { runtime: "0x6000" },
    ]) await expect(verifyGuardReceipt(1, artifact, transactionHash, fixture(changes))).rejects.toThrow();
    await expect(verifyGuardReceipt(1, artifact, transactionHash, fixture(), 3)).rejects.toThrow("more confirmations");

    const safe = `0x${"ef".repeat(20)}`;
    const module = `0x${"de".repeat(20)}`;
    const inner = { type: "CALL", from: safe, to: GUARD_FACTORY, input: deployment.data, value: "0x0", output: deployment.address };
    const root = { type: "CALL", from: tx.from, to: module, input: "0x1234", value: "0x0", calls: [inner] };
    const sphinxFixture = (trace: unknown = root) => {
      const base = fixture({ tx: { to: module, input: "0x1234" } });
      return async (chainId: number, method: string, params: unknown[]) => method === "debug_traceTransaction"
        ? trace : base(chainId, method, params);
    };
    expect(await verifyGuardReceipt(1, artifact, transactionHash, sphinxFixture(), 2, safe))
      .toMatchObject({ sphinxSafe: safe, exactFactoryCallVerified: true });
    for (const trace of [
      { ...root, input: "0x5678" }, { ...root, calls: [] }, { ...root, calls: [inner, inner] },
      { ...root, calls: [{ ...inner, from: tx.from }] }, { ...root, calls: [{ ...inner, error: "execution reverted" }] },
      { ...root, calls: [{ type: "CALL", error: "execution reverted", calls: [inner] }] },
    ]) await expect(verifyGuardReceipt(1, artifact, transactionHash, sphinxFixture(trace), 2, safe)).rejects.toThrow();
  });
});
