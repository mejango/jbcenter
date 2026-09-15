import { isDeepStrictEqual } from "node:util";
import { keccak256, toHex, type Hex } from "viem";
import { RestError, type RestBlockEvidence } from "../core.js";
import { enrollmentDigest } from "./enrollment.js";
import { verifyBaseReceiptFees, type BaseReceiptFees } from "./baseReceiptFees.js";
import type { operationRpc } from "./operationRpc.js";

function invalid(): never {
  throw new RestError(502, "WALLET_BASE_FEE_OBSERVATION_INVALID", "Base fee evidence must remain at the retained canonical inclusion block.");
}

/** Shared read-only step for Base creation and recovery accounting. The caller owns the bounded
 * operationRpc lifetime, including cancellation and the final check before consuming its output.
 * This establishes receipt consistency at the retained inclusion, not finality, deployed fork
 * qualification, sender authority, allocation coverage, settlement or permission to dispatch. */
export async function observeBaseReceiptFees(rpc: Pick<ReturnType<typeof operationRpc>, "request" | "check">,
  rawTransaction: Hex, input: RestBlockEvidence): Promise<BaseReceiptFees> {
  let inclusion: RestBlockEvidence;
  try {
    enrollmentDigest(input); inclusion = structuredClone(input);
    if (Object.keys(inclusion).length !== 5 || inclusion.chainId !== 8453 || inclusion.source !== "onchain" ||
        typeof inclusion.blockHash !== "string" || typeof inclusion.blockNumber !== "string" || typeof inclusion.timestamp !== "string" ||
        !/^0x[0-9a-f]{64}$/.test(inclusion.blockHash) || BigInt(inclusion.blockHash) === 0n ||
        !/^(0|[1-9][0-9]{0,77})$/.test(inclusion.blockNumber) || BigInt(inclusion.blockNumber) >= 1n << 256n ||
        !/^(0|[1-9][0-9]{0,77})$/.test(inclusion.timestamp) || BigInt(inclusion.timestamp) >= 1n << 256n ||
        typeof rawTransaction !== "string" || rawTransaction.length > 262_146 || !/^0x02(?:[0-9a-fA-F]{2})+$/.test(rawTransaction)) invalid();
  } catch { return invalid(); }
  const transactionHash = keccak256(rawTransaction), blockTag = toHex(BigInt(inclusion.blockNumber));
  rpc.check();
  const [chain, receipt, block] = await Promise.all([
    rpc.request("eth_chainId", []), rpc.request("eth_getTransactionReceipt", [transactionHash]),
    rpc.request("eth_getBlockByNumber", [blockTag, false]),
  ]);
  if (chain !== "0x2105" || !block || typeof block !== "object") invalid();
  // operationRpc already copied and bounded provider JSON without invoking accessors/proxies.
  const hashes = (block as Record<string, unknown>).transactions;
  if (!Array.isArray(hashes) || hashes.length < 2 || hashes.length > 4096 ||
      typeof hashes[0] !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hashes[0])) invalid();
  const attributes = await rpc.request("eth_getTransactionByHash", [hashes[0]]);
  const first = verifyBaseReceiptFees({ rawTransaction, block, receipt, attributes });
  if (first.blockHash !== inclusion.blockHash || first.blockNumber !== BigInt(inclusion.blockNumber) ||
      first.blockTimestamp !== BigInt(inclusion.timestamp)) invalid();
  const [chainAgain, receiptAgain, blockAgain] = await Promise.all([
    rpc.request("eth_chainId", []), rpc.request("eth_getTransactionReceipt", [transactionHash]),
    rpc.request("eth_getBlockByNumber", [blockTag, false]),
  ]);
  if (chainAgain !== "0x2105" || !isDeepStrictEqual(first,
    verifyBaseReceiptFees({ rawTransaction, block: blockAgain, receipt: receiptAgain, attributes }))) invalid();
  rpc.check();
  return first;
}
