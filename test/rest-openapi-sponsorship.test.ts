import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { buildSponsorshipApprovalTypedData, buildTransactionApprovalTypedData, sponsorshipSubmissionHash } from "../src/rest/approvals.js";
import { getContractCatalog } from "../src/rest/contracts/catalog.js";
import { sharedSchemas } from "../src/rest/docs/schemas.js";
import { sponsorshipSchemas } from "../src/rest/docs/sponsorship.js";
import { RelayrSponsorshipService } from "../src/rest/sponsorship/service.js";
import type { SponsorshipStore } from "../src/rest/sponsorship/store.js";
import type { SponsorshipRecord } from "../src/rest/sponsorship/types.js";
import type { TransactionStore } from "../src/rest/transactions/store.js";

const address = "0x0000000000000000000000000000000000000001" as const;
const hash = `0x${"11".repeat(32)}` as const;
const signature = `0x${"22".repeat(65)}` as const;
const accountId = `eip155:1:${address}`;
const resourceId = "11111111-1111-4111-8111-111111111111";
const principalId = `bot:${resourceId}`;
const now = 1_800_000_000;
const actor = { accountId, principalId };
const schemas = { ...sharedSchemas([1, 10, 8453, 42161]), ...sponsorshipSchemas() };
const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(JSON.parse(JSON.stringify({ $id: "urn:juicebox:approval-schemas", $defs: schemas }).replaceAll("#/components/schemas/", "#/$defs/")));
const validator = (name: string) => ajv.compile({ $ref: `urn:juicebox:approval-schemas#/$defs/${name}` });

describe("published approval and sponsorship schemas", () => {
  it("accepts actual approval-builder claims and rejects cross-protocol or extra wire fields", () => {
    const common = { accountId, principalId, commitment: hash, issuedAt: now, expiresAt: now + 300, nonce: hash };
    const transaction = { ...common, planId: resourceId, stepIndex: 0, transactionHash: hash };
    const sponsorship = { ...common, sponsorshipId: resourceId, submissionHash: sponsorshipSubmissionHash(hash, [signature]) };
    expect(buildTransactionApprovalTypedData("https://juicebox.center", transaction).primaryType).toBe("CenterTransactionApproval");
    expect(buildSponsorshipApprovalTypedData("https://juicebox.center", sponsorship).primaryType).toBe("CenterSponsorshipApproval");
    const approveTransaction = validator("TransactionApproval"), approveSponsorship = validator("SponsorshipApproval");
    expect(approveTransaction({ ...transaction, signature }), JSON.stringify(approveTransaction.errors)).toBe(true);
    expect(approveSponsorship({ ...sponsorship, signature }), JSON.stringify(approveSponsorship.errors)).toBe(true);
    expect(approveTransaction({ ...sponsorship, signature })).toBe(false);
    expect(approveSponsorship({ ...transaction, signature })).toBe(false);
    expect(approveSponsorship({ ...sponsorship, signature, audience: "https://juicebox.center" })).toBe(false);
    expect(approveSponsorship({ ...sponsorship, signature: "0x1" })).toBe(false);
    expect(validator("SignedTransactionSubmission")({ rawSignedTransaction: "0x01", ownerApproval: { ...transaction, signature } })).toBe(true);
    expect(validator("SubmitSponsorship")({ signatures: [signature], ownerApproval: { ...sponsorship, signature } })).toBe(true);
  });

  it("validates real service views for prepared, quoted and execution-complete states", async () => {
    const record: SponsorshipRecord = { id: resourceId, actor, planId: resourceId, planCommitment: hash,
      preparationKey: "preparation-1", inputHash: hash, commitment: hash, createdAt: now * 1000, expiresAt: (now + 300) * 1000,
      revision: 0, state: "prepared", observations: [], requests: [{ stepIndex: 0, chainId: 1, forwarder: address,
        forwarderCodeHash: hash, targetCodeHash: hash, domain: { name: "Juicebox", version: "1", chainId: 1, verifyingContract: address },
        message: { from: address, to: address, value: "0", gas: "100000", nonce: "0", deadline: String(now + 47 * 3600), data: "0x" },
        evidence: { chainId: 1, blockNumber: "100", blockHash: hash, timestamp: String(now), source: "onchain" } }] };
    const service = new RelayrSponsorshipService({ catalog: await getContractCatalog(),
      rpc: { request: async () => { throw new Error("Documentation view must not contact RPC"); } },
      store: { get: async () => record } as unknown as SponsorshipStore,
      transactionStore: {} as TransactionStore });
    const validate = validator("Sponsorship");
    const prepared = await service.get(actor, resourceId);
    expect(validate(prepared), JSON.stringify(validate.errors)).toBe(true);
    expect(prepared.availability).toBe("available");
    record.state = "quoted";
    record.quoteRuntimeVerified = true;
    record.submission = { key: "publication-1", hash, entries: [], startedAt: now * 1000 };
    record.quote = { bundleUuid: resourceId, commitment: hash, observedAt: now * 1000,
      payments: [{ chainId: 1, to: address, data: "0x", value: "1", deadline: String(now + 100) }],
      entries: [{ txUuid: resourceId, entry: { chain: 1, target: address, data: "0x", value: "0", virtual_nonce: 0 } }] };
    const quoted = await service.get(actor, resourceId);
    expect(validate(quoted), JSON.stringify(validate.errors)).toBe(true);
    expect(quoted.availability).toBe("funding_quote_available");
    record.observations = [{ stepIndex: 0, chainId: 1, providerState: "stored-hash-rechecked-onchain", state: "confirmed", hash, semantic: { status: "verified" } }];
    const completed = await service.get(actor, resourceId);
    expect(validate(completed), JSON.stringify(validate.errors)).toBe(true);
    expect(completed.availability).toBe("completed");
    expect(completed.economicCompletion).toBe(true);
    expect(completed).not.toHaveProperty("actor");
    expect(completed.submission).not.toHaveProperty("entries");
  });
});
