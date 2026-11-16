import { runTool, toolJsonSchema, type ToolDefinition, type ToolResult } from "@juicebox/mcp/host";
import { withBackendBucket } from "../mcp.js";
import type { ChatConfig } from "./config.js";
import { systemPrompt } from "./prompt.js";
import type { ChatMessage, Provider, ToolCall, ToolOutcome } from "./provider.js";
import { directorySources, projectOf, sourcesFor, withSourceIds, type Source } from "./sources.js";

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; label: string }
  | { type: "source"; source: Source }
  | { type: "error"; message: string }
  | { type: "done"; reason: "end" | "max_tokens" | "refusal" | "rounds" | "error" | "gone"; inputTokens: number; outputTokens: number; toolCalls: number };

const LAST_ROUND = "\n\nThis was the last tool round. Answer now from what you have read.";
const TRUNCATED = "…[truncated, ask for a smaller page]";
// Models also group ids in one bracket, so any id in the text counts.
const CITED = /S-[0-9a-f]{6}/g;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** What the visitor sees while a tool runs. */
function label({ name, input }: ToolCall): string {
  if (name === "jb_search_reference") return "Searching the reference";
  if (name === "jb_get_reference" && isObject(input) && typeof input.id === "string") return `Reading ${input.id}`;
  const project = projectOf(input);
  if (project) return `Reading project ${project.projectId}`;
  return `Checking ${name.replace(/^jb_/, "").replaceAll("_", " ")}`;
}

// ponytail: one cap for the whole question, run together. Split per round or queue them if answers need more.
const MAX_TOOL_CALLS = 12;

const failed = (code: string, message: string): ToolResult =>
  ({ schemaVersion: 1, observedAt: new Date().toISOString(), ok: false, error: { code, message, retryable: false } });

/**
 * One chat request: the model reads Center's tools until it can answer. Yields what the page shows.
 * Every path ends with one `done`, which carries what was spent; `gone` means the caller left first.
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
      // The last round offers no tools, so the model answers from what it has read.
      for await (const event of session.next(outcomes, round >= config.maxRounds)) {
        if (event.type === "text") {
          text += event.text;
          yield event;
        } else if (event.type === "usage") {
          totals.inputTokens += event.inputTokens;
          totals.outputTokens += event.outputTokens;
        } else if (event.type === "tool_calls") calls = event.calls;
        else stop = event.reason;
      }
      if (deps.signal.aborted) break;
      if (signal.aborted || !stop) throw new Error("The model stopped without finishing.");
      if (stop !== "tool" || calls.length === 0) {
        // The directory is in the prompt, not in a tool result: send the rows this answer cited.
        const cited = new Set(text.match(CITED));
        for (const source of directorySources(origin)) if (cited.has(source.id) && !sent.has(source.id)) yield { type: "source", source };
        yield { type: "done", reason: stop === "tool" ? "end" : (stop as "end" | "max_tokens" | "refusal"), ...totals };
        return;
      }
      // A model can ask for tools even when none are offered: refuse them once, then stop.
      if (round > config.maxRounds) {
        yield { type: "done", reason: "rounds", ...totals };
        return;
      }
      // Words said before a tool call stay apart from what follows.
      if (text && !text.endsWith("\n\n")) { text += "\n\n"; yield { type: "text", text: "\n\n" }; }
      const allowed = new Set(round >= config.maxRounds ? [] : calls.slice(0, MAX_TOOL_CALLS - totals.toolCalls));
      totals.toolCalls += allowed.size;
      for (const call of allowed) yield { type: "tool", name: call.name, label: label(call) };
      const results = await Promise.all(calls.map(async (call) => {
        const tool = byName.get(call.name);
        const result = !allowed.has(call) ? failed("TOOL_LIMIT", "This question has used all its tool calls. Answer from what you have.")
          : tool ? await withBackendBucket("chat", () => runTool(tool, call.input, { signal }))
          : failed("TOOL_NOT_AVAILABLE", `The tool ${call.name} is not available here.`);
        return { call, result, sources: sourcesFor(call.name, call.input, result, origin) };
      }));
      if (deps.signal.aborted) break;
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
      if (round + 1 >= config.maxRounds && outcomes.length > 0) outcomes.at(-1)!.content += LAST_ROUND;
    }
  } catch {
    if (!deps.signal.aborted) {
      // The provider's own words can quote the request or a key, so they never reach the page.
      yield { type: "error", message: "The model could not answer. Try again." };
      yield { type: "done", reason: "error", ...totals };
      return;
    }
  }
  yield { type: "done", reason: "gone", ...totals };
}
