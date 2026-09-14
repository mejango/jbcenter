import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { hashTypedData, toHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { expect, vi } from 'vitest';
import type { WalletEnrollment } from '../../src/rest/wallet/enrollment.js';
import { PostgresWalletRecoveryStore } from '../../src/rest/wallet/recoveryPostgres.js';
import { PostgresWalletAuthorityStore } from '../../src/rest/wallet/authorityPostgres.js';
import { PostgresWalletLoginStore } from '../../src/rest/wallet/loginPostgres.js';
import { PostgresWalletSignupStore } from '../../src/rest/wallet/signupPostgres.js';
import { createWalletAuthorityChain } from '../../src/rest/wallet/authorityChain.js';
import type { createWalletAuthorityService } from '../../src/rest/wallet/authorityService.js';
import type { createSmartAccountService } from '../../src/rest/smartAccounts/service.js';
import { passkeyOnboardingProofDocument } from '../../src/rest/smartAccounts/passkeyOnboarding.js';
import { encodeSafe7579MessageSignature } from '../../src/rest/smartAccounts/passkeySignatures.js';
import { verifyWalletAssertion } from '../../src/rest/wallet/webauthn.js';
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
  const { pool, fixture, enrollment, smart } = options, rpId = enrollment.intent.rpId, origin = enrollment.intent.origin;
  const observer = createWalletAuthorityChain({ rpc: fixture.readOnlyRpc, manifest: fixture.manifest, utility: fixture.utility });
  const recovery = new PostgresWalletRecoveryStore(pool, { rpId, origin, lifetimeMs: 2000 }, { audience: options.audience, observe: context => observer.observe(context) });
  const accountId = enrollment.receipt!.accountId, begun = await recovery.begin(accountId), intent = begun.record.intent;
  const replacement = createRegistration({ rpId, origin, userHandle: intent.userHandle,
    challenge: `0x${Buffer.from(intent.registration.challenge, 'base64url').toString('hex')}` });
  const pending = await recovery.register(intent.id, begun.flowToken, replacement.response), document = walletRecoveryDocument(pending.candidate!);
  await recovery.prove(intent.id, begun.flowToken, { assertion: signGet({ ...replacement, rpId, origin, challenge: hashTypedData(document) }),
    backupSignature: await signBackupProof(document) });
  await pool.query('SELECT pg_sleep(GREATEST(0,($1-extract(epoch FROM clock_timestamp())*1000)/1000)+0.01)', [intent.expiresAtMs]);
  const beforeRotation = await fixture.rpc<Hex>('evm_snapshot');
  // This public fixture key has no owner role and no relation to the signup treasury.
  // The independent backup approves the exact SafeTx using only typed-data signing.
  const relay = privateKeyToAccount(`0x${'55'.repeat(32)}`);
  await fixture.rpc('anvil_setBalance', [relay.address, toHex(10n ** 20n)]);
  const candidate = pending.candidate!, wallet = enrollment.creation!.address;
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
    dispatched = await transport.approve(intent.id, rotation, ownerSignature);
    for (let attempt = 0; dispatched.state === 'unknown' && attempt < 20; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 25));
      dispatched = await transport.approve(intent.id, rotation, ownerSignature);
    }
    expect(dispatched.state).toBe('ready'); expect(sends).toBe(2);
    expect(await transport.approve(intent.id, rotation, ownerSignature)).toEqual(dispatched);
    expect(await transport.status(intent.id)).toEqual(dispatched); expect(sends).toBe(2);
  } finally { network.mockRestore(); }
  const signerTransaction = dispatched.transactions.createSigner!, rotationTransaction = dispatched.transactions.rotateOwner!;
  const dispatchHistory = (await pool.query('SELECT * FROM rest_wallet_recovery_transactions WHERE recovery_id=$1 ORDER BY step', [intent.id])).rows;
  expect(dispatchHistory).toHaveLength(2);
  expect(dispatchHistory.every(row => row.attempted_at_ms !== null && row.receipt?.status === 'success')).toBe(true);
  expect((await fixture.rpc<{ from: Address }>('eth_getTransactionByHash', [rotationTransaction])).from.toLowerCase()).toBe(relay.address.toLowerCase());
  expect(relay.address.toLowerCase()).not.toBe(enrollmentBackupAccount.address.toLowerCase());
  expect(relay.address.toLowerCase()).not.toBe(fixture.sender.toLowerCase());
  const browser = privateKeyToAccount(generatePrivateKey()), now = Math.floor(Date.now() / 1000);
  const input = { profile: 'center-passkey-v1' as const, address: wallet, manifestId: fixture.manifest.id,
    nonce: `0x${randomUUID().replaceAll('-', '').repeat(2)}` as Hex, issuedAt: now, expiresAt: now + 300,
    grant: { id: randomUUID(), botAddress: browser.address, scopes: ['read', 'plan', 'relay'] as ('read' | 'plan' | 'relay')[],
      expiresAt: now + 3600, label: 'Fresh browser after passkey recovery' } };
  const review = await smart.passkeyOnboardingChallenge(input);
  expect(review.state.ownerProfile!.signer.address).toBe(candidate.signerAddress);
  expect(review.typedData.message.initializerHash).toBe(enrollment.creation!.initializerHash);
  const assertion = signGet({ ...replacement, rpId, origin, challenge: review.signingPayload.digest });
  const verified = verifyWalletAssertion(assertion, { purpose: 'session', challenge: review.signingPayload.digest, rpId, origin, requireUserHandle: true,
    credential: { id: replacement.credentialId, userHandle: replacement.userHandle, publicKey: replacement.publicKey, backupEligible: true } });
  await smart.finalizePasskeyOnboarding({ ...input, stateHash: review.state.stateHash, manifestRevision: review.state.manifestRevision,
    initializerHash: enrollment.creation!.initializerHash,
    signature: encodeSafe7579MessageSignature([{ kind: 'contract', owner: candidate.signerAddress, signature: verified.contractSignature }]),
    proofSignature: await browser.signTypedData(passkeyOnboardingProofDocument(review.typedData)) });
  const activated = await recovery.activate(intent.id, begun.flowToken, assertion);
  expect(activated.replayed).toBe(false);
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
  expect(await recovery.activate(intent.id, begun.flowToken, assertion)).toEqual({ ...activated, replayed: true });
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
    sameSafe: true, originalGenesisRetained: true, newPasskeyLogin: true, oldSessionAndPasskeyRejected: true,
    oldSignupResumeRejected: true, exactActivationRetry: true, chainRollbackFailsClosedWithoutRevertingCredentials: true }, null, 2));
}
