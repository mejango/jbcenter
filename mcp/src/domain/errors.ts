import * as sdk from '@bananapus/nana-sdk-core';
import { decodeErrorResult, type Abi, type Hex } from 'viem';

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
  return {
    code: 'UPSTREAM_FAILURE',
    message:
      'The operation could not be verified. Retry the read; do not infer zero balances, permission, or transaction failure.',
    retryable: true,
  };
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
          args: JSON.parse(
            JSON.stringify(decoded.args ?? [], (_key, value: unknown) =>
              typeof value === 'bigint' ? value.toString() : value,
            ),
          ) as unknown[],
        };
      } catch {
        return { selector };
      }
    }
    item = e.cause;
  }
  return undefined;
}
