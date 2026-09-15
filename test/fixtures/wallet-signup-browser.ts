import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { build } from 'esbuild';
import { Hono } from 'hono';
import { chromium } from 'playwright';
import { expect } from 'vitest';
import type { Pool } from 'pg';
import type { TypedDataDefinition } from 'viem';
import { toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createLocalWalletSignup, type LocalWalletSignupDependencies } from '../../src/rest/wallet/signup.js';
import { PostgresWalletSignupStore } from '../../src/rest/wallet/signupPostgres.js';
import { PostgresWalletLoginStore } from '../../src/rest/wallet/loginPostgres.js';
import { PostgresWalletRecoveryStore } from '../../src/rest/wallet/recoveryPostgres.js';
import { PostgresWalletRecoveryFlowStore } from '../../src/rest/wallet/recoveryFlowPostgres.js';
import { createLocalAnvilWalletRecovery } from '../../src/rest/wallet/recoveryLocalAnvil.js';
import { createLocalWalletRecovery } from '../../src/rest/wallet/recoveryService.js';
import { createWalletAuthorityChain } from '../../src/rest/wallet/authorityChain.js';
import { exerciseRecoveryBrowser } from './wallet-recovery-browser.js';
import { createWalletSite } from '../../src/rest/wallet/site.js';
import { walletSignupCookie } from '../../src/rest/wallet/http.js';
import { enrollmentBackupAccount } from './wallet-enrollment-crypto.js';
import type { startWalletDeploymentAnvil } from './wallet-deployment-anvil.js';

/** Real browser, HTTP handlers, PostgreSQL and unforked EVM. Only the hardware
 * authenticator and independent test recovery wallet are simulated. */
export async function exerciseSignupBrowser(options: Omit<LocalWalletSignupDependencies, 'flows'> & {
  pool: Pool; fixture: Awaited<ReturnType<typeof startWalletDeploymentAnvil>>;
  recoveryMode?: 'wallet' | 'kit'; expectedNextNonce?: string;
}) {
  let app = new Hono(), lostRegistration = false, lostSetup = false;
  let recoveryKitText: string | null = null;
  const lostRecoveryPaths = new Set<string>();
  const kitMode = options.recoveryMode === 'kit', requestBodies: string[] = [];
  const observed: { path: string; status: number }[] = [];
  const server = serve({ port: 0, hostname: '127.0.0.1', fetch: async request => {
    if (kitMode && request.method === 'POST') requestBodies.push(await request.clone().text());
    const response = await app.fetch(request), path = new URL(request.url).pathname;
    observed.push({ path, status: response.status });
    if (kitMode && response.ok && ['/wallet/recovery/register', '/wallet/recovery/rotation/approve', '/wallet/recovery/setup/complete'].includes(path)
      && !lostRecoveryPaths.has(path)) {
      lostRecoveryPaths.add(path); return new Response('Unavailable after commit', { status: 503 });
    }
    if (response.ok && ((path === '/wallet/signup/register' && !lostRegistration) || (path === '/wallet/signup/setup/complete' && !lostSetup))) {
      if (path.endsWith('/register')) lostRegistration = true; else lostSetup = true;
      return new Response('Unavailable after commit', { status: 503 });
    }
    return response;
  } });
  if (!server.listening) await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No local signup listener.');
  const origin = `http://localhost:${address.port}`;
  const flows = new PostgresWalletSignupStore(options.pool, { origin, rpId: 'localhost', manifest: options.fixture.manifest });
  const signup = createLocalWalletSignup({ ...options, flows });
  const login = new PostgresWalletLoginStore(options.pool, { origin, rpId: 'localhost' });
  const recoveryObserver = createWalletAuthorityChain({ rpc: options.fixture.readOnlyRpc, manifest: options.fixture.manifest, utility: options.fixture.utility });
  const relay = privateKeyToAccount(`0x${'77'.repeat(32)}`);
  const recovery = kitMode ? createLocalWalletRecovery({ audience: 'https://juicebox.center', smart: options.smart, authority: options.authority,
    recoveries: new PostgresWalletRecoveryStore(options.pool, { origin, rpId: 'localhost' },
      { audience: 'https://juicebox.center', observe: context => recoveryObserver.observe(context) }),
    flows: new PostgresWalletRecoveryFlowStore(options.pool),
    rotation: createLocalAnvilWalletRecovery({ pool: options.pool, endpoint: options.fixture.endpoint, expectedGenesisHash: options.fixture.expectedGenesisHash,
      signer: relay, manifest: options.fixture.manifest, utility: options.fixture.utility, maximumOperations: 2, maximumCostWei: '1000000000000000000' }) }) : null;
  if (kitMode) await options.fixture.rpc('anvil_setBalance', [relay.address, toHex(10n ** 20n)]);
  const bundle = async (entry: string) => (await build({ entryPoints: [entry], bundle: true, platform: 'browser', format: 'esm', write: false })).outputFiles[0]!.text;
  const [browserScript, signupBrowserScript] = await Promise.all([bundle('src/rest/web/wallet.ts'), bundle('src/rest/web/walletSignup.ts')]);
  const recoveryBrowserScript = recovery ? await bundle('src/rest/web/walletRecoveryJourney.ts') : undefined;
  app = createWalletSite({ origin, audience: 'https://juicebox.center', browserScript, signup, signupBrowserScript, login,
    ...(recovery ? { recovery, recoveryBrowserScript: recoveryBrowserScript! } : {}),
    // No app handoff is involved in this signup/login observation.
    handoff: {} as never, policy: {} as never,
    refresh: { request: accountId => options.authority.refreshAuthority(accountId), tick: async () => ({}) } });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1000, height: 850 } });
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.name));
  page.setDefaultTimeout(15000);
  await page.exposeFunction('recoveryTestRequest', async (input: { method: string; params?: unknown[] }) => {
    if (kitMode) throw new Error('First-time signup must not request an external wallet.');
    if (input.method === 'eth_requestAccounts') return [enrollmentBackupAccount.address];
    if (input.method === 'eth_signTypedData_v4') {
      expect(input.params?.[0]).toBe(enrollmentBackupAccount.address);
      return enrollmentBackupAccount.signTypedData(JSON.parse(input.params?.[1] as string) as TypedDataDefinition);
    }
    throw new Error('Unsupported test recovery wallet method.');
  });
  await page.addInitScript(() => {
    (window as any).ethereum = { request: (input: unknown) => (window as any).recoveryTestRequest(input) };
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  } });
  const out = new URL(`../../.generated/wallet-observations/signup-browser${kitMode ? '-kit' : ''}/`, import.meta.url);
  // Match the browser's existing wait budget, rather than Vitest's one-second
  // polling default. The enclosing journey and all server deadlines stay bounded.
  const contains = async (text: string) => expect.poll(() => page.locator('#wallet-status').textContent(), { timeout: 15000 }).toContain(text);
  try {
    await page.goto(origin + '/wallet/create');
    await page.getByLabel('Passkey name').fill('Juicebox test');
    if (!kitMode) await page.getByLabel('A wallet you already have').check();
    await page.getByRole('button', { name: 'Sign up' }).click();
    await contains('Create your named passkey');
    await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: false });
    await page.getByRole('button', { name: 'Create passkey', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel prompt' }).click();
    await contains('cancelled');
    await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: true });
    await page.getByRole('button', { name: 'Create passkey', exact: true }).click();
    await contains('Check the original signup');
    await page.getByRole('button', { name: 'Check signup' }).click();
    await contains('Prove access');
    await page.getByRole('button', { name: 'Verify both owners' }).click();
    await contains('Review and approve');
    const originalAddress = await page.locator('#signup-address').textContent();
    await page.getByRole('button', { name: 'Review wallet creation' }).click();
    await page.getByRole('button', { name: 'Approve wallet creation' }).click();
    await contains('Creating your wallet');
    const cookie = (await context.cookies()).find(item => item.name === walletSignupCookie)!;
    const flow = (await flows.authenticate(cookie.value))!, deploymentId = flow.deploymentId!;
    await signup.tick();
    const dispatch = (await options.deployments.getDispatch(deploymentId))!;
    await new Promise(resolve => setTimeout(resolve, Math.max(1, dispatch.leaseUntil - Date.now() + 20)));
    await options.fixture.rpc('anvil_mine', ['0x41', '0x0']); await signup.tick();
    let encoded = '';
    if (kitMode) {
      // The kit is presented once the wallet exists; saving it unlocks browser setup.
      await page.getByRole('button', { name: 'Check signup' }).click();
      await contains('Authorize this browser');
      expect(await page.getByRole('button', { name: 'Review browser setup' }).isDisabled()).toBe(true);
      const downloaded = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download recovery kit' }).click();
      const stream = await (await downloaded).createReadStream(), chunks = [];
      if (!stream) throw new Error('No recovery download.');
      for await (const chunk of stream) chunks.push(chunk);
      encoded = Buffer.concat(chunks).toString('utf8'); const kit = JSON.parse(encoded);
      recoveryKitText = encoded;
      expect(kit.walletAddress.toLowerCase()).toBe(originalAddress?.toLowerCase());
      expect(kit.mnemonic.split(' ')).toHaveLength(24);
      expect(await page.getByRole('button', { name: 'Review browser setup' }).isDisabled()).toBe(false);
      const wrong = JSON.stringify({ ...kit, walletAddress: '0x' + '44'.repeat(20) });
      await page.locator('#recovery-verify summary').click();
      await page.getByLabel('Recovery kit file').setInputFiles({ name: 'wrong.json', mimeType: 'application/json', buffer: Buffer.from(wrong) });
      await contains('does not match');
    }
    await context.clearCookies({ name: walletSignupCookie });
    await page.reload();
    await page.getByRole('link', { name: 'log in' }).click();
    await contains('Authorize this browser');
    expect(await page.locator('#signup-address').textContent()).toBe(originalAddress);
    expect(await flows.authenticate(cookie.value)).toBeNull();
    if (kitMode) {
      const kit = JSON.parse(encoded);
      expect(await page.locator('#recovery-phrase').textContent()).toBe('');
      await page.setViewportSize({ width: 320, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.locator('#recovery-verify summary').click();
      await page.getByLabel('Recovery kit file').setInputFiles({ name: 'recovery.json', mimeType: 'application/json', buffer: Buffer.from(encoded) });
      await contains('Recovery kit verified');
      expect(await page.locator('#recovery-phrase').textContent()).toBe('');
      const persisted = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
      expect(persisted.includes(kit.mnemonic)).toBe(false);
      expect(requestBodies.some(body => body.includes(kit.mnemonic))).toBe(false);
      await page.setViewportSize({ width: 1000, height: 850 });
    }
    await page.getByRole('button', { name: 'Review browser setup' }).click();
    await page.getByRole('button', { name: 'Approve browser setup' }).click();
    await contains('Check the original signup');
    await page.getByRole('button', { name: 'Check signup' }).click();
    await contains('Your wallet is ready');
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('center:signup:browser:')))).toEqual([]);
    await mkdir(out, { recursive: true });
    await page.screenshot({ path: new URL('signup-desktop.png', out).pathname, fullPage: true });
    await page.setViewportSize({ width: 320, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: new URL('signup-mobile.png', out).pathname, fullPage: true });
    await page.getByRole('link', { name: 'Sign in with your passkey' }).click();
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await contains('You are signed in');
    expect((await page.locator('#wallet-address').textContent())?.toLowerCase()).toBe(originalAddress?.toLowerCase());
    if (recovery) {
      await exerciseRecoveryBrowser({ page, context, cdp, authenticatorId, origin, recovery, login, kitText: recoveryKitText!, requestBodies });
      expect(lostRecoveryPaths.size).toBe(3);
    }
    expect(errors).toEqual([]); expect(lostRegistration && lostSetup).toBe(true);
    expect((await options.deployments.getSettlement(deploymentId))?.nextNonce).toBe(options.expectedNextNonce ?? '5');
    await writeFile(new URL('summary.json', out), JSON.stringify({ passed: true, browser: browser.version(),
      evidence: 'real HTTP, PostgreSQL, unforked Anvil; virtual authenticator and test EOA',
      recoveryMode: options.recoveryMode ?? 'wallet', ...(kitMode ? { savedKitRestored: true, wrongKitRejected: true, phraseAbsentFromStorageAndRequests: true } : {}),
      cancelledPrompt: true, lostRegistrationReplyRecovered: lostRegistration, lostSetupReplyRecovered: lostSetup,
      cookieLossResumedSameWallet: true, separateFreshLogin: true, mobileWidth: 320, pageErrors: errors, requests: observed }, null, 2));
  } finally { await recovery?.stop(); await signup.stop(); await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
