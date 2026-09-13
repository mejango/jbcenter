import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { createPublicKey, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseWalletRegistration, type WalletRegistrationCandidate } from "../src/rest/wallet/registration.js";
import { verifyWalletAssertion, type WalletAssertion } from "../src/rest/wallet/webauthn.js";

const encode = (value: Uint8Array) => Buffer.from(value).toString("base64url");
const decode = (value: string) => Buffer.from(value, "base64url");
const hex = (value: Uint8Array): `0x${string}` => `0x${Buffer.from(value).toString("hex")}`;
const output = new URL("../.generated/wallet-observations/browser-required/", import.meta.url);
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Center passkey compatibility</title>
<style>body{font:16px monospace;background:#faf9f6;color:#171717;max-width:640px;margin:80px auto;padding:24px}pre{white-space:pre-wrap;line-height:1.6}</style></head>
<body><h1>Center passkey compatibility</h1><pre id="status">Testing registration and possession proof.</pre><p>Local virtual authenticator. No wallet or payment is created.</p><p>Physical-device acceptance remains pending.</p></body></html>`;

describe("actual Chromium WebAuthn producer and Center verification", () => {
  let server: Server | undefined;
  let browser: Browser | undefined;
  let page: Page;
  let cdp: CDPSession;
  let authenticatorId: string;
  let origin: string;
  let candidate: WalletRegistrationCandidate;
  let browserPublicKey: WalletRegistrationCandidate["publicKey"];
  const userHandle = encode(randomBytes(32));
  const registrationChallenge = randomBytes(32);
  const pageErrors: string[] = [];

  beforeAll(async () => {
    server = createServer((_, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(html);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Local browser test server did not start.");
    origin = `http://localhost:${address.port}`;
    // Pinned Playwright installs its matching Chromium in local development and CI.
    // This is a virtual-authenticator observation, never a physical-device assertion.
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1000, height: 750 } });
    page = await context.newPage();
    page.on("pageerror", error => pageErrors.push(error.message));
    cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    ({ authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
      protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
    } }));
    await page.goto(origin);
    await enrollCandidate();
  }, 30_000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
  });

  async function assertion(challenge: Uint8Array, userVerification: "required" | "discouraged" = "required"): Promise<WalletAssertion> {
    const response = await page.evaluate(async input => {
      const bytes = (value: string) => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
      const encode = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      // Deliberately omit allowCredentials: the stable handle must come from discoverable selection.
      const credential = await navigator.credentials.get({ publicKey: {
        rpId: "localhost", challenge: bytes(input.challenge), userVerification: input.userVerification, timeout: 5_000,
      } }) as PublicKeyCredential;
      const response = credential.response as AuthenticatorAssertionResponse;
      return { credentialId: credential.id, authenticatorData: encode(response.authenticatorData), clientDataJSON: encode(response.clientDataJSON),
        signature: encode(response.signature), userHandle: response.userHandle ? encode(response.userHandle) : null };
    }, { challenge: encode(challenge), userVerification });
    return { ...response, authenticatorData: decode(response.authenticatorData), clientDataJSON: decode(response.clientDataJSON), signature: decode(response.signature) };
  }

  const expected = (challenge: Uint8Array) => ({ purpose: "registration" as const, challenge: hex(challenge), rpId: "localhost", origin,
    credential: { id: candidate.credentialId, publicKey: candidate.publicKey, userHandle, backupEligible: candidate.backupEligible }, requireUserHandle: true });

  async function enrollCandidate() {
    const registration = await page.evaluate(async input => {
      const bytes = (value: string) => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
      const encode = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      const credential = await navigator.credentials.create({ publicKey: {
        rp: { id: "localhost", name: "Center local compatibility" },
        user: { id: bytes(input.userHandle), name: "Local test", displayName: "Local test" },
        challenge: bytes(input.challenge), pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
        attestation: "none", timeout: 5_000,
      } }) as PublicKeyCredential;
      const response = credential.response as AuthenticatorAttestationResponse;
      return { type: credential.type, credentialId: credential.id, rawId: encode(credential.rawId), clientDataJSON: encode(response.clientDataJSON),
        attestationObject: encode(response.attestationObject), publicKey: encode(response.getPublicKey()!) };
    }, { challenge: encode(registrationChallenge), userHandle });
    if (registration.type !== "public-key") throw new Error("Browser returned an unsupported credential.");
    candidate = parseWalletRegistration({ type: registration.type, credentialId: registration.credentialId, rawId: decode(registration.rawId),
      clientDataJSON: decode(registration.clientDataJSON), attestationObject: decode(registration.attestationObject) },
    { challenge: hex(registrationChallenge), rpId: "localhost", origin, userHandle });
    const jwk = createPublicKey({ key: decode(registration.publicKey), format: "der", type: "spki" }).export({ format: "jwk" });
    browserPublicKey = { x: hex(decode(jwk.x!)), y: hex(decode(jwk.y!)) };
  }

  it("parses actual none attestation and proves possession with a discoverable UV assertion", async () => {
    expect(candidate.publicKey).toEqual(browserPublicKey);
    const challenge = randomBytes(32), response = await assertion(challenge);
    expect(response.userHandle).toBe(userHandle);
    const verified = verifyWalletAssertion(response, expected(challenge));
    expect((verified.contractSignature.length - 2) / 2).toBeLessThanOrEqual(2240);
    expect(pageErrors).toEqual([]);
    await page.locator("#status").evaluate(element => { element.textContent = "Browser credential parsed by Center.\nDiscoverable possession assertion verified.\nExpected user handle matched."; });
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: new URL("chromium-passkey.png", output).pathname, fullPage: true });
    // No credential, assertion or private key is persisted in the observation.
    await writeFile(new URL("summary.json", output), JSON.stringify({ tier: "virtual-authenticator", browserVersion: browser!.version(),
      registrationParsed: true, possessionVerified: true, discoverableGet: true, userHandleMatched: true,
      contractSignatureBytes: (verified.contractSignature.length - 2) / 2, physicalDeviceObserved: false }, null, 2), { mode: 0o600 });
  }, 20_000);

  it("rejects genuine browser assertions for a different challenge or origin", async () => {
    const challenge = randomBytes(32), response = await assertion(challenge), expectation = expected(challenge);
    expect(() => verifyWalletAssertion(response, expectation)).not.toThrow();
    expect(() => verifyWalletAssertion(response, { ...expectation, challenge: hex(randomBytes(32)) })).toThrow();
    expect(() => verifyWalletAssertion(response, { ...expectation, origin: "http://localhost:1" })).toThrow();
  });

  it("rejects an actual authenticator signature without user verification", async () => {
    await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: false });
    try {
      const challenge = randomBytes(32), response = await assertion(challenge, "discouraged");
      expect(response.authenticatorData[32]! & 4).toBe(0);
      expect(() => verifyWalletAssertion(response, expected(challenge))).toThrow();
    } finally { await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: true }); }
  });
});
