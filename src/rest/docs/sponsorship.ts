import { FORWARD_REQUEST_TYPES, RELAYR_LIMITS, RELAYR_MAINNET_CHAINS } from "../sponsorship/constants.js";
import { array, decimalString, object, ref, type Schema } from "./schemas.js";

const text = { type: "string" };
const boolean = { type: "boolean" };
const index = { type: "integer", minimum: 0, maximum: 31 };
const chain = { type: "integer", enum: RELAYR_MAINNET_CHAINS };

/** Public DTOs only. Actor identities, durable leases, raw signatures and provider bodies stay private. */
export function sponsorshipSchemas(): Record<string, Schema> {
  return {
    SponsorshipApproval: { ...object({ accountId: ref("AccountId"), principalId: ref("PrincipalId"), sponsorshipId: ref("ResourceId"),
      commitment: ref("Hash"), submissionHash: ref("Hash"), issuedAt: ref("ApprovalTime"), expiresAt: ref("ApprovalTime"), nonce: ref("ApprovalNonce"), signature: ref("OwnerSignature"),
    }), description: "Fresh owner CenterSponsorshipApproval EIP-712 consent for this exact publication. `submissionHash` commits to the preparation commitment and ordered lowercase forward signatures. Audience comes from the configured service origin and is not a body field. A long-lived ForwardRequest signature alone does not authorize a new bot publication." },
    CreateSponsorship: object({ planId: ref("ResourceId"), stepIndexes: array(index, { minItems: 1, maxItems: RELAYR_LIMITS.maximumCalls, uniqueItems: true,
      description: "Omit to select all source steps, subject to the same limit. Multiple calls per chain execute in plan order; prerequisites must already be confirmed. This is Center’s plan capacity, not a provider limit." }) }, ["planId"]),
    SubmitSponsorship: object({ signatures: array({ type: "string", pattern: "^0x[0-9a-fA-F]{130}$" }, { minItems: 1, maxItems: RELAYR_LIMITS.maximumCalls,
      description: "One owner ECDSA ForwardRequest signature per returned authorization, in the same order." }), ownerApproval: ref("SponsorshipApproval") }, ["signatures"]),
    CreateSponsorshipFundingPlan: object({ chainId: chain, payer: { ...ref("Address"), description: "Must equal the authenticated API owner's wallet. The resulting unsigned funding plan requires separate owner review and signing." } }),
    ForwardRequest: object({ from: ref("Address"), to: ref("Address"), value: ref("Uint256"), gas: ref("Uint256"), nonce: ref("Uint256"),
      deadline: { ...decimalString(281474976710655), description: "Exact uint48 Unix seconds. This onchain authorization deadline can outlive the shorter source-plan publication cutoff." }, data: ref("HexBytes") }),
    ForwardAuthorization: object({ stepIndex: index, chainId: chain, forwarder: ref("Address"), forwarderCodeHash: ref("Hash"), targetCodeHash: ref("Hash"),
      domain: object({ name: text, version: text, chainId: chain, verifyingContract: ref("Address") }), message: ref("ForwardRequest"), evidence: ref("BlockEvidence"),
      primaryType: { type: "string", const: "ForwardRequest" }, types: { type: "object", const: FORWARD_REQUEST_TYPES },
    }),
    SponsorshipPayment: object({ chainId: chain, to: ref("Address"), data: ref("HexBytes"), value: ref("Uint256"), deadline: ref("Uint256") }),
    SponsorshipObservation: object({ stepIndex: index, chainId: chain, providerState: text,
      state: { type: "string", enum: ["pending", "unknown", "confirming", "confirmed", "reverted"] }, hash: ref("Hash"), receipt: ref("TransactionReceipt"), semantic: ref("SemanticResult"), reason: text,
    }, ["stepIndex", "chainId", "providerState", "state"]),
    Sponsorship: object({ id: ref("ResourceId"), planId: ref("ResourceId"), planCommitment: ref("Hash"), commitment: ref("Hash"),
      state: { type: "string", enum: ["prepared", "submitting", "submission_unknown", "quoted"] },
      availability: { type: "string", enum: ["available", "submission_unknown", "requires_verification", "funding_quote_available", "execution_verified", "completed"],
        description: "funding_quote_available does not establish that the bundle is unpaid. execution_verified confirms exact inner execution; completed additionally requires verified modeled economic semantics." },
      createdAt: ref("UnixMilliseconds"), publicationExpiresAt: { ...ref("UnixMilliseconds"), description: "Original source-plan cutoff for new publication. It cannot revoke a ForwardRequest already published." },
      revision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, authorizations: array(ref("ForwardAuthorization"), { minItems: 1, maxItems: RELAYR_LIMITS.maximumCalls }),
      submission: object({ hash: ref("Hash"), startedAt: ref("UnixMilliseconds"), repeatPublicationAllowed: { type: "boolean", const: false } }),
      quote: object({ bundleUuid: text, commitment: ref("Hash"), payments: array(ref("SponsorshipPayment"), { maxItems: RELAYR_MAINNET_CHAINS.length }), runtimeVerified: boolean,
        observedAt: ref("UnixMilliseconds"), transactions: array(object({ txUuid: text, chainId: chain, outerCallHash: ref("Hash") }), { minItems: 1, maxItems: RELAYR_LIMITS.maximumCalls }) }),
      observations: array(ref("SponsorshipObservation"), { maxItems: RELAYR_LIMITS.maximumCalls }), authorizationNotice: text, fundingNotice: text, recovery: text, economicCompletion: boolean,
    }, ["id", "planId", "planCommitment", "commitment", "state", "availability", "createdAt", "publicationExpiresAt", "revision", "authorizations", "observations", "authorizationNotice", "fundingNotice", "economicCompletion"]),
  };
}
