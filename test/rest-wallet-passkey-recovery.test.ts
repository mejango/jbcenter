import { beforeAll, describe, expect, it } from 'vitest';
import { hashTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletAuthorityContextFixture } from './fixtures/wallet-authority-context.js';
import { createRegistration, signBackupProof, signGet } from './fixtures/wallet-enrollment-crypto.js';
import { createWalletRecoveryIntent, prepareWalletRecoveryCandidate, walletRecoveryDocument, verifyWalletRecoveryProof } from '../src/rest/wallet/recovery.js';
import type { WalletAuthorityContext } from '../src/rest/wallet/authority.js';

const now = 1_800_000_120_000;
let context: WalletAuthorityContext;
beforeAll(async () => { context = await createWalletAuthorityContextFixture(now); });
function candidate() {
  const intent = createWalletRecoveryIntent(context, { rpId: context.credential.rpId, origin: context.enrollment.intent.origin,
    nowMs: now, expiresAtMs: now + 120000 });
  const credential = createRegistration({ rpId: intent.rpId, origin: intent.origin, userHandle: intent.userHandle,
    challenge: `0x${Buffer.from(intent.registration.challenge, 'base64url').toString('hex')}` });
  const record = prepareWalletRecoveryCandidate(intent, credential.response);
  return { intent, credential, record };
}
async function proof(value = candidate()) {
  const document = walletRecoveryDocument(value.record);
  return { ...value, document, proof: { assertion: signGet({ ...value.credential, rpId: value.intent.rpId, origin: value.intent.origin,
    challenge: hashTypedData(document) }), backupSignature: await signBackupProof(document) } };
}
describe('independent owner and new-passkey recovery consent', () => {
  it('preserves the Safe and immutable genesis while verifying both replacement owners', async () => {
    const value = await proof(), result = await verifyWalletRecoveryProof(value.record, value.proof, now + 1);
    expect(result.accountId).toBe(context.accountId);
    expect(value.intent.initializerHash).toBe(context.enrollment.creation!.initializerHash);
    expect(value.intent.priorSigner).toBe(context.binding.state.ownerProfile!.signer.address.toLowerCase());
    expect(value.record.signerAddress.toLowerCase()).not.toBe(value.intent.priorSigner);
    expect(value.document.domain.verifyingContract.toLowerCase()).toBe(context.binding.wallet.address.toLowerCase());
    expect(value.document.primaryType).toBe('WalletRecovery');
    expect(result).not.toHaveProperty('session'); expect(result).not.toHaveProperty('grant');
    expect(result).not.toHaveProperty('newWallet');
    const retried = await verifyWalletRecoveryProof(value.record, value.proof, now + 2);
    expect(retried.verificationDigest).toBe(result.verificationDigest);
  });
  it('requires fresh possession of the selected replacement key with its matching handle and RP', async () => {
    const value = await proof(), other = candidate();
    const variations = [
      { ...value.proof.assertion, userHandle: null },
      { ...value.proof.assertion, userHandle: other.intent.registration.challenge },
      signGet({ ...other.credential, challenge: hashTypedData(value.document), rpId: value.intent.rpId, origin: value.intent.origin }),
      signGet({ ...value.credential, challenge: hashTypedData(value.document), rpId: 'attacker.test', origin: 'https://attacker.test' }),
      signGet({ ...value.credential, challenge: `0x${'11'.repeat(32)}`, rpId: value.intent.rpId, origin: value.intent.origin }),
    ];
    for (const assertion of variations) await expect(verifyWalletRecoveryProof(value.record, { ...value.proof, assertion }, now + 1)).rejects.toThrow();
  });
  it('requires the independent backup rather than an app key or the new passkey alone', async () => {
    const value = await proof();
    const backupSignature = await privateKeyToAccount(`0x${'22'.repeat(32)}`).signTypedData(value.document);
    await expect(verifyWalletRecoveryProof(value.record, { ...value.proof, backupSignature }, now + 1)).rejects.toThrow();
    await expect(verifyWalletRecoveryProof(value.record, { assertion: value.proof.assertion } as never, now + 1)).rejects.toThrow();
  });
  it('binds all identity, signer and lifetime fields and never renews an expired approval', async () => {
    const value = await proof();
    for (const update of [{ accountId: 'eip155:8453:0x' + '33'.repeat(20) }, { origin: 'https://attacker.test', rpId: 'attacker.test' },
      { initializerHash: `0x${'44'.repeat(32)}` }, { priorCredentialDigest: '55'.repeat(32) }, { expiresAtMs: value.intent.expiresAtMs + 1 }]) {
      const changed = structuredClone(value.record); Object.assign(changed.intent, update);
      await expect(verifyWalletRecoveryProof(changed, value.proof, now + 1)).rejects.toThrow();
    }
    await expect(verifyWalletRecoveryProof(value.record, value.proof, value.intent.expiresAtMs)).rejects.toThrow();
    await expect(verifyWalletRecoveryProof(value.record, value.proof, now - 1)).rejects.toThrow();
  });
  it('snapshots the selected manifest and refuses unknown caller authority or unbounded lifetimes', () => {
    const selected = structuredClone(context);
    const value = createWalletRecoveryIntent(selected, { rpId: context.credential.rpId, origin: context.enrollment.intent.origin, nowMs: now, expiresAtMs: now + 120000 });
    selected.enrollment.intent.manifest.id = 'changed';
    expect(value.manifest.id).toBe(context.enrollment.intent.manifest.id);
    for (const extra of [{ expiresAtMs: now + 300001 }, { origin: 'https://attacker.test', rpId: context.credential.rpId }, { accountId: 'attacker' }])
      expect(() => createWalletRecoveryIntent(context, { rpId: context.credential.rpId, origin: context.enrollment.intent.origin, nowMs: now, expiresAtMs: now + 120000, ...extra } as never)).toThrow();
  });
});
