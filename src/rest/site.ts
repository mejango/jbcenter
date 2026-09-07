import { readFile } from "node:fs/promises";
import type { Hono } from "hono";
import type { JbcenterEnv } from "../types.js";
import type { createRestApp } from "./app.js";
import { accountsCss, accountsPage } from "./web/page.js";

export const REST_PAGE_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
} as const;

export interface RestSite {
  app: ReturnType<typeof createRestApp>;
  audience: string;
  accountsScript: string;
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
  ]) {
    const content = await readFile(
      new URL(`../../docs/rest/${name}.md`, import.meta.url),
      "utf8",
    );
    documents.set(name.toLowerCase(), content);
    documents.set(name.toLowerCase().replaceAll("_", "-"), content);
  }
  return { accountsScript, documents };
}

export function mountRestSite(app: Hono<JbcenterEnv>, site: RestSite): void {
  app.route("/api/v1", site.app);
  app.get("/accounts", (context) =>
    context.html(
      accountsPage({ audience: site.audience }),
      200,
      REST_PAGE_HEADERS,
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
    const name = context.req.param("name").replace(/\.md$/, "");
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
    return context.text(document, 200, {
      ...REST_PAGE_HEADERS,
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
  });
}
