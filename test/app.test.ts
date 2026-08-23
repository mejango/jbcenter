import { randomUUID } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { createApp, originsForEnvironment } from "../src/app.js";
import { DeploymentVerificationError } from "../src/deploymentVerifier.js";
import type { RpcGateway } from "../src/rpc.js";
import {
  ConflictError,
  type NewDeployment,
  type NewIntent,
  type StorageLimits,
  type Store,
} from "../src/store.js";
import type { Deployment, Intent, SearchPage } from "../src/types.js";

class MemoryStore implements Store {
  intents: Intent[] = [];
  requests = new Map<string, number>();

  async health() {}

  async consumeRequest(client: string, limit: number) {
    const count = (this.requests.get(client) ?? 0) + 1;
    this.requests.set(client, count);
    return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
  }

  async createIntent(value: NewIntent, _limits: StorageLimits) {
    const existing = this.intents.find(
      (intent) => intent.publisher === value.publisher && intent.contentHash === value.contentHash,
    );
    if (existing) return { intent: existing, created: false };
    const intent: Intent = {
      ...value,
      id: randomUUID(),
      status: "undeployed",
      createdAt: new Date().toISOString(),
      deployments: [],
    };
    this.intents.push(intent);
    return { intent, created: true };
  }

  async getIntent(id: string) {
    return this.intents.find((intent) => intent.id === id) ?? null;
  }

  async search(query: string, limit: number, offset: number): Promise<SearchPage> {
    const values = this.intents.filter(
      (intent) =>
        intent.deployments.length === 0 &&
        [intent.name, intent.description, intent.tagline, ...intent.tags]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(query.toLowerCase()),
    );
    const page = values.slice(offset, offset + limit);
    return {
      items: page.map((intent) => ({
        source: "jbcenter",
        status: "undeployed",
        intentId: intent.id,
        contentHash: intent.contentHash,
        format: intent.envelope.format,
        deploymentVersion: intent.envelope.deploymentVersion,
        chainIds: intent.envelope.chainIds,
        publisher: intent.publisher,
        name: intent.name,
        description: intent.description,
        tagline: intent.tagline,
        tags: intent.tags,
        logoUri: intent.logoUri,
        owner: intent.owner,
        createdAt: intent.createdAt,
      })),
      totalCount: values.length,
      nextCursor: offset + page.length < values.length ? String(offset + page.length) : null,
    };
  }

  async recordDeployment(intentId: string, value: NewDeployment): Promise<Deployment> {
    const intent = this.intents.find(({ id }) => id === intentId)!;
    const existing = intent.deployments.find(({ chainId }) => chainId === value.chainId);
    if (existing) {
      if (
        existing.projectId !== value.projectId ||
        existing.transactionHash !== value.transactionHash
      ) {
        throw new ConflictError("A different deployment is already recorded for that chain");
      }
      return existing;
    }
    const deployment: Deployment = { ...value, createdAt: new Date().toISOString() };
    intent.deployments.push(deployment);
    intent.status = "deployed";
    return deployment;
  }
}

const account = privateKeyToAccount(
  "0x0123456789012345678901234567890123456789012345678901234567890123",
);
const trusted = {
  origin: "https://juicebox.money",
  "content-type": "application/json",
};
const verifier = { verify: vi.fn(async () => {}) };
const envelope = {
  format: "juicebox.money/v1",
  deploymentVersion: "6",
  chainIds: [1],
  deploymentCalls: [
    {
      chainId: 1,
      to: "0x3333333333333333333333333333333333333333",
      data: "0x12345678",
    },
  ],
  jb: {
    v: 1,
    name: "Public goods garden",
    description: "Fund climate work",
    tagline: "Grow something useful",
    tags: ["climate", "public-goods"],
    chains: [1],
    stages: [{}],
    owner: account.address,
  },
};

async function publish(app: ReturnType<typeof createApp>) {
  const preparedResponse = await app.request("/v1/intents/message", {
    method: "POST",
    headers: trusted,
    body: JSON.stringify(envelope),
  });
  const prepared = (await preparedResponse.json()) as { message: string };
  const signature = await account.signMessage({ message: prepared.message });
  return app.request("/v1/intents", {
    method: "POST",
    headers: trusted,
    body: JSON.stringify({ ...envelope, publisher: account.address, signature }),
  });
}

describe("JB Center API", () => {
  it("requires a trusted browser origin", async () => {
    const response = await createApp(new MemoryStore()).request("/v1/search");
    expect(response.status).toBe(403);
  });

  it("separates liveness, readiness, and protected metrics", async () => {
    const app = createApp(new MemoryStore(), { metricsToken: "metrics-secret" });
    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/readyz")).status).toBe(200);
    expect((await app.request("/metrics")).status).toBe(404);
    const metrics = await app.request("/metrics", {
      headers: { authorization: "Bearer metrics-secret" },
    });
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain("jbcenter_http_requests_total");
  });

  it("accepts only Juicebox Money and Revnet Money browser origins", async () => {
    const app = createApp(new MemoryStore());
    const rejected = await app.request("/v1/search", {
      headers: { ...trusted, origin: "https://example.com" },
    });
    expect(rejected.status).toBe(403);

    for (const origin of ["https://juicebox.money", "https://revnet.money"]) {
      const accepted = await app.request("/v1/search", { headers: { ...trusted, origin } });
      expect(accepted.status).toBe(200);
      expect(accepted.headers.get("access-control-allow-origin")).toBe(origin);
    }
  });

  it("isolates the dev browser origin from production", async () => {
    expect(originsForEnvironment("production")).toEqual([
      "https://juicebox.money",
      "https://revnet.money",
    ]);
    const devOrigins = originsForEnvironment("dev");
    expect(devOrigins).toEqual(["https://dev.juicebox.money", "https://dev.revnet.money"]);

    const app = createApp(new MemoryStore(), { allowedOrigins: devOrigins });
    for (const origin of ["https://dev.juicebox.money", "https://dev.revnet.money"]) {
      const accepted = await app.request("/v1/search", { headers: { ...trusted, origin } });
      expect(accepted.status).toBe(200);
      expect(accepted.headers.get("access-control-allow-origin")).toBe(origin);
    }
    for (const origin of ["https://juicebox.money", "https://revnet.money"]) {
      const rejected = await app.request("/v1/search", {
        headers: { ...trusted, origin },
      });
      expect(rejected.status).toBe(403);
    }
  });

  it("publishes idempotently, searches, reads, and retires a deployed intent", async () => {
    const store = new MemoryStore();
    const app = createApp(store, { deploymentVerifier: verifier });
    const created = await publish(app);
    expect(created.status).toBe(201);
    const intent = (await created.json()) as Intent;
    expect(intent.name).toBe("Public goods garden");
    expect(intent.owner).toBe(account.address);

    const repeated = await publish(app);
    expect(repeated.status).toBe(200);
    expect(((await repeated.json()) as Intent).id).toBe(intent.id);

    const search = await app.request("/v1/search?q=climate", { headers: trusted });
    const results = (await search.json()) as SearchPage;
    expect(results.items).toHaveLength(1);
    expect(results.items[0]?.source).toBe("jbcenter");

    const reconciled = await app.request(`/v1/intents/${intent.id}/deployments`, {
      method: "POST",
      headers: trusted,
      body: JSON.stringify({
        chainId: 1,
        projectId: "42",
        transactionHash: `0x${"12".repeat(32)}`,
      }),
    });
    expect(reconciled.status).toBe(201);
    expect(verifier.verify).toHaveBeenCalledWith(
      expect.objectContaining({ call: envelope.deploymentCalls[0] }),
    );
    const after = (await (
      await app.request("/v1/search?q=climate", { headers: trusted })
    ).json()) as SearchPage;
    expect(after.items).toHaveLength(0);

    const fetched = await app.request(`/v1/intents/${intent.id}`, { headers: trusted });
    const deployed = (await fetched.json()) as Intent;
    expect(deployed.status).toBe("deployed");
    expect(deployed.deployments[0]?.projectId).toBe("42");
  });

  it("rejects a signature after the signed content is changed", async () => {
    const store = new MemoryStore();
    const app = createApp(store);
    const prepared = (await (
      await app.request("/v1/intents/message", {
        method: "POST",
        headers: trusted,
        body: JSON.stringify(envelope),
      })
    ).json()) as { message: string };
    const signature = await account.signMessage({ message: prepared.message });
    const response = await app.request("/v1/intents", {
      method: "POST",
      headers: trusted,
      body: JSON.stringify({
        ...envelope,
        jb: { ...envelope.jb, name: "Tampered" },
        publisher: account.address,
        signature,
      }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects a signature after committed deployment calldata is changed", async () => {
    const app = createApp(new MemoryStore());
    const prepared = (await (
      await app.request("/v1/intents/message", {
        method: "POST",
        headers: trusted,
        body: JSON.stringify(envelope),
      })
    ).json()) as { message: string };
    const signature = await account.signMessage({ message: prepared.message });
    const response = await app.request("/v1/intents", {
      method: "POST",
      headers: trusted,
      body: JSON.stringify({
        ...envelope,
        deploymentCalls: [{ ...envelope.deploymentCalls[0], data: "0x87654321" }],
        publisher: account.address,
        signature,
      }),
    });
    expect(response.status).toBe(400);
  });

  it("enforces per-origin caller request limits", async () => {
    const store = new MemoryStore();
    const app = createApp(store, {
      deploymentVerifier: verifier,
      requestLimitPerMinute: 1,
    });
    const first = await app.request("/v1/search", { headers: trusted });
    const limited = await app.request("/v1/search", { headers: trusted });
    expect(first.status).toBe(200);
    expect(limited.status).toBe(429);
  });

  it("exposes RPC reads directly to trusted browser origins only", async () => {
    const rpc: RpcGateway = {
      supports: (chainId: number) => chainId === 1,
      request: async (chainId, request) => ({
        jsonrpc: "2.0",
        id: request.id,
        result: `0x${chainId.toString(16)}`,
      }),
    };
    const app = createApp(new MemoryStore(), { rpc });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "eth_chainId", params: [] });

    const anonymous = await app.request("/v1/rpc/1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(anonymous.status).toBe(403);

    const rejected = await app.request("/v1/rpc/1", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://example.com" },
      body,
    });
    expect(rejected.status).toBe(403);

    const accepted = await app.request("/v1/rpc/1", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://juicebox.money" },
      body,
    });
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("access-control-allow-origin")).toBe("https://juicebox.money");
    await expect(accepted.json()).resolves.toEqual({ jsonrpc: "2.0", id: 7, result: "0x1" });
  });

  it("enforces independent caller and site RPC budgets", async () => {
    const store = new MemoryStore();
    const app = createApp(store, {
      rpc: {
        supports: () => true,
        request: async (_chainId, request) => ({ jsonrpc: "2.0", id: request.id, result: "0x1" }),
      },
      rpcRequestLimitPerMinute: 1,
      rpcSiteLimitPerMinute: 2,
    });
    const request = (origin: string, ip: string) =>
      app.request("/v1/rpc/1", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "x-forwarded-for": ip,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }),
      });

    expect((await request("https://juicebox.money", "1.1.1.1")).status).toBe(200);
    expect((await request("https://juicebox.money", "1.1.1.1")).status).toBe(429);
    expect((await request("https://revnet.money", "2.2.2.2")).status).toBe(200);
    expect((await request("https://revnet.money", "3.3.3.3")).status).toBe(429);
  });

  it("fails closed when RPC cannot verify a deployment", async () => {
    const store = new MemoryStore();
    const app = createApp(store, {
      deploymentVerifier: {
        verify: async () => {
          throw new DeploymentVerificationError("receipt unavailable");
        },
      },
    });
    const created = (await (await publish(app)).json()) as Intent;
    const response = await app.request(`/v1/intents/${created.id}/deployments`, {
      method: "POST",
      headers: trusted,
      body: JSON.stringify({
        chainId: 1,
        projectId: "42",
        transactionHash: `0x${"12".repeat(32)}`,
      }),
    });
    expect(response.status).toBe(422);
    expect(store.intents[0]?.status).toBe("undeployed");
  });

  it("keeps concurrent duplicate publications idempotent", async () => {
    const store = new MemoryStore();
    const app = createApp(store);
    const responses = await Promise.all(Array.from({ length: 25 }, () => publish(app)));
    expect(responses.filter(({ status }) => status === 201)).toHaveLength(1);
    expect(responses.filter(({ status }) => status === 200)).toHaveLength(24);
    expect(store.intents).toHaveLength(1);
  });
});
