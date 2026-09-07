import { describe, expect, it, vi } from "vitest";
import { hashTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { accountIdFor, buildRequestTypedData, newRequestNonce, type ContractOwnerVerifier } from "../src/rest/auth/signatures.js";
import {
  buildSponsorshipApprovalTypedData, buildTransactionApprovalTypedData, sponsorshipSubmissionHash,
  verifySponsorshipApproval, verifyTransactionApproval,
  type SponsorshipApproval, type SponsorshipApprovalBinding,
  type TransactionApproval, type TransactionApprovalBinding, type TransactionApprovalClaims,
} from "../src/rest/approvals.js";
import { digest } from "../src/rest/sponsorship/validation.js";

// Public, deterministic test keys; no transaction is broadcast in this suite.
const owner = privateKeyToAccount(`0x${"09".padStart(64, "0")}`);
const bot = privateKeyToAccount(`0x${"0a".padStart(64, "0")}`);
const stranger = privateKeyToAccount(`0x${"0b".padStart(64, "0")}`);
const audience = "https://juicebox.center";
const now = 1_900_000_000;
const binding: TransactionApprovalBinding = {
  accountId: accountIdFor(owner.address, 1),
  principalId: "bot:11111111-1111-4111-8111-111111111111",
  planId: "22222222-2222-4222-8222-222222222222",
  commitment: `0x${"ab".repeat(32)}`, stepIndex: 0,
  transactionHash: `0x${"cd".repeat(32)}`,
};
const settings = { now: () => now };
async function signed(
  overrides: Partial<TransactionApprovalClaims> = {}, wallet = owner, forAudience = audience,
): Promise<TransactionApproval> {
  const claims = { ...binding, issuedAt: now, expiresAt: now + 300, nonce: newRequestNonce(), ...overrides };
  return { ...claims, signature: await wallet.signTypedData(buildTransactionApprovalTypedData(forAudience, claims)) };
}
function gate() {
  let release!: (value: boolean) => void;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const value = new Promise<boolean>((resolve) => { release = resolve; });
  const verifier = vi.fn<ContractOwnerVerifier>(async () => { enter(); return value; });
  return { entered, release, verifier };
}

describe("fresh wallet-owner transaction approvals", () => {
  it("uses a distinct EIP-712 type, audience, and owner authority chain", async () => {
    const approval = await signed();
    const document = buildTransactionApprovalTypedData(audience, approval);
    expect(document).toMatchObject({
      domain: { name: "Juicebox Center REST", version: "1", chainId: 1 },
      primaryType: "CenterTransactionApproval",
      message: { ...binding, audience, issuedAt: BigInt(now), expiresAt: BigInt(now + 300) },
    });
    const result = await verifyTransactionApproval(audience, approval, binding, settings);
    expect(result.ownerAddress).toBe(owner.address);
    expect(result.authorityChainId).toBe(1);
    const { signature: _signature, ...claims } = approval;
    expect(result.claims).toEqual(claims);
  });

  it.each(["accountId", "principalId", "planId", "commitment", "stepIndex", "transactionHash"] as const)(
    "binds %s so an approval nonce cannot be reused for another effect", async (field) => {
      const approval = await signed();
      const changed: TransactionApprovalBinding = { ...binding };
      if (field === "accountId") changed.accountId = accountIdFor(owner.address, 10);
      else if (field === "principalId") changed.principalId = "bot:33333333-3333-4333-8333-333333333333";
      else if (field === "planId") changed.planId = "33333333-3333-4333-8333-333333333333";
      else if (field === "stepIndex") changed.stepIndex = 1;
      else changed[field] = `0x${"ee".repeat(32)}`;
      await expect(verifyTransactionApproval(audience, approval, changed, settings)).rejects.toMatchObject({ code: "OWNER_APPROVAL_MISMATCH", status: 409 });
      // Copying a nonce and changing the document cannot reuse the old owner's signature.
      await expect(verifyTransactionApproval(audience, { ...approval, ...changed }, changed, settings)).rejects.toMatchObject({ code: "INVALID_OWNER_APPROVAL_SIGNATURE" });
    },
  );

  it("rejects other audiences, bot signatures, and unrelated owner signatures", async () => {
    for (const approval of [await signed({}, bot), await signed({}, stranger), await signed({}, owner, "https://elsewhere.example")]) {
      await expect(verifyTransactionApproval(audience, approval, binding, settings)).rejects.toMatchObject({ code: "INVALID_OWNER_APPROVAL_SIGNATURE", status: 403 });
    }
  });

  it("does not treat the owner's ordinary request signature as this distinct approval", async () => {
    const approval = await signed();
    const signature = await owner.signTypedData(buildRequestTypedData(audience, {
      accountId: binding.accountId, signer: owner.address, grantId: "", method: "POST",
      requestTarget: "/api/v1/plans", contentType: "application/json", bodyHash: binding.transactionHash,
      issuedAt: now, expiresAt: now + 300, nonce: approval.nonce, idempotencyKey: "",
    }));
    await expect(verifyTransactionApproval(audience, { ...approval, signature }, binding, settings)).rejects.toMatchObject({ code: "INVALID_OWNER_APPROVAL_SIGNATURE" });
  });

  it("requires approval and rejects malformed body, scope, signature, and timestamp types", async () => {
    const valid = await signed();
    await expect(verifyTransactionApproval(audience, undefined, binding, settings)).rejects.toMatchObject({ code: "OWNER_APPROVAL_REQUIRED", status: 428 });
    for (const invalid of [
      [], "signature", { ...valid, scopes: ["relay"] }, { ...valid, signer: owner.address },
      { ...valid, issuedAt: String(now) }, { ...valid, issuedAt: NaN }, { ...valid, issuedAt: -0 },
      { ...valid, expiresAt: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, expiresAt: now + 301 },
      { ...valid, expiresAt: now }, { ...valid, stepIndex: 0.5 }, { ...valid, stepIndex: -0 },
      { ...valid, stepIndex: 32 }, { ...valid, nonce: "0x12" }, { ...valid, signature: [valid.signature] },
      { ...valid, signature: "0x123" }, { ...valid, signature: `0x${"ab".repeat(8193)}` },
      { ...valid, accountId: { toString: () => binding.accountId } },
    ]) await expect(verifyTransactionApproval(audience, invalid, binding, settings)).rejects.toMatchObject({ code: "INVALID_OWNER_APPROVAL", status: 400 });
  });

  it("accepts a five-minute window and enforces expiry at final admission", async () => {
    const approval = await signed();
    const result = await verifyTransactionApproval(audience, approval, binding, settings);
    expect(() => result.assertFreshAt(now + 299)).not.toThrow();
    expect(() => result.assertFreshAt(now + 300)).toThrow(expect.objectContaining({ code: "OWNER_APPROVAL_EXPIRED" }));
    await expect(verifyTransactionApproval(audience, approval, binding, { now: () => now + 300 })).rejects.toMatchObject({ code: "OWNER_APPROVAL_EXPIRED" });
    await expect(verifyTransactionApproval(audience, await signed({ issuedAt: now + 31, expiresAt: now + 60 }), binding, settings)).rejects.toMatchObject({ code: "OWNER_APPROVAL_EXPIRED" });
  });

  it("permits only the same exact approval effect to be verified again before expiry", async () => {
    const approval = await signed();
    await expect(verifyTransactionApproval(audience, approval, binding, settings)).resolves.toMatchObject({ claims: { nonce: approval.nonce } });
    await expect(verifyTransactionApproval(audience, approval, { ...binding, commitment: binding.commitment.toUpperCase().replace("0X", "0x") as Hex }, settings)).resolves.toMatchObject({ claims: { nonce: approval.nonce } });
    await expect(verifyTransactionApproval(audience, { ...approval, nonce: newRequestNonce() }, binding, settings)).rejects.toMatchObject({ code: "INVALID_OWNER_APPROVAL_SIGNATURE" });
  });

  it("verifies contract owners on their authority chain with the exact approval digest", async () => {
    const approval = { ...await signed(), signature: "0x1234" as Hex };
    const verifier = vi.fn<ContractOwnerVerifier>(async () => true);
    const result = await verifyTransactionApproval(audience, approval, binding, { ...settings, verifyContractOwner: verifier });
    expect(result.ownerAddress).toBe(owner.address);
    expect(verifier).toHaveBeenCalledWith({
      ownerAddress: owner.address, authorityChainId: 1,
      digest: hashTypedData(buildTransactionApprovalTypedData(audience, approval)),
      signature: "0x1234", signal: expect.any(AbortSignal),
    });
  });

  it("fails closed on contract verifier errors or truthy non-booleans without leaking data", async () => {
    const approval = { ...await signed(), signature: "0x1234" as Hex };
    for (const verifier of [
      async () => false,
      async () => { throw new Error("https://private.example/credential signature=0x1234"); },
      async () => "true",
    ]) {
      const failure = verifyTransactionApproval(audience, approval, binding, { ...settings, verifyContractOwner: verifier as ContractOwnerVerifier });
      await expect(failure).rejects.toMatchObject({ code: "INVALID_OWNER_APPROVAL_SIGNATURE" });
      await expect(failure).rejects.not.toThrow(/credential|private\.example|1234/);
    }
  });

  it("rechecks freshness after awaited contract verification", async () => {
    const approval = { ...await signed({ expiresAt: now + 1 }), signature: "0x1234" as Hex };
    const pending = gate();
    let clock = now;
    const outcome = verifyTransactionApproval(audience, approval, binding, { now: () => clock, verifyContractOwner: pending.verifier });
    await pending.entered;
    clock = now + 1;
    pending.release(true);
    await expect(outcome).rejects.toMatchObject({ code: "OWNER_APPROVAL_EXPIRED" });
  });

  it("rechecks freshness after asynchronous EOA recovery too", async () => {
    const approval = await signed({ expiresAt: now + 1 });
    const clock = vi.fn().mockReturnValueOnce(now).mockReturnValue(now + 1);
    await expect(verifyTransactionApproval(audience, approval, binding, { now: clock })).rejects.toMatchObject({ code: "OWNER_APPROVAL_EXPIRED" });
    expect(clock).toHaveBeenCalledTimes(2);
  });

  it("snapshots signed claims before awaiting and returns an immutable approval window", async () => {
    const approval = { ...await signed({ expiresAt: now + 20 }), signature: "0x1234" as Hex };
    const expected = { ...binding };
    const pending = gate();
    const outcome = verifyTransactionApproval(audience, approval, expected, { ...settings, verifyContractOwner: pending.verifier });
    await pending.entered;
    approval.expiresAt = now + 300;
    approval.transactionHash = `0x${"ef".repeat(32)}`;
    expected.planId = "33333333-3333-4333-8333-333333333333";
    pending.release(true);
    const result = await outcome;
    expect(result.claims).toMatchObject({ expiresAt: now + 20, transactionHash: binding.transactionHash, planId: binding.planId });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.claims)).toBe(true);
    expect(() => result.assertFreshAt(now + 20)).toThrow(expect.objectContaining({ code: "OWNER_APPROVAL_EXPIRED" }));
  });

  it("bounds contract verification to five seconds and aborts the upstream operation", async () => {
    const approval = { ...await signed(), signature: "0x1234" as Hex };
    let signal: AbortSignal | undefined;
    vi.useFakeTimers();
    try {
      const outcome = expect(verifyTransactionApproval(audience, approval, binding, {
        ...settings, verifyContractOwner: async (input) => { signal = input.signal; return new Promise<boolean>(() => undefined); },
      })).rejects.toMatchObject({ code: "INVALID_OWNER_APPROVAL_SIGNATURE" });
      await vi.advanceTimersByTimeAsync(5001);
      await outcome;
      expect(signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("honors cancellation before recovery and while a contract verifier waits", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(verifyTransactionApproval(audience, await signed(), binding, { ...settings, signal: controller.signal })).rejects.toMatchObject({ code: "REQUEST_ABORTED" });
    const active = new AbortController();
    const pending = gate();
    const outcome = verifyTransactionApproval(audience, { ...await signed(), signature: "0x1234" }, binding, { ...settings, signal: active.signal, verifyContractOwner: pending.verifier });
    await pending.entered;
    active.abort();
    await expect(outcome).rejects.toMatchObject({ code: "REQUEST_ABORTED" });
    pending.release(true);
  });
});

describe("fresh sponsorship publication approvals", () => {
  const expected: SponsorshipApprovalBinding = {
    accountId: binding.accountId, principalId: binding.principalId,
    sponsorshipId: "44444444-4444-4444-8444-444444444444",
    commitment: binding.commitment, submissionHash: `0x${"dd".repeat(32)}`,
  };
  async function sponsored(): Promise<SponsorshipApproval> {
    const claims = { ...expected, issuedAt: now, expiresAt: now + 300, nonce: newRequestNonce() };
    return { ...claims, signature: await owner.signTypedData(buildSponsorshipApprovalTypedData(audience, claims)) };
  }

  it("uses a distinct type and returns an immutable verified publication window", async () => {
    const approval = await sponsored();
    expect(buildSponsorshipApprovalTypedData(audience, approval).primaryType).toBe("CenterSponsorshipApproval");
    const verified = await verifySponsorshipApproval(audience, approval, expected, settings);
    const { signature: _signature, ...claims } = approval;
    expect(verified.claims).toEqual(claims);
    expect(verified.ownerAddress).toBe(owner.address);
    expect(Object.isFrozen(verified.claims)).toBe(true);
    expect(() => verified.assertFreshAt(now + 300)).toThrow(expect.objectContaining({ code: "OWNER_APPROVAL_EXPIRED" }));
  });

  it.each(["accountId", "principalId", "sponsorshipId", "commitment", "submissionHash"] as const)(
    "prevents an approval nonce from transferring to another sponsorship %s", async (field) => {
      const approval = await sponsored();
      const changed = { ...expected };
      if (field === "accountId") changed.accountId = accountIdFor(owner.address, 10);
      else if (field === "principalId") changed.principalId = "bot:55555555-5555-4555-8555-555555555555";
      else if (field === "sponsorshipId") changed.sponsorshipId = "55555555-5555-4555-8555-555555555555";
      else changed[field] = `0x${"ee".repeat(32)}`;
      await expect(verifySponsorshipApproval(audience, approval, changed, settings)).rejects.toMatchObject({ code: "OWNER_APPROVAL_MISMATCH" });
      await expect(verifySponsorshipApproval(audience, { ...approval, ...changed }, changed, settings)).rejects.toMatchObject({ code: "INVALID_OWNER_APPROVAL_SIGNATURE" });
    },
  );

  it("rejects direct transaction, bot, and other-audience signatures for publication", async () => {
    const approval = await sponsored();
    const signatures = [
      (await signed()).signature,
      await bot.signTypedData(buildSponsorshipApprovalTypedData(audience, approval)),
      await owner.signTypedData(buildSponsorshipApprovalTypedData("https://another.example", approval)),
    ];
    for (const signature of signatures) await expect(verifySponsorshipApproval(audience, { ...approval, signature }, expected, settings)).rejects.toMatchObject({ code: "INVALID_OWNER_APPROVAL_SIGNATURE" });
    await expect(verifyTransactionApproval(audience, { ...await signed(), signature: approval.signature }, binding, settings)).rejects.toMatchObject({ code: "INVALID_OWNER_APPROVAL_SIGNATURE" });
  });

  it("rejects fields from other approval types and malformed publication hashes", async () => {
    const approval = await sponsored();
    for (const input of [
      { ...approval, planId: binding.planId }, { ...approval, transactionHash: binding.transactionHash },
      { ...approval, sponsorshipId: "unknown" }, { ...approval, submissionHash: "0x01" },
      { ...approval, issuedAt: String(now) }, { ...approval, signature: { signature: approval.signature } },
    ]) await expect(verifySponsorshipApproval(audience, input, expected, settings)).rejects.toMatchObject({ code: "INVALID_OWNER_APPROVAL" });
  });

  it("matches the server publication hash from exact ordered forwarding signatures", () => {
    const signatures: Hex[] = [`0x${"AB".repeat(65)}`, `0x${"CD".repeat(65)}`];
    expect(sponsorshipSubmissionHash(binding.commitment, signatures)).toBe(digest({
      commitment: binding.commitment, signatures: signatures.map((signature) => signature.toLowerCase()),
    }));
    expect(sponsorshipSubmissionHash(binding.commitment, [...signatures].reverse())).not.toBe(sponsorshipSubmissionHash(binding.commitment, signatures));
    for (const invalid of [[], ["0x123"], new Array<Hex>(1), new Array<Hex>(5).fill(signatures[0]!)]) {
      expect(() => sponsorshipSubmissionHash(binding.commitment, invalid as Hex[])).toThrow(expect.objectContaining({ code: "INVALID_OWNER_APPROVAL" }));
    }
  });

  it("rechecks the sponsorship deadline after contract-wallet verification", async () => {
    const approval = { ...await sponsored(), signature: "0x1234" as Hex };
    const pending = gate();
    let clock = now;
    const outcome = verifySponsorshipApproval(audience, approval, expected, { now: () => clock, verifyContractOwner: pending.verifier });
    await pending.entered;
    clock = approval.expiresAt;
    pending.release(true);
    await expect(outcome).rejects.toMatchObject({ code: "OWNER_APPROVAL_EXPIRED" });
  });
});
