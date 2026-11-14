export async function boundedText(
  response: Response,
  signal: AbortSignal,
  responseLimit: number,
  unavailable: (message: string) => Error,
): Promise<string> {
  const reader = response.body?.getReader();
  const cancel = (reason: unknown) => {
    // Cancellation must not wait for an upstream's cancellation hook to settle.
    void reader?.cancel(reason).catch(() => undefined);
  };
  const onAbort = () => cancel(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    signal.throwIfAborted();
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (!Number.isFinite(declared) || declared < 0 || declared > responseLimit) {
      throw unavailable("upstream response is too large");
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > responseLimit) {
        throw unavailable("upstream response is too large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  } catch (error) {
    cancel(error);
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader?.releaseLock();
  }
}

