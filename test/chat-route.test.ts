import type { ToolDefinition } from "@juicebox/mcp/host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createApp } from "../src/app.js";
import { loadChatConfig } from "../src/chat/config.js";
import type { Provider, TurnEvent } from "../src/chat/provider.js";
import { sourceId } from "../src/chat/sources.js";
import { Metrics } from "../src/observability.js";
import { fakeProvider } from "./support/fakeProvider.js";
import { MemoryStore } from "./support/memoryStore.js";

const origin = "https://juicebox.center";
const config = { ...loadChatConfig({ CHAT_PROVIDER: "ollama", CHAT_MODEL: "test" })!, maxMessages: 4, maxInputChars: 200 };
const upstream = `https://github.com/Bananapus/nana-core-v6/blob/${"a".repeat(40)}/src/JBCashOuts.sol`;
const schema = z.object({ query: z.string() }).strict();
const search: ToolDefinition = { name: "jb_search_reference", description: "search", schema,
  run: async (input) => { schema.parse(input); return { results: [{ title: "JBCashOuts.sol", source: { upstreamUrl: upstream, fileDirty: false } }] }; } };
const script = (): TurnEvent[][] => [
  [{ type: "tool_calls", calls: [{ id: "c1", name: "jb_search_reference", input: { query: "cash out" } }] }, { type: "usage", inputTokens: 100, outputTokens: 10 }, { type: "stop", reason: "tool" }],
  [{ type: "text", text: `Burns tokens [${sourceId(upstream)}].` }, { type: "usage", inputTokens: 120, outputTokens: 8 }, { type: "stop", reason: "end" }],
];
const QUESTION = "How do cash outs work, privately asked?";

function setup(metrics = new Metrics()) {
  const store = new MemoryStore();
  const app = createApp(store, { metrics, chat: { config, provider: fakeProvider(script()), tools: [search], origin, page: { boot: "", main: "" } } });
  const post = (body: unknown, headers: Record<string, string> = { origin, "x-real-ip": "203.0.113.7" }) =>
    app.request(`${origin}/chat`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { app, post, metrics };
}
const ask = (text = QUESTION) => ({ messages: [{ role: "user", text }] });
const events = (body: string) => body.trim().split("\n\n").map((block) => {
  const [event, data] = block.split("\n");
  return { type: event!.replace("event: ", ""), ...JSON.parse(data!.replace("data: ", "")) };
});

afterEach(() => vi.unstubAllEnvs());

describe("POST /chat", () => {
  it("is off without a provider", async () => {
    const response = await createApp(new MemoryStore()).request(`${origin}/chat`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(ask()) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "chat_off" });
  });

  it("answers only its own page", async () => {
    const { post } = setup();
    expect((await post(ask(), { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(ask(), {})).status).toBe(403);
    expect((await post(ask(), { origin: "null" })).status).toBe(403);
    // Same host over plain HTTP is another origin.
    expect((await post(ask(), { origin: "http://juicebox.center", host: "juicebox.center" })).status).toBe(403);
  });

  it("rejects a malformed conversation", async () => {
    const { post } = setup();
    for (const body of ["{", {}, { messages: [] }, { messages: [{ role: "system", text: "x" }] }, { messages: [{ role: "user", text: "" }] },
      { messages: [{ role: "assistant", text: "x" }] }, { messages: [{ role: "user", text: "a" }, { role: "user", text: "b" }] }, { messages: [{ role: "user", text: 5 }] }])
      expect((await post(body)).status, JSON.stringify(body)).toBe(400);
  });

  it("answers 413 when the conversation is too long", async () => {
    const { post } = setup();
    const long = await post(ask("x".repeat(201)));
    expect(long.status).toBe(413);
    expect(await long.json()).toEqual({ error: "too_long" });
    const many = Array.from({ length: 5 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", text: "x" }));
    expect((await post({ messages: many })).status).toBe(413);
    expect((await post(`{"messages":[{"role":"user","text":"${"x".repeat(70_000)}"}]}`)).status).toBe(413);
  });

  it("stops reading a body that is too large", async () => {
    const { app } = setup();
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { if (++pulled > 64) return controller.close(); controller.enqueue(new Uint8Array(16 * 1024).fill(120)); } });
    const response = await app.request(`${origin}/chat`, { method: "POST", headers: { origin, "content-type": "application/json" }, body, duplex: "half" } as RequestInit);
    expect(response.status).toBe(413);
    // 64 KiB is allowed; a megabyte was offered.
    expect(pulled).toBeLessThan(16);
  });

  it("streams sources, text and a final event", async () => {
    const { post, metrics } = setup();
    const response = await post(ask());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const id = sourceId(upstream);
    expect(events(await response.text())).toEqual([
      { type: "tool", name: "jb_search_reference", label: "Searching the reference" },
      { type: "source", source: { id, title: "JBCashOuts.sol", url: upstream, kind: "reference" } },
      { type: "text", text: `Burns tokens [${id}].` },
      { type: "done", reason: "end", inputTokens: 220, outputTokens: 18, toolCalls: 1 },
    ]);
    const rendered = metrics.render();
    expect(rendered).toContain("jbcenter_chat_requests_total 1");
    expect(rendered).toContain("jbcenter_chat_tool_calls_total 1");
    expect(rendered).toContain("jbcenter_chat_input_tokens_total 220");
    expect(rendered).toContain("jbcenter_chat_output_tokens_total 18");
  });

  it("rests after the hourly budget for one visitor, and tells when to return", async () => {
    const { post, metrics } = setup();
    for (let index = 0; index < 20; index++) expect((await post(ask())).status).toBe(200);
    const denied = await post(ask());
    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toBe("3600");
    expect(await denied.json()).toEqual({ error: "resting" });
    expect((await post(ask(), { origin, "x-real-ip": "203.0.113.8" })).status).toBe(200);
    expect(metrics.render()).toContain("jbcenter_chat_budget_denials_total 1");
  });

  describe("with answers in flight", () => {
    // A model that reports its usage, then says nothing until the caller leaves.
    const stalled: Provider = { start: ({ signal }) => ({ async *next() {
      yield { type: "usage", inputTokens: 100, outputTokens: 20 };
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
    } }) };
    const open = (metrics: Metrics) => {
      const app = createApp(new MemoryStore(), { metrics, chat: { config: { ...config, perIpPerHour: 1000, perIpPerDay: 1000 }, provider: stalled, tools: [], origin, page: { boot: "", main: "" } } });
      return () => app.request(`${origin}/chat`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(ask()) });
    };

    it("counts what a visitor who left had already spent", async () => {
      const metrics = new Metrics();
      const response = await open(metrics)();
      await response.body!.cancel();
      await expect.poll(() => metrics.render()).toContain("jbcenter_chat_input_tokens_total 100");
      expect(metrics.render()).toContain("jbcenter_chat_output_tokens_total 20");
      expect(metrics.render()).toContain("jbcenter_chat_requests_total 1");
    });

    it("answers at most 16 questions at once", async () => {
      const metrics = new Metrics();
      const post = open(metrics);
      const held = await Promise.all(Array.from({ length: 16 }, post));
      expect(held.every(({ status }) => status === 200)).toBe(true);
      const over = await post();
      expect(over.status).toBe(429);
      expect(over.headers.get("retry-after")).toBe("10");
      await held[0]!.body!.cancel();
      await expect.poll(async () => { const next = await post(); await next.body?.cancel(); return next.status; }).toBe(200);
    });
  });

  it("never logs what was asked", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const logged: string[] = [];
    const spies = (["log", "info", "warn", "error"] as const).map((method) => vi.spyOn(console, method).mockImplementation((...args) => { logged.push(args.join(" ")); }));
    const { post } = setup();
    await (await post(ask())).text();
    spies.forEach((spy) => spy.mockRestore());
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join("\n")).not.toContain("privately asked");
    expect(logged.join("\n")).not.toContain("Burns tokens");
  });
});
