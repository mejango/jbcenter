import type { ToolDefinition } from "@juicebox/mcp/host";
import { build } from "esbuild";
import type { Hono } from "hono";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
// @ts-expect-error The build script is plain ESM without declarations.
import { webBuildOptions } from "../scripts/rest/build-web.mjs";
import { createApp } from "../src/app.js";
import { loadChatConfig } from "../src/chat/config.js";
import type { TurnEvent } from "../src/chat/provider.js";
import { sourceId } from "../src/chat/sources.js";
import { STORAGE_KEY } from "../src/chat/web/key.js";
import type { JbcenterEnv } from "../src/types.js";
import { fakeProvider } from "./support/fakeProvider.js";
import { MemoryStore } from "./support/memoryStore.js";

const origin = "https://juicebox.center";
const upstream = `https://github.com/Bananapus/nana-core-v6/blob/${"a".repeat(40)}/src/JBCashOuts.sol`;
const schema = z.object({ query: z.string() }).strict();
const search: ToolDefinition = { name: "jb_search_reference", description: "search", schema,
  run: async (input) => { schema.parse(input); return { results: [{ title: "JBCashOuts.sol", source: { upstreamUrl: upstream, fileDirty: false } }] }; } };
const cited: (TurnEvent[] | Error)[] = [
  [{ type: "tool_calls", calls: [{ id: "c1", name: "jb_search_reference", input: { query: "cash out" } }] }, { type: "usage", inputTokens: 1, outputTokens: 1 }, { type: "stop", reason: "tool" }],
  [{ type: "text", text: `Cash outs burn tokens [${sourceId(upstream)}]. <img src=x onerror="document.title='pwned'">` }, { type: "usage", inputTokens: 1, outputTokens: 1 }, { type: "stop", reason: "end" }],
];
const plain = (text: string): TurnEvent[] => [{ type: "text", text }, { type: "usage", inputTokens: 1, outputTokens: 1 }, { type: "stop", reason: "end" }];

let bundles: { boot: string; main: string }, browser: Browser, page: Page, app: Hono<JbcenterEnv>;
const errors: string[] = [], bodies: string[] = [];
let tooLong = 0;

beforeAll(async () => {
  const result = await build({ ...webBuildOptions, write: false });
  const text = (name: string) => result.outputFiles!.find((file) => file.path.endsWith(`/${name}.js`))!.text;
  bundles = { boot: text("chat-boot"), main: text("chat") };
  browser = await chromium.launch({ headless: true });
}, 60_000);
afterAll(async () => { await browser?.close(); });

/** A fresh browser profile on a Center whose model follows the script. */
async function open(rounds: (TurnEvent[] | Error)[], stored?: string) {
  const config = loadChatConfig({ CHAT_PROVIDER: "ollama", CHAT_MODEL: "test" })!;
  app = createApp(new MemoryStore(), { chat: { config, provider: fakeProvider(rounds), tools: [search], origin, page: bundles } });
  const context = await browser.newContext();
  if (stored !== undefined) await context.addInitScript(([key, value]) => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem(key!, value!); sessionStorage.setItem("seeded", "1"); } }, [STORAGE_KEY, stored]);
  page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { // The browser logs every refused request; the page's own errors are what matter here.
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(message.text()); });
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    if (new URL(request.url()).pathname === "/chat") {
      bodies.push(request.postData() ?? "");
      if (tooLong-- > 0) return route.fulfill({ status: 413, contentType: "application/json", body: '{"error":"too_long"}' });
    }
    const response = await app.request(request.url(), { method: request.method(), headers: request.headers(), ...(request.postData() ? { body: request.postData()! } : {}) });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });
  await page.goto(`${origin}/`);
}
beforeEach(() => { errors.length = 0; bodies.length = 0; tooLong = 0; });
afterEach(async () => { await page.context().close(); expect(errors).toEqual([]); });

const idle = () => expect.poll(() => page.locator("#chat").getAttribute("aria-busy")).toBe("false");

describe("homepage chat", () => {
  it("answers a suggestion with a cited source, survives a reload, and clears on New chat", async () => {
    await open(cited);
    await expect.poll(() => page.locator("#chat").isVisible()).toBe(true);
    // The directory is still there, below.
    expect(await page.locator("#apps, #main .audiences").first().isVisible()).toBe(true);
    await page.getByRole("button", { name: "How do cash outs work?" }).click();
    await idle();
    expect(await page.locator("#log .you").textContent()).toBe("How do cash outs work?");
    const link = page.locator("#log .answer p a");
    expect(await link.textContent()).toBe("[1]");
    expect(await link.getAttribute("href")).toBe(upstream);
    expect(await page.locator("#log .cited a").getAttribute("href")).toBe(upstream);
    expect(await page.locator("#log .cited").textContent()).toBe("[1] JBCashOuts.sol");
    // The model's own markup is text.
    expect(await page.locator("#log img").count()).toBe(0);
    expect(await page.locator("#log .answer p").first().textContent()).toContain("<img src=x");
    expect(await page.title()).toBe("Juicebox Center");
    expect(await page.locator(".jumps button").first().isVisible()).toBe(false);
    expect(JSON.parse(bodies[0]!)).toEqual({ messages: [{ role: "user", text: "How do cash outs work?" }] });

    await page.reload();
    await expect.poll(() => page.locator("#log .cited a").getAttribute("href")).toBe(upstream);
    expect(await page.locator("#log .you").textContent()).toBe("How do cash outs work?");

    await page.getByRole("button", { name: "New chat" }).click();
    expect(await page.locator("#log").textContent()).toBe("");
    expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
    expect(await page.locator(".jumps button").first().isVisible()).toBe(true);
  });

  it("keeps what arrived when the model fails, and tries again on request", async () => {
    await open([[{ type: "text", text: "Half an ans" }], plain("A whole answer.")]);
    await page.locator("#chat textarea").fill("Where do fees go?");
    await page.locator("#chat textarea").press("Enter");
    await idle();
    expect(await page.locator("#log .answer").textContent()).toBe("Half an ans");
    expect(await page.locator("#log .notice").textContent()).toBe("That did not work.Try again");
    expect(await page.getByRole("button", { name: "Ask", exact: true }).isDisabled()).toBe(false);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => page.locator("#log .answer").textContent()).toBe("A whole answer.");
    await idle();
    expect(await page.locator("#log .notice").count()).toBe(0);
    expect(bodies.map((body) => JSON.parse(body).messages.length)).toEqual([1, 1]);
  });

  it("starts clean when the stored conversation is unreadable", async () => {
    await open([], "{");
    await expect.poll(() => page.locator("#log").count()).toBe(1);
    expect(await page.locator("#log").textContent()).toBe("");
    expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
    expect(await page.locator(".jumps button").first().isVisible()).toBe(true);
  });

  it("drops the oldest messages when the conversation is too long, and says so", async () => {
    const messages = [{ role: "user", text: "first" }, { role: "assistant", text: "one" }];
    await open([plain("Answer two.")], JSON.stringify({ messages, sources: [] }));
    await expect.poll(() => page.locator("#log .you").count()).toBe(1);
    tooLong = 1;
    await page.locator("#chat textarea").fill("second");
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await expect.poll(() => page.locator("#log .answer").last().textContent()).toBe("Answer two.");
    await idle();
    expect(bodies.map((body) => JSON.parse(body).messages.length)).toEqual([3, 1]);
    expect(await page.locator("#log .you").allTextContents()).toEqual(["second"]);
  });

  it("sends what was in the box when Ask was pressed, even if the chat was still loading", async () => {
    await open([plain("Answered.")]);
    let release: (() => void) | undefined;
    await page.route(/\/assets\/chat\.[0-9a-f]{12}\.js$/, async (route) => { await new Promise<void>((resolve) => { release = resolve; }); await route.fallback(); });
    // No focus first: the script starts loading only on the submit itself.
    await page.evaluate(() => {
      const box = document.querySelector<HTMLTextAreaElement>("#chat textarea")!;
      box.value = "submitted question";
      box.form!.requestSubmit();
      box.value = "unsent edited draft";
    });
    await expect.poll(() => release).toBeDefined();
    release!();
    await expect.poll(() => page.locator("#log .answer").textContent()).toBe("Answered.");
    expect(await page.locator("#log .you").textContent()).toBe("submitted question");
    expect(await page.locator("#chat textarea").inputValue()).toBe("unsent edited draft");
  });

  it("says the chat is resting when the budget is spent", async () => {
    await open([]);
    await page.route(`${origin}/chat`, (route) => route.fulfill({ status: 429, contentType: "application/json", body: '{"error":"resting"}' }));
    await page.getByRole("button", { name: "Where do fees go?" }).click();
    await expect.poll(() => page.locator("#log .notice").textContent()).toBe("Chat is resting. The directory is below.");
    await idle();
  });
});
