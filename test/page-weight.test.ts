import { readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createProtocolOperations, createServices, loadConfig } from "@juicebox/mcp/host";
import { build } from "esbuild";
import { expect, it } from "vitest";
// @ts-expect-error The build script is plain ESM without declarations.
import { minifyScript, webBuildOptions } from "../scripts/rest/build-web.mjs";
import { FAVICON_SVG } from "../src/branding.js";
import { HOMEPAGE_HTML, homepageAssets } from "../src/homepage.js";
import { getContractCatalog } from "../src/rest/contracts/catalog.js";
import { guidePage } from "../src/rest/docs/guide.js";
import { apiDocsCss, apiDocsPage, apiReferencePages, apiSearchTerms, buildRestOpenApi } from "../src/rest/docs/index.js";
import { createIndexerReadService } from "../src/rest/indexer/index.js";
import { REST_DOCUMENTS } from "../src/rest/site.js";
import { hashedAssetName, type AssetNames } from "../src/rest/web/assets.js";
import { accountsCss, accountsPage } from "../src/rest/web/page.js";
import { walletDeviceCss, walletDevicePage } from "../src/rest/web/walletDevicePage.js";
import { walletCss, walletPage } from "../src/rest/web/walletPage.js";
import { walletPaymentCss, walletPaymentPage } from "../src/rest/web/walletPaymentPage.js";
import { walletRecoveryCss, walletRecoveryPage } from "../src/rest/web/walletRecoveryPage.js";
import { walletSignupCss, walletSignupPage } from "../src/rest/web/walletSignupPage.js";

// Gzip bytes of each served page: its HTML plus every script, stylesheet and icon the HTML links.
// Ceilings sit at the measured size rounded up to the next 0.5 KiB. Raise one only for bytes the
// page needs on first view; anything else loads on demand and gets its own ceiling below.
const pageCeilings: Record<string, number> = {
  "/": 14_848, "/api": 25_600, "/api/docs/* (largest)": 19_968, "/accounts": 76_800,
  "wallet /": 12_288, "wallet signup": 19_456, "wallet /payment": 25_088, "wallet /recover": 20_480, "wallet /add": 13_312,
};
// What loads after the first view: the backup kit, one journey map, one endpoint's tables, the filter's term index.
const onDemandCeilings: Record<string, number> = {
  "wallet-recovery-kit.js": 42_496, "journey map (largest)": 4_608, "/api/reference/* (largest)": 7_168,
  "/api/terms.json": 23_040,
};
// Every bundle the build emits needs a ceiling, so a new page or chunk cannot escape the gate.
const bundleCeilings: Record<string, number> = {
  accounts: 68_096, docs: 1_024, wallet: 9_216, "wallet-device": 10_240, "wallet-payment": 21_504,
  "wallet-recovery": 16_384, "wallet-recovery-kit": 42_496, "wallet-signup": 15_360,
};

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
  // Production serves directory.js minified (scripts/rest/copy-assets.mjs); the HTML is the same size either way.
  const source = homepageAssets(), home = { ...source, "directory.js": minifyScript(source["directory.js"]!) as string };
  const docs = { "docs.js": bundles.docs!, "api.css": apiDocsCss, "favicon.svg": FAVICON_SVG };
  const accounts = { "accounts.js": bundles.accounts!, "accounts.css": accountsCss(), "accounts-icon.svg": FAVICON_SVG };
  const wallet = { "wallet.js": bundles.wallet!, "wallet.css": walletCss(), "wallet-payment.js": bundles["wallet-payment"]!, "wallet-payment.css": walletPaymentCss(),
    "wallet-signup.js": bundles["wallet-signup"]!, "wallet-signup.css": walletSignupCss(), "wallet-recovery.js": bundles["wallet-recovery"]!,
    "wallet-recovery.css": walletRecoveryCss(), "wallet-device.js": bundles["wallet-device"]!, "wallet-device.css": walletDeviceCss(),
    "wallet-recovery-kit.js": bundles["wallet-recovery-kit"]! };
  const guides = await Promise.all(REST_DOCUMENTS.map(async name => guidePage(name.toLowerCase(), await readFile(new URL(`../docs/rest/${name}.md`, import.meta.url), "utf8"), names(docs))));
  const pages: Record<string, [string, Record<string, string>]> = {
    "/": [HOMEPAGE_HTML.replace(hashedAssetName("directory.js", source["directory.js"]!), hashedAssetName("directory.js", home["directory.js"])), home],
    "/api": [apiDocsPage(spec, names(docs)), docs],
    "/api/docs/* (largest)": [guides.reduce((a, b) => gz(a) >= gz(b) ? a : b), docs],
    "/accounts": [accountsPage({ audience: origin, scriptPath: `/assets/${hashedAssetName("accounts.js", accounts["accounts.js"])}`,
      stylePath: `/assets/${hashedAssetName("accounts.css", accounts["accounts.css"])}`, faviconPath: `/assets/${hashedAssetName("accounts-icon.svg", FAVICON_SVG)}` }), accounts],
    "wallet /": [walletPage(true, true, "", names(wallet)), wallet],
    "wallet signup": [walletSignupPage({ base: "", assets: names(wallet) }), wallet],
    "wallet /payment": [walletPaymentPage("", names(wallet)), wallet],
    "wallet /recover": [walletRecoveryPage({ base: "", assets: names(wallet) }), wallet],
    "wallet /add": [walletDevicePage({ base: "", assets: names(wallet) }), wallet],
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
    "wallet-recovery-kit.js": gz(wallet["wallet-recovery-kit.js"]),
    "journey map (largest)": Math.max(...Object.entries(home).filter(([file]) => file.startsWith("journey-")).map(([, body]) => gz(body))),
    "/api/reference/* (largest)": Math.max(...Array.from(apiReferencePages(spec, names(docs)).values(), gz)),
    "/api/terms.json": gz(JSON.stringify(apiSearchTerms(spec))),
  };
  for (const [piece, ceiling] of Object.entries(onDemandCeilings)) expect(onDemand[piece], piece).toBeLessThanOrEqual(ceiling);
  // PAGE_WEIGHT_REPORT=<file> writes the measured sizes, for the PR table and for lowering ceilings.
  if (process.env.PAGE_WEIGHT_REPORT) await writeFile(process.env.PAGE_WEIGHT_REPORT, JSON.stringify({ pages: sizes, onDemand }, null, 1));
}, 60_000);
