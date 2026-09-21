import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { CID } from "multiformats/cid";

const FILEBASE_ADD_URL = "https://rpc.filebase.io/api/v0/add?cid-version=0";
const PINATA_PIN_URL = "https://api.pinata.cloud/v3/files/public/pin_by_cid";
const PROVIDER_TIMEOUT_MS = 90_000;
const FILEBASE_TIMEOUT_MS = 290_000;
const PROVIDER_RESPONSE_LIMIT = 64 * 1024;

const CID_ENVELOPE = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,160})$/u;

export const PIN_LIMITS = {
  json: 2 * 1024 * 1024,
  image: 25 * 1024 * 1024,
  media: 500 * 1024 * 1024,
  multipartOverhead: 256 * 1024,
  gateway: 500 * 1024 * 1024,
} as const;

export type PinResult = {
  cid: string;
  status: "queued";
};

export interface PinningService {
  pin(
    content: Blob,
    filename: string,
    signal?: AbortSignal,
  ): Promise<PinResult>;
  pinStream(
    content: Readable,
    filename: string,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<PinResult>;
}

export interface IpfsStorage {
  add(content: Blob, filename: string, signal?: AbortSignal): Promise<string>;
  addStream(
    content: Readable,
    filename: string,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<string>;
}

/** Provider responses are small status envelopes, never unbounded content streams. */
async function providerText(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const reader = response.body?.getReader();
  const cancel = (reason: unknown) => {
    void reader?.cancel(reason).catch(() => undefined);
  };
  const abort = () => cancel(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (
      !Number.isFinite(declared) ||
      declared < 0 ||
      declared > PROVIDER_RESPONSE_LIMIT
    ) {
      throw new Error("IPFS provider response is too large");
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (reader) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > PROVIDER_RESPONSE_LIMIT)
        throw new Error("IPFS provider response is too large");
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    cancel(error);
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader?.releaseLock();
  }
}

function cancelResponse(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

export function isIpfsCid(value: string): boolean {
  if (!CID_ENVELOPE.test(value)) return false;
  try {
    return CID.parse(value).toString() === value;
  } catch {
    return false;
  }
}

export function safeIpfsPath(rawPath: string): string | null {
  const parts = rawPath.split("/");
  if (parts.length < 1 || parts.length > 8 || !isIpfsCid(parts[0] ?? ""))
    return null;
  if (
    parts
      .slice(1)
      .some(
        (part) =>
          part === "." ||
          part === ".." ||
          !/^[A-Za-z0-9._~-]{1,128}$/u.test(part),
      )
  ) {
    return null;
  }
  const path = parts.map(encodeURIComponent).join("/");
  return path.length <= 512 ? path : null;
}

export class FilebaseRpcStorage implements IpfsStorage {
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async add(
    content: Blob,
    filename: string,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    const bytes = Buffer.from(await content.arrayBuffer());
    signal?.throwIfAborted();
    return this.addStream(
      Readable.from(bytes),
      filename,
      content.type || "application/octet-stream",
      signal,
    );
  }

  async addStream(
    content: Readable,
    filename: string,
    contentType: string,
    callerSignal?: AbortSignal,
  ): Promise<string> {
    const signal = AbortSignal.any([
      AbortSignal.timeout(FILEBASE_TIMEOUT_MS),
      ...(callerSignal ? [callerSignal] : []),
    ]);
    signal.throwIfAborted();
    const boundary = `jbcenter-${randomBytes(18).toString("hex")}`;
    const safeFilename = filename.replace(/[\r\n"]/gu, "_");
    const safeContentType = /^[\w.+-]+\/[\w.+-]+$/u.test(contentType)
      ? contentType
      : "application/octet-stream";
    const prefix = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFilename}"\r\nContent-Type: ${safeContentType}\r\n\r\n`,
    );
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Readable.from(
      (async function* () {
        yield prefix;
        for await (const chunk of content) yield chunk;
        yield suffix;
      })(),
    );
    const abort = () => {
      // Fetch cancellation alone must not leave the supplied Node stream producing data.
      content.destroy();
      body.destroy();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.fetcher(FILEBASE_ADD_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body: body as unknown as BodyInit,
        duplex: "half",
        redirect: "error",
        signal,
      } as RequestInit & { duplex: "half" });
      if (!response.ok) {
        cancelResponse(response);
        throw new Error(`Filebase upload failed (${response.status})`);
      }
      const lastLine = (await providerText(response, signal))
        .trim()
        .split("\n")
        .at(-1);
      signal.throwIfAborted();
      let cid: unknown;
      try {
        cid = JSON.parse(lastLine ?? "").Hash;
      } catch {
        throw new Error("Filebase returned an invalid response");
      }
      if (typeof cid !== "string" || !isIpfsCid(cid)) {
        throw new Error("Filebase returned an invalid CID");
      }
      return cid;
    } finally {
      signal.removeEventListener("abort", abort);
      content.destroy();
      body.destroy();
    }
  }
}

export class RedundantIpfsPinning implements PinningService {
  constructor(
    private readonly filebase: IpfsStorage,
    private readonly pinataJwt: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async pin(
    content: Blob,
    filename: string,
    signal?: AbortSignal,
  ): Promise<PinResult> {
    signal?.throwIfAborted();
    const cid = await this.filebase.add(content, filename, signal);
    signal?.throwIfAborted();
    await this.replicate(cid, filename, signal);
    return { cid, status: "queued" };
  }

  async pinStream(
    content: Readable,
    filename: string,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<PinResult> {
    signal?.throwIfAborted();
    const cid = await this.filebase.addStream(
      content,
      filename,
      contentType,
      signal,
    );
    signal?.throwIfAborted();
    await this.replicate(cid, filename, signal);
    return { cid, status: "queued" };
  }

  private async replicate(
    cid: string,
    filename: string,
    callerSignal?: AbortSignal,
  ): Promise<void> {
    const signal = AbortSignal.any([
      AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      ...(callerSignal ? [callerSignal] : []),
    ]);
    signal.throwIfAborted();
    const pinata = await this.fetcher(PINATA_PIN_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.pinataJwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cid, name: filename }),
      redirect: "error",
      signal,
    });
    if (!pinata.ok) {
      cancelResponse(pinata);
      throw new Error(`Pinata replication failed (${pinata.status})`);
    }
    const pinataBody = JSON.parse(await providerText(pinata, signal)) as {
      data?: { cid?: unknown };
    };
    signal.throwIfAborted();
    if (pinataBody.data?.cid !== cid)
      throw new Error("Pinata returned a mismatched CID");
  }
}
