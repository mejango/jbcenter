import { array, decimalString, nullable, object, ref, type Schema } from "./schemas.js";

const text = { type: "string" };
const yes = { type: "boolean", const: true };
const no = { type: "boolean", const: false };
const boolean = { type: "boolean" };
const chain = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const nonce = { allOf: [ref("Hash"), { not: { const: `0x${"00".repeat(32)}` } }] };
const policyId = { type: "string", pattern: "^[A-Za-z0-9_-]{1,100}$" };
const wallet = object({ chainId: chain, address: ref("Address") });
const challengeFields = { manifestId: text, address: ref("Address"), nonce,
  expiresAt: { ...ref("UnixSeconds"), description: "Future Unix seconds no more than 900 seconds after server time." } };
const actionFields = { allocationId: policyId, beneficiary: ref("Address"), perCallLimit: ref("PositiveUint256"), totalLimit: ref("PositiveUint256") };
const reviewedActionFields = { ...actionFields, chainId: chain, asset: ref("Address"), target: ref("Address"), targetReviewId: text,
  runtimeCodeHash: ref("Hash"), selector: { type: "string", pattern: "^0x[0-9a-fA-F]{8}$" }, requiredEnforcement: array(text) };

export function smartAccountSchemas(): Record<string, Schema> {
  return {
    SmartDeploymentResearch: { ...object({ schemaVersion: { type: "integer", const: 1 }, readOnly: yes, observedAt: { type: "string", format: "date-time" },
      limitations: array(text), contracts: { type: "object", additionalProperties: { type: "object", additionalProperties: true } },
      chains: array({ type: "object", additionalProperties: true }),
      compiledPolicySources: array(object({ name: text, path: text, sha256: ref("Sha256"), keccak256: ref("Hash"), verificationInputSha256: ref("Sha256"),
        verificationInputUrl: { type: "string", format: "uri" }, compiler: text, artifactMetadataSourceKeccakMatches: boolean })),
    }, ["schemaVersion", "readOnly", "observedAt", "limitations", "contracts", "chains"], true), description: "Historical public source/code observations. Additional research fields are additive reference data. These are not active deployment manifests, account-configuration proof, session activation or execution support." },
    SmartAccountCapabilities: object({ deploymentResearch: ref("SmartDeploymentResearch"), accountOwnershipVerification: { type: "string", const: "safe-current-eoa-owner-threshold" },
      sessionDurationsDays: { type: "array", const: [7, 30] }, walletCreation: no, userOperationPreparation: no, userOperationSimulation: no, userOperationRelay: no,
      deployments: array(object({ manifestId: text, mode: { type: "string", enum: ["ownership-only", "execution-candidate"], description: "Ownership-only manifests support association. An execution candidate still requires all reported execution prerequisites; this service's UserOperation flags remain false." },
        chainId: chain, revision: ref("Hash"), moduleGeneration: { type: "string", enum: ["legacy-validator", "emissary"] }, entryPointSourceVerified: boolean, moduleInspectionConfigured: boolean })),
      requirements: array(text), exclusions: array(text),
    }),
    SmartModuleEvidence: object({ stateHash: ref("Hash"), complete: yes, arbitrarySigningDisabled: yes, wildcardExecutionDisabled: yes, details: ref("JsonValue") }),
    SmartAccountState: object({ chainId: chain, address: ref("Address"), manifestId: text, manifestRevision: ref("Hash"),
      owners: array(ref("Address"), { minItems: 1, maxItems: 16, uniqueItems: true }), threshold: { type: "integer", minimum: 1, maximum: 16 }, safeNonce: ref("Uint256"),
      stateHash: ref("Hash"), evidence: ref("BlockEvidence"), codeHashes: array(object({ address: ref("Address"), runtimeCodeHash: ref("Hash") })),
      modules: nullable(ref("SmartModuleEvidence")), moduleConfigurationVerified: boolean, executionVerified: no,
    }),
    SmartBindingChallengeInput: { ...object(challengeFields), description: "Select a server-published reviewed manifest and an existing Safe distinct from the API owner EOA. The API owner must be a current Safe owner. Nonce must be nonzero." },
    SmartBindingInput: object({ ...challengeFields, stateHash: ref("Hash"), signature: { type: "string", pattern: "^0x(?:[0-9a-fA-F]{130}){1,16}$",
      description: "Exactly the current threshold of concatenated 65-byte EOA owner signatures, sorted by ascending owner address. Only direct EIP-712 signatures with v=27 or v=28 are accepted." } }),
    SmartBindingChallenge: object({ state: ref("SmartAccountState"), digest: ref("Hash"), typedData: object({
      domain: object({ name: { type: "string", const: "Juicebox Center Smart Account" }, version: { type: "string", const: "1" }, chainId: chain, verifyingContract: ref("Address"), salt: ref("Hash") }),
      primaryType: { type: "string", const: "BindSmartAccount" },
      types: { type: "object", const: { BindSmartAccount: [{ name: "accountId", type: "string" }, { name: "owner", type: "address" }, { name: "stateHash", type: "bytes32" }, { name: "nonce", type: "bytes32" }, { name: "expiresAt", type: "uint64" }] } },
      message: object({ accountId: ref("AccountId"), owner: ref("Address"), stateHash: ref("Hash"), nonce, expiresAt: { ...decimalString(Number.MAX_SAFE_INTEGER), description: "Uint64 typed-data value serialized as a decimal string. Challenge request expiresAt uses a JSON integer in Unix seconds." } }),
    }) }),
    SmartAccountBinding: object({ id: ref("Hash"), ownerAccountId: ref("AccountId"), ownerAddress: ref("Address"), wallet, manifestId: text,
      authorization: object({ digest: ref("Hash"), nonce, expiresAt: ref("UnixSeconds"), method: { type: "string", const: "safe-current-owner-threshold" } }), state: ref("SmartAccountState"),
    }),
    SmartBindingList: object({ items: array(object({ id: ref("Hash"), wallet, manifestId: text, stateHash: ref("Hash"), evidence: ref("BlockEvidence"),
      moduleConfigurationVerified: boolean, executionVerified: no, observation: { type: "string", const: "stored-binding-snapshot" } })) }),
    SmartBindingUnlinked: object({ id: ref("Hash"), status: { type: "string", const: "unlinked" }, onchainSessionRevoked: no, reason: text }),
    SessionAllocation: object({ id: policyId, chainId: chain, asset: ref("Address"), limit: ref("PositiveUint256") }),
    SessionAllocationGroup: object({ id: policyId, total: ref("PositiveUint256"), allocations: array(ref("SessionAllocation"), { minItems: 1, maxItems: 8 }) }),
    ReviewedSessionAllocation: object({ id: policyId, chainId: chain, asset: ref("Address"), limit: ref("PositiveUint256"), assetReviewId: text }),
    ReviewedSessionAllocationGroup: object({ id: policyId, assetIdentity: text, decimals: { type: "integer", minimum: 0, maximum: 255 },
      total: ref("PositiveUint256"), allocations: array(ref("ReviewedSessionAllocation"), { minItems: 1, maxItems: 8 }) }),
    SessionAction: { oneOf: [
      object({ kind: { type: "string", const: "erc20-transfer" }, ...actionFields }),
      object({ kind: { type: "string", const: "v6-pay" }, ...actionFields, terminal: ref("Address"), projectId: ref("PositiveUint256"), minReturnedTokens: ref("Uint256") }),
    ] },
    ReviewedSessionAction: { oneOf: [
      object({ kind: { type: "string", const: "erc20-transfer" }, ...reviewedActionFields }),
      object({ kind: { type: "string", const: "v6-pay" }, ...reviewedActionFields, projectId: ref("PositiveUint256"), minReturnedTokens: ref("Uint256"), memo: { type: "string", const: "" }, metadata: { type: "string", const: "0x" } }),
    ] },
    SessionMaximumCalls: { allOf: [decimalString(100000), { not: { const: "0" } }] },
    SessionReviewInput: { ...object({ bindingId: ref("Hash"), grantId: policyId, generation: ref("PositiveUint256"), nonce,
      validAfter: { ...ref("UnixSeconds"), description: "Start at or after server time, within the next 86400 seconds. The complete chosen duration must fit the active bot grant's expiry." },
      durationDays: { type: "integer", enum: [7, 30] }, maximumCalls: ref("SessionMaximumCalls"), allocations: array(ref("SessionAllocationGroup"), { minItems: 1, maxItems: 16 }),
      actions: array(ref("SessionAction"), { minItems: 1, maxItems: 16 }),
    }), description: "Review only. The selected grant must be active with read+plan+relay; a bot can review only its own grant. Groups, chain/asset coordinates, allocation IDs and target/selector actions must be unique. Every asset requires a host-reviewed identity and decimals; one group cannot mix incompatible units. Per-call and summed action caps must fit allocations and group totals. Every action must use a host-reviewed target on the bound wallet's chain." },
    ReviewedSessionPolicy: object({ schemaVersion: { type: "integer", const: 1 }, ownerAccountId: ref("AccountId"), bindingId: ref("Hash"), chainId: chain, wallet: ref("Address"),
      grantId: ref("GrantId"), sessionKey: ref("Address"), generation: ref("PositiveUint256"), nonce, validAfter: ref("UnixSeconds"), validUntil: ref("UnixSeconds"), maximumCalls: ref("SessionMaximumCalls"), salt: ref("Hash"),
      restrictToActions: yes, signing: object({ mode: { type: "string", const: "disabled" } }), crossChainPermits: no, claimPolicies: no, wildcardFallback: no,
      allocations: array(ref("ReviewedSessionAllocationGroup"), { minItems: 1, maxItems: 16 }), actions: array(ref("ReviewedSessionAction"), { minItems: 1, maxItems: 16 }),
    }),
    SessionReview: object({ status: { type: "string", const: "reviewable-not-activated" }, policy: ref("ReviewedSessionPolicy"), policyHash: ref("Hash"),
      walletStateHash: ref("Hash"), manifestRevision: ref("Hash"), evidence: ref("BlockEvidence"),
      ownerApproval: object({ required: yes, signerRole: { type: "string", const: "smart-account-owner-threshold" }, action: { type: "string", const: "install-or-enable-exact-session-policy" }, noPermanentBotProjectPermission: yes }),
      activationRequirements: array(text), warnings: array(text),
    }),
  };
}
