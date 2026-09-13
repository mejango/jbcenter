import { request } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { createRegistration, signGet } from './fixtures/wallet-enrollment-crypto.js';
import { startWalletDeviceProbe } from '../scripts/rest/wallet-device-probe.js';

let probe: Awaited<ReturnType<typeof startWalletDeviceProbe>> | undefined;
afterEach(async () => { await probe?.close(); probe = undefined; });
async function send(path: string, options: { method?: string; headers?: Record<string, string>; body?: string; omitOrigin?: boolean } = {}) {
  const origin = new URL(probe!.origin), method = options.method ?? 'POST';
  return new Promise<{ status: number; headers: Record<string, unknown>; text: string; json: Record<string, any> }>((resolve, reject) => {
    const body = options.body ?? (path === '/begin' ? JSON.stringify({ name: 'Juicebox HTTP test' }) : '{}');
    const req = request({ host: '127.0.0.1', port: origin.port, path, method,
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
