import { getAddress, isAddress, type Address } from "viem";
import type { IntentMetadata, Json } from "./types.js";

const text = (value: Json | undefined, max: number): string | null =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

export function extractMetadata(jb: Record<string, Json>): IntentMetadata {
  const root = jb.app === "revnet.money" && jb.data && typeof jb.data === "object" && !Array.isArray(jb.data)
    ? jb.data
    : jb;
  const links = root.links && typeof root.links === "object" && !Array.isArray(root.links)
    ? root.links
    : {};
  const rawOwner = text(root.owner, 64);
  const owner: Address | null = rawOwner && isAddress(rawOwner) ? getAddress(rawOwner) : null;
  const tags = Array.isArray(root.tags)
    ? root.tags
        .filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
        .map((tag) => tag.trim().slice(0, 30))
        .slice(0, 10)
    : [];

  return {
    name: text(root.name, 100) ?? "Untitled project",
    description: text(root.description, 10_000),
    tagline: text(root.tagline ?? root.projectTagline, 200),
    tags,
    logoUri: text(root.logoUri ?? root.logo ?? links.logoUri, 1_000),
    owner,
  };
}
