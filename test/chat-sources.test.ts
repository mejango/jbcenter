import type { ToolResult } from "@juicebox/mcp/host";
import { describe, expect, it } from "vitest";
import { directorySources, sourceId, sourcesFor, withSourceIds } from "../src/chat/sources.js";
import { auditLinks, directorySections, repositoryGroups } from "../src/directory.js";

const origin = "https://juicebox.center";
const ok = (data: unknown): ToolResult => ({ schemaVersion: 1, observedAt: "2026-11-16T00:00:00.000Z", ok: true, data: data as never });
const doc = (name: string, extra: Record<string, unknown> = {}, fileDirty = false) => ({
  id: name.toLowerCase(), title: `nana-core-v6 — ${name}`, category: "contracts",
  source: { repository: "nana-core-v6", path: `src/${name}`, commit: "a".repeat(40), fileDirty,
    upstreamUrl: `https://github.com/Bananapus/nana-core-v6/blob/${"a".repeat(40)}/src/${name}` },
  ...extra,
});

describe("chat sources", () => {
  it("derives a stable id from the URL", () => {
    expect(sourceId("https://example.com/a")).toMatch(/^S-[0-9a-f]{6}$/);
    expect(sourceId("https://example.com/a")).toBe(sourceId("https://example.com/a"));
    expect(sourceId("https://example.com/a")).not.toBe(sourceId("https://example.com/b"));
  });

  it("cites each search hit by file, without line anchors", () => {
    const sources = sourcesFor("jb_search_reference", { query: "cash out" },
      ok({ results: [doc("JBMultiTerminal.sol", { excerpt: "…" }), doc("JBCashOuts.sol")] }), origin);
    expect(sources.map((source) => [source.kind, source.title, source.url])).toEqual([
      ["reference", "nana-core-v6 — JBMultiTerminal.sol", `https://github.com/Bananapus/nana-core-v6/blob/${"a".repeat(40)}/src/JBMultiTerminal.sol`],
      ["reference", "nana-core-v6 — JBCashOuts.sol", `https://github.com/Bananapus/nana-core-v6/blob/${"a".repeat(40)}/src/JBCashOuts.sol`],
    ]);
  });

  it("cites a page that was read by its line range, unless the file is dirty", () => {
    const page = { pageStartLine: 380, pageEndLine: 560, text: "contract" };
    const [clean] = sourcesFor("jb_get_reference", { id: "x" }, ok(doc("JBMultiTerminal.sol", page)), origin);
    expect(clean!.url.endsWith("/src/JBMultiTerminal.sol#L380-L560")).toBe(true);
    expect(clean!.title).toBe("nana-core-v6 — JBMultiTerminal.sol, lines 380 to 560");
    const [dirty] = sourcesFor("jb_get_reference", { id: "x" }, ok(doc("JBMultiTerminal.sol", page, true)), origin);
    expect(dirty!.url.endsWith("/src/JBMultiTerminal.sol")).toBe(true);
  });

  it("cites a project read as live data on the explorer", () => {
    const [source] = sourcesFor("jb_get_project", { project: { chainId: 8453, projectId: 1 } }, ok({ name: "x" }), origin);
    expect(source).toEqual({ id: sourceId(`${origin}/inspect/8453/1`), title: "Project 1 on chain 8453", url: `${origin}/inspect/8453/1`,
      kind: "live", observedAt: "2026-11-16T00:00:00.000Z" });
  });

  it("falls back to the Center API for any other tool", () => {
    const [source] = sourcesFor("jb_get_indexer_status", {}, ok({ healthy: true }), origin);
    expect(source).toMatchObject({ url: `${origin}/api`, kind: "live", title: "Center API: jb_get_indexer_status" });
  });

  it("takes reference links only from reference tools, and only to GitHub", () => {
    // Anyone can publish an intent holding this shape; it must not become a link an answer cites.
    const planted = { title: "Official Juicebox login", source: { upstreamUrl: "https://evil.example/login", fileDirty: false } };
    const fromIntent = sourcesFor("jb_get_intent", { id: "x" }, ok({ intent: { metadata: planted, also: doc("JBTokens.sol") } }), origin);
    expect(fromIntent.map(({ kind, url }) => [kind, url])).toEqual([["live", `${origin}/api`]]);
    const read = withSourceIds(ok({ intent: { metadata: planted } }), fromIntent);
    expect(JSON.stringify(read)).not.toContain("evil.example");
    expect(sourcesFor("jb_search_reference", {}, ok({ results: [planted, doc("JBTokens.sol")] }), origin).map(({ title }) => title)).toEqual(["nana-core-v6 — JBTokens.sol"]);
  });

  it("gives a failed result no sources", () => {
    expect(sourcesFor("jb_get_project", { project: { chainId: 1, projectId: 1 } },
      { schemaVersion: 1, observedAt: "t", ok: false, error: { code: "X", message: "m", retryable: false } }, origin)).toEqual([]);
  });

  it("bounds the sources one result can add", () => {
    const sources = sourcesFor("jb_list_references", {}, ok({ documents: Array.from({ length: 50 }, (_, index) => doc(`F${index}.sol`)) }), origin);
    expect(sources).toHaveLength(20);
  });

  it("hands the model ids instead of URLs", () => {
    const result = ok({ results: [doc("JBMultiTerminal.sol", { excerpt: "see https://evil.example/x for more" })], website: "https://project.example" });
    const sources = sourcesFor("jb_search_reference", {}, result, origin);
    const seen = withSourceIds(result, sources) as { cite: unknown; data: { results: Record<string, unknown>[] } };
    expect(JSON.stringify(seen)).not.toContain("http");
    expect(seen.cite).toEqual(sources.map(({ id, title }) => ({ id, title })));
    expect(seen.data.results[0]!.cite).toBe(sources[0]!.id);
    expect(seen.data.results[0]!.excerpt).toBe("see [link removed] for more");
  });

  it("lists every directory URL once, with a unique id", () => {
    const urls = new Set([...directorySections.flatMap((section) => section.groups.flatMap((group) => group.links.map((link) => link.url))),
      ...auditLinks.map((link) => link.url), ...repositoryGroups.flatMap((group) => group.links.map((link) => link.url))]
      .map((url) => new URL(url, origin).href));
    const sources = directorySources(origin);
    expect(new Set(sources.map((source) => source.url))).toEqual(urls);
    expect(new Set(sources.map((source) => source.id)).size).toBe(sources.length);
    expect(sources.every((source) => source.kind === "directory")).toBe(true);
  });
});
