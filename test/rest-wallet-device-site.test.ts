import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { RestError } from '../src/rest/core.js';
import { mountWalletDevices, type WalletDeviceSiteOptions } from '../src/rest/wallet/deviceSite.js';

const origin = 'https://my.juicebox.center', linkToken = 'A'.repeat(43);
function setup() {
  const view = { phase: 'awaiting_activation' };
  const devices = { activateForLink: vi.fn(async () => view), statusForLink: vi.fn(async () => view), activate: vi.fn(async () => view) };
  const session = vi.fn(async () => { throw new RestError(403, 'WALLET_HTTP_SESSION', 'Sign in.'); });
  const app = new Hono();
  app.onError((error, c) => c.json({ error: error instanceof RestError ? error.code : 'unavailable' }, error instanceof RestError ? error.status as 400 : 503));
  mountWalletDevices(app, { origin, devices: devices as unknown as WalletDeviceSiteOptions['devices'], browserScript: '', session } as unknown as WalletDeviceSiteOptions);
  return { app, devices, session };
}
const post = (path: string, body: unknown) => new Request(origin + '/wallet/devices/' + path, { method: 'POST',
  headers: { origin, 'content-type': 'application/json', 'x-center-wallet-request': '1' }, body: JSON.stringify(body) });

describe('device site routes', () => {
  it("the other device's own routes are not the account's `:id` routes: `link` is not an id", async () => {
    const { app, devices, session } = setup();
    for (const path of ['activate', 'state']) {
      const response = await app.fetch(post(`link/${path}`, { linkToken }));
      expect(response.status).toBe(200);
    }
    expect(devices.activateForLink).toHaveBeenCalledWith(linkToken);
    expect(devices.statusForLink).toHaveBeenCalledWith(linkToken);
    expect(session).not.toHaveBeenCalled();
    // The account's routes still take a UUID and still need the session.
    expect((await app.fetch(post('6f2b986a-c549-4d8a-8bc6-fbd7afafcb5f/activate', {}))).status).toBe(403);
    expect((await app.fetch(post('not-an-id/activate', {}))).status).toBe(404);
  });
});
