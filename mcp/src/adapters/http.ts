import { DomainError } from '../domain/errors.js';
import { consumeRequest } from '../domain/context.js';

export interface FetchJsonOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}

const ERROR_BODY_LIMIT = 8 * 1024;
const ERROR_CODE = /^[a-z_]{1,64}$/u;

/**
 * The bounded machine-readable refusal code an upstream carried, or nothing. Only a short code
 * matching a fixed shape is admitted, so upstream prose, URLs and credentials never travel with
 * the failure.
 */
export function upstreamErrorCode(body: string): string | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(body.slice(0, 4096));
  } catch {
    return undefined;
  }
  const code = (payload as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === 'string' && ERROR_CODE.test(code) ? code : undefined;
}

/**
 * The bounded `{status, code}` an `UPSTREAM_HTTP_ERROR` DomainError already carries, computed by
 * `upstreamErrorCode` when the failure was first observed. Callers read this instead of narrowing
 * `error.details` themselves, so the one extraction is shared rather than repeated per caller.
 */
export function upstreamErrorDetails(error: unknown): { status?: number; code?: string } {
  if (!(error instanceof DomainError) || error.code !== 'UPSTREAM_HTTP_ERROR') return {};
  const details = error.details;
  return details && typeof details === 'object'
    ? (details as { status?: number; code?: string })
    : {};
}

/** Read at most a bounded prefix of a failure body, then stop the stream. */
async function boundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const chunk = await reader.read();
      if (chunk.done) break;
      chunks.push(chunk.value);
      size += chunk.value.byteLength;
    }
  } catch {
    return '';
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8').slice(0, limit);
}

/** Only adapters supply URLs. Redirects and unbounded upstream bodies are never followed. */
export async function fetchJson(
  url: string | URL,
  options: FetchJsonOptions = {},
): Promise<unknown> {
  const target = new URL(url);
  if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) {
    throw new DomainError(
      'INVALID_ENDPOINT',
      'The configured upstream endpoint must be an HTTP(S) URL without user information.',
    );
  }
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 15_000),
    ...[options.signal, consumeRequest()].filter((item): item is AbortSignal => item !== undefined),
  ]);
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(target, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: {
        accept: 'application/json',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      ...(options.body === undefined
        ? {}
        : { body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body) }),
      redirect: 'manual',
      signal,
    });
    if (!response.ok) {
      const code = upstreamErrorCode(await boundedText(response, ERROR_BODY_LIMIT));
      throw new DomainError(
        'UPSTREAM_HTTP_ERROR',
        `The upstream returned HTTP ${response.status}.`,
        {
          retryable: response.status === 429 || response.status >= 500,
          details: { status: response.status, ...(code === undefined ? {} : { code }) },
        },
      );
    }
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) {
      await response.body?.cancel();
      throw new DomainError(
        'UPSTREAM_RESPONSE_TOO_LARGE',
        'The upstream response exceeded the configured size limit. Narrow the query.',
      );
    }
    if (!response.body)
      throw new DomainError(
        'UPSTREAM_INVALID_RESPONSE',
        'The upstream returned an empty response.',
      );
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes)
        throw new DomainError(
          'UPSTREAM_RESPONSE_TOO_LARGE',
          'The upstream response exceeded the configured size limit. Narrow the query.',
        );
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    if (signal.aborted)
      throw new DomainError(
        'UPSTREAM_TIMEOUT',
        'The upstream request was cancelled or exceeded its time limit.',
        { retryable: true },
      );
    if (error instanceof SyntaxError)
      throw new DomainError('UPSTREAM_INVALID_RESPONSE', 'The upstream did not return valid JSON.');
    throw new DomainError('UPSTREAM_UNAVAILABLE', 'The configured upstream could not be reached.', {
      retryable: true,
    });
  } finally {
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
  }
}
