import { readFile } from "node:fs/promises";
import type { Hono } from "hono";
import type { JbcenterEnv } from "../types.js";
import type { createRestApp } from "./app.js";
import { guidePage } from "./docs/guide.js";
import { accountsCss, accountsPage } from "./web/page.js";

export const REST_PAGE_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
} as const;

// Para authentication and signing run only on Accounts. API docs keep their narrower policy.
export const ACCOUNTS_PAGE_HEADERS = {
  ...REST_PAGE_HEADERS,
  "Content-Security-Policy": "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self' https://*.getpara.com https://*.usecapsule.com wss://*.getpara.com wss://*.usecapsule.com https://*.publicnode.com; img-src 'self' data: blob:; frame-src https://app.beta.getpara.com https://app.getpara.com https://app.beta.usecapsule.com https://app.usecapsule.com; worker-src 'self' blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
} as const;

export interface RestSite {
  app: ReturnType<typeof createRestApp>;
  audience: string;
  para?: { apiKey: string; environment: "BETA" | "PROD" };
  paraScript?: string;
  accountsScript: string;
  docsScript?: string;
  clientPackage?: Uint8Array;
  docsHtml: string;
  docsCss: string;
  documents: ReadonlyMap<string, string>;
}

export async function readRestAssets() {
  const accountsScript = await readFile(
    new URL("../../.generated/rest/accounts.js", import.meta.url),
    "utf8",
  );
  const documents = new Map<string, string>();
  for (const name of [
    "ARCHITECTURE",
    "QUICKSTART",
    "CLIENT",
    "USER_JOURNEYS",
    "AUTHENTICATION",
    "API",
    "AI_GUIDE",
    "CONTRACTS",
    "INDEXER",
    "TRANSACTIONS",
    "OMNICHAIN",
    "SPONSORSHIP",
    "SMART_ACCOUNTS",
    "SESSIONS",
    "EXECUTION_OPERATIONS",
    "PRODUCTION_CHECK",
    "PRODUCTION_OPERATIONS",
  ]) {
    const content = await readFile(
      new URL(`../../docs/rest/${name}.md`, import.meta.url),
      "utf8",
    );
    documents.set(name.toLowerCase(), content);
    documents.set(name.toLowerCase().replaceAll("_", "-"), content);
  }
  const paraScript = await readFile(new URL("../../.generated/rest/para.js", import.meta.url), "utf8");
  const docsScript = await readFile(new URL("../../.generated/rest/docs.js", import.meta.url), "utf8");
  const clientPackage = new Uint8Array(await readFile(new URL("../../.generated/rest/juicebox-center-client-0.1.0.tgz", import.meta.url)));
  return { accountsScript, paraScript, documents, docsScript, clientPackage };
}

export function mountRestSite(app: Hono<JbcenterEnv>, site: RestSite): void {
  app.route("/api/v1", site.app);
  app.get("/accounts", (context) =>
    context.html(
      accountsPage({ audience: site.audience, ...(site.para ? { para: site.para } : {}) }),
      200,
      ACCOUNTS_PAGE_HEADERS,
    ),
  );
  app.get("/assets/accounts.css", (context) =>
    context.body(accountsCss(), 200, {
      ...REST_PAGE_HEADERS,
      "Content-Type": "text/css; charset=utf-8",
    }),
  );
  app.get("/assets/accounts.js", (context) =>
    context.body(site.accountsScript, 200, {
      ...REST_PAGE_HEADERS,
      "Content-Type": "application/javascript; charset=utf-8",
    }),
  );
  app.get("/assets/para.js", (context) => context.body(site.paraScript ?? "", 200, { ...ACCOUNTS_PAGE_HEADERS, "Content-Type": "application/javascript; charset=utf-8" }));
  app.get("/assets/docs.js", (context) => context.body(site.docsScript ?? "", 200, { ...REST_PAGE_HEADERS, "Content-Type": "application/javascript; charset=utf-8" }));
  app.get("/api/client/juicebox-center-client-0.1.0.tgz", (context) => {
    if (!site.clientPackage) return context.notFound();
    return new Response(site.clientPackage as BodyInit, { headers: { "Content-Type": "application/gzip", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache", "Content-Disposition": 'attachment; filename="juicebox-center-client-0.1.0.tgz"' } });
  });
  app.get("/api", (context) =>
    context.html(site.docsHtml, 200, REST_PAGE_HEADERS),
  );
  app.get("/assets/api.css", (context) =>
    context.body(site.docsCss, 200, {
      ...REST_PAGE_HEADERS,
      "Content-Type": "text/css; charset=utf-8",
    }),
  );
  app.get("/api/docs/:name", (context) => {
    const name = context.req.param("name").replace(/\.md$/i, "").toLowerCase();
    const document = site.documents.get(name);
    if (!document)
      return context.json(
        {
          error: {
            code: "DOCUMENT_NOT_FOUND",
            message: "Choose a document linked from /api",
          },
        },
        404,
      );
    if (!context.req.param("name").endsWith(".md") && !context.req.header("Accept")?.includes("text/markdown"))
      return context.html(guidePage(name, document), 200, REST_PAGE_HEADERS);
    return context.text(document, 200, {
      ...REST_PAGE_HEADERS,
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
  });
}
