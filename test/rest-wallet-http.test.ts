import { describe, expect, it } from 'vitest';
import { assertWalletCsrf, assertWalletHttpRequest, readWalletCookie, readWalletJson,
  walletCookie, walletCsrfToken, walletFlowCookie, walletSessionCookie } from '../src/rest/wallet/http.js';

const origin = 'https://wallet.example.test';
const token = Buffer.alloc(32, 7).toString('base64url');
const other = Buffer.alloc(32, 8).toString('base64url');
function post(headers: Record<string, string> = {}, body = '{}') {
  return new Request(origin + '/wallet/login/begin', { method:'POST', headers:{ origin, 'content-type':'application/json', 'x-center-wallet-request':'1', ...headers }, body });
}

describe('wallet HTTP origin and browser binding', () => {
  it('accepts exact central requests and top-level navigation without requiring an Origin header', () => {
    expect(() => assertWalletHttpRequest(post(), origin, 'central')).not.toThrow();
    expect(() => assertWalletHttpRequest(new Request(origin + '/wallet'), origin, 'navigation')).not.toThrow();
    expect(() => assertWalletHttpRequest(new Request('http://wallet.example.test/wallet/login/begin', {
      method:'POST',headers:{host:'wallet.example.test',origin,'content-type':'application/json','x-center-wallet-request':'1'},body:'{}',
    }),origin,'central')).not.toThrow();
  });
  it.each([
    {origin:'https://beep.example.test'}, {origin:'null'}, {origin:origin+'/'}, {origin:origin+', '+origin},
    {host:'localhost:3000','x-forwarded-host':'wallet.example.test','x-forwarded-proto':'https'},
    {host:'wallet.example.test:443'}, {'sec-fetch-site':'same-site'}, {'sec-fetch-site':'cross-site'},
    {'x-center-wallet-request':'0'}, {'content-type':'text/plain'},
  ])('rejects substituted origins, hosts and simple cross-site requests: %j', headers => {
    expect(() => assertWalletHttpRequest(post(headers as Record<string,string>),origin,'central')).toThrow();
  });
  it('requires the exact mutating method and origin independently of same-site metadata', () => {
    expect(() => assertWalletHttpRequest(new Request(origin+'/wallet/login/begin',{method:'POST',headers:{'content-type':'application/json','x-center-wallet-request':'1'},body:'{}'}),origin,'central')).toThrow();
    expect(() => assertWalletHttpRequest(new Request(origin+'/wallet/logout'),origin,'central')).toThrow();
    expect(() => assertWalletHttpRequest(new Request('https://another.example.test/wallet'),origin,'navigation')).toThrow();
  });
  it('reads only a single canonical host cookie and ignores unrelated app cookies', () => {
    const request = new Request(origin,{headers:{cookie:`analytics=any; ${walletSessionCookie}=${token}; ${walletFlowCookie}=${other}`}});
    expect(readWalletCookie(request,walletSessionCookie)).toBe(token);
    expect(readWalletCookie(request,walletFlowCookie)).toBe(other);
    expect(readWalletCookie(new Request(origin),walletSessionCookie)).toBeNull();
  });
  it.each([
    `${walletSessionCookie}=${token}; ${walletSessionCookie}=${other}`,
    `${walletSessionCookie}=${token}=` , `${walletSessionCookie}=%41`, `${walletSessionCookie}=short`,
    `${walletSessionCookie}="${token}"`, `${walletSessionCookie}=${'x'.repeat(43)}`,
  ])('rejects ambiguous or noncanonical cookie values: %s', cookie => {
    expect(() => readWalletCookie(new Request(origin,{headers:{cookie}}),walletSessionCookie)).toThrow();
  });
  it('sets host-only secure cookies with bounded lifetime and an explicit deletion', () => {
    expect(walletCookie(walletSessionCookie,token,3600)).toBe(`${walletSessionCookie}=${token}; Path=/; Max-Age=3600; Secure; HttpOnly; SameSite=Lax`);
    expect(walletCookie(walletFlowCookie,token,180)).not.toContain('Domain=');
    expect(walletCookie(walletSessionCookie,null,0)).toBe(`${walletSessionCookie}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`);
    expect(walletCookie(walletFlowCookie,token,3780)).toContain('Max-Age=3780;');
    expect(() => walletCookie(walletFlowCookie,token,3781)).toThrow();
    expect(() => walletCookie(walletSessionCookie,token,3601)).toThrow();
  });
  it('binds CSRF proof to the exact opaque session cookie without accepting it as an app key', () => {
    const csrf = walletCsrfToken(token);
    expect(csrf).not.toBe(token);
    expect(csrf).not.toBe(walletCsrfToken(other));
    expect(() => assertWalletCsrf(post({'x-center-wallet-csrf':csrf}),token)).not.toThrow();
    expect(() => assertWalletCsrf(post({'x-center-wallet-csrf':csrf}),other)).toThrow();
    expect(() => assertWalletCsrf(post({'x-center-wallet-csrf':token}),token)).toThrow();
    expect(() => assertWalletCsrf(post(),token)).toThrow();
  });
  it('accepts bounded JSON objects and rejects oversized, malformed or unsupported bodies', async () => {
    await expect(readWalletJson(post({},'{"id":"test"}'))).resolves.toEqual({id:'test'});
    for(const body of ['[]','null','true','{"id":','{"x":"'+'x'.repeat(16384)+'"}'])
      await expect(readWalletJson(post({},body))).rejects.toThrow();
    await expect(readWalletJson(post({'content-length':'20000'},'{}'))).rejects.toThrow();
    await expect(readWalletJson(post({'content-length':'1'},'{}'))).rejects.toThrow();
    const malformed = new Request(origin,{method:'POST',body:new Uint8Array([123,34,120,34,58,34,255,34,125])});
    await expect(readWalletJson(malformed)).rejects.toThrow();
  });
  it('cancels a stalled body within its total read deadline', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; } });
    const request = new Request(origin, { method:'POST', body, duplex:'half' } as RequestInit);
    await expect(readWalletJson(request,25)).rejects.toMatchObject({code:'WALLET_HTTP_BODY_TIMEOUT'});
    expect(cancelled).toBe(true);
  });
  it('rejects a body that arrives after an event-loop stall before the timer can run', async () => {
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      const end = performance.now() + 12;
      while (performance.now() < end) { /* Reproduce a busy event loop ahead of the timer callback. */ }
      controller.enqueue(new TextEncoder().encode('{}')); controller.close();
    } });
    const request = new Request(origin, { method:'POST', body, duplex:'half' } as RequestInit);
    await expect(readWalletJson(request,5)).rejects.toMatchObject({code:'WALLET_HTTP_BODY_TIMEOUT'});
  });
});
