import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Hex } from "viem";
import type {
  PlanDraft,
  ProtocolOperation,
  ProtocolOperations,
} from "@juicebox/mcp/host";
import { createRestApp, type RestDependencies } from "../src/rest/app.js";
import { REST_LIMITS } from "../src/rest/http.js";
import type { RestPlanDraft } from "../src/rest/core.js";

const blockHash = `0x${"ab".repeat(32)}` as Hex;
const at = {
  chainId: 8453,
  blockNumber: "100",
  blockHash,
  timestamp: "1900000000",
  source: "onchain",
} as const;
const draft: RestPlanDraft = {
  operation: "prepare_pay",
  account: "0x1111111111111111111111111111111111111111",
  project: { chainId: 8453, projectId: "1", version: 6 },
  calls: [
    {
      chainId: 8453,
      to: "0x2222222222222222222222222222222222222222",
      data: "0x12345678",
      value: "123",
      label: "Pay",
      dependsOn: [],
      decoded: { functionName: "pay" },
    },
  ],
  evidence: [at],
  summary: { amount: "123" },
  warnings: [],
};
const descriptor = (
  id: string,
  transaction = false,
  externalMutation = false,
): ProtocolOperation => ({
  id,
  transaction,
  kind: transaction ? "prepare" : "read",
  description: id,
  sources: ["onchain", "indexer"],
  inputJsonSchema: { type: "object" },
  schema: z.object({}).passthrough(),
  effects: { externalMutation, idempotent: true },
  handler: async () => undefined,
});
function fixture(overrides: Partial<RestDependencies> = {}) {
  const entries = [
    descriptor("get_project"),
    descriptor("prepare_pay", true),
    descriptor("publish_intent", false, true),
  ];
  const prepare = vi.fn<ProtocolOperations["prepare"]>(
    async () =>
      ({
        ...structuredClone(draft),
        evidence: [{ ...at, source: "rpc" }],
      }) as PlanDraft,
  );
  const execute = vi.fn<ProtocolOperations["execute"]>(
    async (_id, input, options) => ({ input, source: options?.source }),
  );
  const rpc = {
    request: vi.fn(async (_chain: number, method: string) =>
      method === "eth_chainId"
        ? "0x2105"
        : {
            hash: blockHash,
            number: "0x64",
            timestamp: `0x${BigInt(at.timestamp).toString(16)}`,
          },
    ),
  };
  const generic = vi.fn(async () => ({
    ...draft,
    operation: "protocol-contract-calls",
  }));
  const counts = new Map<string, number>();
  const quota = {
    consumeRequest: vi.fn(async (key: string, maximum: number) => {
      const used = (counts.get(key) ?? 0) + 1;
      counts.set(key, used);
      return {
        allowed: used <= maximum,
        remaining: Math.max(0, maximum - used),
      };
    }),
  };
  const deps: RestDependencies = {
    quota,
    rpc,
    contracts: {
      data: { chains: [{ id: 8453 }] },
    } as RestDependencies["contracts"],
    protocol: { prepare: generic } as unknown as RestDependencies["protocol"],
    indexer: {
      catalog: () => ({ entities: [] }),
    } as unknown as RestDependencies["indexer"],
    operations: {
      list: () => entries,
      get: (id) => entries.find((entry) => entry.id === id)!,
      execute,
      prepare,
    },
    ...overrides,
  };
  const app = new Hono();
  app.route("/api/v1", createRestApp(deps));
  const post = (body: unknown, path = "/api/v1/plans") =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return { app, post, prepare, execute, rpc, generic, quota, counts };
}

describe("public protocol REST API", () => {
  it("prepares exact unsigned drafts without accounts, credentials or persistence", async () => {
    const f = fixture();
    const result = await f.post({
      operation: "prepare_pay",
      input: { account: draft.account, amount: "123" },
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ data: draft });
    expect(f.prepare).toHaveBeenCalledWith(
      "prepare_pay",
      { account: draft.account, amount: "123" },
      expect.objectContaining({ source: "onchain" }),
    );
    expect((await f.app.request("/api/v1/capabilities")).status).toBe(200);
    const capabilities = await (
      await f.app.request("/api/v1/capabilities")
    ).json();
    expect(capabilities).toMatchObject({
      authentication: { scheme: "none" },
      execution: { available: false, service: "https://api.signa.center" },
    });
    expect(capabilities).not.toHaveProperty("sessions");
  });
  it("exposes only nonmutating operations and has no account or execution routes", async () => {
    const f = fixture();
    const catalog = await (
      await f.app.request("/api/v1/catalog/operations")
    ).json();
    expect(
      catalog.data.operations.map((item: { id: string }) => item.id),
    ).toEqual(["get_project", "prepare_pay"]);
    for (const path of [
      "/accounts/enroll",
      "/accounts/me",
      "/plans/example/submit",
      "/sessions",
      "/user-operations",
      "/wallet/payment-reviews",
    ]) {
      expect((await f.post({}, `/api/v1${path}`)).status).toBe(404);
    }
    expect(
      (await f.post({ operation: "publish_intent", input: {} })).status,
    ).toBe(404);
    expect(
      (await f.app.request("/api/v1/operations/publish_intent")).status,
    ).toBe(404);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("keeps source selection explicit and preserves indexed provenance", async () => {
    const f = fixture();
    expect((await f.app.request("/api/v1/projects/8453/1")).status).toBe(400);
    const read = await f.app.request(
      "/api/v1/projects/8453/1?source=bendystraw",
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ source: "indexer" });
    expect(
      (
        await f.app.request(
          "/api/v1/projects/8453/1?source=onchain&source=bendystraw",
        )
      ).status,
    ).toBe(400);
  });
  it("validates the exact canonical head before forwarding it to protocol preparation", async () => {
    const f = fixture();
    const result = await f.post({ operation: "prepare_pay", input: {}, at });
    expect(result.status).toBe(200);
    expect(f.rpc.request.mock.calls.map((call) => call[1])).toEqual([
      "eth_chainId",
      "eth_getBlockByNumber",
    ]);
    expect(f.prepare).toHaveBeenCalledWith(
      "prepare_pay",
      {},
      expect.objectContaining({ at: { ...at, source: "rpc" } }),
    );
    const wrong = await f.post({
      operation: "prepare_pay",
      input: {},
      at: { ...at, blockHash: `0x${"cd".repeat(32)}` },
    });
    expect(wrong.status).toBe(409);
    expect(await wrong.json()).toMatchObject({
      code: "BLOCK_EVIDENCE_MISMATCH",
    });
    expect(f.prepare).toHaveBeenCalledTimes(1);
  });
  it("rejects wrong chain, malformed evidence and preparations that ignore the supplied head", async () => {
    const f = fixture();
    expect(
      (
        await f.post({
          operation: "prepare_pay",
          input: {},
          at: { ...at, source: "rpc" },
        })
      ).status,
    ).toBe(400);
    f.rpc.request.mockResolvedValueOnce("0x1");
    expect(
      (await f.post({ operation: "prepare_pay", input: {}, at })).status,
    ).toBe(502);
    f.prepare.mockResolvedValueOnce({
      ...draft,
      evidence: [{ ...at, blockNumber: "101", source: "rpc" }],
    } as PlanDraft);
    expect(
      (await f.post({ operation: "prepare_pay", input: {}, at })).status,
    ).toBe(409);
  });
  it("supports catalog call drafts and rejects unsupported pinned heads instead of ignoring them", async () => {
    const f = fixture();
    expect(
      (await f.post({ operation: "contract_calls", input: {} })).status,
    ).toBe(200);
    expect(
      (await f.post({ operation: "protocol-contract-calls", input: {} }))
        .status,
    ).toBe(200);
    expect(
      (await f.post({ operation: "contract_calls", input: {}, at })).status,
    ).toBe(400);
    expect(f.generic).toHaveBeenCalledTimes(2);
  });
  it("rejects unknown fields, malformed UTF-8, unsupported media and oversized streamed bodies", async () => {
    const f = fixture();
    expect(
      (await f.post({ operation: "prepare_pay", input: {}, ownerApproval: {} }))
        .status,
    ).toBe(400);
    expect(
      (await f.app.request("/api/v1/plans", { method: "POST", body: "{}" }))
        .status,
    ).toBe(415);
    const malformed = await f.app.request("/api/v1/plans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: new Uint8Array([0xff]),
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "INVALID_UTF8" });
    expect(
      (
        await f.post({
          operation: "prepare_pay",
          input: "x".repeat(REST_LIMITS.bodyBytes),
        })
      ).status,
    ).toBe(413);
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it("enforces durable shared and caller budgets independently of spoofed forwarding headers", async () => {
    const f = fixture();
    await f.app.request("/api/v1", {
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    await f.app.request("/api/v1", {
      headers: { "x-forwarded-for": "4.3.2.1" },
    });
    const peerKeys = [...f.counts.keys()].filter((key) =>
      key.startsWith("rest:peer:"),
    );
    expect(peerKeys).toHaveLength(1);
    expect(f.counts.get(peerKeys[0]!)).toBe(2);
    f.counts.set(peerKeys[0]!, REST_LIMITS.requestsPerMinute);
    const limited = await f.app.request("/api/v1");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    const site = fixture();
    site.counts.set("rest:site", REST_LIMITS.siteRequestsPerMinute);
    expect((await site.app.request("/api/v1")).status).toBe(429);
  });
});
