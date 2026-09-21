// SPDX-License-Identifier: MIT
// FastLZ port copyright (c) 2025 Base. See stack/baseFees/Base-LICENSE.txt.
import { keccak256, parseTransaction, serializeTransaction, type Hex } from "viem";
import { RestError } from "../core.js";

export interface BaseFeeParameters {
  profile: "fjord-isthmus" | "fjord-jovian";
  l1BaseFee: bigint;
  l1BlobBaseFee: bigint;
  l1BaseFeeScalar: bigint;
  l1BlobBaseFeeScalar: bigint;
  operatorFeeScalar: bigint;
  operatorFeeConstant: bigint;
}
export interface BaseSignedFees {
  transactionHash: Hex;
  rawByteLength: number;
  fastLzLength: number;
  estimatedSizeScaled: bigint;
  l1FeeAtParameters: bigint;
  operatorMaximumAtParameters: bigint;
  executionMaximum: bigint;
  value: bigint;
  totalMaximumAtParameters: bigint;
  futureFeeCeiling: null;
}

const maximumBytes = 131_072;
const uint256 = (1n << 256n) - 1n;
const uint64 = (1n << 64n) - 1n;
const uint32 = (1n << 32n) - 1n;
const secp256k1Order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength")!.get!;
function invalid(): never {
  throw new RestError(400, "WALLET_BASE_FEE_INVALID", "Provide bounded canonical signed bytes and all explicit fee parameters.");
}
function amount(value: unknown, maximum = uint256): bigint {
  if (typeof value !== "bigint" || value < 0n || value > maximum) invalid();
  return value;
}
function add(a: bigint, b: bigint): bigint { return amount(a + b); }
function multiply(a: bigint, b: bigint): bigint { return amount(a * b); }
function fields(value: unknown, keys: readonly string[]): void {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== keys.length || keys.some(key => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return !descriptor || !("value" in descriptor) || !descriptor.enumerable;
      })) invalid();
}

/** FastLZ compressed length of exactly these bytes, without signature padding.
 * Port of base/base 9469da27403d6836634639b4899a6e4a0964720f
 * crates/common/flz/src/flz.rs. Source hashes and upstream licenses are retained in
 * stack/baseFees. The fixed input and hash-table bounds also bound memory and work. */
export function baseFastLzLength(bytes: Uint8Array): number {
  let length: number;
  try { length = typedArrayByteLength.call(bytes); } catch { return invalid(); }
  if (!(bytes instanceof Uint8Array) || length > maximumBytes) invalid();
  // Intrinsic length plus typed-array set avoids caller iterators, length accessors and species.
  const input = new Uint8Array(length), table = new Uint32Array(8192);
  input.set(bytes);
  const limit = Math.max(0, input.length - 13);
  const u24 = (index: number) => input[index]! | (input[index + 1]! << 8) | (input[index + 2]! << 16);
  const hash = (value: number) => (Math.imul(value, 2654435769) >>> 19) & 0x1fff;
  const literals = (length: number) => 33 * Math.floor(length / 32) + (length % 32 ? length % 32 + 1 : 0);
  const nextHash = (index: number) => { table[hash(u24(index))] = index; return index + 1; };
  let index = 2, anchor = 0, size = 0;
  while (index < limit) {
    let reference = 0;
    for (;;) {
      const sequence = u24(index), slot = hash(sequence);
      reference = table[slot]!;
      table[slot] = index;
      const distance = index - reference;
      if (index >= limit) break;
      index++;
      if (distance < 8192 && sequence === u24(reference)) break;
    }
    if (index >= limit) break;
    index--;
    if (index > anchor) size += literals(index - anchor);
    let length = 0, end = limit + 9 - (index + 3);
    while (length < end) {
      if (input[reference + 3 + length] !== input[index + 3 + length]) end = 0;
      length++;
    }
    const matched = length - 1;
    size += 3 * Math.floor(matched / 262) + (matched % 262 >= 6 ? 3 : 2);
    index = nextHash(nextHash(index + length));
    anchor = index;
  }
  return size + literals(input.length - anchor);
}

function envelope(raw: Hex): ReturnType<typeof parseTransaction> {
  if (typeof raw !== "string" || raw.length > maximumBytes * 2 + 2 || !/^0x02(?:[0-9a-fA-F]{2})+$/.test(raw)) invalid();
  const tx = parseTransaction(raw);
  if (tx.type !== "eip1559" || !Number.isSafeInteger(tx.chainId) || tx.chainId! < 1 ||
      !Number.isSafeInteger(tx.nonce) || tx.nonce! < 0 || (tx.yParity !== 0 && tx.yParity !== 1) ||
      typeof tx.r !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(tx.r) ||
      typeof tx.s !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(tx.s) ||
      BigInt(tx.r) <= 0n || BigInt(tx.r) >= secp256k1Order || BigInt(tx.s) <= 0n || BigInt(tx.s) > secp256k1Order / 2n ||
      (tx.to !== undefined && (typeof tx.to !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(tx.to))) ||
      (tx.data !== undefined && (typeof tx.data !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(tx.data)))) invalid();
  if (tx.accessList !== undefined) {
    if (!Array.isArray(tx.accessList) || tx.accessList.length > 256) invalid();
    let keys = 0;
    for (const item of tx.accessList) {
      if (!item || typeof item.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(item.address) ||
          !Array.isArray(item.storageKeys)) invalid();
      keys += item.storageKeys.length;
      if (keys > 1024 || item.storageKeys.some((key: unknown) => typeof key !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(key))) invalid();
    }
  }
  const canonical = serializeTransaction(tx, { r: tx.r, s: tx.s, yParity: tx.yParity });
  if (canonical.toLowerCase() !== raw.toLowerCase()) invalid();
  return tx;
}

/** Pure arithmetic for explicit parameters and original signed type-2 bytes. It checks envelope
 * shape, not signer authority, chain state, parameter provenance, balance or permission to dispatch.
 * Chain IDs other than Base are accepted for upstream differential vectors; callers must bind the
 * actual chain and exact durable operation independently. No finite future L1/operator fee ceiling
 * exists in a standard type-2 envelope. Unknown parameters must never be substituted with zero. */
export function calculateBaseSignedFees(input: { rawTransaction: Hex; parameters: BaseFeeParameters }): BaseSignedFees {
  try {
    fields(input, ["rawTransaction", "parameters"]);
    const p = input.parameters;
    fields(p, ["profile", "l1BaseFee", "l1BlobBaseFee", "l1BaseFeeScalar", "l1BlobBaseFeeScalar", "operatorFeeScalar", "operatorFeeConstant"]);
    if (p.profile !== "fjord-isthmus" && p.profile !== "fjord-jovian") invalid();
    amount(p.l1BaseFee); amount(p.l1BlobBaseFee); amount(p.l1BaseFeeScalar, uint32); amount(p.l1BlobBaseFeeScalar, uint32);
    amount(p.operatorFeeScalar, uint32); amount(p.operatorFeeConstant, uint64);
    const raw = input.rawTransaction, tx = envelope(raw);
    const gas = amount(tx.gas, uint64), maxFee = amount(tx.type === "eip1559" ? tx.maxFeePerGas ?? 0n : undefined);
    const priority = amount(tx.type === "eip1559" ? tx.maxPriorityFeePerGas ?? 0n : undefined), value = amount(tx.value ?? 0n);
    if (gas === 0n || priority > maxFee) invalid();
    const fastLzLength = baseFastLzLength(Buffer.from(raw.slice(2), "hex"));
    const estimated = BigInt(fastLzLength) * 836_500n - 42_585_600n;
    const estimatedSizeScaled = estimated > 100_000_000n ? estimated : 100_000_000n;
    const priceScaled = add(multiply(multiply(p.l1BaseFee, 16n), p.l1BaseFeeScalar), multiply(p.l1BlobBaseFee, p.l1BlobBaseFeeScalar));
    const l1FeeAtParameters = multiply(estimatedSizeScaled, priceScaled) / 1_000_000_000_000n;
    const operatorProduct = multiply(gas, p.operatorFeeScalar);
    const operatorMaximumAtParameters = add(p.profile === "fjord-jovian" ? multiply(operatorProduct, 100n) : operatorProduct / 1_000_000n,
      p.operatorFeeConstant);
    const executionMaximum = multiply(gas, maxFee);
    const totalMaximumAtParameters = add(add(add(value, executionMaximum), l1FeeAtParameters), operatorMaximumAtParameters);
    return { transactionHash: keccak256(raw), rawByteLength: (raw.length - 2) / 2, fastLzLength, estimatedSizeScaled,
      l1FeeAtParameters, operatorMaximumAtParameters, executionMaximum, value, totalMaximumAtParameters, futureFeeCeiling: null };
  } catch { return invalid(); }
}
