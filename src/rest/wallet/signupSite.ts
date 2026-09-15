import type { Hono, Context } from 'hono';
import type { Address, Hex } from 'viem';
import { RestError } from '../core.js';
import { walletAppFields } from './appGrants.js';
import type { createLocalWalletSignup } from './signup.js';
import { walletSignupPage, walletSignupCss } from '../web/walletSignupPage.js';
import { assertWalletHttpHost, assertWalletHttpRequest, assertWalletCsrf, readWalletCookie, readWalletJson,
  walletCookie, walletCsrfToken, walletSignupCookie, walletSignupResumeCookie, walletHttpBytes, walletHttpAssertion, walletPageHeaders,
  type WalletCookieName } from './http.js';

export interface WalletSignupSiteOptions {
  origin: string; browserScript: string;
  /** Mount path of the wallet pages on this host ('' on the dedicated host). */
  basePath?: string;
  signup: Pick<ReturnType<typeof createLocalWalletSignup>, 'begin' | 'status' | 'register' | 'proveEnrollment' |
    'prepareDeployment' | 'approveDeployment' | 'prepareSetup' | 'completeSetupPasskey' | 'beginResume' | 'completeResume'>;
}
function invalid(status = 400): never { throw new RestError(status, 'WALLET_SIGNUP_HTTP_INVALID', 'Reload the original signup and retry its current step.'); }
/** Installed only by the dedicated wallet host. No trusted-app CORS grants signup access. */
export function mountWalletSignup(app: Hono, options: WalletSignupSiteOptions) {
  const base = options.basePath ?? '/wallet';
  const { signup, origin } = options;
  for (const path of [`${base}/create`, `${base}/signup/*`, `${base}/assets/wallet-signup.*`]) app.use(path, async (c, next) => {
    assertWalletHttpHost(c.req.raw, origin);
    for (const [name, value] of Object.entries(walletPageHeaders)) c.header(name, value);
    await next();
  });
  function cookie(c: Context, name: WalletCookieName) {
    const token = readWalletCookie(c.req.raw, name);
    if (!token) invalid(403);
    assertWalletCsrf(c.req.raw, token); return token;
  }
  async function body(c: Context, fields: string[], optional: string[] = []) {
    assertWalletHttpRequest(c.req.raw, origin, 'central');
    const value = await readWalletJson(c.req.raw);
    try { return walletAppFields(value, fields, optional); } catch { return invalid(); }
  }
  function result(c: Context, token: string, view: Awaited<ReturnType<typeof signup.status>>, replayed?: boolean) {
    c.header('Set-Cookie', walletCookie(walletSignupCookie, token, Math.max(1, Math.min(86400, Math.floor((view.expiresAtMs - Date.now()) / 1000)))), { append: true });
    return { view, csrfToken: walletCsrfToken(token), ...(replayed === undefined ? {} : { replayed }) };
  }
  // All typed-data uints are decimal JSON strings; no credential-bearing rows are serialized.
  const json = (c: Context, value: unknown) => c.body(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item), 200, { 'Content-Type': 'application/json' });
  app.get(`${base}/create`, c => c.html(walletSignupPage({ base })));
  app.get(`${base}/assets/wallet-signup.js`, c => c.body(options.browserScript, 200, { 'Content-Type': 'application/javascript; charset=utf-8' }));
  app.get(`${base}/assets/wallet-signup.css`, c => c.body(walletSignupCss(), 200, { 'Content-Type': 'text/css; charset=utf-8' }));
  app.get(`${base}/signup/state`, async c => {
    const token = readWalletCookie(c.req.raw, walletSignupCookie);
    if (!token) return c.json({ view: null });
    try { return json(c, { view: await signup.status(token), csrfToken: walletCsrfToken(token) }); }
    catch (error) {
      if (!(error instanceof RestError) || error.code !== 'WALLET_SIGNUP_UNAUTHORIZED') throw error;
      // Expired unproved flows may be reclaimed. Clear only the unusable continuation,
      // preserving all accepted deployment/setup records and requiring an explicit next action.
      c.header('Set-Cookie', walletCookie(walletSignupCookie, null, 0), { append: true });
      return c.json({ view: null });
    }
  });
  app.post(`${base}/signup/begin`, async c => {
    const input = await body(c, ['recoveryOwner', 'passkeyName']);
    if (readWalletCookie(c.req.raw, walletSignupCookie)) invalid(409);
    const started = await signup.begin({ recoveryOwner: input.recoveryOwner as Address, passkeyName: input.passkeyName as string });
    return c.json(result(c, started.flowToken, started.view), 201);
  });
  app.post(`${base}/signup/restart`, async c => {
    // A deliberate start-over only forgets this browser's continuation. The signup itself keeps
    // its state server-side and its passkey can log in or resume later.
    await body(c, []); const token = cookie(c, walletSignupCookie);
    try { await signup.status(token); }
    catch (error) {
      if (!(error instanceof RestError) || error.code !== 'WALLET_SIGNUP_UNAUTHORIZED') throw error;
      // Cleanup can reclaim an expired continuation between state and Restart.
    }
    c.header('Set-Cookie', walletCookie(walletSignupCookie, null, 0), { append: true });
    return c.json({ view: null });
  });
  app.post(`${base}/signup/register`, async c => {
    const input = await body(c, ['type', 'credentialId', 'rawId', 'clientDataJSON', 'attestationObject']), token = cookie(c, walletSignupCookie);
    if (input.type !== 'public-key') invalid();
    walletHttpBytes(input.credentialId, 1, 1023);
    return json(c, { view: await signup.register(token, { type: 'public-key', credentialId: input.credentialId as string,
      rawId: walletHttpBytes(input.rawId, 1, 1023), clientDataJSON: walletHttpBytes(input.clientDataJSON, 1, 2048), attestationObject: walletHttpBytes(input.attestationObject, 1, 2048) }) });
  });
  app.post(`${base}/signup/prove`, async c => {
    const input = await body(c, ['assertion', 'backupSignature']), token = cookie(c, walletSignupCookie);
    return json(c, { view: await signup.proveEnrollment(token, { assertion: walletHttpAssertion(input.assertion), backupSignature: input.backupSignature as Hex }) });
  });
  app.post(`${base}/signup/deployment/review`, async c => {
    await body(c, []); return json(c, await signup.prepareDeployment(cookie(c, walletSignupCookie)));
  });
  app.post(`${base}/signup/deployment/approve`, async c => {
    const input = await body(c, ['approvalId', 'assertion'], ['backupSignature']), token = cookie(c, walletSignupCookie);
    if (input.backupSignature !== undefined && (typeof input.backupSignature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(input.backupSignature))) invalid();
    return json(c, { view: await signup.approveDeployment(token, { approvalId: input.approvalId as string, assertion: walletHttpAssertion(input.assertion),
      ...(input.backupSignature === undefined ? {} : { backupSignature: input.backupSignature as Hex }) }) });
  });
  app.post(`${base}/signup/setup/review`, async c => {
    const input = await body(c, ['browserPublicAddress']), token = cookie(c, walletSignupCookie);
    return json(c, await signup.prepareSetup(token, { browserPublicAddress: input.browserPublicAddress as Address }));
  });
  app.post(`${base}/signup/setup/complete`, async c => {
    const input = await body(c, ['setupId', 'assertion', 'browserProof']), token = cookie(c, walletSignupCookie);
    return json(c, { view: await signup.completeSetupPasskey(token, { setupId: input.setupId as string,
      assertion: walletHttpAssertion(input.assertion), browserProof: input.browserProof as Hex }) });
  });
  app.post(`${base}/signup/resume/begin`, async c => {
    await body(c, []);
    const resumed = await signup.beginResume();
    c.header('Set-Cookie', walletCookie(walletSignupResumeCookie, resumed.resumeToken, 86400), { append: true });
    return c.json({ challenge: resumed.challenge, csrfToken: walletCsrfToken(resumed.resumeToken) }, 201);
  });
  app.post(`${base}/signup/resume/complete`, async c => {
    const input = await body(c, ['resumeId', 'assertion']), resumeToken = cookie(c, walletSignupResumeCookie);
    const resumed = await signup.completeResume({ resumeId: input.resumeId as string, resumeToken, assertion: walletHttpAssertion(input.assertion) });
    return json(c, result(c, resumed.flowToken, await signup.status(resumed.flowToken), resumed.replayed));
  });
}
