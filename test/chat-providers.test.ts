import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadChatConfig } from "../src/chat/config.js";
import { createProvider, type TurnEvent } from "../src/chat/provider.js";

const rounds = (name: string) => readFileSync(new URL(`./fixtures/chat/${name}.sse`, import.meta.url), "utf8").split("=== round ===\n");
const tools = [{ name: "jb_search_reference", description: "Search the reference.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }];

function recordingFetch(bodies: string[]) {
  const requests: { url: string; body: any; headers: Headers }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, body: JSON.parse(await request.text()), headers: request.headers });
    return new Response(bodies[requests.length - 1], { headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;
  return { fetchImpl, requests };
}
async function collect(events: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const all: TurnEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

const cases = [
  { name: "anthropic", fixture: "anthropic-tool-then-text", env: { CHAT_PROVIDER: "anthropic", CHAT_API_KEY: "test-key" } },
  { name: "openai", fixture: "compatible-tool-then-text", env: { CHAT_PROVIDER: "openai", CHAT_MODEL: "gpt-test", CHAT_API_KEY: "test-key" } },
  { name: "ollama", fixture: "compatible-tool-then-text", env: { CHAT_PROVIDER: "ollama", CHAT_MODEL: "qwen-test" } },
] as const;

describe.each(cases)("$name provider", ({ fixture, env, name }) => {
  const config = loadChatConfig(env)!;

  it("streams a tool call, then the answer after the tool result", async () => {
    const { fetchImpl, requests } = recordingFetch(rounds(fixture));
    const session = createProvider(config, fetchImpl).start({ system: "SYSTEM", tools,
      messages: [{ role: "user", text: "How do cash outs work?" }], signal: new AbortController().signal });

    const first = await collect(session.next());
    const calls = first.find((event) => event.type === "tool_calls");
    expect(calls).toEqual({ type: "tool_calls", calls: [{ id: expect.any(String), name: "jb_search_reference", input: { query: "cash out" } }] });
    expect(first.at(-1)).toEqual({ type: "stop", reason: "tool" });
    expect(first.find((event) => event.type === "usage")).toEqual({ type: "usage", inputTokens: 100, outputTokens: 20 });

    const id = (calls as Extract<TurnEvent, { type: "tool_calls" }>).calls[0]!.id;
    const second = await collect(session.next([{ id, content: '{"cite":[]}', isError: false }]));
    expect(second.filter((event) => event.type === "text").map((event) => (event as { text: string }).text).join("")).toBe("A cash out burns tokens [S-aaaaaa].");
    expect(second.at(-1)).toEqual({ type: "stop", reason: "end" });

    expect(requests).toHaveLength(2);
    const [one, two] = requests.map((request) => JSON.stringify(request.body));
    expect(one).toContain("SYSTEM");
    expect(one).toContain("How do cash outs work?");
    expect(one).toContain("Search the reference.");
    // The second request replays the model's own turn and carries the tool result.
    expect(two).toContain('{\\"cite\\":[]}');
    expect(two).toContain(id);
    expect(requests[0]!.body.model).toBe(config.model);
    if (name === "anthropic") {
      expect(two).toContain("sig-1");
      expect(requests[0]!.body.fallbacks).toBe("default");
      expect(requests[0]!.body.thinking).toEqual({ type: "adaptive" });
      expect(requests[0]!.body.output_config).toEqual({ effort: "medium" });
      // The SDK chooses the credential header; the key must arrive in one of them.
      expect(requests[0]!.headers.get("x-api-key") ?? requests[0]!.headers.get("authorization")).toContain("test-key");
    } else {
      expect(requests[0]!.url).toBe(`${config.baseUrl}/chat/completions`);
      expect(requests[0]!.headers.get("authorization")).toBe(name === "openai" ? "Bearer test-key" : null);
      // An Ollama model can spend its whole output on hidden reasoning unless told how hard to think.
      expect(requests[0]!.body.reasoning_effort).toBe(name === "ollama" ? "medium" : undefined);
    }
  });

  it("offers no tool call on the last round", async () => {
    const { fetchImpl, requests } = recordingFetch(rounds(fixture));
    const session = createProvider(config, fetchImpl).start({ system: "S", tools, messages: [{ role: "user", text: "q" }], signal: new AbortController().signal });
    const first = await collect(session.next());
    const id = (first.find((event) => event.type === "tool_calls") as Extract<TurnEvent, { type: "tool_calls" }>).calls[0]!.id;
    await collect(session.next([{ id, content: "{}", isError: false }], true));
    expect(requests[0]!.body.tool_choice).toBeUndefined();
    expect(requests[0]!.body.tools).toHaveLength(1);
    // Ollama models ignore tool_choice, so a compatible provider gets no tools at all.
    if (name === "anthropic") expect(requests[1]!.body.tool_choice).toEqual({ type: "none" });
    else expect(requests[1]!.body.tools).toBeUndefined();
  });

  it("ends quietly when the caller aborts", async () => {
    const controller = new AbortController();
    const fetchImpl = ((_: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as typeof fetch;
    const session = createProvider(config, fetchImpl).start({ system: "S", tools, messages: [{ role: "user", text: "q" }], signal: controller.signal });
    const pending = collect(session.next());
    setTimeout(() => controller.abort(), 10);
    expect(await pending).toEqual([]);
  });

  it("throws on a provider failure without echoing its body", async () => {
    const fetchImpl = (async () => new Response('{"error":{"type":"invalid_request_error","message":"secret detail"}}', { status: 400, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    const session = createProvider(config, fetchImpl).start({ system: "S", tools, messages: [{ role: "user", text: "q" }], signal: new AbortController().signal });
    await expect(collect(session.next())).rejects.toThrow();
  });
});

describe("a provider stream cut before its end", () => {
  const config = loadChatConfig({ CHAT_PROVIDER: "openai", CHAT_MODEL: "gpt-test", CHAT_API_KEY: "test-key" })!;
  const chunk = (delta: unknown) => `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`;
  it.each([
    ["text", chunk({ content: "Partial answer" })],
    ["a tool call", chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "jb_search_reference", arguments: '{"query":"x"}' } }] })],
  ])("is an error, not an answer: %s", async (_, body) => {
    const { fetchImpl } = recordingFetch([body]);
    const session = createProvider(config, fetchImpl).start({ system: "S", tools, messages: [{ role: "user", text: "q" }], signal: new AbortController().signal });
    const seen: TurnEvent[] = [];
    await expect((async () => { for await (const event of session.next()) seen.push(event); })()).rejects.toThrow();
    expect(seen.some((event) => event.type === "stop" || event.type === "tool_calls")).toBe(false);
  });
});

describe("anthropic stop reasons", () => {
  const config = loadChatConfig({ CHAT_PROVIDER: "anthropic", CHAT_API_KEY: "test-key" })!;
  const ending = (reason: string) => rounds("anthropic-tool-then-text")[1]!.replace('"stop_reason": "end_turn"', `"stop_reason": "${reason}"`);
  const stop = async (reason: string) => {
    const { fetchImpl } = recordingFetch([ending(reason)]);
    const session = createProvider(config, fetchImpl).start({ system: "S", tools, messages: [{ role: "user", text: "q" }], signal: new AbortController().signal });
    return (await collect(session.next())).at(-1);
  };
  it("reports a full context window as a cut-off answer", async () => {
    expect(await stop("model_context_window_exceeded")).toEqual({ type: "stop", reason: "max_tokens" });
    expect(await stop("stop_sequence")).toEqual({ type: "stop", reason: "end" });
  });
  it("fails on a reason it does not know", async () => {
    await expect(stop("some_future_reason")).rejects.toThrow();
  });
});

