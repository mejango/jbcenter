import type { Hono } from "hono";
import { FAVICON_SVG } from "../branding.js";
import type { JbcenterEnv } from "../types.js";
import { validateAudience } from "./auth/signatures.js";
import { REST_PAGE_HEADERS } from "./pageHeaders.js";
import { serveHashed } from "../hashedAsset.js";
import { accountsCss, accountsPage } from "./web/page.js";

/** Account management can be hosted separately while signing requests for the same API audience. */
export function mountAccountsSite(app: Hono<JbcenterEnv>, options: { audience: string; accountsScript: string }): void {
  const audience = validateAudience(options.audience);
  if (audience !== options.audience || new URL(audience).origin !== audience || /[*,;'"\s]/.test(audience))
    throw new Error("Accounts requires an exact API origin.");
  const headers = { ...REST_PAGE_HEADERS, "Content-Security-Policy": REST_PAGE_HEADERS["Content-Security-Policy"]
    .replace("connect-src 'self'", `connect-src 'self' ${audience}`) };
  const page = accountsPage({ audience,
    stylePath: serveHashed(app, "/assets/accounts.css", accountsCss(), { ...REST_PAGE_HEADERS, "Content-Type": "text/css; charset=utf-8" }),
    scriptPath: serveHashed(app, "/assets/accounts.js", options.accountsScript, { ...REST_PAGE_HEADERS, "Content-Type": "application/javascript; charset=utf-8" }),
    faviconPath: serveHashed(app, "/assets/accounts-icon.svg", FAVICON_SVG, { ...REST_PAGE_HEADERS, "Content-Type": "image/svg+xml; charset=utf-8" }) });
  // The page itself stays uncached: it is the entry point that names this deploy's assets.
  app.get("/accounts", context => context.html(page, 200, headers));
}
