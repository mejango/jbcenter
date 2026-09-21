import { decodeEventLog, isAddress, keccak256, type Hex } from "viem";
import type { RestRpc } from "../core.js";
import type {
  SemanticVerifier,
  StoredPlan,
  StoredReceipt,
} from "../transactions/types.js";
import { FORWARDER_ABI, RELAYR_LIMITS } from "./constants.js";
import type { SponsorshipChain } from "./chain.js";
import type {
  DestinationObservation,
  PreparedForwardRequest,
  RelayrEntry,
  SponsorshipPolicy,
} from "./types.js";
import { hash, hex, object, quantity, same } from "./validation.js";
import { rpcHex } from "../protocol/code.js";

/** Exact outer call + inner forwarder execution + canonical receipt, before economic semantics. */
export async function observeDestination(options: {
  chain: SponsorshipChain;
  request: PreparedForwardRequest;
  entry: RelayrEntry;
  hint: { providerState: string; hash?: Hex };
  plan: StoredPlan;
  policy: SponsorshipPolicy;
  semanticVerifier?: SemanticVerifier;
  now: number;
}): Promise<DestinationObservation> {
  const { chain, request, entry, hint, plan, policy, now } = options;
  const base = {
    stepIndex: request.stepIndex,
    chainId: request.chainId,
    providerState: hint.providerState,
  };
  const call = plan.draft.calls[request.stepIndex];
  if (
    entry.chain !== request.chainId ||
    !same(entry.target, request.forwarder) ||
    !call ||
    call.chainId !== request.chainId ||
    !same(call.to, request.message.to) ||
    !same(call.data, request.message.data) ||
    call.value !== request.message.value ||
    !same(plan.draft.account, request.message.from)
  )
    return {
      ...base,
      state: "unknown",
      reason:
        "The quoted request does not match the original plan step and chain.",
    };
  if (!hint.hash)
    return {
      ...base,
      state: "pending",
      reason:
        "Provider status contains no independently verifiable destination hash.",
    };
  const txHash = hint.hash;
  const unknown = (reason: string): DestinationObservation => ({
    ...base,
    state: "unknown",
    hash: txHash,
    reason,
  });
  const [tx, rawReceipt, head] = await Promise.all([
    chain.request(request.chainId, "eth_getTransactionByHash", [txHash]),
    chain.request(request.chainId, "eth_getTransactionReceipt", [txHash]),
    chain.snapshot(request.chainId),
  ]);
  if (tx === null || rawReceipt === null)
    return {
      ...base,
      state: "pending",
      hash: txHash,
      reason:
        "The destination transaction is not yet mined on the configured chain.",
    };
  if (
    !object(tx) ||
    !object(rawReceipt) ||
    !hash(tx.hash) ||
    !same(tx.hash, txHash) ||
    typeof tx.to !== "string" ||
    !same(tx.to, entry.target) ||
    typeof tx.input !== "string" ||
    !same(tx.input, entry.data) ||
    quantity(tx.value, "transaction value").toString() !== entry.value ||
    (tx.chainId !== undefined &&
      quantity(tx.chainId, "transaction chain") !== BigInt(request.chainId)) ||
    !hash(rawReceipt.transactionHash) ||
    !same(rawReceipt.transactionHash, txHash) ||
    !hash(rawReceipt.blockHash) ||
    !hash(tx.blockHash) ||
    !same(rawReceipt.blockHash, tx.blockHash) ||
    typeof tx.from !== "string" ||
    !isAddress(tx.from) ||
    typeof rawReceipt.from !== "string" ||
    !isAddress(rawReceipt.from) ||
    !same(tx.from, rawReceipt.from) ||
    typeof rawReceipt.to !== "string" ||
    !same(rawReceipt.to, entry.target)
  )
    return unknown(
      "RPC transaction/receipt does not match the exact immutable forwarded call.",
    );
  const number = quantity(rawReceipt.blockNumber, "receipt block");
  if (
    quantity(tx.blockNumber, "transaction block") !== number ||
    quantity(tx.transactionIndex, "transaction index") !==
      quantity(rawReceipt.transactionIndex, "receipt transaction index")
  )
    return unknown("Transaction and receipt block positions do not match.");
  const block = await chain.request(request.chainId, "eth_getBlockByNumber", [
    hex(number),
    false,
  ]);
  if (
    !object(block) ||
    !hash(block.hash) ||
    !same(block.hash, rawReceipt.blockHash) ||
    quantity(block.number, "canonical block") !== number
  )
    return unknown("The receipt is not in the canonical chain.");
  const observed = {
    chainId: request.chainId,
    blockNumber: number.toString(),
    blockHash: rawReceipt.blockHash,
    timestamp: quantity(block.timestamp, "receipt timestamp").toString(),
    source: "onchain" as const,
  };
  const code = rpcHex(
    await chain.request(request.chainId, "eth_getCode", [
      request.forwarder,
      chain.tag(observed),
    ]),
    "Forwarder execution runtime",
  );
  if (keccak256(code) !== request.forwarderCodeHash)
    return unknown(
      "The forwarder runtime at execution does not match its reviewed implementation.",
    );
  if (
    !Array.isArray(rawReceipt.logs) ||
    rawReceipt.logs.length > 512 ||
    Buffer.byteLength(JSON.stringify(rawReceipt.logs)) >
      RELAYR_LIMITS.maximumBytes
  )
    return unknown("Receipt logs exceed the bounded verification limit.");
  const logIndexes = new Set<string>();
  for (const log of rawReceipt.logs) {
    if (
      !object(log) ||
      typeof log.address !== "string" ||
      !/^0x[0-9a-fA-F]{40}$/.test(log.address) ||
      !Array.isArray(log.topics) ||
      log.topics.length > 4 ||
      !log.topics.every(hash) ||
      typeof log.data !== "string" ||
      !/^0x(?:[0-9a-fA-F]{2})*$/.test(log.data) ||
      log.data.length > 262_146 ||
      log.removed === true ||
      !hash(log.transactionHash) ||
      !same(log.transactionHash, txHash) ||
      !hash(log.blockHash) ||
      !same(log.blockHash, rawReceipt.blockHash) ||
      quantity(log.blockNumber, "log block") !== number ||
      quantity(log.transactionIndex, "log transaction index") !==
        quantity(rawReceipt.transactionIndex, "receipt transaction index")
    )
      return unknown(
        "Receipt logs have inconsistent transaction or block identity.",
      );
    const logIndex = quantity(log.logIndex, "log index").toString();
    if (logIndexes.has(logIndex))
      return unknown("Receipt contains duplicate log positions.");
    logIndexes.add(logIndex);
  }
  const count =
    BigInt(head.blockNumber) >= number
      ? BigInt(head.blockNumber) - number + 1n
      : 0n;
  const confirmations = Number(count > 1024n ? 1024n : count);
  const status = quantity(rawReceipt.status, "receipt status");
  if (status !== 0n && status !== 1n)
    return unknown("The receipt status is invalid.");
  const receipt: StoredReceipt = {
    transactionHash: txHash,
    blockHash: rawReceipt.blockHash,
    blockNumber: number.toString(),
    status: status === 1n ? "success" : "reverted",
    confirmations,
    canonical: true,
    observedAt: now,
    logs: rawReceipt.logs,
  };
  await chain.canonical(observed);
  if (status === 0n)
    return {
      ...base,
      state: confirmations >= policy.confirmations ? "reverted" : "confirming",
      hash: txHash,
      receipt,
      semantic: {
        status: "failed",
        details: "The outer forwarding transaction reverted.",
      },
    };
  let matched = 0;
  for (const log of rawReceipt.logs) {
    if (!same(log.address, request.forwarder)) continue;
    try {
      const decoded = decodeEventLog({
        abi: FORWARDER_ABI,
        eventName: "ExecutedForwardRequest",
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data,
        strict: true,
      });
      if (
        same(decoded.args.signer, request.message.from) &&
        decoded.args.nonce.toString() === request.message.nonce &&
        decoded.args.success === true
      )
        matched++;
    } catch {
      /* Other events do not establish execution of this authorization. */
    }
  }
  if (matched !== 1)
    return unknown(
      "The receipt does not prove one successful execution of the exact signer and forwarding nonce.",
    );
  const rpc: RestRpc = {
    request: (chainId, method, params) =>
      chain.request(chainId, method, params),
  };
  const semantic = options.semanticVerifier
    ? await options.semanticVerifier.verify(
        plan,
        request.stepIndex,
        receipt,
        rpc,
      )
    : {
        status: "unknown" as const,
        details: "No operation-specific economic verifier is installed.",
      };
  return {
    ...base,
    state: confirmations >= policy.confirmations ? "confirmed" : "confirming",
    hash: txHash,
    receipt,
    semantic,
  };
}
