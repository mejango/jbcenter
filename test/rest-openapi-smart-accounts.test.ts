import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import type { BotGrant, RestPrincipal } from "../src/rest/auth/store.js";
import { sharedSchemas } from "../src/rest/docs/schemas.js";
import { smartAccountSchemas } from "../src/rest/docs/smartAccounts.js";
import { createSessionPolicyReviewer, createSmartAccountService, MemorySmartAccountRegistry, type SmartAccountBinding } from "../src/rest/smartAccounts/index.js";
import { CHECKED_SMART_ACCOUNT_BINDING_MANIFESTS } from "../src/rest/smartAccounts/manifests.js";

const address = "0x0000000000000000000000000000000000000001" as const;
const wallet = "0x0000000000000000000000000000000000000002" as const;
const asset = "0x0000000000000000000000000000000000000003" as const;
const recipient = "0x0000000000000000000000000000000000000004" as const;
const hash = `0x${"11".repeat(32)}` as const;
const now = 1_800_000_000;
const accountId = `eip155:1:${address}`;
const principal: RestPrincipal = { principalId: `owner:${accountId}`, account: { id: accountId, ownerAddress: address, authorityChainId: 1,
  profile: { displayName: "", bio: "", avatarUri: null }, createdAt: now, updatedAt: now },
  signer: address, grantId: null, scopes: ["read", "plan", "relay"], isOwner: true, requestNonce: hash, idempotencyKey: null };
const grant: BotGrant = { id: "11111111-1111-4111-8111-111111111111", accountId, botAddress: recipient, scopes: ["read", "plan", "relay"],
  label: "", createdAt: now, expiresAt: now + 40 * 86400, revokedAt: null };
const binding: SmartAccountBinding = { id: hash, ownerAccountId: accountId, ownerAddress: address, wallet: { chainId: 1, address: wallet }, manifestId: "fixture",
  authorization: { digest: hash, nonce: hash, expiresAt: now + 300, method: "safe-current-owner-threshold" },
  state: { chainId: 1, address: wallet, manifestId: "fixture", manifestRevision: hash, owners: [address], threshold: 1, safeNonce: "1", stateHash: hash,
    evidence: { chainId: 1, blockNumber: "100", blockHash: hash, timestamp: String(now), source: "onchain" }, codeHashes: [], modules: null, moduleConfigurationVerified: false, executionVerified: false } };
const schemas = { ...sharedSchemas([1, 10, 8453, 42161]), ...smartAccountSchemas() };
const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(JSON.parse(JSON.stringify({ $id: "urn:juicebox:smart-account-schemas", $defs: schemas }).replaceAll("#/components/schemas/", "#/$defs/")));
const validator = (name: string) => ajv.compile({ $ref: `urn:juicebox:smart-account-schemas#/$defs/${name}` });

describe("smart-account documentation reflects review-only capabilities", () => {
  it("validates actual unconfigured capability, list and unlink responses without calling a chain", async () => {
    const registry = new MemorySmartAccountRegistry();
    await registry.bind(binding);
    const service = createSmartAccountService({ audience: "https://juicebox.center", manifests: [], registry,
      rpc: { request: async () => { throw new Error("Discovery and stored views must not contact RPC"); } } });
    const capabilities = await service.capabilities();
    const validate = validator("SmartAccountCapabilities");
    expect(validate(capabilities), JSON.stringify(validate.errors)).toBe(true);
    expect(capabilities.deployments).toEqual([]);
    expect(capabilities.userOperationRelay).toBe(false);
    const checkedService = createSmartAccountService({ audience: "https://juicebox.center", manifests: CHECKED_SMART_ACCOUNT_BINDING_MANIFESTS, registry,
      rpc: { request: async () => { throw new Error("Capability discovery must not contact RPC"); } } });
    const checked = await checkedService.capabilities();
    expect(validate(checked), JSON.stringify(validate.errors)).toBe(true);
    expect(checked.deployments.length).toBeGreaterThan(0);
    expect(checked.deployments.every((entry) => entry.mode === "ownership-only")).toBe(true);
    expect(checked.userOperationRelay).toBe(false);
    expect(validator("SmartBindingList")(await service.list(principal))).toBe(true);
    const unlinked = await service.revoke(principal, hash);
    expect(validator("SmartBindingUnlinked")(unlinked)).toBe(true);
    expect(unlinked.onchainSessionRevoked).toBe(false);
  });

  it("validates a real bounded policy review while retaining missing activation requirements", async () => {
    const reviewer = createSessionPolicyReviewer({ now: () => now * 1000, currentBinding: async () => binding, getGrant: async () => grant,
      assets: [{ chainId: 1, address: asset, assetIdentity: "fixture-token", decimals: 18, reviewId: "fixture-asset-review" }],
      targets: [{ chainId: 1, address: asset, runtimeCodeHash: hash, kind: "erc20-exact-transfer", reviewId: "fixture" }] });
    const input = { bindingId: hash, grantId: grant.id, generation: "1", nonce: hash, validAfter: now, durationDays: 7 as const,
      maximumCalls: "10", allocations: [{ id: "asset", total: "100", allocations: [{ id: "chain-1", chainId: 1, asset, limit: "100" }] }],
      actions: [{ kind: "erc20-transfer" as const, allocationId: "chain-1", beneficiary: recipient, perCallLimit: "10", totalLimit: "100" }] };
    expect(validator("SessionReviewInput")(input)).toBe(true);
    const review = await reviewer.review(principal, input);
    const validate = validator("SessionReview");
    expect(validate(review), JSON.stringify(validate.errors)).toBe(true);
    expect(review.status).toBe("reviewable-not-activated");
    expect(review.activationRequirements).toContain("complete-version-specific-module-state-proof");
    expect(review.policy.allocations[0]).toMatchObject({ assetIdentity: "fixture-token", decimals: 18,
      allocations: [{ assetReviewId: "fixture-asset-review" }] });
    expect(review).not.toHaveProperty("transaction");
    expect(review).not.toHaveProperty("userOperation");
    expect(validator("SessionReviewInput")({ ...input, sessionKey: recipient })).toBe(false);
  });
});
