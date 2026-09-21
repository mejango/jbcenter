import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TransactionSerializableEIP1559 } from "viem";
import { createWalletDeploymentExecution, type WalletDeploymentExecutionStore } from "../src/rest/wallet/deploymentExecution.js";
import { assertWalletDeploymentDispatchAdmission } from "../src/rest/wallet/deploymentDispatch.js";
import type { WalletDeploymentDispatchAdmission, WalletDeploymentDispatchJournal, WalletDeploymentExecutionContext } from "../src/rest/wallet/deploymentDispatch.js";
import { deploymentFixtureSigner, syntheticDeploymentAdmission, syntheticDeploymentContext,
  syntheticDeploymentObservation } from "./fixtures/wallet-deployment-execution.js";

let context: WalletDeploymentExecutionContext;
beforeEach(async () => { context = await syntheticDeploymentContext(); });
function harness() {
  let current = structuredClone(context);
  let journal: WalletDeploymentDispatchJournal;
  const calls: string[] = [];
  const store: WalletDeploymentExecutionStore = {
    loadExecutionContext: vi.fn(async () => { calls.push("load"); return structuredClone(current); }),
    leaseSigning: vi.fn(async () => { calls.push("lease"); current.operation.revision++;
      return { operation: structuredClone(current.operation), leaseToken: "12345678-1234-4567-89ab-123456789abc",
        leaseUntil: Date.now() + 3000, revision: current.operation.revision }; }),
    persistSigned: vi.fn(async input => { calls.push("persist"); current.operation = { ...context.operation, revision: current.operation.revision + 1,
      signed: { ...context.operation.signed!, rawTransaction: input.rawTransaction } }; return { operation: current.operation, replayed: false }; }),
    saveObservation: vi.fn(async input => { calls.push("observe-save"); current.operation.observation = input.observation;
      current.operation.observationSavedAt = Date.now(); current.operation.revision++; return { operation: current.operation, replayed: false }; }),
    leaseDispatch: vi.fn(async input => { calls.push("dispatch-claim"); journal = { operationId: input.operationId,
      transactionHash: input.signedHash, templateCommitment: input.admission.templateCommitment, revision: 1, attempts: 1,
      status: "in-flight", leaseToken: "12345678-1234-4567-89ab-123456789abc", leaseUntil: Date.now() + 3000,
      admission: input.admission, admissionDigest: "b".repeat(64), claimedAt: Date.now(), settledAt: null, nextAttemptAt: Date.now() + 4000 };
      return journal; }),
    settleDispatch: vi.fn(async input => { calls.push("dispatch-settle"); return { journal: { ...journal, status: input.status,
      revision: journal.revision + 1, settledAt: Date.now() }, replayed: false }; }),
  };
  const signer = { address: deploymentFixtureSigner.address, signTransaction: vi.fn(async (tx: TransactionSerializableEIP1559) => {
    calls.push("sign"); return deploymentFixtureSigner.signTransaction(tx); }) };
  const chain = { observeSigned: vi.fn(async input => { calls.push("observe"); return syntheticDeploymentObservation({ ...context, ...input }); }) };
  const experimentalTransport = { admit: vi.fn(async input => { calls.push("admit"); return syntheticDeploymentAdmission(input); }),
    broadcast: vi.fn(async (_input: WalletDeploymentDispatchAdmission) => { calls.push("broadcast"); return "accepted" as const; }) };
  return { store, signer, chain, experimentalTransport, calls,
    setClaimed: () => { current.operation.state = "claimed"; current.operation.signed = null; } };
}
describe("durable frozen deployment signing and experimental dispatch coordinator", () => {
  it("returns the durable signed winner without invoking the signer", async () => {
    const h = harness(), result = await createWalletDeploymentExecution(h).sign(context.operation.id);
    expect(result.signed).toEqual(context.operation.signed); expect(h.signer.signTransaction).not.toHaveBeenCalled();
  });
  it("leases, signs only the frozen template, persists and reloads before returning", async () => {
    const h = harness(); h.setClaimed();
    expect((await createWalletDeploymentExecution(h).sign(context.operation.id)).signed).toEqual(context.operation.signed);
    expect(h.calls).toEqual(["load", "lease", "sign", "persist", "load"]);
  });
  it("persists read-only observation while dispatch remains closed without explicit experimental transport", async () => {
    const h = harness(), result = await createWalletDeploymentExecution({ store: h.store, signer: h.signer, chain: h.chain }).recover(context.operation.id);
    expect(result.dispatch).toBe("disabled"); expect(h.calls).toEqual(["load", "observe", "observe-save", "load"]);
    expect(h.store.leaseDispatch).not.toHaveBeenCalled();
  });
  it("accepts a bounded context-bound local admission without claiming Base affordability", () => {
    context.operation.observation = syntheticDeploymentObservation(context);
    const value = syntheticDeploymentAdmission(context);
    expect(assertWalletDeploymentDispatchAdmission(value, context, value.observedAt)).toEqual(value);
    expect(value.baseTotalAffordability).toBe("unknown");
  });
  it("observes and persists before claiming dispatch, then settles only the exact durable lease", async () => {
    const h = harness(), result = await createWalletDeploymentExecution(h).recover(context.operation.id);
    expect(result.dispatch).toBe("accepted");
    expect(h.calls).toEqual(["load", "observe", "observe-save", "load", "admit", "dispatch-claim", "broadcast", "dispatch-settle", "load"]);
    expect(h.signer.signTransaction).not.toHaveBeenCalled();
    expect(h.experimentalTransport.broadcast).toHaveBeenCalledWith(expect.any(Object), undefined, expect.any(Number));
  });
  it("does not send when dispatch commit fails or its response is lost", async () => {
    const h = harness(); vi.mocked(h.store.leaseDispatch).mockRejectedValue(new Error("commit response lost"));
    await expect(createWalletDeploymentExecution(h).recover(context.operation.id)).rejects.toThrow("commit response lost");
    expect(h.experimentalTransport.broadcast).not.toHaveBeenCalled();
  });
  it("reports persistence uncertainty after a send without fabricating a settled result", async () => {
    const h = harness(); vi.mocked(h.store.settleDispatch).mockRejectedValue(new Error("commit response lost"));
    await expect(createWalletDeploymentExecution(h).recover(context.operation.id)).rejects.toMatchObject({ code: "WALLET_DEPLOYMENT_DISPATCH_UNCERTAIN" });
    expect(h.experimentalTransport.broadcast).toHaveBeenCalledTimes(1);
  });
  it("keeps a lost send response unknown and never retries inside the same attempt", async () => {
    const h = harness(); h.experimentalTransport.broadcast.mockRejectedValue(new Error("provider secret URL"));
    const result = await createWalletDeploymentExecution(h).recover(context.operation.id);
    expect(result.dispatch).toBe("unknown"); expect(result.journal!.status).toBe("unknown");
    expect(h.experimentalTransport.broadcast).toHaveBeenCalledTimes(1);
  });
  it("bounds an unresponsive signer without persisting or dispatching its eventual candidate", async () => {
    const h = harness(); h.setClaimed(); h.signer.signTransaction.mockImplementation(() => new Promise(() => {}));
    await expect(createWalletDeploymentExecution({ ...h, signingTimeoutMs: 10 }).sign(context.operation.id))
      .rejects.toMatchObject({ code: "WALLET_DEPLOYMENT_SIGNING_TIMEOUT" });
    expect(h.store.persistSigned).not.toHaveBeenCalled(); expect(h.experimentalTransport.broadcast).not.toHaveBeenCalled();
  });
  it("sanitizes configured signer failures before returning an internal error", async () => {
    const h = harness(); h.setClaimed(); h.signer.signTransaction.mockRejectedValue(new Error("secret signer credentials"));
    await expect(createWalletDeploymentExecution(h).sign(context.operation.id)).rejects.toMatchObject({ code: "WALLET_DEPLOYMENT_SIGNING_UNAVAILABLE" });
    expect(h.store.persistSigned).not.toHaveBeenCalled();
  });
  it("does not pass caller-owned mutable frozen fields to the signer", async () => {
    const h = harness(); h.setClaimed();
    h.signer.signTransaction.mockImplementation(async transaction => {
      expect(transaction).toMatchObject({ nonce: 1, value: 0n, type: "eip1559", accessList: [] });
      expect(transaction).not.toHaveProperty("from");
      context.operation.template!.transaction.gas = "1";
      return deploymentFixtureSigner.signTransaction(transaction);
    });
    // The harness persists its fixture template from context. Changing it here makes read-back
    // mismatch and reject; the signer still received only the isolated original gas.
    await expect(createWalletDeploymentExecution(h).sign(context.operation.id)).rejects.toThrow();
    expect(h.signer.signTransaction.mock.calls[0]![0].gas).toBe(1500000n);
  });
  it.each(["pending", "unknown", "nonce-conflict", "reorged"] as const)("retains %s evidence without requesting local broadcast admission", async state => {
    const h = harness(); h.chain.observeSigned.mockImplementation(async () => {
      const observation = syntheticDeploymentObservation(context); observation.transaction.state = state;
      return observation;
    });
    const result = await createWalletDeploymentExecution(h).recover(context.operation.id);
    expect(result.dispatch).toBe("observed"); expect(h.experimentalTransport.admit).not.toHaveBeenCalled();
  });
  it.each(["transactionHash", "templateCommitment", "poolConfigurationDigest", "observationDigest"] as const)
    ("rejects substituted %s in local admission", field => {
      context.operation.observation = syntheticDeploymentObservation(context); const value = syntheticDeploymentAdmission(context);
      if (field === "transactionHash" || field === "templateCommitment") value[field] = `0x${"ff".repeat(32)}`;
      else value[field] = "f".repeat(64);
      expect(() => assertWalletDeploymentDispatchAdmission(value, context, value.observedAt)).toThrow();
    });
  it.each(["expired", "future", "oversized-window", "revision", "balance", "cost", "base-claim", "genesis", "head"])
    ("rejects %s local admission evidence", change => {
      context.operation.observation = syntheticDeploymentObservation(context); const value = syntheticDeploymentAdmission(context);
      const now = value.observedAt;
      if (change === "expired") value.expiresAt = now;
      if (change === "future") value.observedAt = now + 1;
      if (change === "oversized-window") value.expiresAt = now + 5001;
      if (change === "revision") value.operationRevision++;
      if (change === "balance") value.balanceWei = "1";
      if (change === "cost") value.maximumExecutionCost = "1";
      if (change === "base-claim") (value as any).baseTotalAffordability = "covered";
      if (change === "genesis") value.environment.genesisHash = `0x${"00".repeat(32)}`;
      if (change === "head") value.environment.head = { ...value.environment.head, blockNumber: "102" };
      expect(() => assertWalletDeploymentDispatchAdmission(value, context, now)).toThrow();
    });
  it("rejects accessors before reading caller admission fields and returns an isolated snapshot", () => {
    context.operation.observation = syntheticDeploymentObservation(context); const value = syntheticDeploymentAdmission(context);
    const getter = vi.fn(() => value.observedAt), hostile = { ...value };
    Object.defineProperty(hostile, "observedAt", { enumerable: true, get: getter });
    expect(() => assertWalletDeploymentDispatchAdmission(hostile, context, value.observedAt)).toThrow(); expect(getter).not.toHaveBeenCalled();
    const checked = assertWalletDeploymentDispatchAdmission(value, context, value.observedAt);
    value.environment.head.blockNumber = "999"; expect(checked.environment.head.blockNumber).toBe("101");
  });
  it("rejects dispatch based on a provider head below the retained observation watermark", () => {
    context.operation.observation = syntheticDeploymentObservation(context); context.operation.highestObservedHead = "102";
    const value = syntheticDeploymentAdmission(context);
    expect(() => assertWalletDeploymentDispatchAdmission(value, context, value.observedAt)).toThrow();
  });
});
