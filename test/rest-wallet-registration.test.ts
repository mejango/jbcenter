import { createHash, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { encode, Tag } from "cbor2";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  parseWalletRegistration, WalletRegistrationError,
  type WalletRegistrationExpectation, type WalletRegistrationResponse,
} from "../src/rest/wallet/registration.js";
import { deriveWalletAuthenticationChallenge, verifyWalletAssertion } from "../src/rest/wallet/webauthn.js";

const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = keys.publicKey.export({ format: "jwk" });
const rawId = Buffer.from("candidate-credential-id");
const credentialId = rawId.toString("base64url");
const x = Uint8Array.from(Buffer.from(jwk.x!, "base64url"));
const y = Uint8Array.from(Buffer.from(jwk.y!, "base64url"));
const hex = (bytes: Uint8Array): Hex => `0x${Buffer.from(bytes).toString("hex")}`;
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest();
const aaguid = Buffer.from("01020304050607080102030405060708", "hex");
const expected: WalletRegistrationExpectation = {
  challenge: `0x${"42".repeat(32)}`,
  rpId: "wallet.juicebox.center", origin: "https://wallet.juicebox.center",
  userHandle: Buffer.from("stable-server-user-handle").toString("base64url"),
};
const coseKey = () => new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, x], [-3, y]]);
function makeResponse(options: {
  json?: string; flags?: number; rpId?: string; counter?: number;
  id?: Uint8Array; cose?: Uint8Array; authData?: Uint8Array;
  fmt?: unknown; attStmt?: unknown; attestation?: Uint8Array;
} = {}): WalletRegistrationResponse {
  const id = options.id ?? rawId;
  const length = Buffer.alloc(2); length.writeUInt16BE(id.length);
  const counter = Buffer.alloc(4); counter.writeUInt32BE(options.counter ?? 0);
  const authData = options.authData ?? Buffer.concat([
    sha256(options.rpId ?? expected.rpId), Buffer.from([options.flags ?? 0x5d]), counter,
    aaguid, length, id, options.cose ?? encode(coseKey()),
  ]);
  return {
    type: "public-key", credentialId: Buffer.from(id).toString("base64url"), rawId: id,
    clientDataJSON: Buffer.from(options.json ?? JSON.stringify({
      type: "webauthn.create", challenge: Buffer.from(expected.challenge.slice(2), "hex").toString("base64url"),
      origin: expected.origin, crossOrigin: false,
    })),
    attestationObject: options.attestation ?? encode(new Map<string, unknown>([
      ["fmt", options.fmt ?? "none"], ["attStmt", options.attStmt ?? new Map()], ["authData", Uint8Array.from(authData)],
    ])),
  };
}
const clientJSON = () => Buffer.from(makeResponse().clientDataJSON).toString();

describe("unproven wallet registration candidate", () => {
  it("parses none attestation with a genuine P256 public key without claiming possession", () => {
    const result = parseWalletRegistration(makeResponse(), expected);
    expect(result).toEqual({
      credentialId, userHandle: expected.userHandle, publicKey: { x: hex(x), y: hex(y) },
      signCount: 0, backupEligible: true, backedUp: true, aaguid: hex(aaguid),
    });
    expect(result).not.toHaveProperty("verified");
    expect(result).not.toHaveProperty("active");
  });

  it("accepts the actual Chromium virtual-authenticator producer and matches its SPKI key", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/wallet/registration-chromium.json", import.meta.url), "utf8"));
    const decode = (value: string) => Buffer.from(value, "base64url");
    const result = parseWalletRegistration({
      ...fixture.registration, rawId: decode(fixture.registration.rawId),
      clientDataJSON: decode(fixture.registration.clientDataJSON), attestationObject: decode(fixture.registration.attestationObject),
    }, { challenge: hex(decode(fixture.registrationChallenge)), rpId: fixture.rpId, origin: fixture.origin, userHandle: fixture.userHandle });
    const spki = createPublicKey({ key: decode(fixture.registration.publicKey), format: "der", type: "spki" }).export({ format: "jwk" });
    expect(result.publicKey).toEqual({ x: hex(decode(spki.x!)), y: hex(decode(spki.y!)) });
    expect(result.publicKey).toEqual(fixture.publicKey);
    expect(result.credentialId).toBe(fixture.registration.credentialId);
    expect(result.aaguid).not.toBe(`0x${"00".repeat(16)}`);
    const possession = verifyWalletAssertion({
      credentialId: fixture.assertion.credentialId, userHandle: fixture.assertion.userHandle,
      authenticatorData: decode(fixture.assertion.authenticatorData),
      clientDataJSON: decode(fixture.assertion.clientDataJSON), signature: decode(fixture.assertion.signature),
    }, {
      purpose: "registration", challenge: hex(decode(fixture.possessionChallenge)),
      rpId: fixture.rpId, origin: fixture.origin, requireUserHandle: true,
      credential: { id: result.credentialId, userHandle: result.userHandle, publicKey: result.publicKey, backupEligible: result.backupEligible },
    });
    expect(possession.credentialId).toBe(result.credentialId);
  });

  it("requires a separate genuine possession signature bound to the pending candidate and fixed initializer", () => {
    const result = parseWalletRegistration(makeResponse(), expected);
    const initializerDigest = `0x${"11".repeat(32)}` as Hex;
    const context = {
      purpose: "registration" as const, accountId: "enrollment:pending-id",
      bindingDigest: hex(sha256(JSON.stringify([result.credentialId, result.publicKey, result.userHandle, initializerDigest]))),
      nonce: `0x${"22".repeat(32)}` as Hex,
      expiresAt: 1_800_000_000, // Existing derivation helper uses seconds; no database timestamp reinterpretation here.
    };
    const challenge = deriveWalletAuthenticationChallenge(context);
    const authenticatorData = Buffer.concat([sha256(expected.rpId), Buffer.from([0x1d, 0, 0, 0, 0])]);
    const clientDataJSON = Buffer.from(JSON.stringify({
      type: "webauthn.get", challenge: Buffer.from(challenge.slice(2), "hex").toString("base64url"), origin: expected.origin,
    }));
    const payload = Buffer.concat([authenticatorData, sha256(clientDataJSON)]);
    const assertion = { credentialId, userHandle: expected.userHandle, authenticatorData, clientDataJSON, signature: sign("sha256", payload, keys.privateKey) };
    const assertionExpected = {
      purpose: "registration" as const, challenge, rpId: expected.rpId, origin: expected.origin,
      credential: { id: result.credentialId, userHandle: result.userHandle, publicKey: result.publicKey, backupEligible: result.backupEligible },
      requireUserHandle: true,
    };
    expect(verifyWalletAssertion(assertion, assertionExpected).credentialId).toBe(credentialId);
    // An assertion made inside a frame names its top origin: accepted only for the one origin the
    // expectation admits, and never when no framer is admitted; a top-level assertion never names one.
    const framed = (data: Record<string, unknown>) => {
      const json = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: Buffer.from(challenge.slice(2), "hex").toString("base64url"), origin: expected.origin, ...data }));
      return { ...assertion, clientDataJSON: json, signature: sign("sha256", Buffer.concat([authenticatorData, sha256(json)]), keys.privateKey) };
    };
    const admitted = { ...assertionExpected, topOrigin: "https://beep.example" };
    expect(verifyWalletAssertion(framed({ crossOrigin: true, topOrigin: "https://beep.example" }), admitted).credentialId).toBe(credentialId);
    expect(verifyWalletAssertion(framed({ crossOrigin: true }), admitted).credentialId).toBe(credentialId);
    expect(verifyWalletAssertion(framed({ crossOrigin: false }), admitted).credentialId).toBe(credentialId);
    for (const [data, against] of [
      [{ crossOrigin: true, topOrigin: "https://beep.example" }, assertionExpected], [{ crossOrigin: true }, assertionExpected],
      [{ crossOrigin: true, topOrigin: "https://evil.example" }, admitted], [{ crossOrigin: false, topOrigin: "https://beep.example" }, admitted],
      [{ topOrigin: "https://beep.example" }, admitted], [{ crossOrigin: "true" }, admitted],
    ] as const) expect(() => verifyWalletAssertion(framed(data), against)).toThrow();
    const otherPrivateKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
    expect(() => verifyWalletAssertion({ ...assertion, signature: sign("sha256", payload, otherPrivateKey) }, assertionExpected)).toThrow();
    const changedInitializer = deriveWalletAuthenticationChallenge({ ...context, bindingDigest: hex(sha256("different initializer")) });
    expect(() => verifyWalletAssertion(assertion, { ...assertionExpected, challenge: changedInitializer })).toThrow();
    expect(() => verifyWalletAssertion({ ...assertion, clientDataJSON: makeResponse().clientDataJSON }, assertionExpected)).toThrow();
  });

  it("takes user handle exclusively from the trusted creation intent, not response fields", () => {
    const response = { ...makeResponse(), userHandle: Buffer.from("attacker-handle").toString("base64url") };
    expect(parseWalletRegistration(response, expected).userHandle).toBe(expected.userHandle);
  });

  it("accepts nonzero AAGUID, zero/max counter, and backup-state transitions without hardware claims", () => {
    expect(parseWalletRegistration(makeResponse({ counter: 0xffffffff, flags: 0x4d }), expected)).toMatchObject({
      signCount: 0xffffffff, backupEligible: true, backedUp: false, aaguid: hex(aaguid),
    });
    expect(parseWalletRegistration(makeResponse({ flags: 0x45 }), expected)).toMatchObject({ backupEligible: false, backedUp: false });
  });

  it("preserves valid CBOR map ordering and integer-width variants", () => {
    const reordered = new Map([...coseKey()].reverse());
    expect(parseWalletRegistration(makeResponse({ cose: encode(reordered) }), expected).publicKey).toEqual({ x: hex(x), y: hex(y) });
    const encoded = Buffer.from(encode(coseKey()));
    const wideKey = Buffer.concat([encoded.subarray(0, 1), Buffer.from([0x18, 0x01]), encoded.subarray(2)]);
    expect(parseWalletRegistration(makeResponse({ cose: wideKey }), expected).publicKey).toEqual({ x: hex(x), y: hex(y) });
  });

  it.each([
    ["wrong type", () => clientJSON().replace("webauthn.create", "webauthn.get")],
    ["wrong challenge", () => clientJSON().replace(Buffer.from(expected.challenge.slice(2), "hex").toString("base64url"), "A".repeat(43))],
    ["wrong origin", () => clientJSON().replace(expected.origin, "https://evil.example")],
    ["origin lookalike", () => clientJSON().replace(expected.origin, expected.origin + ".evil.example")],
    ["crossOrigin", () => clientJSON().replace('"crossOrigin":false', '"crossOrigin":true')],
    ["crossOrigin wrong type", () => clientJSON().replace('"crossOrigin":false', '"crossOrigin":"false"')],
    ["topOrigin", () => clientJSON().slice(0, -1) + ',"topOrigin":"https://elsewhere.example"}'],
    ["duplicate origin", () => clientJSON().slice(0, -1) + `,"origin":"${expected.origin}"}`],
    ["escaped duplicate", () => clientJSON().slice(0, -1) + `,"ori\\u0067in":"${expected.origin}"}`],
    ["nested unsupported field", () => clientJSON().slice(0, -1) + ',"extra":{}}'],
  ])("rejects client data with %s", (_label, json) => {
    expect(() => parseWalletRegistration(makeResponse({ json: json() }), expected)).toThrow(WalletRegistrationError);
  });

  it("accepts absent crossOrigin and supported flat browser fields", () => {
    const json = clientJSON().replace(',"crossOrigin":false', ',"other_keys_can_be_added_here":"browser sentinel"');
    expect(parseWalletRegistration(makeResponse({ json }), expected).credentialId).toBe(credentialId);
  });

  it.each([0x1d, 0x5c, 0x59, 0x55, 0x5f, 0x7d, 0xdd])("rejects missing or unsupported registration flags %s", (flags) => {
    expect(() => parseWalletRegistration(makeResponse({ flags }), expected)).toThrow(WalletRegistrationError);
  });

  it.each([
    [1, 3], [3, -8], [-1, 2], [-2, new Uint8Array(31)], [-3, true], [-2, new Uint8Array(33)],
  ])("rejects unsupported COSE field %j", (label, value) => {
    const key = coseKey(); key.set(label as number, value);
    expect(() => parseWalletRegistration(makeResponse({ cose: encode(key) }), expected)).toThrow(WalletRegistrationError);
  });

  it("rejects an off-curve public key through Node crypto", () => {
    const key = coseKey(); key.set(-2, new Uint8Array(32)); key.set(-3, new Uint8Array(32));
    expect(() => parseWalletRegistration(makeResponse({ cose: encode(key) }), expected)).toThrow(WalletRegistrationError);
  });

  it("rejects duplicate decoded COSE keys even when integer widths differ", () => {
    const encoded = Buffer.from(encode(coseKey()));
    for (const duplicate of [Buffer.from([1, 2]), Buffer.from([0x18, 1, 2])]) {
      const bad = Buffer.concat([Buffer.from([0xa6]), encoded.subarray(1), duplicate]);
      expect(() => parseWalletRegistration(makeResponse({ cose: bad }), expected)).toThrow(WalletRegistrationError);
    }
    const stringLabels = new Map([...coseKey()].map(([key, value]) => [String(key), value]));
    expect(() => parseWalletRegistration(makeResponse({ cose: encode(stringLabels) }), expected)).toThrow(WalletRegistrationError);
  });

  it("rejects duplicate attestation fields, nonempty statements and unsupported formats", () => {
    const original = Buffer.from(makeResponse().attestationObject);
    const duplicate = Buffer.concat([Buffer.from([0xa4]), original.subarray(1), encode("fmt"), encode("none")]);
    for (const response of [
      makeResponse({ attestation: duplicate }), makeResponse({ fmt: "packed" }),
      makeResponse({ fmt: new Tag(32, "none") }), makeResponse({ attStmt: new Map([["sig", Buffer.from([1])]]) }),
      makeResponse({ attStmt: [] }),
    ]) expect(() => parseWalletRegistration(response, expected)).toThrow(WalletRegistrationError);
  });

  it("rejects semantic tags instead of silently applying global CBOR conversions", () => {
    const key = coseKey(); key.set(-2, new Tag(64, x));
    expect(() => parseWalletRegistration(makeResponse({ cose: encode(key) }), expected)).toThrow(WalletRegistrationError);
    const tagged = encode(new Tag(24, makeResponse().attestationObject));
    expect(() => parseWalletRegistration(makeResponse({ attestation: tagged }), expected)).toThrow(WalletRegistrationError);
  });

  it("rejects trailing data, deep containers, indefinite maps, huge lengths, and floats", () => {
    const original = makeResponse();
    for (const attestation of [
      Buffer.concat([original.attestationObject, Buffer.from([0])]),
      Buffer.from("818181818181818100", "hex"), Buffer.from("5bffffffffffffffff", "hex"),
      Buffer.from("bbffffffffffffffff", "hex"), Buffer.from("bf63666d74646e6f6e65ff", "hex"), Buffer.from("61ff", "hex"),
    ]) expect(() => parseWalletRegistration(makeResponse({ attestation }), expected)).toThrow(WalletRegistrationError);
    const validCose = encode(coseKey());
    for (const cose of [
      Buffer.concat([validCose, Buffer.from([0])]),
      Buffer.concat([Buffer.from([0xa5, 0xf9, 0x3c, 0x00]), validCose.subarray(2)]),
    ]) expect(() => parseWalletRegistration(makeResponse({ cose }), expected)).toThrow(WalletRegistrationError);
  });

  it("requires the exact credential ID in all response representations", () => {
    const response = makeResponse();
    for (const invalid of [
      { ...response, credentialId: Buffer.from("different").toString("base64url") },
      { ...response, rawId: Buffer.from("different") }, { ...response, credentialId: response.credentialId + "=" },
      { ...response, type: "password" as "public-key" },
    ]) expect(() => parseWalletRegistration(invalid, expected)).toThrow(WalletRegistrationError);
  });

  it("bounds credential, attestation, client data and trusted handle sizes before parsing", () => {
    const response = makeResponse();
    for (const invalid of [
      makeResponse({ id: Buffer.alloc(0) }), makeResponse({ id: Buffer.alloc(1024) }),
      makeResponse({ authData: Buffer.alloc(54) }),
      { ...response, attestationObject: Buffer.alloc(2049) },
      { ...response, clientDataJSON: Buffer.alloc(2049) },
      { ...response, clientDataJSON: Buffer.from([0xff]) },
    ]) expect(() => parseWalletRegistration(invalid, expected)).toThrow(WalletRegistrationError);
    expect(parseWalletRegistration(makeResponse({ id: Buffer.alloc(1023, 1) }), expected).credentialId.length).toBe(1364);
    for (const userHandle of ["", "A".repeat(87), expected.userHandle + "="]) {
      expect(() => parseWalletRegistration(response, { ...expected, userHandle })).toThrow(WalletRegistrationError);
    }
  });

  it("validates RP/configuration and fails closed without exposing submitted data", () => {
    for (const patch of [
      { rpId: "juicebox.center" }, { origin: "http://wallet.juicebox.center" },
      { origin: expected.origin + "/" }, { challenge: "0x12" as Hex },
    ]) expect(() => parseWalletRegistration(makeResponse(), { ...expected, ...patch })).toThrow(WalletRegistrationError);
    expect(() => parseWalletRegistration(makeResponse({ rpId: "elsewhere.example" }), expected)).toThrow(WalletRegistrationError);
    for (const response of [null, {}, { ...makeResponse(), attestationObject: "secret-user-data" }]) {
      expect(() => parseWalletRegistration(response as WalletRegistrationResponse, expected)).toThrow(WalletRegistrationError);
    }
  });
});
