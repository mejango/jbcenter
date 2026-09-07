import {
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type AccessList,
  type Hex,
  type TransactionSerialized,
} from "viem";
import { RestError, type RestCall } from "../core.js";
import type { RelayPolicy, SignedAttempt } from "./types.js";

const SECP256K1_ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export type ValidatedSignedTransaction = Omit<
  SignedAttempt,
  "reservedAt" | "leaseToken" | "leaseUntil" | "dispatchCount"
> & {
  priorityFeePerGas?: bigint;
  gasPrice?: bigint;
  accessList?: AccessList;
};

/** Decode and recover locally. Unsupported envelopes never reach a relay RPC. */
export async function validateSignedTransaction(
  raw: Hex,
  call: RestCall,
  account: string,
  policy: RelayPolicy,
): Promise<ValidatedSignedTransaction> {
  if (
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(raw) ||
    (raw.length - 2) / 2 > policy.maximumRawBytes
  ) {
    throw new RestError(
      400,
      "INVALID_SIGNED_TRANSACTION",
      "Provide a bounded, byte-aligned signed transaction.",
    );
  }
  let tx: ReturnType<typeof parseTransaction>;
  try {
    tx = parseTransaction(raw);
  } catch {
    throw new RestError(
      400,
      "INVALID_SIGNED_TRANSACTION",
      "The signed transaction cannot be decoded.",
    );
  }
  if (tx.type !== "legacy" && tx.type !== "eip2930" && tx.type !== "eip1559") {
    throw new RestError(
      422,
      "UNSUPPORTED_TRANSACTION_TYPE",
      "Relay supports EIP-155 protected legacy, EIP-2930, and EIP-1559 transactions; blob and EIP-7702 envelopes are excluded.",
    );
  }
  if (
    !tx.chainId ||
    tx.chainId !== call.chainId ||
    !Number.isSafeInteger(tx.nonce) ||
    tx.nonce! < 0
  ) {
    throw new RestError(
      400,
      "TRANSACTION_CHAIN_OR_NONCE_MISMATCH",
      "The signature must protect the planned chain and a safely representable nonce.",
    );
  }
  if (
    !tx.r ||
    !tx.s ||
    BigInt(tx.r) <= 0n ||
    BigInt(tx.r) >= SECP256K1_ORDER ||
    BigInt(tx.s) <= 0n ||
    BigInt(tx.s) > SECP256K1_ORDER / 2n
  ) {
    throw new RestError(
      400,
      "INVALID_TRANSACTION_SIGNATURE",
      "A canonical low-s transaction signature is required.",
    );
  }
  let sender: Awaited<ReturnType<typeof recoverTransactionAddress>>;
  try {
    sender = await recoverTransactionAddress({
      serializedTransaction: raw as TransactionSerialized,
    });
  } catch {
    throw new RestError(
      400,
      "INVALID_TRANSACTION_SIGNATURE",
      "The transaction signer could not be recovered.",
    );
  }
  if (
    sender.toLowerCase() !== account.toLowerCase() ||
    tx.to?.toLowerCase() !== call.to.toLowerCase() ||
    (tx.data ?? "0x").toLowerCase() !== call.data.toLowerCase() ||
    (tx.value ?? 0n) !== BigInt(call.value)
  ) {
    throw new RestError(
      409,
      "SIGNED_PLAN_MISMATCH",
      "The signed sender, destination, calldata, and native value must exactly match the immutable plan.",
    );
  }
  const gas = tx.gas ?? 0n;
  const maximumFeePerGas =
    tx.type === "eip1559" ? tx.maxFeePerGas : tx.gasPrice;
  if (
    gas <= 0n ||
    gas > policy.maximumGas ||
    maximumFeePerGas === undefined ||
    maximumFeePerGas < 0n ||
    maximumFeePerGas > policy.maximumFeePerGas
  ) {
    throw new RestError(
      422,
      "TRANSACTION_FEE_BOUND",
      "The signed gas limit or fee cap exceeds relay policy.",
    );
  }
  if (
    tx.type === "eip1559" &&
    (tx.maxPriorityFeePerGas === undefined ||
      tx.maxPriorityFeePerGas < 0n ||
      tx.maxPriorityFeePerGas > maximumFeePerGas)
  ) {
    throw new RestError(
      400,
      "INVALID_FEE_ENVELOPE",
      "The priority fee must not exceed the signed maximum fee.",
    );
  }
  if (
    "accessList" in tx &&
    tx.accessList &&
    (tx.accessList.length > 256 ||
      tx.accessList.reduce((n, item) => n + item.storageKeys.length, 0) > 1024)
  ) {
    throw new RestError(
      422,
      "ACCESS_LIST_BOUND",
      "The signed access list exceeds relay policy.",
    );
  }
  const maximumCost = (tx.value ?? 0n) + gas * maximumFeePerGas;
  if (maximumCost > policy.maximumTransactionCost)
    throw new RestError(
      422,
      "TRANSACTION_COST_BOUND",
      "The signed native value and execution-gas envelope exceeds relay policy.",
    );
  return {
    hash: keccak256(raw),
    rawTransaction: raw,
    sender,
    chainId: call.chainId,
    nonce: String(tx.nonce),
    type: tx.type,
    gas: gas.toString(),
    maximumFeePerGas: maximumFeePerGas.toString(),
    maximumCost: maximumCost.toString(),
    ...(tx.type === "eip1559"
      ? { priorityFeePerGas: tx.maxPriorityFeePerGas! }
      : { gasPrice: tx.gasPrice! }),
    ...("accessList" in tx && tx.accessList
      ? { accessList: tx.accessList }
      : {}),
  };
}
