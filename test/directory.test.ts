import { describe, expect, it } from "vitest";
import { auditLinks, directorySections, repositoryGroupId, repositoryGroups, workInProgress } from "../src/directory.js";
import { HOMEPAGE_CSS, HOMEPAGE_HTML } from "../src/homepage.js";
import { llmsIndex } from "../src/llms.js";

const origin = "https://juicebox.center";
const finishedLinks = [...directorySections.flatMap((section) => section.groups.flatMap((group) => group.links)), ...auditLinks];
const links = [...finishedLinks, ...workInProgress];
const urls = [...links.map((link) => link.url), ...repositoryGroups.flatMap((group) => group.links.map((link) => link.url))];

describe("directory", () => {
  it("routes every row to a secure page, one of Center's own, or a section of this page", () => {
    const ids = new Set(Array.from(HOMEPAGE_HTML.matchAll(/ id="([^"]+)"/g), ([, id]) => id));
    for (const url of urls) {
      if (url.startsWith("#")) expect(ids, url).toContain(url.slice(1));
      else if (!url.startsWith("/")) expect(new URL(url).protocol, url).toBe("https:");
    }
    for (const section of directorySections) expect(ids).toContain(section.id);
    // Fragments other pages may already link.
    for (const id of ["apps", "projects", "developers", "api", "agents", "auditors", "wip", "repositories"]) expect(ids).toContain(id);
    expect(new Set(directorySections.map((section) => section.id)).size).toBe(directorySections.length);
    for (const group of repositoryGroups) expect(ids).toContain(repositoryGroupId(group.title));
  });

  it("keeps rows short enough to scan", () => {
    for (const { need, name, note } of links) {
      expect(need.length, need).toBeLessThanOrEqual(32);
      expect(name.length, name).toBeLessThanOrEqual(18);
      expect((note ?? "").length, note).toBeLessThanOrEqual(56);
    }
  });

  it("keeps unfinished tools out of the finished sections, each with its status", () => {
    const finished = new Set(finishedLinks.map((link) => link.url));
    for (const tool of workInProgress) {
      expect(finished.has(tool.url), tool.name).toBe(false);
      expect(tool.note).not.toBe("");
    }
  });

  it("shows the page and the text index the same destinations, without scripts or middots", () => {
    const text = llmsIndex(origin);
    const escaped = (value: string) => value.replace(/&/g, "&amp;");
    for (const url of urls) {
      expect(HOMEPAGE_HTML, url).toContain(`href="${escaped(url)}"`);
      if (!url.startsWith("#")) expect(text, url).toContain(`(${new URL(url, origin).href})`);
    }
    for (const body of [HOMEPAGE_HTML, HOMEPAGE_CSS, text]) expect(body).not.toMatch(/·|&middot;/);
    expect(HOMEPAGE_HTML).not.toContain("<script");
    expect(HOMEPAGE_HTML).toContain('<link rel="alternate" type="text/markdown" href="/llms.txt"');
  });
});
