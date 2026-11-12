import { describe, expect, it, vi } from "vitest";
import { createServices, loadConfig } from "@juicebox/mcp/host";
import { createRestRuntime } from "../src/rest/runtime.js";
import { createApp } from "../src/app.js";
import { MemoryStore } from "./support/memoryStore.js";

vi.mock("../src/rest/site.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/rest/site.js")>(),
  readRestAssets: async () => ({ docsScript: "", documents: new Map() }),
}));

describe("protocol-only Center runtime", () => {
  it("starts without account storage, exposes public reads and cleans only quota windows", async () => {
    vi.useFakeTimers();
    const store = new MemoryStore();
    const clean = vi.spyOn(store, "cleanupRateLimits");
    const config = loadConfig({ PORT: "0" });
    const rpc = { request: vi.fn(async () => { throw new Error("Discovery must not make RPC calls"); }) };
    const runtime = await createRestRuntime({ store, services: createServices(config), config, upstreams: new Map(), rpc });
    try {
      const app = createApp(store, { rest: runtime.site });
      const capabilities = await app.request("https://juicebox.center/api/v1/capabilities");
      expect(capabilities.status).toBe(200);
      expect(await capabilities.json()).toMatchObject({ authentication: { scheme: "none" }, execution: { available: false } });
      for (const path of ["/accounts", "/wallet", "/api/v1/accounts/me", "/api/v1/sessions", "/api/v1/plans/retired"]) {
        expect((await app.request("https://juicebox.center" + path, { headers: { Origin: "https://juicebox.money" } })).status, path).toBe(404);
      }
      expect(rpc.request).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(clean).toHaveBeenCalledOnce();
      await runtime.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(clean).toHaveBeenCalledOnce();
    } finally { await runtime.stop(); vi.useRealTimers(); }
  });
});
