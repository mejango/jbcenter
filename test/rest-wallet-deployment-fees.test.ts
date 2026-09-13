import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fromRlp, keccak256, serializeTransaction, toHex, toRlp, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseFastLzLength, calculateBaseSignedFees, type BaseFeeParameters } from "../src/rest/wallet/deploymentFees.js";

const account = privateKeyToAccount(`0x${"22".repeat(32)}`);
const parameters: BaseFeeParameters = { profile: "fjord-jovian", l1BaseFee: 1_000n, l1BlobBaseFee: 3n,
  l1BaseFeeScalar: 1_000_000n, l1BlobBaseFeeScalar: 2_000_000n, operatorFeeScalar: 7n, operatorFeeConstant: 11n };
const published = JSON.parse(readFileSync(new URL("../src/rest/wallet/stack/baseFees/base-vectors.json", import.meta.url), "utf8")) as {
  name: string; rawTransaction: Hex; l1BaseFee: string; l1BlobBaseFee: string; l1BaseFeeScalar: string;
  l1BlobBaseFeeScalar: string; expectedL1Fee: string; expectedFastLzLength?: string;
}[];
async function signed(data: Hex = "0x") {
  return account.signTransaction({ type: "eip1559", chainId: 8453, nonce: 0, gas: 21_000n, maxFeePerGas: 10n,
    maxPriorityFeePerGas: 1n, value: 17n, to: account.address, data, accessList: [] });
}
const invalid = { status: 400, code: "WALLET_BASE_FEE_INVALID" };
function changed(raw: Hex, index: number, value: unknown): Hex {
  const fields = fromRlp(`0x${raw.slice(4)}`) as unknown[];
  fields[index] = value;
  return `0x02${toRlp(fields as any).slice(2)}`;
}

describe("pure exact signed Base fee calculations without authority or future guarantees", () => {
  it.each(published)("matches primary Base published fee output $name", vector => {
    const result = calculateBaseSignedFees({ rawTransaction: vector.rawTransaction, parameters: {
      profile: "fjord-isthmus", l1BaseFee: BigInt(vector.l1BaseFee), l1BlobBaseFee: BigInt(vector.l1BlobBaseFee),
      l1BaseFeeScalar: BigInt(vector.l1BaseFeeScalar), l1BlobBaseFeeScalar: BigInt(vector.l1BlobBaseFeeScalar),
      operatorFeeScalar: 0n, operatorFeeConstant: 0n } });
    expect(result.l1FeeAtParameters).toBe(BigInt(vector.expectedL1Fee));
    if (vector.expectedFastLzLength !== undefined) expect(result.fastLzLength).toBe(Number(vector.expectedFastLzLength));
  });
  it("matches primary FastLZ outputs for short bytes and repeated input", () => {
    expect(baseFastLzLength(new Uint8Array())).toBe(0);
    expect(baseFastLzLength(Buffer.from("facade", "hex"))).toBe(4);
    expect(baseFastLzLength(new Uint8Array(1000))).toBe(21);
    expect(baseFastLzLength(new Uint8Array(1000).fill(42))).toBe(21);
  });
  it("prices the actual signed envelope and explicitly has no finite future fee ceiling", async () => {
    const rawTransaction = await signed(), result = calculateBaseSignedFees({ rawTransaction, parameters });
    expect(result).toMatchObject({ transactionHash: keccak256(rawTransaction), rawByteLength: (rawTransaction.length - 2) / 2,
      executionMaximum: 210_000n, value: 17n, operatorMaximumAtParameters: 14_700_011n, futureFeeCeiling: null });
    expect(result.fastLzLength).toBe(baseFastLzLength(Buffer.from(rawTransaction.slice(2), "hex")));
    expect(result.totalMaximumAtParameters).toBe(17n + 210_000n + result.l1FeeAtParameters + 14_700_011n);
  });
  it("distinguishes Isthmus floor division from Jovian multiplication", async () => {
    const rawTransaction = await signed();
    expect(calculateBaseSignedFees({ rawTransaction, parameters: { ...parameters, profile: "fjord-isthmus" } }).operatorMaximumAtParameters).toBe(11n);
    expect(calculateBaseSignedFees({ rawTransaction, parameters }).operatorMaximumAtParameters).toBe(14_700_011n);
  });
  it("accepts every explicitly observed zero while retaining execution value", async () => {
    const rawTransaction = await signed();
    const p = { ...parameters, l1BaseFee: 0n, l1BlobBaseFee: 0n, l1BaseFeeScalar: 0n, l1BlobBaseFeeScalar: 0n,
      operatorFeeScalar: 0n, operatorFeeConstant: 0n };
    expect(calculateBaseSignedFees({ rawTransaction, parameters: p })).toMatchObject({ l1FeeAtParameters: 0n,
      operatorMaximumAtParameters: 0n, totalMaximumAtParameters: 210_017n, futureFeeCeiling: null });
  });
  it.each(Object.keys(parameters))("rejects a missing %s instead of assuming zero or a previous fork", async key => {
    const rawTransaction = await signed();
    const p = { ...parameters } as any; delete p[key];
    expect(() => calculateBaseSignedFees({ rawTransaction, parameters: p })).toThrowError(expect.objectContaining(invalid));
  });
  it.each([
    ["profile", "fjord"], ["l1BaseFee", undefined], ["l1BaseFee", 0], ["l1BaseFee", "0"],
    ["l1BaseFee", -1n], ["l1BaseFee", 1n << 256n], ["l1BlobBaseFee", 1n << 256n],
    ["l1BaseFeeScalar", 1n << 32n], ["l1BlobBaseFeeScalar", 1n << 32n],
    ["operatorFeeScalar", 1n << 32n], ["operatorFeeConstant", 1n << 64n],
  ])("rejects invalid explicit parameter %s=%s", async (key, value) => {
    const rawTransaction = await signed();
    expect(() => calculateBaseSignedFees({ rawTransaction, parameters: { ...parameters, [key as string]: value } as any }))
      .toThrowError(expect.objectContaining(invalid));
  });
  it("rejects accessors, extra keys and hidden fields before invoking caller code", async () => {
    const rawTransaction = await signed(); let calls = 0;
    const p = { ...parameters }; Object.defineProperty(p, "l1BaseFee", { get() { calls++; return 0n; } });
    expect(() => calculateBaseSignedFees({ rawTransaction, parameters: p })).toThrowError(expect.objectContaining(invalid));
    expect(calls).toBe(0);
    expect(() => calculateBaseSignedFees({ rawTransaction, parameters, secret: "no" } as any)).toThrow();
    expect(() => calculateBaseSignedFees({ rawTransaction, parameters: { ...parameters, [Symbol("extra")]: 0 } })).toThrow();
    expect(() => calculateBaseSignedFees({ rawTransaction, parameters: Object.create(parameters) })).toThrow();
  });
  it("rejects checked uint256 intermediate overflow before division can hide it", async () => {
    const rawTransaction = await signed();
    for (const p of [
      { ...parameters, l1BaseFee: (1n << 256n) - 1n },
      { ...parameters, l1BaseFee: 1n << 230n, l1BaseFeeScalar: 1n },
      { ...parameters, l1BaseFee: 0n, l1BlobBaseFee: 1n << 255n, l1BlobBaseFeeScalar: 2n },
    ]) expect(() => calculateBaseSignedFees({ rawTransaction, parameters: p })).toThrowError(expect.objectContaining(invalid));
  });
  it("uses integer floor for fractional L1 and Isthmus operator fees", async () => {
    const rawTransaction = await signed();
    const result = calculateBaseSignedFees({ rawTransaction, parameters: { ...parameters, profile: "fjord-isthmus",
      l1BaseFee: 1n, l1BlobBaseFee: 1n, l1BaseFeeScalar: 1n, l1BlobBaseFeeScalar: 1n, operatorFeeScalar: 49n,
      operatorFeeConstant: 0n } });
    expect(result.l1FeeAtParameters).toBe(0n);
    expect(result.operatorMaximumAtParameters).toBe(1n);
  });
  it("handles uint32/uint64 parameter boundaries exactly", async () => {
    const rawTransaction = await signed(), scalar = (1n << 32n) - 1n, constant = (1n << 64n) - 1n;
    const result = calculateBaseSignedFees({ rawTransaction, parameters: { ...parameters,
      operatorFeeScalar: scalar, operatorFeeConstant: constant } });
    expect(result.operatorMaximumAtParameters).toBe(18_455_763_505_029_051_615n);
  });
  it("bounds raw compression before allocation and accepts the exact maximum", () => {
    expect(() => baseFastLzLength(new Uint8Array(131_073))).toThrowError(expect.objectContaining(invalid));
    expect(() => baseFastLzLength([1, 2, 3] as any)).toThrow();
    const data = new Uint8Array(131_072).fill(42);
    expect(baseFastLzLength(data)).toBeGreaterThan(0);
    expect(baseFastLzLength(data)).toBeLessThan(data.length);
    expect(data[0]).toBe(42);
  });
  it("copies bounded typed-array slots without executing caller iterators or shadowed lengths", () => {
    let iteratorCalls = 0, lengthCalls = 0;
    const input = Buffer.from("facade", "hex");
    Object.defineProperty(input, Symbol.iterator, { value() { iteratorCalls++; throw new Error("Caller iterator ran"); } });
    Object.defineProperty(input, "byteLength", { get() { lengthCalls++; return 0; } });
    expect(baseFastLzLength(input)).toBe(4);
    expect(iteratorCalls).toBe(0); expect(lengthCalls).toBe(0);
    const oversized = new Uint8Array(131_073);
    Object.defineProperty(oversized, "byteLength", { value: 0 });
    expect(() => baseFastLzLength(oversized)).toThrowError(expect.objectContaining(invalid));
  });
  it("rejects unsigned, unsupported, byte-misaligned and oversized raw envelopes", async () => {
    const raw = await signed();
    for (const rawTransaction of ["0x", "0x02", `${raw}0`, `0x01${raw.slice(4)}`, `0x02${"00".repeat(131_072)}`,
      serializeTransaction({ type: "eip1559", chainId: 8453, nonce: 0, gas: 21_000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n })])
      expect(() => calculateBaseSignedFees({ rawTransaction: rawTransaction as Hex, parameters })).toThrowError(expect.objectContaining(invalid));
  });
  it.each([
    [0, "0x"], [1, "0x00"], [4, "0x"], [4, "0x010000000000000000"],
    [2, "0x0b"], [9, "0x02"], [10, "0x"], [11, "0x"],
    [11, toHex(0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n / 2n + 1n)],
    [8, [[account.address, [[]]]]], [5, []],
  ])("rejects invalid or noncanonical signed scalar/list field %s", async (index, value) => {
    const rawTransaction = changed(await signed(), index as number, value);
    expect(() => calculateBaseSignedFees({ rawTransaction, parameters })).toThrowError(expect.objectContaining(invalid));
  });
  it("bounds execution and total costs instead of wrapping arithmetic", async () => {
    const raw = await signed();
    expect(() => calculateBaseSignedFees({ rawTransaction: changed(raw, 3, toHex((1n << 256n) - 1n)), parameters })).toThrow();
    expect(() => calculateBaseSignedFees({ rawTransaction: changed(raw, 6, toHex((1n << 256n) - 1n)), parameters })).toThrow();
  });
  it("includes canonical zero fee fields and preserves raw-byte identity across hex casing", async () => {
    const rawTransaction = await account.signTransaction({ type: "eip1559", chainId: 8453, nonce: 0, gas: 21_000n,
      maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, value: 0n, to: account.address });
    const result = calculateBaseSignedFees({ rawTransaction, parameters });
    expect(result.executionMaximum).toBe(0n);
    expect(calculateBaseSignedFees({ rawTransaction: `0x${rawTransaction.slice(2).toUpperCase()}`, parameters })).toEqual(result);
    expect(() => calculateBaseSignedFees({ rawTransaction: changed(rawTransaction, 3, "0x00"), parameters })).toThrow();
  });
});
