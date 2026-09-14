import { getAddress, isAddress, type Address, type Hex, type TypedDataDefinition } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { createLocalWalletSignup } from '../wallet/signup.js';

type Signup = ReturnType<typeof createLocalWalletSignup>;
type View = Awaited<ReturnType<Signup['status']>>;
type Ethereum = { request(input: { method: string; params?: unknown[] }): Promise<unknown> };
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = el<HTMLFormElement>('signup-form'), name = el<HTMLInputElement>('passkey-name');
const next = el<HTMLButtonElement>('signup-next'), resume = el<HTMLButtonElement>('signup-resume');
const check = el<HTMLButtonElement>('signup-check'), cancel = el<HTMLButtonElement>('signup-cancel');
const status = el('wallet-status'), details = el('signup-details'), signIn = el<HTMLAnchorElement>('signup-signin');
let view: View | null = null, known = false, busy = false, csrf = '', native: AbortController | null = null;
let pending: { path: string; body: unknown; csrf: string } | null = null;
let deployment: Awaited<ReturnType<Signup['prepareDeployment']>> | null = null;
let setup: Awaited<ReturnType<Signup['prepareSetup']>> | null = null;
let disposed = false, pollCount = 0;
const steps: Record<View['phase'], string> = {
  awaiting_registration: 'Create your named passkey.', awaiting_possession: 'Prove access to your passkey and recovery wallet.',
  awaiting_deployment_approval: 'Review and approve creation of your test wallet.', deploying: 'Creating your test wallet. Keep this page open, or resume later with your passkey.',
  deployment_failed: 'Wallet creation did not complete. Keep this signup for recovery; do not send funds.',
  awaiting_setup: 'Authorize this browser to read and prepare requests. Every payment will still need owner approval.',
  ready_to_sign_in: 'Your test wallet is ready. Sign in with a fresh passkey prompt.', expired: 'This incomplete registration expired. Its passkey is not an active wallet credential.',
};
function message(value: string, error = false) { status.textContent = value; status.dataset.state = error ? 'error' : 'ready'; }
function encode(value: ArrayBuffer) { return btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(value)) throw new Error('Invalid passkey challenge.');
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
  if (encode(bytes.buffer) !== value) throw new Error('Invalid passkey challenge.');
  return bytes;
}
function hexBytes(value: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('Invalid passkey challenge.');
  return Uint8Array.from(value.slice(2).match(/../g)!.map(pair => parseInt(pair, 16)));
}
class HttpFailure extends Error { constructor(readonly status: number) { super('Signup could not be confirmed. Check the original signup and retry.'); } }
async function request(path: string, body?: unknown, proof = csrf): Promise<any> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch('/wallet/signup/' + path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
      ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-center-wallet-request': '1',
        ...(proof ? { 'x-center-wallet-csrf': proof } : {}) }, body: JSON.stringify(body) }) });
    if (!response.ok) throw new HttpFailure(response.status);
    return await response.json();
  } finally { clearTimeout(timer); }
}
function accept(result: { view: View | null; csrfToken?: string }) {
  if (result.view) {
    if (result.view.origin !== location.origin || result.view.rpId !== location.hostname || !(result.view.phase in steps)) throw new Error('The wallet host or signup changed.');
    if (view && view.enrollmentId !== result.view.enrollmentId && !pending?.path.startsWith('resume/')) throw new Error('Another signup replaced this page. Reload before continuing.');
  }
  view = result.view; known = true;
  if (result.csrfToken) { if (decode(result.csrfToken).length !== 32) throw new Error('Invalid signup context.'); csrf = result.csrfToken; }
  message(view ? steps[view.phase] : 'Name your passkey and connect a recovery wallet to begin.');
  if (view?.phase === 'ready_to_sign_in') sessionStorage.removeItem('center:signup:browser:' + view.enrollmentId);
}
function render() {
  form.hidden = !known || !!view; form.querySelector('button')!.disabled = busy;
  name.disabled = busy; details.hidden = !view;
  el('signup-name').textContent = view?.passkeyName ?? ''; el('signup-recovery').textContent = view?.recoveryOwner ?? '';
  el('signup-address').textContent = view?.walletAddress ?? 'Not created yet';
  const label = view?.phase === 'awaiting_registration' ? 'Create passkey' : view?.phase === 'awaiting_possession' ? 'Verify both owners'
    : view?.phase === 'awaiting_deployment_approval' ? deployment ? 'Approve wallet creation' : 'Review wallet creation'
    : view?.phase === 'awaiting_setup' ? setup ? 'Approve browser setup' : 'Review browser setup'
    : view?.phase === 'expired' ? 'Start a new registration' : null;
  next.hidden = !label || !!pending; next.textContent = label; next.disabled = busy;
  resume.hidden = busy || !!pending || view?.phase === 'ready_to_sign_in';
  check.hidden = !view && !pending && known; check.disabled = busy;
  cancel.hidden = !native; signIn.hidden = view?.phase !== 'ready_to_sign_in';
}
async function send(path: string, body: unknown, proof = csrf) {
  pending = { path, body, csrf: proof };
  const result = await request(path, body, proof); accept(result); pending = null;
}
async function observe() {
  if (pending) { const saved = pending; await send(saved.path, saved.body, saved.csrf); }
  else accept(await request('state'));
}
async function run(action: () => Promise<void>) {
  if (busy || disposed) return;
  busy = true; render();
  try { await action(); }
  catch (error) {
    if (error instanceof HttpFailure && error.status >= 400 && error.status < 500) {
      pending = null; deployment = null; setup = null;
      try { accept(await request('state')); } catch { /* Resume with a fresh proof if the cookie is no longer valid. */ }
    }
    message(error instanceof DOMException && ['NotAllowedError', 'AbortError'].includes(error.name) && native
      ? 'Passkey prompt cancelled or unavailable. You can try again.'
      : error instanceof Error ? error.message : 'Signup is unavailable. Check the original signup again.', true);
  } finally { native = null; busy = false; if (!disposed) render(); }
}
function provider(): Ethereum {
  const value = (window as unknown as { ethereum?: Ethereum }).ethereum;
  if (!value?.request) throw new Error('Open this page with your recovery wallet browser extension available.');
  return value;
}
async function recoveryOwner(expected?: Address) {
  const accounts = await provider().request({ method: 'eth_requestAccounts' });
  if (!Array.isArray(accounts) || !isAddress(accounts[0]) || (expected && getAddress(accounts[0]) !== getAddress(expected)))
    throw new Error('Select the original recovery wallet before continuing.');
  return getAddress(accounts[0]);
}
async function assertion(challenge: string, rpId: string, credentialId?: string) {
  if (rpId !== location.hostname || !window.isSecureContext) throw new Error('Open the original secure wallet page.');
  native = new AbortController(); render();
  const value = await navigator.credentials.get({ publicKey: { rpId, challenge: hexBytes(challenge), userVerification: 'required', timeout: 90000,
    ...(credentialId ? { allowCredentials: [{ type: 'public-key', id: decode(credentialId) }] } : {}) }, signal: native.signal });
  if (!(value instanceof PublicKeyCredential) || !(value.response instanceof AuthenticatorAssertionResponse)) throw new Error('The passkey response is unavailable.');
  const response = value.response; native = null;
  return { credentialId: encode(value.rawId), userHandle: response.userHandle ? encode(response.userHandle) : null,
    authenticatorData: encode(response.authenticatorData), clientDataJSON: encode(response.clientDataJSON), signature: encode(response.signature) };
}
function browserKey() {
  if (!view) throw new Error('Reload your signup.');
  const key = 'center:signup:browser:' + view.enrollmentId;
  let stored = sessionStorage.getItem(key);
  if (!stored) { stored = generatePrivateKey(); sessionStorage.setItem(key, stored); }
  if (sessionStorage.getItem(key) !== stored || !/^0x[0-9a-f]{64}$/.test(stored)) throw new Error('This tab could not preserve its browser setup.');
  return privateKeyToAccount(stored as Hex);
}
async function advance() {
  if (!view) return;
  if (view.phase === 'expired') {
    await send('restart', {}); csrf = '';
  } else if (view.phase === 'awaiting_registration' && view.registration) {
    native = new AbortController(); render();
    const value = await navigator.credentials.create({ publicKey: { rp: { id: view.rpId, name: 'Juicebox' },
      user: { id: decode(view.registration.userHandle), name: view.passkeyName, displayName: view.passkeyName },
      challenge: decode(view.registration.challenge), pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      attestation: 'none', timeout: 90000 }, signal: native.signal });
    if (!(value instanceof PublicKeyCredential) || !(value.response instanceof AuthenticatorAttestationResponse)) throw new Error('The passkey response is unavailable.');
    native = null;
    await send('register', { type: 'public-key', credentialId: encode(value.rawId), rawId: encode(value.rawId),
      clientDataJSON: encode(value.response.clientDataJSON), attestationObject: encode(value.response.attestationObject) });
  } else if (view.phase === 'awaiting_possession' && view.possession) {
    const owner = await recoveryOwner(view.recoveryOwner), document = view.possession.document;
    const backupSignature = await provider().request({ method: 'eth_signTypedData_v4', params: [owner, JSON.stringify(document)] });
    const proof = await assertion(view.possession.challenge, view.rpId, view.possession.credentialId);
    await send('prove', { assertion: proof, backupSignature });
  } else if (view.phase === 'awaiting_deployment_approval') {
    if (!deployment) {
      deployment = await request('deployment/review', {});
      if (deployment!.walletAddress.toLowerCase() !== view.walletAddress?.toLowerCase() || deployment!.recoveryOwner.toLowerCase() !== view.recoveryOwner.toLowerCase() || deployment!.initializerHash !== view.initializerHash) {
        deployment = null; throw new Error('The wallet creation review changed.');
      }
      message('Approve creation of the test wallet shown above, with this passkey and recovery owner.');
    } else {
      const proof = await assertion(deployment.challenge, view.rpId, deployment.credentialId);
      await send('deployment/approve', { approvalId: deployment.id, assertion: proof }); deployment = null;
    }
  } else if (view.phase === 'awaiting_setup') {
    const browser = browserKey();
    if (!setup) {
      setup = await request('setup/review', { browserPublicAddress: browser.address });
      if (setup!.walletAddress.toLowerCase() !== view.walletAddress?.toLowerCase() || getAddress(setup!.input.grant.botAddress) !== browser.address ||
        setup!.input.grant.scopes.join(',') !== 'read,plan,relay') { setup = null; throw new Error('The browser setup review changed.'); }
      message('Authorize this browser for one hour of read, plan and relay access. It cannot approve payments on its own.');
    } else {
      const proof = await assertion(setup.signingPayload.digest, view.rpId);
      const browserProof = await browser.signTypedData(setup.proofDocument as TypedDataDefinition);
      await send('setup/complete', { setupId: setup.id, assertion: proof, browserProof }); setup = null;
    }
  }
}
form.addEventListener('submit', event => { event.preventDefault(); void run(async () => {
  const passkeyName = name.value.trim(), owner = await recoveryOwner();
  await send('begin', { recoveryOwner: owner, passkeyName });
}); });
next.addEventListener('click', () => { void run(advance); });
check.addEventListener('click', () => { void run(observe); });
cancel.addEventListener('click', () => native?.abort());
resume.addEventListener('click', () => { void run(async () => {
  const begun = await request('resume/begin', {}), proof = await assertion(begun.challenge.challenge, begun.challenge.rpId);
  await send('resume/complete', { resumeId: begun.challenge.id, assertion: proof }, begun.csrfToken);
  deployment = null; setup = null;
}); });
const timer = setInterval(() => {
  if (!busy && !pending && view?.phase === 'deploying' && !document.hidden && navigator.onLine && pollCount++ < 60) void run(observe);
}, 2000);
window.addEventListener('pagehide', () => { disposed = true; native?.abort(); clearInterval(timer); }, { once: true });
void run(async () => {
  const url = new URL(location.href);
  if (url.hash || url.searchParams.size > 1 || [...url.searchParams].some(([key, value]) => key === 'intent' ? !/^[A-Za-z0-9_-]{43}$/.test(value)
    : key === 'payment' ? !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) : true)) throw new Error('Return to the original app to start this signup.');
  signIn.href = '/wallet' + url.search; el<HTMLAnchorElement>('wallet-back').href = signIn.href;
  await observe();
});
