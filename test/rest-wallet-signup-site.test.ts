import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { mountWalletSignup, type WalletSignupSiteOptions } from '../src/rest/wallet/signupSite.js';
import { RestError } from '../src/rest/core.js';
import { walletCookie, walletCsrfToken, walletSignupCookie, walletSignupResumeCookie } from '../src/rest/wallet/http.js';

const origin = 'https://wallet.example.test', token = Buffer.alloc(32, 7).toString('base64url');
const view = { phase: 'awaiting_registration', expiresAtMs: Date.now() + 180000, passkeyName: 'Juicebox test' };
function setup() {
  const signup = { begin: vi.fn(async () => ({ flowToken: token, view })), status: vi.fn(async () => view),
    register: vi.fn(async () => view), proveEnrollment: vi.fn(async () => view),
    prepareDeployment: vi.fn(), approveDeployment: vi.fn(), prepareSetup: vi.fn(), completeSetupPasskey: vi.fn(),
    beginResume: vi.fn(async () => ({ resumeToken: token, challenge: { id: 'resume', challenge: '0x' + '11'.repeat(32) } })),
    completeResume: vi.fn(async () => ({ flowToken: token, flow: { secret: 'internal-only' }, replayed: true })) };
  const app = new Hono();
  app.onError((error, c) => c.json({ error: error instanceof RestError ? error.code : 'unavailable' }, error instanceof RestError ? error.status as 400 : 503));
  mountWalletSignup(app, { origin, signup: signup as unknown as WalletSignupSiteOptions['signup'], browserScript: '/* signup */' });
  return { app, signup };
}
const headers = { origin, 'content-type': 'application/json', 'x-center-wallet-request': '1',
  cookie: `${walletSignupCookie}=${token}`, 'x-center-wallet-csrf': walletCsrfToken(token) };
function post(path: string, body: unknown, input = headers) {
  return new Request(origin + '/wallet/signup/' + path, { method: 'POST', headers: input, body: JSON.stringify(body) });
}
describe('signup HTTP authority boundary', () => {
  it('serves signup with restrictive headers and rejects a substituted host', async () => {
    const { app } = setup(), response = await app.fetch(new Request(origin + '/wallet/create'));
    expect(response.status).toBe(200); expect(await response.text()).toContain('Passkey name');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect((await app.fetch(new Request(origin + '/wallet/create', { headers: { host: 'attacker.test' } }))).status).toBe(403);
  });
  it('creates only with same-origin browser context and keeps the continuation in a distinct HttpOnly cookie', async () => {
    const { app, signup } = setup(), body = { recoveryOwner: '0x' + '12'.repeat(20), passkeyName: 'Juicebox test' };
    const fresh = { ...headers }; delete (fresh as Partial<typeof headers>).cookie;
    const response = await app.fetch(post('begin', body, fresh));
    expect(response.status).toBe(201); expect(response.headers.get('set-cookie')).toContain(walletSignupCookie + '=' + token);
    expect(response.headers.get('set-cookie')).toContain('Secure; HttpOnly; SameSite=Lax');
    const json = await response.json(); expect(json).toEqual({ view, csrfToken: walletCsrfToken(token) });
    expect(JSON.stringify(json)).not.toContain(token);
    expect((await app.fetch(post('begin', body))).status).toBe(409);
    expect((await app.fetch(post('begin', body, { ...fresh, origin: 'https://homerun.test' }))).status).toBe(403);
    expect((await app.fetch(post('begin', { ...body, rpId: 'attacker.test' }, fresh))).status).toBe(400);
    expect((await app.fetch(post('begin', { ...body, mnemonic: 'a secret must not be accepted' }, fresh))).status).toBe(400);
    expect(signup.begin).toHaveBeenCalledTimes(1);
  });
  it('rejects missing CSRF, duplicate cookies and client authority fields before mutation', async () => {
    const { app, signup } = setup();
    for (const input of [{ ...headers, 'x-center-wallet-csrf': '' }, { ...headers, cookie: headers.cookie + '; ' + headers.cookie },
      { ...headers, origin: 'https://homerun.test' }, { ...headers, 'sec-fetch-site': 'cross-site' }])
      expect((await app.fetch(post('deployment/review', {}, input))).status).toBeGreaterThanOrEqual(400);
    expect((await app.fetch(post('deployment/review', { accountId: 'attacker' }))).status).toBe(400);
    expect(signup.prepareDeployment).not.toHaveBeenCalled();
  });
  it('decodes bounded registration bytes and never accepts malformed base64 or extra fields', async () => {
    const { app, signup } = setup(), value = { type: 'public-key', credentialId: token, rawId: token,
      clientDataJSON: Buffer.from('{}').toString('base64url'), attestationObject: token };
    expect((await app.fetch(post('register', value))).status).toBe(200);
    expect(signup.register).toHaveBeenCalledWith(token, { ...value, rawId: Buffer.alloc(32, 7), clientDataJSON: Buffer.from('{}'), attestationObject: Buffer.alloc(32, 7) });
    for (const bad of [{ ...value, rawId: token + '=' }, { ...value, attestationObject: 'A'.repeat(3000) }, { ...value, userHandle: token }])
      expect((await app.fetch(post('register', bad))).status).toBe(400);
    expect(signup.register).toHaveBeenCalledTimes(1);
  });
  it('resumption uses its own cookie and strips internal rows from the response', async () => {
    const { app } = setup(), begun = await app.fetch(post('resume/begin', {}));
    expect(begun.headers.get('set-cookie')).toContain(walletSignupResumeCookie + '=');
    const assertion = { credentialId: token, userHandle: token, authenticatorData: Buffer.alloc(37).toString('base64url'),
      clientDataJSON: Buffer.from('{}').toString('base64url'), signature: Buffer.alloc(70).toString('base64url') };
    expect((await app.fetch(post('resume/complete', { resumeId: 'resume', assertion }))).status).toBe(403);
    const response = await app.fetch(post('resume/complete', { resumeId: 'resume', assertion }, { ...headers, cookie: `${walletSignupResumeCookie}=${token}` }));
    expect(await response.json()).toEqual({ view, csrfToken: walletCsrfToken(token), replayed: true });
    expect(response.headers.get('set-cookie')).toContain(walletSignupCookie + '=');
  });
  it('never permits a signup cookie to be used as a session cookie name or indefinite bearer', () => {
    expect(() => walletCookie(walletSignupCookie, token, 86401)).toThrow();
    expect(() => walletCookie('__Host-other' as never, token, 60)).toThrow();
  });
  it('allows a new registration only after the original unverified signup has expired', async () => {
    const { app, signup } = setup();
    expect((await app.fetch(post('restart', {}))).status).toBe(409);
    signup.status.mockResolvedValueOnce({ ...view, phase: 'expired' });
    const response = await app.fetch(post('restart', {}));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ view: null });
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(signup.begin).not.toHaveBeenCalled();
  });
  it('clears a reclaimed continuation during restart but preserves it on outage and rejects invalid CSRF', async () => {
    const { app, signup } = setup();
    signup.status.mockRejectedValueOnce(new RestError(403, 'WALLET_SIGNUP_UNAUTHORIZED', 'Reclaimed'));
    const reset = await app.fetch(post('restart', {}));
    expect(reset.status).toBe(200);
    expect(reset.headers.get('set-cookie')).toContain('Max-Age=0');
    signup.status.mockRejectedValueOnce(new Error('Database unavailable'));
    const outage = await app.fetch(post('restart', {}));
    expect(outage.status).toBe(503); expect(outage.headers.get('set-cookie')).toBeNull();
    const invalid = await app.fetch(post('restart', {}, { ...headers, 'x-center-wallet-csrf': '' }));
    expect(invalid.status).toBe(403); expect(invalid.headers.get('set-cookie')).toBeNull();
    expect(signup.status).toHaveBeenCalledTimes(2); expect(signup.begin).not.toHaveBeenCalled();
  });
  it('clears an unavailable continuation cookie so cleaned pending flows do not trap the browser', async () => {
    const { app, signup } = setup();
    signup.status.mockRejectedValueOnce(new RestError(403, 'WALLET_SIGNUP_UNAUTHORIZED', 'Continuation unavailable'));
    const response = await app.fetch(new Request(origin + '/wallet/signup/state', { headers }));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ view: null });
    expect(response.headers.get('set-cookie')).toContain(walletSignupCookie + '=;');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(signup.begin).not.toHaveBeenCalled();
    signup.status.mockRejectedValueOnce(new Error('Database unavailable'));
    const outage = await app.fetch(new Request(origin + '/wallet/signup/state', { headers }));
    expect(outage.status).toBe(503); expect(outage.headers.get('set-cookie')).toBeNull();
  });

});
