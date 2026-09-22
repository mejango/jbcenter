import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { JbcenterEnv } from "../src/types.js";
import { guidePage } from "../src/rest/docs/guide.js";
import { mountRestSite, REST_DOCUMENTS, type RestSite } from "../src/rest/site.js";

describe("readable developer guides", () => {
  it("renders navigation, code, tables and stable heading links without executing raw HTML", () => {
    const html = guidePage("quickstart", '# Get started\n\n## Connect\n\n[Client](./CLIENT.md#connect-from-node)\n\n```js\nconsole.log("hello");\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>\n\n[x](javascript:alert%281%29)');
    expect(html).toContain('id="connect"');
    expect(html).toContain('href="/api/docs/client#connect-from-node"');
    expect(html).toContain('class="copy-code"');
    expect(html).toContain('<table>');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('aria-current="page"');
  });
  it("keeps Markdown available while serving readable pages and the actual client archive", async () => {
    const app = new Hono<JbcenterEnv>();
    mountRestSite(app, { app: new Hono(), audience: "https://juicebox.center", accountsScript: "", docsScript: "", docsHtml: "", docsCss: "", clientPackage: new Uint8Array([1, 2, 3]), documents: new Map([["quickstart", "# Hello"]]) } as RestSite);
    const html = await app.request('/api/docs/quickstart');
    expect(html.headers.get('content-type')).toContain('text/html');
    expect(await html.text()).toContain('<h1 id="hello">Hello</h1>');
    expect(await (await app.request('/api/docs/quickstart.md')).text()).toBe('# Hello');
    expect(await (await app.request('/api/docs/quickstart', { headers: { accept: 'text/markdown' } })).text()).toBe('# Hello');
    const archive = await app.request('/api/client/juicebox-center-client-0.1.0.tgz');
    expect(archive.headers.get('content-type')).toBe('application/gzip');
    expect(new Uint8Array(await archive.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
  it("lists the project intents guide and keeps every listed document on disk", async () => {
    expect(REST_DOCUMENTS).toContain("PROJECT_INTENTS");
    for (const name of REST_DOCUMENTS) {
      const text = await readFile(new URL(`../docs/rest/${name}.md`, import.meta.url), "utf8");
      expect(text.startsWith("# ")).toBe(true);
    }
  });

  it("serves the project intents guide as a page and as Markdown", async () => {
    const markdown = await readFile(new URL("../docs/rest/PROJECT_INTENTS.md", import.meta.url), "utf8");
    const app = new Hono<JbcenterEnv>();
    mountRestSite(app, {
      app: new Hono(), audience: "https://juicebox.center", accountsScript: "", docsScript: "",
      docsHtml: "", docsCss: "", clientPackage: new Uint8Array([1]),
      documents: new Map([["project-intents", markdown]]),
    } as RestSite);
    const page = await app.request("/api/docs/project-intents");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Project intents");
    expect(html).toContain("/v1/intents/:id/deploy");
    expect(html).not.toContain("<script>alert");
    const raw = await app.request("/api/docs/project-intents.md");
    expect(raw.headers.get("content-type")).toContain("text/markdown");
    expect(await raw.text()).toBe(markdown);
  });

  it("documents the setup-call rule with the canonical Safe addresses", async () => {
    const markdown = await readFile(new URL("../docs/rest/PROJECT_INTENTS.md", import.meta.url), "utf8");
    expect(markdown).toContain("## Setup calls");
    expect(markdown).toContain("0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67");
    expect(markdown).toContain("0x41675C099F32341bf84BFc5382aF534df5C7461a");
    expect(markdown).toContain("0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99");
    expect(markdown).toContain("jb.safes");
    expect(markdown).toContain("1 to 4 calls");
    expect(markdown).not.toMatch(/exactly one .*call per/i);
  });

  it("documents the relay route and the per-chain deploy", async () => {
    const markdown = await readFile(new URL("../docs/rest/PROJECT_INTENTS.md", import.meta.url), "utf8");
    expect(markdown).toContain("## Relay a chain the payer sends");
    expect(markdown).toContain("POST /v1/intents/:id/relay");
    expect(markdown).toContain("sponsored_chain");
    expect(markdown).toContain("relay_limit");
    expect(markdown).toContain("mixed_sender");
    expect(markdown).toContain('"chainIds": [8453]');
    expect(markdown).toContain("the same forwarder nonce");
    expect(markdown).not.toContain("is refused for an\nintent that already has a recorded deployment");
  });
});
