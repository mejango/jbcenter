import { IndexerError, type IndexerFetchJson } from "./types.js";

/** Streams a bounded JSON response; redirects never forward configured credentials. */
export const boundedIndexerFetch: IndexerFetchJson = async (url, options) => {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: options.headers,
      body: JSON.stringify(options.body),
      signal: options.signal,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new IndexerError(
        "INDEXER_UPSTREAM_HTTP_ERROR",
        "The configured indexer returned an unsuccessful HTTP status.",
        502,
        response.status === 429 || response.status >= 500,
      );
    }
    const length = response.headers.get("content-length");
    if (
      length !== null &&
      (!/^\d+$/.test(length) || Number(length) > options.maxBytes)
    ) {
      await response.body?.cancel();
      throw new IndexerError(
        "INDEXER_RESPONSE_TOO_LARGE",
        "The indexer response exceeds the size limit.",
        502,
      );
    }
    if (!response.body)
      throw new IndexerError(
        "INDEXER_INVALID_RESPONSE",
        "The indexer returned no response body.",
        502,
      );
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > options.maxBytes)
        throw new IndexerError(
          "INDEXER_RESPONSE_TOO_LARGE",
          "The indexer response exceeds the size limit.",
          502,
        );
      chunks.push(chunk.value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    ) as unknown;
  } catch (error) {
    if (error instanceof IndexerError) throw error;
    if (options.signal.aborted)
      throw new IndexerError(
        "INDEXER_CANCELLED",
        "The indexer request was cancelled or exceeded its deadline.",
        504,
        true,
      );
    if (
      error instanceof SyntaxError ||
      (error instanceof TypeError &&
        String(error.message).includes("encoded data"))
    ) {
      throw new IndexerError(
        "INDEXER_INVALID_RESPONSE",
        "The indexer returned invalid JSON or UTF-8.",
        502,
      );
    }
    throw new IndexerError(
      "INDEXER_UNAVAILABLE",
      "The configured indexer could not be reached.",
      502,
      true,
    );
  } finally {
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
  }
};
