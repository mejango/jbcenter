import { readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createProtocolOperations, createServices, loadConfig } from "@juicebox/mcp/host";
import { build } from "esbuild";
import { expect, it } from "vitest";
// @ts-expect-error The build script is plain ESM without declarations.
import { webBuildOptions } from "../scripts/rest/build-web.mjs";
import { FAVICON_SVG } from "../src/branding.js";
import { HOMEPAGE_HTML, homepageAssets } from "../src/homepage.js";
import { getContractCatalog } from "../src/rest/contracts/catalog.js";
import { guidePage } from "../src/rest/docs/guide.js";
import { apiDocsCss, apiDocsPage, apiReferencePages, apiSearchTerms, buildRestOpenApi } from "../src/rest/docs/index.js";
import { createIndexerReadService } from "../src/rest/indexer/index.js";
import { REST_DOCUMENTS } from "../src/rest/site.js";
import { hashedAssetName, type AssetNames } from "../src/rest/web/assets.js";

// Gzip bytes of each served page: its HTML plus every script, stylesheet and icon the HTML links.
// Ceilings sit at the measured size rounded up to the next 0.5 KiB. Raise one only for bytes the
// page needs on first view; anything else loads on demand and gets its own ceiling below.
const pageCeilings: Record<string, number> = {
  "/": 5_120, "/api": 25_600, "/api/docs/* (largest)": 19_968,
};
const onDemandCeilings: Record<string, number> = {
  "/api/reference/* (largest)": 7_168, "/api/terms.json": 23_040,
};
const bundleCeilings: Record<string, number> = { docs: 1_024 };

const gz = (body: string) => gzipSync(body).length;
// Each link is /<base>/assets/<name>.<hash>.<ext>; the hash must name these exact bytes.
const linked = (html: string, files: Record<string, string>) => Array.from(html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="[^"]*\/assets\/([a-z-]+)\.([0-9a-f]{12})\.(js|css|svg)"/g), ([, stem, hash, ext]) => {
  const file = `${stem}.${ext}`, body = files[file];
  expect(body, file).toBeDefined();
  expect(hashedAssetName(file, body!), file).toBe(`${stem}.${hash}.${ext}`);
  return body!;
});
const names = (files: Record<string, string>): AssetNames => Object.fromEntries(Object.entries(files).map(([file, body]) => [file, hashedAssetName(file, body)]));

it("keeps every served page, bundle and on-demand piece within its ceiling", async () => {
  const result = await build({ ...webBuildOptions, write: false });
  const bundles: Record<string, string> = Object.fromEntries(result.outputFiles!.map(file => [file.path.split("/").pop()!.replace(/\.js$/, ""), file.text]));
  expect(Object.keys(bundles).sort()).toEqual(Object.keys(bundleCeilings).sort());
  for (const [name, ceiling] of Object.entries(bundleCeilings)) expect(gz(bundles[name]!), name).toBeLessThanOrEqual(ceiling);

  const origin = "https://juicebox.center";
  const operations = createProtocolOperations(createServices(loadConfig({ NODE_ENV: "test", PUBLIC_ORIGIN: origin,
    PLAN_SECRET: "openapi-offline-tests-only-32-byte-secret" })));
  const spec = buildRestOpenApi({ contracts: await getContractCatalog(), indexer: createIndexerReadService({}), operations, publicOrigin: origin });
  const home = homepageAssets();
  const docs = { "docs.js": bundles.docs!, "api.css": apiDocsCss, "favicon.svg": FAVICON_SVG };
  const guides = await Promise.all(REST_DOCUMENTS.map(async name => guidePage(name.toLowerCase(), await readFile(new URL(`../docs/rest/${name}.md`, import.meta.url), "utf8"), names(docs))));
  const pages: Record<string, [string, Record<string, string>]> = {
    "/": [HOMEPAGE_HTML, home],
    "/api": [apiDocsPage(spec, names(docs)), docs],
    "/api/docs/* (largest)": [guides.reduce((a, b) => gz(a) >= gz(b) ? a : b), docs],
  };
  expect(Object.keys(pages).sort()).toEqual(Object.keys(pageCeilings).sort());
  const sizes: Record<string, number> = {};
  for (const [page, [html, files]] of Object.entries(pages)) {
    const assets = linked(html, files);
    expect(assets.length, page).toBeGreaterThan(0);
    sizes[page] = gz(html) + assets.reduce((total, body) => total + gz(body), 0);
    expect(sizes[page], page).toBeLessThanOrEqual(pageCeilings[page]!);
  }

  const onDemand: Record<string, number> = {
    "/api/reference/* (largest)": Math.max(...Array.from(apiReferencePages(spec, names(docs)).values(), gz)),
    "/api/terms.json": gz(JSON.stringify(apiSearchTerms(spec))),
  };
  for (const [piece, ceiling] of Object.entries(onDemandCeilings)) expect(onDemand[piece], piece).toBeLessThanOrEqual(ceiling);
  // PAGE_WEIGHT_REPORT=<file> writes the measured sizes, for the PR table and for lowering ceilings.
  if (process.env.PAGE_WEIGHT_REPORT) await writeFile(process.env.PAGE_WEIGHT_REPORT, JSON.stringify({ pages: sizes, onDemand }, null, 1));
}, 60_000);
