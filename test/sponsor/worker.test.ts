import { describe, expect, test, vi } from "vitest";
import { MemoryStore } from "../support/memoryStore.js";
import { createSponsorWorker } from "../../src/sponsor/worker.js";
import type { DeployLane, SponsorEvent } from "../../src/sponsor/chain.js";
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
      resume: vi.fn(async () => {}),
      deploy: vi.fn(async (_i, _c, report) => {
        await report.sent(84532, HASH, BUNDLE);
        await report.confirmed(84532, HASH, "9");
      }),
    };
    const verifier = { verify: vi.fn(async () => {}) };
    const worker = createSponsorWorker({ store, verifier, lane, policy });
    await worker.runOnce();
    await worker.stop();
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
      resume: vi.fn(async () => {}),
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
    await worker.stop();
    const after = await store.getIntent(intent.id);
    expect(after?.deploys.map((d) => [d.status, d.error])).toEqual([
      ["failed", "boom"],
      ["failed", "not attempted: an earlier chain failed"],
    ]);
  });

  test("worker marks a sent-but-unconfirmed chain failed with a coded message when the lane throws", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532, 421614] }), limits);
    await store.queueDeploys(intent.id, [84532, 421614], "browser:x", 10n);
    const lane: DeployLane = {
      resume: vi.fn(async () => {}),
      deploy: vi.fn(async (_i, _c, report) => {
        await report.sent(84532, HASH, BUNDLE);
        throw new Error("bundle submission failed");
      }),
    };
    const worker = createSponsorWorker({ store, verifier: { verify: vi.fn() }, lane, policy });
    await worker.runOnce();
    await worker.stop();
    const after = await store.getIntent(intent.id);
    expect(after?.deploys.map((d) => [d.status, d.error])).toEqual([
      ["failed", "Error: lane error"],
      ["failed", "Error: lane error"],
    ]);
  });

  test("worker records a verifier rejection as a failed row", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532] }), limits);
    await store.queueDeploys(intent.id, [84532], "browser:x", 10n);
    const lane: DeployLane = {
      resume: vi.fn(async () => {}),
      deploy: vi.fn(async (_i, _c, report) => {
        await report.confirmed(84532, HASH, "9");
      }),
    };
    const verifier = {
      verify: vi.fn(async () => {
        throw new DeploymentVerificationError("bad");
      }),
    };
    const worker = createSponsorWorker({ store, verifier, lane, policy });
    await worker.runOnce();
    await worker.stop();
    const after = await store.getIntent(intent.id);
    expect(after?.status).toBe("undeployed");
    expect(after?.deploys[0]).toMatchObject({ status: "failed", error: "bad" });
    expect(after?.deployments).toEqual([]);
  });

  test("worker persists the bundle for every claimed chain as the lane reports it", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532, 421614] }), limits);
    await store.queueDeploys(intent.id, [84532, 421614], "browser:x", 10n);
    const lane: DeployLane = {
      resume: vi.fn(async () => {}),
      deploy: vi.fn(async (_i, _c, report) => {
        await report.bundle(BUNDLE);
      }),
    };
    const worker = createSponsorWorker({ store, verifier: { verify: vi.fn() }, lane, policy });
    await worker.runOnce();
    await worker.stop();
    const after = await store.getIntent(intent.id);
    expect(after?.deploys.map((d) => d.bundleUuid)).toEqual([BUNDLE, BUNDLE]);
  });

  test("worker resumes a re-claimed intent that already carries a bundle instead of deploying again", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532, 421614] }), limits);
    await store.queueDeploys(intent.id, [84532, 421614], "browser:x", 10n);
    for (const chainId of [84532, 421614]) {
      await store.updateDeploy(intent.id, chainId, { status: "queued", bundleUuid: BUNDLE });
    }
    const lane: DeployLane = {
      deploy: vi.fn(async () => {}),
      resume: vi.fn(async (_i, chainIds, bundleUuid, report) => {
        for (const chainId of chainIds) {
          await report.sent(chainId, HASH, bundleUuid);
          await report.confirmed(chainId, HASH, "9");
        }
      }),
    };
    const worker = createSponsorWorker({ store, verifier: { verify: vi.fn(async () => {}) }, lane, policy });
    await worker.runOnce();
    await worker.stop();
    expect(lane.deploy).not.toHaveBeenCalled();
    expect(lane.resume).toHaveBeenCalledWith(
      expect.objectContaining({ id: intent.id }),
      [84532, 421614],
      BUNDLE,
      expect.anything(),
    );
    const after = await store.getIntent(intent.id);
    expect(after?.deploys.map((d) => d.status)).toEqual(["confirmed", "confirmed"]);
  });

  test("the prepayment stays on the budget when every chain then reverts", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532, 421614] }), limits);
    await store.queueDeploys(intent.id, [84532, 421614], "browser:x", 10n);
    const lane: DeployLane = {
      resume: vi.fn(async () => {}),
      deploy: vi.fn(async (_i, chainIds, report) => {
        await report.bundle(BUNDLE);
        await report.paid(chainIds[0]!, 700n);
        for (const chainId of chainIds) {
          await report.failed(chainId, "the relayed deployment reverted");
        }
      }),
    };
    const worker = createSponsorWorker({ store, verifier: { verify: vi.fn() }, lane, policy });
    await worker.runOnce();
    await worker.stop();
    const after = await store.getIntent(intent.id);
    expect(after?.deploys.map((d) => d.status)).toEqual(["failed", "failed"]);
    // 700 spent on the prepayment, and the two reservations a paid bundle cannot release.
    expect(await store.sponsoredWeiSince(new Date(Date.now() - 60_000))).toBe(720n);
  });

  test("a resumed bundle does not charge the budget a second payment", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532, 421614] }), limits);
    await store.queueDeploys(intent.id, [84532, 421614], "browser:x", 10n);
    for (const chainId of [84532, 421614]) {
      await store.updateDeploy(intent.id, chainId, { status: "queued", bundleUuid: BUNDLE });
    }
    await store.updateDeploy(intent.id, 84532, { status: "queued", spentWei: 700n });
    const lane: DeployLane = {
      deploy: vi.fn(async () => {}),
      resume: vi.fn(async (_i, chainIds, _bundleUuid, report) => {
        for (const chainId of chainIds) {
          await report.sent(chainId, HASH, BUNDLE);
          await report.confirmed(chainId, HASH, "9");
        }
      }),
    };
    const worker = createSponsorWorker({
      store,
      verifier: { verify: vi.fn(async () => {}) },
      lane,
      policy,
    });
    await worker.runOnce();
    await worker.stop();
    expect(lane.deploy).not.toHaveBeenCalled();
    expect(await store.sponsoredWeiSince(new Date(Date.now() - 60_000))).toBe(700n);
  });

  test("a deferred lane leaves every claimed chain queued", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532, 421614] }), limits);
    await store.queueDeploys(intent.id, [84532, 421614], "browser:x", 10n);
    const lane: DeployLane = {
      resume: vi.fn(async () => {}),
      deploy: vi.fn(async (_i, _c, report) => {
        await report.deferred("sponsor balance too low");
      }),
    };
    const events: SponsorEvent[] = [];
    const worker = createSponsorWorker({
      store,
      verifier: { verify: vi.fn() },
      lane,
      policy,
      onEvent: (event) => events.push(event),
    });
    await worker.runOnce();
    await worker.stop();
    const after = await store.getIntent(intent.id);
    expect(after?.deploys.map((d) => [d.status, d.error])).toEqual([
      ["queued", null],
      ["queued", null],
    ]);
    expect(events).toEqual([
      {
        event: "deferred",
        intentId: intent.id,
        chainIds: [84532, 421614],
        error: "sponsor balance too low",
      },
    ]);
    // A deferral spends nothing, the attempt included, so the next pass claims again.
    expect(
      (store.intents[0]!.deploys as unknown as { attempts: number }[]).map((d) => d.attempts),
    ).toEqual([0, 0]);
    expect(await store.claimQueuedDeploys(30, 5)).toEqual([
      { intentId: intent.id, chainIds: [84532, 421614] },
    ]);
  });

  test("a bundle in flight resumes the chains that are not recorded yet", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532, 421614] }), limits);
    await store.queueDeploys(intent.id, [84532, 421614], "browser:x", 10n);
    for (const chainId of [84532, 421614]) {
      await store.updateDeploy(intent.id, chainId, { status: "sent", transactionHash: HASH, bundleUuid: BUNDLE });
    }
    // The first chain of the bundle was recorded before the process died.
    await store.recordDeployment(intent.id, { chainId: 84532, projectId: "7", transactionHash: HASH });
    const lane: DeployLane = {
      deploy: vi.fn(async () => {}),
      resume: vi.fn(async (_i, chainIds, bundleUuid, report) => {
        for (const chainId of chainIds) {
          await report.sent(chainId, HASH, bundleUuid);
          await report.confirmed(chainId, HASH, "9");
        }
      }),
    };
    const worker = createSponsorWorker({
      store,
      verifier: { verify: vi.fn(async () => {}) },
      lane,
      policy,
    });
    await worker.runOnce();
    await worker.stop();
    expect(lane.deploy).not.toHaveBeenCalled();
    expect(lane.resume).toHaveBeenCalledWith(
      expect.objectContaining({ id: intent.id }),
      [421614],
      BUNDLE,
      expect.anything(),
    );
    const after = await store.getIntent(intent.id);
    expect(after?.deploys.map((d) => [d.chainId, d.status, d.error])).toEqual([
      [84532, "failed", "chain already deployed"],
      [421614, "confirmed", null],
    ]);
    expect(after?.deployments.map((d) => [d.chainId, d.projectId])).toEqual([
      [84532, "7"],
      [421614, "9"],
    ]);
  });

  test("an intent that already has a deployment retires its claimed rows without spending", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532] }), limits);
    await store.queueDeploys(intent.id, [84532], "browser:x", 10n);
    await store.recordDeployment(intent.id, { chainId: 84532, projectId: "9", transactionHash: HASH });
    const lane: DeployLane = { deploy: vi.fn(async () => {}), resume: vi.fn(async () => {}) };
    const worker = createSponsorWorker({ store, verifier: { verify: vi.fn() }, lane, policy });
    await worker.runOnce();
    await worker.stop();
    expect(lane.deploy).not.toHaveBeenCalled();
    expect(lane.resume).not.toHaveBeenCalled();
    const after = await store.getIntent(intent.id);
    expect(after?.deploys[0]).toMatchObject({
      status: "failed",
      error: "intent already has a deployment",
    });
  });

  test("one unreadable intent does not cost the rest of the batch its turn", async () => {
    const store = new MemoryStore();
    const first = await store.createIntent(newIntent({ chainIds: [84532] }), limits);
    const second = await store.createIntent(
      { ...newIntent({ chainIds: [421614] }), contentHash: `0x${"cc".repeat(32)}` },
      limits,
    );
    await store.queueDeploys(first.intent.id, [84532], "browser:x", 10n);
    await store.queueDeploys(second.intent.id, [421614], "browser:x", 10n);
    const read = store.getIntent.bind(store);
    let unreadable = true;
    store.getIntent = async (id: string) => {
      if (unreadable) {
        unreadable = false;
        throw new Error("the intent could not be read");
      }
      return read(id);
    };
    const lane: DeployLane = {
      resume: vi.fn(async () => {}),
      deploy: vi.fn(async (_i, chainIds, report) => {
        for (const chainId of chainIds) await report.failed(chainId, "boom");
      }),
    };
    const worker = createSponsorWorker({ store, verifier: { verify: vi.fn() }, lane, policy });
    await worker.runOnce();
    await worker.stop();
    expect(lane.deploy).toHaveBeenCalledTimes(1);
  });

  test("stop() waits for the pass in flight, then resolves", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532] }), limits);
    await store.queueDeploys(intent.id, [84532], "browser:x", 10n);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lane: DeployLane = {
      resume: vi.fn(async () => {}),
      deploy: vi.fn(async (_i, chainIds, report) => {
        await gate;
        for (const chainId of chainIds) await report.failed(chainId, "boom");
      }),
    };
    const worker = createSponsorWorker({ store, verifier: { verify: vi.fn() }, lane, policy });
    worker.kick();
    let drained = false;
    const stopping = worker.stop().then(() => {
      drained = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    release();
    await stopping;
    expect(drained).toBe(true);
    expect((await store.getIntent(intent.id))?.deploys[0]?.status).toBe("failed");
  });

  test("worker exposes the policy and stop() clears the interval without pending work", async () => {
    const store = new MemoryStore();
    const worker = createSponsorWorker({
      store,
      verifier: { verify: vi.fn() },
      lane: { deploy: vi.fn(async () => {}), resume: vi.fn(async () => {}) },
      policy,
    });
    expect(worker.policy).toBe(policy);
    await worker.runOnce();
    await worker.stop();
  });
});
