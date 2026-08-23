import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { CID } from "multiformats/cid";

const FILEBASE_ADD_URL = "https://rpc.filebase.io/api/v0/add?cid-version=0";
const PINATA_PIN_URL = "https://api.pinata.cloud/v3/files/public/pin_by_cid";
const PROVIDER_TIMEOUT_MS = 90_000;
const FILEBASE_TIMEOUT_MS = 290_000;

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
  pin(content: Blob, filename: string): Promise<PinResult>;
  pinStream(content: Readable, filename: string, contentType: string): Promise<PinResult>;
}

export interface IpfsStorage {
  add(content: Blob, filename: string): Promise<string>;
  addStream(content: Readable, filename: string, contentType: string): Promise<string>;
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
  if (parts.length < 1 || parts.length > 8 || !isIpfsCid(parts[0] ?? "")) return null;
  if (
    parts
      .slice(1)
      .some((part) => part === "." || part === ".." || !/^[A-Za-z0-9._~-]{1,128}$/u.test(part))
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

  async add(content: Blob, filename: string): Promise<string> {
    return this.addStream(
      Readable.from(Buffer.from(await content.arrayBuffer())),
      filename,
      content.type || "application/octet-stream",
    );
  }

  async addStream(content: Readable, filename: string, contentType: string): Promise<string> {
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
    const response = await this.fetcher(FILEBASE_ADD_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body: body as unknown as BodyInit,
      duplex: "half",
      signal: AbortSignal.timeout(FILEBASE_TIMEOUT_MS),
    } as RequestInit & { duplex: "half" });
    if (!response.ok) throw new Error(`Filebase upload failed (${response.status})`);
    const lastLine = (await response.text()).trim().split("\n").at(-1);
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
  }
}

export class RedundantIpfsPinning implements PinningService {
  constructor(
    private readonly filebase: IpfsStorage,
    private readonly pinataJwt: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async pin(content: Blob, filename: string): Promise<PinResult> {
    const cid = await this.filebase.add(content, filename);
    await this.replicate(cid, filename);
    return { cid, status: "queued" };
  }

  async pinStream(content: Readable, filename: string, contentType: string): Promise<PinResult> {
    const cid = await this.filebase.addStream(content, filename, contentType);
    await this.replicate(cid, filename);
    return { cid, status: "queued" };
  }

  private async replicate(cid: string, filename: string): Promise<void> {
    const pinata = await this.fetcher(PINATA_PIN_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.pinataJwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cid, name: filename }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!pinata.ok) throw new Error(`Pinata replication failed (${pinata.status})`);
    const pinataBody = (await pinata.json()) as { data?: { cid?: unknown } };
    if (pinataBody.data?.cid !== cid) throw new Error("Pinata returned a mismatched CID");
  }
}
