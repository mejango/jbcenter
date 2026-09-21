import type { Hex } from "viem";
import type { ContractPin } from "../smartAccounts/types.js";
import { createLocalAnvilWalletDeploymentReader } from "./deploymentLocalAnvil.js";
import { createWalletDeploymentSettlementObserver } from "./deploymentSettlementObserver.js";

/** Explicit local test-chain accounting. This capability never authorizes Base dispatch. */
export function createLocalAnvilWalletDeploymentSettlement(options: {
  endpoint: string; expectedGenesisHash: Hex; utility: ContractPin; now?: () => number;
}) {
  const local = createLocalAnvilWalletDeploymentReader(options);
  return createWalletDeploymentSettlementObserver({ kind: "unforked-anvil", genesisHash: options.expectedGenesisHash.toLowerCase() as Hex,
    reads: local.reads, limits: { rpcCalls: 320, rpcTimeoutMs: 2000, totalTimeoutMs: 5000, responseBytes: 8 * 1024 * 1024 },
    identity: local.identity, utility: options.utility, evidenceLifetimeMs: 5000, ...(options.now ? { now: options.now } : {}),
    fees: async (_rpc, _context, observation) => ({ profile: "unforked-anvil-execution-fees-v1",
      executionWei: observation.fees.executionWei!, totalWei: observation.fees.executionWei! }) });
}
