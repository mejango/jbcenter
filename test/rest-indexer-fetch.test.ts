import { afterEach, describe, expect, it, vi } from "vitest";
import {
  boundedIndexerFetch,
  type IndexerFetchOptions,
} from "../src/rest/indexer/index.js";

function options(
  overrides: Partial<IndexerFetchOptions> = {},
): IndexerFetchOptions {
  return {
    method: "POST",
    headers: { authorization: "Bearer private-test-credential" },
    body: { query: "query IndexerStatus { _meta { status } }", variables: {} },
    signal: new AbortController().signal,
    maxBytes: 128,
    timeoutMs: 1000,
    ...overrides,
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("bounded REST indexer transport", () => {
  it("preserves UTF-8 split across chunks and sends only the supplied query body with redirects disabled", async () => {
    const bytes = new TextEncoder().encode('{"data":{"value":"🍌"}}');
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const byte of bytes)
                controller.enqueue(new Uint8Array([byte]));
              controller.close();
            },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(
      boundedIndexerFetch("https://indexer.example/private/path", options()),
    ).resolves.toEqual({ data: { value: "🍌" } });
    expect(fetch).toHaveBeenCalledWith(
      "https://indexer.example/private/path",
      expect.objectContaining({
        redirect: "error",
        method: "POST",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual(
      options().body,
    );
  });

  it("cancels a declared oversized stream before reading it", async () => {
    const cancelled = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new ReadableStream({ cancel: cancelled }), {
            headers: { "content-length": "9999999" },
          }),
      ),
    );
    await expect(
      boundedIndexerFetch("https://indexer.example/credential", options()),
    ).rejects.toMatchObject({
      code: "INDEXER_RESPONSE_TOO_LARGE",
      status: 502,
    });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("bounds streams without content-length and cancels remaining data", async () => {
    const cancelled = vi.fn();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                calls++;
                controller.enqueue(new TextEncoder().encode("12345678"));
              },
              cancel: cancelled,
            }),
          ),
      ),
    );
    await expect(
      boundedIndexerFetch(
        "https://indexer.example/graphql",
        options({ maxBytes: 12 }),
      ),
    ).rejects.toMatchObject({ code: "INDEXER_RESPONSE_TOO_LARGE" });
    expect(calls).toBeLessThanOrEqual(3);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it.each([
    ["malformed JSON", new TextEncoder().encode("{")],
    ["invalid UTF-8", new Uint8Array([0xff, 0xfe])],
  ])("rejects %s without exposing upstream data", async (_name, body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body)),
    );
    await expect(
      boundedIndexerFetch(
        "https://indexer.example/private-credential",
        options(),
      ),
    ).rejects.toMatchObject({ code: "INDEXER_INVALID_RESPONSE" });
  });

  it("never exposes upstream error bodies, credential URLs, or exception messages", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("private-body-secret", { status: 503 }),
      )
      .mockRejectedValueOnce(
        new Error(
          "https://indexer.example/private-credential Bearer private-test-credential",
        ),
      );
    vi.stubGlobal("fetch", fetch);
    for (let i = 0; i < 2; i++) {
      const error = await boundedIndexerFetch(
        "https://indexer.example/private-credential",
        options(),
      ).catch((error: unknown) => error);
      expect(JSON.stringify(error)).not.toMatch(
        /private-body-secret|private-credential|private-test-credential/,
      );
      expect(String(error)).not.toMatch(
        /private-body-secret|private-credential|private-test-credential/,
      );
    }
    expect(
      fetch.mock.calls.every(([, init]) => init.redirect === "error"),
    ).toBe(true);
  });

  it("propagates cancellation without calling it an empty response", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        expect(init.signal).toBe(controller.signal);
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      }),
    );
    await expect(
      boundedIndexerFetch(
        "https://indexer.example/graphql",
        options({ signal: controller.signal }),
      ),
    ).rejects.toMatchObject({ code: "INDEXER_CANCELLED", retryable: true });
  });
});
