import { hashTypedData, type Hex } from "viem";
import type { Pool } from "pg";
import { PostgresWalletDeploymentStore, type WalletDeploymentAdmission } from "../../src/rest/wallet/deploymentPostgres.js";
import { PostgresWalletEnrollmentStore } from "../../src/rest/wallet/enrollmentPostgres.js";
import { createWalletEnrollmentIntent, walletEnrollmentDocument } from "../../src/rest/wallet/enrollment.js";
import { prepareWalletDeploymentApproval, walletDeploymentDocument } from "../../src/rest/wallet/deployment.js";
import { createRegistration, enrollmentBackupAccount, enrollmentManifest, signBackupProof, signGet } from "./wallet-enrollment-crypto.js";
import { deploymentFixtureConfiguration, deploymentFixtureSigner, deploymentFixtureTransaction, syntheticDeploymentObservation } from "./wallet-deployment-execution.js";
import { walletDeploymentAccountingDigest, type WalletDeploymentEnvironment, type WalletDeploymentFundingContext, type WalletDeploymentFundingEvidence,
  type WalletDeploymentSettlementContext, type WalletDeploymentSettlementEvidence } from "../../src/rest/wallet/deploymentSettlement.js";
export async function settlementDatabaseNow(pool: Pool): Promise<number> {
  return Number((await pool.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now")).rows[0].now);
}
export function syntheticFunding(context: WalletDeploymentFundingContext, now: number, environment?: WalletDeploymentEnvironment): WalletDeploymentFundingEvidence {
  const head = { chainId: 8453 as const, blockNumber: "100", blockHash: `0x${"ab".repeat(32)}` as Hex,
    timestamp: String(Math.floor(now / 1000)), source: "onchain" as const };
  return { version: "center-wallet-deployment-funding-v1", poolId: context.pool.configuration.id, configurationDigest: context.pool.configurationDigest,
    poolRevision: context.pool.revision, accountingDigest: context.pool.accounting ? walletDeploymentAccountingDigest(context.pool.accounting) : null,
    environment: context.pool.accounting?.environment ?? environment ?? { kind: "unforked-anvil", genesisHash: `0x${"cd".repeat(32)}`, instanceId: `0x${"ef".repeat(32)}` },
    head, observedAt: now, expiresAt: now + 5000, confirmedNonce: context.pool.accounting?.nextNonce ?? "1",
    pendingNonce: context.pool.accounting?.nextNonce ?? "1", balanceWei: String(BigInt(context.pool.configuration.allocationWei) - BigInt(context.pool.accounting?.spentWei ?? "0")),
    previousAnchor: context.pool.accounting?.lastSettlementAnchor ?? null };
}
export async function initializedSettlementPool(pool: Pool, store: PostgresWalletDeploymentStore, environment?: WalletDeploymentEnvironment,
  configuration = deploymentFixtureConfiguration()) {
  const configured = await store.configurePool(configuration), context = await store.loadFundingContext(configured.configuration.id);
  await store.initializeAccounting(context, syntheticFunding(context, await settlementDatabaseNow(pool), environment), "1");
  return store.loadFundingContext(configured.configuration.id);
}
export async function preparedSettlementUser(pool: Pool, store: PostgresWalletDeploymentStore) {
  const config = (await pool.query("SELECT configuration FROM rest_wallet_deployment_pools")).rows[0].configuration, enrollments = new PostgresWalletEnrollmentStore(pool);
  const initial = await enrollments.begin(createWalletEnrollmentIntent({ manifest: enrollmentManifest,
    rpId: "wallet.juicebox.center", origin: "https://wallet.juicebox.center", recoveryOwner: enrollmentBackupAccount.address,
    expiresAt: await settlementDatabaseNow(pool) + 120000 }));
  const credential = createRegistration({ challenge: `0x${Buffer.from(initial.intent.registration.challenge, "base64url").toString("hex")}`,
    rpId: initial.intent.rpId, origin: initial.intent.origin, userHandle: initial.intent.userHandle });
  const pending = await enrollments.acceptRegistration(initial.intent.id, credential.response), document = walletEnrollmentDocument(pending);
  const { record } = await enrollments.finalize(initial.intent.id, { assertion: signGet({ ...credential, challenge: hashTypedData(document),
    rpId: pending.intent.rpId, origin: pending.intent.origin }), backupSignature: await signBackupProof(document) });
  const issuedAt = await settlementDatabaseNow(pool), approval = prepareWalletDeploymentApproval(record, { issuedAt, expiresAt: issuedAt + 120000 });
  const operation = await store.prepare({ poolId: config.id, approval });
  const assertion = signGet({ ...credential, challenge: hashTypedData(walletDeploymentDocument(record, approval)),
    rpId: record.intent.rpId, origin: record.intent.origin });
  const fundingContext = await store.loadFundingContext(config.id), funding = syntheticFunding(fundingContext, await settlementDatabaseNow(pool));
  const admission: WalletDeploymentAdmission = { version: "center-wallet-deployment-admission-v1", chainId: 8453, sender: config.sender,
    blockNumber: funding.head.blockNumber, blockHash: funding.head.blockHash, confirmedNonce: funding.confirmedNonce, pendingNonce: funding.pendingNonce,
    observedAt: funding.observedAt, enrollmentCommitment: approval.enrollmentCommitment, manifestRevision: record.intent.manifest.revision,
    initializerHash: record.creation!.initializerHash, gas: "1500000", maxFeePerGas: "2000000000", maxPriorityFeePerGas: "1000000" };
  return { operation, enrollment: record, input: { operationId: operation.id, admission, funding, assertion } };
}
export async function signedSettlementUser(pool: Pool, store: PostgresWalletDeploymentStore) {
  const prepared = await preparedSettlementUser(pool, store);
  let operation = (await store.claim(prepared.input)).operation;
  const lease = await store.leaseSigning(operation.id);
  operation = (await store.persistSigned({ operationId: operation.id, leaseToken: lease.leaseToken!, revision: lease.revision,
    rawTransaction: await deploymentFixtureSigner.signTransaction(deploymentFixtureTransaction(operation.template!)) })).operation;
  return store.loadSettlementContext(operation.id);
}
/** A signed user whose inclusion is canonical (sender nonce advanced past it) and whose lane
 * was released: the shape every settlement now starts from. */
export async function releasedSettlementUser(pool: Pool, store: PostgresWalletDeploymentStore) {
  const signed = await signedSettlementUser(pool, store), now = await settlementDatabaseNow(pool);
  const observation = syntheticDeploymentObservation(signed, now), next = String(BigInt(signed.operation.template!.transaction.nonce) + 1n);
  const head = syntheticFunding(signed, now).head;
  observation.head = head; observation.wallet.evidence = head;
  observation.transaction.state = "canonical-success";
  observation.transaction.nonce = { confirmed: next, pending: next };
  observation.transaction.receipt = { block: head, transactionIndex: "0", status: "success", gasUsed: "500000",
    effectiveGasPrice: "1000000", logCount: 1, logsHash: `0x${"12".repeat(32)}` };
  observation.finality = { state: "unfinalized", evidence: { ...head, blockNumber: "90", blockHash: `0x${"5a".repeat(32)}` } };
  observation.fees.executionWei = "500000000000";
  const saved = await store.saveObservation({ operationId: signed.operation.id, expectedRevision: signed.operation.revision,
    signedHash: signed.operation.signed!.hash, observation });
  await store.release({ operationId: signed.operation.id, expectedRevision: saved.operation.revision });
  return store.loadSettlementContext(signed.operation.id);
}
export function syntheticSettlement(context: WalletDeploymentSettlementContext, now: number,
  fees: WalletDeploymentSettlementEvidence["fees"] = { profile: "unforked-anvil-execution-fees-v1", executionWei: "500000000000", totalWei: "500000000000" }): WalletDeploymentSettlementEvidence {
  const funding = syntheticFunding(context, now), next = String(BigInt(context.operation.template!.transaction.nonce) + 1n);
  // The sender's nonce is past every released inclusion: the accounting's nextNonce.
  funding.confirmedNonce = funding.pendingNonce = context.pool.accounting!.nextNonce;
  const observation = syntheticDeploymentObservation(context, now);
  observation.head = funding.head; observation.wallet.evidence = funding.head;
  observation.transaction.state = "canonical-success";
  observation.transaction.nonce = { confirmed: next, pending: next };
  observation.transaction.receipt = { block: funding.head, transactionIndex: "0", status: "success", gasUsed: "500000",
    effectiveGasPrice: "1000000", logCount: 1, logsHash: `0x${"12".repeat(32)}` };
  observation.finality = { state: "finalized", evidence: funding.head };
  observation.fees.executionWei = "500000000000";
  // The balance already paid this fee and every other released inclusion's actual fee (≤ reservation).
  const balance = BigInt(funding.balanceWei) - BigInt(fees.totalWei) - (BigInt(context.pool.reservedWei) - BigInt(context.operation.reservedWei ?? "0"));
  funding.balanceWei = String(balance < 0n ? 0n : balance);
  return { version: "center-wallet-deployment-settlement-evidence-v1", funding, operationId: context.operation.id,
    operationRevision: context.operation.revision, transactionHash: context.operation.signed!.hash,
    templateCommitment: context.operation.templateCommitment!, observation, finalizedNonce: next,
    fees: structuredClone(fees) };
}
