import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { mountWalletRecovery, type WalletRecoverySiteOptions } from '../src/rest/wallet/recoverySite.js';
import { RestError } from '../src/rest/core.js';
import { walletCookie, walletCsrfToken, walletRecoveryCookie, walletRecoveryResumeCookie, walletSessionCookie } from '../src/rest/wallet/http.js';

const origin = 'https://wallet.example.test', token = Buffer.alloc(32, 8).toString('base64url');
const view = { id: 'recovery', phase: 'awaiting_registration', expiresAtMs: Date.now() + 300000, passkeyName: 'Juicebox test' };
const assertion = { credentialId: token, userHandle: token, authenticatorData: Buffer.alloc(37).toString('base64url'),
  clientDataJSON: Buffer.from('{}').toString('base64url'), signature: Buffer.alloc(70).toString('base64url') };
function setup(extra: Partial<WalletRecoverySiteOptions> = {}) {
  const recovery = { begin: vi.fn(async () => ({ flowToken: token, view })), status: vi.fn(async () => view),
    register: vi.fn(async () => view), prove: vi.fn(async () => view), prepareRotation: vi.fn(), approveRotation: vi.fn(async () => view),
    prepareSetup: vi.fn(), completeSetup: vi.fn(async () => view), restart: vi.fn(async () => {}),
    beginResume: vi.fn(async () => ({ resumeToken: token, challenge: { id: 'resume', document: { purpose: 'resume' } } })),
    completeResume: vi.fn(async () => ({ flowToken: token, flow: { secret: 'internal-only' }, replayed: true })) };
  const app = new Hono();
  app.onError((error, c) => c.json({ error: error instanceof RestError ? error.code : 'unavailable' }, error instanceof RestError ? error.status as 400 : 503));
  mountWalletRecovery(app, { origin, recovery: recovery as unknown as WalletRecoverySiteOptions['recovery'], browserScript: '/* recovery */', ...extra });
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
  it('clears a reclaimed continuation during restart but preserves it on outage and rejects invalid CSRF', async () => {
    const { app, recovery } = setup();
    recovery.restart.mockRejectedValueOnce(new RestError(403, 'WALLET_RECOVERY_UNAUTHORIZED', 'Reclaimed'));
    const reset = await app.fetch(post('restart', {}));
    expect(reset.status).toBe(200);
    expect(reset.headers.get('set-cookie')).toContain('Max-Age=0');
    recovery.restart.mockRejectedValueOnce(new Error('Database unavailable'));
    const outage = await app.fetch(post('restart', {}));
    expect(outage.status).toBe(503); expect(outage.headers.get('set-cookie')).toBeNull();
    const invalid = await app.fetch(post('restart', {}, { ...headers, 'x-center-wallet-csrf': '' }));
    expect(invalid.status).toBe(403); expect(invalid.headers.get('set-cookie')).toBeNull();
    expect(recovery.restart).toHaveBeenCalledTimes(2); expect(recovery.begin).not.toHaveBeenCalled();
  });
  it('clears only an explicitly restartable recovery cookie and makes an already-cleared retry harmless', async () => {
    const { app, recovery } = setup();
    recovery.restart.mockRejectedValueOnce(new RestError(409, 'WALLET_RECOVERY_CONFLICT', 'Still active'));
    const active = await app.fetch(post('restart', {}));
    expect(active.status).toBe(409); expect(active.headers.get('set-cookie')).toBeNull();
    const reset = await app.fetch(post('restart', {}));
    expect(await reset.json()).toEqual({ restarted: true, view: null });
    expect(reset.headers.get('set-cookie')).toContain(`${walletRecoveryCookie}=;`);
    expect(reset.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(reset.headers.get('set-cookie')).not.toContain(walletSessionCookie + '=');
    const fresh = { ...headers }; delete (fresh as Partial<typeof headers>).cookie;
    expect((await app.fetch(post('restart', {}, fresh))).status).toBe(200);
    expect(recovery.restart).toHaveBeenCalledTimes(2); expect(recovery.begin).not.toHaveBeenCalled();
  });
  it('rejects restart without the current cookie CSRF and refuses a cross-site reset even without a cookie', async () => {
    const { app, recovery } = setup();
    expect((await app.fetch(post('restart', {}, { ...headers, 'x-center-wallet-csrf': '' }))).status).toBe(403);
    const fresh = { ...headers, origin: 'https://homerun.test' }; delete (fresh as Partial<typeof headers>).cookie;
    expect((await app.fetch(post('restart', {}, fresh))).status).toBe(403);
    expect(recovery.restart).not.toHaveBeenCalled();
  });
  it('clears an unavailable continuation cookie so cleaned pending flows do not trap the browser', async () => {
    const { app, recovery } = setup();
    recovery.status.mockRejectedValueOnce(new RestError(403, 'WALLET_RECOVERY_UNAUTHORIZED', 'Continuation unavailable'));
    const response = await app.fetch(new Request(origin + '/wallet/recovery/state', { headers }));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ view: null });
    expect(response.headers.get('set-cookie')).toContain(walletRecoveryCookie + '=;');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(recovery.begin).not.toHaveBeenCalled();
    recovery.status.mockRejectedValueOnce(new Error('Database unavailable'));
    const outage = await app.fetch(new Request(origin + '/wallet/recovery/state', { headers }));
    expect(outage.status).toBe(503); expect(outage.headers.get('set-cookie')).toBeNull();
  });

  it('hands back a chosen-password backup envelope by wallet address, and nothing when none is configured or stored', async () => {
    const found = { walletAddress: '0x' + '12'.repeat(20), recoveryOwner: '0x' + '34'.repeat(20), initializerHash: '0x' + 'ab'.repeat(32),
      envelope: { version: 'center-wallet-backup-v1', kdf: { name: 'scrypt', n: 65536, r: 8, p: 1 }, salt: 'a'.repeat(22), iv: 'b'.repeat(16), ciphertext: 'c'.repeat(64) } };
    const read = vi.fn(async (address: string) => address === found.walletAddress ? found : null);
    const { app } = setup({ backups: { read } } as never);
    const plain = { origin, 'content-type': 'application/json', 'x-center-wallet-request': '1' };
    const request = (body: unknown) => new Request(origin + '/wallet/recovery/backup', { method: 'POST', headers: plain, body: JSON.stringify(body) });
    const response = await app.fetch(request({ walletAddress: found.walletAddress }));
    expect(response.status).toBe(200); expect(await response.json()).toEqual(found);
    expect((await app.fetch(request({ walletAddress: '0x' + '99'.repeat(20) }))).status).toBe(404);
    expect((await app.fetch(request({ walletAddress: 'nope' }))).status).toBe(400);
    expect((await app.fetch(request({ walletAddress: found.walletAddress, extra: 1 }))).status).toBe(400);
    read.mockRejectedValueOnce(new RestError(429, 'WALLET_BACKUP_READ_LIMIT', 'Too many'));
    expect((await app.fetch(request({ walletAddress: found.walletAddress }))).status).toBe(429);
    expect((await setup().app.fetch(request({ walletAddress: found.walletAddress }))).status).toBe(404);
  });
});
