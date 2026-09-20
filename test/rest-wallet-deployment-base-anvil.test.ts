// Hosted Base creation producers against a Base-shaped local chain: pinned fee predeploys,
// a reserved admission, one exact send and complete finalized receipt fees.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { toHex, type Hex } from "viem";
import { createBaseWalletDeploymentSettlement, createBaseWalletDeploymentTransport, baseWalletChainPins } from "../src/rest/wallet/deploymentBase.js";
import { assertWalletDeploymentDispatchAdmission } from "../src/rest/wallet/deploymentDispatch.js";
import { assertWalletDeploymentSettlementEvidence, walletDeploymentFundingConflict, type WalletDeploymentAccounting,
  type WalletDeploymentSettlementContext } from "../src/rest/wallet/deploymentSettlement.js";
import { calculateBaseSignedFees } from "../src/rest/wallet/deploymentFees.js";
import { baseAnvilParameters, startWalletBaseAnvil } from "./fixtures/wallet-base-anvil.js";
import { enrollmentDigest } from "../src/rest/wallet/enrollment.js";

describe("hosted Base deployment producers on a Base-shaped local chain", () => {
  let fixture: Awaited<ReturnType<typeof startWalletBaseAnvil>>;
  const options = () => ({ url: fixture.endpoint, genesisHash: fixture.genesisHash });
  const transport = () => createBaseWalletDeploymentTransport(options());
  const producer = () => createBaseWalletDeploymentSettlement({ ...options(), utility: fixture.utility });
  beforeAll(async () => { fixture = await startWalletBaseAnvil(); }, 60_000);
  beforeEach(async () => { await fixture.reset(); });
  afterAll(async () => { await fixture?.close(); });
  async function initialized(): Promise<WalletDeploymentSettlementContext> {
    const context = await fixture.signedContext();
    await fixture.rpc("anvil_setBalance", [fixture.sender, toHex(BigInt(fixture.configuration.allocationWei))]);
    const funding = await producer().observeFunding({ pool: context.pool, lastSettlement: null });
    const accounting: WalletDeploymentAccounting = { version: "center-wallet-deployment-accounting-v1", environment: funding.environment,
      initialHead: funding.head, initialNonce: funding.confirmedNonce, spentWei: "0", sequence: 0, nextNonce: funding.confirmedNonce,
      lastSettlementId: null, lastSettlementAnchor: null, fence: null };
    return { ...context, pool: { ...context.pool, accounting }, dispatch: null, lastSettlement: null };
  }

  it("reads the Base environment only after the pinned fee predeploy runtimes match", async () => {
    const context = await fixture.signedContext();
    const evidence = await producer().observeFunding({ pool: context.pool, lastSettlement: null });
    expect(evidence.environment).toEqual({ kind: "base-mainnet", genesisHash: fixture.genesisHash });
    expect(baseWalletChainPins.genesisHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(baseWalletChainPins.genesisHash).not.toBe(fixture.genesisHash);
    await fixture.rpc("anvil_setCode", [fixture.feeContracts[1]!.implementation, "0x6000"]);
    await expect(producer().observeFunding({ pool: context.pool, lastSettlement: null })).rejects.toMatchObject({ status: 502 });
  });
  it("refuses the production genesis pin against the local chain", async () => {
    const context = await fixture.signedContext();
    await expect(createBaseWalletDeploymentSettlement({ url: fixture.endpoint, utility: fixture.utility })
      .observeFunding({ pool: context.pool, lastSettlement: null })).rejects.toMatchObject({ status: 502 });
  });
  it("admits the frozen bytes with a reservation priced from the head block's attributes deposit, without sending", async () => {
    const context = await initialized(), admission = await transport().admit(context);
    const priced = calculateBaseSignedFees({ rawTransaction: context.operation.signed!.rawTransaction, parameters: baseAnvilParameters() });
    expect(admission).toMatchObject({ version: "center-wallet-deployment-base-admission-v1", feeScope: "base-execution-l1-operator-reserved",
      baseTotalAffordability: "reserved", environment: { kind: "base-mainnet", genesisHash: fixture.genesisHash },
      reservation: { l1WeiAtParameters: String(priced.l1FeeAtParameters), operatorMaximumWei: String(priced.operatorMaximumAtParameters),
        totalWei: String(BigInt(context.operation.signed!.maximumExecutionCost) + 2n * (priced.l1FeeAtParameters + priced.operatorMaximumAtParameters)) } });
    expect(priced.operatorMaximumAtParameters).toBeGreaterThan(0n);
    expect(assertWalletDeploymentDispatchAdmission(admission, context, Date.now())).toEqual(admission);
    expect(fixture.sends()).toHaveLength(0);
  });
  it("admits on the first pass when Base has mined past the observed head, pinned to that head", async () => {
    const context = await initialized(), observed = context.operation.observation!.head!;
    // The worker observed at head N; by the time the admission's identity reads return, Base is at
    // N+2. The send must still go out on this pass: the observed head is re-verified canonical and
    // every state read is pinned to it by hash, so nothing waits for "latest" to stand still.
    await fixture.rpc("anvil_mine", ["0x2", "0x0"]);
    const value = transport(), admission = await value.admit(context);
    expect(admission.environment.head).toEqual(observed);
    expect(BigInt((await fixture.rpc<{ number: string }>("eth_getBlockByNumber", ["latest", false])).number)).toBe(BigInt(observed.blockNumber) + 2n);
    expect(assertWalletDeploymentDispatchAdmission(admission, context, Date.now())).toEqual(admission);
    expect(await value.broadcast(admission)).toBe("accepted");
    expect(fixture.sends()).toHaveLength(1);
  });
  it.each(["observed-block", "latest-behind"])("refuses admission when the observed head is not canonical or latest is behind it (%s)", async check => {
    const context = await initialized(), observed = context.operation.observation!.head!;
    await fixture.rpc("anvil_mine", ["0x1", "0x0"]);
    fixture.faults.transform = (method, params, result) => {
      if (method !== "eth_getBlockByNumber" || !result || typeof result !== "object") return result;
      if (check === "observed-block" && params[0] === toHex(BigInt(observed.blockNumber))) return { ...result, hash: `0x${"ab".repeat(32)}` };
      if (check === "latest-behind" && params[0] === "latest") return { ...result, number: toHex(BigInt(observed.blockNumber) - 1n) };
      return result;
    };
    await expect(transport().admit(context)).rejects.toMatchObject({ status: 502, details: { check } });
    expect(fixture.sends()).toHaveLength(0);
  });
  it("refuses admission when the remaining allocation cannot cover the reservation", async () => {
    let context = await initialized();
    const reservation = (await transport().admit(context)).reservation!;
    // Execution alone stays affordable; only the complete reservation exceeds the remaining allocation.
    context = structuredClone(context);
    context.pool.configuration.allocationWei = context.pool.configuration.globalAllocationLimitWei = String(BigInt(reservation.totalWei) - 1n);
    context.pool.configurationDigest = context.operation.poolConfigurationDigest = enrollmentDigest(context.pool.configuration);
    expect(BigInt(context.pool.configuration.allocationWei)).toBeGreaterThan(BigInt(context.operation.signed!.maximumExecutionCost));
    await expect(transport().admit(context)).rejects.toMatchObject({ status: 502 });
    expect(fixture.sends()).toHaveLength(0);
  });
  it("sends the admitted bytes exactly once and settles complete finalized receipt fees", async () => {
    const context = await initialized(), value = transport(), admission = await value.admit(context);
    expect(await value.broadcast(admission)).toBe("accepted");
    expect(fixture.sends()).toHaveLength(1);
    expect(fixture.sends()[0]!.params).toEqual([context.operation.signed!.rawTransaction]);
    await expect(producer().observeSettlement(context)).rejects.toMatchObject({ status: 502 });
    await fixture.rpc("anvil_mine", ["0x201", "0x0"]);
    // Released at inclusion: the lane is empty, nextNonce is past this operation and its full
    // Base reservation is held until this settlement debits the actual fee.
    context.operation.releasedAt = Date.now(); context.operation.reservedWei = admission.reservation!.totalWei;
    context.pool.activeOperationId = null; context.pool.reservedWei = admission.reservation!.totalWei;
    context.pool.accounting!.nextNonce = String(BigInt(context.operation.template!.transaction.nonce) + 1n);
    fixture.requests.length = 0;
    // Base keeps mining during the pass: the funding read must pair with the observation's head
    // by number, not expect "latest" to stand still for twenty seconds.
    // Base's finalized tag also advances in bursts: the pass tolerates a later finalized head.
    let latestReads = 0, finalizedReads = 0;
    fixture.faults.after = async (method, params) => {
      if (method === "eth_getBlockByNumber" && params[0] === "latest" && ++latestReads === 1) await fixture.rpc("anvil_mine", ["0x1", "0x0"]);
      if (method === "eth_getBlockByNumber" && params[0] === "finalized" && ++finalizedReads === 1) await fixture.rpc("anvil_mine", ["0x1", "0x0"]);
    };
    const evidence = await producer().observeSettlement(context), receipt = evidence.observation.transaction.receipt!;
    fixture.faults.after = async () => undefined;
    expect(latestReads).toBeGreaterThan(0); expect(finalizedReads).toBeGreaterThan(1);
    // The verified creation receipt proves the deployment; a genesis-to-head factory scan is
    // impossible on a 500-block log plan, so every history read starts at the creation block.
    const scans = fixture.requests.filter(request => request.method === "eth_getLogs").map(request => request.params[0] as { fromBlock: string });
    expect(scans.length).toBeGreaterThan(0);
    expect(scans.map(scan => BigInt(scan.fromBlock) >= BigInt(receipt.block.blockNumber))).not.toContain(false);
    const priced = calculateBaseSignedFees({ rawTransaction: context.operation.signed!.rawTransaction, parameters: baseAnvilParameters() });
    const execution = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice), operator = BigInt(receipt.gasUsed) * 100n + 7n;
    expect(evidence.observation).toMatchObject({ transaction: { state: "canonical-success" }, wallet: { state: "verified" }, finality: { state: "finalized" } });
    expect(evidence.fees).toEqual({ profile: "base-fjord-jovian-receipt-v1", executionWei: String(execution), l1Wei: String(priced.l1FeeAtParameters),
      operatorWei: String(operator), totalWei: String(execution + priced.l1FeeAtParameters + operator) });
    expect(BigInt(evidence.fees.totalWei)).toBeGreaterThan(execution);
    expect(evidence.funding.environment).toEqual({ kind: "base-mainnet", genesisHash: fixture.genesisHash });
    expect(evidence.finalizedNonce).toBe(String(BigInt(context.operation.template!.transaction.nonce) + 1n));
    expect(assertWalletDeploymentSettlementEvidence(evidence, context, Date.now())).toEqual(evidence);
    expect(walletDeploymentFundingConflict(context, evidence.funding, evidence.finalizedNonce, "0")).toBeNull();
  });
  it.each(["l1Fee", "attributes", "runtime"])("withholds settlement when %s evidence is inconsistent", async fault => {
    const context = await initialized(), value = transport();
    expect(await value.broadcast(await value.admit(context))).toBe("accepted");
    await fixture.rpc("anvil_mine", ["0x41", "0x0"]);
    if (fault === "runtime") await fixture.rpc("anvil_setCode", [fixture.feeContracts[0]!.implementation, "0x6000"]);
    fixture.faults.transform = (method, _params, result) => {
      if (fault === "l1Fee" && method === "eth_getTransactionReceipt" && result && typeof result === "object")
        return { ...result, l1Fee: toHex(BigInt((result as { l1Fee: Hex }).l1Fee) + 1n) };
      if (fault === "attributes" && method === "eth_getTransactionByHash" && result && typeof result === "object" && (result as { type: string }).type === "0x7e")
        return { ...result, input: (result as { input: string }).input.replace(/^(0x3db6be2b)[0-9a-f]{8}/, "$100000001") };
      return result;
    };
    await expect(producer().observeSettlement(context)).rejects.toMatchObject({ status: 502 });
  });
  it("keeps a lost send reply and a wrong provider hash unknown without another send", async () => {
    for (const fault of ["lost-reply", "wrong-hash"] as const) {
      await fixture.reset();
      const context = await initialized(), value = transport(), admission = await value.admit(context);
      fixture.faults.send = fault;
      expect(await value.broadcast(admission)).toBe("unknown");
      expect(fixture.sends()).toHaveLength(1);
      await expect(value.broadcast(admission)).rejects.toBeDefined();
      expect(fixture.sends()).toHaveLength(1);
    }
  });
});
