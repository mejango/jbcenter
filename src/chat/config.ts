export type ChatConfig = {
  provider: "anthropic" | "openai" | "ollama";
  model: string;
  apiKey?: string;
  baseUrl?: string;
  effort: "low" | "medium" | "high";
  maxRounds: number;
  maxOutputTokens: number;
  maxMessages: number;
  maxInputChars: number;
  timeoutMs: number;
  toolResultBytes: number;
  perIpPerHour: number;
  perIpPerDay: number;
  sitePerDay: number;
};

const PROVIDERS = ["anthropic", "openai", "ollama"] as const;
const EFFORTS = ["low", "medium", "high"] as const;
const BASE_URLS = { openai: "https://api.openai.com/v1", ollama: "http://127.0.0.1:11434/v1" } as const;

// A wrong setting names its variable and never echoes the value: one of them is a key.
const invalid = (name: string): never => {
  throw new Error(`${name} is missing or invalid.`);
};

/** The homepage chat's settings. `null` means chat is off: no provider was chosen. */
export function loadChatConfig(env: Record<string, string | undefined>): ChatConfig | null {
  const provider = env.CHAT_PROVIDER?.trim();
  if (!provider) return null;
  if (!(PROVIDERS as readonly string[]).includes(provider)) invalid("CHAT_PROVIDER");
  const name = provider as ChatConfig["provider"];
  const text = (key: string) => env[key]?.trim() || undefined;
  const count = (key: string, fallback: number) => {
    const raw = text(key);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value > 0 ? value : invalid(key);
  };
  const effort = text("CHAT_EFFORT") ?? "medium";
  if (!(EFFORTS as readonly string[]).includes(effort)) invalid("CHAT_EFFORT");
  const apiKey = text("CHAT_API_KEY");
  if (!apiKey && name !== "ollama") invalid("CHAT_API_KEY");
  const baseUrl = text("CHAT_BASE_URL") ?? (name === "anthropic" ? undefined : BASE_URLS[name]);
  if (baseUrl && !URL.canParse(baseUrl)) invalid("CHAT_BASE_URL");
  return {
    provider: name,
    model: text("CHAT_MODEL") ?? (name === "anthropic" ? "claude-opus-5-5" : invalid("CHAT_MODEL")),
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl: baseUrl.replace(/\/+$/, "") } : {}),
    effort: effort as ChatConfig["effort"],
    maxRounds: count("CHAT_MAX_ROUNDS", 6),
    maxOutputTokens: count("CHAT_MAX_OUTPUT_TOKENS", 8000),
    maxMessages: count("CHAT_MAX_MESSAGES", 24),
    maxInputChars: count("CHAT_MAX_INPUT_CHARS", 24000),
    timeoutMs: count("CHAT_TIMEOUT_MS", 90000),
    toolResultBytes: count("CHAT_TOOL_RESULT_BYTES", 32768),
    perIpPerHour: count("CHAT_PER_IP_PER_HOUR", 20),
    perIpPerDay: count("CHAT_PER_IP_PER_DAY", 60),
    sitePerDay: count("CHAT_SITE_PER_DAY", 3000),
  };
}
