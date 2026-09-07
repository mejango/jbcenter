import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { Pool } from "pg";
import { createCenterMcp } from "../src/mcp.js";
import type { Store } from "../src/store.js";
import { createRestRuntime } from "../src/rest/runtime.js";
import { readRestExecutionConfiguration } from "../src/rest/executionConfig.js";

// Asset packaging is checked by the production build. This suite exercises the
// real runtime composition and public readiness without opening a DB or network.
vi.mock("../src/rest/site.js", async (original) => ({
  ...(await original<typeof import("../src/rest/site.js")>()),
  readRestAssets: async () => ({ accountsScript: "", documents: new Map() }),
}));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture(configured: boolean) {
  const pool = new Pool({
    connectionString: "postgresql://fixture@127.0.0.1:1/unused",
  });
  const query = vi.spyOn(pool, "query").mockImplementation(() => {
    throw new Error("Unexpected database request during discovery");
  });
  const request = vi.fn(async (): Promise<never> => {
    throw new Error("Unexpected upstream request during discovery");
  });
  const store = {
    consumeRequest: async () => ({ allowed: true, remaining: 100 }),
  } as unknown as Store;
  const mcp = createCenterMcp(store, {
    rpc: { request, supports: () => true },
    env: {
      MCP_PLAN_SECRET: "PUBLIC_TEST_ONLY_RUNTIME_DISCOVERY_SECRET",
      MCP_PUBLIC_ORIGIN: "https://juicebox.center",
    },
  });
  const executionConfiguration = await readRestExecutionConfiguration(
    configured
      ? JSON.stringify({
          chains: [
            {
              chainId: 11155111,
              bundlerUrl: "https://bundler.invalid/SECRET_FIXTURE",
              paymasterUrl: "https://paymaster.invalid/SECRET_FIXTURE",
              paymasterPolicyId: "fixture",
              sessionGuardAddress: "0x6000000000000000000000000000000000000006",
              gas: {
                maximumCallGas: "1000000",
                maximumVerificationGas: "1000000",
                maximumPreVerificationGas: "100000",
                maximumPaymasterVerificationGas: "100000",
                maximumPaymasterPostOpGas: "0",
                maximumFeePerGas: "1000000000",
                maximumPriorityFeePerGas: "100000000",
                maximumCost: "10000000000000000",
              },
            },
          ],
        })
      : {},
  );
  const runtime = await createRestRuntime({
    pool,
    store,
    services: mcp.services,
    config: mcp.config,
    upstreams: new Map(),
    rpc: { request },
    executionConfiguration,
    startMaintenance: false,
  });
  cleanup.push(async () => {
    await runtime.stop();
    await pool.end();
  });
  const app = new Hono().route("/api/v1", runtime.site.app);
  return { app, request, query };
}
describe("production execution runtime composition", () => {
  it.each([false, true])(
    "reports exact configured execution readiness without upstream access: %s",
    async (configured) => {
      const f = await fixture(configured);
      const response = await f.app.request("/api/v1/capabilities");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.smartAccounts.deployments).toHaveLength(8);
      expect(
        body.smartAccounts.deployments.every(
          (d: { mode: string; manifest: unknown }) =>
            d.mode === "execution-candidate" && d.manifest,
        ),
      ).toBe(true);
      expect(body.userOperations.preparation).toBe(configured);
      expect(body.userOperations.relay).toBe(configured);
      expect(body.sessions.activationReady).toBe(configured);
      expect(body.sessions.requiresVerifiedGuardDeployment).toBe(true);
      expect(
        body.transactions.transports.find(
          (t: { kind: string }) => t.kind === "eip4337-user-operation",
        ).supported,
      ).toBe(configured);
      expect(body.transactions.authorization.onchainSessionKeysSupported).toBe(
        configured,
      );
      expect(JSON.stringify(body)).not.toContain("SECRET_FIXTURE");
      expect(f.request).not.toHaveBeenCalled();
      expect(f.query).not.toHaveBeenCalled();
      const spec = await (await f.app.request("/api/v1/openapi.json")).json();
      for (const route of [
        "/smart-accounts/creation-plans",
        "/smart-accounts/sessions",
        "/user-operations",
      ]) {
        expect(spec.paths[`/api/v1${route}`].post).toBeDefined();
        const rejected = await f.app.request(`/api/v1${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        expect(rejected.status).toBe(401);
      }
      expect(f.request).not.toHaveBeenCalled();
      expect(f.query).not.toHaveBeenCalled();
    },
  );
});
