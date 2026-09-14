/** No credentials, assertions, CSRF values or handoff codes are persisted by this page. */
type Json = Record<string, unknown>;
type Configuration = { issuer: string; audience: string; rpId: string };
type Session = { accountId: string; loginId: string; walletAddress: string; chainId: number; expiresAtMs: number };
type Intent = { id: string; callbackUri: string; state: string; expiresAtMs: number };
type Completion = { loginId: string; assertion: { credentialId: string; userHandle: string | null;
  authenticatorData: string; clientDataJSON: string; signature: string } };

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = element("wallet-status"), account = element("wallet-account"), address = element("wallet-address");
const destination = element("wallet-destination");
const signIn = element<HTMLButtonElement>("wallet-signin"), retry = element<HTMLButtonElement>("wallet-retry");
const cancel = element<HTMLButtonElement>("wallet-cancel"), signOut = element<HTMLButtonElement>("wallet-logout");
let configuration: Configuration, intent: Intent | null = null, session: Session | null = null;
let sessionKnown = false, busy = false, csrf = "", pending: Completion | null = null;
let completionAttempted = false;
let paymentReviewId: string | null = null;
let nativePrompt: AbortController | null = null, retryAction: (() => Promise<void>) | null = null;
let nextRetry: () => Promise<void> = load;

class InvalidResponse extends Error {}
class HttpFailure extends Error { constructor(readonly status: number) { super("Wallet request failed"); } }
function record(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidResponse();
  return value as Json;
}
function string(value: unknown, maximum = 2048): string {
  if (typeof value !== "string" || !value || value.length > maximum) throw new InvalidResponse();
  return value;
}
function future(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= Date.now()) throw new InvalidResponse();
  return value;
}
function encode(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function decode(value: unknown): Uint8Array<ArrayBuffer> {
  const encoded = string(value, 4096);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new InvalidResponse();
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = Uint8Array.from(atob(encoded.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0)); }
  catch { throw new InvalidResponse(); }
  if (encode(bytes.buffer) !== encoded) throw new InvalidResponse();
  return bytes;
}
function token(value: unknown): string {
  if (decode(value).length !== 32) throw new InvalidResponse();
  return value as string;
}
function setStatus(state: string, message: string) { status.dataset.state = state; status.textContent = message; }
function render() {
  signIn.hidden = !sessionKnown || !!session || !!pending;
  signIn.disabled = busy;
  retry.hidden = !retryAction || busy;
  signOut.hidden = !session; signOut.disabled = busy;
  cancel.hidden = !nativePrompt;
  account.hidden = !session; address.textContent = session?.walletAddress ?? "";
}
async function request(path: string, body?: unknown, csrfToken?: string): Promise<Json> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(path, { credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal,
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body), headers: {
        "content-type": "application/json", "x-center-wallet-request": "1", ...(csrfToken ? { "x-center-wallet-csrf": csrfToken } : {}),
      } }) });
    if (!response.ok) throw new HttpFailure(response.status);
    return record(await response.json());
  } finally { clearTimeout(timer); }
}
async function readyRequest(path: string, body?: unknown, csrfToken?: string): Promise<Json> {
  for (let attempt = 0; ; attempt++) {
    try { return await request(path, body, csrfToken); }
    catch (error) {
      if (!(error instanceof HttpFailure) || error.status !== 503 || attempt === 2) throw error;
      setStatus("checking", "Checking current wallet access. This may take a moment…");
      await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 400));
    }
  }
}
function acceptSession(value: Json, required = false) {
  if (value.session === null && !required) { session = null; csrf = ""; sessionKnown = true; return; }
  const current = record(value.session), walletAddress = string(current.walletAddress, 42);
  if (!/^0x[0-9a-fA-F]{40}$/.test(walletAddress) || current.chainId !== 8453
    || string(current.accountId).toLowerCase() !== `eip155:8453:${walletAddress.toLowerCase()}`) throw new InvalidResponse();
  const nextCsrf = token(value.csrfToken), expiresAtMs = future(current.expiresAtMs);
  session = { accountId: current.accountId as string, loginId: string(current.loginId, 36), walletAddress, chainId: 8453, expiresAtMs };
  csrf = nextCsrf; sessionKnown = true;
}
async function run(action: () => Promise<void>) {
  if (busy) return;
  busy = true; retryAction = null; render();
  try { await action(); }
  catch (error) {
    if (error instanceof DOMException && ["NotAllowedError", "AbortError"].includes(error.name) && nativePrompt) {
      setStatus("ready", "Sign-in cancelled. You can try your passkey again.");
    } else if (error instanceof InvalidResponse) {
      setStatus("error", "This wallet request could not be verified. Return to the app and start again.");
      // An unverified result never makes a previously unknown session safe to replace.
    } else if (error instanceof HttpFailure && [400, 401, 403, 404, 410].includes(error.status)) {
      if (pending) {
        pending = null; csrf = ""; completionAttempted = false;
        setStatus("ready", "This sign-in expired or could not be authorized. Try your passkey again.");
      } else {
        retryAction = readSession;
        setStatus("retry", "Wallet access changed or the request expired. Check your wallet again.");
      }
    } else {
      retryAction = nextRetry;
      setStatus("retry", pending
        ? "Sign-in confirmation is unavailable. Retry to check the same sign-in without using your passkey again."
        : "Wallet access is temporarily unavailable. Retry to check again.");
    }
  } finally { nativePrompt = null; busy = false; render(); }
}
async function load() {
  nextRetry = load; setStatus("loading", "Checking your wallet…");
  const query = new URL(location.href);
  if (query.hash || [...query.searchParams.keys()].some(key => !["intent", "payment"].includes(key)) || query.searchParams.size > 1) throw new InvalidResponse();
  paymentReviewId = query.searchParams.get("payment");
  if (paymentReviewId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(paymentReviewId)) throw new InvalidResponse();
  const intentId = query.searchParams.has("intent") ? token(query.searchParams.get("intent")) : null;
  const config = await request("/wallet/config");
  if (config.version !== "center-wallet-v1" || config.issuer !== location.origin) throw new InvalidResponse();
  const create = document.getElementById("wallet-create") as HTMLAnchorElement | null;
  if (create) { create.href = "/wallet/create" + query.search; create.hidden = false; }
  const rpId = string(config.rpId, 253);
  if (location.hostname !== rpId && !location.hostname.endsWith(`.${rpId}`)) throw new InvalidResponse();
  configuration = { issuer: location.origin, audience: string(config.audience), rpId };
  if (intentId) {
    const result = await request(`/wallet/authorize/${intentId}`), requested = record(result.request);
    if (result.id !== intentId || !["prepared", "issued"].includes(String(result.state))
      || requested.issuer !== configuration.issuer || requested.audience !== configuration.audience) throw new InvalidResponse();
    const callbackUri = string(requested.callbackUri), callback = new URL(callbackUri);
    if (callback.origin !== requested.origin || callback.username || callback.password || callback.hash || callback.search
      || callback.href !== callbackUri || !["https:", "http:"].includes(callback.protocol)) throw new InvalidResponse();
    intent = { id: intentId, callbackUri, state: token(requested.state), expiresAtMs: future(result.expiresAtMs) };
    destination.textContent = `Returning to ${callback.origin} after sign-in.`; destination.hidden = false;
  }
  await readSession();
}
async function readSession() {
  nextRetry = readSession; setStatus("checking", "Checking current wallet access…");
  acceptSession(await readyRequest("/wallet/session"));
  await continueSession();
}
async function continueSession() {
  if (session && paymentReviewId) {
    setStatus("returning", "Returning to your payment review…");
    location.replace(`/wallet/payment?review=${paymentReviewId}`);
  }
  else if (session && intent) await issue();
  else setStatus(session ? "signed-in" : "ready", session ? "You are signed in." : "Sign in with your existing wallet passkey.");
}
async function login() {
  nextRetry = login;
  if (pending) return completeLogin();
  if (!window.isSecureContext || !navigator.credentials?.get) {
    setStatus("error", "This browser cannot use passkeys here. Open Center in a browser that supports passkeys."); return;
  }
  setStatus("checking", "Preparing your passkey sign-in…");
  const begun = await request("/wallet/login/begin", {}), publicKey = record(begun.publicKey);
  if (publicKey.rpId !== configuration.rpId || publicKey.userVerification !== "required" || publicKey.timeout !== 90_000) throw new InvalidResponse();
  const challenge = decode(publicKey.challenge); if (challenge.length !== 32) throw new InvalidResponse();
  const loginId = string(begun.loginId, 36); future(begun.expiresAtMs);
  const flowCsrf = token(begun.csrfToken);
  nativePrompt = new AbortController(); setStatus("authenticating", "Use your passkey to sign in."); render();
  const credential = await navigator.credentials.get({ publicKey: { rpId: configuration.rpId, challenge,
    userVerification: "required", timeout: 90_000 }, signal: nativePrompt.signal });
  if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAssertionResponse)) throw new InvalidResponse();
  const assertion = credential.response;
  pending = { loginId, assertion: { credentialId: encode(credential.rawId), userHandle: assertion.userHandle ? encode(assertion.userHandle) : null,
    authenticatorData: encode(assertion.authenticatorData), clientDataJSON: encode(assertion.clientDataJSON), signature: encode(assertion.signature) } };
  csrf = flowCsrf; nativePrompt = null; render();
  completionAttempted = false;
  await completeLogin();
}
async function completeLogin() {
  nextRetry = completeLogin;
  if (!pending) throw new InvalidResponse();
  setStatus("checking", "Confirming your wallet access…");
  if (completionAttempted) {
    // Success headers can install the session and clear the flow cookie before its body
    // arrives. Only this exact login can recover the selected credential's completion.
    const recovered = await readyRequest("/wallet/session");
    if (recovered.session && record(recovered.session).loginId === pending.loginId) {
      acceptSession(recovered, true); pending = null; completionAttempted = false;
      await continueSession(); return;
    }
    // A different tab's session must neither replace this identity nor its flow CSRF.
  }
  completionAttempted = true;
  const result = await readyRequest("/wallet/login/complete", pending, csrf);
  if (record(result.session).loginId !== pending.loginId) throw new InvalidResponse();
  acceptSession(result, true);
  pending = null; completionAttempted = false;
  await continueSession();
}
async function issue() {
  nextRetry = issue;
  if (!intent || !session) throw new InvalidResponse();
  future(intent.expiresAtMs); future(session.expiresAtMs);
  setStatus("returning", "Returning to your Juicebox app…");
  const result = await request("/wallet/authorize/issue", { intentId: intent.id }, csrf);
  const redirectUri = string(result.redirectUri, 4096), redirect = new URL(redirectUri);
  const keys = [...redirect.searchParams.keys()];
  if (redirectUri.split("?")[0] !== intent.callbackUri || redirect.hash || keys.length !== 3
    || new Set(keys).size !== 3 || keys.some(key => !["code", "state", "iss"].includes(key))
    || redirect.searchParams.get("state") !== intent.state || redirect.searchParams.get("iss") !== configuration.issuer) throw new InvalidResponse();
  token(redirect.searchParams.get("code"));
  location.replace(redirectUri);
}
async function logout() {
  nextRetry = logout; setStatus("checking", "Signing out…");
  const result = await request("/wallet/logout", {}, csrf);
  if (result.loggedOut !== true) throw new InvalidResponse();
  session = null; csrf = ""; pending = null; completionAttempted = false; sessionKnown = true;
  setStatus("ready", "You are signed out. You can sign in again with your passkey.");
}
signIn.addEventListener("click", () => void run(login));
retry.addEventListener("click", () => { if (retryAction) void run(retryAction); });
cancel.addEventListener("click", () => nativePrompt?.abort());
signOut.addEventListener("click", () => void run(logout));
void run(load);
export {};
