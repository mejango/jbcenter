import { createHash, timingSafeEqual } from "node:crypto";

const digest = (value: string) => createHash("sha256").update(value).digest();

export function authenticate(secret: string, header: string | undefined): boolean {
  const candidate = header?.startsWith("Bearer ") ? header.slice(7) : "";
  return timingSafeEqual(digest(candidate), digest(secret));
}
