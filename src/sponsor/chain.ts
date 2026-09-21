import {
  BaseError,
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
import { ConflictError } from "../store.js";
import type { Intent } from "../types.js";

export { CREATE_TOPIC } from "../deploymentVerifier.js";

export const PROJECTS_ABI = parseAbi(["function creationFee() view returns (uint256)"]);

const ERROR_LIMIT = 300;
const SECRETS = [/https?:\/\/\S+/g, /0x[0-9a-fA-F]{20,}/g];

/** A lane failure whose text is authored here, safe to show a caller. */
export class LaneError extends Error {}

/**
 * Lane failures are published by `GET /v1/intents/:id`, and upstream exceptions carry
 * request URLs with the RPC key and signed payload bytes. Only authored text, error
 * codes and fixed phrases survive.
 */
export function laneErrorMessage(error: unknown): string {
  let message = describeError(error);
  for (const secret of SECRETS) message = message.replace(secret, " ");
  return message.replace(/\s+/g, " ").trim().slice(0, ERROR_LIMIT) || "lane error";
}

function describeError(error: unknown): string {
  if (error instanceof LaneError || error instanceof DeploymentVerificationError) return error.message;
  if (error instanceof ConflictError) return "another sender already deployed this chain";
  if (error instanceof RelayrResponseError) return "relayr request failed";
  if (error instanceof RestError) return error.code;
  if (error instanceof BaseError) {
    const rpc = error.walk(
      (cause) => cause instanceof HttpRequestError || cause instanceof RpcRequestError,
    );
    return rpc ? "rpc request failed" : `${error.name}: ${error.shortMessage ?? "lane error"}`;
  }
  if (error instanceof Error) return `${error.name}: lane error`;
  return "lane error";
}

export type SponsorEvent =
  | { event: "bundle"; intentId: string; bundleUuid: string; chainIds: number[]; paymentChainId: number; offeredPaymentChainIds: number[] }
  | { event: "payment"; intentId: string; chainId: number; transactionHash: Hex; wei: string }
  | { event: "sent"; intentId: string; chainId: number; transactionHash: Hex }
  | { event: "confirmed"; intentId: string; chainId: number; projectId: string }
  | { event: "failed"; intentId: string; chainId: number; error: string }
  | { event: "deferred"; intentId: string; chainIds: number[]; error: string };

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
