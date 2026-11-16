import type { ChatConfig } from "../config.js";
import type { Provider, ProviderRequest, ToolCall, ToolOutcome, TurnEvent } from "../provider.js";

type WireMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };
const STOP: Record<string, Extract<TurnEvent, { type: "stop" }>["reason"]> = {
  tool_calls: "tool", length: "max_tokens", content_filter: "refusal",
};

/** `data:` payloads of a server-sent event stream, one per event. */
async function* dataLines(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end).trimEnd();
      buffer = buffer.slice(end + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
}

/** The chat completions wire format, which OpenAI and Ollama both serve. */
export function compatibleProvider(config: ChatConfig, fetchImpl: typeof fetch): Provider {
  return {
    start({ system, tools, messages: history, signal }: ProviderRequest) {
      const messages: WireMessage[] = [{ role: "system", content: system }, ...history.map(({ role, text }) => ({ role, content: text }))];
      return {
        async *next(outcomes?: ToolOutcome[]): AsyncIterable<TurnEvent> {
          for (const { id, content } of outcomes ?? []) messages.push({ role: "tool", tool_call_id: id, content });
          try {
            const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
              method: "POST",
              signal,
              headers: { "Content-Type": "application/json", ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
              body: JSON.stringify({
                model: config.model,
                messages,
                tools: tools.map(({ name, description, inputSchema }) => ({ type: "function", function: { name, description, parameters: inputSchema } })),
                stream: true,
                stream_options: { include_usage: true },
                // OpenAI's current models take max_completion_tokens; Ollama takes max_tokens.
                [config.provider === "openai" ? "max_completion_tokens" : "max_tokens"]: config.maxOutputTokens,
              }),
            });
            // The body can quote the request, so it is never part of the error.
            if (!response.ok || !response.body) throw new Error(`The model provider answered ${response.status}.`);
            let text = "";
            let finish = "";
            const calls: { id: string; name: string; arguments: string }[] = [];
            for await (const data of dataLines(response.body)) {
              if (data === "[DONE]") break;
              const chunk = JSON.parse(data);
              if (chunk.usage) yield { type: "usage", inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 };
              const choice = chunk.choices?.[0];
              if (!choice) continue;
              if (typeof choice.delta?.content === "string" && choice.delta.content) {
                text += choice.delta.content;
                yield { type: "text", text: choice.delta.content };
              }
              for (const part of choice.delta?.tool_calls ?? []) {
                const call = (calls[part.index ?? 0] ??= { id: "", name: "", arguments: "" });
                if (part.id) call.id = part.id;
                if (part.function?.name) call.name = part.function.name;
                if (part.function?.arguments) call.arguments += part.function.arguments;
              }
              if (choice.finish_reason) finish = choice.finish_reason;
            }
            const made = calls.filter(Boolean).map((call, index) => ({ ...call, id: call.id || `call_${index}` }));
            const reason = STOP[finish] ?? (made.length > 0 && finish !== "stop" ? "tool" : "end");
            messages.push({ role: "assistant", content: text || null, ...(made.length > 0 ? { tool_calls: made.map(({ id, name, arguments: json }) => ({
              id, type: "function" as const, function: { name, arguments: json } })) } : {}) });
            if (reason === "tool") yield { type: "tool_calls", calls: made.map(({ id, name, arguments: json }): ToolCall => {
              // Unparseable arguments stay a string; the tool's own schema then rejects them.
              try { return { id, name, input: JSON.parse(json || "{}") }; } catch { return { id, name, input: json }; }
            }) };
            yield { type: "stop", reason };
          } catch (error) {
            if (signal.aborted) return;
            throw error;
          }
        },
      };
    },
  };
}
