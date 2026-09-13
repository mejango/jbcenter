import { request } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { createRegistration, signGet } from './fixtures/wallet-enrollment-crypto.js';
import { startWalletDeviceProbe } from '../scripts/rest/wallet-device-probe.js';

let probe: Awaited<ReturnType<typeof startWalletDeviceProbe>> | undefined;
afterEach(async () => { await probe?.close(); probe = undefined; });
async function send(path: string, options: { method?: string; headers?: Record<string, string | string[]>; body?: string; omitOrigin?: boolean } = {}) {
  const origin = new URL(probe!.origin), method = options.method ?? 'POST';
  const localOrigin = new URL(probe!.localOrigin);
  return new Promise<{ status: number; headers: Record<string, unknown>; text: string; json: Record<string, any> }>((resolve, reject) => {
    const body = options.body ?? (path === '/begin' ? JSON.stringify({ name: 'Juicebox HTTP test' }) : '{}');
    const req = request({ host: '127.0.0.1', port: localOrigin.port, path, method,
      headers: { host: origin.host, ...(method === 'POST' ? { ...(options.omitOrigin ? {} : { origin: origin.origin }), 'content-type': 'application/json', 'x-center-device-probe': '1' } : {}), ...options.headers } }, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { const text = Buffer.concat(chunks).toString();
        let json = {}; try { json = JSON.parse(text); } catch { /* HTML is inspected directly. */ }
        resolve({ status: res.statusCode!, headers: res.headers, text, json });
      });
    });
    req.setTimeout(2000, () => req.destroy(new Error('Probe request timed out')));
    req.on('error', reject); req.end(method === 'POST' ? body : undefined);
  });
}

describe('local device probe HTTP boundary', () => {
  it('serves an isolated test page and issues only localhost resident UV registration options', async () => {
    probe = await startWalletDeviceProbe();
    const page = await send('/', { method: 'GET' });
    expect(page.status).toBe(200); expect(page.text).toContain('Local test only');
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    const first = await send('/begin'), second = await send('/begin');
    expect(first.status).toBe(200);
    expect(first.json.publicKey).toMatchObject({ rp: { id: 'localhost' },
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, attestation: 'none' });
    expect(first.json.publicKey.challenge).not.toBe(second.json.publicKey.challenge);
    expect(first.json.publicKey.user.id).not.toBe(second.json.publicKey.user.id);
    expect(first.json).not.toHaveProperty('wallet');
  });

  it('rejects changed host, Origin and cross-site request metadata before issuance', async () => {
    probe = await startWalletDeviceProbe({ maxProbes: 1 });
    for (const headers of [
      { host: 'example.com' }, { host: new URL(probe.origin).host.replace('localhost', '127.0.0.1') },
      { origin: '' }, { origin: 'null' }, { origin: 'https://localhost' },
      { 'x-center-device-probe': '' }, { 'sec-fetch-site': 'cross-site' },
    ]) expect((await send('/begin', { headers })).status).toBe(403);
    expect((await send('/begin', { omitOrigin: true })).status).toBe(403);
    expect((await send('/', { method: 'GET', headers: { origin: 'https://example.com' } })).status).toBe(403);
    expect((await send('/begin')).status).toBe(200);
  });

  it('rejects non-JSON, malformed, oversized and unexpected input', async () => {
    probe = await startWalletDeviceProbe();
    expect((await send('/begin', { headers: { 'content-type': 'text/plain' } })).status).toBe(415);
    expect((await send('/begin', { body: '{' })).status).toBe(400);
    expect((await send('/begin', { body: '{"extra":true}' })).status).toBe(400);
    expect((await send('/begin', { body: 'x'.repeat(16_385) })).status).toBe(413);
    expect((await send('/begin', { method: 'GET' })).status).toBe(405);
    expect((await send('/not-a-wallet-route')).status).toBe(404);
  });

  it('cannot verify an unregistered candidate or a cancelled ceremony', async () => {
    probe = await startWalletDeviceProbe();
    const { id } = (await send('/begin')).json;
    expect((await send('/challenge', { body: JSON.stringify({ id }) })).status).toBe(409);
    expect((await send('/verify', { body: JSON.stringify({ id, response: {} }) })).status).toBe(409);
    expect((await send('/cancel', { body: JSON.stringify({ id }) })).json).toEqual({ status: 'cancelled' });
    expect((await send('/challenge', { body: JSON.stringify({ id }) })).status).toBe(410);
  });

  it('caps retained probes and frees cancelled capacity without reusing challenges', async () => {
    probe = await startWalletDeviceProbe({ maxProbes: 1 });
    const first = (await send('/begin')).json;
    expect((await send('/begin')).status).toBe(429);
    await send('/cancel', { body: JSON.stringify({ id: first.id }) });
    const next = await send('/begin');
    expect(next.status).toBe(200); expect(next.json.id).not.toBe(first.id);
    expect(next.json.publicKey.challenge).not.toBe(first.publicKey.challenge);
  });

  it('expires state and recovers bounded capacity using the actual process clock', async () => {
    probe = await startWalletDeviceProbe({ challengeTtlMs: 100, maxProbes: 1 });
    const first = (await send('/begin')).json;
    await new Promise(resolve => setTimeout(resolve, 130));
    expect((await send('/challenge', { body: JSON.stringify({ id: first.id }) })).status).toBe(410);
    expect((await send('/begin')).status).toBe(200);
  });

  it('closes automatically and allows repeated explicit shutdown', async () => {
    probe = await startWalletDeviceProbe({ lifetimeMs: 100 });
    await new Promise(resolve => setTimeout(resolve, 150));
    await expect(send('/', { method: 'GET' })).rejects.toThrow();
    await probe.close(); await probe.close();
  });

  it('reports only bounded stage counts and never credential or ceremony data', async () => {
    const events: string[] = [];
    probe = await startWalletDeviceProbe({ onEvent: event => events.push(event) });
    const privateName = 'Personal test name 漢';
    const begun = (await send('/begin', { body: JSON.stringify({ name: privateName }) })).json;
    const status = await send('/status', { method: 'GET' });
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({ testOnly: true, rpId: 'localhost', pending: 1,
      counts: { started: 1, registered: 0, verified: 0, cancelled: 0, expired: 0, rejected: 0 } });
    expect(Object.keys(status.json).sort()).toEqual(['counts', 'pending', 'rpId', 'startedAt', 'stopsAt', 'testOnly']);
    for (const value of [begun.id, begun.publicKey.challenge, begun.publicKey.user.id, privateName]) expect(status.text).not.toContain(value);
    await send('/cancel', { body: JSON.stringify({ id: begun.id }) });
    expect(events).toEqual(['started', 'cancelled']);
    expect(JSON.stringify(events)).not.toContain(privateName);
    expect((await send('/status', { method: 'GET' })).json).toMatchObject({ pending: 0, counts: { cancelled: 1 } });
  });

  it('cannot allocate state from an in-flight body after shutdown has started', async () => {
    const events: string[] = [];
    probe = await startWalletDeviceProbe({ onEvent: event => events.push(event) });
    const origin = new URL(probe.origin);
    const pending = request({ host: '127.0.0.1', port: origin.port, path: '/begin', method: 'POST',
      headers: { host: origin.host, origin: origin.origin, 'content-type': 'application/json',
        'x-center-device-probe': '1', expect: '100-continue' } });
    pending.setTimeout(2000, () => pending.destroy(new Error('Pending probe request timed out')));
    const continuing = once(pending, 'continue'), response = once(pending, 'response');
    void response.catch(() => {});
    pending.flushHeaders();
    await continuing;
    const stopped = probe.close();
    pending.end(JSON.stringify({ name: 'Juicebox HTTP test' }));
    const [result] = await response;
    result.resume();
    expect(result.statusCode).toBe(503);
    await stopped;
    expect(events).not.toContain('started');
  });

  it.each(['  Família 🌿  ', 'ليلى', '👩‍💻 work', 'A'.repeat(64), '名'.repeat(21), '😀'.repeat(16)])(
    'accepts a bounded human name and keeps it separate from random identity', async name => {
      probe = await startWalletDeviceProbe();
      const first = await send('/begin', { body: JSON.stringify({ name }) });
      const second = await send('/begin', { body: JSON.stringify({ name }) });
      expect(first.status).toBe(200); expect(second.status).toBe(200);
      expect(first.json.publicKey.user).toMatchObject({ name: name.trim(), displayName: name.trim() });
      expect(second.json.publicKey.user).toMatchObject({ name: name.trim(), displayName: name.trim() });
      expect(first.json.publicKey.user.id).not.toBe(second.json.publicKey.user.id);
      expect(Buffer.from(first.json.publicKey.user.id, 'base64url')).toHaveLength(32);
      expect(first.json.id).not.toBe(second.json.id);
    },
  );

  it('requires the explicit name field and rejects malformed names before allocating state', async () => {
    probe = await startWalletDeviceProbe({ maxProbes: 1 });
    for (const name of ['', '   ', '\nAlice', 'Alice\u0000', 'Alice\u007f', 'Alice\u202e', 'Alice\u2066',
      'Alice\u061c', '\u200d\u200b', '\u0301', '\u115f', '\ud800', 'A'.repeat(65), '名'.repeat(22), '😀'.repeat(17), null, 1]) {
      const result = await send('/begin', { body: JSON.stringify({ name }) });
      expect(result.status).toBe(400); expect(result.json).toEqual({ code: 'PROBE_NAME_INVALID' });
    }
    for (const body of [{}, { name: 'Valid', extra: true }]) {
      const result = await send('/begin', { body: JSON.stringify(body) });
      expect(result.status).toBe(400); expect(result.json).toEqual({ code: 'PROBE_INPUT_INVALID' });
    }
    expect((await send('/begin')).status).toBe(200);
  });

  it.each([
    ['credential', 'CREDENTIAL_MISMATCH'], ['handle', 'USER_HANDLE_MISMATCH'], ['missing handle', 'USER_HANDLE_REQUIRED'],
    ['flags', 'AUTHENTICATOR_FLAGS_INVALID'], ['RP', 'RP_MISMATCH'], ['challenge', 'CHALLENGE_OR_CLIENT_DATA_INVALID'],
    ['origin', 'CLIENT_DATA_INVALID'], ['signature', 'SIGNATURE_INVALID'], ['encoding', 'RESPONSE_INVALID'],
  ])('categorizes a rejected %s proof without disclosing its bytes and permits fresh retry', async (variant, diagnostic) => {
    const events: Array<{ event: string; diagnostic?: string }> = [];
    probe = await startWalletDeviceProbe({ onEvent: (...args: [string, string?]) => events.push({ event: args[0], ...(args[1] ? { diagnostic: args[1] } : {}) }) });
    const initial = (await send('/begin')).json;
    const context = { rpId: 'localhost', origin: probe.origin, userHandle: initial.publicKey.user.id as string };
    const hex = (value: string): Hex => `0x${Buffer.from(value, 'base64url').toString('hex')}`;
    const registration = createRegistration({ ...context, challenge: hex(initial.publicKey.challenge) });
    const registered = await send('/register', { body: JSON.stringify({ id: initial.id, response: {
      ...registration.response, rawId: Buffer.from(registration.response.rawId).toString('base64url'),
      clientDataJSON: Buffer.from(registration.response.clientDataJSON).toString('base64url'),
      attestationObject: Buffer.from(registration.response.attestationObject).toString('base64url'),
    } }) });
    expect(registered.status).toBe(200);
    const first = (await send('/challenge', { body: JSON.stringify({ id: initial.id }) })).json.publicKey.challenge;
    const assertion = signGet({ ...context, challenge: variant === 'challenge' ? `0x${'ab'.repeat(32)}` : hex(first),
      ...(variant === 'origin' ? { origin: 'https://unexpected.example' } : {}), credentialId: registration.credentialId, key: registration.key });
    if (variant === 'credential') assertion.credentialId = Buffer.from('other-test-passkey').toString('base64url');
    if (variant === 'handle') assertion.userHandle = Buffer.from('other-test-handle').toString('base64url');
    if (variant === 'missing handle') assertion.userHandle = null;
    if (variant === 'flags') assertion.authenticatorData[32]! &= ~4;
    if (variant === 'RP') assertion.authenticatorData[0]! ^= 1;
    if (variant === 'signature') assertion.signature[assertion.signature.length - 1]! ^= 1;
    const wire = (value: typeof assertion) => ({ ...value, authenticatorData: Buffer.from(value.authenticatorData).toString('base64url'),
      clientDataJSON: Buffer.from(value.clientDataJSON).toString('base64url'), signature: Buffer.from(value.signature).toString('base64url') });
    const response = wire(assertion);
    if (variant === 'encoding') response.authenticatorData = '!invalid!';
    const rejected = await send('/verify', { body: JSON.stringify({ id: initial.id, response }) });
    expect(rejected.status).toBe(403);
    expect(rejected.json).toEqual({ code: 'PROBE_PROOF_INVALID', diagnostic });
    expect(events.at(-1)).toEqual({ event: 'rejected', diagnostic });
    for (const value of [registration.credentialId, context.userHandle, first, response.signature, response.clientDataJSON])
      expect(rejected.text).not.toContain(value);
    expect((await send('/verify', { body: JSON.stringify({ id: initial.id, response }) })).status).toBe(409);
    const next = (await send('/challenge', { body: JSON.stringify({ id: initial.id }) })).json.publicKey.challenge;
    expect(next).not.toBe(first);
    const fresh = signGet({ ...context, challenge: hex(next), credentialId: registration.credentialId, key: registration.key });
    expect((await send('/verify', { body: JSON.stringify({ id: initial.id, response: wire(fresh) }) })).json)
      .toEqual({ status: 'verified', userVerified: true, userHandleMatched: true });
  });
});

describe('remote device probe HTTP boundary', () => {
  const origin = 'https://device-probe.example.test';
  const accessToken = Buffer.alloc(32, 0x6a).toString('base64url');
  const remoteTest = { origin, accessToken };
  const authorized = { authorization: `Bearer ${accessToken}` };

  it('rejects unsafe remote configuration before retaining a listening server', async () => {
    const invalidOrigins = [
      'http://device-probe.example.test', 'https://127.0.0.1', 'https://[::1]', 'https://localhost',
      'https://juicebox.center', 'https://probe.juicebox.center', 'https://juicebox.center.',
      'https://device-probe.example.test:8443', 'https://device-probe.example.test/',
      'https://device-probe.example.test/path', 'https://device-probe.example.test?token=x',
      'https://device-probe.example.test#token', 'https://user:pass@device-probe.example.test',
      'https://device-probe.example.test.', 'HTTPS://device-probe.example.test',
    ];
    const invalidTokens = ['', 'x'.repeat(42), 'x'.repeat(44), `${accessToken}=`,
      'x'.repeat(43), `${accessToken.slice(0, 42)}+`, ` ${accessToken}`, `${accessToken}\n`];
    for (const value of [
      ...invalidOrigins.map(value => ({ origin: value, accessToken })),
      ...invalidTokens.map(value => ({ origin, accessToken: value })),
    ]) {
      const options = { remoteTest: value, lifetimeMs: 100 };
      const result = await startWalletDeviceProbe(options).then(
        server => ({ server, rejected: false }), () => ({ server: undefined, rejected: true }),
      );
      await result.server?.close();
      expect(result.rejected, 'Invalid remote configuration must fail closed').toBe(true);
    }
  });

  it('serves a token-free public shell and exposes only authenticated sanitized status', async () => {
    const events: Array<{ event: string; diagnostic?: string }> = [];
    probe = await startWalletDeviceProbe({ remoteTest, onEvent: (...args: [string, string?]) =>
      events.push({ event: args[0], ...(args[1] ? { diagnostic: args[1] } : {}) }) });
    expect(probe.origin).toBe(origin);
    const localOrigin = new URL(probe.localOrigin);
    expect(localOrigin.protocol).toBe('http:'); expect(localOrigin.hostname).toBe('localhost');
    expect(Number(localOrigin.port)).toBeGreaterThan(0);
    const page = await send('/', { method: 'GET' });
    expect(page.status).toBe(200);
    expect(page.text).not.toContain(accessToken);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect((await send('/status', { method: 'GET' })).status).toBe(403);
    const empty = await send('/status', { method: 'GET', headers: authorized });
    expect(empty.status).toBe(200); expect(empty.json).toMatchObject({ pending: 0, counts: { started: 0 } });
    const privateName = 'Remote personal test 漢';
    const begun = await send('/begin', { headers: authorized, body: JSON.stringify({ name: privateName }) });
    expect(begun.status).toBe(200);
    const status = await send('/status', { method: 'GET', headers: authorized });
    expect(status.json).toMatchObject({ testOnly: true, rpId: new URL(origin).hostname, pending: 1,
      counts: { started: 1, registered: 0, verified: 0, cancelled: 0, expired: 0, rejected: 1 } });
    expect(Object.keys(status.json).sort()).toEqual(['counts', 'pending', 'rpId', 'startedAt', 'stopsAt', 'testOnly']);
    await send('/cancel', { headers: authorized, body: JSON.stringify({ id: begun.json.id }) });
    expect(events).toEqual([{ event: 'rejected' }, { event: 'started' }, { event: 'cancelled' }]);
    for (const value of [accessToken, privateName, begun.json.id, begun.json.publicKey.challenge, begun.json.publicKey.user.id]) {
      expect(status.text).not.toContain(value); expect(JSON.stringify(events)).not.toContain(value);
      expect(page.text).not.toContain(value);
    }
  });

  it('requires one exact bearer on every private route before reading or allocating from a body', async () => {
    probe = await startWalletDeviceProbe({ remoteTest, maxProbes: 1 });
    const invalidHeaders = [{}, { authorization: 'Bearer wrong' },
      { authorization: [`Bearer ${accessToken}`, `Bearer ${accessToken}`] },
      { authorization: `Basic ${accessToken}` }, { authorization: `Bearer ${accessToken}, Bearer ${accessToken}` }];
    for (const path of ['/begin', '/register', '/challenge', '/verify', '/cancel', '/status']) {
      for (const headers of invalidHeaders) {
        const denied = await send(path, { method: path === '/status' ? 'GET' : 'POST', headers, body: '{' });
        expect(denied.status).toBe(403);
        expect(denied.json).toEqual({ code: Array.isArray(headers.authorization) ? 'PROBE_ORIGIN_INVALID' : 'PROBE_ACCESS_INVALID' });
        expect(denied.text).not.toContain(accessToken);
      }
    }
    expect((await send('/begin', { body: 'x'.repeat(16_385) })).status).toBe(403);
    const local = new URL(probe.localOrigin);
    const earlyStatus = await new Promise<number>((resolve, reject) => {
      const pending = request({ host: '127.0.0.1', port: local.port, path: '/begin', method: 'POST',
        headers: { host: new URL(probe!.origin).host, origin: probe!.origin, 'content-type': 'application/json',
          'x-center-device-probe': '1', 'content-length': '100' } }, response => {
        response.resume(); resolve(response.statusCode!); pending.destroy();
      });
      pending.setTimeout(1500, () => pending.destroy(new Error('Unauthenticated request awaited its body')));
      pending.on('error', reject); pending.flushHeaders();
    });
    expect(earlyStatus).toBe(403);
    const status = await send('/status', { method: 'GET', headers: authorized });
    expect(status.json).toMatchObject({ pending: 0, counts: { started: 0 } });
    expect((await send('/begin', { headers: authorized })).status).toBe(200);
  });

  it('pins external Host and POST Origin without trusting forwarded substitutions', async () => {
    probe = await startWalletDeviceProbe({ remoteTest, maxProbes: 1 });
    const local = new URL(probe.localOrigin);
    for (const headers of [
      { host: local.host }, { host: `${new URL(origin).host}:443` }, { host: 'other.example.test' },
      { origin: local.origin }, { origin: `${origin}/` }, { origin: 'null' },
      { origin: [origin, origin] }, { 'sec-fetch-site': 'cross-site' },
      { host: 'other.example.test', 'x-forwarded-host': new URL(origin).host,
        forwarded: `host=${new URL(origin).host};proto=https` },
      { origin: 'https://other.example.test', 'x-forwarded-proto': 'https', 'x-forwarded-host': new URL(origin).host },
    ]) expect((await send('/begin', { headers: { ...authorized, ...headers } })).status).toBe(403);
    expect((await send('/begin', { headers: authorized, omitOrigin: true })).status).toBe(403);
    expect((await send('/', { method: 'GET', headers: { host: local.host } })).status).toBe(403);
    expect((await send('/status', { method: 'GET', headers: { ...authorized, host: local.host } })).status).toBe(403);
    const begun = await send('/begin', { headers: { ...authorized, forwarded: 'host=untrusted.example;proto=http',
      'x-forwarded-host': 'untrusted.example', 'x-forwarded-proto': 'http' } });
    expect(begun.status).toBe(200);
    expect(begun.json.publicKey.rp.id).toBe(new URL(origin).hostname);
  });

  it('verifies registration and fresh possession only for the configured remote RP', async () => {
    probe = await startWalletDeviceProbe({ remoteTest });
    const initial = await send('/begin', { headers: authorized });
    expect(initial.status).toBe(200);
    expect(initial.json.publicKey).toMatchObject({ rp: { id: new URL(origin).hostname },
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, attestation: 'none' });
    const { id, publicKey } = initial.json;
    const context = { rpId: new URL(origin).hostname, origin, userHandle: publicKey.user.id as string };
    const hex = (value: string): Hex => `0x${Buffer.from(value, 'base64url').toString('hex')}`;
    const registration = createRegistration({ ...context, challenge: hex(publicKey.challenge) });
    const registered = await send('/register', { headers: authorized, body: JSON.stringify({ id, response: {
      ...registration.response, rawId: Buffer.from(registration.response.rawId).toString('base64url'),
      clientDataJSON: Buffer.from(registration.response.clientDataJSON).toString('base64url'),
      attestationObject: Buffer.from(registration.response.attestationObject).toString('base64url'),
    } }) });
    expect(registered.status).toBe(200);
    const first = await send('/challenge', { headers: authorized, body: JSON.stringify({ id }) });
    expect(first.json.publicKey).toMatchObject({ rpId: context.rpId, userVerification: 'required' });
    expect(first.json.publicKey).not.toHaveProperty('allowCredentials');
    const wire = (value: ReturnType<typeof signGet>) => ({ ...value,
      authenticatorData: Buffer.from(value.authenticatorData).toString('base64url'),
      clientDataJSON: Buffer.from(value.clientDataJSON).toString('base64url'),
      signature: Buffer.from(value.signature).toString('base64url') });
    const wrongRp = signGet({ ...context, rpId: 'localhost', challenge: hex(first.json.publicKey.challenge),
      credentialId: registration.credentialId, key: registration.key });
    const rejected = await send('/verify', { headers: authorized, body: JSON.stringify({ id, response: wire(wrongRp) }) });
    expect(rejected.status).toBe(403);
    expect(rejected.json).toEqual({ code: 'PROBE_PROOF_INVALID', diagnostic: 'RP_MISMATCH' });
    const fresh = await send('/challenge', { headers: authorized, body: JSON.stringify({ id }) });
    expect(fresh.json.publicKey.challenge).not.toBe(first.json.publicKey.challenge);
    const assertion = signGet({ ...context, challenge: hex(fresh.json.publicKey.challenge),
      credentialId: registration.credentialId, key: registration.key });
    expect((await send('/cancel', { body: JSON.stringify({ id }) })).status).toBe(403);
    const proofBody = JSON.stringify({ id, response: wire(assertion) });
    const verified = await send('/verify', { headers: authorized, body: proofBody });
    expect(verified.status).toBe(200);
    expect(verified.json).toEqual({ status: 'verified', userVerified: true, userHandleMatched: true });
    expect((await send('/verify', { headers: authorized, body: proofBody })).status).toBe(410);
    expect((await send('/status', { method: 'GET', headers: authorized })).json)
      .toMatchObject({ pending: 0, counts: { started: 1, registered: 1, verified: 1, rejected: 3 } });
  });
});
