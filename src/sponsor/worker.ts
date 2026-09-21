import type { DeploymentVerifier } from "../deploymentVerifier.js";
import type { Store } from "../store.js";
import type { DeployLane, LaneReport } from "./chain.js";
import type { SponsorPolicy, SponsorRuntime } from "./policy.js";

export function createSponsorWorker(options: {
  store: Store;
  verifier: DeploymentVerifier;
  lane: DeployLane;
  policy: SponsorPolicy;
  leaseSeconds?: number;
}): SponsorRuntime & { stop(): void; runOnce(): Promise<void> } {
  const { store, verifier, lane, policy, leaseSeconds = 1800 } = options;
  let running = false;
  let stopped = false;
  let pending = false;

  async function runOnce(): Promise<void> {
    const claims = await store.claimQueuedDeploys(leaseSeconds, 5);
    for (const { intentId, chainIds } of claims) {
      const intent = await store.getIntent(intentId);
      if (!intent) continue;
      const done = new Set<number>();
      const report: LaneReport = {
        bundle: async (bundleUuid) => {
          for (const chainId of chainIds) {
            await store.updateDeploy(intentId, chainId, { status: "queued", bundleUuid });
          }
        },
        sent: (chainId, transactionHash, bundleUuid) =>
          store.updateDeploy(intentId, chainId, { status: "sent", transactionHash, bundleUuid }),
        confirmed: async (chainId, transactionHash, projectId, spentWei) => {
          try {
            const call = intent.envelope.deploymentCalls.find((c) => c.chainId === chainId)!;
            await verifier.verify({
              chainId,
              projectId,
              transactionHash,
              deploymentVersion: intent.envelope.deploymentVersion,
              call,
            });
            await store.recordDeployment(intentId, { chainId, projectId, transactionHash });
            await store.updateDeploy(intentId, chainId, { status: "confirmed", transactionHash, spentWei });
          } catch (error) {
            await store.updateDeploy(intentId, chainId, {
              status: "failed",
              transactionHash,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          done.add(chainId);
        },
        failed: async (chainId, error) => {
          await store.updateDeploy(intentId, chainId, { status: "failed", error });
          done.add(chainId);
        },
      };
      // A claimed row that already carries a bundle was paid for by an earlier
      // attempt; resuming it is the only way not to fund the same work twice.
      const bundleUuid = intent.deploys.find(
        (deploy) => chainIds.includes(deploy.chainId) && deploy.bundleUuid,
      )?.bundleUuid;
      try {
        if (bundleUuid) await lane.resume(intent, chainIds, bundleUuid, report);
        else await lane.deploy(intent, chainIds, report);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const chainId of chainIds) {
          if (!done.has(chainId)) await report.failed(chainId, message);
        }
      }
      for (const chainId of chainIds) {
        if (!done.has(chainId)) {
          await store.updateDeploy(intentId, chainId, {
            status: "failed",
            error: "not attempted: an earlier chain failed",
          });
        }
      }
    }
  }

  async function loop(): Promise<void> {
    if (running || stopped) {
      pending = running;
      return;
    }
    running = true;
    try {
      do {
        pending = false;
        await runOnce();
      } while (pending);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => {
    void loop();
  }, 30_000);
  timer.unref();

  return {
    policy,
    kick: () => {
      void loop();
    },
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    runOnce,
  };
}
