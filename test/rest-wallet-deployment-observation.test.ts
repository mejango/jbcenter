import { expect, it } from "vitest";
import type { Hex } from "viem";
import type { RestBlockEvidence } from "../src/rest/core.js";
import { assertWalletDeploymentObservation, type WalletDeploymentObservation } from "../src/rest/wallet/deploymentObservation.js";

const hash = (byte: string): Hex => `0x${byte.repeat(64)}`;
const head: RestBlockEvidence = { chainId: 8453, blockNumber: "100", blockHash: hash("a"), timestamp: "1800000100", source: "onchain" };
const receiptBlock: RestBlockEvidence = { ...head, blockNumber: "99", blockHash: hash("b"), timestamp: "1800000099" };
const prior: RestBlockEvidence = { ...head, blockNumber: "98", blockHash: hash("c"), timestamp: "1800000098" };
function valid(): WalletDeploymentObservation {
  return { version: "center-wallet-deployment-observation-v1", operationId: "12345678-1234-4567-89ab-123456789abc",
    templateCommitment: hash("d"), transactionHash: hash("e"), observedAt: 1800000100100, head: structuredClone(head),
    transaction: { state: "canonical-success", reason: null, receipt: { block: structuredClone(receiptBlock), transactionIndex: "2",
      status: "success", gasUsed: "300000", effectiveGasPrice: "1000000", logCount: 5, logsHash: hash("f") }, conflict: null,
      nonce: { confirmed: "4", pending: "4" } },
    finality: { state: "finalized", evidence: structuredClone(head) },
    wallet: { state: "verified", address: "0x4444444444444444444444444444444444444444", initializerHash: hash("1"),
      stateHash: hash("2"), evidence: structuredClone(head), creationTransaction: hash("e"), reason: null },
    fees: { executionWei: "300000000000", l1Wei: null, operatorWei: null, totalWei: null }, dispatchEligible: false };
}
function unknownWallet(value: WalletDeploymentObservation) {
  value.wallet = { ...value.wallet, state: "unknown", stateHash: null, evidence: null, creationTransaction: null, reason: "history-unavailable" };
}
function transactionState(state: WalletDeploymentObservation["transaction"]["state"]): WalletDeploymentObservation {
  const value = valid();
  value.transaction.state = state;
  if (state === "canonical-revert") { value.transaction.receipt!.status = "reverted"; value.transaction.receipt!.logCount = 0; }
  else if (state !== "canonical-success") {
    value.transaction.receipt = null; value.transaction.reason = state;
    value.fees.executionWei = null; value.finality = { state: "unknown", evidence: null };
  }
  if (state === "nonce-conflict") value.transaction.conflict = { transactionHash: hash("3"), block: structuredClone(receiptBlock), transactionIndex: "2" };
  if (state === "unknown" || state === "reorged") { value.head = null; value.transaction.nonce = null; unknownWallet(value); }
  return value;
}
const reject = (value: unknown) => expect(() => assertWalletDeploymentObservation(value))
  .toThrowError(expect.objectContaining({ code: "WALLET_DEPLOYMENT_OBSERVATION_INVALID" }));

it("returns an isolated bounded copy without making an authority or dispatch claim", () => {
  const input = valid(), output = assertWalletDeploymentObservation(input);
  expect(output).toEqual(input); expect(output).not.toBe(input); expect(output.transaction.receipt).not.toBe(input.transaction.receipt);
  input.transaction.receipt!.gasUsed = "1"; output.wallet.reason = "mutated-copy";
  expect(output.transaction.receipt!.gasUsed).toBe("300000"); expect(input.wallet.reason).toBeNull();
  expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(16384); expect(output.dispatchEligible).toBe(false);
});

it.each(["not-observed", "pending", "canonical-success", "canonical-revert", "reorged", "nonce-conflict", "unknown"] as const)
  ("accepts coherent transaction state %s", state => {
    const value = transactionState(state); expect(assertWalletDeploymentObservation(value)).toEqual(value);
  });
it("accepts known unfinalized receipt only with a finalized anchor below its block", () => {
  const value = valid(); value.finality = { state: "unfinalized", evidence: structuredClone(prior) };
  expect(assertWalletDeploymentObservation(value)).toEqual(value);
});
it("accepts unknown finality without inventing anchor evidence", () => {
  const value = valid(); value.finality = { state: "unknown", evidence: null };
  expect(assertWalletDeploymentObservation(value)).toEqual(value);
});
it("keeps verified wallet readiness independent of a reverted treasury transaction", () => {
  const value = transactionState("canonical-revert"); value.wallet.creationTransaction = hash("5");
  expect(assertWalletDeploymentObservation(value)).toEqual(value);
});
it.each(["undeployed", "unknown"] as const)("accepts honest %s wallet evidence", state => {
  const value = valid(); unknownWallet(value);
  if (state === "undeployed") value.wallet = { ...value.wallet, state, reason: null, evidence: structuredClone(head) };
  expect(assertWalletDeploymentObservation(value)).toEqual(value);
});
it("accepts optional absent nonce and zero execution price without filling other Base fees", () => {
  const value = valid(); value.transaction.nonce = null; value.transaction.receipt!.effectiveGasPrice = "0"; value.fees.executionWei = "0";
  expect(assertWalletDeploymentObservation(value)).toEqual(value);
});

const invalidChanges: [string, (value: WalletDeploymentObservation) => void][] = [
  ["unknown version", v => { (v as any).version = "other"; }],
  ["non-v4 operation ID", v => { v.operationId = "12345678-1234-1567-89ab-123456789abc"; }],
  ["uppercase operation ID", v => { v.operationId = v.operationId.toUpperCase(); }],
  ["uppercase template hash", v => { v.templateCommitment = hash("D"); }],
  ["short transaction hash", v => { v.transactionHash = "0x01"; }],
  ["zero transaction hash", v => { v.transactionHash = hash("0"); }],
  ["zero observation clock", v => { v.observedAt = 0; }],
  ["fractional observation clock", v => { v.observedAt += 0.5; }],
  ["unsafe observation clock", v => { v.observedAt = Number.MAX_SAFE_INTEGER + 1; }],
  ["wrong chain", v => { v.head!.chainId = 1; }],
  ["wrong evidence source", v => { (v.head as any).source = "simulated"; }],
  ["noncanonical block quantity", v => { v.head!.blockNumber = "0100"; }],
  ["negative timestamp", v => { v.head!.timestamp = "-1"; }],
  ["receipt over uint256", v => { v.transaction.receipt!.gasUsed = String(1n << 256n); }],
  ["fee multiplication overflow", v => { v.transaction.receipt!.gasUsed = String((1n << 256n) - 1n); }],
  ["fractional transaction index", v => { v.transaction.receipt!.transactionIndex = "1.5"; }],
  ["negative log count", v => { v.transaction.receipt!.logCount = -1; }],
  ["oversized log count", v => { v.transaction.receipt!.logCount = 10001; }],
  ["uppercase log hash", v => { v.transaction.receipt!.logsHash = hash("F"); }],
  ["missing receipt for canonical success", v => { v.transaction.receipt = null; }],
  ["receipt status mismatch", v => { v.transaction.receipt!.status = "reverted"; }],
  ["reverted receipt retaining logs", v => { v.transaction.state = "canonical-revert"; v.transaction.receipt!.status = "reverted"; v.transaction.receipt!.logCount = 1; }],
  ["missing canonical head", v => { v.head = null; }],
  ["receipt after head", v => { v.transaction.receipt!.block.blockNumber = "101"; }],
  ["receipt on alternate chain", v => { v.transaction.receipt!.block.chainId = 1; }],
  ["equal-height conflicting hash", v => { v.transaction.receipt!.block.blockNumber = "100"; }],
  ["equal-height conflicting timestamp", v => { v.finality.evidence!.timestamp = "1800000099"; }],
  ["unknown finality with evidence", v => { v.finality.state = "unknown"; }],
  ["finalized without evidence", v => { v.finality.evidence = null; }],
  ["finalized anchor before receipt", v => { v.finality.evidence = structuredClone(prior); }],
  ["finalized anchor after head", v => { v.finality.evidence!.blockNumber = "101"; }],
  ["unfinalized without evidence", v => { v.finality = { state: "unfinalized", evidence: null }; }],
  ["unfinalized despite reached receipt", v => { v.finality = { state: "unfinalized", evidence: structuredClone(receiptBlock) }; }],
  ["verified wallet missing state hash", v => { v.wallet.stateHash = null; }],
  ["verified wallet missing evidence", v => { v.wallet.evidence = null; }],
  ["verified wallet missing creation transaction", v => { v.wallet.creationTransaction = null; }],
  ["wallet evidence below head", v => { v.wallet.evidence = structuredClone(receiptBlock); }],
  ["uppercase wallet address", v => { v.wallet.address = "0xabcdefabcdefabcdefabcdefabcdefabcdefABCDEF"; }],
  ["zero wallet address", v => { v.wallet.address = "0x0000000000000000000000000000000000000000"; }],
  ["unknown wallet with proof", v => { v.wallet.state = "unknown"; v.wallet.reason = "history-unavailable"; }],
  ["unknown wallet missing reason", v => { unknownWallet(v); v.wallet.reason = null; }],
  ["undeployed wallet with state hash", v => { v.wallet.state = "undeployed"; v.wallet.creationTransaction = null; }],
  ["undeployed wallet without head", v => { unknownWallet(v); v.wallet.state = "undeployed"; v.wallet.reason = null; }],
  ["execution fee mismatch", v => { v.fees.executionWei = "1"; }],
  ["missing execution fee", v => { v.fees.executionWei = null; }],
  ["invented L1 fee", v => { (v.fees as any).l1Wei = "0"; }],
  ["invented operator fee", v => { (v.fees as any).operatorWei = "0"; }],
  ["invented total fee", v => { (v.fees as any).totalWei = "300000000000"; }],
  ["invented dispatch permission", v => { (v as any).dispatchEligible = true; }],
  ["unsafe reason text", v => { v.transaction.reason = "RPC https://secret.example/?key=x"; }],
  ["oversized reason", v => { v.transaction.reason = "x".repeat(129); }],
  ["empty reason", v => { v.transaction.reason = ""; }],
  ["pending nonce below confirmed", v => { v.transaction.nonce!.pending = "3"; }],
  ["conflict on canonical transaction", v => { v.transaction.conflict = { transactionHash: hash("3"), block: structuredClone(receiptBlock), transactionIndex: "0" }; }],
];
it.each(invalidChanges)("rejects incoherent observation: %s", (_, mutate) => { const value = valid(); mutate(value); reject(value); });

it.each(["not-observed", "pending", "reorged", "nonce-conflict", "unknown"] as const)
  ("rejects receipt and execution charges attached to %s", state => {
    const value = transactionState(state); value.transaction.receipt = valid().transaction.receipt; value.fees.executionWei = valid().fees.executionWei;
    reject(value);
  });
it.each(["not-observed", "pending", "reorged", "nonce-conflict", "unknown"] as const)
  ("rejects finalized classification for %s", state => {
    const value = transactionState(state); value.finality = valid().finality; reject(value);
  });
it.each([
  ["missing conflict", (v: WalletDeploymentObservation) => { v.transaction.conflict = null; }],
  ["same transaction as conflict", (v: WalletDeploymentObservation) => { v.transaction.conflict!.transactionHash = v.transactionHash; }],
  ["conflict after head", (v: WalletDeploymentObservation) => { v.transaction.conflict!.block.blockNumber = "101"; }],
  ["conflict without head", (v: WalletDeploymentObservation) => { v.head = null; }],
] as const)("rejects nonce-conflict with %s", (_, mutate) => { const value = transactionState("nonce-conflict"); mutate(value); reject(value); });

it("rejects missing and extra fields at every object boundary", () => {
  const paths: string[][] = [[], ["head"], ["transaction"], ["transaction", "receipt"], ["transaction", "receipt", "block"],
    ["transaction", "nonce"], ["finality"], ["wallet"], ["fees"]];
  for (const path of paths) for (const action of ["add", "delete"] as const) {
    const value = valid(); let object: Record<string, unknown> = value as unknown as Record<string, unknown>;
    for (const key of path) object = object[key] as Record<string, unknown>;
    if (action === "add") object.extra = "ignored-field"; else delete object[Object.keys(object)[0]!];
    reject(value);
  }
});
it("rejects accessors, hidden properties, symbols, custom serialization, cycles and non-JSON types without evaluating them", () => {
  let touched = false;
  const getter = valid(); Object.defineProperty(getter.wallet, "reason", { enumerable: true, get() { touched = true; return null; } }); reject(getter);
  const hidden = valid(); Object.defineProperty(hidden.transaction, "extra", { value: 1, enumerable: false }); reject(hidden);
  const symbol = valid(); Object.defineProperty(symbol, Symbol("extra"), { value: 1, enumerable: true }); reject(symbol);
  const custom = valid(); Object.assign(custom.wallet, { toJSON() { touched = true; return {}; } }); reject(custom);
  const cycle = valid(); Object.assign(cycle.wallet, { extra: cycle }); reject(cycle);
  for (const invalid of [undefined, 1n, NaN, Infinity, [], new Uint8Array(1), new Date(), null]) reject(invalid);
  expect(touched).toBe(false);
});
it("rejects proxies at any depth before invoking any trap", () => {
  let trapped = false;
  const handler: ProxyHandler<object> = { getPrototypeOf() { trapped = true; throw new Error("trap"); },
    ownKeys() { trapped = true; throw new Error("trap"); }, get() { trapped = true; throw new Error("trap"); } };
  reject(new Proxy(valid(), handler));
  const nested = valid(); nested.wallet = new Proxy(nested.wallet, handler) as typeof nested.wallet; reject(nested);
  const { proxy, revoke } = Proxy.revocable(valid(), {}); revoke(); reject(proxy);
  expect(trapped).toBe(false);
});
it("rejects oversized reason strings without invoking custom serialization", () => {
  const value = valid(); value.transaction.reason = "x".repeat(17000); reject(value);
});
it("accepts ordinary null-prototype JSON objects and returns independent ordinary JSON", () => {
  const input = valid(); input.wallet = Object.assign(Object.create(null), input.wallet);
  expect(assertWalletDeploymentObservation(input)).toEqual(valid());
});
