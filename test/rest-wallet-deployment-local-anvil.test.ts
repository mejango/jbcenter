import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { toHex, type Hex } from "viem";
import { createLocalAnvilWalletDeploymentTransport } from "../src/rest/wallet/deploymentLocalAnvil.js";
import { assertWalletDeploymentDispatchAdmission } from "../src/rest/wallet/deploymentDispatch.js";
import { startWalletDeploymentAnvil } from "./fixtures/wallet-deployment-anvil.js";

describe("explicit unforked local Anvil deployment transport", () => {
  let fixture: Awaited<ReturnType<typeof startWalletDeploymentAnvil>>;
  let proxy: Server, endpoint: string;
  type Request = { jsonrpc: string; id: number; method: string; params: any[] };
  const requests: Request[] = [];
  let transform: (request: Request, result: any) => any = (_request, result) => result;
  let before: (request: Request) => void | Promise<void> = () => undefined;
  let sendFault: "none" | "lost-reply" | "wrong-hash" | "malformed" | "redirect" = "none";
  const sends = () => requests.filter(request => request.method === "eth_sendRawTransaction");
  const transport = (now?: () => number) => createLocalAnvilWalletDeploymentTransport({ endpoint,
    expectedGenesisHash: fixture.expectedGenesisHash, ...(now ? { now } : {}) });
  beforeAll(async () => {
    fixture = await startWalletDeploymentAnvil();
    proxy = createServer(async (request, response) => {
      try {
        let bytes = "";
        for await (const chunk of request) { bytes += String(chunk); if (bytes.length > 131072) throw new Error("Fixture body bound"); }
        const body = JSON.parse(bytes) as Request; requests.push(body); await before(body);
        if (body.method === "eth_sendRawTransaction" && sendFault === "redirect") {
          response.writeHead(302, { location: `${fixture.endpoint}/redirect-target` }); response.end(); return;
        }
        const result = transform(body, await fixture.rpc(body.method, body.params));
        if (body.method === "eth_sendRawTransaction") {
          if (sendFault === "lost-reply") { response.destroy(); return; }
          if (sendFault === "malformed") { response.end('{"jsonrpc":"2.0","result":'); return; }
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id,
          result: body.method === "eth_sendRawTransaction" && sendFault === "wrong-hash" ? `0x${"ab".repeat(32)}` : result }));
      } catch { if (!response.destroyed) response.end('{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"synthetic-private-provider-detail"}}'); }
    });
    await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
    endpoint = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  }, 30000);
  beforeEach(async () => {
    await fixture.reset(); requests.length = 0; transform = (_request, result) => result; before = () => undefined; sendFault = "none";
  });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => {
    proxy?.closeAllConnections(); if (proxy) await new Promise<void>(resolve => proxy.close(() => resolve())); await fixture?.close();
  });

  it("admits genuine frozen signed creation at the pinned local genesis without broadcasting", async () => {
    const context = await fixture.signedContext();
    const transport = createLocalAnvilWalletDeploymentTransport(fixture);
    const admission = await transport.admit(context);
    expect(admission).toMatchObject({ operationId: context.operation.id, transactionHash: context.operation.signed!.hash,
      templateCommitment: context.operation.templateCommitment, feeScope: "local-execution-only", baseTotalAffordability: "unknown",
      environment: { kind: "unforked-anvil", genesisHash: fixture.expectedGenesisHash } });
    expect(admission.expiresAt - admission.observedAt).toBeLessThanOrEqual(5000);
    expect(assertWalletDeploymentDispatchAdmission(admission, context, Date.now())).toEqual(admission);
    expect(await fixture.rpc("eth_getTransactionReceipt", [context.operation.signed!.hash])).toBeNull();
  });

  it("broadcasts exactly the admitted bytes once and observes the real created wallet", async () => {
    const context = await fixture.signedContext(), transport = createLocalAnvilWalletDeploymentTransport(fixture);
    const admission = await transport.admit(context);
    expect(await transport.broadcast(admission)).toBe("accepted");
    await expect(transport.broadcast(admission)).rejects.toMatchObject({ status: 403 });
    const observed = await fixture.chain().observeSigned(context);
    expect(observed.transaction.state).toBe("canonical-success"); expect(observed.wallet.state).toBe("verified");
  });

  it("keeps a fresh canonical observation usable after the chain advances", async () => {
    const context = await fixture.signedContext(), value = transport();
    await fixture.rpc("anvil_mine", ["0x1", "0x0"]);
    const admission = await value.admit(context);
    expect(admission.environment.head).toEqual(context.operation.observation!.head);
    expect(assertWalletDeploymentDispatchAdmission(admission, context, Date.now())).toEqual(admission);
    expect(await value.broadcast(admission)).toBe("accepted");
    expect(sends()).toHaveLength(1);
  });

  it.each(["https://127.0.0.1:8545", "http://localhost:8545", "http://127.1:8545", "http://2130706433:8545", "http://0x7f000001:8545",
    "http://127.0.0.2:8545", "http://example.com:8545", "http://user@127.0.0.1:8545", "http://127.0.0.1:8545/path",
    "http://127.0.0.1:8545?x=y", "http://127.0.0.1:8545#x", "http://127.0.0.1:65536"])("rejects nonliteral or extended endpoint %s before I/O", endpoint => {
    expect(() => createLocalAnvilWalletDeploymentTransport({ endpoint, expectedGenesisHash: fixture.expectedGenesisHash })).toThrow();
    expect(requests).toHaveLength(0);
  });

  it("refuses another genesis even when its chain ID and Anvil identity match", async () => {
    const context = await fixture.signedContext();
    await expect(createLocalAnvilWalletDeploymentTransport({ endpoint, expectedGenesisHash: `0x${"ab".repeat(32)}` }).admit(context)).rejects.toMatchObject({ status: 502 });
    expect(sends()).toHaveLength(0);
  });

  it.each(["client", "fork-url", "fork-block", "fork-metadata", "hardfork", "chain", "instance-change"])("withholds admission for %s identity", async fault => {
    const context = await fixture.signedContext(); let metadataReads = 0;
    transform = (request, result) => {
      if (request.method === "web3_clientVersion" && fault === "client") return "Geth/v1.6.0";
      if (request.method === "eth_chainId" && fault === "chain") return "0x1";
      if (request.method === "anvil_nodeInfo") {
        if (fault === "fork-url") result.forkConfig.forkUrl = "https://synthetic.invalid";
        if (fault === "fork-block") result.forkConfig.forkBlockNumber = "0x1";
        if (fault === "hardfork") result.hardFork = "Prague";
      }
      if (request.method === "anvil_metadata") {
        if (fault === "fork-metadata") result.forkedNetwork = { chainId: 8453 };
        if (fault === "instance-change" && ++metadataReads > 1) result.instanceId = `0x${"ab".repeat(32)}`;
      }
      return result;
    };
    await expect(transport().admit(context)).rejects.toMatchObject({ status: 502 }); expect(sends()).toHaveLength(0);
  });

  it.each(["pending", "unknown", "nonce", "paused", "finalized-history", "stale", "raw", "template", "pool"])("rejects %s context before obtaining a send capability", async fault => {
    const context = await fixture.signedContext(), op = context.operation;
    if (fault === "pending") op.observation!.transaction.state = "pending";
    if (fault === "unknown") op.observation!.wallet.state = "unknown";
    if (fault === "nonce") op.observation!.transaction.nonce!.pending = String(BigInt(op.template!.transaction.nonce) + 1n);
    if (fault === "paused") context.pool.state = "paused";
    if (fault === "finalized-history") op.historicalCanonicalObservation = { ...structuredClone(op.observation!), finality: { state: "finalized", evidence: op.observation!.head } };
    if (fault === "stale") op.observation!.observedAt -= 10000;
    if (fault === "raw") op.signed!.rawTransaction = `${op.signed!.rawTransaction.slice(0, -2)}00` as Hex;
    if (fault === "template") op.template!.transaction.nonce = String(BigInt(op.template!.transaction.nonce) + 1n);
    if (fault === "pool") context.pool.configurationDigest = "ab".repeat(32);
    await expect(transport().admit(context)).rejects.toBeDefined(); expect(requests).toHaveLength(0);
  });

  it("requires balance covering the whole permanent allocation even when execution alone is affordable", async () => {
    const context = await fixture.signedContext();
    const partial = BigInt(context.operation.signed!.maximumExecutionCost) + 1n;
    expect(partial).toBeLessThan(BigInt(context.pool.configuration.allocationWei));
    await fixture.rpc("anvil_setBalance", [fixture.sender, toHex(partial)]);
    await expect(transport().admit(context)).rejects.toMatchObject({ status: 502 }); expect(sends()).toHaveLength(0);
  });

  it.each(["fee-cap", "estimate", "simulation", "canonical", "runtime", "pending-change"])("rejects %s changes without changing frozen bytes", async fault => {
    const context = await fixture.signedContext(), frozen = structuredClone(context); let blockReads = 0, pendingReads = 0;
    transform = (request, result) => {
      if (request.method === "eth_getBlockByNumber" && request.params[0] !== "0x0") {
        if (fault === "fee-cap") result.baseFeePerGas = toHex(BigInt(context.operation.template!.transaction.maxFeePerGas));
        if (fault === "canonical" && request.params[0] === toHex(BigInt(context.operation.observation!.head!.blockNumber)) && ++blockReads > 1) result.hash = `0x${"ab".repeat(32)}`;
      }
      if (request.method === "eth_estimateGas" && fault === "estimate") return toHex(BigInt(context.operation.template!.transaction.gas) + 1n);
      if (request.method === "eth_call" && request.params[0].to.toLowerCase() === context.operation.template!.transaction.to.toLowerCase() && fault === "simulation") return `0x${"00".repeat(32)}`;
      if (request.method === "eth_getCode" && request.params[0].toLowerCase() === fixture.manifest.factory.address.toLowerCase() && fault === "runtime") return "0x6000";
      if (request.method === "eth_getTransactionCount" && request.params[1] === "pending" && fault === "pending-change" && ++pendingReads > 1) return toHex(BigInt(result) + 1n);
      return result;
    };
    await expect(transport().admit(context)).rejects.toMatchObject({ status: 502 }); expect(context).toEqual(frozen); expect(sends()).toHaveLength(0);
  });

  it("rechecks actual transaction presence before admitting old not-observed evidence", async () => {
    const context = await fixture.signedContext(); await fixture.rpc("evm_setAutomine", [false]);
    await fixture.rpc("eth_sendRawTransaction", [context.operation.signed!.rawTransaction]);
    await expect(transport().admit(context)).rejects.toMatchObject({ status: 502 }); expect(sends()).toHaveLength(0);
  });

  it("snapshots caller context before async reads and broadcasts only the admitted original bytes", async () => {
    const context = await fixture.signedContext(), raw = context.operation.signed!.rawTransaction;
    before = request => { if (request.method === "anvil_metadata") { context.operation.signed!.rawTransaction = "0x02"; context.operation.template!.transaction.gas = "1"; } };
    const value = transport(), admission = await value.admit(context);
    expect(await value.broadcast(admission)).toBe("accepted"); expect(sends().map(send => send.params[0])).toEqual([raw]);
  });

  it("rejects cloned and foreign capabilities without consuming the original", async () => {
    const context = await fixture.signedContext(), value = transport(), admission = await value.admit(context);
    await expect(value.broadcast(structuredClone(admission))).rejects.toMatchObject({ status: 403 });
    await expect(transport().broadcast(admission)).rejects.toMatchObject({ status: 403 });
    expect(sends()).toHaveLength(0); expect(await value.broadcast(admission)).toBe("accepted");
  });

  it.each(["mutated", "expired", "backwards-clock"])("consumes and refuses a %s minted capability", async fault => {
    const context = await fixture.signedContext(); let clock = Date.now();
    const value = transport(() => clock), admission = await value.admit(context);
    if (fault === "mutated") admission.transactionHash = `0x${"ab".repeat(32)}`;
    if (fault === "expired") clock = admission.expiresAt;
    if (fault === "backwards-clock") clock = admission.observedAt - 1;
    await expect(value.broadcast(admission)).rejects.toMatchObject({ status: 403 });
    await expect(value.broadcast(admission)).rejects.toMatchObject({ status: 403 }); expect(sends()).toHaveLength(0);
  });

  it("refuses mutation during broadcast identity reads and never exposes a changed raw envelope", async () => {
    const context = await fixture.signedContext(), value = transport(), admission = await value.admit(context);
    before = request => { if (request.method === "anvil_metadata") admission.expiresAt += 100000; };
    expect(await value.broadcast(admission)).toBe("unknown"); expect(sends()).toHaveLength(0);
    await expect(value.broadcast(admission)).rejects.toMatchObject({ status: 403 });
  });

  it("refuses a replaced local Anvil instance before sending", async () => {
    const context = await fixture.signedContext(), value = transport(), admission = await value.admit(context);
    transform = (request, result) => request.method === "anvil_metadata" ? { ...result, instanceId: `0x${"ab".repeat(32)}` } : result;
    expect(await value.broadcast(admission)).toBe("unknown"); expect(sends()).toHaveLength(0);
  });

  it("sends zero bytes when the final canonical read crosses a shorter durable dispatch lease", async () => {
    const context = await fixture.signedContext(), value = transport(), admission = await value.admit(context);
    const leaseUntil = Date.now() + 250;
    before = async request => {
      if (request.method === "eth_getBlockByNumber" && request.params[0] !== "0x0")
        await new Promise(resolve => setTimeout(resolve, Math.max(1, leaseUntil - Date.now() + 25)));
    };
    expect(await value.broadcast(admission, undefined, leaseUntil)).toBe("unknown");
    expect(sends()).toHaveLength(0);
    expect(await fixture.rpc("eth_getTransactionReceipt", [context.operation.signed!.hash])).toBeNull();
    await expect(value.broadcast(admission)).rejects.toMatchObject({ status: 403 });
  });

  it.each(["lost-reply", "wrong-hash", "malformed", "redirect"] as const)("records %s as unknown without automatic send retry", async fault => {
    const context = await fixture.signedContext(), value = transport(), admission = await value.admit(context); sendFault = fault;
    expect(await value.broadcast(admission)).toBe("unknown"); expect(sends()).toHaveLength(1);
    expect(sends()[0]!.params).toEqual([context.operation.signed!.rawTransaction]);
    await expect(value.broadcast(admission)).rejects.toMatchObject({ status: 403 });
    if (fault !== "redirect") await expect.poll(() => fixture.rpc("eth_getTransactionReceipt", [context.operation.signed!.hash])).not.toBeNull();
    else expect(await fixture.rpc("eth_getTransactionReceipt", [context.operation.signed!.hash])).toBeNull();
  });

  it("consumes an aborted admission with zero send attempts", async () => {
    const context = await fixture.signedContext(), value = transport(), admission = await value.admit(context), controller = new AbortController(); controller.abort();
    expect(await value.broadcast(admission, controller.signal)).toBe("unknown"); expect(sends()).toHaveLength(0);
    await expect(value.broadcast(admission)).rejects.toMatchObject({ status: 403 });
  });

  it("bounds a broadcast transport that ignores AbortSignal without retry or error disclosure", async () => {
    const context = await fixture.signedContext(), original = globalThis.fetch.bind(globalThis); let sendCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (JSON.parse(String(init?.body)).method === "eth_sendRawTransaction") { sendCount++; return new Promise(() => undefined); }
      return original(input, init);
    });
    const value = transport(), admission = await value.admit(context), start = performance.now();
    expect(await value.broadcast(admission)).toBe("unknown"); expect(sendCount).toBe(1); expect(performance.now() - start).toBeLessThan(4000);
    await expect(value.broadcast(admission)).rejects.toMatchObject({ status: 403 });
  }, 8000);

  it("bounds admission when a read transport ignores AbortSignal", async () => {
    const context = await fixture.signedContext(), original = globalThis.fetch.bind(globalThis);
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => JSON.parse(String(init?.body)).method === "anvil_metadata"
      ? new Promise(() => undefined) : original(input, init));
    const start = performance.now(); await expect(transport().admit(context)).rejects.toMatchObject({ status: 502 });
    expect(performance.now() - start).toBeLessThan(3000); expect(sends()).toHaveLength(0);
  }, 6000);
});
