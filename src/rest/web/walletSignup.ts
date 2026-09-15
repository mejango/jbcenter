import { getAddress, hashTypedData, isAddress, type Address, type Hex, type TypedDataDefinition } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { createLocalWalletSignup } from '../wallet/signup.js';
import { createWalletRecoverySecret, readWalletRecoveryKit, recoveryAccountFromPhrase, serializeWalletRecoveryKit,
  type WalletRecoveryKitIdentity, type WalletRecoverySecret } from './walletRecoveryKit.js';

type Signup = ReturnType<typeof createLocalWalletSignup>;
type View = Awaited<ReturnType<Signup['status']>>;
type Ethereum = { request(input: { method: string; params?: unknown[] }): Promise<unknown> };
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = el<HTMLFormElement>('signup-form'), name = el<HTMLInputElement>('passkey-name');
const next = el<HTMLButtonElement>('signup-next'), resume = el<HTMLAnchorElement>('signup-resume');
const check = el<HTMLButtonElement>('signup-check'), cancel = el<HTMLButtonElement>('signup-cancel');
const status = el('wallet-status'), details = el('signup-details'), restart = el<HTMLButtonElement>('signup-restart');
const explain = el<HTMLDialogElement>('signup-explain');
/** A small in-page note before every native passkey prompt: what it is for, then one click opens it. */
function announce(title: string, text: string) {
  el('explain-title').textContent = title; el('explain-text').textContent = text;
  return new Promise<void>((resolve, reject) => {
    explain.addEventListener('close', () => explain.returnValue === 'continue' ? resolve() : reject(new Error('Cancelled. You can try again.')), { once: true });
    explain.returnValue = ''; explain.showModal();
  });
}
const short = (address: string) => address.slice(0, 6) + '…' + address.slice(-4);
let view: View | null = null, known = false, busy = false, csrf = '', native: AbortController | null = null;
let pending: { path: string; body: unknown; csrf: string } | null = null;
let disposed = false, pollCount = 0;
let recoverySecret: WalletRecoverySecret | null = null, kitVerifiedWallet: string | null = null, kitSavedWallet: string | null = null;
const downloadUrls = new Set<string>();
// The choice outlives the form: a resumed signup reads it back by enrollment.
const kitChoice = () => el<HTMLFieldSetElement>('recovery-method').querySelector<HTMLInputElement>('input:checked')?.value === 'kit';
const kitMode = () => view ? localStorage.getItem('center:signup:kit:' + view.enrollmentId) === '1' : kitChoice();
function kitIdentity(): WalletRecoveryKitIdentity {
  if (!view?.walletAddress || !view.initializerHash) throw new Error('Create your passkey before saving the complete recovery kit.');
  return { network: 'base', chainId: 8453, walletAddress: view.walletAddress, recoveryOwner: view.recoveryOwner, initializerHash: view.initializerHash };
}
const steps: Record<View['phase'], string> = {
  awaiting_registration: 'Create your passkey.', awaiting_possession: 'Your passkey is ready. Create your wallet with it.',
  awaiting_deployment_approval: 'Your passkey is ready. Approve creation of your wallet.',
  deploying: 'Creating your wallet. This usually takes about a minute. Keep this page open, or come back later with your passkey.',
  deployment_failed: 'Wallet creation did not complete. Keep this signup for recovery; do not send funds.',
  awaiting_setup: 'Your wallet is ready.', ready_to_sign_in: 'Your wallet is ready. Log in with your passkey.',
  expired: 'This incomplete signup expired. Its passkey is not an active wallet credential.',
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
class HttpFailure extends Error {
  constructor(readonly status: number, readonly code = '') {
    super(code === 'WALLET_DEPLOYMENT_BUSY' ? 'Another wallet is being created right now. Try again in a minute.' : 'Signup could not be confirmed. Check the original signup and retry.');
  }
}
async function failure(response: Response) {
  try { const code = (await response.json())?.error?.code; return new HttpFailure(response.status, typeof code === 'string' ? code : ''); }
  catch { return new HttpFailure(response.status); }
}
async function request(path: string, body?: unknown, proof = csrf): Promise<any> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch('/wallet/signup/' + path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
      ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-center-wallet-request': '1',
        ...(proof ? { 'x-center-wallet-csrf': proof } : {}) }, body: JSON.stringify(body) }) });
    if (!response.ok) throw await failure(response);
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
  message(view ? steps[view.phase] + (view.phase === 'awaiting_setup' ? kitMode() ? ' Save your recovery kit, then continue.' : ' Continue to log in.' : '') : '');
  if (view?.phase === 'ready_to_sign_in') sessionStorage.removeItem('center:signup:browser:' + view.enrollmentId);
  if (view?.phase === 'ready_to_sign_in' && kitSavedWallet === view.walletAddress) recoverySecret = null;
}
function render() {
  form.querySelector('button')!.disabled = busy;
  name.disabled = busy;
  // The kit is presented once the wallet exists. Earlier phases still need the words in memory
  // to sign the enrollment; a reload before then strands the signup, so say so and offer a fresh start.
  const kitPhase = !!view && ['awaiting_setup', 'ready_to_sign_in'].includes(view.phase);
  const stranded = kitMode() && !recoverySecret && !!view && ['awaiting_registration', 'awaiting_possession'].includes(view.phase);
  // A stranded attempt that never created a passkey lost nothing worth mentioning: show the clean form.
  if (stranded) message(view!.phase === 'awaiting_possession' ? 'Your last signup cannot continue without its recovery words. Sign up again with a new passkey.' : '');
  form.hidden = !known || (!!view && !stranded); details.hidden = !view || stranded;
  el<HTMLFieldSetElement>('recovery-method').disabled = busy; // Inside the form: gone once signup begins.
  el('recovery-kit').hidden = !kitPhase || !kitMode() || kitVerifiedWallet === view!.walletAddress;
  el('recovery-phrase').textContent = recoverySecret?.mnemonic ?? '';
  el('recovery-hint').textContent = recoverySecret ? '' : 'Reloading hid the words. Reopen your saved kit or restore the words to check them.';
  el('recovery-kit-note').hidden = !recoverySecret; el<HTMLButtonElement>('recovery-download').hidden = !recoverySecret;
  el<HTMLButtonElement>('recovery-download').disabled = busy;
  el<HTMLInputElement>('recovery-file').disabled = busy;
  el<HTMLTextAreaElement>('recovery-words').disabled = busy;
  el<HTMLButtonElement>('recovery-restore').disabled = busy;
  el('signup-name').textContent = view?.passkeyName ?? '';
  el('signup-recovery-label').textContent = kitMode() ? 'Recovery' : 'Recovery wallet';
  el('signup-recovery').textContent = kitMode() ? kitPhase ? 'Your recovery kit' : 'A kit you download once the wallet exists' : view?.recoveryOwner ?? '';
  el('signup-address').textContent = view?.walletAddress ?? 'Not created yet';
  const label = view?.phase === 'awaiting_registration' ? 'Create passkey'
    : view?.phase === 'awaiting_possession' || view?.phase === 'awaiting_deployment_approval' ? 'Create wallet'
    : view?.phase === 'awaiting_setup' ? 'Set up and log in' : view?.phase === 'ready_to_sign_in' ? 'Log in' : view?.phase === 'expired' ? 'Start a new signup' : null;
  next.hidden = !label || !!pending || stranded; next.textContent = label; next.disabled = busy;
  // Saving the kit unlocks browser setup; after a reload the words are gone and only a saved kit can be checked.
  if (view?.phase === 'awaiting_setup' && kitMode() && recoverySecret && kitSavedWallet !== view.walletAddress) next.disabled = true;
  el('signup-intro').hidden = !known || !!view; // "log in" resumes with a passkey; a finished wallet lands at sign-in.
  // "Check signup" only matters for a lost reply or while creation is in progress.
  check.hidden = stranded || !(pending || view?.phase === 'deploying'); check.disabled = busy;
  cancel.hidden = !native;
  // Forgetting this browser's continuation; the signup and its passkey stay usable through "log in".
  restart.hidden = !view || stranded || view.phase === 'expired'; restart.disabled = busy;
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
      pending = null;
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
    await announce('Create your passkey', `Your device will ask for your passkey (Touch ID, Face ID or a PIN) to save "${view.passkeyName}".`);
    message('Create the passkey in the prompt.'); native = new AbortController(); render();
    const value = await navigator.credentials.create({ publicKey: { rp: { id: view.rpId, name: 'Juicebox' },
      user: { id: decode(view.registration.userHandle), name: view.passkeyName, displayName: view.passkeyName },
      challenge: decode(view.registration.challenge), pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      attestation: 'none', timeout: 90000 }, signal: native.signal });
    if (!(value instanceof PublicKeyCredential) || !(value.response instanceof AuthenticatorAttestationResponse)) throw new Error('The passkey response is unavailable.');
    native = null;
    await send('register', { type: 'public-key', credentialId: encode(value.rawId), rawId: encode(value.rawId),
      clientDataJSON: encode(value.response.clientDataJSON), attestationObject: encode(value.response.attestationObject) });
    // Straight on to checking the passkey and approving creation; the first page said so.
    if (current()?.phase === 'awaiting_possession') await advance();
  } else if (view.phase === 'awaiting_possession' && view.possession) {
    const document = view.possession.document, value = document.message;
    if (document.domain.name !== 'Juicebox Center Wallet Enrollment' || document.domain.version !== '1' || document.domain.chainId !== 8453
      || document.primaryType !== 'WalletEnrollment' || value.purpose !== 'registration' || value.enrollmentId !== view.enrollmentId
      || value.origin !== location.origin || value.rpId !== location.hostname || value.initializerHash !== view.initializerHash
      || getAddress(value.recoveryOwner) !== getAddress(view.recoveryOwner) || getAddress(value.predictedSafe) !== getAddress(view.walletAddress!)
      || getAddress(document.domain.verifyingContract) !== getAddress(view.walletAddress!)
      || hashTypedData(document) !== view.possession.challenge || BigInt(value.expiresAtMs) <= BigInt(Date.now())) throw new Error('The wallet enrollment review changed.');
    let backupSignature: unknown;
    if (kitMode()) {
      if (!recoverySecret) throw new Error('Restore your recovery words or saved kit before verifying this signup.');
      backupSignature = await recoveryAccountFromPhrase(recoverySecret.mnemonic, view.recoveryOwner).signTypedData(document);
    } else {
      const owner = await recoveryOwner(view.recoveryOwner);
      backupSignature = await provider().request({ method: 'eth_signTypedData_v4', params: [owner, JSON.stringify(document)] });
    }
    await announce('Check the new passkey', 'One more passkey prompt proves the passkey you just made can sign for this wallet.');
    message('Check that the new passkey works: use it in the prompt.');
    const proof = await assertion(view.possession.challenge, view.rpId, view.possession.credentialId);
    await send('prove', { assertion: proof, backupSignature });
    if (current()?.phase === 'awaiting_deployment_approval') await approve();
  } else if (view.phase === 'awaiting_deployment_approval') {
    await approve();
  } else if (view.phase === 'awaiting_setup') {
    if (kitMode() && recoverySecret && kitSavedWallet !== view.walletAddress) throw new Error('Download your recovery kit before continuing.');
    // One click authorizes this browser for an hour of read, plan and relay access (it cannot approve
    // payments on its own), then logs in: two prompts.
    const browser = browserKey();
    const setup: Awaited<ReturnType<Signup['prepareSetup']>> = await request('setup/review', { browserPublicAddress: browser.address });
    if (setup.walletAddress.toLowerCase() !== view.walletAddress?.toLowerCase() || getAddress(setup.input.grant.botAddress) !== browser.address ||
      setup.input.grant.scopes.join(',') !== 'read,plan,relay') throw new Error('The browser setup review changed.');
    await announce('Authorize this browser', 'A passkey prompt lets this browser read your wallet and prepare requests for one hour. It cannot move funds on its own.');
    message('Authorize this browser in the prompt.');
    const proof = await assertion(setup.signingPayload.digest, view.rpId);
    const browserProof = await browser.signTypedData(setup.proofDocument as TypedDataDefinition);
    await send('setup/complete', { setupId: setup.id, assertion: proof, browserProof });
    if (current()?.phase === 'ready_to_sign_in') await login();
  } else if (view.phase === 'ready_to_sign_in') {
    await login();
  }
}
const current = () => view;
async function approve() {
  const deployment: Awaited<ReturnType<Signup['prepareDeployment']>> = await request('deployment/review', {});
  if (deployment.walletAddress.toLowerCase() !== view!.walletAddress?.toLowerCase() || deployment.recoveryOwner.toLowerCase() !== view!.recoveryOwner.toLowerCase()
    || deployment.initializerHash !== view!.initializerHash) throw new Error('The wallet creation review changed.');
  await announce('Approve creating your wallet', `A passkey prompt approves creating wallet ${short(deployment.walletAddress)} on Base. This makes it yours.`);
  message('Approve creating your wallet: use your passkey in the prompt.');
  const proof = await assertion(deployment.challenge, view!.rpId, deployment.credentialId);
  await send('deployment/approve', { approvalId: deployment.id, assertion: proof });
}
form.addEventListener('submit', event => { event.preventDefault(); void run(async () => {
  const passkeyName = name.value.trim(), kit = kitChoice();
  if (kit && !recoverySecret) recoverySecret = createWalletRecoverySecret();
  const owner = kit ? recoverySecret!.recoveryOwner : await recoveryOwner();
  await send('begin', { recoveryOwner: owner, passkeyName });
  if (kit) localStorage.setItem('center:signup:kit:' + view!.enrollmentId, '1');
  // Go straight into the passkey prompt; a cancelled prompt leaves the explicit button as the fallback.
  if (view?.phase === 'awaiting_registration') await advance();
}); });
el('recovery-method').addEventListener('change', render);
el('recovery-download').addEventListener('click', () => { void run(async () => {
  if (!recoverySecret) throw new Error('Restore your recovery words first.');
  const encoded = serializeWalletRecoveryKit(recoverySecret, kitIdentity());
  const url = URL.createObjectURL(new Blob([encoded], { type: 'application/json' })); downloadUrls.add(url);
  const link = document.createElement('a'); link.href = url; link.download = 'juicebox-wallet-recovery-kit.json';
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.delete(url); }, 1000);
  kitSavedWallet = view!.walletAddress!;
  message('Recovery kit saved. Keep it somewhere private, then continue.');
}); });
el<HTMLInputElement>('recovery-file').addEventListener('change', event => { void run(async () => {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = '';
  if (!file || file.size > 8192) throw new Error('Choose the recovery kit you saved for this wallet.');
  const kit = readWalletRecoveryKit(await file.text(), kitIdentity());
  recoverySecret = view?.phase === 'awaiting_possession' || view?.phase === 'awaiting_registration'
    ? { mnemonic: kit.mnemonic, recoveryOwner: kit.recoveryOwner } : null;
  kitVerifiedWallet = kitSavedWallet = view!.walletAddress; el<HTMLTextAreaElement>('recovery-words').value = '';
  message('Recovery kit verified.');
}); });
el('recovery-restore').addEventListener('click', () => { void run(async () => {
  if (!view) throw new Error('Resume your signup first.');
  const input = el<HTMLTextAreaElement>('recovery-words'), mnemonic = input.value; input.value = '';
  const account = recoveryAccountFromPhrase(mnemonic, view.recoveryOwner);
  recoverySecret = { mnemonic: mnemonic.trim().toLowerCase().replace(/\s+/g, ' '), recoveryOwner: account.address };
  message('Recovery words restored. Save the complete kit with your wallet address before creating the wallet.');
}); });
next.addEventListener('click', () => { void run(advance); });
restart.addEventListener('click', () => { void run(async () => {
  await send('restart', {}); csrf = ''; pending = null; recoverySecret = null; kitSavedWallet = kitVerifiedWallet = null;
}); });
check.addEventListener('click', () => { void run(async () => {
  message('Checking your signup…'); await observe(); pollCount = 0;
  if (view?.phase === 'deploying') message('Still creating your wallet. Checked just now; this page keeps checking while it is open.');
}); });
cancel.addEventListener('click', () => native?.abort());
async function walletRequest(path: string, body: unknown, proof?: string): Promise<any> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal, method: 'POST',
      headers: { 'content-type': 'application/json', 'x-center-wallet-request': '1', ...(proof ? { 'x-center-wallet-csrf': proof } : {}) }, body: JSON.stringify(body) });
    if (!response.ok) throw await failure(response);
    return await response.json();
  } finally { clearTimeout(timer); }
}
/** The same sign-in as the wallet landing page, then that page shows the session (and any app return). */
async function login() {
  await announce('Log in', 'A passkey prompt logs you in to your wallet.');
  const begun = await walletRequest('/wallet/login/begin', {}), publicKey = begun.publicKey;
  if (publicKey?.rpId !== location.hostname || publicKey.userVerification !== 'required' || typeof begun.loginId !== 'string' || typeof begun.csrfToken !== 'string') throw new Error('The wallet host changed.');
  const challenge = decode(publicKey.challenge); if (challenge.length !== 32) throw new Error('Invalid passkey challenge.');
  message('Log in with the prompt.');
  const proof = await assertion('0x' + Array.from(challenge, byte => byte.toString(16).padStart(2, '0')).join(''), publicKey.rpId);
  const result = await walletRequest('/wallet/login/complete', { loginId: begun.loginId, assertion: proof }, begun.csrfToken);
  if (result?.session?.loginId !== begun.loginId) throw new Error('Sign-in could not be confirmed.');
  location.replace('/wallet' + location.search);
}
async function resumeSignup() {
  await announce('Pick up your signup', 'That passkey belongs to an unfinished signup. One more passkey prompt picks it up where you left off.');
  const begun = await request('resume/begin', {}); message('Pick up your signup with the prompt.');
  const proof = await assertion(begun.challenge.challenge, begun.challenge.rpId);
  await send('resume/complete', { resumeId: begun.challenge.id, assertion: proof }, begun.csrfToken);
}
resume.addEventListener('click', event => { event.preventDefault(); if (busy || pending) return; void run(async () => {
  // A passkey with a finished wallet logs in; one from an unfinished signup resumes it.
  try { await login(); return; } catch (error) { if (!(error instanceof HttpFailure) || ![400, 401, 403, 404, 410].includes(error.status)) throw error; }
  await resumeSignup();
}); });
const timer = setInterval(() => {
  if (!busy && !pending && view?.phase === 'deploying' && !document.hidden && navigator.onLine && pollCount++ < 150) void run(observe);
}, 2000);
window.addEventListener('pagehide', () => {
  disposed = true; native?.abort(); clearInterval(timer); recoverySecret = null;
  el('recovery-phrase').textContent = ''; el<HTMLTextAreaElement>('recovery-words').value = '';
  for (const url of downloadUrls) URL.revokeObjectURL(url); downloadUrls.clear();
}, { once: true });
void run(async () => {
  const url = new URL(location.href);
  if (url.hash || url.searchParams.size > 1 || [...url.searchParams].some(([key, value]) => key === 'intent' ? !/^[A-Za-z0-9_-]{43}$/.test(value)
    : key === 'payment' ? !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) : true)) throw new Error('Return to the original app to start this signup.');
  el<HTMLAnchorElement>('wallet-back').href = '/wallet' + url.search;
  await observe();
});
