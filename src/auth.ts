import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { JbcenterEnv } from "./types.js";

export type ApiKey = { name: string; secret: string; role?: "client" | "reconciler" };

export function parseApiKeys(
  value: string | undefined,
  role: "client" | "reconciler" = "client",
): ApiKey[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf(":");
      if (separator < 1 || separator === entry.length - 1) {
        throw new Error("JBCENTER_API_KEYS entries must use client-name:secret");
      }
      return { name: entry.slice(0, separator), secret: entry.slice(separator + 1), role };
    });
}

const digest = (value: string) => createHash("sha256").update(value).digest();

export function authenticate(keys: ApiKey[], header: string | undefined): ApiKey | null {
  if (!header?.startsWith("Bearer ")) return null;
  const candidate = digest(header.slice(7));
  return keys.find((key) => timingSafeEqual(candidate, digest(key.secret))) ?? null;
}

export function apiKeyAuth(keys: ApiKey[]): MiddlewareHandler<JbcenterEnv> {
  return async (c, next) => {
    const key = authenticate(keys, c.req.header("authorization"));
    if (!key) {
      return c.json(
        { error: { code: "unauthorized", message: "A valid bearer API key is required" } },
        401,
      );
    }
    c.set("client", key.name);
    c.set("role", key.role ?? "client");
    await next();
  };
}
