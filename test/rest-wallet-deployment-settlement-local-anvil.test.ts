import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { toHex, type Hex } from "viem";
import { createLocalAnvilWalletDeploymentSettlement } from "../src/rest/wallet/deploymentSettlementLocalAnvil.js";
import { createLocalAnvilWalletDeploymentTransport } from "../src/rest/wallet/deploymentLocalAnvil.js";
import { assertWalletDeploymentDispatchAdmission } from "../src/rest/wallet/deploymentDispatch.js";
import { assertWalletDeploymentSettlementEvidence, walletDeploymentAccountingDigest, walletDeploymentFundingConflict } from "../src/rest/wallet/deploymentSettlement.js";
import type { WalletDeploymentAccounting, WalletDeploymentSettlementContext, WalletDeploymentSettlementReceipt } from "../src/rest/wallet/deploymentSettlement.js";
import { enrollmentDigest } from "../src/rest/wallet/enrollment.js";
import { startWalletDeploymentAnvil } from "./fixtures/wallet-deployment-anvil.js";

describe("qualified local deployment settlement producer", () => {
  let fixture: Awaited<ReturnType<typeof startWalletDeploymentAnvil>>;
  const producer = () => createLocalAnvilWalletDeploymentSettlement(fixture);
  beforeAll(async () => { fixture = await startWalletDeploymentAnvil(); }, 30000);
  beforeEach(async () => { await fixture.reset(); });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { await fixture?.close(); });
  function alterRpc(transform: (method: string, params: any[], value: any) => any, before?: (method: string, params: any[]) => Promise<void>) {
    const original = globalThis.fetch.bind(globalThis), calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const { method, params } = JSON.parse(String(init?.body)); calls.push(method);
      await before?.(method, params);
      const response = await original(input, init), value = await response.json();
      return new Response(JSON.stringify({ ...value, result: transform(method, params, value.result) }), {
        status: response.status, headers: { "content-type": "application/json" } });
    });
    return calls;
  }
  async function initialized(): Promise<WalletDeploymentSettlementContext> {
    const context = await fixture.signedContext();
    await fixture.rpc("anvil_setBalance", [fixture.sender, toHex(BigInt(fixture.configuration.allocationWei))]);
    const funding = await producer().observeFunding({ pool: context.pool, lastSettlement: null });
    const accounting: WalletDeploymentAccounting = { version: "center-wallet-deployment-accounting-v1", environment: funding.environment,
      initialHead: funding.head, initialNonce: funding.confirmedNonce, spentWei: "0", sequence: 0, nextNonce: funding.confirmedNonce,
      lastSettlementId: null, lastSettlementAnchor: null, fence: null };
    return { ...context, pool: { ...context.pool, accounting }, dispatch: null, lastSettlement: null };
  }
  async function mine(context: WalletDeploymentSettlementContext) {
    await fixture.rpc("eth_sendRawTransaction", [context.operation.signed!.rawTransaction]);
    await fixture.rpc("anvil_mine", ["0x41", "0x0"]);
  }
  async function finalized(context: WalletDeploymentSettlementContext) {
    await mine(context);
    return producer().observeSettlement(context);
  }

  it("reads the pinned unforked local environment and the actual starting nonce without adopting authority", async () => {
    const context = await fixture.signedContext(), evidence = await producer().observeFunding({ pool: context.pool, lastSettlement: null });
    expect(evidence).toMatchObject({ version: "center-wallet-deployment-funding-v1", poolId: fixture.configuration.id,
      configurationDigest: context.pool.configurationDigest, accountingDigest: null, confirmedNonce: context.operation.template!.transaction.nonce,
      pendingNonce: context.operation.template!.transaction.nonce, previousAnchor: null,
      environment: { kind: "unforked-anvil", genesisHash: fixture.expectedGenesisHash } });
    expect(evidence.environment.instanceId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(evidence.expiresAt - evidence.observedAt).toBeLessThanOrEqual(5000);
  });

  it("proves actual complete local fees and R-C balance using the source finalized observer", async () => {
    const context = await initialized(), evidence = await finalized(context), receipt = evidence.observation.transaction.receipt!;
    const cost = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
    expect(evidence.observation.transaction.state).toBe("canonical-success");
    expect(evidence.observation.wallet.state).toBe("verified");
    expect(evidence.observation.finality.state).toBe("finalized");
    expect(evidence.fees).toEqual({ profile: "unforked-anvil-execution-fees-v1", executionWei: String(cost), totalWei: String(cost) });
    expect(evidence.funding.balanceWei).toBe(String(BigInt(fixture.configuration.allocationWei) - cost));
    expect(evidence.finalizedNonce).toBe(String(BigInt(context.operation.template!.transaction.nonce) + 1n));
    expect(evidence.funding.confirmedNonce).toBe(evidence.finalizedNonce);
    expect(evidence.funding.pendingNonce).toBe(evidence.finalizedNonce);
    expect(evidence.observation.fees).toEqual({ executionWei: String(cost), l1Wei: null, operatorWei: null, totalWei: null });
    expect(evidence.observation.dispatchEligible).toBe(false);
    expect(assertWalletDeploymentSettlementEvidence(evidence, context, Date.now())).toEqual(evidence);
  });

  it("retains an unfinalized own deployment instead of minting a settlement", async () => {
    const context = await initialized();
    await fixture.rpc("eth_sendRawTransaction", [context.operation.signed!.rawTransaction]);
    await expect(producer().observeSettlement(context)).rejects.toMatchObject({ status: 502 });
  });

  it("retains a pending exact transaction even when its provider reports it", async () => {
    const context = await initialized();
    await fixture.rpc("evm_setAutomine", [false]);
    await fixture.rpc("eth_sendRawTransaction", [context.operation.signed!.rawTransaction]);
    await expect(producer().observeSettlement(context)).rejects.toMatchObject({ status: 502 });
  });

  it("charges a real finalized revert without claiming a created wallet", async () => {
    const context = await initialized();
    await fixture.rpc("anvil_setCode", [fixture.manifest.factory.address, "0x60006000fd"]);
    const evidence = await finalized(context), cost = BigInt(evidence.fees.totalWei);
    expect(evidence.observation.transaction.state).toBe("canonical-revert");
    expect(evidence.observation.transaction.receipt!.status).toBe("reverted");
    expect(evidence.observation.wallet.state).toBe("undeployed");
    expect(cost).toBeGreaterThan(0n);
    expect(evidence.funding.balanceWei).toBe(String(BigInt(fixture.configuration.allocationWei) - cost));
    expect(assertWalletDeploymentSettlementEvidence(evidence, context, Date.now())).toEqual(evidence);
  });

  it("retains own pending treasury liability when a third party creates the enrolled wallet", async () => {
    const context = await initialized();
    await fixture.rpc("eth_sendTransaction", [{ from: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      to: context.operation.template!.transaction.to, data: context.operation.template!.transaction.data, gas: "0x1e8480" }]);
    await fixture.rpc("evm_setAutomine", [false]);
    await fixture.rpc("eth_sendRawTransaction", [context.operation.signed!.rawTransaction]);
    const observed = await fixture.chain().observeSigned(context);
    expect(observed.transaction.state).toBe("pending"); expect(observed.wallet.state).toBe("verified");
    expect(observed.wallet.creationTransaction).not.toBe(context.operation.signed!.hash);
    await expect(producer().observeSettlement(context)).rejects.toMatchObject({ status: 502 });
  });

  it("returns actual conflicting nonce consumption for the durable fence instead of adopting it", async () => {
    const context = await initialized(); await mine(context);
    await fixture.rpc("eth_sendTransaction", [{ from: fixture.sender, to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", value: "0x0", gas: "0x5208" }]);
    await fixture.rpc("anvil_mine", ["0x41", "0x0"]);
    const evidence = await producer().observeSettlement(context), expected = String(BigInt(context.pool.accounting!.nextNonce) + 1n);
    expect(evidence.finalizedNonce).toBe(String(BigInt(expected) + 1n));
    expect(evidence.funding.confirmedNonce).toBe(evidence.finalizedNonce);
    expect(walletDeploymentFundingConflict(context, evidence.funding, expected, "0")).toBe("nonce-conflict");
    expect(context.pool.accounting!.nextNonce).toBe(context.operation.template!.transaction.nonce);
  });

  it("returns a real post-transaction balance deficit for a durable fence", async () => {
    const context = await initialized(); await mine(context);
    await fixture.rpc("anvil_setBalance", [fixture.sender, "0x1"]); await fixture.rpc("anvil_mine", ["0x1", "0x0"]);
    const evidence = await producer().observeSettlement(context), remaining = String(BigInt(fixture.configuration.allocationWei) - BigInt(evidence.fees.totalWei));
    expect(evidence.funding.balanceWei).toBe("1");
    expect(walletDeploymentFundingConflict(context, evidence.funding, evidence.finalizedNonce, remaining)).toBe("balance-deficit");
  });

  it.each(["missing-price", "price", "gas", "hash", "false-finality", "receipt-block", "raw-signature"])("withholds complete settlement for %s evidence", async fault => {
    const context = await initialized(); await mine(context);
    alterRpc((method, params, result) => {
      if (method === "eth_getTransactionReceipt" && result) {
        if (fault === "missing-price") delete result.effectiveGasPrice;
        if (fault === "price") result.effectiveGasPrice = "0x0";
        if (fault === "gas") result.gasUsed = "0x0";
        if (fault === "hash") result.transactionHash = `0x${"ab".repeat(32)}`;
        if (fault === "receipt-block") result.blockHash = `0x${"ab".repeat(32)}`;
      }
      if (method === "eth_getTransactionByHash" && result && fault === "raw-signature") result.r = "0x1";
      if (method === "eth_getBlockByNumber" && params[0] === "finalized" && fault === "false-finality") result.number = "0x1000000";
      return result;
    });
    await expect(producer().observeSettlement(context)).rejects.toMatchObject({ status: 502 });
  });

  it.each(["chain", "client", "fork", "hardfork", "metadata"])("does not qualify %s as local complete-fee evidence", async fault => {
    const context = await initialized();
    const calls = alterRpc((method, _params, result) => {
      if (method === "eth_chainId" && fault === "chain") return "0x1";
      if (method === "web3_clientVersion" && fault === "client") return "Geth/v1.0.0";
      if (method === "anvil_nodeInfo" && fault === "fork") result.forkConfig.forkUrl = "https://invalid.example";
      if (method === "anvil_nodeInfo" && fault === "hardfork") result.hardFork = "Prague";
      if (method === "anvil_metadata" && fault === "metadata") result.instanceId = null;
      return result;
    });
    await expect(producer().observeFunding(context)).rejects.toMatchObject({ status: 502 });
    expect(calls).not.toContain("eth_sendRawTransaction");
  });

  it.each(["pending-changed", "head-changed", "instance-changed"])("rejects funding when %s during final reads", async fault => {
    const context = await initialized(); let pendingReads = 0, metadataReads = 0;
    alterRpc((method, params, result) => {
      if (method === "eth_getTransactionCount" && params[1] === "pending" && fault === "pending-changed" && ++pendingReads > 1) return toHex(BigInt(result) + 1n);
      if (method === "eth_getBlockByNumber" && params[0] !== "latest" && params[0] !== "0x0" && fault === "head-changed") result.hash = `0x${"ab".repeat(32)}`;
      if (method === "anvil_metadata" && fault === "instance-changed" && ++metadataReads > 1) result.instanceId = `0x${"ab".repeat(32)}`;
      return result;
    });
    await expect(producer().observeFunding(context)).rejects.toMatchObject({ status: 502 });
  });

  it("does not adopt a mined nonce from a simulated stale accounting snapshot", async () => {
    const context = await initialized(); await mine(context);
    const evidence = await producer().observeFunding(context);
    expect(walletDeploymentFundingConflict(context, evidence)).toBe("nonce-conflict");
    expect(context.pool.accounting!.nextNonce).toBe(context.operation.template!.transaction.nonce);
  });

  it("rechecks the finalized tag after complete receipt and funding reads", async () => {
    const context = await initialized(); await mine(context);
    const genesis = await fixture.rpc("eth_getBlockByNumber", ["0x0", false]); let finalizedReads = 0;
    alterRpc((method, params, result) => method === "eth_getBlockByNumber" && params[0] === "finalized" && ++finalizedReads > 1 ? genesis : result);
    await expect(producer().observeSettlement(context)).rejects.toMatchObject({ status: 502 });
  });

  it.each(["v1-downgrade", "digest", "remaining", "nonce", "extra", "fence", "balance"])("rejects %s in an initialized dispatch admission", async fault => {
    const context = await initialized(), admission: any = await createLocalAnvilWalletDeploymentTransport(fixture).admit(context);
    if (fault === "v1-downgrade") { admission.version = "center-wallet-deployment-local-admission-v1"; delete admission.accounting; }
    if (fault === "digest") admission.accounting.digest = "ab".repeat(32);
    if (fault === "remaining") admission.accounting.remainingWei = String(BigInt(admission.accounting.remainingWei) - 1n);
    if (fault === "nonce") admission.accounting.nextNonce = String(BigInt(admission.accounting.nextNonce) + 1n);
    if (fault === "extra") admission.accounting.refund = "1";
    if (fault === "fence") context.pool.accounting!.fence = { reason: "restore-required", evidenceDigest: "ab".repeat(32), recordedAt: Date.now() };
    if (fault === "balance") admission.balanceWei = String(BigInt(fixture.configuration.allocationWei) - 1n);
    expect(() => assertWalletDeploymentDispatchAdmission(admission, context, Date.now())).toThrow();
  });

  it.each(["instance", "nonce", "restore"])("withholds a local send capability for %s accounting mismatch", async fault => {
    const context = await initialized();
    if (fault === "instance") context.pool.accounting!.environment.instanceId = `0x${"ab".repeat(32)}`;
    if (fault === "nonce") context.pool.accounting!.nextNonce = String(BigInt(context.pool.accounting!.nextNonce) + 1n);
    if (fault === "restore") context.pool.accounting!.fence = { reason: "restore-required", evidenceDigest: "ab".repeat(32), recordedAt: Date.now() };
    const calls = alterRpc((_method, _params, result) => result);
    await expect(createLocalAnvilWalletDeploymentTransport(fixture).admit(context)).rejects.toBeDefined();
    expect(calls).not.toContain("eth_sendRawTransaction");
  });

  it.each(["expired", "backwards"])("withholds funding after its %s clock boundary", async fault => {
    const context = await initialized(); let clock = Date.now(), reads = 0;
    alterRpc((method, _params, result) => { if (method === "anvil_metadata" && ++reads > 1) clock += fault === "expired" ? 5000 : -1; return result; });
    await expect(createLocalAnvilWalletDeploymentSettlement({ ...fixture, now: () => clock }).observeFunding(context)).rejects.toMatchObject({ status: 502 });
  });

  it("bounds a local provider that ignores read cancellation", async () => {
    const context = await initialized();
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => undefined));
    const started = performance.now();
    await expect(producer().observeFunding(context)).rejects.toMatchObject({ status: 502 });
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it("honors an already cancelled funding observation without making requests", async () => {
    const context = await initialized(), controller = new AbortController(); controller.abort();
    const calls = alterRpc((_method, _params, result) => result);
    await expect(producer().observeFunding(context, controller.signal)).rejects.toMatchObject({ status: 502 });
    expect(calls).toHaveLength(0);
  });

  it("fails uninitialized funding for an unexpected genesis", async () => {
    const context = await fixture.signedContext();
    await expect(createLocalAnvilWalletDeploymentSettlement({ ...fixture, expectedGenesisHash: `0x${"ab".repeat(32)}` })
      .observeFunding({ pool: context.pool, lastSettlement: null })).rejects.toMatchObject({ status: 502 });
  });

  it("exposes a real reset instance even when its retained settlement height is now unavailable", async () => {
    const isolated = await startWalletDeploymentAnvil();
    try {
      const value = createLocalAnvilWalletDeploymentSettlement(isolated), operation = await isolated.signedContext();
      const initial = await value.observeFunding({ pool: operation.pool, lastSettlement: null });
      const context: WalletDeploymentSettlementContext = { ...operation, dispatch: null, lastSettlement: null,
        pool: { ...operation.pool, accounting: { version: "center-wallet-deployment-accounting-v1", environment: initial.environment,
          initialHead: initial.head, initialNonce: initial.confirmedNonce, spentWei: "0", sequence: 0, nextNonce: initial.confirmedNonce,
          lastSettlementId: null, lastSettlementAnchor: null, fence: null } } };
      await isolated.rpc("eth_sendRawTransaction", [context.operation.signed!.rawTransaction]);
      await isolated.rpc("anvil_mine", ["0x41", "0x0"]);
      const evidence = await value.observeSettlement(context);
      const pool = { ...context.pool, activeOperationId: null, accounting: { ...context.pool.accounting!, sequence: 1,
        spentWei: evidence.fees.totalWei, nextNonce: evidence.finalizedNonce, lastSettlementId: context.operation.id,
        lastSettlementAnchor: evidence.observation.finality.evidence! } };
      await isolated.rpc("anvil_reset", []);
      const reset = await value.observeFunding({ pool, lastSettlement: null });
      expect(reset.environment.instanceId).not.toBe(initial.environment.instanceId);
      expect(reset.previousAnchor).toBeNull();
      expect(walletDeploymentFundingConflict({ pool, lastSettlement: null }, reset)).toBe("environment-changed");
      expect(pool.accounting.spentWei).toBe(evidence.fees.totalWei);
    } finally { await isolated.close(); }
  });

  it("admits the next distinct user's frozen bytes against the remaining R-C allocation", async () => {
    const first = await initialized(), evidence = await finalized(first), second = await fixture.signedContext();
    const accounting: WalletDeploymentAccounting = { ...first.pool.accounting!, spentWei: evidence.fees.totalWei, sequence: 1,
      nextNonce: evidence.finalizedNonce, lastSettlementId: first.operation.id, lastSettlementAnchor: evidence.observation.finality.evidence! };
    second.pool.accounting = accounting;
    expect(second.enrollment.intent.id).not.toBe(first.enrollment.intent.id);
    const transport = createLocalAnvilWalletDeploymentTransport(fixture), admission = await transport.admit(second);
    expect(admission).toMatchObject({ version: "center-wallet-deployment-local-admission-v2", accounting: {
      digest: walletDeploymentAccountingDigest(accounting), remainingWei: String(BigInt(fixture.configuration.allocationWei) - BigInt(evidence.fees.totalWei)),
      nextNonce: evidence.finalizedNonce } });
    expect(assertWalletDeploymentDispatchAdmission(admission, second, Date.now())).toEqual(admission);
    await fixture.rpc("evm_setAutomine", [false]);
    expect(await transport.broadcast(admission)).toBe("accepted");
    // Provider acceptance can precede block inclusion, including with automining.
    // Make both states deterministic before asserting the verified creation.
    expect((await fixture.chain().observeSigned(second)).transaction.state).toBe("pending");
    await fixture.rpc("anvil_mine", ["0x1", "0x0"]);
    const observed = await fixture.chain().observeSigned(second);
    expect(observed.transaction.state).toBe("canonical-success"); expect(observed.wallet.state).toBe("verified");
    expect(second.operation.template!.transaction.nonce).toBe(evidence.finalizedNonce);
  });

  it("returns a real replaced finalized anchor for the durable pool fence without inventing a refund", async () => {
    const context = await initialized(), before = await fixture.rpc<Hex>("evm_snapshot"), evidence = await finalized(context);
    const oldAnchor = evidence.observation.finality.evidence!;
    const receipt: WalletDeploymentSettlementReceipt = { version: "center-wallet-deployment-settlement-receipt-v1", id: context.operation.id,
      poolId: context.pool.configuration.id, operationId: context.operation.id, evidenceDigest: enrollmentDigest(evidence), evidence,
      nonce: context.operation.template!.transaction.nonce, priorSequence: 0, sequence: 1, spentWei: evidence.fees.totalWei,
      nextNonce: evidence.finalizedNonce, settledAt: Date.now() };
    const pool = { ...context.pool, activeOperationId: null, accounting: { ...context.pool.accounting!, spentWei: receipt.spentWei,
      sequence: 1, nextNonce: receipt.nextNonce, lastSettlementId: receipt.id, lastSettlementAnchor: oldAnchor } };
    expect(await fixture.rpc("evm_revert", [before])).toBe(true);
    await fixture.rpc("anvil_mine", ["0x42", "0x0"]);
    const current = await producer().observeFunding({ pool, lastSettlement: receipt });
    expect(current.previousAnchor!.blockNumber).toBe(oldAnchor.blockNumber);
    expect(current.previousAnchor!.blockHash).not.toBe(oldAnchor.blockHash);
    expect(current.confirmedNonce).toBe(context.operation.template!.transaction.nonce);
    expect(pool.accounting.spentWei).toBe(receipt.spentWei);
    expect(pool.accounting.nextNonce).toBe(receipt.nextNonce);
    expect(walletDeploymentFundingConflict({ pool, lastSettlement: receipt }, current)).toBe("finalized-anchor-replaced");
  });
});
