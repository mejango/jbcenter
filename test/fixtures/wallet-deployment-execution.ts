import { randomUUID } from "node:crypto";
import { keccak256, type TransactionSerializableEIP1559 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { enrollmentDigest } from "../../src/rest/wallet/enrollment.js";
import { prepareWalletDeploymentApproval, prepareWalletDeploymentTemplate, type WalletDeploymentTemplate } from "../../src/rest/wallet/deployment.js";
import type { WalletDeploymentOperation, WalletDeploymentPoolConfiguration } from "../../src/rest/wallet/deploymentPostgres.js";
import type { WalletDeploymentDispatchAdmission, WalletDeploymentExecutionContext } from "../../src/rest/wallet/deploymentDispatch.js";
import type { WalletDeploymentObservation } from "../../src/rest/wallet/deploymentObservation.js";
import { createWalletAuthorityContextFixture } from "./wallet-authority-context.js";

export const deploymentFixtureSigner = privateKeyToAccount(`0x${"22".repeat(32)}`);
export const deploymentFixtureConfiguration = (): WalletDeploymentPoolConfiguration => ({ id: randomUUID(), chainId: 8453,
  sender: deploymentFixtureSigner.address.toLowerCase() as `0x${string}`, allocationWei: "100000000000000000",
  globalAllocationLimitWei: "1000000000000000000", policy: { maximumRawBytes: 32768, maximumGas: "2000000",
    maximumFeePerGas: "10000000000", maximumTransactionCost: "20000000000000000", maximumObservationAgeMs: 5000 } });
export function deploymentFixtureTransaction(template: WalletDeploymentTemplate): TransactionSerializableEIP1559 {
  const tx = template.transaction;
  return { type: "eip1559", chainId: tx.chainId, to: tx.to, data: tx.data, value: 0n, nonce: Number(tx.nonce),
    gas: BigInt(tx.gas), maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas), accessList: [] };
}
/** Genuine signatures and immutable codec; chain/DB evidence here is explicitly synthetic. */
export async function syntheticDeploymentContext(now = Date.now()): Promise<WalletDeploymentExecutionContext> {
  const { enrollment } = await createWalletAuthorityContextFixture(now);
  const configuration = deploymentFixtureConfiguration(), approval = prepareWalletDeploymentApproval(enrollment,
    { issuedAt: now - 1000, expiresAt: now + 60_000 });
  const template = prepareWalletDeploymentTemplate(enrollment, approval, { sender: configuration.sender, nonce: "1",
    gas: "1500000", maxFeePerGas: "2000000000", maxPriorityFeePerGas: "1000000" }, {
    planTtlMs: 300000, maximumPlanTtlMs: 300000, leaseMs: 15000, rpcTimeoutMs: 1000, confirmations: 1, allowedChainIds: [8453],
    maximumRawBytes: 32768, maximumGas: 2000000n, maximumFeePerGas: 10000000000n, maximumTransactionCost: 20000000000000000n });
  const raw = await deploymentFixtureSigner.signTransaction(deploymentFixtureTransaction(template));
  const operation: WalletDeploymentOperation = { id: approval.id, poolId: configuration.id, enrollmentId: enrollment.intent.id,
    poolConfigurationDigest: enrollmentDigest(configuration), approval, state: "signed", createdAt: now - 1000,
    retainUntil: approval.expiresAt + 86400000, claimedAt: now - 500, proofDigest: "a".repeat(64),
    admission: { version: "center-wallet-deployment-admission-v1", chainId: 8453, sender: configuration.sender,
      blockNumber: "100", blockHash: `0x${"ab".repeat(32)}`, confirmedNonce: "1", pendingNonce: "1", observedAt: now - 600,
      enrollmentCommitment: approval.enrollmentCommitment, manifestRevision: enrollment.intent.manifest.revision,
      initializerHash: template.initializerHash, gas: template.transaction.gas, maxFeePerGas: template.transaction.maxFeePerGas,
      maxPriorityFeePerGas: template.transaction.maxPriorityFeePerGas }, template,
    templateCommitment: `0x${enrollmentDigest(template)}`, signingLease: null,
    signed: { rawTransaction: raw, hash: keccak256(raw), maximumExecutionCost: "3000000000000000" },
    observation: null, observationSavedAt: null, historicalCanonicalObservation: null, highestObservedHead: null, releasedAt: null, reservedWei: null, revision: 3 };
  return { enrollment, pool: { configuration, configurationDigest: enrollmentDigest(configuration), createdAt: now - 2000,
    state: "active", activeOperationId: operation.id, reservedWei: "0", revision: 1 }, operation };
}
export function syntheticDeploymentObservation(context: WalletDeploymentExecutionContext, now = Date.now()): WalletDeploymentObservation {
  const operation = context.operation;
  return { version: "center-wallet-deployment-observation-v1", operationId: operation.id, templateCommitment: operation.templateCommitment!,
    transactionHash: operation.signed!.hash, observedAt: now, head: { chainId: 8453, blockNumber: "101",
      blockHash: `0x${"bc".repeat(32)}`, timestamp: String(Math.floor(now / 1000)), source: "onchain" },
    transaction: { state: "not-observed", reason: null, receipt: null, conflict: null, nonce: { confirmed: "1", pending: "1" } },
    finality: { state: "unknown", evidence: null }, wallet: { state: "undeployed", address: operation.template!.predictedSafe.toLowerCase() as `0x${string}`,
      initializerHash: operation.template!.initializerHash, stateHash: null, evidence: { chainId: 8453, blockNumber: "101",
        blockHash: `0x${"bc".repeat(32)}`, timestamp: String(Math.floor(now / 1000)), source: "onchain" }, creationTransaction: null, reason: null },
    fees: { executionWei: null, l1Wei: null, operatorWei: null, totalWei: null }, dispatchEligible: false };
}
export function syntheticDeploymentAdmission(context: WalletDeploymentExecutionContext, now = Date.now()): Extract<WalletDeploymentDispatchAdmission, { version: "center-wallet-deployment-local-admission-v1" }> {
  const operation = context.operation, observation = operation.observation!;
  // The admission window is the one the production producer computes in deploymentTransport:
  // bounded by the local admission lifetime, the observation age policy and the observed head.
  const expiresAt = Math.min(now + 5000, observation.observedAt + context.pool.configuration.policy.maximumObservationAgeMs,
    Number((BigInt(observation.head!.timestamp) + 300n) * 1000n));
  return { version: "center-wallet-deployment-local-admission-v1", operationId: operation.id,
    poolConfigurationDigest: operation.poolConfigurationDigest, templateCommitment: operation.templateCommitment!, transactionHash: operation.signed!.hash,
    operationRevision: operation.revision, observationDigest: enrollmentDigest(operation.observation),
    environment: { kind: "unforked-anvil", genesisHash: `0x${"de".repeat(32)}`, head: observation.head! },
    observedAt: now, expiresAt, balanceWei: context.pool.configuration.allocationWei,
    maximumExecutionCost: operation.signed!.maximumExecutionCost, feeScope: "local-execution-only", baseTotalAffordability: "unknown" };
}
