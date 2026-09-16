import type { Pool } from 'pg';
import { hashTypedData, toHex, type Address, type Hex } from 'viem';
import { expect } from 'vitest';
import type { WalletEnrollment } from '../../src/rest/wallet/enrollment.js';
import { recoveryFixtureRelay } from './wallet-recovery-crash-runtime.js';
import { PostgresWalletDeviceStore } from '../../src/rest/wallet/devicesPostgres.js';
import { PostgresWalletAuthorityStore } from '../../src/rest/wallet/authorityPostgres.js';
import { PostgresWalletLoginStore } from '../../src/rest/wallet/loginPostgres.js';
import { createWalletAuthorityChain } from '../../src/rest/wallet/authorityChain.js';
import type { createWalletAuthorityService } from '../../src/rest/wallet/authorityService.js';
import type { createSmartAccountService } from '../../src/rest/smartAccounts/service.js';
import { createLocalWalletDevices } from '../../src/rest/wallet/deviceService.js';
import { createWalletDeviceRelay } from '../../src/rest/wallet/deviceRelay.js';
import { createLocalAnvilWalletDeploymentReader } from '../../src/rest/wallet/deploymentLocalAnvil.js';
import { createRegistration, signGet } from './wallet-enrollment-crypto.js';
import type { startWalletDeploymentAnvil } from './wallet-deployment-anvil.js';

/** Adding a device on the actual local chain and database: the primary's session begins, the new
 * device registers and proves, the primary approves the exact owner addition with its passkey,
 * the relay adds the owner, activation records the device, and the device logs in. */
export async function exerciseWalletDeviceEvm(options: {
  pool: Pool; fixture: Pick<Awaited<ReturnType<typeof startWalletDeploymentAnvil>>, 'endpoint' | 'expectedGenesisHash' | 'manifest' | 'utility' | 'rpc' | 'readOnlyRpc' | 'sender'>;
  smart: ReturnType<typeof createSmartAccountService>; authority: ReturnType<typeof createWalletAuthorityService>;
  enrollment: WalletEnrollment; originalKey: ReturnType<typeof createRegistration>; originalSessionToken: string; audience: string;
}) {
  const { pool, fixture, enrollment } = options, rpId = enrollment.intent.rpId, origin = enrollment.intent.origin, accountId = enrollment.receipt!.accountId;
  const observer = createWalletAuthorityChain({ rpc: fixture.readOnlyRpc, manifest: fixture.manifest, utility: fixture.utility });
  const store = new PostgresWalletDeviceStore(pool, { rpId, origin }, { audience: options.audience, observe: context => observer.observe(context) });
  const relay = recoveryFixtureRelay;
  await fixture.rpc('anvil_setBalance', [relay.address, toHex(10n ** 20n)]);
  const local = createLocalAnvilWalletDeploymentReader({ endpoint: fixture.endpoint, expectedGenesisHash: fixture.expectedGenesisHash });
  const addition = createWalletDeviceRelay({ pool, signer: relay, manifest: fixture.manifest, utility: fixture.utility, maximumOperations: 2, maximumCostWei: '1000000000000000000',
    adapter: { configurationVersion: 'unforked-anvil-recovery-v1', kind: 'unforked-anvil', genesisHash: fixture.expectedGenesisHash.toLowerCase() as Hex,
      reads: local.reads, identity: local.identity, send: local.send,
      quote: async () => ({ gas: 3_000_000n, maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }),
      fees: async (_rpc, _raw, receipt) => ({ executionWei: String(receipt.gasUsed * receipt.effectiveGasPrice) }), releaseAfterFinality: false } });
  const service = createLocalWalletDevices({ audience: options.audience, devices: store, addition, smart: options.smart, authority: new PostgresWalletAuthorityStore(pool) });
  // The runtime starts the worker right after creation; it must be startable and stoppable at once.
  service.start(); service.start(); await service.stop();
  const login = new PostgresWalletLoginStore(pool, { rpId, origin });
  const session = (await login.readSession(options.originalSessionToken))!;
  expect(session.accountId).toBe(accountId);

  // Primary: begin. New device: register and prove possession.
  const begun = await service.begin(session, { passkeyName: 'Juicebox phone' });
  expect(begun.view.phase).toBe('awaiting_registration'); expect(begun.linkToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const device = createRegistration({ rpId, origin, userHandle: begun.view.registration!.userHandle,
    challenge: `0x${Buffer.from(begun.view.registration!.challenge, 'base64url').toString('hex')}` });
  const registered = await service.register(begun.linkToken, device.response);
  expect(registered.phase).toBe('awaiting_possession');
  const proved = await service.prove(begun.linkToken, signGet({ ...device, rpId, origin, challenge: registered.possession!.challenge }));
  expect(proved.phase).toBe('awaiting_approval');
  expect((await service.statusForSession(begun.view.id, session)).phase).toBe('awaiting_approval');

  // Primary: review and approve the exact addition with its passkey; the relay adds the owner.
  const prepared = await service.prepareAddition(begun.view.id, session);
  expect(prepared.review.deviceSigner).toBe(proved.deviceSigner);
  const assertion = signGet({ ...options.originalKey, rpId, origin, challenge: prepared.challenge });
  let progressed = await service.approveAddition(begun.view.id, session, { review: prepared.review, assertion });
  for (let attempt = 0; progressed.phase === 'adding' && attempt < 40; attempt++) {
    await service.tick(); await new Promise(resolve => setTimeout(resolve, 25));
    progressed = await service.statusForSession(begun.view.id, session);
  }
  expect(progressed.phase).toBe('awaiting_activation'); expect(progressed.transactionHashes).toHaveLength(2);
  const owners = await fixture.readOnlyRpc.request(8453, 'eth_call', [{ to: accountId.slice(12), data: '0xa0e67e2b' }, 'latest']) as Hex; // getOwners()
  expect(owners.toLowerCase()).toContain(proved.deviceSigner!.slice(2).toLowerCase());

  // Mined but not yet activated: the account cannot review a second addition until this one is recorded.
  const second = await service.begin(session, { passkeyName: 'Second phone' });
  const secondDevice = createRegistration({ rpId, origin, userHandle: second.view.registration!.userHandle,
    challenge: `0x${Buffer.from(second.view.registration!.challenge, 'base64url').toString('hex')}` });
  const secondRegistered = await service.register(second.linkToken, secondDevice.response);
  await service.prove(second.linkToken, signGet({ ...secondDevice, rpId, origin, challenge: secondRegistered.possession!.challenge }));
  await expect(service.prepareAddition(second.view.id, session)).rejects.toMatchObject({ status: 503 });

  // Either page: activate. The account is rebound with the device as an owner.
  const activated = await service.activateForLink(begun.linkToken);
  expect(activated.phase).toBe('ready');
  expect((await service.activateForSession(begun.view.id, session).catch(error => error)).phase ?? 'ready').toBe('ready');
  expect((await options.authority.refreshAuthority(accountId)).snapshot.readiness).toBe('verified');
  const context = await new PostgresWalletAuthorityStore(pool).loadContext(accountId);
  expect(context.credential.credentialId).toBe(options.originalKey.credentialId);
  expect(context.devices!.map(entry => entry.credentialId)).toEqual([device.credentialId]);
  expect(context.devices![0]!.device.signerAddress).toBe(proved.deviceSigner!.toLowerCase());

  // The primary's old session ended with the binding it pinned; both passkeys log in now.
  expect(await login.readSession(options.originalSessionToken)).toBeNull();
  const deviceLogin = await login.begin(), signedIn = await login.complete({ loginId: deviceLogin.login.id, flowToken: deviceLogin.flowToken,
    assertion: signGet({ ...device, rpId, origin, challenge: deviceLogin.login.challenge }) });
  expect(signedIn.session).toMatchObject({ accountId, credentialId: device.credentialId });
  expect(await login.passkeyName(signedIn.session)).toBe('Juicebox phone');
  // Only the primary passkey can approve an addition, so only its session may begin one.
  await expect(service.begin(signedIn.session)).rejects.toMatchObject({ status: 403 });
  const primaryLogin = await login.begin(), primarySignedIn = await login.complete({ loginId: primaryLogin.login.id, flowToken: primaryLogin.flowToken,
    assertion: signGet({ ...options.originalKey, rpId, origin, challenge: primaryLogin.login.challenge }) });
  expect(primarySignedIn.session).toMatchObject({ accountId, credentialId: options.originalKey.credentialId });
  return { device, deviceSigner: proved.deviceSigner as Address, primarySessionToken: primarySignedIn.sessionToken };
}
