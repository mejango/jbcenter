import { describe, expect, test, vi } from "vitest";
import { MemoryStore } from "./memoryStore.js";
import { createSponsorWorker } from "../../src/sponsor/worker.js";
import type { DeployLane } from "../../src/sponsor/chain.js";
import { DeploymentVerificationError } from "../../src/deploymentVerifier.js";
import { readSponsorPolicy } from "../../src/sponsor/policy.js";
import type { NewIntent, StorageLimits } from "../../src/store.js";

const HASH = `0x${"12".repeat(32)}` as const;
const BUNDLE = "bundle-1";
const limits: StorageLimits = { maxIntents: 100, maxBytes: 1_000_000 };
const policy = readSponsorPolicy({});

function newIntent(overrides: { chainIds: number[] }): NewIntent {
  return {
    name: "Public goods garden",
    description: null,
    tagline: null,
    tags: [],
    logoUri: null,
    owner: null,
    contentHash: `0x${"aa".repeat(32)}`,
    envelope: {
      format: "juicebox.money/v1",
      deploymentVersion: "6",
      chainIds: overrides.chainIds,
      deploymentCalls: overrides.chainIds.map((chainId) => ({
        chainId,
        to: "0x3333333333333333333333333333333333333333",
        data: "0x12345678",
      })),
      jb: { name: "Public goods garden", chains: overrides.chainIds },
    },
    publisher: "0x1111111111111111111111111111111111111111",
    signature: `0x${"bb".repeat(65)}`,
    submittedBy: "browser:x",
    jbBytes: 128,
  };
}

describe("sponsor worker", () => {
  test("worker claims a queued intent, runs the lane, verifies and records", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532] }), limits);
    await store.queueDeploys(intent.id, [84532], "browser:x", 10n);
    const lane: DeployLane = {
      deploy: vi.fn(async (_i, _c, report) => {
        await report.sent(84532, HASH, BUNDLE);
        await report.confirmed(84532, HASH, "9", 5n);
      }),
    };
    const verifier = { verify: vi.fn(async () => {}) };
    const worker = createSponsorWorker({ store, verifier, lane, policy });
    await worker.runOnce();
    worker.stop();
    expect(verifier.verify).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 84532, projectId: "9", transactionHash: HASH }),
    );
    const after = await store.getIntent(intent.id);
    expect(after?.status).toBe("deployed");
    expect(after?.deploys[0]).toMatchObject({
      status: "confirmed",
      transactionHash: HASH,
      bundleUuid: BUNDLE,
    });
  });

  test("worker marks remaining chains failed when the lane stops early", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532, 421614] }), limits);
    await store.queueDeploys(intent.id, [84532, 421614], "browser:x", 10n);
    const lane: DeployLane = {
      deploy: vi.fn(async (_i, _c, report) => {
        await report.failed(84532, "boom");
      }),
    };
    const worker = createSponsorWorker({
      store,
      verifier: { verify: vi.fn() },
      lane,
      policy,
    });
    await worker.runOnce();
    worker.stop();
    const after = await store.getIntent(intent.id);
    expect(after?.deploys.map((d) => [d.status, d.error])).toEqual([
      ["failed", "boom"],
      ["failed", "not attempted: an earlier chain failed"],
    ]);
  });

  test("worker records a verifier rejection as a failed row", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532] }), limits);
    await store.queueDeploys(intent.id, [84532], "browser:x", 10n);
    const lane: DeployLane = {
      deploy: vi.fn(async (_i, _c, report) => {
        await report.confirmed(84532, HASH, "9", 5n);
      }),
    };
    const verifier = {
      verify: vi.fn(async () => {
        throw new DeploymentVerificationError("bad");
      }),
    };
    const worker = createSponsorWorker({ store, verifier, lane, policy });
    await worker.runOnce();
    worker.stop();
    const after = await store.getIntent(intent.id);
    expect(after?.status).toBe("undeployed");
    expect(after?.deploys[0]).toMatchObject({ status: "failed", error: "bad" });
    expect(after?.deployments).toEqual([]);
  });

  test("worker exposes the policy and stop() clears the interval without pending work", async () => {
    const store = new MemoryStore();
    const worker = createSponsorWorker({
      store,
      verifier: { verify: vi.fn() },
      lane: { deploy: vi.fn(async () => {}) },
      policy,
    });
    expect(worker.policy).toBe(policy);
    await worker.runOnce();
    worker.stop();
  });
});
