import { pathToFileURL } from "node:url";

// Fixed origin prevents a monitoring credential from following a changed URL.
const origin = "https://juicebox.center";

export async function checkProduction({ metricsToken, fetchImpl = fetch } = {}) {
  if (!metricsToken) throw new Error("METRICS_TOKEN is required for service checks");
  async function get(path, type, authenticated = false) {
    const response = await fetchImpl(origin + path, {
      redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: authenticated ? { Authorization: `Bearer ${metricsToken}` } : {},
    });
    if (response.status !== 200 || !response.headers.get("content-type")?.includes(type))
      throw new Error(`${path}: unexpected status or content type`);
    return response;
  }
  const [capabilities, metrics] = await Promise.all([
    get("/api/v1/capabilities", "application/json").then(r => r.json()),
    get("/metrics", "text/plain", true).then(r => r.text()),
    ...["/healthz", "/readyz", "/mcp/readyz"].map(async path => {
      const value = await (await get(path, "application/json")).json();
      if (value.ok !== true && value.status !== "ready") throw new Error(`${path}: service is not ready`);
    }),
    get("/api", "text/html").then(r => r.body?.cancel()),
  ]);
  if (capabilities.protocolVersion !== 6 || capabilities.authentication?.scheme !== "none" ||
      capabilities.execution?.available !== false || capabilities.execution?.service !== "https://api.signa.center")
    throw new Error("Expected public V6 protocol preparation with Signa execution ownership");
  if (!/^jbcenter_http_requests_in_flight \d+$/m.test(metrics))
    throw new Error("Missing or invalid service metrics");
  for (const path of ["/accounts", "/api/v1/accounts/me", "/api/v1/plans/retired-plan"]) {
    const response = await fetchImpl(origin + path, { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { Origin: "https://juicebox.money" } });
    await response.body?.cancel();
    if (response.status !== 404) throw new Error(`${path}: retired account route is still exposed`);
  }
  return { healthy: true, accounts: "https://api.signa.center", protocolVersion: 6 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await checkProduction({ metricsToken: process.env.METRICS_TOKEN }))); }
  catch (error) {
    console.error(error instanceof TypeError ? "Production check could not reach the service" : error.message);
    process.exitCode = 1;
  }
}
