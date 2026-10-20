import type { Hono } from "hono";
import { FAVICON_SVG } from "../branding.js";
import type { JbcenterEnv } from "../types.js";
import { validateAudience } from "./auth/signatures.js";
import { REST_PAGE_HEADERS } from "./pageHeaders.js";
import { assetHref, mountAssets } from "./web/assets.js";
import { accountsCss, accountsPage } from "./web/page.js";

/** Account management can be hosted separately while signing requests for the same API audience. */
export function mountAccountsSite(app: Hono<JbcenterEnv>, options: { audience: string; accountsScript: string }): void {
  const audience = validateAudience(options.audience);
  if (audience !== options.audience || new URL(audience).origin !== audience || /[*,;'"\s]/.test(audience))
    throw new Error("Accounts requires an exact API origin.");
  const headers = { ...REST_PAGE_HEADERS, "Content-Security-Policy": REST_PAGE_HEADERS["Content-Security-Policy"]
    .replace("connect-src 'self'", `connect-src 'self' ${audience}`) };
  const assets = mountAssets(app, "", { "accounts.js": options.accountsScript, "accounts.css": accountsCss(), "accounts-icon.svg": FAVICON_SVG });
  app.get("/accounts", context => context.html(accountsPage({ audience, faviconPath: assetHref("", "accounts-icon.svg", assets),
    scriptPath: assetHref("", "accounts.js", assets), stylePath: assetHref("", "accounts.css", assets) }), 200, headers));
}
