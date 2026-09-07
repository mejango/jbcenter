import { randomUUID } from "node:crypto";
import type { Address } from "viem";
import type { BotGrant } from "../../src/rest/auth/store.js";
import { createLegacySessionCompiler, LEGACY_COMPILER_RUNTIME_HASHES, type SessionCompilerStack, type SessionReview } from "../../src/rest/smartAccounts/compiler.js";
import type { InstalledSessionObservation } from "../../src/rest/smartAccounts/compiler/types.js";
import { fingerprint } from "../../src/rest/smartAccounts/service.js";
import { createSessionObservation, createSessionRecord } from "../../src/rest/sessions/store.js";
import type { SessionClaim, StoredSession, UserOperationSessionBinding } from "../../src/rest/sessions/types.js";
import { account, owner, binding, h, target } from "./user-operations.js";

/** Pure public synthetic deployment pins. These fixtures never assert a live deployment. */
export function sessionFixture(now = Date.now(), options: { generation?: string; chainId?: number; days?: 7 | 30; emptyAllocations?: boolean; sessionKey?: Address } = {}) {
  const apiAccount = account(now), actor = owner(apiAccount), walletBinding = binding(apiAccount, now);
  if (options.chainId) {
    walletBinding.wallet.chainId = options.chainId;
    walletBinding.state.chainId = options.chainId;
    walletBinding.state.evidence.chainId = options.chainId;
  }
  const key = options.sessionKey ?? "0x4444444444444444444444444444444444444444" as Address;
  const validAfter = Math.floor(now / 1000) - 1, validUntil = validAfter + (options.days ?? 7) * 86400;
  const grant: BotGrant = { id: randomUUID(), accountId: apiAccount.id, botAddress: key, scopes: ["read", "plan", "relay"],
    label: "Session fixture", createdAt: validAfter - 1, expiresAt: validUntil + 86400, revokedAt: null };
  const pin = (index: number) => ({ address: `0x${index.toString(16).padStart(40, "0")}` as Address, runtimeCodeHash: h(`runtime:${index}`),
    source: { repository: "https://github.com/example/test-only", commit: "a".repeat(40), artifactSha256: "b".repeat(64) } });
  const generation = options.generation ?? "1";
  const policy = { schemaVersion: 1, ownerAccountId: apiAccount.id, bindingId: walletBinding.id, grantId: grant.id, sessionKey: key,
    chainId: walletBinding.wallet.chainId, wallet: walletBinding.wallet.address, generation, nonce: h(randomUUID()), salt: h(randomUUID()),
    validAfter, validUntil, maximumCalls: "100", restrictToActions: true, signing: { mode: "disabled" },
    crossChainPermits: false, claimPolicies: false, wildcardFallback: false,
    allocations: options.emptyAllocations ? [] : [{ id: "token", assetIdentity: "fixture-token", decimals: 18, total: "200",
      allocations: [{ id: "local", chainId: walletBinding.wallet.chainId, asset: target, limit: "100", assetReviewId: "fixture-local" },
        { id: "sibling", chainId: walletBinding.wallet.chainId === 10 ? 1 : 10, asset: target, limit: "100", assetReviewId: "fixture-sibling" }] }],
    gasBudget: { paymaster: pin(106).address, paymasterCodeHash: pin(106).runtimeCodeHash, paymasterReviewId: "fixture-paymaster",
      maxGasPerOperation: "1000", maxFeePerGas: "2", maxPriorityFeePerGas: "1", totalGasLimit: "100000", totalSponsoredCostLimit: "200000", maxPaymasterDataLength: 130 },
    actions: options.emptyAllocations
      ? [{ kind: "v6-project-uri", target, selector: "0x67b42b16", projectId: "1" }]
      : [{ kind: "erc20-transfer", target, selector: "0xa9059cbb", asset: target, beneficiary: apiAccount.ownerAddress, perCallLimit: "10", totalLimit: "100" }],
  };
  const review = { policy, policyHash: fingerprint(policy), manifestRevision: walletBinding.state.manifestRevision } as unknown as SessionReview;
  const stack: SessionCompilerStack = { smartSessions: pin(100), sessionValidator: pin(101), timeFrame: pin(102),
    universalAction: pin(103), valueLimit: pin(104), sessionGuard: pin(105) };
  for (const role of Object.keys(stack) as (keyof SessionCompilerStack)[]) stack[role].runtimeCodeHash = LEGACY_COMPILER_RUNTIME_HASHES[role];
  const compiled = createLegacySessionCompiler({ stack }).compile({ review, activationEnableNonce: "0" });
  const record = createSessionRecord({ actor, compiled, preparedAdministration: { epoch: "0", hash: h("empty-session-administration") }, now });
  return { account: apiAccount, actor, bot: { accountId: apiAccount.id, principalId: `bot:${grant.id}` }, grant, walletBinding, record };
}
export function sessionClaim(record: StoredSession, now = Date.now(), kind: "activation" | "revocation" = "activation"): SessionClaim {
  return { actor: { accountId: record.compiled.ownerAccountId, principalId: `owner:${record.compiled.ownerAccountId}` }, id: record.id,
    expectedRevision: record.revision, approval: { kind, accountId: record.compiled.ownerAccountId, sessionId: record.id,
      policyHash: record.compiled.policyHash, compiledHash: record.compiled.compiledHash, planId: randomUUID(), planCommitment: h(randomUUID()),
      digest: h(randomUUID()), issuedAt: Math.floor(now / 1000), expiresAt: Math.floor(now / 1000) + 120 },
    idempotency: { key: randomUUID(), requestHash: h(randomUUID()) }, now };
}
export function sessionObservation(record: StoredSession, now = Date.now(), changes: Partial<InstalledSessionObservation> = {}, finalized = false) {
  const c = record.compiled;
  return createSessionObservation({ permissionId: c.permissionId, compiledHash: c.compiledHash, account: c.wallet, chainId: c.chainId,
    enabled: true, enableNonce: c.activationEnableNonce, configurationHash: h(c.compiledHash),
    administration: { epoch: "1", hash: h(`initialized:${c.permissionId}`), lastInitialization: { epoch: "1", permissionIds: [c.permissionId] } },
    evidence: { chainId: c.chainId, blockNumber: "100", blockHash: h("100"), timestamp: String(Math.floor(now / 1000)), source: "onchain" },
    counters: [{ policy: c.configurations[1]!.policy.address, configId: c.configurations[1]!.configId, name: "calls", used: "0", limit: "100" }],
    ...changes }, now, finalized);
}
export function sessionBinding(record: StoredSession): UserOperationSessionBinding {
  const c = record.compiled;
  return { id: record.id, policyHash: c.policyHash, compiledHash: c.compiledHash, generation: c.generation, grantId: c.grantId,
    permissionId: c.permissionId, sessionKey: c.sessionKey, observationHash: record.observation!.proofHash };
}
