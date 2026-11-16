import type { ChatConfig } from "./config.js";
import { anthropicProvider } from "./providers/anthropic.js";
import { compatibleProvider } from "./providers/compatible.js";

export type ChatMessage = { role: "user" | "assistant"; text: string };
export type ProviderTool = { name: string; description: string; inputSchema: Record<string, unknown> };
export type ToolCall = { id: string; name: string; input: unknown };
export type TurnEvent =
  | { type: "text"; text: string }
  | { type: "tool_calls"; calls: ToolCall[] }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "stop"; reason: "end" | "tool" | "max_tokens" | "refusal" };
export type ToolOutcome = { id: string; content: string; isError: boolean };

/** One request's conversation with the model. It owns the provider's own transcript, so whatever
 * the model produced (thinking, tool calls) goes back unchanged on the next round. */
export interface ProviderSession {
  /** One model round. Pass the outcomes of the tool calls the previous round asked for. Ends without
   * events when the caller aborted; throws on a provider failure. */
  next(outcomes?: ToolOutcome[]): AsyncIterable<TurnEvent>;
}
export type ProviderRequest = { system: string; tools: ProviderTool[]; messages: ChatMessage[]; signal: AbortSignal };
export interface Provider {
  start(request: ProviderRequest): ProviderSession;
}

export function createProvider(config: ChatConfig, fetchImpl: typeof fetch = fetch): Provider {
  return config.provider === "anthropic" ? anthropicProvider(config, fetchImpl) : compatibleProvider(config, fetchImpl);
}
