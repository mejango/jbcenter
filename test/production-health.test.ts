import { describe, expect, it, vi } from "vitest";
const { checkProduction } = await import(new URL("../scripts/check-production.mjs", import.meta.url).href);
function fixture(change: Record<string, unknown> = {}) {
  return vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (["/accounts", "/api/v1/accounts/me", "/api/v1/plans/retired-plan"].includes(path)) return new Response("", { status: 404 });
    if (path === "/api") return new Response("<html>", { headers: { "content-type": "text/html" } });
    if (path === "/metrics") return new Response("jbcenter_http_requests_in_flight 0\n", { headers: { "content-type": "text/plain" } });
    return Response.json(path === "/api/v1/capabilities" ? { protocolVersion: 6, authentication: { scheme: "none" }, execution: { available: false, service: "https://api.signa.center" }, ...change } : { ok: true });
  });
}
describe("production protocol monitor", () => {
  it("checks protocol readiness and retired routes, sending credentials only to metrics", async () => {
    const fetchImpl = fixture();
    await expect(checkProduction({ metricsToken: "secret", fetchImpl })).resolves.toMatchObject({ healthy: true });
    for (const [url, options] of fetchImpl.mock.calls as unknown as [string, RequestInit][]) {
      expect(url).toMatch(/^https:\/\/juicebox\.center\//);
      expect(options.redirect).toBe("error");
      expect(new Headers(options.headers).get("authorization")).toBe(url.endsWith("/metrics") ? "Bearer secret" : null);
    }
  });
  it("rejects account execution capability on Center", async () => {
    await expect(checkProduction({ metricsToken: "secret", fetchImpl: fixture({ execution: { available: true } }) })).rejects.toThrow("Signa execution");
  });
  it("rejects a failed readiness response", async () => {
    const fallback = fixture();
    const fetchImpl = async (url: string) => url.endsWith("/readyz") ? Response.json({ ok: false }) : fallback(url);
    await expect(checkProduction({ metricsToken: "secret", fetchImpl })).rejects.toThrow("not ready");
  });
});
