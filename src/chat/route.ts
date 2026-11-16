import type { ToolDefinition } from "@juicebox/mcp/host";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { ChatPage } from "../homepage.js";
import type { Metrics } from "../observability.js";
import type { Store } from "../store.js";
import type { ChatConfig } from "./config.js";
import { runChat } from "./loop.js";
import type { ChatMessage, Provider } from "./provider.js";

export type ChatRuntime = { config: ChatConfig; provider: Provider; tools: ToolDefinition[]; origin: string; page: ChatPage };

const BODY_LIMIT = 64 * 1024;
const MESSAGE_LIMIT = 8_000;
const HOUR = 3_600;
const DAY = 86_400;

/** The conversation as the page sends it: plain turns, ending with the visitor's. */
function parse(raw: string, config: ChatConfig): ChatMessage[] | "bad" | "long" {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return "bad";
  }
  const messages = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return "bad";
  let total = 0;
  for (const [index, message] of messages.entries()) {
    const { role, text } = (message ?? {}) as { role?: unknown; text?: unknown };
    // Turns alternate and the first is the visitor's, so the last is too.
    if (role !== (index % 2 === 0 ? "user" : "assistant") || typeof text !== "string" || text.length === 0) return "bad";
    if (text.length > MESSAGE_LIMIT) return "long";
    total += text.length;
  }
  if (messages.length % 2 === 0) return "bad";
  if (messages.length > config.maxMessages || total > config.maxInputChars) return "long";
  return messages.map(({ role, text }) => ({ role, text }));
}

/** `POST /chat`: the homepage's own endpoint, not a public API. Agents have `/mcp`. */
export function mountChat(app: Hono<any>, deps: { chat?: ChatRuntime; store: Store; metrics: Metrics; callerIp: (c: Context) => string }): void {
  // The limit stops reading an oversized body; it is not buffered first.
  app.post("/chat", bodyLimit({ maxSize: BODY_LIMIT, onError: (c) => c.json({ error: "too_long" }, 413) }), async (c) => {
    const { chat, store, metrics } = deps;
    if (!chat) return c.json({ error: "chat_off" }, 503);
    // Same origin only: a page elsewhere cannot spend the budget from a visitor's browser.
    if (c.req.header("origin") !== chat.origin) return c.json({ error: "forbidden_origin" }, 403);

    const messages = parse(await c.req.text(), chat.config);
    if (messages === "bad") return c.json({ error: "bad_request" }, 400);
    if (messages === "long") return c.json({ error: "too_long" }, 413);

    const ip = deps.callerIp(c);
    for (const [key, limit, windowSeconds] of [
      [`chat:h:${ip}`, chat.config.perIpPerHour, HOUR], [`chat:d:${ip}`, chat.config.perIpPerDay, DAY], ["chat:site", chat.config.sitePerDay, DAY],
    ] as const) {
      if ((await store.consumeRequest(key, limit, windowSeconds)).allowed) continue;
      metrics.observeChat({ denied: true });
      return c.json({ error: "resting" }, 429, { "Retry-After": String(windowSeconds) });
    }

    const response = streamSSE(c, async (stream) => {
      const gone = new AbortController();
      stream.onAbort(() => gone.abort());
      for await (const { type, ...data } of runChat({ config: chat.config, provider: chat.provider, tools: chat.tools, origin: chat.origin, messages, signal: gone.signal })) {
        if (type === "done") metrics.observeChat(data as never);
        await stream.writeSSE({ event: type, data: JSON.stringify(data) });
      }
    });
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Content-Type-Options", "nosniff");
    return response;
  });
}
