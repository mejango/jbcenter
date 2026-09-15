import { isProxy } from "node:util/types";
import { parseTransaction, type Hex } from "viem";
import { RestError } from "../core.js";
import { calculateBaseSignedFees, type BaseFeeParameters } from "./deploymentFees.js";

export interface BaseReceiptFeeInput {
  rawTransaction: Hex;
  block: unknown;
  receipt: unknown;
  attributes: unknown;
}
export interface BaseReceiptFees {
  profile: "base-fjord-jovian-receipt-v1";
  transactionHash: Hex;
  blockHash: Hex;
  blockNumber: bigint;
  blockTimestamp: bigint;
  transactionIndex: bigint;
  status: "success" | "reverted";
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  parameters: BaseFeeParameters;
  daFootprintGasScalar: bigint;
  executionWei: bigint;
  l1Wei: bigint;
  operatorWei: bigint;
  /** Fees only. Receipt data cannot establish net sender balance changes through internal calls. */
  totalWei: bigint;
  futureFeeCeiling: null;
}

const uint256 = (1n << 256n) - 1n;
const uint64 = (1n << 64n) - 1n;
function invalid(): never {
  throw new RestError(502, "WALLET_BASE_RECEIPT_FEES_INVALID", "Base receipt fees require matching signed bytes, block positions and explicit Jovian attributes.");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  return value as Record<string, unknown>;
}
/** Read only the fields relevant to fees. Other ordinary RPC fields (logs, bloom, etc.) are not
 * evidence for this calculation. Never run caller accessors or proxy traps. */
function field(value: Record<string, unknown>, key: string, optional = false): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor && optional) return undefined;
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
  if (optional && descriptor.value === undefined) invalid();
  return descriptor.value;
}
function quantity(value: unknown, maximum = uint256): bigint {
  if (typeof value !== "string" || value.length > 66 || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) invalid();
  const result = BigInt(value); if (result > maximum) invalid(); return result;
}
function checked(value: bigint): bigint { if (value < 0n || value > uint256) invalid(); return value; }
function hash(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value) || BigInt(value) === 0n) invalid();
  return value.toLowerCase() as Hex;
}
function address(value: unknown, expected: string): void {
  if (typeof value !== "string" || value.length !== 42 || value.toLowerCase() !== expected) invalid();
}
function transactionHashes(value: unknown): Hex[] {
  if (!value || typeof value !== "object" || isProxy(value) || !Array.isArray(value)) invalid();
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 2 || length > 4096) invalid();
  const hashes: Hex[] = [], seen = new Set<Hex>();
  for (let index = 0; index < length; index++) {
    const item = hash(field(value as unknown as Record<string, unknown>, String(index)));
    if (seen.has(item)) invalid();
    seen.add(item); hashes.push(item);
  }
  return hashes;
}

/** Pure consistency and fee arithmetic, NOT RPC provenance, canonicality, fork qualification,
 * signer authority, treasury settlement or dispatch permission. The production observer must
 * independently bind its exact durable operation and recheck the canonical inclusion block.
 *
 * This explicit profile supports only the 178-byte Jovian L1-attributes deposit. Its full
 * parameters are mandatory even when a provider omits operator fields from the receipt.
 * L1 pricing uses the original signed envelope; operator pricing uses gas actually charged,
 * after execution refunds. The pinned Base sources in stack/baseFees document both equations.
 * Missing/mismatched evidence throws; it never supplies zero, a prior profile or a future cap. */
export function verifyBaseReceiptFees(input: BaseReceiptFeeInput): BaseReceiptFees {
  try {
    const v = object(input), block = object(field(v, "block")), receipt = object(field(v, "receipt")),
      attributes = object(field(v, "attributes"));
    const blockHash = hash(field(block, "hash")), blockNumber = quantity(field(block, "number")),
      blockTimestamp = quantity(field(block, "timestamp")), baseFee = quantity(field(block, "baseFeePerGas"));
    const hashes = transactionHashes(field(block, "transactions"));
    function position(value: Record<string, unknown>): bigint {
      if (hash(field(value, "blockHash")) !== blockHash || quantity(field(value, "blockNumber")) !== blockNumber) invalid();
      return quantity(field(value, "transactionIndex"), BigInt(hashes.length - 1));
    }
    if (position(attributes) !== 0n || hash(field(attributes, "hash")) !== hashes[0] || quantity(field(attributes, "type")) !== 126n) invalid();
    address(field(attributes, "from"), "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001");
    address(field(attributes, "to"), "0x4200000000000000000000000000000000000015");
    const data = field(attributes, "input");
    if (typeof data !== "string" || data.length !== 358 || !/^0x3db6be2b[0-9a-fA-F]+$/i.test(data)) invalid();
    const uint = (start: number, end: number) => BigInt(`0x${data.slice(2 + start * 2, 2 + end * 2)}`);
    const parameters: BaseFeeParameters = { profile: "fjord-jovian", l1BaseFeeScalar: uint(4, 8), l1BlobBaseFeeScalar: uint(8, 12),
      l1BaseFee: uint(36, 68), l1BlobBaseFee: uint(68, 100), operatorFeeScalar: uint(164, 168), operatorFeeConstant: uint(168, 176) };
    const daFootprintGasScalar = uint(176, 178);
    const raw = field(v, "rawTransaction") as Hex;
    const calculated = calculateBaseSignedFees({ rawTransaction: raw, parameters });
    const tx = parseTransaction(raw);
    if (tx.type !== "eip1559" || tx.chainId !== 8453) invalid();
    const transactionHash = hash(field(receipt, "transactionHash")), transactionIndex = position(receipt);
    if (transactionIndex === 0n || transactionHash !== hashes[Number(transactionIndex)] ||
        transactionHash !== calculated.transactionHash || quantity(field(receipt, "type")) !== 2n) invalid();
    const status = quantity(field(receipt, "status")); if (status !== 0n && status !== 1n) invalid();
    const gasUsed = quantity(field(receipt, "gasUsed"), uint64), effectiveGasPrice = quantity(field(receipt, "effectiveGasPrice"));
    const feeCap = tx.maxFeePerGas ?? 0n, price = checked(baseFee + (tx.maxPriorityFeePerGas ?? 0n));
    // Type-2 intrinsic gas is at least 21000; the EIP-3529 refund cannot exceed one fifth.
    if (tx.gas! < 21_000n || gasUsed < 16_800n || gasUsed > tx.gas! || baseFee > feeCap ||
        effectiveGasPrice !== (price < feeCap ? price : feeCap)) invalid();
    const executionWei = checked(gasUsed * effectiveGasPrice), l1Wei = quantity(field(receipt, "l1Fee"));
    if (l1Wei !== calculated.l1FeeAtParameters) invalid();
    const operatorWei = checked(checked(gasUsed * parameters.operatorFeeScalar * 100n) + parameters.operatorFeeConstant);
    const optionalFields = { l1GasPrice: parameters.l1BaseFee, l1BlobBaseFee: parameters.l1BlobBaseFee,
      l1BaseFeeScalar: parameters.l1BaseFeeScalar, l1BlobBaseFeeScalar: parameters.l1BlobBaseFeeScalar,
      operatorFeeScalar: parameters.operatorFeeScalar, operatorFeeConstant: parameters.operatorFeeConstant,
      daFootprintGasScalar, l1GasUsed: calculated.estimatedSizeScaled * 16n / 1_000_000n };
    for (const [key, expected] of Object.entries(optionalFields)) {
      const value = field(receipt, key, true);
      if (value !== undefined && quantity(value) !== expected) invalid();
    }
    const totalWei = checked(checked(executionWei + l1Wei) + operatorWei);
    return { profile: "base-fjord-jovian-receipt-v1", transactionHash, blockHash, blockNumber, blockTimestamp, transactionIndex,
      status: status === 1n ? "success" : "reverted", gasUsed, effectiveGasPrice, parameters, daFootprintGasScalar,
      executionWei, l1Wei, operatorWei, totalWei, futureFeeCeiling: null };
  } catch { return invalid(); }
}
