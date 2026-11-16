import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadChatConfig } from "../src/chat/config.js";
import { HOMEPAGE_CSS, HOMEPAGE_HEADERS, HOMEPAGE_HTML, homepageAssets, homepageHeaders, homepageHtml } from "../src/homepage.js";
import { hashedAssetName } from "../src/rest/web/assets.js";
import { fakeProvider } from "./support/fakeProvider.js";
import { MemoryStore } from "./support/memoryStore.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const before = JSON.parse(readFileSync(new URL("./fixtures/homepage-chat-off.sha256", import.meta.url), "utf8"));
const page = { boot: "/* boot */", main: "/* chat */" };

describe("homepage with chat off", () => {
  it("is byte-identical to the directory page before chat existed", () => {
    expect(sha(HOMEPAGE_HTML)).toBe(before.html);
    expect(sha(homepageHtml())).toBe(before.html);
    expect(sha(JSON.stringify(HOMEPAGE_HEADERS))).toBe(before.headers);
    expect(sha(JSON.stringify(homepageHeaders()))).toBe(before.headers);
    expect(sha(HOMEPAGE_CSS)).toBe(before.css);
    expect(sha(homepageAssets()["directory.css"]!)).toBe(before.css);
    expect(Object.keys(homepageAssets())).toEqual(["directory.css", "favicon.svg"]);
  });

  it("is what the app serves when no provider is set", async () => {
    const response = await createApp(new MemoryStore()).request("/");
    expect(sha(await response.text())).toBe(before.html);
    expect(response.headers.get("content-security-policy")).toBe(HOMEPAGE_HEADERS["Content-Security-Policy"]);
  });
});

describe("homepage with chat on", () => {
  const html = homepageHtml(page);
  const assets = homepageAssets(page);

  it("adds one script, hidden until it runs, and loads the chat on demand", () => {
    expect(html.match(/<script\b/g)).toHaveLength(1);
    expect(html).toContain(`<script type="module" src="/assets/${hashedAssetName("chat-boot.js", page.boot)}"></script>`);
    expect(html).toMatch(/<section id="chat"[^>]* hidden>/);
    expect(html).toContain(`data-src="/assets/${hashedAssetName("chat.js", page.main)}"`);
    expect(html).toContain(`data-css="/assets/${hashedAssetName("chat.css", assets["chat.css"]!)}"`);
    expect(html).toContain(`/assets/${hashedAssetName("directory.css", assets["directory.css"]!)}`);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    // The rest of the page is the directory, under a smaller title.
    const strip = (value: string) => value.replace(/directory\.[0-9a-f]{12}\.css/, "");
    expect(strip(html.replace(/\s*<section id="chat"[\s\S]*?<\/section>/, "").replace(/\s*<script type="module"[^>]*><\/script>/, "")
      .replace('<h2 class="more">Directory</h2>', "<h1>Everything Juicebox in one place</h1>"))).toBe(strip(HOMEPAGE_HTML));
  });

  it("allows its own script and its own endpoint, and nothing else new", () => {
    const off = HOMEPAGE_HEADERS["Content-Security-Policy"];
    expect(homepageHeaders(page)["Content-Security-Policy"]).toBe(off.replace("img-src 'self';", "img-src 'self'; script-src 'self'; connect-src 'self';"));
    expect({ ...homepageHeaders(page), "Content-Security-Policy": off }).toEqual(HOMEPAGE_HEADERS);
  });

  it("is what the app serves when a provider is set, with every asset reachable", async () => {
    const config = loadChatConfig({ CHAT_PROVIDER: "ollama", CHAT_MODEL: "test" })!;
    const app = createApp(new MemoryStore(), { chat: { config, provider: fakeProvider([]), tools: [], origin: "https://juicebox.center", page } });
    const response = await app.request("/");
    expect(await response.text()).toBe(html);
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
    for (const [file, body] of Object.entries(assets)) {
      const asset = await app.request(`/assets/${hashedAssetName(file, body)}`);
      expect(asset.status, file).toBe(200);
      expect(await asset.text(), file).toBe(body);
    }
    // Agents that ask for markdown still get the directory as text.
    expect((await app.request("/", { headers: { Accept: "text/markdown" } })).headers.get("content-type")).toContain("text/markdown");
  });
});
