import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { verifyBaseReceiptFees } from "../src/rest/wallet/baseReceiptFees.js";

const vectors = JSON.parse(readFileSync(new URL("./fixtures/base-fee-receipts.json", import.meta.url), "utf8")) as {
  transactions: { hash: Hex; raw: Hex; block: { hash: Hex }; receipt: Record<string, unknown>; attributes: unknown;
    expected: { executionWei: string; l1Wei: string; totalWei: string } }[];
};
const invalid = { status: 502, code: "WALLET_BASE_RECEIPT_FEES_INVALID" };
const hash = (byte: string) => `0x${byte.repeat(32)}` as Hex;
const account = privateKeyToAccount(hash("22"));
const depositor = "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001";
const l1Block = "0x4200000000000000000000000000000000000015";
function attributesInput(scalar = 7n, constant = 11n): Hex {
  const bytes = Buffer.alloc(178);
  bytes.write("3db6be2b", 0, "hex");
  bytes.writeUInt32BE(1_000_000, 4);
  bytes.writeBigUInt64BE(1_000n, 60);
  bytes.writeUInt32BE(Number(scalar), 164);
  bytes.writeBigUInt64BE(constant, 168);
  bytes.writeUInt16BE(148, 176);
  return `0x${bytes.toString("hex")}`;
}
async function fixture(chainId = 8453) {
  const rawTransaction = await account.signTransaction({ type: "eip1559", chainId, nonce: 1, gas: 80_000n,
    maxFeePerGas: 100n, maxPriorityFeePerGas: 2n, to: account.address, value: 17n });
  const transactionHash = keccak256(rawTransaction), blockHash = hash("44"), attributesHash = hash("55");
  return { rawTransaction,
    block: { hash: blockHash, number: "0x100", timestamp: "0x200", baseFeePerGas: "0x46", transactions: [attributesHash, transactionHash] },
    receipt: { transactionHash, blockHash, blockNumber: "0x100", transactionIndex: "0x1", type: "0x2", status: "0x1",
      gasUsed: "0x5208", effectiveGasPrice: "0x48", l1Fee: toHex(1_600_000n) } as Record<string, unknown>,
    attributes: { hash: attributesHash, blockHash, blockNumber: "0x100", transactionIndex: "0x0", type: "0x7e",
      from: depositor, to: l1Block, input: attributesInput() } as Record<string, unknown> };
}

describe("Base receipt fee verification for exact signed bytes and explicit Jovian block attributes", () => {
  it.each(vectors.transactions)("matches observed Dwellir receipt $hash without omitted operator fields becoming assumptions", (vector: any) => {
    expect(vector.receipt).not.toHaveProperty("operatorFeeScalar");
    expect(vector.receipt).not.toHaveProperty("operatorFeeConstant");
    const result = verifyBaseReceiptFees({ rawTransaction: vector.raw, block: vector.block,
      receipt: vector.receipt, attributes: vector.attributes });
    expect(result).toMatchObject({ transactionHash: vector.hash, blockHash: vector.block.hash,
      executionWei: BigInt(vector.expected.executionWei), l1Wei: BigInt(vector.expected.l1Wei),
      operatorWei: 0n, totalWei: BigInt(vector.expected.totalWei),
      parameters: { operatorFeeScalar: 0n, operatorFeeConstant: 0n }, futureFeeCeiling: null });
  });
  it("charges nonzero operator fees on used gas after refund, not the signed gas limit", async () => {
    const input = await fixture();
    const result = verifyBaseReceiptFees(input);
    expect(result).toMatchObject({ executionWei: 1_512_000n, l1Wei: 1_600_000n, operatorWei: 14_700_011n,
      totalWei: 17_812_011n, status: "success", futureFeeCeiling: null });
  });
  it("retains all three fee components on a revert without charging reverted value", async () => {
    const input = await fixture(); input.receipt.status = "0x0";
    expect(verifyBaseReceiptFees(input)).toMatchObject({ status: "reverted", operatorWei: 14_700_011n,
      totalWei: 17_812_011n });
  });
  it("reports fees without claiming a net sender balance delta from receipts alone", async () => {
    // This successful transaction sends value to itself. More generally, a called contract can
    // also send ETH back, so fees plus envelope value cannot prove a sender's balance change.
    const result = verifyBaseReceiptFees(await fixture());
    expect(result.totalWei).toBe(17_812_011n);
    expect(result).not.toHaveProperty("senderDebitWei");
    expect(result).not.toHaveProperty("valueTransferredWei");
  });
  it("accepts explicit zero operator fees and independent scalar/constant boundaries", async () => {
    const input = await fixture();
    for (const [scalar, constant, expected] of [[0n, 0n, 0n], [0n, 11n, 11n], [7n, 0n, 14_700_000n],
      [(1n << 32n) - 1n, (1n << 64n) - 1n, 18_455_763_505_029_051_615n]]) {
      input.attributes.input = attributesInput(scalar, constant);
      expect(verifyBaseReceiptFees(input).operatorWei).toBe(expected);
    }
  });
  it("cross-checks optional provider fields when present", async () => {
    const input = await fixture();
    Object.assign(input.receipt, { l1GasPrice: toHex(1000n), l1BlobBaseFee: "0x0", l1BaseFeeScalar: toHex(1_000_000n),
      l1BlobBaseFeeScalar: "0x0", operatorFeeScalar: "0x7", operatorFeeConstant: "0xb",
      daFootprintGasScalar: "0x94", l1GasUsed: "0x640" });
    expect(verifyBaseReceiptFees(input).totalWei).toBe(17_812_011n);
    for (const key of ["l1GasPrice", "l1BlobBaseFee", "l1BaseFeeScalar", "l1BlobBaseFeeScalar", "operatorFeeScalar",
      "operatorFeeConstant", "daFootprintGasScalar", "l1GasUsed"]) {
      const bad = structuredClone(input); bad.receipt[key] = toHex(BigInt(bad.receipt[key] as Hex) + 1n);
      expect(() => verifyBaseReceiptFees(bad)).toThrowError(expect.objectContaining(invalid));
      bad.receipt[key] = null;
      expect(() => verifyBaseReceiptFees(bad)).toThrowError(expect.objectContaining(invalid));
    }
  });
  it.each(["l1Fee", "gasUsed", "effectiveGasPrice", "transactionHash", "blockHash", "blockNumber", "transactionIndex", "status", "type"])(
    "rejects missing receipt %s", async key => {
      const input = await fixture(); delete input.receipt[key];
      expect(() => verifyBaseReceiptFees(input)).toThrowError(expect.objectContaining(invalid));
    });
  it.each([
    ["l1Fee", "0x0"], ["gasUsed", "0x0"], ["gasUsed", "0x1"], ["gasUsed", toHex(80_001n)], ["gasUsed", toHex(1n << 64n)],
    ["effectiveGasPrice", "0x49"], ["effectiveGasPrice", "0x048"], ["status", "0x2"], ["type", "0x7e"],
    ["transactionHash", hash("66")], ["blockHash", hash("66")], ["blockNumber", "0x101"],
    ["transactionIndex", "0x0"], ["transactionIndex", "0x2"],
  ])("rejects contradictory receipt %s=%s", async (key, value) => {
    const input = await fixture(); input.receipt[key] = value;
    expect(() => verifyBaseReceiptFees(input)).toThrowError(expect.objectContaining(invalid));
  });
  it.each([
    ["from", account.address], ["to", account.address], ["type", "0x2"], ["hash", hash("66")],
    ["blockHash", hash("66")], ["blockNumber", "0x101"], ["transactionIndex", "0x1"],
    ["input", attributesInput().replace("3db6be2b", "440a5e20")], ["input", `${attributesInput()}00`],
    ["input", attributesInput().slice(0, -2)], ["input", "0x"],
  ])("rejects unknown or contradictory attributes %s", async (key, value) => {
    const input = await fixture(); input.attributes[key] = value;
    expect(() => verifyBaseReceiptFees(input)).toThrowError(expect.objectContaining(invalid));
  });
  it("requires the receipt and attributes transactions at their exact block positions", async () => {
    const input = await fixture();
    input.block.transactions.reverse();
    expect(() => verifyBaseReceiptFees(input)).toThrowError(expect.objectContaining(invalid));
    input.block.transactions.reverse(); input.block.transactions.push(input.block.transactions[0]!);
    expect(() => verifyBaseReceiptFees(input)).toThrowError(expect.objectContaining(invalid));
  });
  it("rejects a receipt hash at another index while the attributes remain valid", async () => {
    const input = await fixture(); input.block.transactions.splice(1, 0, hash("66"));
    expect(() => verifyBaseReceiptFees(input)).toThrowError(expect.objectContaining(invalid));
  });
  it.each(["hash", "number", "timestamp", "baseFeePerGas", "transactions"])("rejects missing block %s", async key => {
    const input = await fixture(); delete (input.block as Record<string, unknown>)[key];
    expect(() => verifyBaseReceiptFees(input)).toThrowError(expect.objectContaining(invalid));
  });
  it.each(["hash", "blockHash", "blockNumber", "transactionIndex", "type", "from", "to", "input"])("rejects missing attributes %s", async key => {
    const input = await fixture(); delete input.attributes[key];
    expect(() => verifyBaseReceiptFees(input)).toThrowError(expect.objectContaining(invalid));
  });
  it("rejects other chains and signatures that no longer match the receipt", async () => {
    const otherChain = await fixture(10);
    expect(() => verifyBaseReceiptFees(otherChain)).toThrowError(expect.objectContaining(invalid));
    const input = await fixture();
    input.rawTransaction = `${input.rawTransaction.slice(0, -2)}00` as Hex;
    expect(() => verifyBaseReceiptFees(input)).toThrowError(expect.objectContaining(invalid));
  });
  it("requires the signed cap to cover the inclusion base fee, and checks uint256 intermediates", async () => {
    const input = await fixture(); input.block.baseFeePerGas = "0x65";
    expect(() => verifyBaseReceiptFees(input)).toThrowError(expect.objectContaining(invalid));
    input.block.baseFeePerGas = "0x46";
    const data = Buffer.from(attributesInput().slice(2), "hex"); data.fill(255, 36, 68);
    input.attributes.input = `0x${data.toString("hex")}`;
    expect(() => verifyBaseReceiptFees(input)).toThrowError(expect.objectContaining(invalid));
  });
  it("rejects accessors and proxies without executing them, and bounds sparse or oversized transaction lists", async () => {
    const input = await fixture(); let calls = 0;
    Object.defineProperty(input.receipt, "l1Fee", { get() { calls++; return "0x0"; } });
    expect(() => verifyBaseReceiptFees(input)).toThrowError(expect.objectContaining(invalid));
    const clean = await fixture();
    clean.attributes = new Proxy(clean.attributes, { get() { calls++; return undefined; }, ownKeys() { calls++; return []; } });
    expect(() => verifyBaseReceiptFees(clean)).toThrowError(expect.objectContaining(invalid));
    expect(calls).toBe(0);
    for (const length of [3, 4097, 1_000_000_000]) {
      const bad = await fixture(); bad.block.transactions.length = length;
      expect(() => verifyBaseReceiptFees(bad)).toThrowError(expect.objectContaining(invalid));
    }
  });
});
