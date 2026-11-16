import { createServices, createTools, loadConfig, type ToolDefinition } from "@juicebox/mcp/host";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadChatConfig } from "../src/chat/config.js";
import { runChat, type ChatEvent } from "../src/chat/loop.js";
import { systemPrompt } from "../src/chat/prompt.js";
import type { TurnEvent } from "../src/chat/provider.js";
import { directorySources, sourceId } from "../src/chat/sources.js";
import { CHAT_TOOL_NAMES, chatTools } from "../src/chat/tools.js";
import { createCenterReadFetcher, withBackendBucket } from "../src/mcp.js";
import { fakeProvider } from "./support/fakeProvider.js";
import { MemoryStore } from "./support/memoryStore.js";

const origin = "https://juicebox.center";
const config = { ...loadChatConfig({ CHAT_PROVIDER: "ollama", CHAT_MODEL: "test" })!, maxRounds: 3, toolResultBytes: 400 };
const upstream = `https://github.com/Bananapus/nana-core-v6/blob/${"a".repeat(40)}/src/JBCashOuts.sol`;
const schema = z.object({ query: z.string() }).strict();
// Like a protocol operation, a tool validates its own input.
const tool = (name: string, run: ToolDefinition["run"]): ToolDefinition => ({ name, description: name, schema, run: async (input) => run(schema.parse(input)) });
const search = tool("jb_search_reference", async () => ({ results: [{ id: "x", title: "nana-core-v6 — JBCashOuts.sol", excerpt: "burn", source: { upstreamUrl: upstream, fileDirty: false } }] }));
const call = (name: string, input: unknown = { query: "cash out" }, id = "c1"): TurnEvent[] => [
  { type: "tool_calls", calls: [{ id, name, input }] }, { type: "usage", inputTokens: 100, outputTokens: 10 }, { type: "stop", reason: "tool" }];
const answer = (text: string): TurnEvent[] => [{ type: "text", text }, { type: "usage", inputTokens: 150, outputTokens: 20 }, { type: "stop", reason: "end" }];

async function run(rounds: (TurnEvent[] | Error)[], tools: ToolDefinition[] = [search], signal = new AbortController().signal) {
  const provider = fakeProvider(rounds);
  const events: ChatEvent[] = [];
  for await (const event of runChat({ config, provider, tools, origin, messages: [{ role: "user", text: "How do cash outs work?" }], signal })) events.push(event);
  return { events, provider };
}

describe("chat tool allowlist", () => {
  const all = createTools(createServices(loadConfig({ NODE_ENV: "test", PUBLIC_ORIGIN: origin, PLAN_SECRET: "chat-allowlist-tests-only-32-byte-secret" })));

  it("is the 30 read-only tools of step 1, by name", () => {
    expect(CHAT_TOOL_NAMES).toHaveLength(30);
    expect(new Set(CHAT_TOOL_NAMES).size).toBe(30);
    expect([...CHAT_TOOL_NAMES]).toEqual([...CHAT_TOOL_NAMES].sort());
    const chosen = chatTools(all);
    expect(chosen.map((entry) => entry.name)).toEqual([...CHAT_TOOL_NAMES]);
    for (const entry of chosen) {
      expect(entry.annotations?.readOnlyHint ?? true, entry.name).toBe(true);
      expect(entry.name, entry.name).not.toMatch(/^jb_(prepare|pin|publish|deploy)_/);
      expect(["jb_inspect_plan", "jb_simulate_plan", "jb_verify_plan", "jb_list_capabilities"]).not.toContain(entry.name);
    }
  });

  it("refuses to start with a tool missing from the catalog", () => {
    expect(() => chatTools(all.filter((entry) => entry.name !== "jb_get_project"))).toThrow("jb_get_project");
  });
});

describe("chat system prompt", () => {
  it("carries the directory by id and no URL", () => {
    const prompt = systemPrompt(origin);
    expect(prompt).not.toContain("http");
    expect(prompt).toContain("Juicebox V6 only.");
    expect(prompt).toContain("Never write a URL or a markdown link.");
    for (const source of directorySources(origin).slice(0, 5)) expect(prompt).toContain(source.id);
  });
});

describe("chat loop", () => {
  it("runs a tool, emits its source before the answer, and reports totals", async () => {
    const id = sourceId(upstream);
    const { events, provider } = await run([call("jb_search_reference"), answer(`A cash out burns tokens [${id}].`)]);
    expect(events).toEqual([
      { type: "tool", name: "jb_search_reference", label: "Searching the reference" },
      { type: "source", source: { id, title: "nana-core-v6 — JBCashOuts.sol", url: upstream, kind: "reference" } },
      { type: "text", text: `A cash out burns tokens [${id}].` },
      { type: "done", reason: "end", inputTokens: 250, outputTokens: 30, toolCalls: 1 },
    ]);
    const [outcome] = provider.outcomes[0]!;
    expect(outcome).toMatchObject({ id: "c1", isError: false });
    expect(outcome!.content).toContain(id);
    expect(outcome!.content).not.toContain("http");
    expect(provider.requests[0]!.tools.map((entry) => entry.name)).toEqual(["jb_search_reference"]);
    expect(provider.requests[0]!.tools[0]!.inputSchema.type).toBe("object");
  });

  it("emits a directory source the answer cites", async () => {
    const guide = directorySources(origin)[0]!;
    const { events } = await run([answer(`Start with the guide [${guide.id}].`)]);
    expect(events.at(-2)).toEqual({ type: "source", source: guide });
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "end" });
  });

  it("passes a tool failure to the model and still answers", async () => {
    const failing = tool("jb_search_reference", async () => { throw new RangeError("missing"); });
    const { events, provider } = await run([call("jb_search_reference"), answer("I do not know.")], [failing]);
    expect(provider.outcomes[0]![0]).toMatchObject({ isError: true });
    expect(provider.outcomes[0]![0]!.content).toContain("REFERENCE_NOT_FOUND");
    expect(events.filter((event) => event.type === "source")).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "end" });
  });

  it("rejects arguments the tool's schema does not accept", async () => {
    let ran = false;
    const { provider } = await run([call("jb_search_reference", { query: 7 }), answer("ok")], [tool("jb_search_reference", async () => { ran = true; return {}; })]);
    expect(ran).toBe(false);
    expect(provider.outcomes[0]![0]).toMatchObject({ isError: true });
  });

  it("truncates an oversize result and says so", async () => {
    const big = tool("jb_search_reference", async () => ({ text: "x".repeat(5000) }));
    const { provider } = await run([call("jb_search_reference"), answer("ok")], [big]);
    const { content } = provider.outcomes[0]![0]!;
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(400 + 60);
    expect(content.endsWith("…[truncated, ask for a smaller page]")).toBe(true);
  });

  it("refuses a tool that is not on the list", async () => {
    const { provider } = await run([call("jb_publish_intent"), answer("ok")]);
    expect(provider.outcomes[0]![0]).toMatchObject({ isError: true });
    expect(provider.outcomes[0]![0]!.content).toContain("not available");
  });

  it("stops after the round limit", async () => {
    const { events, provider } = await run([call("jb_search_reference"), call("jb_search_reference"), call("jb_search_reference"), answer("never")]);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "rounds", toolCalls: 2 });
    expect(provider.outcomes).toHaveLength(2);
  });

  it("runs no further tools once the caller is gone", async () => {
    const controller = new AbortController();
    let runs = 0;
    const slow = tool("jb_search_reference", async () => { runs++; controller.abort(); return {}; });
    const { events } = await run([call("jb_search_reference"), call("jb_search_reference"), answer("never")], [slow], controller.signal);
    expect(runs).toBe(1);
    // The page is gone, so nothing follows but the accounting of what was spent.
    expect(events.at(-1)).toEqual({ type: "done", reason: "gone", inputTokens: 100, outputTokens: 10, toolCalls: 1 });
    expect(events.some((event) => event.type === "text" || event.type === "error")).toBe(false);
  });

  it("runs at most 12 tools for one question", async () => {
    let runs = 0;
    const counted = tool("jb_search_reference", async () => { runs++; return {}; });
    const many: TurnEvent[] = [{ type: "tool_calls", calls: Array.from({ length: 20 }, (_, index) => ({ id: `c${index}`, name: "jb_search_reference", input: { query: "x" } })) }, { type: "stop", reason: "tool" }];
    const { events, provider } = await run([many, call("jb_search_reference"), answer("done")], [counted]);
    expect(runs).toBe(12);
    expect(provider.outcomes[0]!.filter(({ isError }) => isError)).toHaveLength(8);
    expect(provider.outcomes[0]![12]!.content).toContain("TOOL_LIMIT");
    expect(provider.outcomes[1]![0]!.content).toContain("TOOL_LIMIT");
    expect(events.filter((event) => event.type === "tool")).toHaveLength(12);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "end", toolCalls: 12 });
  });

  it("reports a provider failure without its text", async () => {
    const { events } = await run([new Error("upstream said: sk-secret")]);
    expect(events).toEqual([
      { type: "error", message: "The model could not answer. Try again." },
      { type: "done", reason: "error", inputTokens: 0, outputTokens: 0, toolCalls: 0 },
    ]);
  });

  it("maps a refusal and a cut-off answer", async () => {
    expect((await run([[{ type: "stop", reason: "refusal" }]])).events.at(-1)).toMatchObject({ reason: "refusal" });
    expect((await run([[{ type: "text", text: "part" }, { type: "stop", reason: "max_tokens" }]])).events.at(-1)).toMatchObject({ reason: "max_tokens" });
  });
});

describe("chat backend bucket", () => {
  it("spends its own read bucket, apart from the MCP's", async () => {
    const store = new MemoryStore();
    const keys: string[] = [];
    const consume = store.consumeRequest.bind(store);
    store.consumeRequest = async (key, limit, windowSeconds) => { keys.push(key); return consume(key, limit, windowSeconds); };
    const fetcher = createCenterReadFetcher(store, origin);
    await withBackendBucket("chat", () => fetcher(`${origin}/v1/search?q=x`));
    expect(keys).toEqual(["center:chat:reads"]);
    await fetcher(`${origin}/v1/search?q=x`);
    expect(keys).toEqual(["center:chat:reads", "center:mcp:reads"]);
  });
});
