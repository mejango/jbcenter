import { createHash } from "node:crypto";
import type { Hex } from "viem";
import { RestError } from "../core.js";
import { RELAYR_LIMITS } from "./constants.js";

export function fail(code: string, message: string, status = 422): never {
  throw new RestError(status, code, message);
}
export const same = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return fail(
    "INVALID_SPONSORSHIP_INPUT",
    "Sponsorship documents require finite, lossless JSON values.",
    400,
  );
}
export function digest(value: unknown): Hex {
  return `0x${createHash("sha256").update(canonical(value)).digest("hex")}`;
}
export function clone<T>(value: T): T {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > RELAYR_LIMITS.maximumBytes)
    fail(
      "SPONSORSHIP_TOO_LARGE",
      "Sponsorship data exceeds the byte limit.",
      413,
    );
  return JSON.parse(text) as T;
}
export function decimal(value: unknown, label: string, bits = 256): bigint {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,77})$/.test(value) ||
    BigInt(value) >= 1n << BigInt(bits)
  ) {
    return fail(
      "INVALID_SPONSORSHIP_INTEGER",
      `Invalid ${label}; use a bounded canonical decimal string.`,
      400,
    );
  }
  return BigInt(value);
}
export function quantity(value: unknown, label: string): bigint {
  if (
    typeof value !== "string" ||
    !/^0x(0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value)
  )
    return fail(
      "INVALID_RPC_RESPONSE",
      `RPC returned an invalid ${label}.`,
      502,
    );
  return BigInt(value);
}
export function hash(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}
export function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  );
}
export function assertKey(key: string): void {
  if (typeof key !== "string" || !/^[\x21-\x7e]{1,128}$/.test(key))
    fail(
      "INVALID_IDEMPOTENCY_KEY",
      "Use an idempotency key of 1–128 printable non-space characters.",
      400,
    );
}
export function assertSignal(signal?: AbortSignal): void {
  if (signal?.aborted)
    fail("REQUEST_CANCELLED", "The sponsorship request was cancelled.", 499);
}
export const hex = (n: bigint): Hex => `0x${n.toString(16)}`;
