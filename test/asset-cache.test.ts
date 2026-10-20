import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { IMMUTABLE_CACHE, hashedAssetName, mountAssets } from "../src/rest/web/assets.js";
import { apiDocsCss, apiDocsPage, docsAssetNames, type OpenApiDocument } from "../src/rest/docs/index.js";
import { mountRestSite, type RestSite } from "../src/rest/site.js";
import type { JbcenterEnv } from "../src/types.js";
import { MemoryStore } from "./support/memoryStore.js";

const origin = "https://juicebox.center";
const links = (html: string) => Array.from(html.matchAll(/(?:src|href)="(\/[^"#?]+\.(?:js|css|svg))"/g), match => match[1]!);

describe("hashed assets", () => {
  it("caches only the current hash, and serves the same body uncached under any other name", async () => {
    const app = new Hono();
    const href = `/assets/${mountAssets(app, "", { "app.js": "current" })["app.js"]}`;
    expect(href).toBe(`/assets/${hashedAssetName("app.js", "current")}`);
    expect(href).toMatch(/^\/assets\/app\.[0-9a-f]{12}\.js$/);
    const current = await app.request(href);
    expect(current.headers.get("cache-control")).toBe(IMMUTABLE_CACHE);
    expect(await current.text()).toBe("current");
    // A page from the previous deploy (old hash) or an unhashed link still loads, without pinning these bytes.
    for (const path of ["/assets/app.js", `/assets/${hashedAssetName("app.js", "previous")}`]) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("current");
    }
    for (const path of ["/assets/app.x.js", "/assets/application.js", "/assets/app.0123.js", "/assets/app.css", "/other/app.js"])
      expect((await app.request(path)).status).toBe(404);
  });

  it("links every homepage, docs and accounts asset under an immutable hash; pages stay short-lived", async () => {
    const app = createApp(new MemoryStore());
    const rest = new Hono<JbcenterEnv>();
    const docsScript = "console.log('docs')";
    const spec = { openapi: "3.1.2", info: {}, paths: {}, tags: [] } as unknown as OpenApiDocument;
    mountRestSite(rest, { app: new Hono() as unknown as RestSite["app"], audience: origin, accountsScript: "console.log('accounts')",
      docsHtml: apiDocsPage(spec, docsAssetNames(docsScript)), apiReference: new Map([["readThing", "<p>fields</p>"]]),
      docsCss: apiDocsCss, docsScript, documents: new Map([["quickstart", "# Get started"]]) });
    const pages: [Hono<JbcenterEnv>, string, string][] = [
      [app, "/", "public, max-age=300"],
      [rest, "/api", "public, max-age=300"],
      [rest, "/api/docs/quickstart", "public, max-age=300"],
      [rest, "/accounts", "no-store"],
    ];
    for (const [site, path, cache] of pages) {
      const page = await site.request(origin + path);
      expect(page.headers.get("cache-control"), path).toBe(cache);
      const assets = links(await page.text());
      expect(assets.length, path).toBeGreaterThan(0);
      for (const asset of assets) {
        expect(asset, path).toMatch(/^\/assets\/[a-z-]+\.[0-9a-f]{12}\.(?:js|css|svg)$/);
        // The favicon is Center's own route; the REST mount shares it in production.
        const own = await site.request(origin + asset), response = own.status === 404 ? await app.request(origin + asset) : own;
        expect(response.status, asset).toBe(200);
        expect(response.headers.get("cache-control"), asset).toBe(IMMUTABLE_CACHE);
      }
    }
    const reference = await rest.request(origin + "/api/reference/readThing");
    expect(reference.headers.get("cache-control")).toBe("public, max-age=300");
    expect((await rest.request(origin + "/api/reference/missing")).status).toBe(404);
    const terms = await rest.request(origin + "/api/terms.json");
    expect(terms.headers.get("cache-control")).toBe("public, max-age=300");
    expect(terms.headers.get("content-type")).toContain("application/json");
    // One URL serves HTML or Markdown by Accept, so a cache must key on it.
    const markdown = await rest.request(origin + "/api/docs/quickstart", { headers: { Accept: "text/markdown" } });
    expect(markdown.headers.get("content-type")).toContain("text/markdown");
    expect(markdown.headers.get("vary")).toBe("Accept");
    expect((await rest.request(origin + "/api/docs/quickstart")).headers.get("vary")).toBe("Accept");
  });
});
