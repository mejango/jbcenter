import { createHash } from "node:crypto";
import type { ToolResult } from "@juicebox/mcp/host";
import { auditLinks, directorySections, repositoryGroups } from "../directory.js";

/** Something an answer can cite. The model sees the id and title, never the URL. */
export type Source = {
  id: string;
  title: string;
  url: string;
  kind: "reference" | "live" | "directory";
  observedAt?: string;
};

/** The same URL has the same id in every request, so a stateless server needs no counter. */
export const sourceId = (url: string): string => `S-${createHash("sha256").update(url).digest("hex").slice(0, 6)}`;

// ponytail: a catalog listing names hundreds of documents; an answer cites a handful.
const MAX_SOURCES_PER_RESULT = 20;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>)\]]+/gi;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** A reference document as the knowledge service describes it: a title and a pinned upstream file. */
function referenceOf(value: Json): Source | undefined {
  const { source, title } = value;
  if (!isObject(source) || typeof source.upstreamUrl !== "string" || typeof title !== "string") return undefined;
  const { pageStartLine: start, pageEndLine: end } = value;
  // A dirty file can differ from its commit link, so its lines are not citable.
  const lines = Number.isInteger(start) && Number.isInteger(end) && source.fileDirty === false;
  const url = lines ? `${source.upstreamUrl}#L${start}-L${end}` : source.upstreamUrl;
  return { id: sourceId(url), title: lines ? `${title}, lines ${start} to ${end}` : title, url, kind: "reference" };
}

function walk(value: unknown, visit: (object: Json) => void): void {
  if (Array.isArray(value)) for (const item of value) walk(item, visit);
  else if (isObject(value)) {
    visit(value);
    for (const item of Object.values(value)) walk(item, visit);
  }
}

function projectOf(input: unknown): { chainId: number; projectId: number } | undefined {
  if (!isObject(input)) return undefined;
  for (const candidate of [input, input.project]) {
    if (isObject(candidate) && Number.isInteger(candidate.chainId) && Number.isInteger(candidate.projectId))
      return { chainId: candidate.chainId as number, projectId: candidate.projectId as number };
  }
  return undefined;
}

/** What a tool result lets an answer cite: its reference documents, else the project, else the API. */
export function sourcesFor(tool: string, input: unknown, result: ToolResult, origin: string): Source[] {
  if (!result.ok) return [];
  const references = new Map<string, Source>();
  walk(result.data, (object) => {
    const source = referenceOf(object);
    if (source && references.size < MAX_SOURCES_PER_RESULT) references.set(source.id, source);
  });
  if (references.size > 0) return [...references.values()];
  const project = projectOf(input);
  const live = project
    ? { url: `${origin}/inspect/${project.chainId}/${project.projectId}`, title: `Project ${project.projectId} on chain ${project.chainId}` }
    : { url: `${origin}/api`, title: `Center API: ${tool}` };
  return [{ id: sourceId(live.url), ...live, kind: "live", observedAt: result.observedAt }];
}

/** The result as the model reads it: source ids in place of provenance, and no URL anywhere. */
export function withSourceIds(result: ToolResult, sources: Source[]): unknown {
  const ids = new Set(sources.map((source) => source.id));
  const strip = (value: unknown): unknown => {
    if (typeof value === "string") return value.replace(URL_IN_TEXT, "[link removed]");
    if (Array.isArray(value)) return value.map(strip);
    if (!isObject(value)) return value;
    const reference = referenceOf(value);
    const entries = Object.entries(value)
      .filter(([key]) => !(reference && key === "source"))
      .map(([key, item]) => [key, strip(item)] as const);
    return Object.fromEntries(reference && ids.has(reference.id) ? [["cite", reference.id], ...entries] : entries);
  };
  return { cite: sources.map(({ id, title }) => ({ id, title })), ...(strip(result) as Json) };
}

/** Every directory row and repository as a source, so the model can point at an app or guide by id. */
export function directorySources(origin: string): Source[] {
  const rows = [
    ...directorySections.flatMap((section) => section.groups.flatMap((group) => group.links.map((link) => ({ title: link.name, url: link.url })))),
    ...auditLinks.map((link) => ({ title: link.name, url: link.url })),
    ...repositoryGroups.flatMap((group) => group.links.map((link) => ({ title: link.title, url: link.url }))),
  ];
  const byUrl = new Map<string, Source>();
  for (const { title, url } of rows) {
    const href = new URL(url, origin).href;
    if (!byUrl.has(href)) byUrl.set(href, { id: sourceId(href), title, url: href, kind: "directory" });
  }
  return [...byUrl.values()];
}
