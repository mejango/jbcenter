import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { mountWalletRecovery, type WalletRecoverySiteOptions } from '../src/rest/wallet/recoverySite.js';
import { RestError } from '../src/rest/core.js';
import { walletCookie, walletCsrfToken, walletRecoveryCookie, walletRecoveryResumeCookie, walletSessionCookie } from '../src/rest/wallet/http.js';

const origin = 'https://wallet.example.test', token = Buffer.alloc(32, 8).toString('base64url');
const view = { id: 'recovery', phase: 'awaiting_registration', expiresAtMs: Date.now() + 300000, passkeyName: 'Juicebox test' };
const assertion = { credentialId: token, userHandle: token, authenticatorData: Buffer.alloc(37).toString('base64url'),
  clientDataJSON: Buffer.from('{}').toString('base64url'), signature: Buffer.alloc(70).toString('base64url') };
function setup() {
  const recovery = { begin: vi.fn(async () => ({ flowToken: token, view })), status: vi.fn(async () => view),
    register: vi.fn(async () => view), prove: vi.fn(async () => view), prepareRotation: vi.fn(), approveRotation: vi.fn(async () => view),
    prepareSetup: vi.fn(), completeSetup: vi.fn(async () => view),
    beginResume: vi.fn(async () => ({ resumeToken: token, challenge: { id: 'resume', document: { purpose: 'resume' } } })),
    completeResume: vi.fn(async () => ({ flowToken: token, flow: { secret: 'internal-only' }, replayed: true })) };
  const app = new Hono();
  app.onError((error, c) => c.json({ error: error instanceof RestError ? error.code : 'unavailable' }, error instanceof RestError ? error.status as 400 : 503));
  mountWalletRecovery(app, { origin, recovery: recovery as unknown as WalletRecoverySiteOptions['recovery'], browserScript: '/* recovery */' });
  return { app, recovery };
}
const headers = { origin, 'content-type': 'application/json', 'x-center-wallet-request': '1',
  cookie: `${walletRecoveryCookie}=${token}`, 'x-center-wallet-csrf': walletCsrfToken(token) };
const post = (path: string, body: unknown, input = headers) => new Request(origin + '/wallet/recovery/' + path,
  { method: 'POST', headers: input, body: JSON.stringify(body) });
describe('recovery HTTP boundary', () => {
  it('keeps recovery isolated from trusted-app CORS, frames and caches', async () => {
    const { app } = setup(), response = await app.fetch(new Request(origin + '/wallet/recover'));
    expect(response.status).toBe(200); expect(await response.text()).toContain('Recover');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect((await app.fetch(new Request(origin + '/wallet/recover', { headers: { host: 'attacker.test' } }))).status).toBe(403);
  });
  it('accepts public wallet/name only and keeps continuation separate from login', async () => {
    const { app, recovery } = setup(), fresh = { ...headers }; delete (fresh as Partial<typeof headers>).cookie;
    const input = { walletAddress: '0x' + '12'.repeat(20), passkeyName: 'Juicebox test' };
    const response = await app.fetch(post('begin', input, fresh));
    expect(response.status).toBe(201); expect(await response.json()).toEqual({ view, csrfToken: walletCsrfToken(token) });
    expect(response.headers.get('set-cookie')).toContain(walletRecoveryCookie + '=' + token);
    expect(response.headers.get('set-cookie')).toContain('Secure; HttpOnly; SameSite=Lax');
    expect(response.headers.get('set-cookie')).not.toContain(walletSessionCookie + '=');
    for (const extra of [{ mnemonic: 'do not accept secrets' }, { observation: {} }, { rpId: 'attacker.test' }, { accountId: 'attacker' }])
      expect((await app.fetch(post('begin', { ...input, ...extra }, fresh))).status).toBe(400);
    expect((await app.fetch(post('begin', input))).status).toBe(409);
    expect((await app.fetch(post('begin', input, { ...fresh, origin: 'https://homerun.test' }))).status).toBe(403);
    expect(recovery.begin).toHaveBeenCalledTimes(1);
  });
  it('rejects missing or substituted CSRF and client observations before rotation', async () => {
    const { app, recovery } = setup();
    for (const input of [{ ...headers, 'x-center-wallet-csrf': '' }, { ...headers, cookie: `${walletSessionCookie}=${token}` },
      { ...headers, cookie: headers.cookie + '; ' + headers.cookie }, { ...headers, 'sec-fetch-site': 'cross-site' }])
      expect((await app.fetch(post('rotation/review', {}, input))).status).toBeGreaterThanOrEqual(400);
    expect((await app.fetch(post('rotation/approve', { backupSignature: '0x', observation: { success: true } }))).status).toBe(400);
    expect(recovery.prepareRotation).not.toHaveBeenCalled(); expect(recovery.approveRotation).not.toHaveBeenCalled();
  });
  it('requires the independent owner proof and bounds native registration/assertion bytes', async () => {
    const { app, recovery } = setup();
    const registration = { type: 'public-key', credentialId: token, rawId: token, clientDataJSON: token, attestationObject: token };
    expect((await app.fetch(post('register', registration))).status).toBe(200);
    expect((await app.fetch(post('register', { ...registration, rawId: token + '=' }))).status).toBe(400);
    expect((await app.fetch(post('prove', { assertion }))).status).toBe(400);
    expect((await app.fetch(post('prove', { assertion, backupSignature: '0x' + '11'.repeat(65) }))).status).toBe(200);
    expect((await app.fetch(post('prove', { assertion: { ...assertion, signature: 'A'.repeat(9000) }, backupSignature: '0x' }))).status).toBe(400);
    expect(recovery.prove).toHaveBeenCalledTimes(1);
  });
  it('resumes with its own cookie and returns only the public view after both proofs', async () => {
    const { app, recovery } = setup(), begin = await app.fetch(post('resume/begin', { recoveryId: 'recovery' }));
    expect(begin.headers.get('set-cookie')).toContain(walletRecoveryResumeCookie + '=');
    const input = { resumeId: 'resume', assertion, backupSignature: '0x' + '11'.repeat(65) };
    expect((await app.fetch(post('resume/complete', input))).status).toBe(403);
    const response = await app.fetch(post('resume/complete', input, { ...headers, cookie: `${walletRecoveryResumeCookie}=${token}` }));
    expect(await response.json()).toEqual({ view, csrfToken: walletCsrfToken(token), replayed: true });
    expect(recovery.completeResume).toHaveBeenCalledTimes(1);
    expect(response.headers.get('set-cookie')).toContain(walletRecoveryCookie + '=');
  });
  it('does not start another recovery or rotate owners while reading state', async () => {
    const { app, recovery } = setup();
    expect(await (await app.fetch(new Request(origin + '/wallet/recovery/state'))).json()).toEqual({ view: null });
    expect(await (await app.fetch(new Request(origin + '/wallet/recovery/state', { headers }))).json()).toEqual({ view, csrfToken: walletCsrfToken(token) });
    expect(recovery.begin).not.toHaveBeenCalled(); expect(recovery.approveRotation).not.toHaveBeenCalled();
    expect(() => walletCookie(walletRecoveryCookie, token, 86401)).toThrow();
  });
});
