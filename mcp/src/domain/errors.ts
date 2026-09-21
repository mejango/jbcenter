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
  return {
    code: 'UPSTREAM_FAILURE',
    message:
      'The operation could not be verified. Retry the read; do not infer zero balances, permission, or transaction failure.',
    retryable: true,
  };
}
