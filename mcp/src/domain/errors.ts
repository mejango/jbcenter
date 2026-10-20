import * as sdk from '@bananapus/nana-sdk-core';
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
    if (typeof data === 'string' && /^0x[0-9a-fA-F]{8}(?:[0-9a-fA-F]{2})*$/.test(data)) {
      const selector = data.slice(0, 10).toLowerCase() as Hex;
      try {
        const decoded = decodeErrorResult({ abi: KNOWN_ERRORS, data: data as Hex });
        // Error(string) text is contract-supplied; keep it out of the response.
        if (decoded.errorName === 'Error') return { selector, errorName: 'Error' };
        return {
          selector,
          errorName: decoded.errorName,
          // Numbers, addresses and bytes stay as diagnostics. Every ABI `string` argument (StringTooLong
          // and the like) is caller- or node-supplied text, so it never reaches the response, whatever
          // it looks like.
          args: (decoded.abiItem as { inputs: readonly AbiParameter[] }).inputs.map(
            (input, index) => shown(input, decoded.args?.[index]),
          ),
        };
      } catch {
        return { selector };
      }
    }
    item = e.cause;
  }
  return undefined;
}
