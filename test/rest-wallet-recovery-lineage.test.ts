import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashTypedData, type Hex } from 'viem';
import { createWalletAuthorityContextFixture } from './fixtures/wallet-authority-context.js';
import { createRegistration, signBackupProof, signGet } from './fixtures/wallet-enrollment-crypto.js';
import { createWalletRecoveryIntent, createWalletRecoveryMapping, prepareWalletRecoveryCandidate,
  verifyWalletRecoveryProof, walletRecoveryDocument } from '../src/rest/wallet/recovery.js';
import { validateWalletAuthorityContext } from '../src/rest/wallet/authority.js';
import { passkeyOnboardingDocument } from '../src/rest/smartAccounts/passkeyOnboarding.js';

const now = 1_800_000_120_000, word = (byte: string): Hex => `0x${byte.repeat(32)}`;
async function replacement() {
  const original = await createWalletAuthorityContextFixture(now), intent = createWalletRecoveryIntent(original, {
    rpId: original.credential.rpId, origin: original.enrollment.intent.origin, nowMs: now, expiresAtMs: now + 120000 });
  const key = createRegistration({ rpId: intent.rpId, origin: intent.origin, userHandle: intent.userHandle,
    challenge: `0x${Buffer.from(intent.registration.challenge, 'base64url').toString('hex')}` });
  const candidate = prepareWalletRecoveryCandidate(intent, key.response), doc = walletRecoveryDocument(candidate);
  const proof = await verifyWalletRecoveryProof(candidate, { assertion: signGet({ ...key, rpId: intent.rpId, origin: intent.origin,
    challenge: hashTypedData(doc) }), backupSignature: await signBackupProof(doc) }, now + 1);
  const captured = structuredClone(original), binding = captured.binding, setup = binding.authorization.setup!;
  // Deliberately modeled replacement setup; no chain provenance is claimed by this pure suite.
  binding.state.owners = [candidate.signerAddress, intent.recoveryOwner]; binding.state.stateHash = word('55');
  Object.assign(binding.state.ownerProfile!.signer, { address: candidate.signerAddress, ...key.publicKey });
  binding.authorization.nonce = word('56'); binding.authorization.expiresAt = now / 1000 + 300;
  setup.issuedAt = now / 1000; setup.grantId = randomUUID(); setup.grantExpiresAt = now / 1000 + 3600;
  const document = passkeyOnboardingDocument(intent.origin, { profile: 'center-passkey-v1', address: binding.wallet.address,
    manifestId: binding.manifestId, nonce: binding.authorization.nonce, issuedAt: setup.issuedAt, expiresAt: binding.authorization.expiresAt,
    grant: { id: setup.grantId, botAddress: setup.botAddress, scopes: setup.scopes, expiresAt: setup.grantExpiresAt, label: setup.label } }, binding.state);
  binding.authorization.digest = hashTypedData(document);
  return { original, captured, record: { intent, candidate, proof }, key, document };
}
describe('immutable recovery lineage for the current wallet credential', () => {
  it('accepts an explicit replacement lineage with the same Safe and original genesis', async () => {
    const value = await replacement(), mapped = createWalletRecoveryMapping(value.record, value.captured, now + 20, value.record.intent.origin);
    expect(mapped.context.enrollment).toEqual(value.original.enrollment);
    expect(mapped.context.accountId).toBe(value.original.accountId);
    expect(mapped.context.credential.credentialId).toBe(value.key.credentialId);
    expect(mapped.context.credential.recovery).toEqual(mapped.receipt);
    expect(validateWalletAuthorityContext(mapped.context)).toEqual(mapped.context);
    expect(value.captured.credential).toEqual(value.original.credential);
    expect(mapped.receipt.priorSigner).toBe(value.record.intent.priorSigner);
    expect(mapped.receipt.priorCredentialDigest).toBe(value.record.intent.priorCredentialDigest);
  });
  it('refuses a replacement key without immutable lineage or with mismatching genesis and signer', async () => {
    const value = await replacement(), mapped = createWalletRecoveryMapping(value.record, value.captured, now + 20, value.record.intent.origin);
    const absent = structuredClone(mapped.context); delete absent.credential.recovery;
    expect(() => validateWalletAuthorityContext(absent)).toThrow();
    for (const mutation of [
      (c: typeof mapped.context) => { c.credential.recovery!.enrollmentDigest = '11'.repeat(32); },
      (c: typeof mapped.context) => { c.credential.recovery!.signerAddress = value.record.intent.priorSigner; },
      (c: typeof mapped.context) => { c.credential.publicKey = value.original.credential.publicKey; },
      (c: typeof mapped.context) => { c.credential.credentialId = value.original.credential.credentialId; },
      (c: typeof mapped.context) => { c.credential.verifiedAtMs++; },
    ]) { const changed = structuredClone(mapped.context); mutation(changed); expect(() => validateWalletAuthorityContext(changed)).toThrow(); }
  });
  it('requires the captured previous credential, an accepted proof and a fresh changed setup', async () => {
    const value = await replacement();
    expect(() => createWalletRecoveryMapping({ ...value.record, proof: null }, value.captured, now + 20, value.record.intent.origin)).toThrow();
    expect(() => createWalletRecoveryMapping(value.record, value.original, now + 20, value.record.intent.origin)).toThrow();
    expect(() => createWalletRecoveryMapping(value.record, value.captured, now + 300001, value.record.intent.origin)).toThrow();
    expect(() => createWalletRecoveryMapping(value.record, value.captured, now + 20, 'https://different-audience.test')).toThrow();
    const changed = structuredClone(value.captured); changed.credential.credentialId = value.key.credentialId;
    expect(() => createWalletRecoveryMapping(value.record, changed, now + 20, value.record.intent.origin)).toThrow();
  });
});
