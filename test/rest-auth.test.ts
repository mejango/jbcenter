import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { hashTypedData, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  accountIdFor,
  buildBotProofTypedData,
  buildRequestTypedData,
  createRestAuth,
  createRestAuthRouter,
  MemoryAccountStore,
  newRequestNonce,
  readSignedRequest,
  RestAuthError,
  REST_AUTH_HEADERS as H,
  validateProfile,
  type BotScope,
  type RegisterBotInput,
  type RequestClaims,
  type RestAuth,
  type SignedRequestInput,
} from "../src/rest/auth/index.js";

const owner = privateKeyToAccount(`0x${"01".padStart(64, "0")}`);
const bot = privateKeyToAccount(`0x${"02".padStart(64, "0")}`);
const other = privateKeyToAccount(`0x${"03".padStart(64, "0")}`);
const accountId = accountIdFor(owner.address, 1);
const audience = "https://juicebox.center";
const now = 1_900_000_000;

async function signed(overrides: Partial<RequestClaims> = {}, wallet = owner, document: unknown = {}) {
  const body = new TextEncoder().encode(JSON.stringify(document));
  const claims: RequestClaims = {
    accountId, signer: wallet.address, grantId: "", method: "POST",
    requestTarget: "/api/v1/accounts/enroll", contentType: "application/json",
    bodyHash: keccak256(body), issuedAt: now, expiresAt: now + 60,
    nonce: newRequestNonce(), idempotencyKey: "", ...overrides,
  };
  const signature = await wallet.signTypedData(buildRequestTypedData(audience, claims));
  return {
    input: {
      method: claims.method, requestTarget: claims.requestTarget, contentType: claims.contentType,
      body,
      headers: new Headers({
        [H.account]: claims.accountId, [H.signer]: claims.signer, [H.grant]: claims.grantId,
        [H.issuedAt]: String(claims.issuedAt), [H.expiresAt]: String(claims.expiresAt),
        [H.nonce]: claims.nonce, [H.signature]: signature,
        [H.idempotencyKey]: claims.idempotencyKey, "content-type": claims.contentType,
      }),
    } satisfies SignedRequestInput,
    claims,
  };
}

async function fixture() {
  let clock = now;
  const store = new MemoryAccountStore();
  const auth = createRestAuth({ store, audience, now: () => clock });
  await auth.enroll((await signed()).input);
  return { store, auth, setClock: (value: number) => { clock = value; } };
}

async function register(auth: RestAuth, scopes?: BotScope[]) {
  const ownerRequestNonce = newRequestNonce();
  const proof = {
    accountId, botAddress: bot.address, scopes: scopes ?? ["read" as const],
    label: "local developer bot", expiresAt: now + 3_600, ownerRequestNonce,
  };
  const document: RegisterBotInput = {
    botAddress: bot.address, ...(scopes ? { scopes } : {}), label: proof.label,
    expiresAt: proof.expiresAt,
    proofSignature: await bot.signTypedData(buildBotProofTypedData(audience, proof)),
  };
  const request = await signed({ nonce: ownerRequestNonce, requestTarget: "/api/v1/accounts/me/bots" }, owner, document);
  const principal = await auth.authenticate(request.input, [], true);
  return { grant: await auth.registerBot(principal, document), document, principal };
}

describe("REST request signatures", () => {
  it("enrolls an owner without any API key or bot and rejects request reuse", async () => {
    const store = new MemoryAccountStore();
    const auth = createRestAuth({ store, audience, now: () => now });
    const request = await signed();
    const result = await auth.enroll(request.input);
    expect(result.account).toMatchObject({ id: accountId, ownerAddress: owner.address.toLowerCase(), authorityChainId: 1 });
    expect(result.isOwner).toBe(true);
    expect(result.principalId).toBe(`owner:${accountId}`);
    await expect(auth.enroll(request.input)).rejects.toMatchObject({ code: "REPLAY" });
  });

  it.each([
    ["method", (input: SignedRequestInput) => { input.method = "PATCH"; }],
    ["path", (input: SignedRequestInput) => { input.requestTarget = "/api/v1/accounts/me"; }],
    ["query", (input: SignedRequestInput) => { input.requestTarget += "?scope=relay"; }],
    ["body bytes", (input: SignedRequestInput) => { input.body = new TextEncoder().encode("{ }"); }],
    ["content type", (input: SignedRequestInput) => { input.contentType += ";charset=utf-8"; input.headers.set("content-type", input.contentType); }],
    ["idempotency", (input: SignedRequestInput) => { input.headers.set(H.idempotencyKey, "changed"); }],
    ["nonce", (input: SignedRequestInput) => { input.headers.set(H.nonce, newRequestNonce()); }],
    ["expiry", (input: SignedRequestInput) => { input.headers.set(H.expiresAt, String(now + 59)); }],
    ["issued time", (input: SignedRequestInput) => { input.headers.set(H.issuedAt, String(now - 1)); }],
    ["signer", (input: SignedRequestInput) => { input.headers.set(H.signer, other.address); }],
    ["account", (input: SignedRequestInput) => { input.headers.set(H.account, accountIdFor(owner.address, 10)); }],
    ["grant", (input: SignedRequestInput) => { input.headers.set(H.grant, "11111111-1111-4111-8111-111111111111"); }],
  ])("binds %s cryptographically", async (_, alter) => {
    const { auth } = await fixture();
    const request = await signed();
    alter(request.input);
    await expect(auth.authenticate(request.input)).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });
  });

  it("separates service audiences and signatures for request versus bot registration", async () => {
    const { store } = await fixture();
    const request = await signed();
    const wrongAudience = createRestAuth({ store, audience: "https://elsewhere.example", now: () => now });
    await expect(wrongAudience.authenticate(request.input)).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });
    const wrongType = await owner.signTypedData(buildBotProofTypedData(audience, {
      accountId, botAddress: owner.address, scopes: ["read"], expiresAt: now + 60,
      label: "", ownerRequestNonce: request.claims.nonce,
    }));
    request.input.headers.set(H.signature, wrongType);
    const auth = createRestAuth({ store, audience, now: () => now });
    await expect(auth.authenticate(request.input)).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });
  });

  it.each([
    { issuedAt: now - 60, expiresAt: now },
    { issuedAt: now + 31, expiresAt: now + 60 },
    { issuedAt: now, expiresAt: now + 301 },
    { issuedAt: now + 10, expiresAt: now + 5 },
  ])("rejects invalid freshness window %j", async (window) => {
    const { auth } = await fixture();
    await expect(auth.authenticate((await signed(window)).input)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  it("rejects fake owner bootstrap and static bearer credentials", async () => {
    const { auth } = await fixture();
    await expect(auth.enroll((await signed({}, bot)).input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const request = (await signed()).input;
    request.headers = new Headers({ authorization: "Bearer a-static-key" });
    await expect(auth.authenticate(request)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("supports an injected EIP-1271 verifier only for the named owner and authority chain", async () => {
    const store = new MemoryAccountStore();
    const request = await signed();
    const signature = "0x1234" as Hex;
    const digest = hashTypedData(buildRequestTypedData(audience, request.claims));
    const calls: unknown[] = [];
    const auth = createRestAuth({ store, audience, now: () => now, verifyContractOwner: async (input) => {
      calls.push(input);
      return input.ownerAddress === owner.address && input.authorityChainId === 1 && input.digest === digest && input.signature === signature;
    } });
    request.input.headers.set(H.signature, signature);
    expect((await auth.enroll(request.input)).isOwner).toBe(true);
    expect(calls).toHaveLength(1);
    const botRequest = await signed({ signer: bot.address, grantId: "11111111-1111-4111-8111-111111111111" }, bot);
    botRequest.input.headers.set(H.signature, signature);
    await expect(auth.authenticate(botRequest.input)).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });
    expect(calls).toHaveLength(1);
  });

  it("fails closed when contract-owner verification is unavailable", async () => {
    const auth = createRestAuth({ store: new MemoryAccountStore(), audience, now: () => now,
      verifyContractOwner: async () => { throw new Error("private RPC credential must not appear"); } });
    const request = await signed();
    request.input.headers.set(H.signature, "0x1234");
    await expect(auth.enroll(request.input)).rejects.toMatchObject({ code: "INVALID_SIGNATURE", message: "Request signature is invalid" });
  });

  it("rechecks expiry after contract-wallet verification returns", async () => {
    let clock = now;
    const auth = createRestAuth({ store: new MemoryAccountStore(), audience, now: () => clock,
      verifyContractOwner: async () => { clock = now + 60; return true; } });
    const request = await signed();
    request.input.headers.set(H.signature, "0x1234");
    await expect(auth.enroll(request.input)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  it("bounds a stalled contract-wallet verifier and aborts its upstream work", async () => {
    const request = await signed();
    request.input.headers.set(H.signature, "0x1234");
    let aborted = false;
    vi.useFakeTimers();
    try {
      const auth = createRestAuth({ store: new MemoryAccountStore(), audience, now: () => now,
        verifyContractOwner: async ({ signal }) => {
          signal.addEventListener("abort", () => { aborted = true; });
          return new Promise<boolean>(() => undefined);
        } });
      const outcome = expect(auth.enroll(request.input)).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });
      await vi.advanceTimersByTimeAsync(5_001);
      await outcome;
      expect(aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});

describe("wallet-owned bot grants", () => {
  it("defaults to read-only, requires possession, and enforces scopes", async () => {
    const { auth } = await fixture();
    const { grant } = await register(auth);
    expect(grant.scopes).toEqual(["read"]);
    const request = await signed({ grantId: grant.id }, bot);
    expect((await auth.authenticate(request.input)).principalId).toBe(`bot:${grant.id}`);
    await expect(auth.authenticate((await signed({ grantId: grant.id }, bot)).input, ["relay"])).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(auth.authenticate((await signed({ grantId: grant.id }, other)).input)).rejects.toMatchObject({ status: 403 });
  });

  it("binds bot proof to account, scopes, expiry, label, and the owner's request nonce", async () => {
    const { auth } = await fixture();
    const { document } = await register(auth);
    for (const changes of [
      { scopes: ["read", "plan"] as BotScope[] }, { expiresAt: now + 120 },
      { label: "different" }, { botAddress: other.address }, {},
    ]) {
      const principal = await auth.authenticate((await signed()).input, [], true);
      await expect(auth.registerBot(principal, { ...document, ...changes })).rejects.toMatchObject({ code: "INVALID_BOT_PROOF" });
    }
  });

  it("never lets a bot manage grants or owner profile even with all bot scopes", async () => {
    const { auth } = await fixture();
    const { grant, document } = await register(auth, ["read", "plan", "relay"]);
    const principal = await auth.authenticate((await signed({ grantId: grant.id }, bot)).input);
    await expect(auth.updateProfile(principal, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(auth.registerBot(principal, document)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(auth.listBots(principal)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(auth.revokeBot(principal, grant.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rechecks revocation for retained principals and enforces grant expiry", async () => {
    const { auth, setClock } = await fixture();
    const { grant, principal: ownerPrincipal } = await register(auth, ["read", "plan", "relay"]);
    const principal = await auth.authenticate((await signed({ grantId: grant.id }, bot)).input);
    await auth.assertActive(principal, "relay");
    await auth.revokeBot(ownerPrincipal, grant.id);
    await expect(auth.assertActive(principal, "relay")).rejects.toMatchObject({ code: "FORBIDDEN" });
    const fresh = await register(auth);
    setClock(now + 3_600);
    await expect(auth.authenticate((await signed({ grantId: fresh.grant.id, issuedAt: now + 3_600, expiresAt: now + 3_660 }, bot)).input)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("validates bounded profile fields without fetching avatar URLs", () => {
    expect(validateProfile({ displayName: "Owner", bio: "Hello", avatarUri: "ipfs://example/logo.png" })).toEqual({ displayName: "Owner", bio: "Hello", avatarUri: "ipfs://example/logo.png" });
    for (const input of [{ displayName: "x".repeat(121) }, { bio: "x".repeat(2001) }, { avatarUri: "javascript:alert(1)" }, { avatarUri: "https://secret@somewhere.example" }, { ownerAddress: other.address }]) {
      expect(() => validateProfile(input)).toThrow();
    }
  });

  it("accepts only cumulative canonical profiles without expanding signed permissions", async () => {
    const { auth } = await fixture();
    for (const scopes of [["read"], ["read", "plan"], ["read", "plan", "relay"]] as BotScope[][]) {
      expect((await register(auth, scopes)).grant.scopes).toEqual(scopes);
    }
    for (const scopes of [[], ["plan"], ["relay"], ["read", "relay"], ["plan", "relay"], ["plan", "read"], ["read", "relay", "plan"], ["read", "read"]] as BotScope[][]) {
      await expect(register(auth, scopes)).rejects.toMatchObject({ code: "INVALID_INPUT", status: 400 });
    }
  });
});

describe("account HTTP routes", () => {
  it("enrolls and reads a profile using the mounted prefix and exact signed bytes", async () => {
    const auth = createRestAuth({ store: new MemoryAccountStore(), audience, now: () => now });
    const app = new Hono();
    app.route("/api/v1", createRestAuthRouter(auth, {
      requestTarget: (context) => { const url = new URL(context.req.url); return `${url.pathname}${url.search}`; },
    }));
    const enrollment = await signed();
    const response = await app.request(`https://juicebox.center${enrollment.input.requestTarget}`, {
      method: "POST", headers: enrollment.input.headers, body: enrollment.input.body,
    });
    expect(response.status).toBe(200);
    const read = await signed({ method: "GET", requestTarget: "/api/v1/accounts/me", bodyHash: keccak256(new Uint8Array()) });
    const profile = await app.request(`https://juicebox.center${read.input.requestTarget}`, { method: "GET", headers: read.input.headers });
    expect(profile.status).toBe(200);
    expect(await profile.json()).toMatchObject({ account: { id: accountId } });
    const replay = await app.request(`https://juicebox.center${read.input.requestTarget}`, { method: "GET", headers: read.input.headers });
    expect(replay.status).toBe(409);
  });

  it("bounds actual streamed body bytes and rejects content encoding", async () => {
    const request = new Request("https://juicebox.center/api/v1/accounts/enroll", { method: "POST", body: "x".repeat(33) });
    await expect(readSignedRequest(request, "/api/v1/accounts/enroll", 32)).rejects.toMatchObject({ code: "BODY_TOO_LARGE" });
    const compressed = new Request(request.url, { method: "POST", body: "{}", headers: { "content-encoding": "gzip" } });
    await expect(readSignedRequest(compressed, "/api/v1/accounts/enroll")).rejects.toMatchObject({ code: "UNSUPPORTED_ENCODING" });
  });

  it("returns a safe input error for malformed bot address types", async () => {
    const { auth } = await fixture();
    const app = new Hono();
    app.route("/api/v1", createRestAuthRouter(auth, {
      requestTarget: (context) => { const url = new URL(context.req.url); return `${url.pathname}${url.search}`; },
    }));
    const body = { botAddress: [bot.address], expiresAt: now + 600, proofSignature: "0x1234" };
    const request = await signed({ requestTarget: "/api/v1/accounts/me/bots" }, owner, body);
    const response = await app.request(`https://juicebox.center${request.input.requestTarget}`, {
      method: "POST", headers: request.input.headers, body: request.input.body,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
  });

  it("rejects unsupported account query parameters and declared GET bodies", async () => {
    const { auth } = await fixture();
    const app = new Hono();
    app.route("/api/v1", createRestAuthRouter(auth, {
      requestTarget: (context) => { const url = new URL(context.req.url); return `${url.pathname}${url.search}`; },
    }));
    const request = await signed({ method: "GET", requestTarget: "/api/v1/accounts/me?unexpected=1", bodyHash: keccak256(new Uint8Array()) });
    const response = await app.request(`https://juicebox.center${request.input.requestTarget}`, { method: "GET", headers: request.input.headers });
    expect(response.status).toBe(400);
    const get = new Request("https://juicebox.center/api/v1/accounts/me", { headers: { "content-length": "1" } });
    await expect(readSignedRequest(get, "/api/v1/accounts/me")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("charges the shared account budget before profile mutation", async () => {
    const { auth, store } = await fixture();
    const app = new Hono();
    app.route("/api/v1", createRestAuthRouter(auth, {
      requestTarget: (context) => { const url = new URL(context.req.url); return `${url.pathname}${url.search}`; },
      onAuthenticated: (principal) => {
        expect(principal.account.id).toBe(accountId);
        throw new RestAuthError("RATE_LIMITED", 429, "Account budget is spent");
      },
    }));
    const request = await signed({ method: "PATCH", requestTarget: "/api/v1/accounts/me" }, owner, { displayName: "Must not persist" });
    const response = await app.request(`https://juicebox.center${request.input.requestTarget}`, {
      method: "PATCH", headers: request.input.headers, body: request.input.body,
    });
    expect(response.status).toBe(429);
    expect((await store.getAccount(accountId))?.profile.displayName).toBe("");
  });

  it("stops waiting on a body that never arrives and cancels its stream", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const request = new Request("https://juicebox.center/api/v1/accounts/enroll", {
      method: "POST", body: stream, duplex: "half",
    } as RequestInit);
    await expect(readSignedRequest(request, "/api/v1/accounts/enroll", 1024, 10)).rejects.toMatchObject({ code: "BODY_TIMEOUT" });
    expect(cancelled).toBe(true);
  });
});
