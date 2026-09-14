import type { Context, Hono } from 'hono';
import type { Address, Hex } from 'viem';
import { RestError } from '../core.js';
import { walletAppFields } from './appGrants.js';
import type { createLocalWalletRecovery } from './recoveryService.js';
import { walletRecoveryPage, walletRecoveryCss } from '../web/walletRecoveryPage.js';
import { assertWalletHttpHost, assertWalletHttpRequest, assertWalletCsrf, readWalletCookie, readWalletJson,
  walletCookie, walletCsrfToken, walletRecoveryCookie, walletRecoveryResumeCookie, walletHttpBytes, walletHttpAssertion,
  walletPageHeaders, type WalletCookieName } from './http.js';

export interface WalletRecoverySiteOptions {
  origin: string; browserScript: string;
  recovery: Pick<ReturnType<typeof createLocalWalletRecovery>, 'begin' | 'status' | 'register' | 'prove' | 'prepareRotation'
    | 'approveRotation' | 'prepareSetup' | 'completeSetup' | 'beginResume' | 'completeResume' | 'restart'>;
}
function invalid(status = 400): never { throw new RestError(status, 'WALLET_RECOVERY_HTTP_INVALID', 'Check the original recovery and retry its current step.'); }
/** Dedicated wallet-host capability. App allowlisting never grants access to recovery cookies. */
export function mountWalletRecovery(app: Hono, options: WalletRecoverySiteOptions) {
  const { recovery, origin } = options;
  for (const path of ['/wallet/recover', '/wallet/recovery/*', '/wallet/assets/wallet-recovery.*']) app.use(path, async (c, next) => {
    assertWalletHttpHost(c.req.raw, origin);
    for (const [name, value] of Object.entries(walletPageHeaders)) c.header(name, value);
    await next();
  });
  function cookie(c: Context, name: WalletCookieName) {
    const token = readWalletCookie(c.req.raw, name);
    if (!token) invalid(403);
    assertWalletCsrf(c.req.raw, token); return token;
  }
  async function body(c: Context, keys: string[]) {
    assertWalletHttpRequest(c.req.raw, origin, 'central');
    const value = await readWalletJson(c.req.raw);
    try { return walletAppFields(value, keys); } catch { return invalid(); }
  }
  const json = (c: Context, value: unknown) => c.body(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item), 200,
    { 'Content-Type': 'application/json' });
  function result(c: Context, token: string, view: Awaited<ReturnType<typeof recovery.status>>, replayed?: boolean) {
    c.header('Set-Cookie', walletCookie(walletRecoveryCookie, token, Math.max(1, Math.min(86400, Math.floor((view.expiresAtMs - Date.now()) / 1000)))), { append: true });
    return { view, csrfToken: walletCsrfToken(token), ...(replayed === undefined ? {} : { replayed }) };
  }
  app.get('/wallet/recover', c => c.html(walletRecoveryPage()));
  app.get('/wallet/assets/wallet-recovery.js', c => c.body(options.browserScript, 200, { 'Content-Type': 'application/javascript; charset=utf-8' }));
  app.get('/wallet/assets/wallet-recovery.css', c => c.body(walletRecoveryCss(), 200, { 'Content-Type': 'text/css; charset=utf-8' }));
  app.get('/wallet/recovery/state', async c => {
    const token = readWalletCookie(c.req.raw, walletRecoveryCookie);
    if (!token) return c.json({ view: null });
    try { return json(c, { view: await recovery.status(token), csrfToken: walletCsrfToken(token) }); }
    catch (error) {
      if (!(error instanceof RestError) || error.code !== 'WALLET_RECOVERY_UNAUTHORIZED') throw error;
      c.header('Set-Cookie', walletCookie(walletRecoveryCookie, null, 0), { append: true });
      return c.json({ view: null });
    }
  });
  app.post('/wallet/recovery/begin', async c => {
    const input = await body(c, ['walletAddress', 'passkeyName']);
    if (readWalletCookie(c.req.raw, walletRecoveryCookie)) invalid(409);
    const begun = await recovery.begin({ walletAddress: input.walletAddress as Address, passkeyName: input.passkeyName as string });
    return c.json(result(c, begun.flowToken, begun.view), 201);
  });
  app.post('/wallet/recovery/restart', async c => {
    await body(c, []);
    if (readWalletCookie(c.req.raw, walletRecoveryCookie)) await recovery.restart(cookie(c, walletRecoveryCookie));
    c.header('Set-Cookie', walletCookie(walletRecoveryCookie, null, 0), { append: true });
    return c.json({ restarted: true, view: null });
  });
  app.post('/wallet/recovery/register', async c => {
    const input = await body(c, ['type', 'credentialId', 'rawId', 'clientDataJSON', 'attestationObject']), token = cookie(c, walletRecoveryCookie);
    if (input.type !== 'public-key') invalid();
    walletHttpBytes(input.credentialId, 1, 1023);
    return json(c, { view: await recovery.register(token, { type: 'public-key', credentialId: input.credentialId as string,
      rawId: walletHttpBytes(input.rawId, 1, 1023), clientDataJSON: walletHttpBytes(input.clientDataJSON, 1, 2048), attestationObject: walletHttpBytes(input.attestationObject, 1, 2048) }) });
  });
  app.post('/wallet/recovery/prove', async c => {
    const input = await body(c, ['assertion', 'backupSignature']), token = cookie(c, walletRecoveryCookie);
    return json(c, { view: await recovery.prove(token, { assertion: walletHttpAssertion(input.assertion), backupSignature: input.backupSignature as Hex }) });
  });
  app.post('/wallet/recovery/rotation/review', async c => {
    await body(c, []); return json(c, await recovery.prepareRotation(cookie(c, walletRecoveryCookie)));
  });
  app.post('/wallet/recovery/rotation/approve', async c => {
    const input = await body(c, ['backupSignature']), token = cookie(c, walletRecoveryCookie);
    return json(c, { view: await recovery.approveRotation(token, input.backupSignature as Hex) });
  });
  app.post('/wallet/recovery/setup/review', async c => {
    const input = await body(c, ['browserPublicAddress']), token = cookie(c, walletRecoveryCookie);
    return json(c, await recovery.prepareSetup(token, { browserPublicAddress: input.browserPublicAddress as Address }));
  });
  app.post('/wallet/recovery/setup/complete', async c => {
    const input = await body(c, ['setupId', 'assertion', 'browserProof']), token = cookie(c, walletRecoveryCookie);
    return json(c, { view: await recovery.completeSetup(token, { setupId: input.setupId as string,
      assertion: walletHttpAssertion(input.assertion), browserProof: input.browserProof as Hex }) });
  });
  app.post('/wallet/recovery/resume/begin', async c => {
    const input = await body(c, ['recoveryId']);
    const resumed = await recovery.beginResume(input.recoveryId as string);
    c.header('Set-Cookie', walletCookie(walletRecoveryResumeCookie, resumed.resumeToken, 86400), { append: true });
    return json(c, { challenge: resumed.challenge, csrfToken: walletCsrfToken(resumed.resumeToken) });
  });
  app.post('/wallet/recovery/resume/complete', async c => {
    const input = await body(c, ['resumeId', 'assertion', 'backupSignature']), resumeToken = cookie(c, walletRecoveryResumeCookie);
    const resumed = await recovery.completeResume({ resumeId: input.resumeId as string, resumeToken,
      assertion: walletHttpAssertion(input.assertion), backupSignature: input.backupSignature as Hex });
    return json(c, result(c, resumed.flowToken, await recovery.status(resumed.flowToken), resumed.replayed));
  });
}
