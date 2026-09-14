import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { concatHex, decodeFunctionResult, encodeFunctionData, hashTypedData, padHex, toHex, zeroAddress, zeroHash, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { expect } from 'vitest';
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
  const recovery = new PostgresWalletRecoveryStore(pool, { rpId, origin }, { audience: options.audience, observe: context => observer.observe(context) });
  const accountId = enrollment.receipt!.accountId, begun = await recovery.begin(accountId), intent = begun.record.intent;
  const replacement = createRegistration({ rpId, origin, userHandle: intent.userHandle,
    challenge: `0x${Buffer.from(intent.registration.challenge, 'base64url').toString('hex')}` });
  const pending = await recovery.register(intent.id, begun.flowToken, replacement.response), document = walletRecoveryDocument(pending.candidate!);
  await recovery.prove(intent.id, begun.flowToken, { assertion: signGet({ ...replacement, rpId, origin, challenge: hashTypedData(document) }),
    backupSignature: await signBackupProof(document) });
  const beforeRotation = await fixture.rpc<Hex>('evm_snapshot');
  const safe = JSON.parse(await readFile(new URL('../../src/rest/smartAccounts/stack/artifacts/SafeL2.json', import.meta.url), 'utf8')) as { abi: Abi };
  const factory = JSON.parse(await readFile(new URL('../../src/rest/smartAccounts/stack/passkey/artifacts/SafeWebAuthnSignerFactory.json', import.meta.url), 'utf8')) as { abi: Abi };
  await fixture.rpc('anvil_setBalance', [enrollmentBackupAccount.address, toHex(10n ** 20n)]);
  async function send(to: Address, data: Hex) {
    const nonce = Number(BigInt(await fixture.rpc<Hex>('eth_getTransactionCount', [enrollmentBackupAccount.address, 'latest'])));
    const serialized = await enrollmentBackupAccount.signTransaction({ type: 'eip1559', chainId: 8453, to, data, value: 0n,
      nonce, gas: 3000000n, maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
    const hash = await fixture.rpc<Hex>('eth_sendRawTransaction', [serialized]);
    expect((await fixture.rpc<{ status: string }>('eth_getTransactionReceipt', [hash])).status).toBe('0x1');
    return hash;
  }
  const candidate = pending.candidate!, wallet = enrollment.creation!.address;
  await send(fixture.manifest.ownerProfile!.signerFactory.address, encodeFunctionData({ abi: factory.abi, functionName: 'createSigner',
    args: [BigInt(replacement.publicKey.x), BigInt(replacement.publicKey.y), BigInt(enrollment.creation!.bootstrap.verifiers)] }));
  const owners = decodeFunctionResult({ abi: safe.abi, functionName: 'getOwners', data: await fixture.rpc<Hex>('eth_call',
    [{ to: wallet, data: encodeFunctionData({ abi: safe.abi, functionName: 'getOwners' }) }, 'latest']) }) as Address[];
  const oldIndex = owners.findIndex(owner => owner.toLowerCase() === intent.priorSigner);
  expect(oldIndex).toBeGreaterThanOrEqual(0);
  const previous = oldIndex === 0 ? '0x0000000000000000000000000000000000000001' : owners[oldIndex - 1]!;
  const swap = encodeFunctionData({ abi: safe.abi, functionName: 'swapOwner', args: [previous, intent.priorSigner, candidate.signerAddress] });
  const ownerApproval = concatHex([padHex(enrollmentBackupAccount.address, { size: 32 }), zeroHash, '0x01']);
  const rotationTransaction = await send(wallet, encodeFunctionData({ abi: safe.abi, functionName: 'execTransaction',
    args: [wallet, 0n, swap, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, ownerApproval] }));
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
  expect((await options.authority.refreshAuthority(accountId)).snapshot.readiness).not.toBe('verified');
  expect(await login.readSession(signedIn.sessionToken)).toBeNull();
  expect((await pool.query('SELECT credential_id,superseded_at,recovery_receipt FROM rest_wallet_credentials WHERE account_id=$1 ORDER BY credential_id', [accountId])).rows).toEqual(retained);
  const out = new URL('../../.generated/wallet-observations/recovery-evm/', import.meta.url); await mkdir(out, { recursive: true });
  await writeFile(new URL('summary.json', out), JSON.stringify({ passed: true, evidence: 'actual PostgreSQL, unforked Anvil, P256 and independent test EOA',
    rotationTransaction, sameSafe: true, originalGenesisRetained: true, newPasskeyLogin: true, oldSessionAndPasskeyRejected: true,
    oldSignupResumeRejected: true, exactActivationRetry: true, chainRollbackFailsClosedWithoutRevertingCredentials: true }, null, 2));
}
