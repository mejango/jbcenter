import { CID } from "multiformats/cid";

const FILEBASE_ADD_URL = "https://rpc.filebase.io/api/v0/add?pin=true&cid-version=0";
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

export class RedundantIpfsPinning implements PinningService {
  constructor(
    private readonly filebaseToken: string,
    private readonly pinataJwt: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async pin(content: Blob, filename: string): Promise<PinResult> {
    const form = new FormData();
    form.append("file", content, filename);
    const filebase = await this.fetcher(FILEBASE_ADD_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.filebaseToken}` },
      body: form,
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!filebase.ok) throw new Error(`Filebase add failed (${filebase.status})`);
    const filebaseBody = (await filebase.json()) as { Hash?: unknown };
    if (typeof filebaseBody.Hash !== "string" || !isIpfsCid(filebaseBody.Hash)) {
      throw new Error("Filebase returned an invalid CID");
    }

    const cid = filebaseBody.Hash;
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
