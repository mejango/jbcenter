import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { decodeAbiParameters, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  deriveWalletAuthenticationChallenge,
  verifyWalletAssertion,
  WalletAssertionError,
  type WalletAssertion,
  type WalletAssertionExpectation,
} from "../src/rest/wallet/webauthn.js";

const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = keys.publicKey.export({ format: "jwk" });
const hex = (bytes: Uint8Array): Hex => `0x${Buffer.from(bytes).toString("hex")}`;
const bytes32 = (byte: string): Hex => `0x${byte.repeat(32)}`;
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest();
const userHandle = Buffer.from("opaque-user-handle").toString("base64url");
const credentialId = Buffer.from("opaque-credential-id").toString("base64url");
const context = {
  purpose: "login" as const,
  accountId: "eip155:8453:0x1111111111111111111111111111111111111111",
  bindingDigest: bytes32("11"),
  nonce: bytes32("22"),
  expiresAt: 1_800_000_000,
};
const expected: WalletAssertionExpectation = {
  purpose: "login",
  challenge: bytes32("33"),
  rpId: "wallet.juicebox.center",
  origin: "https://wallet.juicebox.center",
  credential: {
    id: credentialId,
    publicKey: { x: hex(Buffer.from(jwk.x!, "base64url")), y: hex(Buffer.from(jwk.y!, "base64url")) },
    userHandle,
    backupEligible: true,
  },
  requireUserHandle: true,
};
function makeAssertion(options: {
  json?: string;
  flags?: number;
  counter?: number;
  rpId?: string;
  challenge?: Hex;
  authenticatorData?: Uint8Array;
} = {}): WalletAssertion {
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(options.counter ?? 0);
  const authenticatorData = options.authenticatorData ?? Buffer.concat([
    digest(options.rpId ?? expected.rpId), Buffer.from([options.flags ?? 0x1d]),
    counter,
  ]);
  const clientDataJSON = Buffer.from(options.json ?? JSON.stringify({
    type: "webauthn.get",
    challenge: Buffer.from((options.challenge ?? expected.challenge).slice(2), "hex").toString("base64url"),
    origin: expected.origin,
    crossOrigin: false,
  }));
  return {
    credentialId, userHandle, authenticatorData, clientDataJSON,
    signature: sign("sha256", Buffer.concat([authenticatorData, digest(clientDataJSON)]), keys.privateKey),
  };
}
const clientJson = () => Buffer.from(makeAssertion().clientDataJSON).toString();

describe("Center WebAuthn assertion boundary", () => {
  it.each(["passkey-assertion", "passkey-assertion-max"])("reproduces the committed producer-to-Solidity %s fixture", (name) => {
    const fixture = JSON.parse(readFileSync(new URL(`./fixtures/wallet/${name}.json`, import.meta.url), "utf8"));
    const bytes = (value: string) => Buffer.from(value.slice(2), "hex");
    const result = verifyWalletAssertion({
      credentialId: fixture.credentialId, userHandle: fixture.userHandle,
      authenticatorData: bytes(fixture.authenticatorData), clientDataJSON: bytes(fixture.clientDataJSON),
      signature: bytes(fixture.derSignature),
    }, {
      purpose: "payment", challenge: fixture.challenge, rpId: fixture.rpId, origin: fixture.origin,
      credential: { id: fixture.credentialId, userHandle: fixture.userHandle, publicKey: fixture.publicKey, backupEligible: true },
      requireUserHandle: true,
    });
    expect(result.contractSignature).toBe(fixture.contractSignature);
    expect(result.clientDataFields).toBe(fixture.clientDataFields);
    expect(result.r).toBe(BigInt(fixture.r));
    expect(result.s).toBe(BigInt(fixture.s));
  });

  it("verifies a real P256 assertion and encodes the exact Safe signer tuple", () => {
    const assertion = makeAssertion();
    const verified = verifyWalletAssertion(assertion, expected);
    expect(verified).toMatchObject({ credentialId, userHandle, signCount: 0, backupEligible: true, backedUp: true });
    const decoded = decodeAbiParameters([
      { type: "bytes" }, { type: "string" }, { type: "uint256" }, { type: "uint256" },
    ], verified.contractSignature);
    expect(decoded).toEqual([hex(assertion.authenticatorData), verified.clientDataFields, verified.r, verified.s]);
    const reconstructed = `{"type":"webauthn.get","challenge":"${Buffer.from(expected.challenge.slice(2), "hex").toString("base64url")}",${verified.clientDataFields}}`;
    expect(Buffer.from(reconstructed)).toEqual(Buffer.from(assertion.clientDataJSON));
  });

  it("keeps signed suffix whitespace, escaping and browser sentinel bytes unchanged", () => {
    const json = clientJson().slice(0, -1).replace('"origin":', '"origin" : ') + ', "other_keys_can_be_added_here":"do\\u0020not compare clientDataJSON"}';
    const verified = verifyWalletAssertion(makeAssertion({ json }), expected);
    expect(verified.clientDataFields).toContain('"origin" :');
    expect(verified.clientDataFields).toContain('do\\u0020not compare');
  });

  it("bounds the largest supported client-data signature for gas estimation", () => {
    const emptyExtra = clientJson().slice(0, -1) + ',"extra":""}';
    const json = emptyExtra.replace('"extra":""', `"extra":"${"x".repeat(2048 - Buffer.byteLength(emptyExtra))}"`);
    expect(Buffer.byteLength(json)).toBe(2048);
    const verified = verifyWalletAssertion(makeAssertion({ json }), expected);
    expect(Buffer.byteLength(verified.clientDataFields)).toBe(1966);
    expect((verified.contractSignature.length - 2) / 2).toBe(2240);
    expect(() => verifyWalletAssertion(makeAssertion({ json: json.slice(0, -1) + " }" }), expected)).toThrow(WalletAssertionError);
  });

  it("accepts omitted crossOrigin with its standard false default", () => {
    const json = clientJson().replace(',"crossOrigin":false', "");
    expect(verifyWalletAssertion(makeAssertion({ json }), expected).credentialId).toBe(credentialId);
  });

  it.each([0, 1, 19, 0xffffffff])("accepts synced passkey counter %s without imposing a monotonic counter policy", (counter) => {
    expect(verifyWalletAssertion(makeAssertion({ counter }), expected).signCount).toBe(counter);
  });

  it("allows omitted userHandle only for an already selected credential", () => {
    const assertion = { ...makeAssertion(), userHandle: null };
    expect(() => verifyWalletAssertion(assertion, expected)).toThrow(WalletAssertionError);
    expect(verifyWalletAssertion(assertion, { ...expected, requireUserHandle: false }).userHandle).toBeNull();
  });

  it.each([
    ["origin", () => clientJson().replace(expected.origin, "https://evil.example")],
    ["origin prefix", () => clientJson().replace(expected.origin, `${expected.origin}.evil.example`)],
    ["wrong type", () => clientJson().replace("webauthn.get", "webauthn.create")],
    ["crossOrigin", () => clientJson().replace('"crossOrigin":false', '"crossOrigin":true')],
    ["string crossOrigin", () => clientJson().replace('"crossOrigin":false', '"crossOrigin":"false"')],
    ["null crossOrigin", () => clientJson().replace('"crossOrigin":false', '"crossOrigin":null')],
    ["topOrigin", () => clientJson().slice(0, -1) + ',"topOrigin":"https://trusted.example"}'],
    ["duplicate origin", () => clientJson().slice(0, -1) + `,"origin":"${expected.origin}"}`],
    ["escaped duplicate origin", () => clientJson().slice(0, -1) + `,"ori\\u0067in":"${expected.origin}"}`],
    ["duplicate type", () => clientJson().slice(0, -1) + ',"type":"webauthn.get"}'],
    ["duplicate crossOrigin", () => clientJson().slice(0, -1) + ',"crossOrigin":false}'],
    ["unsupported nested field", () => clientJson().slice(0, -1) + ',"extra":{"origin":"anything"}}'],
    ["unsupported prefix whitespace", () => clientJson().replace('{"type"', '{ "type"')],
    ["trailing comma", () => clientJson().slice(0, -1) + ',}'],
    ["JSON array", () => "[" + clientJson() + "]"],
  ])("rejects a real signed assertion with %s", (_label, json) => {
    expect(() => verifyWalletAssertion(makeAssertion({ json: json() }), expected)).toThrow(WalletAssertionError);
  });

  it.each([0x1c, 0x19, 0x15, 0x3d, 0x1f, 0x5d, 0x9d])("rejects invalid or unsupported authenticator flags 0x%s", (flags) => {
    expect(() => verifyWalletAssertion(makeAssertion({ flags }), expected)).toThrow(WalletAssertionError);
  });

  it("rejects credential backup eligibility changing after registration", () => {
    expect(() => verifyWalletAssertion(makeAssertion({ flags: 0x05 }), expected)).toThrow(WalletAssertionError);
    expect(verifyWalletAssertion(makeAssertion({ flags: 0x0d }), expected).backedUp).toBe(false);
  });

  it("rejects the wrong RP hash, challenge, credential id, or user handle", () => {
    for (const assertion of [
      makeAssertion({ rpId: "juicebox.center" }),
      makeAssertion({ challenge: bytes32("44") }),
      { ...makeAssertion(), credentialId: Buffer.from("wrong-id").toString("base64url") },
      { ...makeAssertion(), userHandle: Buffer.from("wrong-user").toString("base64url") },
    ]) expect(() => verifyWalletAssertion(assertion, expected)).toThrow(WalletAssertionError);
  });

  it("rejects a valid login assertion as exact payment approval", () => {
    const loginChallenge = deriveWalletAuthenticationChallenge(context);
    const assertion = makeAssertion({ challenge: loginChallenge });
    expect(verifyWalletAssertion(assertion, { ...expected, challenge: loginChallenge }).credentialId).toBe(credentialId);
    expect(() => verifyWalletAssertion(assertion, { ...expected, purpose: "payment", challenge: bytes32("44") })).toThrow(WalletAssertionError);
  });

  it("verifies exact signed bytes, public key and signature", () => {
    const assertion = makeAssertion();
    const signature = Buffer.from(assertion.signature);
    signature[signature.length - 1]! ^= 1;
    const changed = Buffer.from(assertion.authenticatorData);
    changed[36] = 1;
    for (const invalid of [{ ...assertion, signature }, { ...assertion, authenticatorData: changed }]) {
      expect(() => verifyWalletAssertion(invalid, expected)).toThrow(WalletAssertionError);
    }
    const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "jwk" });
    expect(() => verifyWalletAssertion(assertion, { ...expected, credential: {
      ...expected.credential,
      publicKey: { x: hex(Buffer.from(other.x!, "base64url")), y: hex(Buffer.from(other.y!, "base64url")) },
    } })).toThrow(WalletAssertionError);
  });

  it("preserves both authenticator high-S and low-S signatures accepted by the pinned Safe signer", () => {
    const assertion = makeAssertion();
    const compact = sign("sha256", Buffer.concat([assertion.authenticatorData, digest(assertion.clientDataJSON)]), {
      key: keys.privateKey, dsaEncoding: "ieee-p1363",
    });
    const r = BigInt(hex(compact.subarray(0, 32)));
    const s = BigInt(hex(compact.subarray(32)));
    const order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
    const derInteger = (value: bigint) => {
      const encoded = value.toString(16);
      const raw = Buffer.from(encoded.length % 2 ? "0" + encoded : encoded, "hex");
      const positive = raw[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), raw]) : raw;
      return Buffer.concat([Buffer.from([2, positive.length]), positive]);
    };
    for (const chosenS of [s, order - s]) {
      const body = Buffer.concat([derInteger(r), derInteger(chosenS)]);
      const signature = Buffer.concat([Buffer.from([0x30, body.length]), body]);
      expect(verifyWalletAssertion({ ...assertion, signature }, expected)).toMatchObject({ r, s: chosenS });
    }
  });

  it("accepts a nonbackup credential only against its registered backup eligibility", () => {
    expect(verifyWalletAssertion(makeAssertion({ flags: 0x05 }), {
      ...expected, credential: { ...expected.credential, backupEligible: false },
    })).toMatchObject({ backupEligible: false, backedUp: false });
  });

  it("rejects malformed, noncanonical, oversized and unsupported wire data", () => {
    const assertion = makeAssertion();
    for (const invalid of [
      { ...assertion, clientDataJSON: Buffer.alloc(2049, 32) },
      { ...assertion, clientDataJSON: Buffer.from([0xff]) },
      { ...assertion, clientDataJSON: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), assertion.clientDataJSON]) },
      { ...assertion, authenticatorData: assertion.authenticatorData.slice(0, 36) },
      { ...assertion, authenticatorData: Buffer.concat([assertion.authenticatorData, Buffer.from([0])]) },
      { ...assertion, signature: Buffer.alloc(73) },
      { ...assertion, signature: Buffer.from("3006020100020100", "hex") },
      { ...assertion, signature: Buffer.from("300702020001020101", "hex") },
      { ...assertion, signature: Buffer.from("3006020180020101", "hex") },
      { ...assertion, signature: Buffer.concat([assertion.signature, Buffer.from([0])]) },
      { ...assertion, credentialId: assertion.credentialId + "=" },
      { ...assertion, credentialId: "A".repeat(1367) },
      { ...assertion, userHandle: "A".repeat(87) },
    ]) expect(() => verifyWalletAssertion(invalid, expected)).toThrow(WalletAssertionError);
  });

  it("fails closed with a bounded generic error for malformed runtime input", () => {
    const assertion = makeAssertion();
    for (const malformed of [null, {}, { ...assertion, signature: "secret-bearer" }, { ...assertion, userHandle: undefined }]) {
      expect(() => verifyWalletAssertion(malformed as WalletAssertion, expected)).toThrow(WalletAssertionError);
    }
    for (const publicKey of [null, { x: bytes32("00"), y: bytes32("00") }, { x: "secret-bearer", y: bytes32("00") }]) {
      expect(() => verifyWalletAssertion(assertion, {
        ...expected, credential: { ...expected.credential, publicKey: publicKey as typeof expected.credential.publicKey },
      })).toThrow("Invalid wallet signature or public key");
    }
  });

  it.each([
    { rpId: "juicebox.center" },
    { origin: "https://wallet.juicebox.center/" },
    { origin: "http://wallet.juicebox.center" },
    { origin: "https://wallet.juicebox.center:443" },
    { challenge: "0x1234" as Hex },
  ])("rejects a mismatched or malformed trusted configuration %j", (patch) => {
    expect(() => verifyWalletAssertion(makeAssertion(), { ...expected, ...patch })).toThrow(WalletAssertionError);
  });
});

describe("Center nonspending challenge derivation", () => {
  it("binds purpose, account, exact action digest, nonce and expiry with a fixed domain", () => {
    const challenge = deriveWalletAuthenticationChallenge(context);
    expect(challenge).toMatch(/^0x[0-9a-f]{64}$/);
    expect(deriveWalletAuthenticationChallenge({ ...context })).toBe(challenge);
    for (const patch of [
      { purpose: "registration" as const }, { purpose: "session" as const },
      { accountId: context.accountId.replace(/1/g, "2") },
      { bindingDigest: bytes32("44") }, { nonce: bytes32("55") }, { expiresAt: context.expiresAt + 1 },
    ]) expect(deriveWalletAuthenticationChallenge({ ...context, ...patch })).not.toBe(challenge);
  });

  it("rejects malformed context and cannot derive transaction challenges", () => {
    for (const patch of [
      { accountId: "" }, { accountId: "x\n" }, { accountId: "x".repeat(257) },
      { bindingDigest: "0x1234" as Hex }, { nonce: "0x1234" as Hex },
      { expiresAt: 0 }, { expiresAt: 1.2 }, { expiresAt: Number.NaN },
      { purpose: "payment" as "login" },
    ]) expect(() => deriveWalletAuthenticationChallenge({ ...context, ...patch })).toThrow(WalletAssertionError);
  });
});
