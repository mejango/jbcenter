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
import { createWalletNetworks } from '../../src/rest/wallet/networks.js';
import { PostgresWalletAuthorityStore } from '../../src/rest/wallet/authorityPostgres.js';
import { PostgresWalletNetworksStore } from '../../src/rest/wallet/networksPostgres.js';
import { RELAYR_NATIVE_TOKEN, RELAYR_PAYMENT_ADDRESS, RELAYR_PAYMENT_SELECTOR } from '../../src/rest/sponsorship/constants.js';
import { RELAYR_PAYMENT_RUNTIME } from './relayr-payment.js';
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
    if (kitMode && response.ok && ['/recovery/register', '/recovery/rotation/approve', '/recovery/activate'].includes(path)
      && !lostRecoveryPaths.has(path)) {
      lostRecoveryPaths.add(path); return new Response('Unavailable after commit', { status: 503 });
    }
    // The kit journey loses the setup reply and logs in by hand; the wallet journey keeps it and
    // proves the single "Continue" click carries the user from setup into the signed-in wallet.
    // The kit journey loses the registration and setup replies and recovers by hand; the wallet
    // journey keeps them and proves one click runs create, check and approve, then setup and login.
    if (response.ok && kitMode && ((path === '/signup/register' && !lostRegistration) || (path === '/signup/activate' && !lostSetup))) {
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
  let refreshHold: Promise<void> = Promise.resolve(), releaseRefresh = () => {};
  const recoveryObserver = createWalletAuthorityChain({ rpc: options.fixture.readOnlyRpc, manifest: options.fixture.manifest, utility: options.fixture.utility });
  const relay = privateKeyToAccount(`0x${'77'.repeat(32)}`);
  const recovery = kitMode ? createLocalWalletRecovery({ audience: 'https://juicebox.center', smart: options.smart, authority: options.authority,
    recoveries: new PostgresWalletRecoveryStore(options.pool, { origin, rpId: 'localhost' },
      { audience: 'https://juicebox.center', observe: context => recoveryObserver.observe(context) }),
    flows: new PostgresWalletRecoveryFlowStore(options.pool),
    rotation: createLocalAnvilWalletRecovery({ pool: options.pool, endpoint: options.fixture.endpoint, expectedGenesisHash: options.fixture.expectedGenesisHash,
      signer: relay, manifest: options.fixture.manifest, utility: options.fixture.utility, maximumOperations: 2, maximumCostWei: '1000000000000000000' }) }) : null;
  if (kitMode) await options.fixture.rpc('anvil_setBalance', [relay.address, toHex(10n ** 20n)]);
  // The account on more chains: Relayr is faked (one quote, then "Included" once the payment landed),
  // Optimism reads are faked (code appears after the payment), the payment itself lands on the Base anvil.
  const networksPayer = privateKeyToAccount(`0x${'88'.repeat(32)}`), networksBundleUuid = 'c0ffee00-4444-4111-aaaa-333333333333';
  let networksPaid = false;
  await options.fixture.rpc('anvil_setBalance', [networksPayer.address, toHex(10n ** 18n)]);
  await options.fixture.rpc('anvil_setCode', [RELAYR_PAYMENT_ADDRESS, RELAYR_PAYMENT_RUNTIME]);
  const networksProvider = { entries: [] as { chain: number; target: string; data: string; value: string }[],
    async createIndependent(entries: { chain: number; target: string; data: string; value: string }[]) {
      networksProvider.entries = entries; const deadline = Math.floor(Date.now() / 1000) + 900;
      return { bundle_uuid: networksBundleUuid, tx_uuids: entries.map((_, i) => `d1d1d1d1-0000-4000-8000-00000000000${i}`),
        payment_info: [{ chain: 8453, target: RELAYR_PAYMENT_ADDRESS, token: RELAYR_NATIVE_TOKEN, amount: '12000000000000', payment_deadline: String(deadline),
          calldata: `${RELAYR_PAYMENT_SELECTOR}${networksBundleUuid.replaceAll('-', '')}${'0'.repeat(32)}${deadline.toString(16).padStart(64, '0')}` }] }; },
    async status(uuid: string) { return { bundle_uuid: uuid, transactions: networksProvider.entries.map((entry, i) => ({ tx_uuid: `d1d1d1d1-0000-4000-8000-00000000000${i}`,
      request: entry, status: { state: networksPaid ? 'Included' : 'Pending', data: networksPaid ? { hash: `0x${'ab'.repeat(32)}` } : {} } })) }; } };
  let networksWalletAddress = '';
  const networksRpc = { async request(chainId: number, method: string, params: readonly unknown[]) {
    if (chainId === 8453) { const result = await options.fixture.rpc(method, params); if (method === 'eth_sendRawTransaction') networksPaid = true; return result; }
    // Optimism: the creation stack reads come from the same anvil bytes; the account appears once the payment landed.
    if (method === 'eth_getCode') {
      const address = String(params[0]).toLowerCase();
      if (address === networksWalletAddress) return networksPaid ? '0x6001' : '0x';
      return options.fixture.rpc(method, params);
    }
    if (method === 'eth_call') return `0x${'00'.repeat(12)}${networksWalletAddress.slice(2)}`;
    throw new Error(`Unexpected ${method} on chain ${chainId}`); } };
  const networks = createWalletNetworks({ enrollments: options.enrollments, authority: new PostgresWalletAuthorityStore(options.pool),
    store: new PostgresWalletNetworksStore(options.pool), provider: networksProvider, rpc: networksRpc,
    payer: { address: networksPayer.address, signTransaction: transaction => networksPayer.signTransaction(transaction) } });
  const bundle = async (entry: string) => (await build({ entryPoints: [entry], bundle: true, platform: 'browser', format: 'esm', write: false })).outputFiles[0]!.text;
  const [browserScript, signupBrowserScript] = await Promise.all([bundle('src/rest/web/wallet.ts'), bundle('src/rest/web/walletSignup.ts')]);
  const recoveryBrowserScript = recovery ? await bundle('src/rest/web/walletRecoveryJourney.ts') : undefined;
  app = createWalletSite({ origin, basePath: '', audience: 'https://juicebox.center', browserScript, signup, signupBrowserScript, login,
    ...(recovery ? { recovery, recoveryBrowserScript: recoveryBrowserScript! } : {}), networks,
    // No app handoff is involved in this signup/login observation.
    handoff: {} as never, policy: {} as never,
    // The site kicks the authority refresh after setup; holding it makes the "preparing" phase
    // observable before the worker (inline here) verifies the authority and login opens.
    refresh: { request: async accountId => { await refreshHold; await options.authority.refreshAuthority(accountId); }, tick: async () => ({}) } });
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
  // The page asks before going on only when something would be lost or is unexpected; "Continue" answers it.
  const proceed = async (title: string) => {
    await expect.poll(() => page.locator('#explain-title').textContent(), { timeout: 15000 }).toBe(title);
    await page.locator('#explain-continue').click();
  };
  try {
    await page.goto(origin + '/');
    const fillForm = async () => {
      await page.getByLabel('Passkey name').fill('Juicebox test');
      if (!kitMode) await page.getByLabel('A wallet you already have').check();
    };
    await fillForm();
    // Sign up opens the passkey prompt at once; a cancelled prompt leaves the explicit button as the fallback.
    await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: false });
    await page.getByRole('button', { name: 'Sign up' }).click();
    // A prompt waiting on the user is not work in flight: the status mark holds still.
    await expect.poll(() => page.locator('#wallet-status').getAttribute('data-state'), { timeout: 5000 }).toBe('ready');
    await page.getByRole('button', { name: 'Cancel prompt' }).click();
    await contains('cancelled');
    // Starting over forgets the continuation and shows the clean form again.
    await page.getByRole('button', { name: 'Start over' }).click();
    await expect.poll(() => page.getByLabel('Passkey name').isVisible()).toBe(true);
    expect((await context.cookies()).some(item => item.name === walletSignupCookie)).toBe(false);
    await fillForm();
    await page.getByRole('button', { name: 'Sign up' }).click();
    // The prompt opens straight from the tap; cancelling it leaves the explicit button as the fallback.
    await page.getByRole('button', { name: 'Cancel prompt' }).click();
    await contains('cancelled');
    // A begun signup without a passkey yet still offers "log in" for someone who already has an account.
    expect(await page.getByRole('link', { name: 'log in' }).isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Create passkey', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel prompt' }).click();
    await contains('cancelled');
    await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: true });
    await page.getByRole('button', { name: 'Create passkey', exact: true }).click();
    if (kitMode) {
      await contains('Check the original signup');
      await page.getByRole('button', { name: 'Check signup' }).click();
      await contains('Your passkey is ready');
      expect((await page.locator('#signup-recovery').textContent())?.toLowerCase()).toBe('a backup password you get once the account exists');
      // One click and one prompt approve creation and prove the passkey.
      await page.getByRole('button', { name: 'Create account', exact: true }).click();
    }
    await contains('Creating your account');
    const originalAddress = await page.locator('#signup-address').textContent();
    networksWalletAddress = (originalAddress ?? '').toLowerCase();
    if (!kitMode) expect((await page.locator('#signup-recovery').textContent())?.toLowerCase()).toBe(enrollmentBackupAccount.address.toLowerCase());
    // A manual check while creation is still running answers at once; the page's own polling then
    // notices the created wallet, so the kit appears without another click.
    await page.getByRole('button', { name: 'Check signup' }).click();
    await contains('Still creating your account');
    const cookie = (await context.cookies()).find(item => item.name === walletSignupCookie)!;
    const flow = (await flows.authenticate(cookie.value))!, deploymentId = flow.deploymentId!;
    await signup.tick();
    // Under load the dispatch may already have settled by now; only an open lease needs waiting out.
    const dispatch = await options.deployments.getDispatch(deploymentId);
    if (dispatch) await new Promise(resolve => setTimeout(resolve, Math.max(1, dispatch.leaseUntil - Date.now() + 20)));
    await options.fixture.rpc('anvil_mine', ['0x41', '0x0']); await signup.tick();
    let encoded = '';
    if (kitMode) {
      // The kit is presented once the wallet exists; saving it unlocks browser setup.
      await contains('save your backup password');
      // The password stays masked until asked for, and copies through the clipboard.
      expect(await page.locator('#recovery-phrase').getAttribute('type')).toBe('password');
      await page.getByRole('button', { name: 'Show' }).click();
      const shown = await page.locator('#recovery-phrase').inputValue();
      expect(await page.locator('#recovery-phrase').getAttribute('type')).toBe('text');
      expect(shown.split(' ')).toHaveLength(24);
      await page.getByRole('button', { name: 'Hide' }).click();
      // Continuing before saving is allowed, after a plain warning that can be declined.
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await expect.poll(() => page.locator('#explain-title').textContent()).toBe('Nothing saved yet');
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
      await contains('Cancelled');
      const downloaded = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Save backup file' }).click();
      const stream = await (await downloaded).createReadStream(), chunks = [];
      if (!stream) throw new Error('No recovery download.');
      for await (const chunk of stream) chunks.push(chunk);
      encoded = Buffer.concat(chunks).toString('utf8'); const kit = JSON.parse(encoded);
      recoveryKitText = encoded;
      expect(kit.walletAddress.toLowerCase()).toBe(originalAddress?.toLowerCase());
      expect(kit.mnemonic.split(' ')).toHaveLength(24);
      expect(kit.mnemonic).toBe(shown);
    }
    await context.clearCookies({ name: walletSignupCookie });
    await page.reload();
    await page.getByRole('link', { name: 'log in' }).click();
    await proceed('Pick up your signup');
    await contains('Your account is ready');
    expect(await page.locator('#signup-address').textContent()).toBe(originalAddress);
    expect(await flows.authenticate(cookie.value)).toBeNull();
    if (kitMode) {
      const kit = JSON.parse(encoded);
      expect(await page.locator('#recovery-phrase').inputValue()).toBe('');
      await page.setViewportSize({ width: 320, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      // After a reload the words are gone: the page names the backup password's address and offers a start over.
      expect(await page.locator('#recovery-restore-box').isVisible()).toBe(true);
      expect(await page.getByRole('link', { name: 'start over' }).isVisible()).toBe(true);
      expect(await page.locator('#signup-recovery-label').textContent()).toBe('Backup password address');
      expect((await page.locator('#signup-recovery').textContent())?.toLowerCase()).toBe(String(kit.recoveryOwner).toLowerCase());
      expect(await page.getByRole('button', { name: 'Continue', exact: true }).isDisabled()).toBe(false);
      const persisted = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
      expect(persisted.includes(kit.mnemonic)).toBe(false);
      expect(requestBodies.some(body => body.includes(kit.mnemonic))).toBe(false);
      await page.setViewportSize({ width: 1000, height: 850 });
    }
    await mkdir(out, { recursive: true });
    await page.screenshot({ path: new URL('signup-desktop.png', out).pathname, fullPage: true });
    await page.setViewportSize({ width: 320, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: new URL('signup-mobile.png', out).pathname, fullPage: true });
    await page.setViewportSize({ width: 1000, height: 850 });
    refreshHold = new Promise<void>(resolve => { releaseRefresh = resolve; });
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    if (kitMode) {
      await contains('Check the original signup');
      await page.getByRole('button', { name: 'Check signup' }).click();
    }
    // Setup is committed, but login needs the verified authority; the page says so and polls.
    await contains('Preparing your login');
    expect(await page.locator('#wallet-status').getAttribute('data-state')).toBe('busy');
    expect(await page.getByRole('button', { name: 'Log in', exact: true }).isVisible()).toBe(false);
    releaseRefresh(); refreshHold = Promise.resolve();
    await contains('Log in with your passkey');
    if (kitMode) expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('center:signup:browser:')))).toEqual([]);
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await contains('You are signed in');
    expect((await page.locator('#wallet-address').textContent())?.toLowerCase()).toBe(originalAddress?.toLowerCase());
    expect(await page.locator('#wallet-passkey').textContent()).toBe('Juicebox test');
    if (!kitMode) {
      // "Add more": one click quotes and prompts the passkey once, Center pays on Base, Optimism shows the account.
      await expect.poll(() => page.getByRole('button', { name: 'Add more' }).isVisible()).toBe(true);
      await page.getByRole('button', { name: 'Add more' }).click();
      // One family at a time: Relayr never mixes mainnets and testnets in a bundle.
      await expect.poll(() => page.getByLabel('Base Sepolia', { exact: true }).count()).toBe(0);
      await page.getByLabel('Testnets', { exact: true }).check();
      await expect.poll(() => page.getByLabel('Base Sepolia', { exact: true }).count()).toBe(1);
      expect(await page.getByLabel('Optimism', { exact: true }).count()).toBe(0);
      await page.getByLabel('Mainnets', { exact: true }).check();
      await page.getByLabel('Optimism', { exact: true }).check();
      await page.screenshot({ path: new URL('networks-picker.png', out).pathname, fullPage: true });
      await page.getByRole('button', { name: 'Deploy', exact: true }).click();
      await expect.poll(() => page.locator('#wallet-networks').textContent(), { timeout: 30000 }).toBe('Base, Optimism');
      expect(networksProvider.entries).toHaveLength(1);
      expect(networksProvider.entries[0]).toMatchObject({ chain: 10, target: options.fixture.manifest.factory.address, value: '0' });
      expect(networksProvider.entries[0]!.data.startsWith('0x1688f0b9')).toBe(true); // createProxyWithNonce, the same call that created it on Base
      await contains('Your account is on 2 networks');
      await page.screenshot({ path: new URL('networks-done.png', out).pathname, fullPage: true });
      const payment = await options.fixture.rpc<{ to: string; value: string }[]>('eth_getBlockByNumber', ['latest', true]).then(block => (block as unknown as { transactions: { to: string; value: string }[] }).transactions);
      expect(payment.some(tx => tx.to?.toLowerCase() === RELAYR_PAYMENT_ADDRESS.toLowerCase() && BigInt(tx.value) === 12000000000000n)).toBe(true);
    }
    if (recovery) {
      await exerciseRecoveryBrowser({ page, context, cdp, authenticatorId, origin, recovery, login, requestBodies, kitText: recoveryKitText!,
        hold: { arm: () => { refreshHold = new Promise<void>(resolve => { releaseRefresh = resolve; }); }, release: () => { releaseRefresh(); refreshHold = Promise.resolve(); } } });
      expect(lostRecoveryPaths.size).toBe(3);
    }
    expect(errors).toEqual([]); expect(lostRegistration).toBe(kitMode); expect(lostSetup).toBe(kitMode);
    expect((await options.deployments.getSettlement(deploymentId))?.nextNonce).toBe(options.expectedNextNonce ?? '5');
    await writeFile(new URL('summary.json', out), JSON.stringify({ passed: true, browser: browser.version(),
      evidence: 'real HTTP, PostgreSQL, unforked Anvil; virtual authenticator and test EOA',
      recoveryMode: options.recoveryMode ?? 'wallet', ...(kitMode ? { reloadOffersStartOver: true, phraseAbsentFromStorageAndRequests: true } : {}),
      cancelledPrompt: true, lostRegistrationReplyRecovered: lostRegistration, lostSetupReplyRecovered: lostSetup,
      cookieLossResumedSameWallet: true, separateFreshLogin: true, mobileWidth: 320, pageErrors: errors, requests: observed }, null, 2));
  } finally { await recovery?.stop(); await signup.stop(); await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
