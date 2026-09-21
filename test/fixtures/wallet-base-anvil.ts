// Base-shaped local chain: the unforked Safe stack on Anvil behind a proxy that presents the
// public Base fee predeploys, a Jovian L1-attributes deposit at index zero of every block and
// receipt L1 fees priced from those attributes. Test-only keys and synthetic balances.
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { keccak256, padHex, toHex, type Hex } from "viem";
import { calculateBaseSignedFees, type BaseFeeParameters } from "../../src/rest/wallet/deploymentFees.js";
import { createWalletDeploymentChain } from "../../src/rest/wallet/deploymentChain.js";
import { createWalletDeploymentAnvilRpc, startWalletDeploymentAnvil } from "./wallet-deployment-anvil.js";

const observations = JSON.parse(readFileSync(new URL("../../docs/rest/evidence/wallet-delivery-2026-09-15/base-runtime-observations.json", import.meta.url), "utf8")) as {
  transactions: { feeContracts: { address: Hex; runtime: Hex; implementation: Hex; implementationRuntime: Hex }[] }[] };
const vectors = JSON.parse(readFileSync(new URL("./base-fee-receipts.json", import.meta.url), "utf8")) as { transactions: { attributes: { input: string } }[] };
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
type Json = Record<string, unknown>;
const record = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const shift = (value: unknown) => typeof value === "string" ? toHex(BigInt(value) + 1n) : value;

/** Jovian attributes from a public Base vector with a small nonzero operator scalar and constant. */
export function baseAnvilAttributesInput(): Hex {
  const input = vectors.transactions[0]!.attributes.input;
  const replace = (data: string, start: number, end: number, value: bigint) =>
    data.slice(0, 2 + start * 2) + value.toString(16).padStart((end - start) * 2, "0") + data.slice(2 + end * 2);
  return replace(replace(input, 164, 168, 1n), 168, 176, 7n) as Hex;
}
export function baseAnvilParameters(): BaseFeeParameters {
  const data = baseAnvilAttributesInput(), uint = (start: number, end: number) => BigInt(`0x${data.slice(2 + start * 2, 2 + end * 2)}`);
  return { profile: "fjord-jovian", l1BaseFeeScalar: uint(4, 8), l1BlobBaseFeeScalar: uint(8, 12), l1BaseFee: uint(36, 68), l1BlobBaseFee: uint(68, 100),
    operatorFeeScalar: uint(164, 168), operatorFeeConstant: uint(168, 176) };
}

export async function startWalletBaseAnvil() {
  const feeContracts = observations.transactions[0]!.feeContracts;
  const anvil = await startWalletDeploymentAnvil(async rpc => {
    for (const contract of feeContracts) {
      await rpc("anvil_setCode", [contract.address, contract.runtime]);
      await rpc("anvil_setStorageAt", [contract.address, IMPLEMENTATION_SLOT, padHex(contract.implementation, { size: 32 })]);
      await rpc("anvil_setCode", [contract.implementation, contract.implementationRuntime]);
    }
  });
  const blocks = new Map<string, { number: string; timestamp: string }>();
  const depositHash = (blockHash: string): Hex => keccak256(`0x${Buffer.from(`base-attributes:${blockHash.toLowerCase()}`).toString("hex")}`);
  const deposit = (blockHash: string) => {
    const block = blocks.get(blockHash.toLowerCase());
    if (!block) return null;
    return { type: "0x7e", from: "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001", to: "0x4200000000000000000000000000000000000015",
      input: baseAnvilAttributesInput(), hash: depositHash(blockHash), blockHash, blockNumber: block.number, transactionIndex: "0x0",
      nonce: "0x0", value: "0x0", gas: "0xf4240", gasPrice: "0x0", chainId: "0x2105" };
  };
  const requests: { method: string; params: readonly unknown[] }[] = [];
  const faults: { transform: (method: string, params: readonly unknown[], result: unknown) => unknown; send: "none" | "lost-reply" | "wrong-hash";
    /** Runs after the upstream answered and before the reply is shaped; lets a test mine between two reads. */
    after: (method: string, params: readonly unknown[]) => Promise<void> } =
    { transform: (_method, _params, result) => result, send: "none", after: async () => undefined };
  function shape(method: string, params: readonly unknown[], result: unknown): unknown {
    if ((method === "eth_getBlockByNumber" || method === "eth_getBlockByHash") && record(result) && Array.isArray(result.transactions) && typeof result.hash === "string") {
      blocks.set(result.hash.toLowerCase(), { number: String(result.number), timestamp: String(result.timestamp) });
      const full = result.transactions.some(record);
      return { ...result, transactions: [full ? deposit(result.hash) : depositHash(result.hash),
        ...result.transactions.map(tx => record(tx) ? { ...tx, transactionIndex: shift(tx.transactionIndex) } : tx)] };
    }
    if (method === "eth_getTransactionByHash" && record(result) && typeof result.blockHash === "string")
      return { ...result, transactionIndex: shift(result.transactionIndex) };
    if (method === "eth_getTransactionReceipt" && record(result)) {
      const logs = Array.isArray(result.logs) ? result.logs.map(log => record(log) ? { ...log, transactionIndex: shift(log.transactionIndex) } : log) : result.logs;
      return { ...result, transactionIndex: shift(result.transactionIndex), logs, l1Fee: toHex(result.l1Fee as bigint) };
    }
    if (method === "eth_getLogs" && Array.isArray(result))
      return result.map(log => record(log) ? { ...log, transactionIndex: shift(log.transactionIndex) } : log);
    return result;
  }
  async function logRangeTooWide(filter: unknown) {
    const { fromBlock, toBlock } = (record(filter) ? filter : {}) as { fromBlock?: string; toBlock?: string };
    const head = BigInt(await anvil.rpc<string>("eth_blockNumber", []));
    const bound = (value: string | undefined, fallback: bigint) => value && /^0x[0-9a-f]+$/i.test(value) ? BigInt(value) : fallback;
    return bound(toBlock, head) - bound(fromBlock, 0n) >= 500n;
  }
  const proxy: Server = createServer(async (request, response) => {
    try {
      let bytes = "";
      for await (const chunk of request) { bytes += String(chunk); if (bytes.length > 262144) throw new Error("Fixture body bound"); }
      const body = JSON.parse(bytes) as { id: number; method: string; params: readonly unknown[] };
      requests.push({ method: body.method, params: body.params });
      let result: unknown;
      if (body.method === "eth_getTransactionByHash" && typeof body.params[0] === "string" && [...blocks.keys()].some(hash => depositHash(hash) === body.params[0])) {
        result = deposit([...blocks.keys()].find(hash => depositHash(hash) === body.params[0])!);
      } else if (body.method === "eth_getLogs" && await logRangeTooWide(body.params[0])) {
        // Dwellir's Base plan refuses wider log windows; the hosted runtime must page like production.
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32005, message: "eth_getLogs range exceeds the 500-block limit for this plan; split the request into ranges of at most 500 blocks" } }));
        return;
      } else if (body.method === "eth_sendRawTransaction" && faults.send === "lost-reply") {
        await anvil.rpc(body.method, body.params); response.destroy(); return;
      } else {
        result = await anvil.rpc(body.method, body.params);
        await faults.after(body.method, body.params);
        if (body.method === "eth_getTransactionReceipt" && record(result)) {
          const raw = await anvil.rpc<Hex>("eth_getRawTransactionByHash", [result.transactionHash]);
          result = { ...result, l1Fee: calculateBaseSignedFees({ rawTransaction: raw, parameters: baseAnvilParameters() }).l1FeeAtParameters };
        }
        result = shape(body.method, body.params, result);
        if (body.method === "eth_sendRawTransaction" && faults.send === "wrong-hash") result = `0x${"ab".repeat(32)}`;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: faults.transform(body.method, body.params, result) }));
    } catch {
      if (!response.destroyed) response.end('{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"synthetic-provider-detail"}}');
    }
  });
  await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
  const endpoint = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const sends = () => requests.filter(request => request.method === "eth_sendRawTransaction");
  // Every application read goes through the Base-shaped proxy so positions and fees stay consistent.
  const readOnlyRpc = createWalletDeploymentAnvilRpc(endpoint);
  const chain = () => createWalletDeploymentChain({ rpc: readOnlyRpc, configuration: anvil.configuration, manifest: anvil.manifest, utility: anvil.utility });
  async function reset() { await anvil.reset(); requests.length = 0; faults.transform = (_m, _p, result) => result; faults.send = "none"; faults.after = async () => undefined; }
  async function close() { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); await anvil.close(); }
  return { anvil, endpoint, requests, sends, faults, reset, close, feeContracts, genesisHash: anvil.expectedGenesisHash, expectedGenesisHash: anvil.expectedGenesisHash,
    configuration: anvil.configuration, manifest: anvil.manifest, utility: anvil.utility, sender: anvil.sender,
    rpc: anvil.rpc, readOnlyRpc, chain, signedContext: anvil.signedContext };
}
