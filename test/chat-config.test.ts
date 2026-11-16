import { describe, expect, it } from "vitest";
import { loadChatConfig } from "../src/chat/config.js";

describe("chat config", () => {
  it("is off when no provider is set", () => {
    expect(loadChatConfig({})).toBeNull();
    expect(loadChatConfig({ CHAT_PROVIDER: "" })).toBeNull();
  });

  it("applies the documented defaults", () => {
    expect(loadChatConfig({ CHAT_PROVIDER: "anthropic", CHAT_API_KEY: "k" })).toEqual({
      provider: "anthropic", model: "claude-opus-5-5", apiKey: "k", effort: "medium",
      maxRounds: 6, maxOutputTokens: 8000, maxMessages: 24, maxInputChars: 24000, timeoutMs: 90000, toolResultBytes: 32768,
      perIpPerHour: 20, perIpPerDay: 60, sitePerDay: 3000,
    });
  });

  it("gives Ollama a local base URL and needs no key", () => {
    expect(loadChatConfig({ CHAT_PROVIDER: "ollama", CHAT_MODEL: "qwen3" })).toMatchObject({
      provider: "ollama", model: "qwen3", baseUrl: "http://127.0.0.1:11434/v1" });
    expect(loadChatConfig({ CHAT_PROVIDER: "openai", CHAT_MODEL: "m", CHAT_API_KEY: "k" })).toMatchObject({ baseUrl: "https://api.openai.com/v1" });
  });

  it("names the variable, never the value, when a setting is wrong", () => {
    expect(() => loadChatConfig({ CHAT_PROVIDER: "anthropic" })).toThrow("CHAT_API_KEY");
    expect(() => loadChatConfig({ CHAT_PROVIDER: "openai", CHAT_API_KEY: "k" })).toThrow("CHAT_MODEL");
    expect(() => loadChatConfig({ CHAT_PROVIDER: "claude" })).toThrow("CHAT_PROVIDER");
    expect(() => loadChatConfig({ CHAT_PROVIDER: "ollama", CHAT_MODEL: "m", CHAT_EFFORT: "extreme" })).toThrow("CHAT_EFFORT");
    let message = "";
    try { loadChatConfig({ CHAT_PROVIDER: "ollama", CHAT_MODEL: "m", CHAT_MAX_ROUNDS: "secret-zero" }); } catch (error) { message = String(error); }
    expect(message).toContain("CHAT_MAX_ROUNDS");
    expect(message).not.toContain("secret-zero");
  });
});
