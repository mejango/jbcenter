import { getAddress, hashTypedData, isAddress, type Address, type Hex } from 'viem';
import type { createLocalWalletSignup } from '../wallet/signup.js';
import { base } from './walletBase.js';
import { createWalletRecoverySecret, recoveryAccountFromPhrase, serializeWalletRecoveryKit,
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
let view: View | null = null, known = false, busy = false, csrf = '', native: AbortController | null = null;
// A log-in in progress is the whole page; the signup form waits until it fails.
let loggingIn = false;
let pending: { path: string; body: unknown; csrf: string } | null = null;
let disposed = false, pollCount = 0;
let recoverySecret: WalletRecoverySecret | null = null, kitSavedWallet: string | null = null;
const downloadUrls = new Set<string>();
// The choice outlives the form: a resumed signup reads it back by enrollment.
type RecoveryChoice = 'kit' | 'wallet';
const choice = (): RecoveryChoice => (el<HTMLFieldSetElement>('recovery-method').querySelector<HTMLInputElement>('input:checked')?.value ?? 'kit') as RecoveryChoice;
const modeKey = (id: string) => 'center:signup:kit:' + id;
const mode = (): RecoveryChoice => {
  if (!view) return choice();
  const stored = localStorage.getItem(modeKey(view.enrollmentId));
  return stored === '1' || stored === 'kit' ? 'kit' : 'wallet';
};
/** The backup words live in this browser (made-for-you password or chosen password) rather than in an external wallet. */
const kitMode = () => mode() !== 'wallet';
function kitIdentity(): WalletRecoveryKitIdentity {
  if (!view?.walletAddress || !view.initializerHash) throw new Error('Create your passkey before saving the complete backup file.');
  return { network: 'base', chainId: 8453, walletAddress: view.walletAddress, recoveryOwner: view.recoveryOwner, initializerHash: view.initializerHash };
}
const steps: Record<View['phase'], string> = {
  awaiting_registration: 'Create your passkey.', awaiting_possession: 'Your passkey is ready. Create your account with it.',
  awaiting_deployment_approval: 'Your passkey is ready. Approve creation of your account.',
  deploying: 'Creating your account. This usually takes about a minute. Keep this page open, or come back later with your passkey.',
  deployment_failed: 'Account creation did not complete. Keep this signup for recovery; do not send funds.',
  awaiting_activation: 'Your account is ready.', preparing_sign_in: 'Preparing your login. This can take up to a minute…',
  ready_to_sign_in: 'Your account is ready. Log in with your passkey.',
  expired: "This recent signup wasn't completed in time. Try again.",
};
// While work is in flight the status line's mark spins (Croptop's text ticker) instead of showing the lightning.
// A native prompt waiting on the user is not work in flight, so the mark holds still for it.
const polling = () => view?.phase === 'deploying' || view?.phase === 'preparing_sign_in';
const waiting = () => (busy && !native) || polling();
function message(value: string, error = false) { status.textContent = value; status.dataset.state = error ? 'error' : waiting() ? 'busy' : 'ready'; }
/** The first word links to the creation transaction on Basescan when the signup has one. */
function messageLinked(word: string, rest: string) {
  const hash = view?.transactionHash;
  if (!hash) { message(word + rest); return; }
  const link = document.createElement('a'); link.href = 'https://basescan.org/tx/' + hash; link.target = '_blank'; link.rel = 'noopener'; link.textContent = word;
  status.replaceChildren(link, document.createTextNode(rest)); status.dataset.state = waiting() ? 'busy' : 'ready';
}
function spin() { if (waiting()) { if (status.dataset.state !== 'error') status.dataset.state = 'busy'; } else if (status.dataset.state === 'busy') status.dataset.state = 'ready'; }
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
    super(code === 'WALLET_DEPLOYMENT_BUSY' ? 'Another account is being created right now. Try again in a minute.' : 'Signup could not be confirmed. Check the original signup and retry.');
  }
}
async function failure(response: Response) {
  try { const code = (await response.json())?.error?.code; return new HttpFailure(response.status, typeof code === 'string' ? code : ''); }
  catch { return new HttpFailure(response.status); }
}
// Setup reviews inspect the wallet on Base (tens of provider reads); they get a longer budget.
const slowPaths = new Set(['activate', 'login/complete']);
async function request(path: string, body?: unknown, proof = csrf): Promise<any> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), slowPaths.has(path) ? 90000 : 15000);
  try {
    const response = await fetch(`${base}/signup/` + path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
      ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-center-wallet-request': '1',
        ...(proof ? { 'x-center-wallet-csrf': proof } : {}) }, body: JSON.stringify(body) }) });
    if (!response.ok) throw await failure(response);
    return await response.json();
  } finally { clearTimeout(timer); }
}
function accept(result: { view: View | null; csrfToken?: string }) {
  if (result.view) {
    if (result.view.origin !== location.origin || result.view.rpId !== location.hostname || !(result.view.phase in steps)) throw new Error('The account host or signup changed.');
    if (view && view.enrollmentId !== result.view.enrollmentId && !pending?.path.startsWith('resume/')) throw new Error('Another signup replaced this page. Reload before continuing.');
  }
  view = result.view; known = true;
  if (result.csrfToken) { if (decode(result.csrfToken).length !== 32) throw new Error('Invalid signup context.'); csrf = result.csrfToken; }
  if (view?.phase === 'deploying') messageLinked('Creating', steps.deploying.slice('Creating'.length));
  else message(view ? steps[view.phase] + (view.phase === 'awaiting_activation' ? mode() === 'kit' ? recoverySecret ? ' Now, save your backup password.' : '' : ' Continue to log in.' : '') : '');
  if (view?.phase === 'ready_to_sign_in' && kitSavedWallet === view.walletAddress) recoverySecret = null;
}
function render() {
  spin();
  form.querySelector('button')!.disabled = busy;
  name.disabled = busy;
  // The kit is presented once the wallet exists. Earlier phases still need the words in memory
  // to sign the enrollment; a reload before then strands the signup, so say so and offer a fresh start.
  const kitPhase = !!view && ['awaiting_activation', 'preparing_sign_in', 'ready_to_sign_in'].includes(view.phase);
  const stranded = kitMode() && !recoverySecret && !!view && ['awaiting_registration', 'awaiting_possession'].includes(view.phase);
  // A stranded attempt that never created a passkey lost nothing worth mentioning: show the clean form.
  if (stranded) message(view!.phase === 'awaiting_possession' ? 'Your last signup cannot continue without its backup password. Sign up again with a new passkey.' : '');
  form.hidden = !known || (!!view && !stranded) || loggingIn; details.hidden = !view || stranded;
  // A default name that tells passkeys apart later: the site, then when it was made.
  if (!form.hidden && !name.value) {
    const now = new Date();
    name.value = `${location.hostname} ${now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} ${now.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }
  el<HTMLFieldSetElement>('recovery-method').disabled = busy; // Inside the form: gone once signup begins.
  const showKit = kitPhase && mode() === 'kit';
  el('recovery-kit').hidden = !showKit;
  const phrase = el<HTMLInputElement>('recovery-phrase');
  phrase.value = recoverySecret?.mnemonic ?? ''; el('recovery-secret').hidden = !(showKit && recoverySecret);
  el('recovery-show').textContent = phrase.type === 'password' ? 'Show' : 'Hide';
  // Only a reload before saving loses the password from memory; pasting it back allows the file save.
  el('recovery-restore-box').hidden = !showKit || !!recoverySecret;
  el('recovery-kit-note').hidden = !recoverySecret; el('recovery-warning').hidden = !recoverySecret; el<HTMLButtonElement>('recovery-download').hidden = !recoverySecret;
  el<HTMLButtonElement>('recovery-download').disabled = busy;
  el<HTMLButtonElement>('recovery-share').hidden = !recoverySecret || typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function';
  el<HTMLButtonElement>('recovery-share').disabled = busy;
  el('signup-name').textContent = view?.passkeyName ?? '';
  el('signup-recovery-label').textContent = mode() === 'wallet' ? 'Recovery wallet' : showKit && recoverySecret ? 'Backup password'
    : showKit ? 'Backup password address' : 'Recovery';
  el('signup-recovery').textContent = mode() === 'wallet' ? view?.recoveryOwner ?? ''
    : kitPhase ? recoverySecret ? '' : view?.recoveryOwner ?? '' : 'A backup password you get once the account exists';
  el('signup-address').textContent = view?.walletAddress ?? 'Not created yet';
  const label = view?.phase === 'awaiting_registration' ? 'Create passkey'
    : view?.phase === 'awaiting_possession' || view?.phase === 'awaiting_deployment_approval' ? 'Create account'
    : view?.phase === 'awaiting_activation' ? 'Continue' : view?.phase === 'ready_to_sign_in' ? 'Log in' : view?.phase === 'expired' ? 'Sign up' : null;
  next.hidden = !label || !!pending || stranded; next.textContent = label; next.disabled = busy;
  el<HTMLButtonElement>('recovery-show').disabled = busy; el<HTMLButtonElement>('recovery-copy').disabled = busy;
  // "log in" resumes with a passkey; a finished wallet lands at sign-in. Once the state is known (or its load failed),
  // it stays offered unless a signup with a passkey is under way, so a returning user is never without a way in.
  el('signup-intro').hidden = !known || loggingIn || (!!view && view.phase !== 'expired' && view.phase !== 'awaiting_registration');
  // "Check signup" only matters for a lost reply or while creation is in progress.
  check.hidden = stranded || !(pending || view?.phase === 'deploying'); check.disabled = busy;
  // One filled button per page: the check is the primary only when it stands alone.
  check.classList.toggle('link', !form.hidden); check.classList.toggle('secondary', form.hidden && !next.hidden);
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
    known = true; // Whatever failed, the page stops waiting and offers its ways in.
    if (error instanceof HttpFailure && error.status >= 400 && error.status < 500) {
      pending = null;
      try { accept(await request('state')); } catch { /* Resume with a fresh proof if the cookie is no longer valid. */ }
    }
    message(error instanceof DOMException && native && (error.name === 'AbortError' || (error.name === 'NotAllowedError' && native.signal.aborted))
      ? 'Passkey prompt cancelled. You can try again.'
      : error instanceof DOMException && native
      ? `The passkey prompt did not complete (${error.name}${error.message ? ': ' + error.message : ''}). If your passkey manager just saved this passkey, wait a moment and try again.`
      : error instanceof DOMException && error.name === 'AbortError'
      ? 'The account service took too long to answer. Try again.'
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
/** Discoverable on purpose: Center pins the expected passkey when it verifies; an allow list only lets
 * iOS refuse a passkey it cannot preselect. */
async function assertion(challenge: string, rpId: string) {
  if (rpId !== location.hostname || !window.isSecureContext) throw new Error('Open the original secure wallet page.');
  native = new AbortController(); render();
  const value = await navigator.credentials.get({ publicKey: { rpId, challenge: hexBytes(challenge), userVerification: 'required', timeout: 90000 }, signal: native.signal });
  if (!(value instanceof PublicKeyCredential) || !(value.response instanceof AuthenticatorAssertionResponse)) throw new Error('The passkey response is unavailable.');
  const response = value.response; native = null;
  return { credentialId: encode(value.rawId), userHandle: response.userHandle ? encode(response.userHandle) : null,
    authenticatorData: encode(response.authenticatorData), clientDataJSON: encode(response.clientDataJSON), signature: encode(response.signature) };
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
    // The recovery owner signs the enrollment document; the single passkey prompt then approves
    // creation, which also proves possession of the new passkey.
    const document = view.possession.document, value = document.message;
    if (document.domain.name !== 'Juicebox Center Wallet Enrollment' || document.domain.version !== '1' || document.domain.chainId !== 8453
      || document.primaryType !== 'WalletEnrollment' || value.purpose !== 'registration' || value.enrollmentId !== view.enrollmentId
      || value.origin !== location.origin || value.rpId !== location.hostname || value.initializerHash !== view.initializerHash
      || getAddress(value.recoveryOwner) !== getAddress(view.recoveryOwner) || getAddress(value.predictedSafe) !== getAddress(view.walletAddress!)
      || getAddress(document.domain.verifyingContract) !== getAddress(view.walletAddress!)
      || hashTypedData(document) !== view.possession.challenge || BigInt(value.expiresAtMs) <= BigInt(Date.now())) throw new Error('The account enrollment review changed.');
    let backupSignature: unknown;
    if (kitMode()) {
      if (!recoverySecret) throw new Error('Restore your backup password or saved backup file before continuing this signup.');
      backupSignature = await recoveryAccountFromPhrase(recoverySecret.mnemonic, view.recoveryOwner).signTypedData(document);
    } else {
      const owner = await recoveryOwner(view.recoveryOwner);
      backupSignature = await provider().request({ method: 'eth_signTypedData_v4', params: [owner, JSON.stringify(document)] });
    }
    await approve(backupSignature as Hex);
  } else if (view.phase === 'awaiting_deployment_approval') {
    await approve();
  } else if (view.phase === 'awaiting_activation') {
    if (mode() === 'kit' && recoverySecret && kitSavedWallet !== view.walletAddress) {
      // Nothing saved, shared or copied: say so once, then respect the choice.
      await announce('Nothing saved yet', 'Without the backup password you cannot get back into this account if you lose the passkey. Continue anyway?');
      kitSavedWallet = view.walletAddress;
    }
    // The passkey already consented to this account when it created the wallet; Center binds the
    // account from that proof. No prompt: reading and preparing need no grant, payments still do.
    messageLinked('Checking', ' your new account. This can take up to a minute…');
    await send('activate', {});
  } else if (view.phase === 'ready_to_sign_in') {
    await login();
  }
}
const current = () => view;
async function approve(backupSignature?: Hex) {
  const deployment: Awaited<ReturnType<Signup['prepareDeployment']>> = await request('deployment/review', {});
  if (deployment.walletAddress.toLowerCase() !== view!.walletAddress?.toLowerCase() || deployment.recoveryOwner.toLowerCase() !== view!.recoveryOwner.toLowerCase()
    || deployment.initializerHash !== view!.initializerHash) throw new Error('The account creation review changed.');
  await announce('Approve creating your account', 'A passkey prompt approves creating your account, making it yours.');
  message('Approve creating your account: use your passkey in the prompt.');
  const proof = await assertion(deployment.challenge, view!.rpId);
  await send('deployment/approve', { approvalId: deployment.id, assertion: proof, ...(backupSignature ? { backupSignature } : {}) });
}
form.addEventListener('submit', event => { event.preventDefault(); void run(async () => {
  const passkeyName = name.value.trim(), selected = choice();
  if (selected === 'kit' && !recoverySecret) recoverySecret = createWalletRecoverySecret();
  const owner = selected === 'wallet' ? await recoveryOwner() : recoverySecret!.recoveryOwner;
  await send('begin', { recoveryOwner: owner, passkeyName });
  localStorage.setItem(modeKey(view!.enrollmentId), selected);
  // Go straight into the passkey prompt; a cancelled prompt leaves the explicit button as the fallback.
  if (view?.phase === 'awaiting_registration') await advance();
}); });
el('recovery-method').addEventListener('change', render);
const backupFileName = 'juicebox-account-backup.json';
el('recovery-download').addEventListener('click', () => { void run(async () => {
  if (!recoverySecret) throw new Error('Restore your backup password first.');
  const encoded = serializeWalletRecoveryKit(recoverySecret, kitIdentity());
  const url = URL.createObjectURL(new Blob([encoded], { type: 'application/json' })); downloadUrls.add(url);
  const link = document.createElement('a'); link.href = url; link.download = backupFileName;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.delete(url); }, 1000);
  kitSavedWallet = view!.walletAddress!;
  message('Backup file saved. Keep it somewhere private, then continue.');
}); });
el('recovery-share').addEventListener('click', () => { void run(async () => {
  if (!recoverySecret) throw new Error('Restore your backup password first.');
  const file = new File([serializeWalletRecoveryKit(recoverySecret, kitIdentity())], backupFileName, { type: 'application/json' });
  if (!navigator.canShare({ files: [file] })) throw new Error('This device cannot share files. Save the backup file instead.');
  try { await navigator.share({ files: [file], title: 'Juicebox account backup' }); }
  catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('Sharing cancelled. Save the backup file, or share again.');
    throw new Error('Your browser would not open its share sheet. Save the backup file instead.');
  }
  kitSavedWallet = view!.walletAddress!;
  message('Backup file shared. Make sure it reached somewhere you trust, then continue.');
}); });
el('recovery-show').addEventListener('click', () => {
  const input = el<HTMLInputElement>('recovery-phrase'); input.type = input.type === 'password' ? 'text' : 'password'; render();
});
el('recovery-copy').addEventListener('click', () => { void run(async () => {
  if (!recoverySecret) throw new Error('Restore your backup password first.');
  await navigator.clipboard.writeText(recoverySecret.mnemonic);
  kitSavedWallet = view!.walletAddress!;
  message('Backup password copied. Paste it somewhere private, then clear your clipboard.');
}); });
next.addEventListener('click', () => { void run(advance); });
el('recovery-restart-link').addEventListener('click', event => { event.preventDefault(); restart.click(); });
restart.addEventListener('click', () => { void run(async () => {
  await send('restart', {}); csrf = ''; pending = null; recoverySecret = null; kitSavedWallet = null;
}); });
check.addEventListener('click', () => { void run(async () => {
  message('Checking your signup…'); await observe(); pollCount = 0;
  if (view?.phase === 'deploying') message('Still creating your account. Checked just now; this page keeps checking while it is open.');
}); });
cancel.addEventListener('click', () => native?.abort());
// Login completion may refresh the account's authority on Base first (the site waits up to 90 s for it).
async function walletRequest(path: string, body: unknown, proof?: string, timeoutMs = 15000): Promise<any> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal, method: 'POST',
      headers: { 'content-type': 'application/json', 'x-center-wallet-request': '1', ...(proof ? { 'x-center-wallet-csrf': proof } : {}) }, body: JSON.stringify(body) });
    if (!response.ok) throw await failure(response);
    return await response.json();
  } finally { clearTimeout(timer); }
}
/** The same sign-in as the wallet landing page, then that page shows the session (and any app return). */
async function login() {
  loggingIn = true; render();
  try { await loginFlow(); } finally { loggingIn = false; }
}
async function loginFlow() {
  await announce('Log in', 'A passkey prompt logs you in to your account.');
  message('Logging in…');
  const begun = await walletRequest(`${base}/login/begin`, {}), publicKey = begun.publicKey;
  if (publicKey?.rpId !== location.hostname || publicKey.userVerification !== 'required' || typeof begun.loginId !== 'string' || typeof begun.csrfToken !== 'string') throw new Error('The account host changed.');
  const challenge = decode(publicKey.challenge); if (challenge.length !== 32) throw new Error('Invalid passkey challenge.');
  message('Log in with the prompt.');
  const proof = await assertion('0x' + Array.from(challenge, byte => byte.toString(16).padStart(2, '0')).join(''), publicKey.rpId);
  message('Checking your account. This can take up to a minute…');
  const result = await walletRequest(`${base}/login/complete`, { loginId: begun.loginId, assertion: proof }, begun.csrfToken, 100000);
  if (result?.session?.loginId !== begun.loginId) throw new Error('Sign-in could not be confirmed.');
  location.replace((base || '/') + location.search);
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
  if (!busy && !pending && polling() && !document.hidden && navigator.onLine && pollCount++ < 150) void run(observe);
}, 2000);
window.addEventListener('pagehide', () => {
  disposed = true; native?.abort(); clearInterval(timer); recoverySecret = null;
  el<HTMLInputElement>('recovery-phrase').value = '';
  for (const url of downloadUrls) URL.revokeObjectURL(url); downloadUrls.clear();
}, { once: true });
void run(async () => {
  const url = new URL(location.href);
  if (url.hash || url.searchParams.size > 1 || [...url.searchParams].some(([key, value]) => key === 'intent' ? !/^[A-Za-z0-9_-]{43}$/.test(value)
    : key === 'payment' ? !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) : true)) throw new Error('Return to the original app to start this signup.');
  el<HTMLAnchorElement>('wallet-back').href = (base || '/') + url.search;
  await observe();
});
