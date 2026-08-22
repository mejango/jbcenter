import { createHash } from "node:crypto";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { CID } from "multiformats/cid";

const PINATA_PIN_URL = "https://api.pinata.cloud/v3/files/public/pin_by_cid";
const PROVIDER_TIMEOUT_MS = 90_000;

const CID_ENVELOPE = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,160})$/u;

export const PIN_LIMITS = {
  json: 64 * 1024,
  image: 5 * 1024 * 1024,
  media: 50 * 1024 * 1024,
  multipartOverhead: 256 * 1024,
  gateway: 50 * 1024 * 1024,
} as const;

export type PinResult = {
  cid: string;
  status: "queued";
};

export interface PinningService {
  pin(content: Blob, filename: string): Promise<PinResult>;
}

export interface IpfsStorage {
  add(content: Blob, filename: string): Promise<string>;
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

export class FilebaseS3Storage implements IpfsStorage {
  private readonly client: S3Client;

  constructor(
    accessKeyId: string,
    secretAccessKey: string,
    private readonly bucket: string,
    client?: S3Client,
  ) {
    this.client =
      client ??
      new S3Client({
        region: "us-east-1",
        endpoint: "https://s3.filebase.com",
        forcePathStyle: true,
        credentials: { accessKeyId, secretAccessKey },
      });
  }

  async add(content: Blob, filename: string): Promise<string> {
    const bytes = Buffer.from(await content.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    const key = `pins/${digest}/${filename}`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentLength: bytes.byteLength,
        ContentType: content.type || "application/octet-stream",
      }),
    );
    const head = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const cid = head.Metadata?.cid;
    if (!cid || !isIpfsCid(cid)) throw new Error("Filebase returned an invalid CID");
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
    return { cid, status: "queued" };
  }
}
