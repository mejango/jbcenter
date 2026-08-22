import { randomUUID } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { DeploymentVerificationError } from "../src/deploymentVerifier.js";
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
const auth = { authorization: "Bearer test-secret", "content-type": "application/json" };
const reconcilerAuth = {
  authorization: "Bearer reconcile-secret",
  "content-type": "application/json",
};
const keys = [
  { name: "test", secret: "test-secret", role: "client" as const },
  { name: "reconciler", secret: "reconcile-secret", role: "reconciler" as const },
];
const verifier = { verify: async () => {} };
const envelope = {
  format: "juicebox.money/v1",
  deploymentVersion: "6",
  chainIds: [1],
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
    headers: auth,
    body: JSON.stringify(envelope),
  });
  const prepared = (await preparedResponse.json()) as { message: string };
  const signature = await account.signMessage({ message: prepared.message });
  return app.request("/v1/intents", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ ...envelope, publisher: account.address, signature }),
  });
}

describe("JB Center API", () => {
  it("requires a trusted client key", async () => {
    const response = await createApp(new MemoryStore(), keys).request("/v1/search");
    expect(response.status).toBe(401);
  });

  it("separates liveness, readiness, and protected metrics", async () => {
    const app = createApp(new MemoryStore(), keys, { metricsToken: "metrics-secret" });
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
    const app = createApp(new MemoryStore(), keys);
    const rejected = await app.request("/v1/search", {
      headers: { ...auth, origin: "https://example.com" },
    });
    expect(rejected.status).toBe(403);

    for (const origin of ["https://juicebox.money", "https://revnet.money"]) {
      const accepted = await app.request("/v1/search", { headers: { ...auth, origin } });
      expect(accepted.status).toBe(200);
      expect(accepted.headers.get("access-control-allow-origin")).toBe(origin);
    }
  });

  it("publishes idempotently, searches, reads, and retires a deployed intent", async () => {
    const store = new MemoryStore();
    const app = createApp(store, keys, { deploymentVerifier: verifier });
    const created = await publish(app);
    expect(created.status).toBe(201);
    const intent = (await created.json()) as Intent;
    expect(intent.name).toBe("Public goods garden");
    expect(intent.owner).toBe(account.address);

    const repeated = await publish(app);
    expect(repeated.status).toBe(200);
    expect(((await repeated.json()) as Intent).id).toBe(intent.id);

    const search = await app.request("/v1/search?q=climate", { headers: auth });
    const results = (await search.json()) as SearchPage;
    expect(results.items).toHaveLength(1);
    expect(results.items[0]?.source).toBe("jbcenter");

    const deployment = await app.request(`/v1/intents/${intent.id}/deployments`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        chainId: 1,
        projectId: "42",
        transactionHash: `0x${"12".repeat(32)}`,
      }),
    });
    expect(deployment.status).toBe(403);
    const reconciled = await app.request(`/v1/intents/${intent.id}/deployments`, {
      method: "POST",
      headers: reconcilerAuth,
      body: JSON.stringify({
        chainId: 1,
        projectId: "42",
        transactionHash: `0x${"12".repeat(32)}`,
      }),
    });
    expect(reconciled.status).toBe(201);
    const after = (await (
      await app.request("/v1/search?q=climate", { headers: auth })
    ).json()) as SearchPage;
    expect(after.items).toHaveLength(0);

    const fetched = await app.request(`/v1/intents/${intent.id}`, { headers: auth });
    const deployed = (await fetched.json()) as Intent;
    expect(deployed.status).toBe("deployed");
    expect(deployed.deployments[0]?.projectId).toBe("42");
  });

  it("rejects a signature after the signed content is changed", async () => {
    const store = new MemoryStore();
    const app = createApp(store, keys);
    const prepared = (await (
      await app.request("/v1/intents/message", {
        method: "POST",
        headers: auth,
        body: JSON.stringify(envelope),
      })
    ).json()) as { message: string };
    const signature = await account.signMessage({ message: prepared.message });
    const response = await app.request("/v1/intents", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        ...envelope,
        jb: { ...envelope.jb, name: "Tampered" },
        publisher: account.address,
        signature,
      }),
    });
    expect(response.status).toBe(400);
  });

  it("requires a reconciler key and enforces per-key request limits", async () => {
    const store = new MemoryStore();
    const app = createApp(store, keys, {
      deploymentVerifier: verifier,
      requestLimitPerMinute: 1,
    });
    const first = await app.request("/v1/search", { headers: auth });
    const limited = await app.request("/v1/search", { headers: auth });
    expect(first.status).toBe(200);
    expect(limited.status).toBe(429);
  });

  it("fails closed when RPC cannot verify a deployment", async () => {
    const store = new MemoryStore();
    const app = createApp(store, keys, {
      deploymentVerifier: {
        verify: async () => {
          throw new DeploymentVerificationError("receipt unavailable");
        },
      },
    });
    const created = (await (await publish(app)).json()) as Intent;
    const response = await app.request(`/v1/intents/${created.id}/deployments`, {
      method: "POST",
      headers: reconcilerAuth,
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
    const app = createApp(store, keys);
    const responses = await Promise.all(Array.from({ length: 25 }, () => publish(app)));
    expect(responses.filter(({ status }) => status === 201)).toHaveLength(1);
    expect(responses.filter(({ status }) => status === 200)).toHaveLength(24);
    expect(store.intents).toHaveLength(1);
  });
});
