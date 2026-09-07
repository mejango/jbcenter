import { randomUUID } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";
import { toHex, type Address } from "viem";
import type { RestPrincipal } from "../src/rest/auth/store.js";
import { sharedSchemas } from "../src/rest/docs/schemas.js";
import { smartAccountSchemas } from "../src/rest/docs/smartAccounts.js";
import { sessionSchemas } from "../src/rest/docs/sessions.js";
import { createSessionPolicyReviewer } from "../src/rest/smartAccounts/policy.js";
import { createLegacySessionCompiler, LEGACY_COMPILER_RUNTIME_HASHES, type SessionCompilerStack } from "../src/rest/smartAccounts/compiler.js";
import { encodeSafe7579Nonce, legacySessionSigningPayload, safe7579OwnerSigningPayload } from "../src/rest/smartAccounts/accountExecution.js";
import { createSessionObservation, createSessionRecord, sessionQuota } from "../src/rest/sessions/store.js";
import { SessionService, type SessionServiceDependencies } from "../src/rest/sessions/service.js";
import { TransactionService } from "../src/rest/transactions/service.js";
import type { TransactionStore } from "../src/rest/transactions/store.js";
import { UserOperationService, type UserOperationServiceDependencies } from "../src/rest/userOperations/service.js";
import { account, binding, owner, plan, record as preparation, target, entryPoint, h } from "./fixtures/user-operations.js";

const schemas = { ...sharedSchemas([1, 10, 8453, 42161]), ...smartAccountSchemas(), ...sessionSchemas() };
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(JSON.parse(JSON.stringify({ $id: "urn:juicebox:session-docs", $defs: schemas }).replaceAll("#/components/schemas/", "#/$defs/")));
const validate = (name: string, value: unknown) => {
  const check = ajv.compile({ $ref: `urn:juicebox:session-docs#/$defs/${name}` });
  expect(check(value), `${name}: ${JSON.stringify(check.errors)}`).toBe(true);
};
const accepts = (name: string, value: unknown) => ajv.compile({ $ref: `urn:juicebox:session-docs#/$defs/${name}` })(value);
const now = 1_800_000_000_000;
const apiAccount = account(now), actor = owner(apiAccount), wallet = binding(apiAccount, now);
const principal: RestPrincipal = { account: apiAccount, principalId: actor.principalId, signer: apiAccount.ownerAddress,
  grantId: null, isOwner: true, scopes: ["read", "plan", "relay"], requestNonce: h("nonce"), idempotencyKey: null };
const bot = "0x4444444444444444444444444444444444444444" as Address;
const paymaster = "0x5555555555555555555555555555555555555555" as Address;
const grant = { id: randomUUID(), accountId: apiAccount.id, botAddress: bot, scopes: ["read", "plan", "relay"] as ["read", "plan", "relay"],
  label: "fixture", createdAt: now / 1000 - 1, expiresAt: now / 1000 + 40 * 86400, revokedAt: null };
const gasBudget = { paymaster, maxGasPerOperation: "1000", maxFeePerGas: "2", maxPriorityFeePerGas: "1",
  totalGasLimit: "100000", totalSponsoredCostLimit: "200000", maxPaymasterDataLength: 130 };

async function policy(uriOnly = false) {
  const reviewer = createSessionPolicyReviewer({ now: () => now, currentBinding: async () => wallet, getGrant: async () => grant,
    assets: [{ chainId: 1, address: target, assetIdentity: "test-token", decimals: 18, reviewId: "test-asset" }],
    paymasters: [{ chainId: 1, address: paymaster, runtimeCodeHash: h("paymaster"), reviewId: "test-paymaster" }],
    targets: [{ chainId: 1, address: target, runtimeCodeHash: h("target"), kind: uriOnly ? "v6-controller-uri" : "erc20-exact-transfer", reviewId: "test-target" }] });
  const input = { bindingId: wallet.id, grantId: grant.id, generation: "1", nonce: h(uriOnly ? "uri" : "transfer"),
    validAfter: now / 1000, durationDays: 7 as const, maximumCalls: "100", gasBudget,
    allocations: uriOnly ? [] : [{ id: "token", total: "100", allocations: [{ id: "ethereum", chainId: 1, asset: target, limit: "100" }] }],
    actions: uriOnly ? [{ kind: "v6-project-uri" as const, controller: target, projectId: "1" }]
      : [{ kind: "erc20-transfer" as const, allocationId: "ethereum", beneficiary: apiAccount.ownerAddress, perCallLimit: "10", totalLimit: "100" }] };
  const review = await reviewer.review(principal, input);
  const stack = Object.fromEntries(Object.entries(LEGACY_COMPILER_RUNTIME_HASHES).map(([role, runtimeCodeHash], index) => [role, {
    address: `0x${(100 + index).toString(16).padStart(40, "0")}` as Address, runtimeCodeHash,
    source: { repository: "https://github.com/example/test-only", commit: "a".repeat(40), artifactSha256: "b".repeat(64) },
  }])) as unknown as SessionCompilerStack;
  const compiled = createLegacySessionCompiler({ stack }).compile({ review, activationEnableNonce: "0" });
  return { input, review, compiled, record: createSessionRecord({ actor, compiled, preparedAdministration: { epoch: "0", hash: h("baseline") }, now }) };
}

describe("session and UserOperation machine-readable contracts", () => {
  it("validates real reviewed/compiler/storage output with reviewed gas and explicit asset units", async () => {
    const fixture = await policy();
    for (const [name, value] of Object.entries({ SessionReviewInput: fixture.input, SessionPreparationInput: fixture.input,
      SessionReview: fixture.review, CompiledSession: fixture.compiled, StoredSession: fixture.record, SessionQuota: sessionQuota(fixture.record) })) validate(name, value);
    const observation = createSessionObservation({ permissionId: fixture.compiled.permissionId, compiledHash: fixture.compiled.compiledHash,
      account: fixture.compiled.wallet, chainId: 1, enabled: true, enableNonce: "0", configurationHash: h("configuration"),
      administration: { epoch: "1", hash: h("administration-1"), lastInitialization: { epoch: "1", permissionIds: [fixture.compiled.permissionId] } },
      evidence: wallet.state.evidence, counters: [{ policy: target, configId: h("config"), name: "calls", used: "0", limit: "100" }] }, now);
    validate("SessionCanonicalObservation", observation);
    const { administration: _administration, ...unproven } = observation.installed;
    expect(accepts("InstalledSessionObservation", unproven)).toBe(false);
    expect(accepts("InstalledSessionObservation", { ...unproven, enabled: false })).toBe(true);
    expect(accepts("InstalledSessionObservation", { ...observation.installed, administration: { epoch: "1", hash: h("incomplete") } })).toBe(false);
    const { preparedAdministration: _baseline, ...unbound } = fixture.record;
    expect(accepts("StoredSession", unbound)).toBe(false);
    expect(accepts("SessionGasBudget", { ...gasBudget, maxFeePerGas: String(2n ** 128n) })).toBe(false);
    expect(accepts("SessionGasBudget", { ...gasBudget, maxPaymasterDataLength: 52 })).toBe(false);
  });

  it("models actual URI-only policies without invented asset permissions or allocations", async () => {
    const fixture = await policy(true);
    validate("SessionPreparationInput", fixture.input); validate("SessionReview", fixture.review); validate("StoredSession", fixture.record);
    expect(fixture.record.allocationGroups).toEqual([]);
    expect(accepts("SessionAction", { kind: "v6-project-uri", controller: target, projectId: "1", beneficiary: bot })).toBe(false);
    const { gasBudget: _gas, ...reviewOnly } = fixture.input;
    expect(accepts("SessionReviewInput", reviewOnly)).toBe(true);
    expect(accepts("SessionPreparationInput", reviewOnly)).toBe(false);
  });

  it.each(["installing", "active"] as const)("validates the actual %s lifecycle replay without preparing another installation", async (state) => {
    const fixture = await policy(), storedPlan = plan(randomUUID(), actor, wallet, now);
    storedPlan.draft.operation = "activate_smart_account_session";
    storedPlan.draft.evidence = [wallet.state.evidence];
    storedPlan.draft.summary = { sessionId: fixture.record.id, compiledHash: fixture.compiled.compiledHash };
    fixture.record.state = state;
    fixture.record.activation = { kind: "activation", accountId: actor.accountId, sessionId: fixture.record.id,
      policyHash: fixture.compiled.policyHash, compiledHash: fixture.compiled.compiledHash,
      planId: storedPlan.id, planCommitment: storedPlan.commitment, digest: h("owner-consent"), issuedAt: now / 1000, expiresAt: now / 1000 + 300 };
    const rpc = { request: vi.fn(async () => { throw new Error("Idempotent replay must not perform RPC"); }) };
    const transactions = new TransactionService({ now: () => now, rpc,
      store: { findIdempotentPlan: async () => storedPlan } as unknown as TransactionStore });
    const authorizeOwnerPlan = vi.fn(async () => { throw new Error("Idempotent replay must not create another approval"); });
    const service = new SessionService({ now: () => now, rpc, transactions, authorizeOwnerPlan,
      store: { get: async () => fixture.record } } as unknown as SessionServiceDependencies);
    const result = await service.prepareOwnerPlan(principal, fixture.record.id, "activation",
      { compiledHash: fixture.compiled.compiledHash }, "original-lifecycle-request", h("request"));
    validate("SessionPlanResult", result);
    expect(result.installationConfirmed).toBe(state === "active");
    expect(result.plan.id).toBe(storedPlan.id);
    expect(result.session).toEqual(fixture.record);
    expect(authorizeOwnerPlan).not.toHaveBeenCalled();
    expect(rpc.request).not.toHaveBeenCalled();
  });

  it("limits session preparations to one ordered step and rejects caller-supplied operation replacement", () => {
    const input = { planId: randomUUID(), stepIndexes: [0, 1] };
    validate("PrepareUserOperation", input);
    expect(accepts("PrepareUserOperation", { ...input, sessionId: randomUUID() })).toBe(false);
    expect(accepts("PrepareUserOperation", { ...input, stepIndexes: [0, 0] })).toBe(false);
    expect(accepts("SubmitUserOperation", { signature: "0x1234", operation: {} })).toBe(false);
    expect(accepts("SubmitUserOperation", { signature: "0x1234", privateKey: h("private-field") })).toBe(false);
  });

  it("validates the actual owner and session signing payloads without conflating HTTP signatures", async () => {
    const fixture = await policy(), storedPlan = plan(randomUUID(), actor, wallet, now);
    const operation = preparation(storedPlan).operation;
    validate("UserOperationV07", operation);
    validate("SafeOwnerUserOperationSigning", safe7579OwnerSigningPayload({ operation, chainId: 1, entryPoint,
      safe7579: target, validAfter: String(now / 1000), validUntil: String(now / 1000 + 300) }));
    const sessionOperation = { ...operation, nonce: toHex(BigInt(encodeSafe7579Nonce({ validator: fixture.compiled.smartSessions.address, lane: "0", sequence: "0" }))) };
    validate("SessionUserOperationSigning", legacySessionSigningPayload({ operation: sessionOperation, chainId: 1,
      entryPoint, smartSessions: fixture.compiled.smartSessions.address, permissionId: fixture.compiled.permissionId }));
    expect(accepts("UserOperationV07", { ...operation, nonce: "1" })).toBe(false);
    expect(accepts("UserOperationV07", { ...operation, callGasLimit: "0x01" })).toBe(false);
    expect(accepts("UserOperationV07", { ...operation, factory: target })).toBe(false);
  });

  it("validates a real public UserOperation read and runtime capability response without RPC", async () => {
    const storedPlan = plan(randomUUID(), actor, wallet, now), record = preparation(storedPlan);
    record.id = randomUUID();
    const service = new UserOperationService({ policies: [], now: () => now,
      rpc: { request: async () => { throw new Error("No RPC belongs in this unsigned stored read"); } },
      provider: { capabilities: () => [] }, store: { get: async () => record }, transactionStore: { get: async () => storedPlan },
      manifestForPlan: () => ({ safe7579: { address: target } }),
    } as unknown as UserOperationServiceDependencies);
    const response = await service.get(principal, record.id);
    validate("UserOperation", response); validate("UserOperationCapabilities", service.capabilities());
    expect(response.operation.signature).toBe("0x");
    expect(response).not.toHaveProperty("preparationKey");
    const sessions = new SessionService({ configuredChainIds: [], now: () => now } as unknown as SessionServiceDependencies);
    validate("SessionCapabilities", sessions.capabilities());
    expect(sessions.capabilities().activationReady).toBe(false);
  });
});
