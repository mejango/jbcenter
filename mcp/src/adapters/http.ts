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
      await response.body?.cancel();
      throw new DomainError(
        'UPSTREAM_HTTP_ERROR',
        `The upstream returned HTTP ${response.status}.`,
        {
          retryable: response.status === 429 || response.status >= 500,
          details: { status: response.status },
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
