import { base } from './walletBase.js';
import { formatUnits } from 'viem';
import { getUserOperationHash, normalizeUserOperation, uoCanonical, userOperationMaximumCost } from '../userOperations/codec.js';
import { safe7579PasskeyOwnerSigningPayload } from '../smartAccounts/passkeySignatures.js';
import { decodeSafe7579Execution } from '../smartAccounts/accountExecution.js';
import { recognizeWalletV6UsdcPayment } from '../userOperations/semantics.js';
import type { WalletPaymentCentralPublic } from '../wallet/paymentPublic.js';

// Native assertions and CSRF values stay in this page's memory. A reload recovers
// the durable review by ID; no proof is put in storage, a URL or diagnostics.
type Json = Record<string, unknown>;
type Assertion = { credentialId: string; userHandle: string | null; authenticatorData: string; clientDataJSON: string; signature: string };
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = element('payment-status'), details = element('payment-review');
const approve = element<HTMLButtonElement>('payment-approve'), cancel = element<HTMLButtonElement>('payment-cancel');
const cancelPrompt = element<HTMLButtonElement>('payment-prompt-cancel'), retry = element<HTMLButtonElement>('payment-retry');
const signIn = element<HTMLAnchorElement>('payment-signin'), returnToApp = element<HTMLAnchorElement>('payment-return');
let id = '', rpId = '', accountId = '', csrf = '', sessionExpires = 0;
let review: WalletPaymentCentralPublic | null = null, immutable = '', busy = false, blocked = false;
let uncertain = false, needsSignIn = false, canRetry = false, nativePrompt: AbortController | null = null;
let pending: Assertion | null = null;
class InvalidResponse extends Error {}
class HttpFailure extends Error { constructor(readonly status: number) { super('Payment request failed'); } }
const fail = (): never => { throw new InvalidResponse(); };
function record(value: unknown): Json { return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : fail(); }
function text(value: unknown, max = 2048, empty = false): string {
  return typeof value === 'string' && (empty || value.length > 0) && value.length <= max ? value : fail();
}
function integer(value: unknown): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fail(); }
function decimal(value: unknown): string { const v = text(value, 78); return /^(0|[1-9][0-9]*)$/.test(v) && BigInt(v) < 2n ** 256n ? v : fail(); }
function address(value: unknown): string { const v = text(value, 42); return /^0x[0-9a-fA-F]{40}$/.test(v) ? v : fail(); }
function uuid(value: unknown): string { const v = text(value, 36); return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v) ? v : fail(); }
function encode(value: ArrayBuffer): string { return btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
function decode(value: unknown, max = 4096): Uint8Array<ArrayBuffer> {
  const encoded = text(value, max); if (!/^[A-Za-z0-9_-]+$/.test(encoded)) fail();
  let bytes: Uint8Array<ArrayBuffer>; try { bytes = Uint8Array.from(atob(encoded.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)); } catch { return fail(); }
  if (encode(bytes.buffer) !== encoded) fail(); return bytes;
}
function token(value: unknown): string { return decode(value).length === 32 ? value as string : fail(); }
function setStatus(state: string, message: string) { status.dataset.state = state; status.textContent = message; }
function expired() { return !!review && (review.expiresAtMs <= Date.now() || sessionExpires <= Date.now()); }
function render() {
  const actionable = review?.status === 'pending' && !expired() && !uncertain && !blocked && !needsSignIn && status.dataset.state === 'ready';
  approve.hidden = !actionable; approve.disabled = busy;
  cancel.hidden = !actionable; cancel.disabled = busy;
  cancelPrompt.hidden = !nativePrompt;
  retry.hidden = !canRetry || busy || blocked;
  signIn.hidden = !needsSignIn || blocked;
  returnToApp.hidden = !review || !['approved', 'cancelled'].includes(review.status) || uncertain || blocked || busy;
  details.hidden = !review;
}
async function request(path: string, body?: unknown): Promise<Json> {
  const controller = new AbortController(), started = performance.now(), timer = setTimeout(() => controller.abort(), 10_000);
  const withinDeadline = () => { if (controller.signal.aborted || performance.now() - started >= 10_000) throw new Error('Payment response unavailable'); };
  try {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body), headers: {
        'content-type': 'application/json', 'x-center-wallet-request': '1', 'x-center-wallet-csrf': csrf } }) });
    withinDeadline(); if (!response.ok) throw new HttpFailure(response.status);
    if (!response.body) throw new InvalidResponse();
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); withinDeadline(); if (done) break;
        total += value.byteLength; if (total > 1_048_576) fail(); chunks.push(value);
      }
    } catch (error) { void reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const parsed = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); withinDeadline(); return parsed;
  } finally { clearTimeout(timer); }
}
function callback(value: WalletPaymentCentralPublic): string {
  const href = text(value.app.callbackUri, 4096), target = new URL(href);
  if (target.origin !== value.app.origin || target.username || target.password || target.search || target.hash || target.href !== href ||
    !['https:', 'http:'].includes(target.protocol)) fail();
  target.search = new URLSearchParams({ review: value.id, state: token(value.state), iss: value.issuer }).toString(); return target.href;
}
function checkReview(input: unknown): WalletPaymentCentralPublic {
  const value = record(input) as unknown as WalletPaymentCentralPublic;
  if (value.version !== 'center-wallet-payment-review-v1' || uuid(value.id) !== id || value.issuer !== location.origin || value.accountId !== accountId ||
    value.chainId !== 8453 || !['pending', 'approved', 'cancelled'].includes(value.status)) fail();
  if (review && review.status !== 'pending' && value.status !== review.status) fail();
  integer(value.createdAtMs); integer(value.expiresAtMs); callback(value);
  const payment = record(value.payment);
  if (payment.kind !== 'v6-usdc-pay' || payment.chainId !== 8453 || `eip155:8453:${address(payment.account).toLowerCase()}` !== accountId) fail();
  address(payment.token); address(payment.terminal); address(payment.beneficiary);
  decimal(payment.amount); decimal(payment.projectId); decimal(payment.minimumReturnedTokens); text(payment.memo, 32768, true);
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(text(payment.metadata, 65538))) fail();
  const operation = normalizeUserOperation(value.operation);
  if (operation.sender.toLowerCase() !== String(payment.account).toLowerCase() || operation.signature !== '0x' ||
    getUserOperationHash(operation, value.entryPoint, 8453) !== value.operationHash) fail();
  const calls = decodeSafe7579Execution(operation.callData).map((call, index) => ({ chainId: 8453, to: call.target, value: call.value,
    data: call.callData, label: '', decoded: {}, dependsOn: index ? [index - 1] : [] }));
  const p = value.payment, project = { chainId: 8453, projectId: p.projectId, version: 6 as const };
  // The shared recognizer derives every displayed economic fact from calldata.
  // A valid SafeOp hash alone cannot bind a separately supplied display summary.
  const derived = recognizeWalletV6UsdcPayment({ draft: { operation: 'pay', account: operation.sender, project, calls, evidence: [], warnings: [],
    summary: { operation: 'pay', project, account: operation.sender, terminal: p.terminal, terminalPath: [p.terminal],
      routerGateway: null, route: 'multi-terminal', payment: { token: p.token, amount: p.amount, unit: 'token-base-units' },
      beneficiary: p.beneficiary, minimumBeneficiaryTokenCount: p.minimumReturnedTokens, metadata: p.metadata } } },
    value.stepIndexes, { chainId: 8453, token: p.token, directV6Terminal: p.terminal });
  if (!derived || uoCanonical(derived) !== uoCanonical(p)) fail();
  const signing = safe7579PasskeyOwnerSigningPayload({ operation, chainId: 8453, entryPoint: value.entryPoint, safe7579: value.safe7579,
    validAfter: decimal(value.signing.validAfter), validUntil: decimal(value.signing.validUntil) });
  if (signing.digest !== value.signing.digest || signing.signedData !== value.signing.signedData) fail();
  const passkey = record(value.passkey);
  if (passkey.rpId !== rpId || passkey.userVerification !== 'required' || decode(passkey.challenge).length !== 32 ||
    `0x${Array.from(decode(passkey.challenge), byte => byte.toString(16).padStart(2, '0')).join('')}` !== signing.digest) fail();
  decode(passkey.credentialId);
  // Status may advance, but the displayed terms, exact operation and selected
  // credential cannot change while recovering an interrupted approval.
  const { status: ignoredStatus, approvedAtMs, cancelledAtMs, operationState, ...stable } = value;
  const next = JSON.stringify(stable); if (immutable && immutable !== next) fail();
  immutable = next; return structuredClone(value);
}
function accept(input: unknown) {
  review = checkReview(input);
  const payment = review.payment;
  for (const [name, value] of Object.entries({ amount: `${formatUnits(BigInt(payment.amount), 6)} USDC`, project: payment.projectId,
    app: review.app.origin, account: payment.account, beneficiary: payment.beneficiary, minimum: payment.minimumReturnedTokens,
    memo: payment.memo || 'No memo', fee: `${formatUnits(userOperationMaximumCost(review.operation), 18)} ETH`, token: payment.token,
    terminal: payment.terminal, metadata: payment.metadata, operation: review.operationHash, expiry: new Date(review.expiresAtMs).toLocaleString() }))
    element(`payment-${name}`).textContent = value;
  returnToApp.href = callback(review);
  if (review.status === 'approved') { pending = null; uncertain = false; setStatus('approved', 'Approved. Check the result in the app.'); }
  else if (review.status === 'cancelled') { pending = null; uncertain = false; setStatus('cancelled', 'Payment declined. No new approval was issued.'); }
  else if (expired()) setStatus('expired', 'This payment approval expired. Return to your app to review a fresh payment.');
  else setStatus('ready', 'Check the payment details, then approve with your passkey.');
}
async function readSession() {
  const result = await request(`${base}/session`);
  if (result.session === null) { needsSignIn = true; csrf = ''; setStatus('sign-in', 'Sign in to review this payment.'); return false; }
  const session = record(result.session), nextAccount = text(session.accountId);
  if (session.chainId !== 8453 || `eip155:8453:${address(session.walletAddress).toLowerCase()}` !== nextAccount || (accountId && accountId !== nextAccount)) fail();
  sessionExpires = integer(session.expiresAtMs); if (sessionExpires <= Date.now()) throw new HttpFailure(401);
  accountId = nextAccount; csrf = token(result.csrfToken); needsSignIn = false; return true;
}
async function load() {
  const url = new URL(location.href);
  if (url.hash || url.searchParams.size !== 1 || !url.searchParams.has('review')) fail();
  id = uuid(url.searchParams.get('review')); signIn.href = `${base || '/'}?payment=${id}`;
  const config = await request(`${base}/config`);
  if (config.version !== 'center-wallet-v1' || config.issuer !== location.origin) fail();
  rpId = text(config.rpId, 253); if (location.hostname !== rpId && !location.hostname.endsWith(`.${rpId}`)) fail();
  await recover();
}
async function recover() {
  if (!await readSession()) return;
  accept(await request(`${base}/payment-reviews/${id}`));
  if (review?.status === 'pending' && pending && !expired()) await submitApproval();
  else if (review?.status === 'pending' && uncertain) {
    // A cancellation may have failed before reaching the server. Reading pending
    // resolves it; a retained approval is retried above with the exact same proof.
    uncertain = false;
  }
}
async function submitApproval() {
  if (!pending || !review || review.status !== 'pending' || expired()) throw new HttpFailure(410);
  uncertain = true; nativePrompt = null; render(); setStatus('checking', 'Confirming your payment approval…');
  const result = await request(`${base}/payment-reviews/${id}/approve`, { assertion: pending });
  const checked = checkReview(result.review);
  if (checked.status !== 'approved' || typeof result.replayed !== 'boolean' || result.redirectUri !== callback(checked)) fail();
  accept(checked);
  goBackToApp();
}
// A fresh approval goes back to the app on its own after a beat of confirmation; the link stays
// for a blocked navigation or a reload.
let returning = false;
function goBackToApp() {
  if (returning || !review || review.status !== 'approved') return;
  returning = true;
  // Approval is the send: Center submits the operation now, and the app shows what happened to it.
  setStatus('approved', 'Approved. Sending on Base… the app will show the result.'); render();
  const back = callback(review); setTimeout(() => location.assign(back), 800);
}
async function approvePayment() {
  if (!review || review.status !== 'pending' || expired() || uncertain) return;
  if (!window.isSecureContext || !navigator.credentials?.get) { blocked = true; setStatus('error', 'This browser cannot use passkeys here. Open Center in a browser that supports passkeys.'); return; }
  // No network await precedes get(): it runs from the explicit approval click.
  nativePrompt = new AbortController(); setStatus('authenticating', 'Use your passkey to approve this payment.'); render();
  const credential = await navigator.credentials.get({ publicKey: { rpId, challenge: decode(review.passkey.challenge), userVerification: 'required', timeout: 90_000 }, signal: nativePrompt.signal });
  if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAssertionResponse) ||
    encode(credential.rawId) !== review.passkey.credentialId) throw new InvalidResponse();
  const response = credential.response;
  pending = { credentialId: encode(credential.rawId), userHandle: response.userHandle ? encode(response.userHandle) : null,
    authenticatorData: encode(response.authenticatorData), clientDataJSON: encode(response.clientDataJSON), signature: encode(response.signature) };
  nativePrompt = null; await submitApproval();
}
async function cancelPayment() {
  if (!review || review.status !== 'pending' || expired() || uncertain) return;
  uncertain = true; render(); setStatus('checking', 'Declining this payment…');
  const result = checkReview(await request(`${base}/payment-reviews/${id}/cancel`));
  if (!['cancelled', 'approved'].includes(result.status)) fail(); accept(result);
}
async function run(action: () => Promise<void>) {
  if (busy || blocked) return; busy = true; canRetry = false; render();
  try { await action(); }
  catch (error) {
    if (error instanceof DOMException && ['NotAllowedError', 'AbortError'].includes(error.name) && nativePrompt) {
      setStatus('ready', 'Passkey approval cancelled. You can try again.');
    } else if (error instanceof InvalidResponse) {
      blocked = true; setStatus('error', 'This payment response could not be verified. Return to the app to check this payment.');
    } else {
      canRetry = true;
      if (uncertain || pending) setStatus('unknown', 'Approval status is unknown. Check this same payment again before taking another action.');
      else if (error instanceof HttpFailure && [400, 401, 403, 404, 410].includes(error.status))
        setStatus('unknown', 'Wallet access changed or this review expired. Check this payment again.');
      else setStatus('unknown', 'This payment is temporarily unavailable. Check this payment again.');
    }
  } finally { nativePrompt = null; busy = false; render(); }
}
approve.addEventListener('click', () => void run(approvePayment));
cancel.addEventListener('click', () => void run(cancelPayment));
cancelPrompt.addEventListener('click', () => nativePrompt?.abort());
// A check that finds the approval committed after all returns to the app like a fresh one.
retry.addEventListener('click', () => void run(async () => { await (id && rpId ? recover : load)(); if (pending === null && !uncertain) goBackToApp(); }));
setInterval(() => {
  if (!busy && review?.status === 'pending' && expired() && !uncertain && !blocked) {
    setStatus('expired', 'This payment approval expired. Return to your app to review a fresh payment.'); render();
  }
}, 1000);
void run(load);
