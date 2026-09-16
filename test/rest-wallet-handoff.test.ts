import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { buildSync } from "esbuild";
import { hashTypedData, keccak256, stringToHex, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import * as handoff from '../src/rest/wallet/handoff.js';
import { validateWalletHandoffRequest, validateWalletHandoffToken, verifyWalletHandoffExchange,
  verifyWalletHandoffExchangeSignature, verifyWalletHandoffRequestSignature, walletHandoffCallback,
  walletHandoffCodeHash, walletHandoffExchangeDocument, walletHandoffFutureClockAllowanceMs,
  walletHandoffMaximumLifetimeMs, walletHandoffPkceChallenge, walletHandoffRequestDocument,
  type WalletHandoffExchangeInput, type WalletHandoffRequest } from "../src/rest/wallet/handoff.js";

const key = privateKeyToAccount(`0x${"31".repeat(32)}`), otherKey = privateKeyToAccount(`0x${"32".repeat(32)}`);
const token = (byte: number) => Buffer.alloc(32, byte).toString("base64url");
// RFC 7636 Appendix B's independent S256 vector.
const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const code = token(4), intentId = token(5);
const invalid = { status: 400, code: "WALLET_HANDOFF_INVALID" };
const badSignature = { status: 401, code: "WALLET_HANDOFF_SIGNATURE_INVALID" };
const request = (): WalletHandoffRequest => ({ version: "center-wallet-handoff-request-v1", issuer: "https://wallet.juicebox.center",
  origin: "https://beep.biz", callbackUri: "https://beep.biz/wallet/callback", audience: "https://juicebox.center",
  appGeneration: 1, requestKey: key.address, state: token(1), codeChallenge: challenge, nonce: `0x${"03".repeat(32)}`,
  issuedAtMs: 1_800_000_000_000, expiresAtMs: 1_800_000_300_000 });

describe('browser-bound handoff launch proof', () => {
  it('requires a separate app-key proof for the exact intent and request', async () => {
    const input = { request: request(), intentId };
    const document = handoff.walletHandoffLaunchDocument(input);
    const signature = await key.signTypedData(document);
    await expect(handoff.verifyWalletHandoffLaunchSignature(input, signature)).resolves.toBeUndefined();
    expect(document.primaryType).toBe('WalletHandoffLaunch');
    expect(document.message.requestDigest).toBe(hashTypedData(walletHandoffRequestDocument(input.request)));
    for (const changed of [{...input, intentId: token(6)}, {...input, request: {...input.request, callbackUri:'https://beep.biz/another'}}])
      await expect(handoff.verifyWalletHandoffLaunchSignature(changed, signature)).rejects.toMatchObject(badSignature);
    for (const wrong of [await otherKey.signTypedData(document), await key.signTypedData(walletHandoffRequestDocument(input.request)),
      await key.signTypedData(walletHandoffExchangeDocument({...input, codeHash:walletHandoffCodeHash(code)}))])
      await expect(handoff.verifyWalletHandoffLaunchSignature(input, wrong)).rejects.toMatchObject(badSignature);
  });
});
async function exchange(): Promise<WalletHandoffExchangeInput> {
  const value = { request: request(), intentId, code, verifier };
  return { ...value, signature: await key.signTypedData(walletHandoffExchangeDocument({ request: value.request,
    intentId, codeHash: walletHandoffCodeHash(code) })) };
}

describe("wallet handoff bounded public request", () => {
  it("copies and freezes the exact tuple without deciding current time or configured trust", () => {
    const value = request(), checked = validateWalletHandoffRequest(value);
    expect(checked).toEqual({ ...value, requestKey: key.address.toLowerCase() });
    expect(checked).not.toBe(value); expect(Object.isFrozen(checked)).toBe(true);
    expect(walletHandoffMaximumLifetimeMs).toBe(900_000); expect(walletHandoffFutureClockAllowanceMs).toBe(30_000);
    expect(validateWalletHandoffRequest({ ...request(), issuedAtMs: 1, expiresAtMs: 2 }).issuedAtMs).toBe(1);
    expect(validateWalletHandoffRequest({ ...request(), issuer: "https://alternate.test", audience: "https://api.test/v1" }).issuer).toBe("https://alternate.test");
  });
  it.each([
    { version: "center-wallet-handoff-request-v2" }, { accountId: "eip155:8453:owner" }, { scopes: ["read"] },
    { authorityEpoch: "1" }, { issuer: "https://wallet.juicebox.center/" }, { issuer: "https://WALLET.juicebox.center" },
    { issuer: "https://wallet.juicebox.center:443" }, { issuer: "https://wallet.juicebox.center/path" },
    { issuer: "https://wallet.juicebox.center@evil.test" }, { issuer: "http://wallet.juicebox.center" },
    { origin: "https://BEEP.biz" }, { origin: "https://beep.biz/" }, { origin: "https://beep.biz:443" },
    { origin: "https://beep.biz.evil.test" }, { callbackUri: "https://beep.biz.evil.test/wallet/callback" },
    { callbackUri: "https://beep.biz//wallet/callback" }, { callbackUri: "https://beep.biz/wallet/../callback" },
    { callbackUri: "https://beep.biz/wallet/%63allback" }, { callbackUri: "https://beep.biz/wallet/callback?state=evil" },
    { callbackUri: "https://beep.biz/wallet/callback#evil" }, { callbackUri: "https://beep.biz\\@evil.test/wallet/callback" },
    { callbackUri: `https://beep.biz/${"a".repeat(2048)}` }, { audience: "https://juicebox.center/" },
    { audience: "https://juicebox.center?x=1" }, { audience: `https://api.test/${"é".repeat(1024)}` },
    { audience: {} }, { appGeneration: 0 }, { appGeneration: -1 }, { appGeneration: 1.5 }, { appGeneration: "1" },
    { appGeneration: Number.MAX_SAFE_INTEGER + 1 }, { requestKey: "0x0" }, { requestKey: `0x${"00".repeat(20)}` },
    { requestKey: `0x${"00".repeat(19)}01` }, { nonce: "0x01" }, { nonce: `0x${"AB".repeat(32)}` },
    { nonce: `0x${"03".repeat(33)}` }, { state: `${token(1)}=` }, { codeChallenge: "plain" },
    { issuedAtMs: 0 }, { issuedAtMs: NaN }, { issuedAtMs: 1.1 }, { issuedAtMs: "1800000000000" },
    { expiresAtMs: 1_800_000_000_000 }, { expiresAtMs: 1_800_000_900_001 }, { expiresAtMs: Infinity },
    { expiresAtMs: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects malformed, aliased, injected or unbounded fields %j", change => {
    expect(() => validateWalletHandoffRequest({ ...request(), ...change })).toThrowError(expect.objectContaining(invalid));
  });
  it("accepts exact local development origins and a one millisecond lifetime", () => {
    expect(validateWalletHandoffRequest({ ...request(), issuer: "http://localhost:4000", origin: "http://127.0.0.1:3000",
      callbackUri: "http://127.0.0.1:3000/callback", audience: "http://localhost:4000", expiresAtMs: request().issuedAtMs + 1 }).origin)
      .toBe("http://127.0.0.1:3000");
  });
  it("rejects missing keys, prototypes, symbols, hidden properties, getters and proxies without invoking them", () => {
    let calls = 0;
    const { state: _missingState, ...missing } = request();
    const getter = Object.defineProperty(request(), "origin", { enumerable: true, get() { calls++; return "https://beep.biz"; } });
    const hidden = Object.defineProperty(request(), "origin", { value: "https://beep.biz", enumerable: false });
    const proxy = new Proxy(request(), { getPrototypeOf() { calls++; return Object.prototype; }, ownKeys() { calls++; return []; } });
    for (const value of [null, [], new String("request"), missing, Object.create(request()), { ...request(), [Symbol()]: 1 }, getter, hidden, proxy]) {
      expect(() => validateWalletHandoffRequest(value)).toThrowError(expect.objectContaining(invalid));
    }
    expect(calls).toBe(0);
    expect(validateWalletHandoffRequest(Object.assign(Object.create(null), request()))).toEqual(validateWalletHandoffRequest(request()));
  });
});

describe("wallet handoff token, S256 and callback boundaries", () => {
  it("matches RFC 7636 S256 and supports the full allowed unreserved alphabet and bounds", () => {
    expect(walletHandoffPkceChallenge(verifier)).toBe(challenge);
    for (const value of ["a".repeat(43), "a".repeat(128), `${"a".repeat(39)}-._~`]) {
      expect(walletHandoffPkceChallenge(value)).toBe(createHash("sha256").update(value, "ascii").digest("base64url"));
    }
  });
  it("bundles and runs the same signing and S256 helpers without Node globals in a browser context", () => {
    const built = buildSync({ entryPoints: [new URL("../src/rest/wallet/sharedHandoff.ts", import.meta.url).pathname],
      bundle: true, platform: "browser", format: "iife", globalName: "Handoff", write: false, logLevel: "silent" });
    const leaf = runInNewContext(`${built.outputFiles![0]!.text}\nHandoff;`, { atob, btoa, TextEncoder, TextDecoder, Uint8Array });
    expect(leaf.walletHandoffPkceChallenge(verifier)).toBe(challenge);
    expect(leaf.walletHandoffCodeHash(code)).toBe(walletHandoffCodeHash(code));
    const value = validateWalletHandoffRequest(request());
    expect(hashTypedData(leaf.walletHandoffRequestDocument(value))).toBe(hashTypedData(walletHandoffRequestDocument(value)));
    const input = { request: value, intentId, codeHash: walletHandoffCodeHash(code) };
    expect(hashTypedData(leaf.walletHandoffExchangeDocument(input))).toBe(hashTypedData(walletHandoffExchangeDocument(input)));
  });
  it.each(["a".repeat(42), "a".repeat(129), `${"a".repeat(42)}+`, `${"a".repeat(42)}/`, `${"a".repeat(42)}=`,
    `${"a".repeat(42)} `, `${"a".repeat(42)}\n`, `${"a".repeat(42)}é`, "a".repeat(100_000), null, {}])("rejects malformed verifier %j", value => {
    expect(() => walletHandoffPkceChallenge(value)).toThrowError(expect.objectContaining(invalid));
  });
  it("requires one canonical encoding of exactly 32 bytes, including zero pad bits", () => {
    expect(validateWalletHandoffToken(token(0))).toBe(token(0));
    const alias = `${token(0).slice(0, -1)}B`;
    expect(Buffer.from(alias, "base64url")).toEqual(Buffer.alloc(32));
    for (const value of [alias, `${token(1)}=`, token(1).slice(1), `${token(1)}A`, "+".repeat(43), "/".repeat(43), "a".repeat(100_000), {}, null]) {
      expect(() => validateWalletHandoffToken(value)).toThrowError(expect.objectContaining(invalid));
      expect(() => walletHandoffCodeHash(value)).toThrowError(expect.objectContaining(invalid));
    }
    expect(walletHandoffCodeHash(code)).toBe(`0x${createHash("sha256").update("center-wallet-handoff-code-v1\0", "ascii").update(code, "ascii").digest("hex")}`);
    expect(walletHandoffCodeHash(code)).not.toBe(`0x${createHash("sha256").update(code).digest("hex")}`);
  });
  it("returns only the exact callback with code, state and issuer response parameters", () => {
    const value = walletHandoffCallback({ request: request(), code }), url = new URL(value);
    expect(value.split("?")[0]).toBe(request().callbackUri);
    expect([...url.searchParams]).toEqual([["code", code], ["state", request().state], ["iss", request().issuer]]);
    expect(url.hash).toBe(""); expect(url.username).toBe("");
    expect(() => walletHandoffCallback({ request: { ...request(), callbackUri: `${request().callbackUri}?code=old` }, code }))
      .toThrowError(expect.objectContaining(invalid));
    expect(() => walletHandoffCallback({ request: request(), code: `${code}&state=bad` })).toThrowError(expect.objectContaining(invalid));
  });
});

describe("wallet handoff request-key proofs and stable exchange receipts", () => {
  it("binds every request field in the dedicated Base and issuer EIP-712 domain", async () => {
    const value = request(), document = walletHandoffRequestDocument(value);
    expect(document.domain).toEqual({ name: "Juicebox Center Wallet Handoff", version: "1", chainId: 8453,
      salt: keccak256(stringToHex(value.issuer)) });
    expect(document.primaryType).toBe("WalletHandoffRequest");
    expect(document.types.WalletHandoffRequest.map(field => field.name)).toEqual(Object.keys(value));
    expect(document.message).toEqual({ ...value, requestKey: key.address.toLowerCase(), state: toHex(Buffer.alloc(32, 1)),
      codeChallenge: toHex(Buffer.from(challenge, "base64url")), appGeneration: 1n, issuedAtMs: BigInt(value.issuedAtMs), expiresAtMs: BigInt(value.expiresAtMs) });
    await expect(verifyWalletHandoffRequestSignature(value, await key.signTypedData(document))).resolves.toBeUndefined();
    await expect(verifyWalletHandoffRequestSignature(value, await otherKey.signTypedData(document))).rejects.toMatchObject(badSignature);
  });
  it("cannot mutate returned type schemas to change later server signature verification", () => {
    const value = request(), before = hashTypedData(walletHandoffRequestDocument(value));
    const document = walletHandoffRequestDocument(value);
    expect(Reflect.set(document.types.WalletHandoffRequest[0], "name", "injected")).toBe(false);
    expect(Reflect.set(document.types.WalletHandoffRequest, "0", { name: "injected", type: "string" })).toBe(false);
    expect(Reflect.set(document.types, "WalletHandoffRequest", [])).toBe(false);
    const exchangeDocument = walletHandoffExchangeDocument({ request: value, intentId, codeHash: walletHandoffCodeHash(code) });
    expect(Reflect.set(exchangeDocument.types.WalletHandoffExchange.at(-1)!, "name", "injected")).toBe(false);
    expect(hashTypedData(walletHandoffRequestDocument(value))).toBe(before);
  });
  it.each([
    { issuer: "https://other-wallet.test" }, { origin: "https://juicebox.money", callbackUri: "https://juicebox.money/wallet/callback" },
    { callbackUri: "https://beep.biz/other-callback" }, { audience: "https://api.other.test" }, { appGeneration: 2 },
    { requestKey: otherKey.address }, { state: token(2) }, { codeChallenge: token(2) }, { nonce: `0x${"04".repeat(32)}` as Hex },
    { issuedAtMs: request().issuedAtMs + 1 }, { expiresAtMs: request().expiresAtMs - 1 },
  ])("rejects request and exchange reuse after tuple mutation %j", async change => {
    const value = request(), signature = await key.signTypedData(walletHandoffRequestDocument(value));
    await expect(verifyWalletHandoffRequestSignature({ ...value, ...change }, signature)).rejects.toMatchObject(badSignature);
    const input = await exchange(), changed = { request: { ...input.request, ...change }, intentId, codeHash: walletHandoffCodeHash(code) };
    await expect(verifyWalletHandoffExchangeSignature(changed, input.signature)).rejects.toMatchObject(badSignature);
  });
  it("separates request and exchange purpose, chain, domain name, version and issuer salt", async () => {
    const value = request(), requestDocument = walletHandoffRequestDocument(value);
    const input = { request: value, intentId, codeHash: walletHandoffCodeHash(code) }, exchangeDocument = walletHandoffExchangeDocument(input);
    expect(exchangeDocument.primaryType).toBe("WalletHandoffExchange");
    expect(exchangeDocument.message.intentId).toBe(toHex(Buffer.alloc(32, 5)));
    const requestSignature = await key.signTypedData(requestDocument), exchangeSignature = await key.signTypedData(exchangeDocument);
    await expect(verifyWalletHandoffExchangeSignature(input, requestSignature)).rejects.toMatchObject(badSignature);
    await expect(verifyWalletHandoffRequestSignature(value, exchangeSignature)).rejects.toMatchObject(badSignature);
    for (const change of [{ chainId: 1 }, { name: "Juicebox Center REST" }, { version: "2" }, { salt: `0x${"01".repeat(32)}` as Hex }]) {
      const signature = await key.signTypedData({ ...requestDocument, domain: { ...requestDocument.domain, ...change } });
      await expect(verifyWalletHandoffRequestSignature(value, signature)).rejects.toMatchObject(badSignature);
    }
  });
  it("rejects noncanonical ECDSA signatures and high-s twins", async () => {
    const value = request(), signature = await key.signTypedData(walletHandoffRequestDocument(value));
    const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const highS = `${signature.slice(0, 66)}${(order - BigInt(`0x${signature.slice(66, 130)}`)).toString(16).padStart(64, "0")}${signature.endsWith("1b") ? "1c" : "1b"}`;
    for (const malformed of ["0x", "0x00", `${signature.slice(0, -2)}00`, `${signature.slice(0, -2)}01`, highS,
      `${signature.slice(0, 66)}${"00".repeat(32)}1b`, `0x${"00".repeat(32)}${signature.slice(66)}`, `0x${"11".repeat(100_000)}`]) {
      await expect(verifyWalletHandoffRequestSignature(value, malformed as Hex)).rejects.toMatchObject(badSignature);
    }
  });
  it("verifies the matching PKCE secret and code proof, returning only frozen semantic receipt data", async () => {
    const input = await exchange(), result = await verifyWalletHandoffExchange(input);
    expect(result).toEqual({ request: validateWalletHandoffRequest(input.request), intentId, codeHash: walletHandoffCodeHash(code),
      exchangeDigest: hashTypedData(walletHandoffExchangeDocument({ request: input.request, intentId, codeHash: walletHandoffCodeHash(code) })) });
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.request)).toBe(true);
    expect(result).not.toHaveProperty("signature"); expect(result).not.toHaveProperty("verifier"); expect(result).not.toHaveProperty("code");
    expect(await verifyWalletHandoffExchange({ ...input, signature: `0x${input.signature.slice(2).toUpperCase()}` })).toEqual(result);
    await expect(verifyWalletHandoffExchange({ ...input, verifier: "x".repeat(43) })).rejects.toMatchObject(invalid);
    // A syntactically valid 32-byte challenge still cannot select the plain method.
    const plainRequest = { ...input.request, codeChallenge: verifier };
    const plainSignature = await key.signTypedData(walletHandoffExchangeDocument({ request: plainRequest, intentId, codeHash: walletHandoffCodeHash(code) }));
    await expect(verifyWalletHandoffExchange({ ...input, request: plainRequest, signature: plainSignature })).rejects.toMatchObject(invalid);
    await expect(verifyWalletHandoffExchange({ ...input, code: token(6) })).rejects.toMatchObject(badSignature);
    await expect(verifyWalletHandoffExchange({ ...input, intentId: token(6) })).rejects.toMatchObject(badSignature);
  });
  it("does not introduce an exchange clock or nonce that prevents exact lost-response recovery", async () => {
    const value = { ...request(), issuedAtMs: 1, expiresAtMs: 2 }, codeHash = walletHandoffCodeHash(code);
    const signature = await key.signTypedData(walletHandoffExchangeDocument({ request: value, intentId, codeHash }));
    const input = { request: value, intentId, code, verifier, signature };
    expect(await verifyWalletHandoffExchange(input)).toEqual(await verifyWalletHandoffExchange(input));
    await expect(verifyWalletHandoffExchange({ ...input, exchangeNonce: token(1) })).rejects.toMatchObject(invalid);
    await expect(verifyWalletHandoffExchange({ ...input, expiresAtMs: Date.now() })).rejects.toMatchObject(invalid);
  });
  it("copies request and exchange fields before the first asynchronous signature operation", async () => {
    const input = await exchange(), expected = validateWalletHandoffRequest(input.request);
    const pending = verifyWalletHandoffExchange(input);
    Object.assign(input.request, { issuer: "https://attacker.test", state: token(9), requestKey: otherKey.address });
    Object.assign(input, { intentId: token(9), code: token(9), verifier: "x".repeat(43), signature: "0x" });
    expect((await pending).request).toEqual(expected);
  });
  it("rejects executable nested exchange data and authority injection without evaluating them", async () => {
    const input = await exchange(); let calls = 0;
    const getter = Object.defineProperty({ ...input }, "signature", { enumerable: true, get() { calls++; return input.signature; } });
    for (const value of [getter, { ...input, request: new Proxy(input.request, { ownKeys() { calls++; return []; } }) },
      new Proxy(input, { get() { calls++; return null; } }), { ...input, accountId: "owner" }, { ...input, scopes: ["read"] },
      { ...input, state: token(9) }, { ...input, codeChallengeMethod: "plain" }, { ...input, signature: {} },
      { ...input, intentId: `${intentId}=` }, { ...input, code: `${code}=` }]) {
      await expect(verifyWalletHandoffExchange(value)).rejects.toThrow();
    }
    expect(calls).toBe(0);
  });
});
