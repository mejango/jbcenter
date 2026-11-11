import { readFile } from "node:fs/promises";
import type { Hono } from "hono";
import type { JbcenterEnv } from "../types.js";
import type { createRestApp } from "./app.js";
import { guidePage } from "./docs/guide.js";
import { REST_DOCS_HEADERS, REST_PAGE_HEADERS } from "./pageHeaders.js";
import { mountAssets } from "./web/assets.js";

export { REST_PAGE_HEADERS } from "./pageHeaders.js";

export const REST_DOCUMENTS = [
  "ARCHITECTURE",
  "QUICKSTART",
  "USER_JOURNEYS",
  "API",
  "AI_GUIDE",
  "PROJECT_INTENTS",
  "CONTRACTS",
  "INDEXER",
  "TRANSACTIONS",
  "OMNICHAIN",
  "PRODUCTION_OPERATIONS",
] as const;

export interface RestSite {
  app: ReturnType<typeof createRestApp>;
  audience: string;
  docsScript: string;
  docsHtml: string;
  /** Each endpoint's parameter and schema tables, by operationId; /api loads one when it is opened. */
  apiReference?: ReadonlyMap<string, string>;
  /** JSON of each endpoint's field names, by operationId, for the /api filter. */
  apiTerms?: string;
  docsCss: string;
  documents: ReadonlyMap<string, string>;
}

export async function readRestAssets() {
  const documents = new Map<string, string>();
  for (const name of REST_DOCUMENTS) {
    const content = await readFile(
      new URL(`../../docs/rest/${name}.md`, import.meta.url),
      "utf8",
    );
    documents.set(name.toLowerCase(), content);
    documents.set(name.toLowerCase().replaceAll("_", "-"), content);
  }
  const docsScript = await readFile(new URL("../../.generated/rest/docs.js", import.meta.url), "utf8");
  return { documents, docsScript };
}

export function mountRestSite(app: Hono<JbcenterEnv>, site: RestSite): void {
  app.route("/api/v1", site.app);
  const assets = mountAssets(app, "", { "docs.js": site.docsScript ?? "", "api.css": site.docsCss }, REST_PAGE_HEADERS);
  app.get("/api", (context) =>
    context.html(site.docsHtml, 200, REST_DOCS_HEADERS),
  );
  app.get("/api/reference/:operationId", (context) => {
    const page = site.apiReference?.get(context.req.param("operationId"));
    return page ? context.html(page, 200, REST_DOCS_HEADERS) : context.notFound();
  });
  app.get("/api/:file{terms(?:\\.[0-9a-f]{12})?\\.json}", (context) =>
    context.body(site.apiTerms ?? "{}", 200, { ...REST_DOCS_HEADERS, "Content-Type": "application/json; charset=utf-8" }),
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
      return context.html(guidePage(name, document, assets), 200, { ...REST_DOCS_HEADERS, Vary: "Accept" });
    return context.text(document, 200, {
      ...REST_DOCS_HEADERS, Vary: "Accept",
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
  });
}
