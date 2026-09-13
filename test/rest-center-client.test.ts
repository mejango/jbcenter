import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CenterClient, connectionForBot, parseConnection, type Plan } from "../src/rest/client/index.js";
import { createRestAuth, createRestAuthRouter, MemoryAccountStore } from "../src/rest/auth/index.js";
import { buildTransactionApprovalTypedData, sponsorshipSubmissionHash } from "../src/rest/approvals.js";
import { recoverTypedDataAddress } from "viem";

const owner = privateKeyToAccount(`0x${"01".padStart(64, "0")}`);
const key = `0x${"02".padStart(64, "0")}` as Hex;
const botSigner = privateKeyToAccount(key);
const audience = "https://juicebox.center";
const now = 1_900_000_000;
const planId = "11111111-1111-4111-8111-111111111111";

async function setup() {
  const auth = createRestAuth({ store: new MemoryAccountStore(), audience, now: () => now });
  const app = new Hono();
  app.route("/api/v1", createRestAuthRouter(auth, { requestTarget: c => new URL(c.req.url).pathname }));
  const bodies: string[] = [];
  const transport: typeof fetch = async (url, init) => {
    bodies.push(new TextDecoder().decode(init?.body instanceof Uint8Array ? init.body : new Uint8Array()));
    return app.request(String(url), init);
  };
  const sign = vi.fn(owner.signTypedData);
  const ownerApi = CenterClient.forOwner({ audience, chainId: 1, signer: { ...owner, signTypedData: sign }, fetch: transport, now: () => now });
  await ownerApi.enroll();
  const registered = await ownerApi.registerBot({ signer: botSigner, scopes: ["read", "plan", "relay"], label: "app", expiresAt: now + 3600 });
  return { ownerApi, ...registered, bodies, sign, transport };
}

describe("Center integration journey", () => {
  it("signs in, creates access, reconnects from one file, and revokes access without copying IDs", async () => {
    const f = await setup();
    expect(f.sign).toHaveBeenCalledTimes(2);
    const saved = connectionForBot(audience, f.bot, key);
    const center = CenterClient.fromConnection(JSON.parse(JSON.stringify(saved)), { fetch: f.transport, now: () => now });
    expect((await center.account()).account.id).toBe(f.bot.accountId);
    expect((await f.client.account()).account.id).toBe(f.bot.accountId);
    expect(f.sign).toHaveBeenCalledTimes(2);
    expect(f.bodies.join(" ")).not.toContain(key);
    expect(f.bodies.join(" ")).not.toContain("privateKey");
    await f.ownerApi.revokeBot(f.bot.id);
    await expect(center.account()).rejects.toMatchObject({ status: 403 });
  });
  it("rejects tampered and expired connections before making a request", async () => {
    const f = await setup();
    const saved = connectionForBot(audience, f.bot, key);
    expect(() => parseConnection({ ...saved, botAddress: owner.address })).toThrow();
    expect(() => parseConnection({ ...saved, audience: "https://juicebox.center.evil.test/path" })).toThrow();
    expect(() => parseConnection({ ...saved, extraSecret: "must not propagate" })).toThrow();
    expect(() => CenterClient.fromConnection(saved, { now: () => now + 3600 })).toThrow(/expired/);
  });
  it("binds approval to the exact bytes, plan, originating bot and fresh nonce", async () => {
    const f = await setup();
    const plan = { id: planId, commitment: `0x${"ab".repeat(32)}`, expiresAt: (now + 100) * 1000,
      account: owner.address, draft: { calls: [{ chainId: 1, to: owner.address, data: "0x", value: "0" }] } } as unknown as Plan;
    const rawSignedTransaction = await owner.signTransaction({ chainId: 1, type: "eip1559", to: owner.address, data: "0x", value: 0n, nonce: 0, gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
    await expect(f.client.approveTransaction({ plan, stepIndex: 0, rawSignedTransaction: "0x1234" }, owner)).rejects.toMatchObject({ code: "SIGNED_TRANSACTION_MISMATCH" });
    const approved = await f.client.approveTransaction({ plan, stepIndex: 0, rawSignedTransaction }, owner);
    const claims = approved.ownerApproval!;
    expect(claims).toMatchObject({ principalId: `bot:${f.bot.id}`, planId, commitment: plan.commitment, transactionHash: keccak256(rawSignedTransaction), issuedAt: now, expiresAt: now + 300 });
    const { signature, ...message } = claims;
    expect(await recoverTypedDataAddress({ ...buildTransactionApprovalTypedData(audience, message), signature })).toBe(owner.address);
    await expect(f.client.approveTransaction({ plan, stepIndex: 0, rawSignedTransaction }, botSigner)).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
    await expect(f.client.approveTransaction({ plan, stepIndex: 1, rawSignedTransaction }, owner)).rejects.toThrow();
    expect((await f.client.approveTransaction({ plan, stepIndex: 0, rawSignedTransaction }, owner)).ownerApproval?.nonce).not.toBe(claims.nonce);
  });
  it("uses named requests with stable idempotency keys and preserves prepaid signature order", async () => {
    const f = await setup();
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const client = CenterClient.fromConnection(connectionForBot(audience, f.bot, key), { now: () => now, fetch: async (url, init) => { requests.push({ url: String(url), init }); return Response.json({}); } });
    await client.prepare({ operation: "contract_calls", input: { calls: [] } }, "prepare-once");
    await client.plan(planId, { refresh: true });
    expect(new Headers(requests[0]!.init?.headers).get("Idempotency-Key")).toBe("prepare-once");
    expect(requests[1]!.url).toBe(`${audience}/api/v1/plans/${planId}?refresh=true`);
    const signatures = [`0x${"11".repeat(65)}`, `0x${"22".repeat(65)}`] as Hex[];
    const preparation = { id: planId, planId, commitment: `0x${"ab".repeat(32)}` as Hex, publicationExpiresAt: (now + 100) * 1000,
      authorizations: [{}, {}], state: "prepared" as const, availability: "available", observations: [] };
    const approved = await client.approvePrepaid(preparation as unknown as Parameters<typeof client.approvePrepaid>[0], signatures, owner);
    expect(approved.ownerApproval?.submissionHash).toBe(sponsorshipSubmissionHash(preparation.commitment, signatures));
    signatures.reverse();
    expect(approved.signatures).not.toEqual(signatures);
    await client.submitPrepaid(approved, "publish-once");
    const body = JSON.parse(new TextDecoder().decode(requests.at(-1)!.init!.body as Uint8Array));
    expect(body.signatures).toEqual(approved.signatures);
    expect(body.ownerApproval).toEqual(approved.ownerApproval);
  });
});
