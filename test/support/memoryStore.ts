import { randomUUID } from "node:crypto";
import {
  ConflictError,
  type DeployPatch,
  type NewDeployment,
  type NewIntent,
  type StorageLimits,
  type Store,
} from "../../src/store.js";
import type { Deployment, Intent, IntentDeploy, SearchPage } from "../../src/types.js";

type StoredDeploy = IntentDeploy & {
  reservedWei: bigint;
  spentWei: bigint;
  attempts: number;
  leaseUntil: number | null;
};

function toIntentDeploy(deploy: StoredDeploy): IntentDeploy {
  const { chainId, status, transactionHash, bundleUuid, error, createdAt, updatedAt } = deploy;
  return { chainId, status, transactionHash, bundleUuid, error, createdAt, updatedAt };
}

function byChainId(deploys: IntentDeploy[]): IntentDeploy[] {
  return (deploys as StoredDeploy[]).slice().sort((a, b) => a.chainId - b.chainId).map(toIntentDeploy);
}

export class MemoryStore implements Store {
  async cleanupRateLimits() { return 0; }
  intents: Intent[] = [];
  requests = new Map<string, number>();

  async health() {}

  async consumeRequest(client: string, limit: number, _windowSeconds?: number) {
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
      deploys: [],
    };
    this.intents.push(intent);
    return { intent, created: true };
  }

  async getIntent(id: string) {
    const intent = this.intents.find((item) => item.id === id);
    return intent ? { ...intent, deploys: byChainId(intent.deploys) } : null;
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

  async queueDeploys(
    intentId: string,
    chainIds: number[],
    _requester: string,
    reservedWeiPerChain: bigint,
  ): Promise<IntentDeploy[]> {
    const intent = this.intents.find(({ id }) => id === intentId)!;
    for (const chainId of chainIds) {
      if (intent.deploys.some((deploy) => deploy.chainId === chainId)) continue;
      const now = new Date().toISOString();
      const deploy: StoredDeploy = {
        chainId,
        status: "queued",
        transactionHash: null,
        bundleUuid: null,
        error: null,
        createdAt: now,
        updatedAt: now,
        reservedWei: reservedWeiPerChain,
        spentWei: 0n,
        attempts: 0,
        leaseUntil: null,
      };
      intent.deploys.push(deploy);
    }
    return this.listDeploys(intentId);
  }

  async listDeploys(intentId: string): Promise<IntentDeploy[]> {
    const intent = this.intents.find(({ id }) => id === intentId);
    return intent ? byChainId(intent.deploys) : [];
  }

  async claimQueuedDeploys(
    leaseSeconds: number,
    limit: number,
  ): Promise<{ intentId: string; chainIds: number[] }[]> {
    const now = Date.now();
    const claimed: { intentId: string; chainIds: number[] }[] = [];
    for (const intent of this.intents) {
      for (const deploy of intent.deploys as StoredDeploy[]) {
        if ((deploy.status !== "queued" && deploy.status !== "sent") || deploy.attempts < 3) continue;
        if (deploy.leaseUntil !== null && deploy.leaseUntil >= now) continue;
        deploy.status = "failed";
        deploy.error = "attempts exhausted";
        if (deploy.bundleUuid === null) deploy.reservedWei = 0n;
        deploy.updatedAt = new Date().toISOString();
      }
    }
    for (const intent of [...this.intents].sort((a, b) => a.id.localeCompare(b.id))) {
      if (claimed.length >= limit) break;
      const eligible = (intent.deploys as StoredDeploy[]).filter(
        (deploy) =>
          (deploy.status === "queued" || deploy.status === "sent") &&
          (deploy.leaseUntil === null || deploy.leaseUntil < now) &&
          deploy.attempts < 3,
      );
      if (eligible.length === 0) continue;
      for (const deploy of eligible) {
        deploy.leaseUntil = now + leaseSeconds * 1000;
        deploy.attempts += 1;
        deploy.updatedAt = new Date().toISOString();
      }
      claimed.push({
        intentId: intent.id,
        chainIds: eligible.map((deploy) => deploy.chainId).sort((a, b) => a - b),
      });
    }
    return claimed;
  }

  async updateDeploy(intentId: string, chainId: number, patch: DeployPatch): Promise<void> {
    const intent = this.intents.find(({ id }) => id === intentId);
    const deploy = intent?.deploys.find((item) => item.chainId === chainId) as StoredDeploy | undefined;
    if (!deploy) return;
    deploy.status = patch.status;
    if (patch.transactionHash !== undefined) deploy.transactionHash = patch.transactionHash;
    if (patch.bundleUuid !== undefined) deploy.bundleUuid = patch.bundleUuid;
    deploy.error = patch.error?.slice(0, 300) ?? null;
    if (patch.spentWei !== undefined) deploy.spentWei = patch.spentWei;
    // A failed row that carries a bundle keeps its reservation: money may have left.
    if (patch.status === "confirmed" || (patch.status === "failed" && deploy.bundleUuid === null))
      deploy.reservedWei = 0n;
    deploy.updatedAt = new Date().toISOString();
  }

  async releaseClaim(intentId: string, chainIds: number[]): Promise<void> {
    const intent = this.intents.find(({ id }) => id === intentId);
    for (const deploy of (intent?.deploys ?? []) as StoredDeploy[]) {
      if (!chainIds.includes(deploy.chainId)) continue;
      deploy.attempts = Math.max(deploy.attempts - 1, 0);
      deploy.leaseUntil = null;
      deploy.updatedAt = new Date().toISOString();
    }
  }

  async sponsoredWeiSince(since: Date): Promise<bigint> {
    let total = 0n;
    for (const intent of this.intents) {
      for (const deploy of intent.deploys as StoredDeploy[]) {
        if (new Date(deploy.createdAt) >= since) total += deploy.reservedWei + deploy.spentWei;
      }
    }
    return total;
  }
}
