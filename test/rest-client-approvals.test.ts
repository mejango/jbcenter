import { describe, expect, it } from "vitest";
import { keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  accountIdFor, buildTransactionApprovalTypedData, buildSponsorshipApprovalTypedData,
  newRequestNonce, sponsorshipSubmissionHash,
} from "../src/rest/client/index.js";
import { verifyTransactionApproval, verifySponsorshipApproval } from "../src/rest/approvals.js";

const owner = privateKeyToAccount(`0x${"01".padStart(64, "0")}`);
const accountId = accountIdFor(owner.address, 1);
const audience = "https://juicebox.center";
const principalId = "bot:11111111-1111-4111-8111-111111111111";
const now = 1_900_000_000;
const commitment = `0x${"22".repeat(32)}` as Hex;

describe("client owner-approval exports", () => {
  it("produces direct approval bytes accepted only for the reviewed principal, step, and transaction hash", async () => {
    const claims = { accountId, principalId, planId: "22222222-2222-4222-8222-222222222222", commitment, stepIndex: 0,
      transactionHash: keccak256("0x010203"), issuedAt: now, expiresAt: now + 300, nonce: newRequestNonce() };
    const approval = { ...claims, signature: await owner.signTypedData(buildTransactionApprovalTypedData(audience, claims)) };
    await expect(verifyTransactionApproval(audience, approval, claims, { now: () => now })).resolves.toMatchObject({ ownerAddress: owner.address });
    for (const changed of [{ stepIndex: 1 }, { transactionHash: keccak256("0x010204") }, { principalId: "bot:33333333-3333-4333-8333-333333333333" }]) {
      await expect(verifyTransactionApproval(audience, approval, { ...claims, ...changed }, { now: () => now })).rejects.toMatchObject({ code: "OWNER_APPROVAL_MISMATCH" });
    }
    await expect(verifyTransactionApproval(audience, approval, claims, { now: () => now + 300 })).rejects.toMatchObject({ code: "OWNER_APPROVAL_EXPIRED" });
  });

  it("binds sponsorship publication to the exact ordered forwarding signatures and its own typed document", async () => {
    const signatures = [`0x${"11".repeat(65)}`, `0x${"33".repeat(65)}`] as Hex[];
    const claims = { accountId, principalId, sponsorshipId: "44444444-4444-4444-8444-444444444444", commitment,
      submissionHash: sponsorshipSubmissionHash(commitment, signatures), issuedAt: now, expiresAt: now + 300, nonce: newRequestNonce() };
    const approval = { ...claims, signature: await owner.signTypedData(buildSponsorshipApprovalTypedData(audience, claims)) };
    await expect(verifySponsorshipApproval(audience, approval, claims, { now: () => now })).resolves.toMatchObject({ ownerAddress: owner.address });
    const reorderedHash = sponsorshipSubmissionHash(commitment, [...signatures].reverse());
    expect(reorderedHash).not.toBe(claims.submissionHash);
    await expect(verifySponsorshipApproval(audience, approval, { ...claims, submissionHash: reorderedHash }, { now: () => now })).rejects.toMatchObject({ code: "OWNER_APPROVAL_MISMATCH" });
    await expect(verifySponsorshipApproval("https://another.example", approval, claims, { now: () => now })).rejects.toMatchObject({ code: "INVALID_OWNER_APPROVAL_SIGNATURE" });
    await expect(verifySponsorshipApproval(audience, approval, claims, { now: () => now + 300 })).rejects.toMatchObject({ code: "OWNER_APPROVAL_EXPIRED" });
  });
});
