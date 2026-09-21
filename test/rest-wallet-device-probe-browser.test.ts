import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startWalletDeviceProbe } from "../scripts/rest/wallet-device-probe.js";

const output = new URL("../.generated/wallet-observations/device-probe/", import.meta.url);

describe("local device probe with a real Chromium virtual authenticator", () => {
  let probe: Awaited<ReturnType<typeof startWalletDeviceProbe>> | undefined;
  let browser: Browser | undefined;
  let page: Page;
  let cdp: CDPSession;
  let authenticatorId: string;
  const pageErrors: string[] = [];

  beforeAll(async () => {
    probe = await startWalletDeviceProbe({ port: 0 });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    page = await context.newPage();
    page.setDefaultTimeout(3_000);
    page.on("pageerror", error => pageErrors.push(error.message));
    cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    ({ authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
      protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
    } }));
  }, 30_000);

  beforeEach(async () => {
    pageErrors.length = 0;
    await cdp.send("WebAuthn.clearCredentials", { authenticatorId });
    await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: true });
    await cdp.send("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId, enabled: true });
    await page.goto(probe!.origin);
  });

  afterAll(async () => {
    const results = await Promise.allSettled([browser?.close(), probe?.close()]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
  });

  async function state(expected: string) {
    await expect.poll(() => page.locator("#status").getAttribute("data-state"), { timeout: 3_000 }).toBe(expected);
  }
  async function register() {
    const submitted = page.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname === "/register");
    // Observe the request without creating a rejected dangling promise if the UI fails to render.
    void submitted.catch(() => {});
    await page.locator("#create").click();
    await state("registered");
    return (await submitted).postDataJSON().id as string;
  }
  async function request(path: string, body: unknown) {
    return page.evaluate(async ({ path, body }) => {
      const response = await fetch(path, { method: "POST", headers: {
        "content-type": "application/json", "x-center-device-probe": "1",
      }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    }, { path, body });
  }

  it("uses an explicit routed HTTPS test origin and a fragment capability for the real browser roundtrip", async () => {
    const origin = "https://device-probe.test", accessToken = Buffer.alloc(32, 37).toString("base64url");
    const remote = await startWalletDeviceProbe({ remoteTest: { origin, accessToken } });
    const context = await browser!.newContext();
    try {
      expect(remote.origin).toBe(origin);
      const local = new URL(remote.localOrigin), requests: { path: string; authorized: boolean; tokenInUrl: boolean }[] = [];
      // Browser origin/RP behavior is real; this route supplies the local HTTP response, not public TLS evidence.
      await context.route(`${origin}/**`, async route => {
        const incoming = route.request(), url = new URL(incoming.url());
        requests.push({ path: url.pathname, authorized: incoming.headers().authorization === `Bearer ${accessToken}`,
          tokenInUrl: incoming.url().includes(accessToken) });
        const response = await new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve, reject) => {
          const forwarded = httpRequest({ host: "127.0.0.1", port: local.port, path: url.pathname + url.search,
            method: incoming.method(), headers: { ...incoming.headers(), host: new URL(origin).host } }, result => {
            const chunks: Buffer[] = []; result.on("data", chunk => chunks.push(chunk));
            result.on("end", () => resolve({ status: result.statusCode!, body: Buffer.concat(chunks),
              headers: Object.fromEntries(Object.entries(result.headers).filter(([name, value]) => typeof value === "string"
                && !["connection", "content-length", "transfer-encoding"].includes(name))) as Record<string, string> }));
          });
          forwarded.setTimeout(3_000, () => forwarded.destroy(new Error("Routed probe timed out")));
          forwarded.on("error", reject); forwarded.end(incoming.postDataBuffer());
        });
        await route.fulfill(response);
      });
      const remotePage = await context.newPage(); remotePage.setDefaultTimeout(3_000);
      await remotePage.goto(origin);
      expect(await remotePage.locator("#create").isDisabled()).toBe(true);
      expect(await remotePage.locator("#status").getAttribute("data-state")).toBe("error");
      await remotePage.goto("about:blank");
      await remotePage.goto(`${origin}/#${accessToken}`);
      expect(await remotePage.evaluate(() => location.hash)).toBe("");
      expect(await remotePage.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
      const remoteCdp = await context.newCDPSession(remotePage);
      await remoteCdp.send("WebAuthn.enable");
      await remoteCdp.send("WebAuthn.addVirtualAuthenticator", { options: {
        protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true,
        hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
      } });
      await remotePage.getByLabel("Passkey name", { exact: true }).fill("Juicebox iOS route test");
      const issued = remotePage.waitForResponse(response => new URL(response.url()).pathname === "/begin");
      void issued.catch(() => {});
      await remotePage.locator("#create").click();
      await expect.poll(() => remotePage.locator("#status").getAttribute("data-state")).toBe("registered");
      expect((await (await issued).json()).publicKey.rp.id).toBe("device-probe.test");
      const challenged = remotePage.waitForResponse(response => new URL(response.url()).pathname === "/challenge");
      void challenged.catch(() => {});
      await remotePage.locator("#verify").click();
      await expect.poll(() => remotePage.locator("#status").getAttribute("data-state")).toBe("verified");
      const challenge = await (await challenged).json();
      expect(challenge.publicKey.rpId).toBe("device-probe.test");
      expect(challenge.publicKey).not.toHaveProperty("allowCredentials");
      expect(requests.filter(item => item.path !== "/").every(item => item.authorized)).toBe(true);
      expect(requests.every(item => !item.tokenInUrl)).toBe(true);
      expect(requests.filter(item => item.path === "/").every(item => !item.authorized)).toBe(true);
    } finally { await context.close(); await remote.close(); }
  }, 20_000);

  it("completes the actual button roundtrip with a fresh discoverable UV possession proof", async () => {
    await state("ready");
    await register();
    const challenged = page.waitForResponse(response => new URL(response.url()).pathname === "/challenge");
    const verified = page.waitForResponse(response => new URL(response.url()).pathname === "/verify");
    void challenged.catch(() => {}); void verified.catch(() => {});
    await page.locator("#verify").click();
    await state("verified");
    const challenge = await (await challenged).json();
    expect(challenge.publicKey).toMatchObject({ rpId: "localhost", userVerification: "required" });
    expect(challenge.publicKey).not.toHaveProperty("allowCredentials");
    const result = await verified;
    expect(result.status()).toBe(200);
    expect(await result.json()).toMatchObject({ status: "verified", userVerified: true, userHandleMatched: true });
    expect(pageErrors).toEqual([]);
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: fileURLToPath(new URL("chromium-device-probe.png", output)), fullPage: true });
    // Only evidence classification and outcomes persist. Credential IDs, assertions and keys do not.
    await writeFile(new URL("summary.json", output), JSON.stringify({
      tier: "virtual-authenticator", browserVersion: browser!.version(), observedAt: new Date().toISOString(),
      servedUiObserved: true, registrationParsed: true, freshPossessionVerified: true,
      discoverableGet: true, userVerified: true, userHandleMatched: true,
      walletCreated: false, sessionCreated: false, physicalDeviceObserved: false,
    }, null, 2), { mode: 0o600 });
  }, 20_000);

  it("uses a trimmed custom Unicode passkey name and keeps identity fresh when the name is reused", async () => {
    const name = page.getByLabel("Passkey name", { exact: true }), chosen = "Família 🌿";
    await name.fill(`  ${chosen}  `);
    const firstBegin = page.waitForResponse(response => new URL(response.url()).pathname === "/begin");
    void firstBegin.catch(() => {});
    await register();
    const firstResponse = await firstBegin, first = await firstResponse.json();
    expect(firstResponse.request().postDataJSON().name).toBe(chosen);
    expect(first.publicKey.user.name).toBe(chosen);
    expect(first.publicKey.user.displayName).toBe(chosen);
    expect(await page.locator("#status").textContent()).toContain(chosen);
    expect(await name.isDisabled()).toBe(true);
    const retainedValue = await name.inputValue();
    await page.locator("#reset").click();
    await state("ready");
    expect(await name.isEnabled()).toBe(true);
    expect(await name.inputValue()).toBe(retainedValue);
    expect(retainedValue.trim()).toBe(chosen);
    // Isolate the current native credential. Reusing its display name must not reuse a server user handle.
    await cdp.send("WebAuthn.clearCredentials", { authenticatorId });
    const secondBegin = page.waitForResponse(response => new URL(response.url()).pathname === "/begin");
    void secondBegin.catch(() => {});
    await register();
    const second = await (await secondBegin).json();
    expect(second.publicKey.user.name).toBe(chosen);
    expect(second.publicKey.user.displayName).toBe(chosen);
    expect(second.publicKey.user.id === first.publicKey.user.id).toBe(false);
    expect(second.id === first.id).toBe(false);
    expect(await name.isDisabled()).toBe(true);
    await page.locator("#verify").click();
    await state("verified");
    expect(pageErrors).toEqual([]);
  }, 20_000);

  it("cancels a pending native passkey prompt and permits a fresh successful retry", async () => {
    await cdp.send("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId, enabled: false });
    await page.evaluate(() => {
      const state = window as unknown as { probeCreationStarted?: boolean; probeCreationError?: string };
      const create = navigator.credentials.create.bind(navigator.credentials);
      navigator.credentials.create = options => {
        state.probeCreationStarted = true;
        return create(options).catch(error => { state.probeCreationError = error.name; throw error; });
      };
    });
    await page.locator("#create").click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { probeCreationStarted?: boolean }).probeCreationStarted), { timeout: 3_000 }).toBe(true);
    await state("working");
    await page.locator("#cancel").click();
    await state("cancelled");
    await expect.poll(() => page.evaluate(() => (window as unknown as { probeCreationError?: string }).probeCreationError), { timeout: 3_000 }).toBe("AbortError");
    await cdp.send("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId, enabled: true });
    await page.locator("#reset").click();
    await state("ready");
    await register();
    await page.locator("#verify").click();
    await state("verified");
    expect(pageErrors).toEqual([]);
  }, 20_000);

  it("keeps a newer passkey prompt working when an older error-cleanup response arrives", async () => {
    let cleanupReached!: () => void, releaseCleanup!: () => void;
    const reached = new Promise<void>(resolve => { cleanupReached = resolve; });
    const released = new Promise<void>(resolve => { releaseCleanup = resolve; });
    let held = false;
    await page.route("**/cancel", async route => {
      if (held) { await route.continue(); return; }
      held = true;
      const response = await route.fetch();
      cleanupReached();
      await released;
      await route.fulfill({ response });
    });
    await cdp.send("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId, enabled: false });
    await page.evaluate(() => {
      const state = window as unknown as { probeCreateCount?: number };
      const create = navigator.credentials.create.bind(navigator.credentials);
      navigator.credentials.create = options => {
        state.probeCreateCount = (state.probeCreateCount ?? 0) + 1;
        if (state.probeCreateCount !== 1) return create(options);
        // The browser produces the AbortError. Only its first native prompt is cancelled externally.
        const cancellation = new AbortController();
        const pending = create({ ...options, signal: AbortSignal.any([
          cancellation.signal, ...(options?.signal ? [options.signal] : []),
        ]) });
        setTimeout(() => cancellation.abort(), 0);
        return pending;
      };
    });
    try {
      await page.locator("#create").click();
      await Promise.race([reached, new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Native cancellation did not reach server cleanup")), 3_000);
        void reached.finally(() => clearTimeout(timer));
      })]);
      await page.locator("#cancel").click();
      await state("cancelled");
      await page.locator("#reset").click();
      await state("ready");
      await page.locator("#create").click();
      await expect.poll(() => page.evaluate(() => (window as unknown as { probeCreateCount?: number }).probeCreateCount), { timeout: 3_000 }).toBe(2);
      await state("working");
      const cleanupResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/cancel");
      releaseCleanup();
      expect(await (await cleanupResponse).finished()).toBeNull();
      // Let the completed response's JSON and UI continuations settle before inspecting the newer prompt.
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await page.locator("#status").getAttribute("data-state")).toBe("working");
      await page.locator("#cancel").click();
      await state("cancelled");
      expect(pageErrors).toEqual([]);
    } finally {
      releaseCleanup();
      await page.unrouteAll({ behavior: "wait" });
      await cdp.send("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId, enabled: true });
    }
  }, 20_000);

  it("rejects a genuine UV-off discoverable assertion and accepts a fresh verified proof", async () => {
    const id = await register();
    const challenged = await request("/challenge", { id });
    expect(challenged.status).toBe(200);
    expect(challenged.body.publicKey).not.toHaveProperty("allowCredentials");
    await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: false });
    try {
      const assertion = await page.evaluate(async options => {
        const decode = (value: string) => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), value => value.charCodeAt(0));
        const encode = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
        const credential = await navigator.credentials.get({ publicKey: {
          rpId: options.rpId, challenge: decode(options.challenge), userVerification: "discouraged", timeout: 5_000,
        } }) as PublicKeyCredential;
        const response = credential.response as AuthenticatorAssertionResponse;
        return { credentialId: credential.id, authenticatorData: encode(response.authenticatorData),
          clientDataJSON: encode(response.clientDataJSON), signature: encode(response.signature),
          userHandle: response.userHandle ? encode(response.userHandle) : null };
      }, challenged.body.publicKey);
      expect(Buffer.from(assertion.authenticatorData, "base64url")[32]! & 4).toBe(0);
      expect(assertion.userHandle).not.toBeNull();
      expect((await request("/verify", { id, response: assertion })).status).toBe(403);
      await state("registered");
    } finally {
      await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: true });
    }
    await page.locator("#verify").click();
    await state("verified");
    expect(pageErrors).toEqual([]);
  }, 20_000);

  it("identifies an older localhost passkey selected by discoverable get and permits the current key on retry", async () => {
    await register();
    const firstCredentials = (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials;
    expect(firstCredentials.length).toBe(1);
    const first = firstCredentials[0]!;
    await page.locator("#reset").click();
    await state("ready");
    const secondBegin = page.waitForResponse(response => new URL(response.url()).pathname === "/begin");
    void secondBegin.catch(() => {});
    await register();
    const secondOptions = (await (await secondBegin).json()).publicKey;
    const testLabel = secondOptions.user.name as string;
    expect(testLabel).toMatch(/^Juicebox test /);
    expect(secondOptions.user.displayName).toBe(testLabel);
    expect(await page.locator("#status").textContent()).toContain(testLabel);
    const bothCredentials = (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials;
    expect(bothCredentials.length).toBe(2);
    const second = bothCredentials.find(credential => credential.credentialId !== first.credentialId)!;
    expect(Boolean(second)).toBe(true);
    // Keep test-only CDP keys in memory. Narrow available native credentials, never allowCredentials.
    await cdp.send("WebAuthn.clearCredentials", { authenticatorId });
    await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: first });
    const challenged = page.waitForResponse(response => new URL(response.url()).pathname === "/challenge");
    const rejected = page.waitForResponse(response => new URL(response.url()).pathname === "/verify");
    void challenged.catch(() => {}); void rejected.catch(() => {});
    await page.locator("#verify").click();
    await state("error");
    expect((await (await challenged).json()).publicKey).not.toHaveProperty("allowCredentials");
    const failure = await rejected;
    expect(failure.status()).toBe(403);
    expect(await failure.json()).toEqual({ code: "PROBE_PROOF_INVALID", diagnostic: "CREDENTIAL_MISMATCH" });
    expect(await page.locator("#status").textContent()).toMatch(/different test passkey/i);
    expect(await page.locator("#status").textContent()).toContain(testLabel);
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: fileURLToPath(new URL("chromium-device-probe-wrong-passkey.png", output)), fullPage: true });
    await cdp.send("WebAuthn.clearCredentials", { authenticatorId });
    await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: second });
    await page.locator("#verify").click();
    await state("verified");
    expect(pageErrors).toEqual([]);
  }, 20_000);

  it.each([
    { variant: "missing", userHandle: null, diagnostic: "USER_HANDLE_REQUIRED" },
    { variant: "changed", userHandle: Buffer.from("different-local-test-handle").toString("base64url"), diagnostic: "USER_HANDLE_MISMATCH" },
  ])("identifies a $variant user handle on a genuine browser assertion and permits a fresh retry", async ({ userHandle, diagnostic }) => {
    const id = await register();
    const challenged = await request("/challenge", { id });
    expect(challenged.status).toBe(200);
    expect(challenged.body.publicKey).not.toHaveProperty("allowCredentials");
    const assertion = await page.evaluate(async options => {
      const decode = (value: string) => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), value => value.charCodeAt(0));
      const encode = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      const credential = await navigator.credentials.get({ publicKey: {
        rpId: options.rpId, challenge: decode(options.challenge), userVerification: "required", timeout: 5_000,
      } }) as PublicKeyCredential;
      const response = credential.response as AuthenticatorAssertionResponse;
      return { credentialId: credential.id, authenticatorData: encode(response.authenticatorData),
        clientDataJSON: encode(response.clientDataJSON), signature: encode(response.signature),
        userHandle: response.userHandle ? encode(response.userHandle) : null };
    }, challenged.body.publicKey);
    expect(assertion.userHandle !== null).toBe(true);
    const rejected = await request("/verify", { id, response: { ...assertion, userHandle } });
    expect(rejected.status).toBe(403);
    expect(rejected.body).toEqual({ code: "PROBE_PROOF_INVALID", diagnostic });
    await page.locator("#verify").click();
    await state("verified");
    expect(pageErrors).toEqual([]);
  }, 20_000);
});
