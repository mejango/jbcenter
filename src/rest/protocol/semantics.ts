import { createHash } from "node:crypto";
import {
  canonicalJson,
  jsonSafe,
  normalizePlanDraft,
  type PlanDraft,
  type PlanService,
  type OperationReceipt,
} from "@juicebox/mcp/host";
import { getAddress, isAddress, type Hex } from "viem";
import type {
  SemanticResult,
  SemanticVerifier,
  StoredReceipt,
} from "../transactions/types.js";

const unknown = (reason: string): SemanticResult => ({
  status: "unknown",
  details: { reason },
});
const hash = (value: unknown): value is Hex =>
  typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function quantity(value: unknown): bigint {
  if (typeof value === "bigint" && value >= 0n && value < 2n ** 256n)
    return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return BigInt(value);
  if (
    typeof value === "string" &&
    /^(?:0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)|0|[1-9][0-9]*)$/.test(value) &&
    value.length <= 78
  ) {
    const number = BigInt(value);
    if (number < 2n ** 256n) return number;
  }
  throw new Error("Invalid receipt quantity");
}
function index(value: unknown): number {
  const number = quantity(value);
  if (number > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Invalid receipt index");
  return Number(number);
}
function receiptFor(receipt: StoredReceipt): OperationReceipt {
  if (
    !hash(receipt.transactionHash) ||
    !hash(receipt.blockHash) ||
    receipt.logsStored === false ||
    !Array.isArray(receipt.logs) ||
    receipt.logs.length > 2048
  )
    throw new Error("Full receipt evidence unavailable");
  if (Buffer.byteLength(canonicalJson(jsonSafe(receipt.logs))) > 524288)
    throw new Error("Receipt logs exceed the evidence bound");
  const blockNumber = quantity(receipt.blockNumber);
  const logs: OperationReceipt["logs"] = receipt.logs.map((input) => {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Invalid receipt log");
    const log = input as Record<string, unknown>;
    if (
      typeof log.address !== "string" ||
      !isAddress(log.address) ||
      !hash(log.transactionHash) ||
      !hash(log.blockHash) ||
      !same(log.transactionHash, receipt.transactionHash) ||
      !same(log.blockHash, receipt.blockHash) ||
      quantity(log.blockNumber) !== blockNumber ||
      log.removed !== false ||
      typeof log.data !== "string" ||
      !/^0x(?:[0-9a-fA-F]{2})*$/.test(log.data) ||
      !Array.isArray(log.topics) ||
      log.topics.length > 4 ||
      !log.topics.every(hash)
    )
      throw new Error("Receipt log identity or encoding mismatch");
    return {
      address: getAddress(log.address),
      blockHash: log.blockHash,
      blockNumber,
      transactionHash: log.transactionHash,
      transactionIndex: index(log.transactionIndex),
      logIndex: index(log.logIndex),
      removed: false,
      data: log.data as Hex,
      topics: log.topics as [Hex, ...Hex[]],
    };
  });
  if (new Set(logs.map((log) => log.logIndex)).size !== logs.length)
    throw new Error("Duplicate receipt log index");
  return {
    status: receipt.status,
    transactionHash: receipt.transactionHash,
    blockHash: receipt.blockHash,
    blockNumber,
    logs,
  };
}

/** Reuses modeled MCP outcome checks after the host has independently proved exact execution. */
export function createProtocolSemanticVerifier({
  plans,
}: {
  plans: Pick<PlanService, "verifyOperationEvidence">;
}): SemanticVerifier {
  return {
    async verify(plan, stepIndex, receipt) {
      if (!Number.isSafeInteger(stepIndex) || !plan.draft.calls[stepIndex])
        return unknown("The planned step is absent.");
      if (!receipt.canonical)
        return unknown("The destination receipt is not canonical.");
      if (receipt.status !== "success")
        return {
          status: "failed",
          details: { reason: "The exact destination transaction reverted." },
        };
      if (
        ["contract_calls", "protocol-contract-calls"].includes(
          plan.draft.operation,
        )
      )
        return {
          status: "unmodeled",
          details: {
            reason:
              "Generic catalog calldata has no modeled business outcome verifier. Transaction confirmation alone does not establish its intended effects.",
          },
        };
      try {
        const draft = normalizePlanDraft({
          ...plan.draft,
          evidence: plan.draft.evidence.map((item) => ({
            ...item,
            source: "rpc",
          })),
        } as PlanDraft);
        const proof = plans.verifyOperationEvidence(
          draft,
          stepIndex,
          receiptFor(receipt),
        );
        const result: SemanticResult = {
          status: proof.verified ? "verified" : "unknown",
          details: {
            verifier: "juicebox-v6-modeled-operation",
            events: proof.events,
            ...(proof.reason ? { reason: proof.reason } : {}),
          },
        };
        const encoded = canonicalJson(jsonSafe(result));
        if (Buffer.byteLength(encoded) > 8192)
          return {
            status: "unknown",
            details: {
              reason:
                "The modeled evidence exceeds the 8 KiB persistence bound; inspect the full canonical receipt before treating the outcome as verified.",
              evidenceSha256: createHash("sha256")
                .update(encoded)
                .digest("hex"),
              eventCount: proof.events.length,
            },
          };
        return result;
      } catch {
        return unknown(
          "The validated plan or complete canonical receipt could not support modeled outcome verification.",
        );
      }
    },
  };
}
