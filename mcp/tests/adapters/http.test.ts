import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJson } from '../../src/adapters/http.js';
import { withRequestBudget } from '../../src/domain/context.js';

afterEach(() => vi.unstubAllGlobals());
describe('bounded upstream HTTP', () => {
  it('does not follow redirects or disclose their response bodies', async () => {
    const fetcher = vi.fn(
      async (_url: URL, _options: RequestInit) =>
        new Response('secret provider credential', {
          status: 302,
          headers: { location: 'https://attacker.example' },
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    await expect(fetchJson('https://upstream.example/key')).rejects.toMatchObject({
      code: 'UPSTREAM_HTTP_ERROR',
      message: 'The upstream returned HTTP 302.',
    });
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });
  it('enforces actual streamed bytes without relying on Content-Length', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('"123456789"')),
    );
    await expect(fetchJson('https://upstream.example', { maxBytes: 5 })).rejects.toMatchObject({
      code: 'UPSTREAM_RESPONSE_TOO_LARGE',
    });
  });
  it('redacts network exception text and rejects malformed JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('https://rpc.example/private-key');
      }),
    );
    await expect(fetchJson('https://rpc.example/private-key')).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      message: 'The configured upstream could not be reached.',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>not json</html>')),
    );
    await expect(fetchJson('https://upstream.example')).rejects.toMatchObject({
      code: 'UPSTREAM_INVALID_RESPONSE',
    });
  });
  it('cancels stalled upstream fetches at the configured deadline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: URL, options: RequestInit) =>
          new Promise((_resolve, reject) =>
            options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
              once: true,
            }),
          ),
      ),
    );
    await expect(fetchJson('https://upstream.example', { timeoutMs: 10 })).rejects.toMatchObject({
      code: 'UPSTREAM_TIMEOUT',
    });
  });
  it('shares an upstream call budget across parallel reads', async () => {
    const fetcher = vi.fn(async () => new Response('{"ok":true}'));
    vi.stubGlobal('fetch', fetcher);
    const results = await withRequestBudget(
      () =>
        Promise.allSettled(Array.from({ length: 3 }, () => fetchJson('https://upstream.example'))),
      undefined,
      2,
    );
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects URL credentials before invoking fetch', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(fetchJson('https://user:secret@example.com')).rejects.toMatchObject({
      code: 'INVALID_ENDPOINT',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
