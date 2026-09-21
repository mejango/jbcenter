// Local acceptance harness. All wallet execution is on a freshly spawned,
// unforked Anvil; the real client uses its installed SDK and the real Center HTTP
// handlers/stores. Browser routing bridges the fixture HTTPS name to loopback;
// this does not qualify a production TLS/proxy deployment or real Base funding.
import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { build } from 'esbuild';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Pool } from 'pg';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { hashTypedData, toHex } from 'viem';
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { PostgresWalletEnrollmentStore } from '@center/src/rest/wallet/enrollmentPostgres.js';
import { walletEnrollmentDocument } from '@center/src/rest/wallet/enrollment.js';
import { PostgresWalletDeploymentStore } from '@center/src/rest/wallet/deploymentPostgres.js';
import { createWalletDeploymentExecution } from '@center/src/rest/wallet/deploymentExecution.js';
import { createLocalAnvilWalletDeploymentTransport } from '@center/src/rest/wallet/deploymentLocalAnvil.js';
import { createLocalAnvilWalletDeploymentSettlement } from '@center/src/rest/wallet/deploymentSettlementLocalAnvil.js';
import { createSmartAccountService } from '@center/src/rest/smartAccounts/service.js';
import { PostgresSmartAccountRegistry } from '@center/src/rest/smartAccounts/postgres.js';
import { PostgresOnboardingStore } from '@center/src/rest/smartAccounts/onboardingPostgres.js';
import { createSafe7579Inspector } from '@center/src/rest/smartAccounts/inspector.js';
import { createInstalledSessionVerifier } from '@center/src/rest/smartAccounts/installed.js';
import { PostgresWalletAuthorityStore } from '@center/src/rest/wallet/authorityPostgres.js';
import { createWalletAuthorityChain } from '@center/src/rest/wallet/authorityChain.js';
import { createWalletAuthorityService } from '@center/src/rest/wallet/authorityService.js';
import { PostgresWalletLoginStore } from '@center/src/rest/wallet/loginPostgres.js';
import { PostgresWalletSignupStore } from '@center/src/rest/wallet/signupPostgres.js';
import { createLocalWalletSignup } from '@center/src/rest/wallet/signup.js';
import { createWalletSite } from '@center/src/rest/wallet/site.js';
import { PostgresWalletPolicyStore } from '@center/src/rest/wallet/policyPostgres.js';
import { PostgresWalletHandoffStore } from '@center/src/rest/wallet/handoffPostgres.js';
import { passkeyOnboardingProofDocument } from '@center/src/rest/smartAccounts/passkeyOnboarding.js';
import { verifyWalletAssertion } from '@center/src/rest/wallet/webauthn.js';
import { encodeSafe7579MessageSignature } from '@center/src/rest/smartAccounts/passkeySignatures.js';
import { createRegistration, enrollmentBackupAccount, signBackupProof, signGet } from '@center/test/fixtures/wallet-enrollment-crypto.js';
import { walletLoginTestMigrations } from '@center/test/fixtures/wallet-login-setup.js';
import { startWalletDeploymentAnvil } from '@center/test/fixtures/wallet-deployment-anvil.js';
import { createRestAuth } from '@center/src/rest/auth/service.js';
import { createRestAuthRouter } from '@center/src/rest/auth/router.js';
import { PostgresAccountStore } from '@center/src/rest/auth/postgres.js';
import { REST_AUTH_HEADERS } from '@center/src/rest/auth/signatures.js';
import { createApp as createBeepApp } from '@beep/dist/app.js';
import { Store as BeepStore } from '@beep/dist/store.js';
import { Protocol as BeepProtocol, BASE } from '@beep/dist/protocol.js';

const base = process.env.HOMERUN_PILOT_ORIGIN!, issuer = 'https://wallet.juicebox.center', audience = 'https://juicebox.center';
const rpId = new URL(issuer).hostname, root = fileURLToPath(new URL('../../', import.meta.url));
const beepDirectory = process.env.BEEP_PILOT_ROOT!;
const output = root + '/.generated/wallet-observations/shared-clients';
const encode = (value: string) => Buffer.from(value, 'base64url').toString('base64');

it('shares one real Center session and deployed wallet across actual Homerun and Beep', async () => {
  const schema = 'client_pilot_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL, connectionTimeoutMillis: 3000, query_timeout: 10000 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema} -c statement_timeout=10000`,
    connectionTimeoutMillis: 3000, query_timeout: 10000, max: 5 });
  let fixture: Awaited<ReturnType<typeof startWalletDeploymentAnvil>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let server: ReturnType<typeof serve> | undefined;
  let beepServer: ReturnType<typeof serve> | undefined, beepStore: BeepStore | undefined;
  try {
    for (const name of [...new Set([...walletLoginTestMigrations, '016_rest_wallet_deployments.sql',
      '018_rest_wallet_deployment_observations.sql', '021_rest_wallet_deployment_dispatch.sql', '024_wallet_handoff.sql',
      '026_wallet_deployment_settlement.sql', '027_wallet_signup.sql'])].sort())
      await pool.query(await readFile(`${root}/src/db/migrations/${name}`, 'utf8'));
    fixture = await startWalletDeploymentAnvil();
    const enrollments = new PostgresWalletEnrollmentStore(pool), deployments = new PostgresWalletDeploymentStore(pool);
    const settlement = createLocalAnvilWalletDeploymentSettlement(fixture);
    await fixture.rpc('anvil_setBalance', [fixture.sender, toHex(BigInt(fixture.configuration.allocationWei))]);
    await deployments.configurePool(fixture.configuration);
    const funding = await deployments.loadFundingContext(fixture.configuration.id);
    await deployments.initializeAccounting(funding, await settlement.observeFunding(funding), '2');
    const execution = createWalletDeploymentExecution({ store: deployments, chain: fixture.chain(), dispatchLeaseMs: 500,
      signer: mnemonicToAccount('test test test test test test test test test test test junk'),
      experimentalTransport: createLocalAnvilWalletDeploymentTransport(fixture) });
    const smart = createSmartAccountService({ rpc: fixture.readOnlyRpc, manifests: [fixture.manifest], audience,
      registry: new PostgresSmartAccountRegistry(pool), onboarding: new PostgresOnboardingStore(pool),
      moduleInspectors: [createSafe7579Inspector({ rpc: fixture.readOnlyRpc, utility: fixture.utility,
        inspectSessions: createInstalledSessionVerifier({ rpc: fixture.readOnlyRpc }).inspectAllAt })] });
    const authority = createWalletAuthorityService({ store: new PostgresWalletAuthorityStore(pool),
      chain: createWalletAuthorityChain({ rpc: fixture.readOnlyRpc, manifest: fixture.manifest, utility: fixture.utility }) });
    const flows = new PostgresWalletSignupStore(pool, { origin: issuer, rpId, manifest: fixture.manifest });
    const signup = createLocalWalletSignup({ flows, enrollments, deployments, settlement, execution, smart, authority,
      registry: new PostgresSmartAccountRegistry(pool), chain: fixture.chain(), poolId: fixture.configuration.id });
    const begun = await signup.begin({ recoveryOwner: enrollmentBackupAccount.address, passkeyName: 'Juicebox Homerun pilot' });
    const token = begun.flowToken, initial = (await enrollments.get(begun.view.enrollmentId))!;
    const credential = createRegistration({ challenge: `0x${Buffer.from(initial.intent.registration.challenge, 'base64url').toString('hex')}`,
      rpId, origin: issuer, userHandle: initial.intent.userHandle });
    await signup.register(token, credential.response);
    const document = walletEnrollmentDocument((await enrollments.get(initial.intent.id))!);
    await signup.proveEnrollment(token, { assertion: signGet({ ...credential, challenge: hashTypedData(document), rpId, origin: issuer }),
      backupSignature: await signBackupProof(document) });
    const creation = await signup.prepareDeployment(token);
    await signup.approveDeployment(token, { approvalId: creation.id,
      assertion: signGet({ ...credential, challenge: hashTypedData(creation.document), rpId, origin: issuer }) });
    await signup.tick();
    const dispatch = (await deployments.getDispatch(creation.id))!;
    await new Promise(resolve => setTimeout(resolve, Math.max(1, dispatch.leaseUntil - Date.now() + 20)));
    await fixture.rpc('anvil_mine', ['0x41', '0x0']); await signup.tick();
    expect((await signup.status(token)).phase).toBe('awaiting_setup');
    const requestKey = privateKeyToAccount(generatePrivateKey());
    const setup = await signup.prepareSetup(token, { browserPublicAddress: requestKey.address });
    const input = (await flows.authenticate(token))!.setup!.input;
    const review = await smart.passkeyOnboardingChallenge(input);
    const assertion = signGet({ ...credential, challenge: review.signingPayload.digest, rpId, origin: issuer });
    const verified = verifyWalletAssertion(assertion, { purpose: 'session', challenge: review.signingPayload.digest, rpId, origin: issuer,
      credential: { id: credential.credentialId, userHandle: credential.userHandle, publicKey: credential.publicKey, backupEligible: true }, requireUserHandle: true });
    expect((await signup.completeSetup(token, { setupId: setup.id,
      signature: encodeSafe7579MessageSignature([{ kind: 'contract', owner: review.state.ownerProfile!.signer.address, signature: verified.contractSignature }]),
      browserProof: await requestKey.signTypedData(passkeyOnboardingProofDocument(review.typedData)) })).phase).toBe('ready_to_sign_in');
    const enrollment = (await enrollments.get(initial.intent.id))!, accountId = enrollment.receipt!.accountId;
    expect((await authority.refreshAuthority(accountId)).snapshot.readiness).toBe('verified');
    let beepApp = new Hono();
    beepServer = serve({ port: 0, hostname: '127.0.0.1', fetch: request => beepApp.fetch(request) });
    if (!beepServer.listening) await once(beepServer, 'listening');
    const beepOrigin = `http://127.0.0.1:${(beepServer.address() as { port: number }).port}`;
    beepStore = new BeepStore(':memory:');
    const terminal = beepStore.createTerminal('Local shared wallet pilot', { chainId: 8453, projectId: '6', chainName: 'Local test chain',
      name: 'Juicebox local pilot', symbol: 'TEST', projectToken: BASE.tokens, owner: BASE.projects,
      terminal: BASE.terminal, usdc: BASE.usdc, checkedBlock: '1' });
    const sale = beepStore.createSale(terminal.id, '1', 'local-pilot-invoice');
    const beepPath = '/i/' + sale.id;
    beepApp = createBeepApp({ store: beepStore, protocol: new BeepProtocol(fixture.endpoint),
      adminKey: 'local-acceptance-only-no-production-authority', origin: beepOrigin, paymentsEnabled: false,
      centerWallet: { enabled: true, issuer, audience, callbackUri: beepOrigin + '/center/callback',
        manifest: { id: fixture.manifest.id, revision: fixture.manifest.revision }, maximumNetworkFee: '100000000000000' } });
    const beepRoot = beepDirectory + '/web-dist';
    beepApp.get('/assets/*', serveStatic({ root: beepRoot }));
    beepApp.get('*', async c => {
      if (c.req.path.startsWith('/api/')) return c.json({ error: 'Not found' }, 404);
      return c.html(await readFile(beepRoot + '/index.html', 'utf8'));
    });
    const policy = new PostgresWalletPolicyStore(pool);
    await policy.activate({ expectedRevision: 0, nextRevision: 1, configuration: { version: 'center-wallet-policy-v1',
      applications: [{ origin: base, walletCallbacks: [base + '/center/callback'] },
        { origin: beepOrigin, walletCallbacks: [beepOrigin + '/center/callback'] }] } });
    const login = new PostgresWalletLoginStore(pool, { origin: issuer, rpId });
    const script = (await build({ entryPoints: [root + '/src/rest/web/wallet.ts'], platform: 'browser', bundle: true, format: 'esm', write: false })).outputFiles[0]!.text;
    const app = createWalletSite({ origin: issuer, audience, browserScript: script, policy, login,
      handoff: new PostgresWalletHandoffStore(pool, { issuer, audience }),
      refresh: { request: id => authority.refreshAuthority(id), tick: async () => ({}) } });
    const api = new Hono();
    api.use('*', cors({ origin: [base, beepOrigin], credentials: false, allowMethods: ['GET', 'OPTIONS'],
      allowHeaders: [...Object.values(REST_AUTH_HEADERS), 'Content-Type'] }));
    api.route('/api/v1', createRestAuthRouter(createRestAuth({ audience, store: new PostgresAccountStore(pool,
      { walletRefresh: { request: id => authority.refreshAuthority(id), tick: async () => ({}) } }) }),
      { requestTarget: context => new URL(context.req.url).pathname }));
    // Observation-only browser module: it restores the actual packaged SDK
    // connection and asks the real server to authorize a signed account read.
    // No key or signature is exported into the test report.
    const readScript = (await build({ stdin: { contents: `import { createCenterWalletClient } from '@juicebox/center-client';
      export async function read() {
        const connection = createCenterWalletClient({ issuer: ${JSON.stringify(issuer)}, audience: ${JSON.stringify(audience)},
          callbackUri: location.origin + '/center/callback' }).restoreConnection();
        if (!connection) throw new Error('No client connection');
        return (await connection.client.account()).account.id;
      }`, resolveDir: beepDirectory }, platform: 'browser', bundle: true, format: 'esm', write: false })).outputFiles[0]!.text;
    const transport: { path: string; method: string; status: number; cookie: boolean }[] = [], exchanges: string[] = [];
    server = serve({ port: 0, hostname: '127.0.0.1', fetch: async incoming => {
      const path = new URL(incoming.url).pathname;
      const request = new Request((path.startsWith('/api/') ? audience : issuer) + path + new URL(incoming.url).search, incoming);
      if (path === '/wallet/handoff/exchange' && request.method === 'POST')
        exchanges.push(createHash('sha256').update(await request.clone().text()).digest('hex'));
      const result = await (path.startsWith('/api/') ? api : app).fetch(request);
      const loggedPath = /^\/wallet\/authorize\/[A-Za-z0-9_-]{43}$/.test(path) ? '/wallet/authorize/:intent' : path;
      transport.push({ path: loggedPath, method: request.method, status: result.status, cookie: request.headers.has('cookie') });
      if (path === '/wallet/handoff/exchange' && request.method === 'POST' && exchanges.length === 1 && result.ok)
        return new Response('Lost response after the real grant committed', { status: 503, headers: result.headers });
      return result;
    } });
    if (!server.listening) await once(server, 'listening');
    const local = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, reducedMotion: 'reduce' });
    for (const origin of [issuer, audience]) await context.route(origin + '/**', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === '/wallet/handoff/exchange' && request.method() === 'POST') {
        const callback = new URL(request.frame().page().url());
        expect(callback.pathname).toBe('/center/callback'); expect(callback.search).toBe(''); expect(callback.hash).toBe('');
      }
      const response = await route.fetch({ url: local + url.pathname + url.search, maxRedirects: 0, maxRetries: 0,
        headers: { ...await request.allHeaders(), host: new URL(origin).host } });
      await route.fulfill({ response });
    });
    for (const origin of [base, beepOrigin]) await context.route(origin + '/__center_pilot_read.js', route =>
      route.fulfill({ contentType: 'text/javascript', body: readScript }));
    const page = await context.newPage(), errors: string[] = [];
    page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.name));
    const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
      protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: { credentialId: encode(credential.credentialId),
      privateKey: credential.key.export({ format: 'der', type: 'pkcs8' }).toString('base64'), userHandle: encode(credential.userHandle),
      rpId, isResidentCredential: true, signCount: 0, backupEligibility: enrollment.candidate!.backupEligible, backupState: enrollment.candidate!.backedUp } });
    await page.goto(base + '/founderhaus');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: 'Continue with a passkey' }).click();
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect.poll(() => page.url()).toBe(base + '/founderhaus');
    await page.getByRole('button', { name: /^Signed in as/ }).waitFor();
    expect(exchanges).toHaveLength(2); expect(exchanges[0]).toBe(exchanges[1]);
    const grants = await pool.query('SELECT grant_document FROM rest_wallet_handoffs WHERE state = $1', ['consumed']);
    expect(grants.rowCount).toBe(1); expect(grants.rows[0].grant_document.accountId).toBe(accountId);
    expect(grants.rows[0].grant_document.scopes).toEqual(['read', 'plan', 'relay']);
    await page.reload(); await page.getByRole('button', { name: /^Signed in as/ }).waitFor();
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: output + '/homerun-connected.png', fullPage: true });
    const beep = await context.newPage(); beep.setDefaultTimeout(15000);
    beep.on('pageerror', error => errors.push(error.name));
    await beep.goto(beepOrigin + beepPath);
    await beep.getByRole('button', { name: 'Juicebox Wallet', exact: true }).click();
    await expect.poll(async () => (await beep.locator('.wallet-address').textContent())?.toLowerCase()).toContain(enrollment.creation!.address.slice(0, 6).toLowerCase());
    await expect.poll(() => beep.url()).toBe(beepOrigin + beepPath);
    await expect.poll(() => beep.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('center.wallet.connection.v1:')).length)).toBe(1);
    const beepAccount = await beep.evaluate(() => JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find(key => key.startsWith('center.wallet.connection.v1:'))!)!).grant.accountId);
    expect(beepAccount).toBe(accountId);
    const shared = await pool.query('SELECT grant_document FROM rest_wallet_handoffs WHERE state = $1 ORDER BY origin', ['consumed']);
    expect(shared.rowCount).toBe(2);
    expect(shared.rows.every(row => row.grant_document.accountId === accountId)).toBe(true);
    expect(new Set(shared.rows.map(row => row.grant_document.signerAddress)).size).toBe(2);
    expect(new Set(shared.rows.map(row => row.grant_document.origin))).toEqual(new Set([base, beepOrigin]));
    expect((await pool.query('SELECT count(*)::int AS n FROM rest_wallet_logins WHERE completed_at_ms IS NOT NULL')).rows[0].n).toBe(1);
    expect(transport.filter(item => item.path === '/wallet/handoff/exchange' && item.method === 'POST')).toHaveLength(3);
    expect(transport.filter(item => item.path.startsWith('/wallet/handoff/') && item.method === 'POST').every(item => !item.cookie)).toBe(true);
    await beep.reload();
    await expect.poll(async () => (await beep.locator('.wallet-address').textContent())?.toLowerCase()).toContain(enrollment.creation!.address.slice(0, 6).toLowerCase());
    await beep.screenshot({ path: output + '/beep-connected.png', fullPage: true });
    // A browser expression keeps Vitest's server import transform out of the
    // native browser module import. Only public account/status values return.
    const readAccount = (target: typeof page) => target.evaluate(`import('/__center_pilot_read.js')
      .then(module => module.read()).then(accountId => ({ accepted: true, accountId }))
      .catch(error => ({ accepted: false, errorName: error.name }))`);
    const homerunRead = await readAccount(page);
    expect(homerunRead, JSON.stringify(transport.slice(-8))).toEqual({ accepted: true, accountId });
    expect(await readAccount(beep)).toEqual({ accepted: true, accountId });
    const center = await context.newPage();
    await center.goto(issuer + '/wallet');
    await center.locator('#wallet-logout').click();
    await expect.poll(() => center.locator('#wallet-status').getAttribute('data-state')).toBe('ready');
    expect(await readAccount(page)).toMatchObject({ accepted: false });
    expect(await readAccount(beep)).toMatchObject({ accepted: false });
    expect(transport.filter(item => item.path === '/api/v1/accounts/me' && item.method === 'GET').map(item => item.status)).toEqual([200, 200, 403, 403]);
    await page.getByRole('button', { name: /^Signed in as/ }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('center.wallet.connection.v1:')))).toEqual([]);
    expect(errors).toEqual([]);
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: output + '/homerun.png', fullPage: true });
    await writeFile(output + '/summary.json', JSON.stringify({ passed: true,
      observedAt: new Date().toISOString(), client: 'actual Homerun Next app and Beep checkout, pinned SDKs', browser: browser.version(),
      realCenterHttp: true, realPostgres: true, realUnforkedAnvil: true, nativeVirtualPasskeyAssertion: true,
      walletDeployedAndCanonicallyVerified: true, sameExchangeRecoveredAfterLostReply: true,
      grants: 2, centralSessions: 1, sameWalletAcrossClients: true, separateAppKeys: true, credentiallessExchanges: true,
      callbackSecretsScrubbed: true, realSignedReadsBeforeLogout: 2, centralLogoutRevokedBothClients: true,
      reloadRestored: true, localDisconnectCleared: true, pageErrors: errors,
      beepPaymentsEnabled: false, beepProjectQuoteQualified: false,
      productionTlsProxyObserved: false, productionBaseObserved: false, paymentsObserved: false, transport }, null, 2));
  } finally {
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    if (beepServer) { beepServer.closeAllConnections(); await new Promise<void>(resolve => beepServer!.close(() => resolve())); }
    beepStore?.close();
    await fixture?.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});
