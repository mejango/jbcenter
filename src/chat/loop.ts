import { runTool, toolJsonSchema, type ToolDefinition, type ToolResult } from "@juicebox/mcp/host";
import { withBackendBucket } from "../mcp.js";
import type { ChatConfig } from "./config.js";
import { systemPrompt } from "./prompt.js";
import type { ChatMessage, Provider, ToolCall, ToolOutcome } from "./provider.js";
import { directorySources, sourcesFor, withSourceIds, type Source } from "./sources.js";

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; label: string }
  | { type: "source"; source: Source }
  | { type: "error"; message: string }
  | { type: "done"; reason: "end" | "max_tokens" | "refusal" | "rounds" | "error"; inputTokens: number; outputTokens: number; toolCalls: number };

const TRUNCATED = "…[truncated, ask for a smaller page]";
const CITED = /\[(S-[0-9a-f]{6})\]/g;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** What the visitor sees while a tool runs. */
function label({ name, input }: ToolCall): string {
  if (name === "jb_search_reference") return "Searching the reference";
  if (isObject(input)) {
    if (name === "jb_get_reference" && typeof input.id === "string") return `Reading ${input.id}`;
    const project = isObject(input.project) ? input.project : input;
    if (Number.isInteger(project.projectId)) return `Reading project ${project.projectId}`;
  }
  return `Checking ${name.replace(/^jb_/, "").replaceAll("_", " ")}`;
}

function refused(name: string): ToolResult {
  return { schemaVersion: 1, observedAt: new Date().toISOString(), ok: false,
    error: { code: "TOOL_NOT_AVAILABLE", message: `The tool ${name} is not available here.`, retryable: false } };
}

/**
 * One chat request: the model reads Center's tools until it can answer. Yields what the page shows.
 * A caller that goes away ends the stream without a `done`; every other path ends with one.
 */
export async function* runChat(deps: {
  config: ChatConfig; provider: Provider; tools: ToolDefinition[]; origin: string;
  messages: ChatMessage[]; signal: AbortSignal;
}): AsyncIterable<ChatEvent> {
  const { config, origin } = deps;
  const signal = AbortSignal.any([deps.signal, AbortSignal.timeout(config.timeoutMs)]);
  const byName = new Map(deps.tools.map((tool) => [tool.name, tool]));
  const totals = { inputTokens: 0, outputTokens: 0, toolCalls: 0 };
  const sent = new Set<string>();
  let text = "";
  try {
    const session = deps.provider.start({
      system: systemPrompt(origin),
      tools: deps.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: toolJsonSchema(tool) })),
      messages: deps.messages,
      signal,
    });
    let outcomes: ToolOutcome[] | undefined;
    for (let round = 1; ; round++) {
      let calls: ToolCall[] = [];
      let stop: string | undefined;
      for await (const event of session.next(outcomes)) {
        if (event.type === "text") {
          text += event.text;
          yield event;
        } else if (event.type === "usage") {
          totals.inputTokens += event.inputTokens;
          totals.outputTokens += event.outputTokens;
        } else if (event.type === "tool_calls") calls = event.calls;
        else stop = event.reason;
      }
      if (deps.signal.aborted) return;
      if (signal.aborted || !stop) throw new Error("The model stopped without finishing.");
      if (stop !== "tool" || calls.length === 0) {
        // The directory is in the prompt, not in a tool result: send the rows this answer cited.
        const cited = new Set(Array.from(text.matchAll(CITED), ([, id]) => id));
        for (const source of directorySources(origin)) if (cited.has(source.id) && !sent.has(source.id)) yield { type: "source", source };
        yield { type: "done", reason: stop === "tool" ? "end" : (stop as "end" | "max_tokens" | "refusal"), ...totals };
        return;
      }
      if (round >= config.maxRounds) {
        yield { type: "done", reason: "rounds", ...totals };
        return;
      }
      for (const call of calls) yield { type: "tool", name: call.name, label: label(call) };
      const results = await Promise.all(calls.map(async (call) => {
        const tool = byName.get(call.name);
        const result = tool ? await withBackendBucket("chat", () => runTool(tool, call.input, { signal })) : refused(call.name);
        return { call, result, sources: sourcesFor(call.name, call.input, result, origin) };
      }));
      if (deps.signal.aborted) return;
      totals.toolCalls += calls.length;
      outcomes = [];
      for (const { call, result, sources } of results) {
        for (const source of sources) {
          if (sent.has(source.id)) continue;
          sent.add(source.id);
          yield { type: "source", source };
        }
        const content = JSON.stringify(withSourceIds(result, sources));
        const bytes = Buffer.from(content);
        outcomes.push({ id: call.id, isError: !result.ok,
          content: bytes.length > config.toolResultBytes ? `${bytes.subarray(0, config.toolResultBytes).toString()}${TRUNCATED}` : content });
      }
    }
  } catch {
    if (deps.signal.aborted) return;
    // The provider's own words can quote the request or a key, so they never reach the page.
    yield { type: "error", message: "The model could not answer. Try again." };
    yield { type: "done", reason: "error", ...totals };
  }
}
