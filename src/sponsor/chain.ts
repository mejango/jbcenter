import {
  BaseError,
  ContractFunctionRevertedError,
  ExecutionRevertedError,
  HttpRequestError,
  parseAbi,
  RpcRequestError,
  type Address,
  type Hex,
  type TransactionSerializableEIP1559,
  type TypedDataDefinition,
} from "viem";
import { DeploymentVerificationError } from "../deploymentVerifier.js";
import { RestError } from "../rest/core.js";
import { RelayrResponseError } from "../rest/sponsorship/provider.js";
import { scrub } from "../rest/sponsorship/validation.js";
import { ConflictError } from "../store.js";
import type { Intent, RelayRequest } from "../types.js";

export { CREATE_TOPIC } from "../deploymentVerifier.js";

export const PROJECTS_ABI = parseAbi(["function creationFee() view returns (uint256)"]);

const ERROR_LIMIT = 300;

/** A lane failure whose text is authored here, safe to show a caller. A coded one
 * publishes its code on the row and keeps its sentence for the operator log. */
export class LaneError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

/**
 * Lane failures are published by `GET /v1/intents/:id`, and upstream exceptions carry
 * request URLs with the RPC key and signed payload bytes. Only authored text, error
 * codes and fixed phrases survive.
 */
export function laneErrorMessage(error: unknown): string {
  return scrub(describeError(error), ERROR_LIMIT) || "lane error";
}

/** The same failure as the operator reads it: a coded lane error keeps its sentence. */
export function laneEventMessage(error: unknown): string {
  if (error instanceof LaneError && error.code) return scrub(error.message, ERROR_LIMIT) || error.code;
  if (error instanceof RelayrResponseError)
    return `relayr request failed, relayr status ${error.responseDetails.status}`;
  return laneErrorMessage(error);
}

/** The bounded, scrubbed body a coded provider failure carried, for the operator log. */
export function laneErrorDetail(error: unknown): string | undefined {
  return error instanceof RestError && typeof error.details === "string" ? error.details : undefined;
}

export type LaneOutcome = "retry" | "terminal";

/**
 * Codes worth another claim when the sponsor has spent nothing yet. The three transport
 * and parse codes are the bare ones the provider raises when no response exists to wrap.
 * An empty or off-hash Safe factory runtime is an answer about the node, not the chain:
 * the canonical factory is deployed everywhere Center sponsors.
 */
const RETRY_UNPAID = new Set([
  "SPONSORSHIP_RPC_UNAVAILABLE",
  "RELAYR_TIMEOUT",
  "SPONSOR_UNFUNDED",
  "RELAYR_UNAVAILABLE",
  "RELAYR_INVALID_RESPONSE",
  "RELAYR_RESPONSE_LIMIT",
  "SAFE_FACTORY_UNAVAILABLE",
]);

/**
 * Whether a lane failure retires the claimed rows or leaves them waiting. A paid bundle
 * is retired only by a definitive answer: anything the execution service, a node or a
 * parser could not say for certain leaves it waiting. Nothing paid retires on a
 * definitive answer too, and on anything outside the codes worth another claim.
 */
export function laneOutcome(error: unknown, context: { paid: boolean }): LaneOutcome {
  if (error instanceof DeploymentVerificationError || error instanceof ConflictError)
    return "terminal";
  if (reverted(error)) return "terminal";
  if (context.paid) return "retry";
  if (error instanceof LaneError)
    return error.code !== undefined && RETRY_UNPAID.has(error.code) ? "retry" : "terminal";
  if (error instanceof RelayrResponseError) return relayrRejected(error) ? "terminal" : "retry";
  if (error instanceof RestError) return RETRY_UNPAID.has(error.code) ? "retry" : "terminal";
  if (rpcFailure(error)) return "retry";
  return "terminal";
}

/**
 * A request the execution service read and refused. The mapped RestError status is the
 * one Center answers its own callers with, so the verdict reads Relayr's own HTTP status:
 * a 4xx names something wrong with the request, and anything else could still pass later.
 */
function relayrRejected(error: RelayrResponseError): boolean {
  const { status } = error.responseDetails;
  return status >= 400 && status < 500;
}

/** A call the node executed and rejected: sending it again cannot change the answer. */
function reverted(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    error.walk(
      (cause) =>
        cause instanceof ContractFunctionRevertedError || cause instanceof ExecutionRevertedError,
    ) !== null
  );
}

function rpcFailure(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    error.walk((cause) => cause instanceof HttpRequestError || cause instanceof RpcRequestError) !==
      null
  );
}

function describeError(error: unknown): string {
  if (error instanceof LaneError) return error.code ?? error.message;
  if (error instanceof DeploymentVerificationError) return error.message;
  if (error instanceof ConflictError) return "another sender already deployed this chain";
  if (error instanceof RelayrResponseError) return "relayr request failed";
  if (error instanceof RestError) return error.code;
  if (error instanceof BaseError)
    return rpcFailure(error) ? "rpc request failed" : `${error.name}: ${error.shortMessage ?? "lane error"}`;
  if (error instanceof Error) return `${error.name}: lane error`;
  return "lane error";
}

export type SponsorEvent =
  | { event: "bundle"; intentId: string; bundleUuid: string; chainIds: number[]; paymentChainId: number; offeredPaymentChainIds: number[] }
  | { event: "payment"; intentId: string; chainId: number; transactionHash: Hex; wei: string }
  | { event: "sent"; intentId: string; chainId: number; transactionHash: Hex }
  | { event: "confirmed"; intentId: string; chainId: number; projectId: string }
  | { event: "setup_skipped"; intentId: string; chainId: number; index: number; safe: Address }
  | { event: "setup_reverted"; intentId: string; chainId: number; index: number; transactionHash: Hex }
  | { event: "setup_unobserved"; intentId: string; chainId: number; index: number; transactionHash: Hex }
  | { event: "relay"; intentId: string; chainId: number; deadline: number }
  | { event: "failed"; intentId: string; chainId: number; error: string }
  | { event: "deferred"; intentId: string; chainIds: number[]; error: string }
  | { event: "status_invalid"; intentId: string; bundleUuid?: string; detail: string };

export type SponsorEvents = (event: SponsorEvent) => void;

export const logSponsorEvent: SponsorEvents = (event) => {
  if (process.env.NODE_ENV === "test") return;
  console.info(JSON.stringify({ level: "info", service: "sponsor", ...event }));
};

export type SponsorSigner = {
  address: Address;
  signTransaction(tx: TransactionSerializableEIP1559): Promise<Hex>;
  signTypedData(args: TypedDataDefinition): Promise<Hex>;
};

export type LaneReport = {
  /** Durably record the submitted bundle before any value leaves the sponsor key. */
  bundle(bundleUuid: string): Promise<void>;
  /** The settled cost of the prepayment, recorded before any destination chain settles. */
  paid(chainId: number, spentWei: bigint): Promise<void>;
  sent(chainId: number, transactionHash: Hex, bundleUuid: string): Promise<void>;
  confirmed(chainId: number, transactionHash: Hex, projectId: string): Promise<void>;
  failed(chainId: number, error: string): Promise<void>;
  /** Spend nothing and leave the claimed rows queued for a later lease. */
  deferred(error: string): Promise<void>;
};

export type DeployLane = {
  deploy(intent: Intent, chainIds: number[], report: LaneReport): Promise<void>;
  /** Follow a bundle a previous attempt already paid for, without paying again. */
  resume(intent: Intent, chainIds: number[], bundleUuid: string, report: LaneReport): Promise<void>;
};

/** Preparing a chain for a sender who is not Center: the sponsor signs, the payer sends. */
export type RelayLane = {
  relay(intent: Intent, chainId: number): Promise<RelayRequest>;
};
