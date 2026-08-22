import { describe, expect, it } from "vitest";
import { authenticate, parseApiKeys } from "../src/auth.js";

describe("API key authentication", () => {
  it("parses named keys and authenticates bearer secrets", () => {
    const keys = parseApiKeys("juicebox:one,revnet:two:with-colon");
    expect(authenticate(keys, "Bearer two:with-colon")?.name).toBe("revnet");
    expect(authenticate(keys, "Bearer wrong")).toBeNull();
    expect(authenticate(keys, undefined)).toBeNull();
  });

  it("rejects unnamed keys", () => {
    expect(() => parseApiKeys("secret-only")).toThrow("client-name:secret");
  });
});
