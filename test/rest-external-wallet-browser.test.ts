import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { externalWalletCss, externalWalletDialogHtml } from "../src/rest/web/externalWalletPage.js";
import type { Provider } from "../src/rest/web/externalWallet.js";

const owner = "0x0000000000000000000000000000000000000001";
declare global {
  interface Window {
    externalWalletApi: typeof import("../src/rest/web/externalWallet.js");
    walletFixture: {
      provider: Provider; requests: string[]; result?: "connected" | "rejected";
      code?: number; samePending?: boolean; release?: (accounts: string[]) => void;
    };
  }
}

describe("external wallet sign-in in Chromium", () => {
  let browser: Browser, page: Page, script: string;
  const errors: string[] = [];
  beforeAll(async () => {
    const bundle = await build({ entryPoints: [new URL("../src/rest/web/externalWallet.ts", import.meta.url).pathname],
      bundle: true, platform: "browser", format: "iife", globalName: "externalWalletApi", target: "es2022", write: false });
    script = bundle.outputFiles[0]!.text;
    browser = await chromium.launch({ headless: true });
  });
  beforeEach(async () => {
    errors.length = 0;
    page = await browser.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.route("https://accounts.test/**", route => route.fulfill({ contentType: "text/html",
      body: `<!doctype html><style>${externalWalletCss}</style>${externalWalletDialogHtml()}<script>${script}</script>` }));
    await page.goto("https://accounts.test/");
  });
  afterEach(async () => { await page.close(); expect(errors).toEqual([]); });
  afterAll(async () => { await browser?.close(); });

  async function install(mode: "announced" | "legacy" | "none" = "announced", pending = false, invalidFirst = false) {
    await page.evaluate(({ mode, pending, invalidFirst, owner }) => {
      const requests: string[] = [];
      const provider: Provider = { async request({ method }) {
        requests.push(method);
        if (method === "eth_requestAccounts") {
          if (pending) return new Promise<string[]>(resolve => { window.walletFixture.release = resolve; });
          if (invalidFirst) { invalidFirst = false; return ["not-an-address"]; }
          return [owner];
        }
        if (method === "eth_chainId") return "0x1";
        throw new Error(`Unexpected wallet request: ${method}`);
      } };
      window.walletFixture = { provider, requests };
      if (mode === "legacy") Object.assign(window, { ethereum: provider });
      if (mode === "announced") window.addEventListener("eip6963:requestProvider", () => {
        for (let i = 0; i < 2; i++) window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
          detail: { info: { name: "Fixture wallet", rdns: "io.fixture.wallet" }, provider },
        }));
      });
    }, { mode, pending, invalidFirst, owner });
  }
  async function begin() {
    await page.evaluate(() => {
      const pending = window.externalWalletApi.signIn();
      window.walletFixture.samePending = pending === window.externalWalletApi.signIn();
      void pending.then(provider => {
        if (provider !== window.walletFixture.provider) throw new Error("Selected provider changed");
        window.externalWalletApi.rememberSignIn(provider, "0x0000000000000000000000000000000000000001", 1);
        window.walletFixture.result = "connected";
      }, error => { window.walletFixture.result = "rejected"; window.walletFixture.code = error.code; });
    });
  }
  const result = () => page.evaluate(() => window.walletFixture.result);

  it.each(["announced", "legacy"] as const)("connects a selected %s provider and remembers only public discovery hints", async mode => {
    await install(mode); await begin();
    expect(await page.locator("#external-wallet-dialog").evaluate(node => (node as HTMLDialogElement).open)).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("external-wallet-close");
    expect(await page.locator("#external-wallet-wallets button").count()).toBe(1);
    expect(await page.evaluate(() => window.walletFixture.requests)).toEqual([]);
    expect(await page.evaluate(() => window.walletFixture.samePending)).toBe(true);
    await page.getByRole("button", { name: mode === "announced" ? "Fixture wallet" : "Browser wallet", exact: true }).click();
    await expect.poll(result).toBe("connected");
    expect(await page.evaluate(() => window.walletFixture.requests)).toEqual(["eth_requestAccounts", "eth_chainId"]);
    expect(await page.locator("#external-wallet-dialog").evaluate(node => (node as HTMLDialogElement).open)).toBe(false);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("juicebox-center.sign-in")!))).toEqual({
      version: 1, type: mode === "announced" ? "external" : "legacy", owner, chainId: 1,
      ...(mode === "announced" ? { rdns: "io.fixture.wallet" } : {}),
    });
  });

  it("leaves a failed connection retryable without accepting malformed account identity", async () => {
    await install("announced", false, true); await begin();
    const button = page.getByRole("button", { name: "Fixture wallet", exact: true });
    await button.click();
    await expect.poll(() => page.locator("#external-wallet-status").textContent()).toContain("did not connect");
    expect(await result()).toBeUndefined(); expect(await button.isEnabled()).toBe(true);
    await button.click(); await expect.poll(result).toBe("connected");
    expect(await page.evaluate(() => window.walletFixture.requests)).toEqual(["eth_requestAccounts", "eth_requestAccounts", "eth_chainId"]);
  });

  it.each(["close", "escape", "sign out"])("cancels a pending wallet request through %s and ignores its late response", async action => {
    await install("announced", true); await begin();
    await page.getByRole("button", { name: "Fixture wallet", exact: true }).click();
    await expect.poll(() => page.evaluate(() => !!window.walletFixture.release)).toBe(true);
    if (action === "close") await page.getByRole("button", { name: "Close sign-in" }).click();
    else if (action === "escape") await page.keyboard.press("Escape");
    else await page.evaluate(() => window.externalWalletApi.signOut());
    await expect.poll(result).toBe("rejected");
    expect(await page.evaluate(() => window.walletFixture.code)).toBe(4001);
    await page.evaluate(owner => { window.walletFixture.release!([owner]); }, owner);
    await expect.poll(() => page.evaluate(() => window.walletFixture.requests)).toContain("eth_chainId");
    expect(await result()).toBe("rejected");
    expect(await page.locator("#external-wallet-dialog").evaluate(node => (node as HTMLDialogElement).open)).toBe(false);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("juicebox-center.sign-in") ?? "null")))
      .toEqual(action === "sign out" ? { version: 1, signedOut: true } : null);
  });

  it("renders untrusted wallet names as labels and rejects remote icons", async () => {
    await install("none"); await begin();
    expect(await page.locator("#external-wallet-status").textContent()).toContain("Choose a wallet");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: {
      info: { name: '<img src=x onerror="throw Error(1)">', icon: "https://attacker.test/icon.svg", rdns: "io.fixture.wallet" },
      provider: window.walletFixture.provider,
    } })));
    const button = page.locator("#external-wallet-wallets button");
    expect(await button.getAttribute("aria-label")).toBe('<img src=x onerror="throw Error(1)">');
    expect(await button.locator("img").count()).toBe(0);
    expect(await button.locator("svg").count()).toBe(1);
    await page.getByRole("button", { name: "Close sign-in" }).click();
    await expect.poll(result).toBe("rejected");
  });
});
