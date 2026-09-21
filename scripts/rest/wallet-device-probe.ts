import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Hex } from 'viem';
import { parseWalletRegistration, type WalletRegistrationCandidate } from '../../src/rest/wallet/registration.js';
import { verifyWalletAssertion, WalletAssertionError } from '../../src/rest/wallet/webauthn.js';

const bodyLimit = 16_384;
type Probe = { expiresAt: number; challenge: Hex; userHandle: string;
  candidate?: WalletRegistrationCandidate; possessionChallenge?: Hex };
type ProbeDiagnostic = 'CREDENTIAL_MISMATCH' | 'USER_HANDLE_MISMATCH' | 'USER_HANDLE_REQUIRED'
  | 'AUTHENTICATOR_FLAGS_INVALID' | 'RP_MISMATCH' | 'CHALLENGE_OR_CLIENT_DATA_INVALID'
  | 'CLIENT_DATA_INVALID' | 'SIGNATURE_INVALID' | 'RESPONSE_INVALID' | 'VERIFICATION_INVALID';
class ProbeError extends Error {
  constructor(readonly status: number, readonly code: string, readonly diagnostic?: ProbeDiagnostic) { super(code); }
}
const assertionDiagnostics = new Map<string, ProbeDiagnostic>([
  ['Wallet user handle required', 'USER_HANDLE_REQUIRED'],
  ['Invalid wallet authenticator flags', 'AUTHENTICATOR_FLAGS_INVALID'],
  ['Wallet RP does not match', 'RP_MISMATCH'],
  ['Unsupported wallet client data encoding or challenge', 'CHALLENGE_OR_CLIENT_DATA_INVALID'],
  ['Invalid wallet client data', 'CLIENT_DATA_INVALID'],
  ['Invalid wallet client data encoding', 'CLIENT_DATA_INVALID'],
  ['Unsupported wallet client data encoding', 'CLIENT_DATA_INVALID'],
  ['Duplicate wallet client data field', 'CLIENT_DATA_INVALID'],
  ['Invalid wallet signature encoding', 'SIGNATURE_INVALID'],
  ['Invalid wallet signature', 'SIGNATURE_INVALID'],
  ['Invalid wallet signature or public key', 'SIGNATURE_INVALID'],
  ['Invalid wallet assertion', 'RESPONSE_INVALID'],
]);
function proofDiagnostic(error: unknown): ProbeDiagnostic {
  if (error instanceof ProbeError) return error.diagnostic ?? 'RESPONSE_INVALID';
  return error instanceof WalletAssertionError ? assertionDiagnostics.get(error.message) ?? 'VERIFICATION_INVALID' : 'VERIFICATION_INVALID';
}
const fail = (status: number, code: string): never => { throw new ProbeError(status, code); };
const nonce = (): Hex => `0x${randomBytes(32).toString('hex')}`;
const encoded = (value: Hex) => Buffer.from(value.slice(2), 'hex').toString('base64url');
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)))
    fail(400, 'PROBE_INPUT_INVALID');
  return value as Record<string, unknown>;
}
function passkeyName(value: unknown): string {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cs}\p{Bidi_Control}]/u.test(value)) return fail(400, 'PROBE_NAME_INVALID');
  const name = value.trim();
  if (!name || [...name].length > 64 || Buffer.byteLength(name, 'utf8') > 64
    || !name.replace(/[\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Mark}\u2800]/gu, '')) return fail(400, 'PROBE_NAME_INVALID');
  return name;
}
function defaultPasskeyName(): string {
  const words = randomBytes(2);
  const first = ['blue', 'calm', 'clear', 'green', 'happy', 'kind', 'lucky', 'mellow', 'quiet', 'silver', 'soft', 'sunny', 'sweet', 'warm', 'wild', 'yellow'];
  const second = ['birch', 'brook', 'cloud', 'dawn', 'fern', 'field', 'forest', 'garden', 'hill', 'lake', 'leaf', 'meadow', 'moon', 'river', 'sky', 'willow'];
  return `Juicebox test ${first[words[0]! % first.length]} ${second[words[1]! % second.length]}`;
}
function remoteConfiguration(value: unknown): { origin: string; rpId: string; authorization: Buffer } | undefined {
  if (value === undefined) return;
  const invalid = (): never => { throw new Error('Invalid remote probe options'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const configuration = value as Record<string, unknown>;
  if (Object.keys(configuration).length !== 2 || typeof configuration.origin !== 'string'
    || typeof configuration.accessToken !== 'string') return invalid();
  let url: URL; try { url = new URL(configuration.origin); } catch { return invalid(); }
  const host = url.hostname;
  if (url.protocol !== 'https:' || url.origin !== configuration.origin || url.port || url.username || url.password
    || host.length > 253 || !host.includes('.') || isIP(host) || host === 'juicebox.center' || host.endsWith('.juicebox.center')
    || !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    || !/^[A-Za-z0-9_-]{43}$/.test(configuration.accessToken)) return invalid();
  const token = Buffer.from(configuration.accessToken, 'base64url');
  if (token.length !== 32 || token.toString('base64url') !== configuration.accessToken) return invalid();
  return { origin: url.origin, rpId: host, authorization: Buffer.from(`Bearer ${configuration.accessToken}`) };
}
function bytes(value: unknown, max: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > Math.ceil(max * 4 / 3))
    return fail(400, 'PROBE_INPUT_INVALID');
  const decoded = Buffer.from(value, 'base64url');
  if (!decoded.length || decoded.length > max || decoded.toString('base64url') !== value) return fail(400, 'PROBE_INPUT_INVALID');
  return decoded;
}
function header(request: IncomingMessage, name: string): string | undefined {
  let count = 0;
  for (let i = 0; i < request.rawHeaders.length; i += 2) if (request.rawHeaders[i]!.toLowerCase() === name) count++;
  if (count > 1) return fail(403, 'PROBE_ORIGIN_INVALID');
  const value = request.headers[name];
  if (Array.isArray(value)) return fail(403, 'PROBE_ORIGIN_INVALID');
  return value;
}
function json(request: IncomingMessage): Promise<unknown> {
  if (Number(request.headers['content-length'] ?? 0) > bodyLimit) return Promise.reject(new ProbeError(413, 'PROBE_BODY_TOO_LARGE'));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    const finish = (error?: ProbeError) => {
      clearTimeout(timer); request.removeListener('data', data); request.removeListener('end', end);
      request.removeListener('error', aborted); request.removeListener('aborted', aborted);
      if (error) { request.pause(); reject(error); }
      else { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new ProbeError(400, 'PROBE_INPUT_INVALID')); } }
    };
    const data = (chunk: Buffer) => { size += chunk.length; if (size > bodyLimit) finish(new ProbeError(413, 'PROBE_BODY_TOO_LARGE')); else chunks.push(chunk); };
    const end = () => finish();
    const aborted = () => finish(new ProbeError(400, 'PROBE_REQUEST_ABORTED'));
    const timer = setTimeout(() => finish(new ProbeError(408, 'PROBE_REQUEST_TIMEOUT')), 5_000);
    request.on('data', data); request.once('end', end); request.once('error', aborted); request.once('aborted', aborted);
  });
}

const browserScript = String.raw`
(() => {
  const remote = document.documentElement.dataset.remote === 'true';
  let accessToken = null;
  if (remote) {
    const fragment = location.hash.slice(1);
    history.replaceState(null, '', location.pathname + location.search);
    if (/^[A-Za-z0-9_-]{43}$/.test(fragment)) accessToken = fragment;
  }
  const status = document.querySelector('#status'), statusLabel = document.querySelector('#status-label'), statusMessage = document.querySelector('#status-message');
  const create = document.querySelector('#create'), nameInput = document.querySelector('#passkey-name');
  const verify = document.querySelector('#verify'), cancel = document.querySelector('#cancel'), reset = document.querySelector('#reset');
  let id = null, testLabel = '', candidate = false, busy = false, generation = 0, controller = null;
  const decode = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
  const encode = value => btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  function render() { const locked = remote && !accessToken;
    create.disabled = locked || busy || candidate; verify.disabled = locked || busy || !candidate;
    cancel.disabled = locked || !busy || !controller; reset.disabled = locked || busy; nameInput.disabled = locked || busy || candidate; }
  function show(state, text) { status.dataset.state = state;
    statusLabel.textContent = { ready: 'Ready', working: 'Working', registered: 'Created', verified: 'Success', error: 'Not verified', cancelled: 'Cancelled' }[state];
    statusMessage.textContent = text; render(); }
  async function api(path, body) {
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 8_000);
    try { const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-center-device-probe': '1',
      ...(remote ? { authorization: 'Bearer ' + accessToken } : {}) },
      body: JSON.stringify(body), signal: abort.signal });
      const result = await response.json(); if (!response.ok) { const error = new Error('Local verification failed'); error.code = result.code; error.diagnostic = result.diagnostic; throw error; }
      return result;
    } finally { clearTimeout(timer); }
  }
  async function run(kind) {
    if (busy) return;
    const turn = ++generation; controller = new AbortController(); busy = true;
    show('working', kind === 'create' ? 'Create a test passkey for this site in the browser prompt.' : 'Choose "' + testLabel + '" and verify with your device.');
    try {
      if (!window.PublicKeyCredential || !navigator.credentials) throw new Error('Unavailable');
      if (kind === 'create') {
        const begun = await api('/begin', { name: nameInput.value.trim() });
        if (turn !== generation) { await api('/cancel', { id: begun.id }); return; }
        id = begun.id; testLabel = begun.publicKey.user.name; nameInput.value = testLabel;
        const options = begun.publicKey; options.challenge = decode(options.challenge); options.user.id = decode(options.user.id);
        const credential = await navigator.credentials.create({ publicKey: options, signal: controller.signal });
        if (turn !== generation) return;
        if (!(credential instanceof PublicKeyCredential)) throw new Error('Unavailable');
        const response = credential.response;
        await api('/register', { id, response: { type: credential.type, credentialId: credential.id, rawId: encode(credential.rawId),
          clientDataJSON: encode(response.clientDataJSON), attestationObject: encode(response.attestationObject) } });
        if (turn !== generation) return;
        candidate = true; show('registered', 'Test passkey created: ' + testLabel + '. Select Verify passkey and choose this exact name.');
      } else {
        const issued = await api('/challenge', { id });
        if (turn !== generation) return;
        issued.publicKey.challenge = decode(issued.publicKey.challenge);
        const credential = await navigator.credentials.get({ publicKey: issued.publicKey, signal: controller.signal });
        if (turn !== generation) return;
        if (!(credential instanceof PublicKeyCredential)) throw new Error('Unavailable');
        const response = credential.response;
        const result = await api('/verify', { id, response: { credentialId: credential.id,
          authenticatorData: encode(response.authenticatorData), clientDataJSON: encode(response.clientDataJSON),
          signature: encode(response.signature), userHandle: response.userHandle ? encode(response.userHandle) : null } });
        if (turn !== generation) return;
        if (result.status !== 'verified' || result.userVerified !== true || result.userHandleMatched !== true) throw new Error('InvalidResult');
        id = null; candidate = false;
        show('verified', 'Registration and a fresh possession proof passed, with user verification and a matching user handle.');
      }
    } catch (error) {
      if (turn !== generation) return;
      if (!candidate && id) { const abandoned = id; id = null; await api('/cancel', { id: abandoned }).catch(() => {}); }
      if (turn !== generation) return;
      if (error.code === 'PROBE_EXPIRED') { id = null; candidate = false; }
      const diagnostics = {
        CREDENTIAL_MISMATCH: 'A different test passkey was selected. Choose "' + testLabel + '" and try Verify passkey again.',
        USER_HANDLE_MISMATCH: 'The passkey user handle did not match this test. Choose "' + testLabel + '" or start over.',
        USER_HANDLE_REQUIRED: 'The browser did not return a discoverable passkey user handle. Try Verify passkey again or start over.',
        AUTHENTICATOR_FLAGS_INVALID: 'The device did not return the required verification flags. Unlock your device and try Verify passkey again.',
        RP_MISMATCH: 'The passkey response was for a different site. Keep this test page open and try Verify passkey again.',
        CHALLENGE_OR_CLIENT_DATA_INVALID: 'The browser response did not match the fresh challenge or supported format. Try Verify passkey again.',
        CLIENT_DATA_INVALID: 'The browser response did not match this page or the supported format. Try Verify passkey again.',
        SIGNATURE_INVALID: 'The passkey signature could not be verified. Try Verify passkey again or start over.',
        RESPONSE_INVALID: 'The browser returned an unsupported passkey response. Try again or start over.',
        VERIFICATION_INVALID: 'The local verifier could not validate this response. Try again or restart the test.',
      };
      const diagnostic = Object.hasOwn(diagnostics, error.diagnostic) ? diagnostics[error.diagnostic] : null;
      show('error', error.name === 'NotAllowedError' || error.name === 'AbortError'
        ? 'Passkey request cancelled or not allowed. Try again.'
        : error.code === 'PROBE_NAME_INVALID' ? 'Enter a visible passkey name of up to 64 UTF-8 bytes, without control or direction-formatting characters.'
        : error.code === 'PROBE_ACCESS_INVALID' ? 'This test link is invalid or expired. Reopen the current private test link.'
        : error.code === 'PROBE_EXPIRED' ? 'This local test expired. Start over to try again.'
          : diagnostic || 'Passkey verification failed or is unavailable in this browser. Try again or start over.');
    } finally { if (turn === generation) { busy = false; controller = null; render(); } }
  }
  async function clear(cancelled) {
    const turn = ++generation; if (controller) controller.abort(); controller = null;
    const abandoned = id; id = null; candidate = false; busy = true; show('working', 'Clearing the local test.');
    try { if (abandoned) await api('/cancel', { id: abandoned });
      if (turn === generation) show(cancelled ? 'cancelled' : 'ready', cancelled ? 'Cancelled. You can create a new test passkey.' : 'Create a test passkey, then verify it.');
    } catch { if (turn === generation) show('error', 'Browser request cancelled. Local cleanup failed; restart the test server.'); }
    finally { if (turn === generation) { busy = false; render(); } }
  }
  create.addEventListener('click', () => run('create')); verify.addEventListener('click', () => run('verify'));
  cancel.addEventListener('click', () => clear(true)); reset.addEventListener('click', () => clear(false));
  if (remote && !accessToken) show('error', 'Open the private test link to enable this temporary test.');
  else render();
})();`;
function page(nonce: string, rpId: string, remote: boolean) {
  return `<!doctype html><html lang="en" data-remote="${remote}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Center passkey device test</title><style nonce="${nonce}">
:root{color-scheme:light dark}*{box-sizing:border-box}body{font:16px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;max-width:720px;margin:48px auto;padding:24px}h1{font-size:1.6rem;line-height:1.2}button,input{font:inherit;border:1px solid currentColor;border-radius:0;padding:10px 14px;background:transparent;color:inherit}button{cursor:pointer}button:disabled,input:disabled{opacity:.45;cursor:default}button:focus-visible,input:focus-visible{outline:3px solid;outline-offset:3px}label{display:block;margin-bottom:6px}input{display:block;width:100%}.name-field{margin:24px 0}.actions{display:flex;gap:10px;flex-wrap:wrap}#status{margin:28px 0;min-height:110px;overflow-wrap:anywhere;cursor:auto}#status-label{display:block;margin-bottom:6px}#status[data-state=verified] #status-label{color:#166534}#status[data-state=error] #status-label{color:#b3261e}small{font-size:.85rem}@media(prefers-color-scheme:dark){#status[data-state=verified] #status-label{color:#86efac}#status[data-state=error] #status-label{color:#ffaba6}}@media(max-width:500px){body{margin:12px auto;padding:20px}.actions button{flex:1 1 45%}}
</style></head><body><p>JUICEBOX CENTER / DEVICE TEST</p><h1>Test your passkey</h1>
<p><strong>${remote ? 'Temporary test only.' : 'Local test only.'}</strong> No wallet, login, or payment is created.</p>
<p>Create a passkey for ${rpId}, then prove possession with a second device prompt. The test passkey may remain or sync in Passwords; you can remove it afterward.</p>
<div class="name-field"><label for="passkey-name">Passkey name</label><input id="passkey-name" name="name" type="text" value="${defaultPasskeyName()}" maxlength="64" autocomplete="off" spellcheck="false" aria-describedby="name-help" required><small id="name-help">Choose a name you will recognize. Up to 64 UTF-8 bytes.</small></div>
<div class="actions"><button id="create" type="button">Create test passkey</button><button id="verify" type="button" disabled>Verify passkey</button><button id="cancel" type="button" disabled>Cancel</button><button id="reset" type="button">Start over</button></div>
<div id="status" role="status" aria-live="polite" aria-atomic="true" data-state="ready"><strong id="status-label">Ready</strong><span id="status-message">Create a test passkey, then verify it.</span></div>
<p><small>Keep this page open. Test state is temporary and disappears when the server stops. This page checks the current browser and authenticator; it does not establish support on other devices.</small></p>
<script nonce="${nonce}">${browserScript}</script></body></html>`;
}

/** Manual device observation only. No database, production RP, wallet/account, grant or deployment. */
export async function startWalletDeviceProbe(options: {
  port?: number; challengeTtlMs?: number; lifetimeMs?: number; maxProbes?: number;
  remoteTest?: { origin: string; accessToken: string };
  onEvent?: (event: 'started' | 'registered' | 'verified' | 'cancelled' | 'expired' | 'rejected', diagnostic?: ProbeDiagnostic) => void;
} = {}) {
  const port = options.port ?? 0, ttl = options.challengeTtlMs ?? 180_000;
  const lifetime = options.lifetimeMs ?? 900_000, max = options.maxProbes ?? 8;
  const remote = remoteConfiguration(options.remoteTest), rpId = remote?.rpId ?? 'localhost';
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535
    || !Number.isSafeInteger(ttl) || ttl < 100 || ttl > 300_000
    || !Number.isSafeInteger(lifetime) || lifetime < 100 || lifetime > 900_000
    || !Number.isSafeInteger(max) || max < 1 || max > 16) throw new Error('Invalid local probe options');
  const probes = new Map<string, Probe>(), scriptNonce = randomBytes(24).toString('base64url'), startedAt = Date.now();
  const counts = { started: 0, registered: 0, verified: 0, cancelled: 0, expired: 0, rejected: 0 };
  const event = (name: keyof typeof counts, diagnostic?: ProbeDiagnostic) => { counts[name]++; options.onEvent?.(name, diagnostic); };
  let origin = '', active = 0, stopping = false;
  const expire = () => { const now = Date.now(); for (const [id, probe] of probes) if (probe.expiresAt <= now) { probes.delete(id); event('expired'); } };
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    void handle(request, response).catch(() => { response.destroy(); });
  });
  server.maxConnections = 16; server.requestTimeout = 6_000; server.headersTimeout = 5_000; server.keepAliveTimeout = 1_000;
  async function handle(request: IncomingMessage, response: ServerResponse) {
    request.on('error', () => {});
    response.setHeader('cache-control', 'no-store'); response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer'); response.setHeader('x-frame-options', 'DENY');
    response.setHeader('content-security-policy', `default-src 'none'; script-src 'nonce-${scriptNonce}'; style-src 'nonce-${scriptNonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
    const reply = (status: number, body: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    active++;
    try {
      if (active > 8) fail(429, 'PROBE_LIMIT');
      if (header(request, 'host') !== new URL(origin).host
        || (header(request, 'origin') !== undefined && header(request, 'origin') !== origin)
        || ['cross-site', 'same-site'].includes(header(request, 'sec-fetch-site') ?? '')) fail(403, 'PROBE_ORIGIN_INVALID');
      if (request.url === '/' && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(page(scriptNonce, rpId, !!remote)); return;
      }
      if (remote) {
        const supplied = Buffer.from(header(request, 'authorization') ?? '');
        if (supplied.length !== remote.authorization.length || !timingSafeEqual(supplied, remote.authorization)) fail(403, 'PROBE_ACCESS_INVALID');
      }
      if (request.url === '/status' && request.method === 'GET') {
        expire(); reply(200, { testOnly: true, rpId, startedAt: new Date(startedAt).toISOString(),
          stopsAt: new Date(startedAt + lifetime).toISOString(), pending: probes.size, counts: { ...counts } }); return;
      }
      if (request.method !== 'POST') fail(405, 'PROBE_METHOD_INVALID');
      if (header(request, 'origin') !== origin || header(request, 'x-center-device-probe') !== '1') fail(403, 'PROBE_ORIGIN_INVALID');
      if (header(request, 'content-type') !== 'application/json') fail(415, 'PROBE_CONTENT_TYPE_INVALID');
      if (!['/begin', '/register', '/challenge', '/verify', '/cancel'].includes(request.url ?? '')) fail(404, 'PROBE_NOT_FOUND');
      const input = await json(request);
      if (stopping) fail(503, 'PROBE_STOPPING');
      if (request.url === '/begin') {
        const name = passkeyName(object(input, ['name']).name);
        expire(); if (probes.size >= max) fail(429, 'PROBE_LIMIT');
        const id = randomBytes(32).toString('base64url'), challenge = nonce(), userHandle = randomBytes(32).toString('base64url');
        probes.set(id, { expiresAt: Date.now() + ttl, challenge, userHandle });
        event('started');
        reply(200, { id, publicKey: { rp: { id: rpId, name: remote ? 'Center temporary device test' : 'Center local device test' },
          // WebAuthn account display metadata, not a credential identity or a provider-owned nickname.
          user: { id: userHandle, name, displayName: name },
          challenge: encoded(challenge), pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' }, attestation: 'none', timeout: 90_000 } });
        return;
      }
      const body = object(input, request.url === '/register' || request.url === '/verify' ? ['id', 'response'] : ['id']);
      if (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.id)) fail(400, 'PROBE_INPUT_INVALID');
      const id = body.id as string;
      if (request.url === '/cancel') { if (probes.delete(id)) event('cancelled'); reply(200, { status: 'cancelled' }); return; }
      expire(); const probe = probes.get(id); if (!probe) return fail(410, 'PROBE_EXPIRED');
      if (request.url === '/register') {
        if (probe.candidate) fail(409, 'PROBE_STATE_INVALID');
        probes.delete(id);
        const value = object(body.response, ['type', 'credentialId', 'rawId', 'clientDataJSON', 'attestationObject']);
        if (value.type !== 'public-key' || typeof value.credentialId !== 'string') fail(400, 'PROBE_INPUT_INVALID');
        try { probe.candidate = parseWalletRegistration({ type: 'public-key', credentialId: value.credentialId as string,
          rawId: bytes(value.rawId, 1023), clientDataJSON: bytes(value.clientDataJSON, 2048), attestationObject: bytes(value.attestationObject, 2048) },
        { challenge: probe.challenge, rpId, origin, userHandle: probe.userHandle }); }
        catch { fail(403, 'PROBE_PROOF_INVALID'); }
        if (probe.expiresAt <= Date.now()) fail(410, 'PROBE_EXPIRED');
        probes.set(id, probe); event('registered'); reply(200, { status: 'registered' }); return;
      }
      if (!probe.candidate) fail(409, 'PROBE_STATE_INVALID');
      if (request.url === '/challenge') {
        probe.possessionChallenge = nonce();
        reply(200, { publicKey: { rpId, challenge: encoded(probe.possessionChallenge), userVerification: 'required', timeout: 90_000 } }); return;
      }
      const challenge = probe.possessionChallenge; delete probe.possessionChallenge;
      if (!challenge) fail(409, 'PROBE_STATE_INVALID');
      try {
        const value = object(body.response, ['credentialId', 'authenticatorData', 'clientDataJSON', 'signature', 'userHandle']);
        bytes(value.credentialId, 1023);
        if (value.credentialId !== probe.candidate!.credentialId) throw new ProbeError(403, 'PROBE_PROOF_INVALID', 'CREDENTIAL_MISMATCH');
        if (value.userHandle === null) throw new ProbeError(403, 'PROBE_PROOF_INVALID', 'USER_HANDLE_REQUIRED');
        bytes(value.userHandle, 64);
        if (value.userHandle !== probe.userHandle) throw new ProbeError(403, 'PROBE_PROOF_INVALID', 'USER_HANDLE_MISMATCH');
        verifyWalletAssertion({ credentialId: value.credentialId as string, authenticatorData: bytes(value.authenticatorData, 37),
        clientDataJSON: bytes(value.clientDataJSON, 2048), signature: bytes(value.signature, 72), userHandle: value.userHandle as string | null },
      { purpose: 'registration', challenge: challenge!, rpId, origin,
        credential: { id: probe.candidate!.credentialId, publicKey: probe.candidate!.publicKey, userHandle: probe.userHandle,
          backupEligible: probe.candidate!.backupEligible }, requireUserHandle: true }); }
      catch (error) { throw new ProbeError(403, 'PROBE_PROOF_INVALID', proofDiagnostic(error)); }
      probes.delete(id); if (probe.expiresAt <= Date.now()) fail(410, 'PROBE_EXPIRED');
      event('verified');
      reply(200, { status: 'verified', userVerified: true, userHandleMatched: true });
    } catch (error) {
      const diagnostic = error instanceof ProbeError ? error.diagnostic : undefined;
      event('rejected', diagnostic);
      response.setHeader('connection', 'close');
      reply(error instanceof ProbeError ? error.status : 500, { code: error instanceof ProbeError ? error.code : 'PROBE_FAILED', ...(diagnostic ? { diagnostic } : {}) });
    } finally { active--; }
  }
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => { server.removeListener('listening', ready); reject(error); };
    const ready = () => { server.removeListener('error', failed); resolve(); };
    server.once('error', failed); server.once('listening', ready); server.listen(port, '127.0.0.1');
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local probe could not start');
  const localOrigin = `http://localhost:${address.port}`;
  origin = remote?.origin ?? localOrigin;
  let closing: Promise<void> | undefined;
  const sweep = setInterval(expire, Math.min(ttl, 10_000)); sweep.unref();
  const deadline = setTimeout(() => { void close(); }, lifetime); deadline.unref();
  function close(): Promise<void> {
    if (closing) return closing;
    stopping = true;
    clearInterval(sweep); clearTimeout(deadline); probes.clear();
    closing = new Promise<void>(resolve => {
      const force = setTimeout(() => server.closeAllConnections(), 500); force.unref();
      server.close(() => { clearTimeout(force); resolve(); }); server.closeIdleConnections();
    });
    return closing;
  }
  return { origin, localOrigin, close };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  startWalletDeviceProbe({ onEvent: (event, diagnostic) => process.stdout.write(`Device test: ${event}${diagnostic ? `:${diagnostic}` : ''}\n`) }).then(probe => {
    process.stdout.write(`Local test only. Open ${probe.origin} in Safari.\nStops after 15 minutes or Ctrl+C. No wallet, login or payment is created.\n`);
    const stop = () => { void probe.close(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  }).catch(() => { process.stderr.write('The local passkey test could not start.\n'); process.exitCode = 1; });
}
