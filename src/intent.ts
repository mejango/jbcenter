import { getAddress, keccak256, size, toBytes, type Address, type Hex } from "viem";
import type { DeploymentCall, IntentEnvelope, Json } from "./types.js";

const MAX_DEPTH = 64;
const MAX_CALL_DATA_BYTES = 4 * 1024 * 1024;
const FORMAT = /^[a-z0-9.-]{1,80}\/[a-zA-Z0-9._-]{1,32}$/u;

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function asJson(value: unknown, depth = 0): Json {
  if (depth > MAX_DEPTH) throw new Error(`jb exceeds the ${MAX_DEPTH}-level nesting limit`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => asJson(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        asJson(item, depth + 1),
      ]),
    );
  }
  throw new Error("jb contains a value JSON cannot represent");
}

function draftChainIds(jb: Record<string, Json>): number[] | null {
  const root = jb.app === "revnet.money" && jb.data && typeof jb.data === "object" && !Array.isArray(jb.data)
    ? jb.data
    : jb;
  const value = root.chainIds ?? root.chains;
  if (!Array.isArray(value)) return null;
  return value
    .filter((chainId): chainId is number => Number.isSafeInteger(chainId) && Number(chainId) > 0)
    .sort((a, b) => a - b);
}

function deploymentCalls(value: unknown, chainIds: number[]): DeploymentCall[] {
  if (!Array.isArray(value) || value.length !== chainIds.length) {
    throw new Error("deploymentCalls must contain exactly one call for each chainId");
  }
  const calls = value.map((item, index) => {
    const raw = object(item, `deploymentCalls[${index}]`);
    const chainId = Number(raw.chainId);
    if (!Number.isSafeInteger(chainId) || chainId <= 0) {
      throw new Error(`deploymentCalls[${index}].chainId must be a positive safe integer`);
    }
    const to = address(raw.to, `deploymentCalls[${index}].to`);
    if (typeof raw.data !== "string" || !/^0x(?:[0-9a-f]{2}){4,}$/iu.test(raw.data)) {
      throw new Error(`deploymentCalls[${index}].data must be contract calldata`);
    }
    if (size(raw.data as Hex) > MAX_CALL_DATA_BYTES) {
      throw new Error(`deploymentCalls[${index}].data exceeds ${MAX_CALL_DATA_BYTES} bytes`);
    }
    return { chainId, to, data: raw.data.toLowerCase() as Hex };
  });
  const callChainIds = calls.map(({ chainId }) => chainId).sort((a, b) => a - b);
  if (JSON.stringify(callChainIds) !== JSON.stringify(chainIds)) {
    throw new Error("deploymentCalls must contain exactly one call for each chainId");
  }
  return calls.sort((a, b) => a.chainId - b.chainId);
}

export function normalizeEnvelope(value: unknown): IntentEnvelope {
  const raw = object(value, "request");
  const format = typeof raw.format === "string" ? raw.format.trim() : "";
  const deploymentVersion =
    typeof raw.deploymentVersion === "string" ? raw.deploymentVersion.trim() : "";
  if (!FORMAT.test(format)) throw new Error("format must look like juicebox.money/v1");
  if (!deploymentVersion || deploymentVersion.length > 64) {
    throw new Error("deploymentVersion must be between 1 and 64 characters");
  }
  if (!Array.isArray(raw.chainIds) || raw.chainIds.length === 0 || raw.chainIds.length > 16) {
    throw new Error("chainIds must contain between 1 and 16 chains");
  }
  const chainIds = [...new Set(raw.chainIds.map(Number))].sort((a, b) => a - b);
  if (
    chainIds.length !== raw.chainIds.length ||
    chainIds.some((chainId) => !Number.isSafeInteger(chainId) || chainId <= 0)
  ) {
    throw new Error("chainIds must contain unique positive safe integers");
  }
  const jb = asJson(object(raw.jb, "jb")) as Record<string, Json>;
  const declared = draftChainIds(jb);
  if (declared && JSON.stringify(declared) !== JSON.stringify(chainIds)) {
    throw new Error("chainIds must match the chains declared by the .jb file");
  }
  return {
    format,
    deploymentVersion,
    chainIds,
    deploymentCalls: deploymentCalls(raw.deploymentCalls, chainIds),
    jb,
  };
}

export function canonicalJson(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
}

export function contentHash(envelope: IntentEnvelope): Hex {
  return keccak256(toBytes(canonicalJson(envelope as unknown as Json)));
}

export function signingMessage(hash: Hex): string {
  // Keep the original domain separator so already-issued signatures remain valid.
  return `Juice Central project intent\nVersion: 1\nContent hash: ${hash}`;
}

export function address(value: unknown, name: string): Address {
  if (typeof value !== "string") throw new Error(`${name} must be an Ethereum address`);
  try {
    return getAddress(value);
  } catch {
    throw new Error(`${name} must be an Ethereum address`);
  }
}
