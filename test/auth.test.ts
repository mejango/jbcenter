import { describe, expect, it } from "vitest";
import { authenticate } from "../src/auth.js";

describe("API key authentication", () => {
  it("compares a bearer token without exposing it", () => {
    expect(authenticate("metrics-secret", "Bearer metrics-secret")).toBe(true);
    expect(authenticate("metrics-secret", "Bearer wrong")).toBe(false);
    expect(authenticate("metrics-secret", undefined)).toBe(false);
  });
});
