// Earlier turns arrive from the browser as plain user and assistant text, with no thinking blocks.
// That is accepted: the history check applies to thinking blocks that are replayed, and stripping
// every thinking block from history is the documented no-beta path (Claude API guide, model
// migration, "Breaking change 3: thinking blocks are preserved only in the conversation that
// produced them"). Inside one request the model's own content goes back unchanged, append-only.
import Anthropic from "@anthropic-ai/sdk";
import type { ChatConfig } from "../config.js";
import type { Provider, ProviderRequest, ToolOutcome, TurnEvent } from "../provider.js";

// Models with server-side refusal fallback. Others reject the parameter.
const FALLBACK_MODELS = new Set(["claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
const STOP: Record<string, Extract<TurnEvent, { type: "stop" }>["reason"]> = {
  end_turn: "end", stop_sequence: "end", tool_use: "tool", refusal: "refusal",
  // A full context window cuts the answer the same way the output limit does.
  max_tokens: "max_tokens", model_context_window_exceeded: "max_tokens",
};

export function anthropicProvider(config: ChatConfig, fetchImpl: typeof fetch): Provider {
  const client = new Anthropic({ apiKey: config.apiKey, fetch: fetchImpl, maxRetries: 1,
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}) });
  const fallback = FALLBACK_MODELS.has(config.model);
  return {
    start({ system, tools, messages: history, signal }: ProviderRequest) {
      const messages: Anthropic.Beta.BetaMessageParam[] = history.map(({ role, text }) => ({ role, content: text }));
      return {
        async *next(outcomes?: ToolOutcome[]): AsyncIterable<TurnEvent> {
          if (outcomes) messages.push({ role: "user", content: outcomes.map(({ id, content, isError }) => ({
            type: "tool_result" as const, tool_use_id: id, content, is_error: isError })) });
          try {
            const stream = client.beta.messages.stream({
              model: config.model,
              max_tokens: config.maxOutputTokens,
              system,
              tools: tools.map(({ name, description, inputSchema }) => ({ name, description, input_schema: inputSchema as Anthropic.Beta.BetaTool.InputSchema })),
              messages,
              thinking: { type: "adaptive" },
              output_config: { effort: config.effort },
              // Tools and system are the same on every request, so the prefix caches.
              cache_control: { type: "ephemeral" },
              ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
            }, { signal });
            for await (const event of stream)
              if (event.type === "content_block_delta" && event.delta.type === "text_delta") yield { type: "text", text: event.delta.text };
            const message = await stream.finalMessage();
            messages.push({ role: "assistant", content: message.content });
            yield { type: "usage", inputTokens: message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0)
              + (message.usage.cache_creation_input_tokens ?? 0), outputTokens: message.usage.output_tokens };
            const reason = STOP[message.stop_reason ?? ""];
            if (!reason) throw new Error("The model stopped for a reason this server does not know.");
            // A refusal or a cut-off can leave a tool call half written: never run that round's tools.
            if (reason === "tool") yield { type: "tool_calls", calls: message.content.flatMap((block) =>
              block.type === "tool_use" ? [{ id: block.id, name: block.name, input: block.input }] : []) };
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
