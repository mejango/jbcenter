import { mkdir, writeFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { hashTypedData, toHex, type Address, type Hex } from 'viem';
import { expect, vi } from 'vitest';
import type { WalletEnrollment } from '../../src/rest/wallet/enrollment.js';
import { recoveryFixtureRelay } from './wallet-recovery-crash-runtime.js';
import { exerciseRecoverySetupCrash } from './wallet-recovery-crash.js';
import { PostgresWalletRecoveryFlowStore } from '../../src/rest/wallet/recoveryFlowPostgres.js';
import { PostgresWalletRecoveryStore } from '../../src/rest/wallet/recoveryPostgres.js';
import { PostgresWalletAuthorityStore } from '../../src/rest/wallet/authorityPostgres.js';
import { PostgresWalletLoginStore } from '../../src/rest/wallet/loginPostgres.js';
import { PostgresWalletSignupStore } from '../../src/rest/wallet/signupPostgres.js';
import { createWalletAuthorityChain } from '../../src/rest/wallet/authorityChain.js';
import type { createWalletAuthorityService } from '../../src/rest/wallet/authorityService.js';
import type { createSmartAccountService } from '../../src/rest/smartAccounts/service.js';
import { walletRecoveryDocument } from '../../src/rest/wallet/recovery.js';
import { walletRecoveryRotationDocument } from '../../src/rest/wallet/recoveryRotation.js';
import { createLocalAnvilWalletRecovery } from '../../src/rest/wallet/recoveryLocalAnvil.js';
import { createRegistration, enrollmentBackupAccount, signBackupProof, signGet } from './wallet-enrollment-crypto.js';
import type { startWalletDeploymentAnvil } from './wallet-deployment-anvil.js';

/** Actual local chain and database recovery. Public test keys and unforked synthetic
 * balances only; this helper never receives a user wallet provider or production RPC. */
export async function exerciseWalletRecoveryEvm(options: {
  pool: Pool; fixture: Awaited<ReturnType<typeof startWalletDeploymentAnvil>>;
  smart: ReturnType<typeof createSmartAccountService>; authority: ReturnType<typeof createWalletAuthorityService>;
  enrollment: WalletEnrollment; originalKey: ReturnType<typeof createRegistration>; originalSessionToken: string;
  audience: string;
}) {
  const { pool, fixture, enrollment } = options, rpId = enrollment.intent.rpId, origin = enrollment.intent.origin;
  const observer = createWalletAuthorityChain({ rpc: fixture.readOnlyRpc, manifest: fixture.manifest, utility: fixture.utility });
  const recovery = new PostgresWalletRecoveryStore(pool, { rpId, origin, lifetimeMs: 2000 }, { audience: options.audience, observe: context => observer.observe(context) });
  const accountId = enrollment.receipt!.accountId, begun = await recovery.begin(accountId), intent = begun.record.intent;
  await new PostgresWalletRecoveryFlowStore(pool).initialize({ recoveryId: intent.id, flowToken: begun.flowToken, passkeyName: 'Juicebox replacement' });
  const replacement = createRegistration({ rpId, origin, userHandle: intent.userHandle,
    challenge: `0x${Buffer.from(intent.registration.challenge, 'base64url').toString('hex')}` });
  const pending = await recovery.register(intent.id, begun.flowToken, replacement.response), document = walletRecoveryDocument(pending.candidate!);
  await recovery.prove(intent.id, begun.flowToken, { assertion: signGet({ ...replacement, rpId, origin, challenge: hashTypedData(document) }),
    backupSignature: await signBackupProof(document) });
  await pool.query('SELECT pg_sleep(GREATEST(0,($1-extract(epoch FROM clock_timestamp())*1000)/1000)+0.01)', [intent.expiresAtMs]);
  const beforeRotation = await fixture.rpc<Hex>('evm_snapshot');
  // This public fixture key has no owner role and no relation to the signup treasury.
  // The independent backup approves the exact SafeTx using only typed-data signing.
  const relay = recoveryFixtureRelay;
  await fixture.rpc('anvil_setBalance', [relay.address, toHex(10n ** 20n)]);
  const candidate = pending.candidate!;
  const transport = createLocalAnvilWalletRecovery({ pool, endpoint: fixture.endpoint, expectedGenesisHash: fixture.expectedGenesisHash,
    signer: relay, manifest: fixture.manifest, utility: fixture.utility, maximumOperations: 2, maximumCostWei: '1000000000000000000' });
  const rotation = await transport.prepare(intent.id);
  const ownerSignature = await enrollmentBackupAccount.signTypedData(walletRecoveryRotationDocument(rotation));
  let sends = 0;
  const originalFetch = globalThis.fetch, network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const response = await originalFetch(input, init);
    if (String(input) === fixture.endpoint && typeof init?.body === 'string' && JSON.parse(init.body).method === 'eth_sendRawTransaction') {
      sends++;
      if (sends === 1) { await response.body?.cancel(); throw new Error('Injected lost response after local RPC accepted the transaction'); }
    }
    return response;
  });
  let dispatched: Awaited<ReturnType<typeof transport.approve>>;
  try {
    dispatched = await transport.approve(intent.id, rotation, ownerSignature, begun.flowToken);
    for (let attempt = 0; dispatched.state === 'unknown' && attempt < 20; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 25));
      dispatched = await transport.approve(intent.id, rotation, ownerSignature, begun.flowToken);
    }
    expect(dispatched.state).toBe('ready'); expect(sends).toBe(2);
    expect(await transport.approve(intent.id, rotation, ownerSignature, begun.flowToken)).toEqual(dispatched);
    expect(await transport.status(intent.id)).toEqual(dispatched); expect(sends).toBe(2);
  } finally { network.mockRestore(); }
  const signerTransaction = dispatched.transactions.createSigner!, rotationTransaction = dispatched.transactions.rotateOwner!;
  const dispatchHistory = (await pool.query('SELECT * FROM rest_wallet_recovery_transactions WHERE recovery_id=$1 ORDER BY step', [intent.id])).rows;
  expect(dispatchHistory).toHaveLength(2);
  expect(dispatchHistory.every(row => row.attempted_at_ms !== null && row.receipt?.status === 'success')).toBe(true);
  expect((await fixture.rpc<{ from: Address }>('eth_getTransactionByHash', [rotationTransaction])).from.toLowerCase()).toBe(relay.address.toLowerCase());
  expect(relay.address.toLowerCase()).not.toBe(enrollmentBackupAccount.address.toLowerCase());
  expect(relay.address.toLowerCase()).not.toBe(fixture.sender.toLowerCase());
  const { assertion, activated, flowToken, crashObservation } = await exerciseRecoverySetupCrash({ pool, accountId, recoveryId: intent.id,
    flowToken: begun.flowToken, replacement, initializerHash: enrollment.creation!.initializerHash, replacementSigner: candidate.signerAddress, priorCredentialId: options.originalKey.credentialId, relayAddress: relay.address, rpc: fixture.rpc,
    config: { endpoint: fixture.endpoint, expectedGenesisHash: fixture.expectedGenesisHash, manifest: fixture.manifest,
      utility: fixture.utility, origin, rpId, audience: options.audience } });
  expect((await options.authority.refreshAuthority(accountId)).snapshot.readiness).toBe('verified');
  const login = new PostgresWalletLoginStore(pool, { rpId, origin });
  expect(await login.readSession(options.originalSessionToken)).toBeNull();
  const oldLogin = await login.begin();
  await expect(login.complete({ loginId: oldLogin.login.id, flowToken: oldLogin.flowToken,
    assertion: signGet({ ...options.originalKey, rpId, origin, challenge: oldLogin.login.challenge }) })).rejects.toThrow();
  const newLogin = await login.begin(), signedIn = await login.complete({ loginId: newLogin.login.id, flowToken: newLogin.flowToken,
    assertion: signGet({ ...replacement, rpId, origin, challenge: newLogin.login.challenge }) });
  expect(signedIn.session.accountId).toBe(accountId);
  const current = await new PostgresWalletAuthorityStore(pool).loadContext(accountId);
  expect(current.enrollment).toEqual(enrollment); expect(current.credential.credentialId).toBe(replacement.credentialId);
  expect(await recovery.activate(intent.id, flowToken, assertion)).toEqual({ ...activated, replayed: true });
  const flows = new PostgresWalletSignupStore(pool, { rpId, origin, manifest: fixture.manifest }), resume = await flows.beginResume();
  await expect(flows.completeResume({ resumeId: resume.challenge.id, resumeToken: resume.resumeToken,
    assertion: signGet({ ...options.originalKey, rpId, origin, challenge: resume.challenge.challenge }) })).rejects.toThrow();
  const retained = (await pool.query('SELECT credential_id,superseded_at,recovery_receipt FROM rest_wallet_credentials WHERE account_id=$1 ORDER BY credential_id', [accountId])).rows;
  expect(await fixture.rpc('evm_revert', [beforeRotation])).toBe(true);
  expect((await transport.status(intent.id)).state).toBe('unknown');
  expect((await pool.query('SELECT fence FROM rest_wallet_recovery_lanes WHERE sender=$1', [relay.address.toLowerCase()])).rows[0].fence).not.toBeNull();
  expect((await pool.query('SELECT * FROM rest_wallet_recovery_transactions WHERE recovery_id=$1 ORDER BY step', [intent.id])).rows).toEqual(dispatchHistory);
  expect((await options.authority.refreshAuthority(accountId)).snapshot.readiness).not.toBe('verified');
  expect(await login.readSession(signedIn.sessionToken)).toBeNull();
  expect((await pool.query('SELECT credential_id,superseded_at,recovery_receipt FROM rest_wallet_credentials WHERE account_id=$1 ORDER BY credential_id', [accountId])).rows).toEqual(retained);
  const out = new URL('../../.generated/wallet-observations/recovery-evm/', import.meta.url); await mkdir(out, { recursive: true });
  await writeFile(new URL('summary.json', out), JSON.stringify({ passed: true, evidence: 'actual PostgreSQL, unforked Anvil, P256 and independent test EOA',
    signerTransaction, rotationTransaction, separateSyntheticRelayer: true, backupTypedDataSignature: true,
    acceptedTransactionLostReplyRecovered: true, physicalSends: sends, exactDispatchBytesRetainedAfterRollback: true,
    sameSafe: true, originalGenesisRetained: true, crashObservation, newPasskeyLogin: true, oldSessionAndPasskeyRejected: true,
    oldSignupResumeRejected: true, exactActivationRetry: true, chainRollbackFailsClosedWithoutRevertingCredentials: true }, null, 2));
}
