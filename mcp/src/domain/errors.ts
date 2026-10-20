import * as sdk from '@bananapus/nana-sdk-core';
import { decodePayFailure, payRetrySlippageBps } from '@bananapus/nana-sdk-core/v6';
import { decodeErrorResult, type Abi, type AbiParameter, type Hex } from 'viem';

export class DomainError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;
  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; details?: unknown } = {},
  ) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

/** Upstream exceptions can contain credential-bearing RPC URLs and request bodies. */
export function publicError(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
  payFailure?: PayFailureView;
} {
  if (error instanceof DomainError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  const revert = revertOf(error);
  if (revert)
    return {
      code: 'CALL_REVERTED',
      message: `The call reverts at this block${revert.errorName ? ` with ${revert.errorName}` : ''}. Retrying the same inputs reverts again until chain state changes.`,
      retryable: false,
      details: revert,
    };
  if (causedBy(error, 'InsufficientFundsError'))
    return {
      code: 'INSUFFICIENT_FUNDS',
      message:
        "The account cannot cover this call's value plus gas at this block. Retrying the same inputs fails again; fund the account or act from one that holds enough.",
      retryable: false,
    };
  return {
    code: 'UPSTREAM_FAILURE',
    message:
      'The operation could not be verified. Retry the read; do not infer zero balances, permission, or transaction failure.',
    retryable: true,
  };
}

export type PayFailureView = {
  reason: string;
  message: string;
  received?: string;
  minimum?: string;
  /** The SDK's: the failing check settled nothing, so no lower minimum fixes it. */
  zeroFill?: boolean;
  /** The SDK's: the setting a retry can relax ("minimum"); absent means relax nothing. */
  adjustable?: string;
  /** The SDK's payRetrySlippageBps from the plan's slippageBps: a candidate, not permission. */
  retrySlippageBps?: number;
  retry?: string;
};

/**
 * What the SDK cannot see from a revert: the slippageBps the payment was prepared with, whether the
 * caller fixed minReturnedTokens, and where the buyback hook's minimum came from.
 */
export type PayFailureContext = {
  slippageBps?: bigint;
  explicitMinimum?: boolean;
  hookMinimumSource?: 'slippageBps' | 'caller metadata';
};

const isAmount = (value: unknown): value is bigint => typeof value === 'bigint' && value >= 0n;

/**
 * Why a payment reverts, from the SDK's decodePayFailure over the revert bytes only (a custom error
 * with exactly its ABI arguments; names in node text or Error(string) never count): a stable reason,
 * its fixed sentence and, for a shortfall, the uint256 amounts. A retry is offered only when the SDK
 * marks the failure adjustable, naming the jb_prepare_pay input that moves the failing check.
 * Never node text.
 */
export function payFailureOf(
  error: unknown,
  context: PayFailureContext = {},
): PayFailureView | undefined {
  const data = revertDataOf(error);
  const failure = data && decodePayFailure(data);
  if (!failure) return undefined;
  const { reason, message, received, minimum, zeroFill, adjustable } = failure;
  if (!isAmount(received) || !isAmount(minimum)) return { reason, message };
  const view: PayFailureView = {
    reason,
    message,
    received: received.toString(),
    minimum: minimum.toString(),
    ...(zeroFill === true ? { zeroFill } : {}),
    ...(adjustable === 'minimum' ? { adjustable } : {}),
  };
  if (zeroFill === true)
    return {
      ...view,
      retry:
        "The failing check settled nothing, so a lower minimum would only accept receiving nothing. Check the project's issuance and pool before retrying.",
    };
  if (adjustable !== 'minimum') return view;
  if (reason === 'TERMINAL_UNDER_MIN' && context.explicitMinimum)
    return {
      ...view,
      retry: `minReturnedTokens was the caller's own. Prepare the payment again with jb_prepare_pay passing minReturnedTokens at or below ${received} only if the payer accepts that many.`,
    };
  if (reason === 'BUYBACK_SLIPPAGE_EXCEEDED' && context.hookMinimumSource === 'caller metadata')
    return {
      ...view,
      retry:
        "The buyback hook's minimum is the minimumSwapAmountOut in the metadata the caller passed, so slippageBps does not change it. Only if the payer accepts a lower minimum, lower that value in the metadata and keep its other entries. Omitting the metadata hands the minimum to jb_prepare_pay: a pool-quote minimum, or without a quote only the payer's mint share, which can be far lower. Review the new minimum and simulate before signing.",
    };
  // slippageBps moves the hook's minimum only when prepareUserPay set it from a pool quote; buyback
  // 1.1.1 raises the same error for its oracle floor, which no tolerance moves.
  if (reason === 'BUYBACK_SLIPPAGE_EXCEEDED' && context.hookMinimumSource !== 'slippageBps')
    return view;
  const next =
    context.slippageBps === undefined ? null : payRetrySlippageBps(failure, context.slippageBps);
  if (next === null) return view;
  return {
    ...view,
    retrySlippageBps: Number(next),
    retry: `Prepare the payment again with jb_prepare_pay and slippageBps ${next} (it was ${context.slippageBps}) only if the payer accepts that tolerance; review the new minimum and simulate before signing. It is a candidate and may still fall short.`,
  };
}

/** publicError for a payment: adds the decoded reason it reverts, when the SDK recognizes it. */
export function publicPayError(
  error: unknown,
  context?: PayFailureContext,
): ReturnType<typeof publicError> {
  const failure = payFailureOf(error, context);
  return { ...publicError(error), ...(failure ? { payFailure: failure } : {}) };
}

/** viem names a node's known failure in the cause chain; its message embeds the request, so match the name. */
function causedBy(error: unknown, name: string): boolean {
  let item: unknown = error;
  for (let depth = 0; depth < 10 && item && typeof item === 'object'; depth++) {
    if ((item as { name?: unknown }).name === name) return true;
    item = (item as { cause?: unknown }).cause;
  }
  return false;
}

/** A decoded argument for the response, by its ABI type: strings withheld, integers as decimal text. */
export function shown(input: AbiParameter, value: unknown): unknown {
  const array = /^(.*)\[\d*\]$/.exec(input.type);
  if (array) return (value as unknown[]).map((item) => shown({ ...input, type: array[1]! }, item));
  if (input.type === 'string') return '[text withheld]';
  if (input.type === 'tuple') {
    const components = (input as { components: readonly AbiParameter[] }).components;
    return Array.isArray(value)
      ? components.map((component, index) => shown(component, value[index]))
      : Object.fromEntries(
          components.map((component) => [
            component.name,
            shown(component, (value as Record<string, unknown>)[component.name!]),
          ]),
        );
  }
  return typeof value === 'bigint' ? value.toString() : value;
}

/** Every error the installed V6 SDK ABIs declare, so a revert can name its contract error. */
const KNOWN_ERRORS = Object.values(sdk).flatMap((value) =>
  Array.isArray(value)
    ? value.filter((item) => typeof item === 'object' && item !== null && item.type === 'error')
    : [],
) as Abi;

export type Revert = { selector: Hex; errorName?: string; args?: unknown[] };

/**
 * A contract revert that carries revert data. Data-less errors (transport failures, gateways that
 * strip revert data, -32603) are not reverts here: their outcome stays unknown.
 */
export function revertOf(error: unknown): Revert | undefined {
  const data = revertDataOf(error);
  if (!data) return undefined;
  const selector = data.slice(0, 10).toLowerCase() as Hex;
  try {
    const decoded = decodeErrorResult({ abi: KNOWN_ERRORS, data });
    // Error(string) text is contract-supplied; keep it out of the response.
    if (decoded.errorName === 'Error') return { selector, errorName: 'Error' };
    return {
      selector,
      errorName: decoded.errorName,
      // Numbers, addresses and bytes stay as diagnostics. Every ABI `string` argument (StringTooLong
      // and the like) is caller- or node-supplied text, so it never reaches the response, whatever
      // it looks like.
      args: (decoded.abiItem as { inputs: readonly AbiParameter[] }).inputs.map((input, index) =>
        shown(input, decoded.args?.[index]),
      ),
    };
  } catch {
    return { selector };
  }
}

/** The revert bytes in an error's cause chain: a revert's raw data or a code-3 RPC error's data. */
function revertDataOf(error: unknown): Hex | undefined {
  let item: unknown = error;
  for (let depth = 0; depth < 10 && item && typeof item === 'object'; depth++) {
    const e = item as {
      name?: unknown;
      raw?: unknown;
      code?: unknown;
      data?: unknown;
      cause?: unknown;
    };
    const data =
      e.name === 'ContractFunctionRevertedError' ? e.raw : e.code === 3 ? e.data : undefined;
    if (typeof data === 'string' && /^0x[0-9a-fA-F]{8}(?:[0-9a-fA-F]{2})*$/.test(data))
      return data as Hex;
    item = e.cause;
  }
  return undefined;
}
