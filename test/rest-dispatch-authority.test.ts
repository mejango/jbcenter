import { describe, expect, it, vi } from "vitest";
import { keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  accountIdFor, buildBotProofTypedData, buildRequestTypedData, createRestAuth,
  MemoryAccountStore, newRequestNonce, REST_AUTH_HEADERS as H,
  type BotScope, type RequestClaims, type RestPrincipal, type SignedRequestInput,
} from "../src/rest/auth/index.js";
import {
  buildSponsorshipApprovalTypedData, buildTransactionApprovalTypedData, sponsorshipSubmissionHash,
  type SponsorshipApproval, type SponsorshipApprovalClaims,
  type TransactionApproval, type TransactionApprovalClaims,
} from "../src/rest/approvals.js";
import {
  createSponsorshipDispatchAuthorizer, createTransactionDispatchAuthorizer,
} from "../src/rest/dispatchAuthority.js";
import {
  restRequest, setOwnerApproval, setRestAuthority, setSponsorshipOwnerApproval, withRestRequest,
} from "../src/rest/context.js";
import type { SponsorshipRecord } from "../src/rest/sponsorship/types.js";
import { FORWARD_REQUEST_TYPES } from "../src/rest/sponsorship/constants.js";
import type { StoredPlan } from "../src/rest/transactions/types.js";

// Public deterministic keys; signed transactions are fixtures and are never broadcast.
const owner = privateKeyToAccount(`0x${"0c".padStart(64, "0")}`);
const bot = privateKeyToAccount(`0x${"0d".padStart(64, "0")}`);
const audience = "https://juicebox.center";
const now = 1_900_000_000;
const accountId = accountIdFor(owner.address, 1);
const planId = "11111111-1111-4111-8111-111111111111";
const target = "0x1111111111111111111111111111111111111111" as Address;
const commitment = `0x${"ab".repeat(32)}` as Hex;
const hash = `0x${"cd".repeat(32)}` as Hex;
type Authority = { principal: RestPrincipal; input: SignedRequestInput };

async function signedRequest(overrides: Partial<RequestClaims> = {}, wallet = owner, document: unknown = {}) {
  const body = overrides.method === "GET" || overrides.method === "HEAD"
    ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(document));
  const claims: RequestClaims = {
    accountId, signer: wallet.address, grantId: "", method: "POST",
    requestTarget: `/api/v1/plans/${planId}/steps/0/submissions`,
    contentType: "application/json", bodyHash: keccak256(body),
    issuedAt: now, expiresAt: now + 60, nonce: newRequestNonce(), idempotencyKey: "authority-test",
    ...overrides,
  };
  const signature = await wallet.signTypedData(buildRequestTypedData(audience, claims));
  const input: SignedRequestInput = {
    method: claims.method, requestTarget: claims.requestTarget, contentType: claims.contentType, body,
    headers: new Headers({
      [H.account]: claims.accountId, [H.signer]: claims.signer, [H.grant]: claims.grantId,
      [H.issuedAt]: String(claims.issuedAt), [H.expiresAt]: String(claims.expiresAt),
      [H.nonce]: claims.nonce, [H.signature]: signature, [H.idempotencyKey]: claims.idempotencyKey,
      "content-type": claims.contentType,
    }),
  };
  return input;
}

function planFor(principal: RestPrincipal): StoredPlan {
  return {
    id: planId, actor: { accountId: principal.account.id, principalId: principal.principalId },
    commitment, createdAt: now * 1000, expiresAt: (now + 300) * 1000, revision: 0,
    draft: {
      account: owner.address, operation: "contract_calls",
      calls: [0, 1].map((index) => ({
        chainId: 1, to: target, data: "0x", value: "0", label: `Reviewed call ${index}`,
        dependsOn: [], decoded: { functionName: "receive", args: [] },
      })),
      evidence: [{ chainId: 1, blockNumber: "100", blockHash: hash, timestamp: String(now), source: "onchain" }],
      summary: { description: "Locally signed dispatch fixture" }, warnings: [],
    },
    steps: [{ index: 0, state: "waiting" }, { index: 1, state: "waiting" }],
  };
}

function sponsorshipFor(principal: RestPrincipal): SponsorshipRecord {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    actor: { accountId: principal.account.id, principalId: principal.principalId },
    planId, planCommitment: commitment, preparationKey: "prepare-sponsorship",
    inputHash: hash, commitment: `0x${"ef".repeat(32)}`,
    requests: [{
      stepIndex: 0, chainId: 1, forwarder: target, forwarderCodeHash: hash, targetCodeHash: hash,
      domain: { name: "Juicebox", version: "1", chainId: 1, verifyingContract: target },
      message: { from: owner.address, to: target, value: "0", gas: "21000", nonce: "0", deadline: String(now + 300), data: "0x" },
      evidence: { chainId: 1, blockNumber: "100", blockHash: hash, timestamp: String(now), source: "onchain" },
    }],
    createdAt: now * 1000, expiresAt: (now + 300) * 1000, revision: 0,
    state: "prepared", observations: [],
  };
}

async function fixture() {
  const clock = { now };
  const auth = createRestAuth({ audience, store: new MemoryAccountStore(), now: () => clock.now });
  await auth.enroll(await signedRequest({ requestTarget: "/api/v1/accounts/enroll" }));
  const transaction = await owner.signTransaction({
    chainId: 1, type: "eip1559", to: target, data: "0x", value: 0n,
    nonce: 0, gas: 21000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n,
  });
  const transactionHash = keccak256(transaction);
  const ownerInput = await signedRequest({}, owner, { rawSignedTransaction: transaction });
  const ownerAuthority: Authority = { input: ownerInput, principal: await auth.authenticate(ownerInput, ["relay"]) };
  const record = sponsorshipFor(ownerAuthority.principal);
  const request = record.requests[0]!;
  const signatures = [await owner.signTypedData({
    domain: request.domain, primaryType: "ForwardRequest", types: FORWARD_REQUEST_TYPES,
    message: {
      ...request.message, value: BigInt(request.message.value), gas: BigInt(request.message.gas),
      nonce: BigInt(request.message.nonce), deadline: Number(request.message.deadline),
    },
  })];
  const sponsorshipHash = sponsorshipSubmissionHash(record.commitment, signatures);
  const sponsorshipInput = await signedRequest({ requestTarget: `/api/v1/sponsorships/${record.id}/submissions` }, owner, { signatures });
  const ownerSponsorshipAuthority: Authority = { input: sponsorshipInput, principal: await auth.authenticate(sponsorshipInput, ["relay"]) };
  const ownerRequest = async (overrides: Partial<RequestClaims>, document: unknown = {}): Promise<Authority> => {
    const input = await signedRequest(overrides, owner, document);
    return { input, principal: await auth.authenticate(input, ["relay"]) };
  };
  const register = async (scopes: BotScope[] = ["read", "plan", "relay"]): Promise<Authority> => {
    const proof = {
      accountId, botAddress: bot.address, scopes,
      label: "Dispatch test bot", expiresAt: now + 3600, ownerRequestNonce: newRequestNonce(),
    };
    const registration = {
      botAddress: proof.botAddress, scopes: proof.scopes, label: proof.label, expiresAt: proof.expiresAt,
      proofSignature: await bot.signTypedData(buildBotProofTypedData(audience, proof)),
    };
    const registrationInput = await signedRequest({ requestTarget: "/api/v1/accounts/me/bots", nonce: proof.ownerRequestNonce }, owner, registration);
    const registrationOwner = await auth.authenticate(registrationInput, [], true);
    const grant = await auth.registerBot(registrationOwner, registration);
    const input = await signedRequest({ grantId: grant.id }, bot, { rawSignedTransaction: transaction });
    return { input, principal: await auth.authenticate(input, [scopes.includes("relay") ? "relay" : "read"]) };
  };
  const botAuthority = await register();
  const options = { audience, now: () => clock.now };
  return {
    clock, auth, ownerAuthority, ownerSponsorshipAuthority, ownerRequest, botAuthority, register,
    options, transaction, transactionHash, sponsorshipHash,
    direct: createTransactionDispatchAuthorizer(options), sponsored: createSponsorshipDispatchAuthorizer(options),
  };
}

async function approvalFor(
  plan: StoredPlan, transactionHash: Hex, stepIndex = 0,
  overrides: Partial<TransactionApprovalClaims> = {}, wallet = owner,
): Promise<TransactionApproval> {
  const claims: TransactionApprovalClaims = {
    ...plan.actor, planId: plan.id, commitment: plan.commitment, stepIndex, transactionHash,
    issuedAt: now, expiresAt: now + 120, nonce: newRequestNonce(), ...overrides,
  };
  return { ...claims, signature: await wallet.signTypedData(buildTransactionApprovalTypedData(audience, claims)) };
}

async function sponsorshipApprovalFor(
  record: SponsorshipRecord, submissionHash: Hex,
  overrides: Partial<SponsorshipApprovalClaims> = {}, wallet = owner,
): Promise<SponsorshipApproval> {
  const claims: SponsorshipApprovalClaims = {
    ...record.actor, sponsorshipId: record.id, commitment: record.commitment, submissionHash,
    issuedAt: now, expiresAt: now + 150, nonce: newRequestNonce(), ...overrides,
  };
  return { ...claims, signature: await wallet.signTypedData(buildSponsorshipApprovalTypedData(audience, claims)) };
}

function authorized<T>(authority: Authority, work: () => Promise<T>, signal = new AbortController().signal) {
  return withRestRequest(signal, async () => { setRestAuthority(authority.principal, authority.input); return work(); });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe("request-bound dispatch authority", () => {
  it("requires an authenticated request context for both dispatch transports", async () => {
    const f = await fixture();
    await expect(f.direct(planFor(f.ownerAuthority.principal), 0, f.transactionHash)).rejects.toMatchObject({ code: "AUTH_REQUIRED", status: 401 });
    await expect(f.sponsored(sponsorshipFor(f.ownerAuthority.principal), hash)).rejects.toMatchObject({ code: "AUTH_REQUIRED", status: 401 });
    await withRestRequest(new AbortController().signal, async () => {
      await expect(f.direct(planFor(f.ownerAuthority.principal), 0, f.transactionHash)).rejects.toMatchObject({ code: "AUTH_REQUIRED", status: 401 });
      await expect(f.sponsored(sponsorshipFor(f.ownerAuthority.principal), hash)).rejects.toMatchObject({ code: "AUTH_REQUIRED", status: 401 });
    });
  });

  it.each(["accountId", "principalId"] as const)("rejects a stored actor with a different %s", async (field) => {
    const f = await fixture();
    const plan = planFor(f.ownerAuthority.principal);
    const record = sponsorshipFor(f.ownerAuthority.principal);
    const replacement = field === "accountId" ? accountIdFor(owner.address, 10) : f.botAuthority.principal.principalId;
    plan.actor[field] = replacement;
    record.actor[field] = replacement;
    await authorized(f.ownerAuthority, async () => {
      await expect(f.direct(plan, 0, f.transactionHash)).rejects.toMatchObject({ code: "DISPATCH_AUTHORITY_MISMATCH", status: 403 });
      await expect(f.sponsored(record, hash)).rejects.toMatchObject({ code: "DISPATCH_AUTHORITY_MISMATCH", status: 403 });
    });
  });

  it("uses the fresh owner's signed request window without a separate approval", async () => {
    const f = await fixture();
    await authorized(f.ownerAuthority, async () => {
      expect(await f.direct(planFor(f.ownerAuthority.principal), 0, f.transactionHash)).toEqual({ issuedAt: now, expiresAt: now + 60 });
      expect(restRequest()?.ownerApprovals.size).toBe(0);
      expect(restRequest()?.sponsorshipOwnerApproval).toBeUndefined();
    });
    await authorized(f.ownerSponsorshipAuthority, async () => {
      expect(await f.sponsored(sponsorshipFor(f.ownerSponsorshipAuthority.principal), f.sponsorshipHash)).toEqual({ issuedAt: now, expiresAt: now + 60 });
      expect(restRequest()?.sponsorshipOwnerApproval).toBeUndefined();
    });
  });

  it("rejects an owner request that expired after HTTP authentication", async () => {
    const f = await fixture();
    f.clock.now = now + 60;
    await authorized(f.ownerAuthority, async () => {
      await expect(f.direct(planFor(f.ownerAuthority.principal), 0, f.transactionHash)).rejects.toMatchObject({ code: "OWNER_APPROVAL_EXPIRED", status: 403 });
    });
    await authorized(f.ownerSponsorshipAuthority, async () => {
      await expect(f.sponsored(sponsorshipFor(f.ownerSponsorshipAuthority.principal), f.sponsorshipHash)).rejects.toMatchObject({ code: "OWNER_APPROVAL_EXPIRED", status: 403 });
    });
  });

  it.each([
    ["expiry", (input: SignedRequestInput) => input.headers.set(H.expiresAt, String(now + 120)), "INVALID_SIGNATURE"],
    ["body", (input: SignedRequestInput) => { input.body = new TextEncoder().encode('{"rawSignedTransaction":"0x01"}'); }, "DISPATCH_AUTHORITY_MISMATCH"],
    ["JSON spacing", (input: SignedRequestInput) => { input.body = new TextEncoder().encode(` ${new TextDecoder().decode(input.body)}`); }, "INVALID_SIGNATURE"],
    ["nonce", (input: SignedRequestInput) => input.headers.set(H.nonce, newRequestNonce()), "DISPATCH_AUTHORITY_MISMATCH"],
    ["signer", (input: SignedRequestInput) => input.headers.set(H.signer, bot.address), "DISPATCH_AUTHORITY_MISMATCH"],
  ] as const)("re-verifies the owner's request after %s is modified", async (_name, mutate, code) => {
    const f = await fixture();
    mutate(f.ownerAuthority.input);
    mutate(f.ownerSponsorshipAuthority.input);
    await authorized(f.ownerAuthority, async () => {
      await expect(f.direct(planFor(f.ownerAuthority.principal), 0, f.transactionHash)).rejects.toMatchObject({ code });
    });
    await authorized(f.ownerSponsorshipAuthority, async () => {
      await expect(f.sponsored(sponsorshipFor(f.ownerSponsorshipAuthority.principal), f.sponsorshipHash)).rejects.toMatchObject({ code });
    });
  });

  it.each([
    { method: "GET", requestTarget: "/api/v1/accounts/me", contentType: "" },
    { method: "PATCH", requestTarget: "/api/v1/accounts/me" },
  ])("does not turn a signed owner $method profile request into dispatch permission", async (request) => {
    const f = await fixture();
    const authority = await f.ownerRequest(request, { displayName: "Owner profile" });
    await authorized(authority, async () => {
      await expect(f.direct(planFor(authority.principal), 0, f.transactionHash)).rejects.toMatchObject({ code: "DISPATCH_AUTHORITY_MISMATCH" });
      await expect(f.sponsored(sponsorshipFor(authority.principal), f.sponsorshipHash)).rejects.toMatchObject({ code: "DISPATCH_AUTHORITY_MISMATCH" });
    });
  });

  it("binds owner requests to the actual plan, step, raw transaction, and sponsorship publication", async () => {
    const f = await fixture();
    const plan = planFor(f.ownerAuthority.principal);
    await authorized(f.ownerAuthority, async () => {
      await expect(f.direct({ ...plan, id: "33333333-3333-4333-8333-333333333333" }, 0, f.transactionHash)).rejects.toMatchObject({ code: "DISPATCH_AUTHORITY_MISMATCH" });
      await expect(f.direct(plan, 1, f.transactionHash)).rejects.toMatchObject({ code: "DISPATCH_AUTHORITY_MISMATCH" });
      await expect(f.direct(plan, 0, hash)).rejects.toMatchObject({ code: "DISPATCH_AUTHORITY_MISMATCH" });
      await expect(f.sponsored(sponsorshipFor(f.ownerAuthority.principal), f.sponsorshipHash)).rejects.toMatchObject({ code: "DISPATCH_AUTHORITY_MISMATCH" });
    });
    await authorized(f.ownerSponsorshipAuthority, async () => {
      const record = sponsorshipFor(f.ownerSponsorshipAuthority.principal);
      await expect(f.sponsored(record, hash)).rejects.toMatchObject({ code: "DISPATCH_AUTHORITY_MISMATCH" });
      await expect(f.sponsored({ ...record, id: "33333333-3333-4333-8333-333333333333" }, f.sponsorshipHash)).rejects.toMatchObject({ code: "DISPATCH_AUTHORITY_MISMATCH" });
      await expect(f.direct(plan, 0, f.transactionHash)).rejects.toMatchObject({ code: "DISPATCH_AUTHORITY_MISMATCH" });
    });
  });

  it("authorizes only the exact signed step entries in an owner's bundle request", async () => {
    const f = await fixture();
    const second = await owner.signTransaction({
      chainId: 1, type: "eip1559", to: target, data: "0x", value: 0n,
      nonce: 1, gas: 21000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n,
    });
    const authority = await f.ownerRequest({ requestTarget: `/api/v1/plans/${planId}/submissions` }, {
      submissions: [{ stepIndex: 0, rawSignedTransaction: f.transaction }, { stepIndex: 1, rawSignedTransaction: second }],
    });
    await authorized(authority, async () => {
      const plan = planFor(authority.principal);
      expect(await f.direct(plan, 0, f.transactionHash)).toEqual({ issuedAt: now, expiresAt: now + 60 });
      expect(await f.direct(plan, 1, keccak256(second))).toEqual({ issuedAt: now, expiresAt: now + 60 });
      await expect(f.direct(plan, 0, keccak256(second))).rejects.toMatchObject({ code: "DISPATCH_AUTHORITY_MISMATCH" });
      await expect(f.direct(plan, 2, f.transactionHash)).rejects.toMatchObject({ code: "DISPATCH_AUTHORITY_MISMATCH" });
    });
  });

  it("requires the bot's exact owner-approved transaction effect", async () => {
    const f = await fixture();
    const plan = planFor(f.botAuthority.principal);
    const approval = await approvalFor(plan, f.transactionHash);
    await authorized(f.botAuthority, async () => {
      await expect(f.direct(plan, 0, f.transactionHash)).rejects.toMatchObject({ code: "OWNER_APPROVAL_REQUIRED" });
      setOwnerApproval(0, approval);
      expect(await f.direct(plan, 0, f.transactionHash)).toEqual({ issuedAt: now, expiresAt: now + 120 });
      await expect(f.direct(plan, 0, hash)).rejects.toMatchObject({ code: "OWNER_APPROVAL_MISMATCH" });
      setOwnerApproval(0, await approvalFor(plan, f.transactionHash, 0, {}, bot));
      await expect(f.direct(plan, 0, f.transactionHash)).rejects.toMatchObject({ code: "INVALID_OWNER_APPROVAL_SIGNATURE" });
    });
  });

  it("does not turn a bot request into owner authority by setting its isOwner flag", async () => {
    const f = await fixture();
    const plan = planFor(f.botAuthority.principal);
    await authorized({ ...f.botAuthority, principal: { ...f.botAuthority.principal, isOwner: true } }, async () => {
      await expect(f.direct(plan, 0, f.transactionHash)).rejects.toMatchObject({ code: "DISPATCH_AUTHORITY_MISMATCH" });
      await expect(f.sponsored(sponsorshipFor(f.botAuthority.principal), hash)).rejects.toMatchObject({ code: "DISPATCH_AUTHORITY_MISMATCH" });
    });
  });

  it("requires a relay grant even when an authenticated read bot has an owner approval", async () => {
    const f = await fixture();
    const reader = await f.register(["read"]);
    const plan = planFor(reader.principal);
    const record = sponsorshipFor(reader.principal);
    const directApproval = await approvalFor(plan, f.transactionHash);
    const sponsoredApproval = await sponsorshipApprovalFor(record, hash);
    await authorized(reader, async () => {
      setOwnerApproval(0, directApproval);
      setSponsorshipOwnerApproval(sponsoredApproval);
      await expect(f.direct(plan, 0, f.transactionHash)).rejects.toMatchObject({ code: "DISPATCH_AUTHORITY_MISMATCH", status: 403 });
      await expect(f.sponsored(record, hash)).rejects.toMatchObject({ code: "DISPATCH_AUTHORITY_MISMATCH", status: 403 });
    });
  });

  it("requires an exact owner approval for a bot's sponsorship publication", async () => {
    const f = await fixture();
    const record = sponsorshipFor(f.botAuthority.principal);
    const approval = await sponsorshipApprovalFor(record, hash);
    await authorized(f.botAuthority, async () => {
      await expect(f.sponsored(record, hash)).rejects.toMatchObject({ code: "OWNER_APPROVAL_REQUIRED" });
      setSponsorshipOwnerApproval(approval);
      expect(await f.sponsored(record, hash)).toEqual({ issuedAt: now, expiresAt: now + 150 });
      await expect(f.sponsored(record, f.transactionHash)).rejects.toMatchObject({ code: "OWNER_APPROVAL_MISMATCH" });
      await expect(f.sponsored({ ...record, commitment }, hash)).rejects.toMatchObject({ code: "OWNER_APPROVAL_MISMATCH" });
      await expect(f.sponsored({ ...record, id: "33333333-3333-4333-8333-333333333333" }, hash)).rejects.toMatchObject({ code: "OWNER_APPROVAL_MISMATCH" });
      setSponsorshipOwnerApproval(await sponsorshipApprovalFor(record, hash, {}, bot));
      await expect(f.sponsored(record, hash)).rejects.toMatchObject({ code: "INVALID_OWNER_APPROVAL_SIGNATURE" });
    });
  });

  it("cannot use one transport's owner signature to authorize the other", async () => {
    const f = await fixture();
    const plan = planFor(f.botAuthority.principal);
    const record = sponsorshipFor(f.botAuthority.principal);
    const directApproval = await approvalFor(plan, f.transactionHash);
    const sponsoredApproval = await sponsorshipApprovalFor(record, hash);
    await authorized(f.botAuthority, async () => {
      setOwnerApproval(0, { ...directApproval, signature: sponsoredApproval.signature });
      setSponsorshipOwnerApproval({ ...sponsoredApproval, signature: directApproval.signature });
      await expect(f.direct(plan, 0, f.transactionHash)).rejects.toMatchObject({ code: "INVALID_OWNER_APPROVAL_SIGNATURE" });
      await expect(f.sponsored(record, hash)).rejects.toMatchObject({ code: "INVALID_OWNER_APPROVAL_SIGNATURE" });
      setOwnerApproval(0, directApproval);
      setSponsorshipOwnerApproval(sponsoredApproval);
      expect(await f.direct(plan, 0, f.transactionHash)).toEqual({ issuedAt: now, expiresAt: now + 120 });
      expect(await f.sponsored(record, hash)).toEqual({ issuedAt: now, expiresAt: now + 150 });
    });
  });

  it("uses separate approval-map entries and verifies the signed step within each entry", async () => {
    const f = await fixture();
    const plan = planFor(f.botAuthority.principal);
    const first = await approvalFor(plan, f.transactionHash);
    const second = await approvalFor(plan, hash, 1, { expiresAt: now + 90 });
    await authorized(f.botAuthority, async () => {
      setOwnerApproval(1, first);
      await expect(f.direct(plan, 0, f.transactionHash)).rejects.toMatchObject({ code: "OWNER_APPROVAL_REQUIRED" });
      await expect(f.direct(plan, 1, f.transactionHash)).rejects.toMatchObject({ code: "OWNER_APPROVAL_MISMATCH" });
      setOwnerApproval(0, first);
      setOwnerApproval(1, second);
      expect(await f.direct(plan, 0, f.transactionHash)).toEqual({ issuedAt: now, expiresAt: now + 120 });
      expect(await f.direct(plan, 1, hash)).toEqual({ issuedAt: now, expiresAt: now + 90 });
    });
  });

  it("isolates principals and per-step approval maps across interleaved async requests", async () => {
    const f = await fixture();
    const secondAuthority = await f.register();
    const firstPlan = planFor(f.botAuthority.principal);
    const secondPlan = planFor(secondAuthority.principal);
    const approvals = [await approvalFor(firstPlan, f.transactionHash), await approvalFor(secondPlan, hash, 0, { expiresAt: now + 90 })];
    const entered = [deferred<void>(), deferred<void>()];
    const continueRequests = [deferred<void>(), deferred<void>()];
    const contexts = [f.botAuthority, secondAuthority];
    const outcomes = contexts.map((authority, index) => authorized(authority, async () => {
      setOwnerApproval(0, approvals[index]);
      entered[index]!.resolve();
      await continueRequests[index]!.promise;
      expect(restRequest()?.authority?.principal.principalId).toBe(authority.principal.principalId);
      const result = await f.direct(index === 0 ? firstPlan : secondPlan, 0, index === 0 ? f.transactionHash : hash);
      await Promise.resolve();
      expect(restRequest()?.ownerApprovals.get(0)).toBe(approvals[index]);
      return result;
    }));
    await Promise.all(entered.map((entry) => entry.promise));
    continueRequests[1]!.resolve();
    expect(await outcomes[1]).toEqual({ issuedAt: now, expiresAt: now + 90 });
    continueRequests[0]!.resolve();
    expect(await outcomes[0]).toEqual({ issuedAt: now, expiresAt: now + 120 });
    expect(restRequest()).toBeUndefined();
  });

  it("rejects canceled requests before owner or bot dispatch", async () => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort();
    for (const authority of [f.ownerAuthority, f.botAuthority]) {
      const plan = planFor(authority.principal);
      const approval = await approvalFor(plan, f.transactionHash);
      await authorized(authority, async () => {
        setOwnerApproval(0, approval);
        await expect(f.direct(plan, 0, f.transactionHash)).rejects.toMatchObject({ code: "REQUEST_ABORTED" });
        await expect(f.sponsored(sponsorshipFor(authority.principal), hash)).rejects.toMatchObject({ code: "REQUEST_ABORTED" });
      }, controller.signal);
    }
  });

  it("propagates cancellation through a waiting owner verifier without affecting another request", async () => {
    const f = await fixture();
    const plan = planFor(f.botAuthority.principal);
    const approval = { ...await approvalFor(plan, f.transactionHash), signature: "0x1234" as Hex };
    const entered = deferred<void>();
    const controller = new AbortController();
    let upstream: AbortSignal | undefined;
    const verifier = vi.fn(async (input: { signal: AbortSignal }) => {
      upstream = input.signal;
      entered.resolve();
      return new Promise<boolean>(() => undefined);
    });
    const direct = createTransactionDispatchAuthorizer({ ...f.options, verifyContractOwner: verifier });
    const interrupted = expect(authorized(f.botAuthority, async () => {
      setOwnerApproval(0, approval);
      return direct(plan, 0, f.transactionHash);
    }, controller.signal)).rejects.toMatchObject({ code: "REQUEST_ABORTED" });
    await entered.promise;
    await authorized(f.ownerAuthority, async () => {
      expect(await f.direct(planFor(f.ownerAuthority.principal), 0, f.transactionHash)).toEqual({ issuedAt: now, expiresAt: now + 60 });
    });
    controller.abort();
    await interrupted;
    expect(upstream?.aborted).toBe(true);
    expect(restRequest()).toBeUndefined();
  });
});
