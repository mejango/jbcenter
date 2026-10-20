import { createHash } from "node:crypto";
import type { Hono } from "hono";

export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

export interface HashedAsset {
  /** The URL pages link: `/dir/name.<hash>.ext`. */
  href: string;
  /** Hono route matching the hashed name, the plain name and any other hash of the same file. */
  route: string;
  /** Cache-Control for a request path that matched `route`. */
  cacheControl(requestPath: string): string;
}

/** Names a served file by its content. Only this body's own hash is cached for a year. The plain
 * name and other hashes (a page from the previous or next deploy, mid-rollout) get this body
 * uncached, so they still load and never pin the wrong bytes under a hashed URL. */
export function hashedAsset(path: string, body: string | Uint8Array): HashedAsset {
  const slash = path.lastIndexOf("/"), dot = path.lastIndexOf(".");
  if (dot <= slash + 1) throw new Error(`Asset needs a name and extension: ${path}`);
  const dir = path.slice(0, slash), name = path.slice(slash + 1, dot), ext = path.slice(dot + 1);
  const href = `${dir}/${name}.${createHash("sha256").update(body).digest("hex").slice(0, 16)}.${ext}`;
  const literal = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    href,
    route: `${dir}/:file{${literal(name)}(?:\\.[0-9a-f]+)?\\.${literal(ext)}}`,
    cacheControl: requestPath => requestPath === href ? IMMUTABLE_CACHE : "no-store",
  };
}

/** Serves one file under `hashedAsset` naming and returns the href pages should link. */
export function serveHashed(app: Hono<any>, path: string, body: string | Uint8Array, headers: Record<string, string>): string {
  const asset = hashedAsset(path, body);
  app.get(asset.route, c => c.body(body as string, 200, { ...headers, "Cache-Control": asset.cacheControl(c.req.path) }));
  return asset.href;
}
