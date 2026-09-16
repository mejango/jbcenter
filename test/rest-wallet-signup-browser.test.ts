import { build } from "esbuild";
import { createServer, type Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** The served signup page in Chromium, with a modeled Center. */
describe("served Center signup page", () => {
  let server: Server, browser: Browser, page: Page, origin: string, script: string, pageHtml: string, css: string;
  let releaseLogin: (() => void) | null = null;
  const errors: string[] = [];

  beforeAll(async () => {
    const built = await build({ entryPoints: [new URL("../src/rest/web/walletSignup.ts", import.meta.url).pathname],
      bundle: true, platform: "browser", format: "esm", target: "es2022", write: false });
    script = built.outputFiles[0]!.text;
    const production = await import("../src/rest/web/walletSignupPage.js");
    pageHtml = production.walletSignupPage(); css = production.walletSignupCss();
    server = createServer(async (request, response) => {
      const path = new URL(request.url!, "http://localhost").pathname;
      const json = (value: unknown, status = 200) => {
        response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(value));
      };
      if (path === "/wallet") { response.writeHead(200, { "content-type": "text/html" }); response.end(pageHtml); return; }
      if (path === "/wallet/assets/wallet-signup.js") { response.writeHead(200, { "content-type": "text/javascript" }); response.end(script); return; }
      if (path === "/wallet/assets/wallet-signup.css") { response.writeHead(200, { "content-type": "text/css" }); response.end(css); return; }
      if (path === "/wallet/config") return json({ version: "center-wallet-v1", issuer: origin, audience: `${origin}/v1`, rpId: "localhost" });
      if (path === "/wallet/signup/state") return json({ view: null });
      if (path === "/wallet/login/begin") {
        // Hold the sign-in open: the page must not keep offering the signup form meanwhile.
        await new Promise<void>(resolve => { releaseLogin = resolve; });
        return json({ error: { code: "WALLET_LOGIN_UNAVAILABLE", message: "private-detail" } }, 503);
      }
      json({ error: { message: `unexpected ${path}` } }, 404);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    origin = `http://localhost:${(server.address() as { port: number }).port}`;
    browser = await chromium.launch();
    page = await browser.newPage();
    page.on("pageerror", error => errors.push(String(error)));
  });
  afterAll(async () => { await browser?.close(); await new Promise<void>(resolve => server?.close(() => resolve())); });

  it("hides the signup form while a log-in is in progress, and offers it again after a failure", async () => {
    await page.goto(`${origin}/wallet`);
    await expect.poll(() => page.locator("#signup-form").isVisible()).toBe(true);
    await page.locator("#signup-resume").click();
    // The explainer dialog is the first step; the form is already out of the way behind it.
    await expect.poll(() => page.locator("#signup-form").isHidden()).toBe(true);
    await page.locator("#explain-continue").click();
    await expect.poll(() => page.locator("#wallet-status").textContent()).toContain("Logging in");
    expect(await page.locator("#signup-form").isHidden()).toBe(true);
    expect(await page.locator("#signup-intro").isHidden()).toBe(true);
    releaseLogin!();
    await expect.poll(() => page.locator("#signup-form").isVisible()).toBe(true);
    expect(await page.locator("body").textContent()).not.toContain("private-detail");
    expect(errors).toEqual([]);
  }, 20_000);
});
