import { describe, expect, it } from "vitest";
const { checkProduction } = await import(new URL("../scripts/check-production.mjs", import.meta.url).href);

const now = 1_800_000_000;
function fixture({ stale = false, failures = 0, missing = false, pendingAge = 0, paymaster = true, chains = [1, 10, 8453, 42161] } = {}) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  return {
    requests,
    fetchImpl: async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      const path = new URL(url).pathname;
      if (path === "/metrics") return new Response(missing ? "" : ["nonce_cleanup", "transactions", "user_operations"].flatMap((task) => [
        `jbcenter_rest_recovery_last_completed_timestamp_seconds{task="${task}"} ${now - (stale ? 181 : 30)}`,
        `jbcenter_rest_recovery_last_failures{task="${task}"} ${failures}`,
        `jbcenter_rest_recovery_sample_oldest_pending_timestamp_seconds{task="${task}"} ${pendingAge ? now - pendingAge : 0}`,
      ]).join("\n"), { headers: { "content-type": "text/plain" } });
      if (path === "/api" || path === "/accounts") return new Response("<html></html>", { headers: { "content-type": "text/html" } });
      return Response.json(path.endsWith("capabilities") ? {
        protocolVersion: 6,
        userOperations: { preparation: true, relay: true, providers: chains.map((chainId) => ({ chainId, paymasterConfigured: paymaster })) },
      } : { ok: true });
    },
  };
}

describe("standalone production monitor", () => {
  it("checks hosted execution and recovery, sending its credential only to the fixed metrics URL", async () => {
    const f = fixture();
    expect(await checkProduction({ ...f, now, metricsToken: "private-test-token" })).toMatchObject({ healthy: true });
    for (const { url, init } of f.requests) {
      expect(init.redirect).toBe("error");
      expect(init.headers).toEqual(url.endsWith("/metrics") ? { Authorization: "Bearer private-test-token" } : {});
      expect(new URL(url).origin).toBe("https://juicebox.center");
    }
  });
  it.each([
    [{ stale: true }, /last three minutes/],
    [{ failures: 1 }, /reported failures/],
    [{ pendingAge: 1801 }, /over thirty minutes/],
    [{ missing: true }, /missing or invalid/],
    [{ chains: [10, 8453, 42161] }, /four mainnets/],
    [{ paymaster: false }, /four mainnets/],
  ])("fails when execution or recovery is unhealthy: %j", async (options, message) => {
    await expect(checkProduction({ ...fixture(options), now, metricsToken: "test" })).rejects.toThrow(message);
  });
  it("fails closed without a monitoring credential", async () => {
    await expect(checkProduction()).rejects.toThrow("METRICS_TOKEN");
  });
});
