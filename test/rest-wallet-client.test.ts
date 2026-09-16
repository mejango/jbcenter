import { buildSync } from 'esbuild';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { readRequestClaims, verifyRequestSignature } from '../src/rest/auth/signatures.js';
import { verifyWalletHandoffRequestSignature, verifyWalletHandoffExchange, walletHandoffCallback } from '../src/rest/wallet/handoff.js';
import type { WalletHandoffRequest } from '../src/rest/wallet/sharedHandoff.js';
import { createCenterWalletClient } from '../src/rest/client/wallet.js';

const issuer = 'https://wallet.juicebox.center', audience = 'https://juicebox.center', origin = 'https://beep.biz';
const callbackUri = origin + '/center/callback', now = 1_900_000_000_000;
const token = (n: number) => Buffer.alloc(32, n).toString('base64url');
const intentId = token(4), code = token(5), accountId = `eip155:8453:0x${'12'.repeat(20)}`;

function fixture() {
  const data = new Map<string, string>(), calls: Array<{ url: string; body: any; init: RequestInit }> = [];
  let href = origin + '/i/' + 'ab'.repeat(16), current = now, request: WalletHandoffRequest;
  let prepareLoss = false, exchangeLoss = false, exchanges = 0, mutateConfig: (value: any) => any = v => v, mutateGrant: (value: any) => any = v => v;
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  const location = { href: () => href, replace: (value: string) => { href = value; } };
  const transport = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input), body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body, init });
    if (url.includes('/wallet/')) {
      expect(init.credentials).toBe('omit'); expect(init.redirect).toBe('error'); expect(init.cache).toBe('no-store');
      expect(new Headers(init.headers).get('x-center-wallet-request')).toBe('1');
      expect(new Headers(init.headers).has('origin')).toBe(false);
    }
    if (url === issuer + '/wallet/config?appOrigin=' + encodeURIComponent(origin)) return Response.json(mutateConfig({ version: 'center-wallet-v1', issuer, audience, rpId: 'wallet.juicebox.center', app: { origin, callbackUris: [callbackUri], generation: 1 } }));
    if (url === issuer + '/wallet/handoff/prepare') {
      request = body.request;
      await verifyWalletHandoffRequestSignature(request, body.signature);
      expect(data.size).toBe(1);
      if (prepareLoss) { prepareLoss = false; throw new Error('private upstream details'); }
      return Response.json({ id: intentId, request, state: 'prepared', createdAtMs: now, expiresAtMs: request.expiresAtMs });
    }
    if (url === issuer + '/wallet/handoff/exchange') {
      await verifyWalletHandoffExchange(body);
      expect(href.includes('?')).toBe(false); // The code never stays in an address bar.
      expect(body.code).toBe(code); expect(body.intentId).toBe(intentId);
      exchanges++;
      if (exchangeLoss) { exchangeLoss = false; throw new Error('private upstream details'); }
      return Response.json({ replayed: exchanges > 1, grant: mutateGrant({ kind: 'wallet-app', id: '550e8400-e29b-41d4-a716-446655440000', incarnation: '1', accountId,
        signerAddress: request.requestKey.toLowerCase(), scopes: ['read', 'plan', 'relay'], origin, callbackUri, audience, appGeneration: 1,
        authorityEpoch: '1', sessionEpoch: '1', createdAt: now / 1000, expiresAt: now / 1000 + 3600, revokedAt: null, retainUntil: now / 1000 + 3600 + 86400 }) });
    }
    if (url === audience + '/api/v1/accounts/me') {
      const headers = new Headers(init.headers), claims = readRequestClaims({ method: 'GET', requestTarget: '/api/v1/accounts/me', contentType: '', body: new Uint8Array(), headers });
      await verifyRequestSignature(audience, claims.claims, claims.signature);
      expect(claims.claims.accountId).toBe(accountId); expect(claims.claims.grantId).toBe('550e8400-e29b-41d4-a716-446655440000');
      expect(claims.claims.signer.toLowerCase()).toBe(request.requestKey.toLowerCase());
      return Response.json({ account: { id: accountId } });
    }
    throw new Error('Unexpected transport target.');
  };
  const options = { issuer, audience, callbackUri, storage, location, fetch: transport as typeof fetch, now: () => current };
  return { options, data, calls, storage, location, client: () => createCenterWalletClient(options),
    callback: () => { href = walletHandoffCallback({ request, code }); return href; }, href: () => href,
    losePrepare: () => { prepareLoss = true; }, loseExchange: () => { exchangeLoss = true; },
    advance: (ms: number) => { current += ms; }, changeConfig: (f: typeof mutateConfig) => { mutateConfig = f; }, changeGrant: (f: typeof mutateGrant) => { mutateGrant = f; } };
}

describe('Center browser wallet connection', () => {
  it('prepares a real signed handoff with local-only key and S256 verifier, then uses an app grant as the Safe API principal', async () => {
    const f = fixture(), client = f.client(), prepared = await client.prepareConnection();
    expect(prepared.authorizationUrl).toBe(issuer + '/wallet?intent=' + intentId);
    const pending = JSON.parse([...f.data.values()][0]!);
    const key = privateKeyToAccount(pending.key);
    expect(f.calls[1]!.body.request.requestKey).toBe(key.address.toLowerCase());
    expect(JSON.stringify(f.calls)).not.toContain(pending.key); expect(JSON.stringify(f.calls)).not.toContain(pending.verifier);
    expect(prepared.authorizationUrl).not.toContain(pending.verifier);
    const connected = await client.completeConnection(f.callback());
    expect(connected).toMatchObject({ accountId, address: accountId.slice(12), chainId: 8453, expiresAt: now / 1000 + 3600, capabilities: ['read', 'plan', 'relay'] });
    expect(JSON.stringify(connected)).not.toContain(pending.key); expect(JSON.stringify(connected)).not.toContain(pending.verifier);
    expect(await connected.client.account()).toEqual({ account: { id: accountId } });
    expect(f.client().restoreConnection()!.accountId).toBe(accountId);
    client.disconnect(); expect(f.data.size).toBe(0); expect(client.restoreConnection()).toBeNull();
  });

  it('reuses the exact prepared request after response loss instead of replacing the browser key', async () => {
    const f = fixture(); f.losePrepare();
    await expect(f.client().prepareConnection()).rejects.toMatchObject({ code: 'WALLET_NETWORK_ERROR' });
    const saved = [...f.data.values()][0];
    expect((await f.client().prepareConnection()).intentId).toBe(intentId);
    expect(f.calls.filter(call => call.url.endsWith('/prepare')).map(call => call.body)).toEqual([f.calls[1]!.body, f.calls[1]!.body]);
    expect(JSON.parse([...f.data.values()][0]!).key).toBe(JSON.parse(saved!).key);
  });

  it('strips callback parameters before exchange and preserves exact receipt retry after the original request expires', async () => {
    const f = fixture(); await f.client().prepareConnection(); f.loseExchange();
    await expect(f.client().completeConnection(f.callback())).rejects.toMatchObject({ code: 'WALLET_NETWORK_ERROR' });
    expect(f.href()).toBe(callbackUri); const first = f.calls.at(-1)!.body;
    f.advance(301_000);
    await expect(f.client().prepareConnection()).rejects.toMatchObject({ code: 'WALLET_HANDOFF_PENDING' });
    const recovered = await f.client().retryConnection();
    expect(recovered.accountId).toBe(accountId); expect(f.calls.at(-1)!.body).toEqual(first);
  });

  it('completes a callback delivered from another window without touching this page, and launches into a named window', async () => {
    const f = fixture(), client = f.client(), page = f.href();
    const prepared = await client.prepareConnection();
    // The callback URL arrives by message from the popup; this page's address stays as it was.
    const delivered = walletHandoffCallback({ request: JSON.parse([...f.data.values()][0]!).request, code });
    expect((await client.completeConnection(delivered)).accountId).toBe(accountId);
    expect(f.href()).toBe(page);
    // launch() targets the window the app opened, and only accepts a plain window name.
    const forms: any[] = [];
    const g = globalThis as any, saved = { location: g.location, document: g.document, HTMLFormElement: g.HTMLFormElement };
    g.location = { origin }; g.HTMLFormElement = { prototype: { submit(this: any) { forms.push(this); } } };
    g.document = { body: { append() {} }, createElement: (tag: string) => ({ tag, target: '_self', hidden: false, children: [] as any[], append(child: any) { this.children.push(child); }, remove() {} }) };
    try {
      const again = f.client(); f.storage.removeItem([...f.data.keys()][0]!);
      const launch = (await again.prepareConnection()).launch;
      launch({ target: 'juicebox-center' }); expect(forms.at(-1)).toMatchObject({ target: 'juicebox-center', method: 'POST', action: issuer + '/wallet/launch' });
      launch(); expect(forms.at(-1).target).toBe('_self');
      expect(() => launch({ target: '_blank' })).toThrow(); expect(() => launch({ target: 'a b' })).toThrow();
    } finally { Object.assign(g, saved); }
  });

  it('preserves the callback code before yielding to asynchronous proof signing', async () => {
    const f = fixture(), client = f.client(); await client.prepareConnection();
    const completion = client.completeConnection(f.callback());
    const captured = JSON.parse([...f.data.values()][0]!);
    expect(f.href()).toBe(callbackUri);
    expect(captured.exchange).toEqual({ code });
    expect((await completion).accountId).toBe(accountId);
  });

  it('resumes local proof creation when saving that proof failed after the callback was cleared', async () => {
    const f = fixture(); await f.client().prepareConnection();
    const setItem = f.storage.setItem; let writes = 0;
    f.storage.setItem = (name, value) => { if (++writes === 2) throw new Error('storage quota'); setItem(name, value); };
    await expect(f.client().completeConnection(f.callback())).rejects.toMatchObject({ code: 'WALLET_STORAGE_UNAVAILABLE' });
    expect(f.href()).toBe(callbackUri);
    expect(JSON.parse([...f.data.values()][0]!).exchange).toEqual({ code });
    expect(f.calls.some(call => call.url.endsWith('/exchange'))).toBe(false);
    f.storage.setItem = setItem;
    expect((await f.client().retryConnection()).accountId).toBe(accountId);
  });

  it.each(['state', 'iss', 'code', 'duplicate', 'extra', 'path', 'fragment'])('rejects callback %s substitution without exchanging and clears the query first', async kind => {
    const f = fixture(); await f.client().prepareConnection(); const original = f.callback(), url = new URL(original);
    if (kind === 'state') url.searchParams.set('state', token(99));
    if (kind === 'iss') url.searchParams.set('iss', 'https://evil.test');
    if (kind === 'code') url.searchParams.set('code', 'invalid');
    if (kind === 'duplicate') url.searchParams.append('state', token(99));
    if (kind === 'extra') url.searchParams.append('returnTo', 'https://evil.test');
    if (kind === 'path') url.pathname = '/another-callback';
    if (kind === 'fragment') url.hash = 'unexpected';
    await expect(f.client().completeConnection(url.href)).rejects.toMatchObject({ code: 'WALLET_CALLBACK_INVALID' });
    expect(f.href()).toBe(callbackUri); expect(f.calls.some(call => call.url.endsWith('/exchange'))).toBe(false);
  });

  it.each(['issuer', 'audience', 'callback', 'origin'])('rejects a configured %s substitution before generating a handoff', async kind => {
    const f = fixture(); f.changeConfig(value => {
      if (kind === 'issuer') value.issuer = 'https://evil.test';
      if (kind === 'audience') value.audience = 'https://evil.test';
      if (kind === 'callback') value.app.callbackUris = ['https://beep.biz/other'];
      if (kind === 'origin') value.app.origin = 'https://evil.test';
      return value;
    });
    await expect(f.client().prepareConnection()).rejects.toMatchObject({ code: 'WALLET_RESPONSE_INVALID' });
    expect(f.calls).toHaveLength(1); expect(f.data.size).toBe(0);
  });

  it.each(['account', 'signer', 'origin', 'scope', 'expiry', 'revoked'])('rejects a substituted %s grant and retains pending exchange', async kind => {
    const f = fixture(); await f.client().prepareConnection(); f.changeGrant(grant => {
      if (kind === 'account') grant.accountId = 'eip155:1:0x' + '12'.repeat(20);
      if (kind === 'signer') grant.signerAddress = '0x' + '34'.repeat(20);
      if (kind === 'origin') grant.origin = 'https://evil.test';
      if (kind === 'scope') grant.scopes = ['read', 'plan', 'relay', 'owner'];
      if (kind === 'expiry') grant.expiresAt = now / 1000 + 7200;
      if (kind === 'revoked') grant.revokedAt = now / 1000;
      return grant;
    });
    await expect(f.client().completeConnection(f.callback())).rejects.toMatchObject({ code: 'WALLET_RESPONSE_INVALID' });
    expect(f.client().restoreConnection()).toBeNull();
    expect(JSON.parse([...f.data.values()][0]!).exchange).toBeDefined();
  });

  it('does not prepare when browser storage silently drops the local key', async () => {
    const f = fixture(); f.storage.setItem = () => {};
    await expect(f.client().prepareConnection()).rejects.toMatchObject({ code: 'WALLET_STORAGE_UNAVAILABLE' });
    expect(f.calls.every(call => !call.url.endsWith('/prepare'))).toBe(true);
  });

  it('rejects a callback whose raw path normalizes to the registered path', async () => {
    const f = fixture(); await f.client().prepareConnection();
    const incoming = f.callback().replace('/center/callback?', '/other/../center/callback?');
    await expect(f.client().completeConnection(incoming)).rejects.toMatchObject({ code: 'WALLET_CALLBACK_INVALID' });
    expect(f.href()).toBe(callbackUri); expect(f.calls.some(call => call.url.endsWith('/exchange'))).toBe(false);
  });

  it('preserves one browser key when two preparations overlap', async () => {
    const f = fixture();
    const results = await Promise.allSettled([f.client().prepareConnection(), f.client().prepareConnection()]);
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find(value => value.status === 'rejected') as PromiseRejectedResult;
    expect(failure.reason).toMatchObject({ code: 'WALLET_HANDOFF_CHANGED' });
    expect(f.calls.filter(call => call.url.endsWith('/prepare'))).toHaveLength(1);
    expect((await f.client().completeConnection(f.callback())).accountId).toBe(accountId);
  });

  it('does not resume a preparation after the user disconnects during discovery', async () => {
    const f = fixture(), transport = f.options.fetch;
    let resume!: () => void;
    const paused = new Promise<void>(resolve => { resume = resolve; });
    f.options.fetch = (async (url, init) => { await paused; return transport(url, init); }) as typeof fetch;
    const client = f.client(), preparing = client.prepareConnection();
    client.disconnect(); resume();
    await expect(preparing).rejects.toMatchObject({ code: 'WALLET_HANDOFF_CHANGED' });
    expect(f.data.size).toBe(0); expect(f.calls.some(call => call.url.endsWith('/prepare'))).toBe(false);
  });

  it.each(['key', 'verifier', 'origin', 'generation'])('rejects corrupt saved %s before sending a retry', async kind => {
    const f = fixture(); await f.client().prepareConnection();
    const [name, raw] = [...f.data.entries()][0]!, value = JSON.parse(raw);
    if (kind === 'key') value.key = '0x' + '45'.repeat(32);
    if (kind === 'verifier') value.verifier = token(99);
    if (kind === 'origin') value.request.origin = 'https://evil.test';
    if (kind === 'generation') value.request.appGeneration = 0;
    f.data.set(name, JSON.stringify(value)); const count = f.calls.length;
    await expect(f.client().prepareConnection()).rejects.toMatchObject({ code: 'WALLET_STORAGE_INVALID' });
    expect(f.calls).toHaveLength(count);
  });

  it('keeps a confirmed grant expiry fixed and prevents use of a disconnected client', async () => {
    const f = fixture(), client = f.client(); await client.prepareConnection();
    const connected = await client.completeConnection(f.callback());
    expect(JSON.parse([...f.data.values()][0]!)).not.toHaveProperty('verifier');
    expect(JSON.parse([...f.data.values()][0]!)).not.toHaveProperty('exchange');
    const count = f.calls.length; client.disconnect();
    await expect(connected.client.account()).rejects.toMatchObject({ code: 'WALLET_CONNECTION_INACTIVE' });
    expect(f.calls).toHaveLength(count);
  });

  it('does not restore or sign with an expired local connection', async () => {
    const f = fixture(), client = f.client(); await client.prepareConnection();
    const connected = await client.completeConnection(f.callback()); f.advance(3_600_000);
    expect(client.restoreConnection()).toBeNull();
    await expect(connected.client.account()).rejects.toMatchObject({ code: 'WALLET_CONNECTION_INACTIVE' });
    await expect(client.retryConnection()).rejects.toMatchObject({ code: 'WALLET_CONNECTION_EXPIRED' });
  });

  it('does not send a request when disconnect happens while its signature is resolving', async () => {
    const f = fixture(), client = f.client(); await client.prepareConnection();
    const connected = await client.completeConnection(f.callback()), count = f.calls.length;
    const request = connected.client.account(); client.disconnect();
    await expect(request).rejects.toMatchObject({ code: 'WALLET_CONNECTION_INACTIVE' });
    expect(f.calls).toHaveLength(count);
  });

  it('authorizes one exact GET for a server relay without sending it or exposing the request key', async () => {
    const f = fixture(), wallet = f.client(); await wallet.prepareConnection();
    const connected = await wallet.completeConnection(f.callback()), count = f.calls.length;
    const request = await connected.client.authorizeRead('/api/v1/plans/original-plan');
    expect(request.url).toBe(audience + '/api/v1/plans/original-plan'); expect(request.method).toBe('GET'); expect(request.body).toHaveLength(0);
    const proof = readRequestClaims({ method: request.method, requestTarget: '/api/v1/plans/original-plan', contentType: '',
      body: request.body, headers: request.headers });
    await verifyRequestSignature(audience, proof.claims, proof.signature);
    expect(proof.claims.accountId).toBe(accountId); expect(proof.claims.grantId).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(f.calls).toHaveLength(count);
    expect(JSON.stringify(request)).not.toContain(JSON.parse([...f.data.values()][0]!).key);
    await expect(connected.client.authorizeRead('/api/v1/plans/../another')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it.each(['disconnect', 'replace'])('does not return relay authorization when the connection changes during signing: %s', async kind => {
    const f = fixture(), wallet = f.client(); await wallet.prepareConnection();
    const connected = await wallet.completeConnection(f.callback()), count = f.calls.length;
    const preparing = connected.client.authorizeRead('/api/v1/plans/original-plan');
    if (kind === 'disconnect') wallet.disconnect();
    else {
      const [key, encoded] = [...f.data.entries()][0]!, saved = JSON.parse(encoded);
      saved.grant.incarnation = '2'; f.data.set(key, JSON.stringify(saved));
    }
    await expect(preparing).rejects.toMatchObject({ code: 'WALLET_CONNECTION_INACTIVE' });
    expect(f.calls).toHaveLength(count);
  });

  it('bounds a fetch which ignores AbortSignal without exposing transport details', async () => {
    const f = fixture(); let signal: AbortSignal | null | undefined;
    const client = createCenterWalletClient({ ...f.options, timeoutMs: 10,
      fetch: (async (_url, init) => { signal = init?.signal; return new Promise<Response>(() => {}); }) as typeof fetch });
    await expect(client.prepareConnection()).rejects.toMatchObject({ code: 'WALLET_NETWORK_ERROR' });
    expect(signal?.aborted).toBe(true); expect(f.data.size).toBe(0);
  });

  it('enforces the deadline even when microtasks finish before an overdue timer runs', async () => {
    const f = fixture(), transport = f.options.fetch;
    const client = createCenterWalletClient({ ...f.options, timeoutMs: 5,
      fetch: (async (url, init) => {
        const until = performance.now() + 15;
        while (performance.now() < until) { /* Reproduce a main-thread stall before a resolved fetch. */ }
        return transport(url, init);
      }) as typeof fetch });
    await expect(client.prepareConnection()).rejects.toMatchObject({ code: 'WALLET_NETWORK_ERROR' });
    expect(f.data.size).toBe(0);
  });

  it('cancels a response body which stalls after the headers arrive', async () => {
    const f = fixture(); let canceled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { canceled = true; } });
    const client = createCenterWalletClient({ ...f.options, timeoutMs: 10,
      fetch: (async () => new Response(body, { headers: { 'content-type': 'application/json' } })) as typeof fetch });
    await expect(client.prepareConnection()).rejects.toMatchObject({ code: 'WALLET_NETWORK_ERROR' });
    expect(canceled).toBe(true); expect(f.data.size).toBe(0);
  });

  it('rejects oversized streamed responses and cancels the remaining body', async () => {
    const f = fixture(); let canceled = false;
    const body = new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(new Uint8Array(32 * 1024 + 1)); }, cancel() { canceled = true; } });
    const client = createCenterWalletClient({ ...f.options,
      fetch: (async () => new Response(body, { headers: { 'content-type': 'application/json' } })) as typeof fetch });
    await expect(client.prepareConnection()).rejects.toMatchObject({ code: 'WALLET_RESPONSE_INVALID' });
    expect(canceled).toBe(true); expect(f.data.size).toBe(0);
  });

  it('bundles the actual helper and connects without Buffer, process or Node builtins', async () => {
    const built = buildSync({ entryPoints: [new URL('../src/rest/client/wallet.ts', import.meta.url).pathname], bundle: true, platform: 'browser', format: 'iife', globalName: 'Wallet', write: false, metafile: true, logLevel: 'silent' });
    expect(Object.keys(built.metafile!.inputs).some(path => /\/wallet\/(policy|appGrants|handoffPostgres)\.ts$/.test(path))).toBe(false);
    const api = runInNewContext(built.outputFiles![0]!.text + '\nWallet;', { crypto: webcrypto, atob, btoa, TextEncoder, TextDecoder, Uint8Array, URL, URLSearchParams, Headers, Response, Request, AbortController, setTimeout, clearTimeout, structuredClone });
    const f = fixture();
    const client = api.createCenterWalletClient(f.options);
    await client.prepareConnection();
    expect((await client.completeConnection(f.callback())).accountId).toBe(accountId);
  });
});
