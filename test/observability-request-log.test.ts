import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Metrics } from "../src/observability.js";
import { RestError } from "../src/rest/core.js";
import { problem } from "../src/rest/http.js";
import type { JbcenterEnv } from "../src/types.js";

describe("request log", () => {
  const env = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = env; vi.restoreAllMocks(); });
  it("names the public error code of a failed response, and nothing for a successful one", async () => {
    process.env.NODE_ENV = "production";
    const lines: Record<string, unknown>[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => { lines.push(JSON.parse(line) as Record<string, unknown>); });
    const app = new Hono<JbcenterEnv>().use(new Metrics().middleware()).onError(problem);
    app.get("/ok", (c) => c.text("ok"));
    app.get("/conflict", () => { throw new RestError(409, "USER_OPERATION_SIGNED_GAS_CHANGED", "private detail"); });
    expect((await app.request("/ok")).status).toBe(200);
    expect((await app.request("/conflict")).status).toBe(409);
    expect(lines.map((line) => [line.path, line.status, line.code])).toEqual([
      ["/ok", 200, undefined],
      ["/conflict", 409, "USER_OPERATION_SIGNED_GAS_CHANGED"],
    ]);
    expect(JSON.stringify(lines)).not.toContain("private detail");
  });
});
