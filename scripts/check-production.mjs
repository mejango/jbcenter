import { pathToFileURL } from "node:url";

// Fixed origin prevents a monitoring credential from following a changed URL.
const origin = "https://juicebox.center";

export async function checkProduction({
  metricsToken,
  fetchImpl = fetch,
  now = Date.now() / 1000,
} = {}) {
  if (!metricsToken) throw new Error("METRICS_TOKEN is required for recovery checks");
  async function get(path, type, authenticated = false) {
    const response = await fetchImpl(origin + path, {
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: authenticated ? { Authorization: `Bearer ${metricsToken}` } : {},
    });
    if (response.status !== 200 || !response.headers.get("content-type")?.includes(type))
      throw new Error(`${path}: unexpected status or content type`);
    return response;
  }
  const [capabilities, metrics] = await Promise.all([
    get("/api/v1/capabilities", "application/json").then((r) => r.json()),
    get("/metrics", "text/plain", true).then((r) => r.text()),
    ...["/healthz", "/readyz", "/mcp/readyz"].map(async (path) => {
      await (await get(path, "application/json")).body?.cancel();
    }),
    ...["/accounts", "/api"].map(async (path) => {
      await (await get(path, "text/html")).body?.cancel();
    }),
  ]);
  const chains = capabilities.userOperations?.providers?.map((p) => p.chainId).sort((a, b) => a - b);
  if (capabilities.protocolVersion !== 6 ||
      !capabilities.userOperations?.preparation || !capabilities.userOperations?.relay ||
      !capabilities.userOperations.providers.every((p) => p.paymasterConfigured === true) ||
      JSON.stringify(chains) !== "[1,10,8453,42161]")
    throw new Error("Expected V6 sponsored execution on all four mainnets");
  for (const task of ["nonce_cleanup", "transactions", "user_operations"]) {
    function value(name) {
      const match = metrics.match(new RegExp(`^jbcenter_rest_recovery_${name}\\{task="${task}"\\} ([^\\n]+)$`, "m"));
      if (!match || !Number.isFinite(Number(match[1])))
        throw new Error(`${task}: missing or invalid recovery metric`);
      return Number(match[1]);
    }
    const completed = value("last_completed_timestamp_seconds");
    if (completed <= 0 || completed > now + 30 || now - completed > 180)
      throw new Error(`${task}: recovery has not completed in the last three minutes`);
    if (value("last_failures") !== 0)
      throw new Error(`${task}: the latest recovery sweep reported failures`);
    const oldestPending = value("sample_oldest_pending_timestamp_seconds");
    if (oldestPending < 0 || oldestPending > now + 30)
      throw new Error(`${task}: invalid pending timestamp`);
    if (oldestPending > 0 && now - oldestPending > 1800)
      throw new Error(`${task}: a sampled transaction has remained unresolved for over thirty minutes`);
  }
  return { healthy: true, chains, recovery: "recent sweeps have no reported failures or sampled overdue transactions" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await checkProduction({ metricsToken: process.env.METRICS_TOKEN })));
  } catch (error) {
    // Fetch errors are deliberately summarized: never log headers or response bodies.
    console.error(error instanceof TypeError ? "Production check could not reach the service" : error.message);
    process.exitCode = 1;
  }
}
