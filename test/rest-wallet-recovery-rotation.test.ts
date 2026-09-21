import { beforeAll, describe, expect, it } from 'vitest';
import { decodeFunctionData, hashTypedData, parseAbi, zeroAddress, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletAuthorityContextFixture } from './fixtures/wallet-authority-context.js';
import { createRegistration, enrollmentBackupAccount } from './fixtures/wallet-enrollment-crypto.js';
import { createWalletRecoveryIntent, prepareWalletRecoveryCandidate, type WalletRecoveryCandidate } from '../src/rest/wallet/recovery.js';
import { prepareWalletRecoveryRotation, verifyWalletRecoveryRotation, walletRecoveryRotationDocument } from '../src/rest/wallet/recoveryRotation.js';

const now = 1_800_000_120_000, sentinel = '0x0000000000000000000000000000000000000001';
let candidate: WalletRecoveryCandidate;
beforeAll(async () => {
  const context = await createWalletAuthorityContextFixture(now);
  const intent = createWalletRecoveryIntent(context, { rpId: context.credential.rpId, origin: context.enrollment.intent.origin,
    nowMs: now, expiresAtMs: now + 120000 });
  const key = createRegistration({ rpId: intent.rpId, origin: intent.origin, userHandle: intent.userHandle,
    challenge: `0x${Buffer.from(intent.registration.challenge, 'base64url').toString('hex')}` });
  candidate = prepareWalletRecoveryCandidate(intent, key.response);
});
function review(nonce = '7', reversed = false) {
  const owners = [candidate.intent.priorSigner, candidate.intent.recoveryOwner];
  return prepareWalletRecoveryRotation(candidate, { owners: reversed ? owners.reverse() : owners, threshold: 1, safeNonce: nonce });
}
describe('exact recovery owner rotation', () => {
  it('uses two zero-value CALLs and a genuine backup signature over the same Safe nonce', async () => {
    const draft = review(), document = walletRecoveryRotationDocument(draft), signature = await enrollmentBackupAccount.signTypedData(document);
    const calls = await verifyWalletRecoveryRotation(candidate, draft, signature);
    expect(draft.previousOwner).toBe(sentinel); expect(draft.walletAddress.toLowerCase()).toBe(candidate.intent.accountId.slice(12));
    expect(draft.initializerHash).toBe(candidate.intent.initializerHash);
    expect(document.domain).toEqual({ chainId: 8453, verifyingContract: draft.walletAddress });
    expect(document.message).toMatchObject({ to: draft.walletAddress, value: 0n, operation: 0, nonce: 7n,
      safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: zeroAddress, refundReceiver: zeroAddress });
    expect(calls.createSigner).toEqual(draft.createSigner); expect(calls.rotateOwner.to).toBe(draft.walletAddress);
    const execution = decodeFunctionData({ abi: parseAbi(['function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns(bool)']), data: calls.rotateOwner.data });
    expect(execution.args).toEqual([draft.walletAddress, 0n, document.message.data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, signature]);
    expect(calls.safeTxHash).toBe(hashTypedData(document));
    expect(review('7', true).previousOwner).toBe(candidate.intent.recoveryOwner);
    // A device owner ahead of the primary in the Safe's list is the previous owner of the swap.
    const device = `0x${'ab'.repeat(20)}` as const;
    const withDevice = prepareWalletRecoveryRotation(candidate, { owners: [device, candidate.intent.priorSigner, candidate.intent.recoveryOwner], threshold: 1, safeNonce: '7' });
    expect(withDevice.previousOwner).toBe(device);
    expect(prepareWalletRecoveryRotation(candidate, { owners: [candidate.intent.priorSigner, device, candidate.intent.recoveryOwner], threshold: 1, safeNonce: '7' }).previousOwner).toBe(sentinel);
  });
  it('rejects changed owners, thresholds, missing owners and non-canonical nonces before signing', () => {
    for (const owners of [[], [candidate.intent.priorSigner], [candidate.intent.priorSigner, candidate.intent.priorSigner],
      [candidate.intent.recoveryOwner, candidate.signerAddress], [candidate.intent.priorSigner, candidate.intent.recoveryOwner, zeroAddress],
      [candidate.intent.priorSigner, candidate.intent.recoveryOwner, candidate.signerAddress]])
      expect(() => prepareWalletRecoveryRotation(candidate, { owners, threshold: 1, safeNonce: '7' })).toThrow();
    for (const safeNonce of ['-1', '01', '0x7', String(1n << 256n)]) expect(() => prepareWalletRecoveryRotation(candidate,
      { owners: [candidate.intent.priorSigner, candidate.intent.recoveryOwner], threshold: 1, safeNonce })).toThrow();
    expect(() => prepareWalletRecoveryRotation(candidate, { owners: [candidate.intent.priorSigner, candidate.intent.recoveryOwner], threshold: 2, safeNonce: '7' })).toThrow();
  });
  it('rejects another key, generation or Safe nonce and calldata with unreviewed suffixes', async () => {
    const draft = review(), document = walletRecoveryRotationDocument(draft), signature = await enrollmentBackupAccount.signTypedData(document);
    await expect(verifyWalletRecoveryRotation(candidate, draft, await privateKeyToAccount(`0x${'22'.repeat(32)}`).signTypedData(document))).rejects.toThrow();
    await expect(verifyWalletRecoveryRotation(candidate, review('8'), signature)).rejects.toThrow();
    const changedCandidate = structuredClone(candidate); changedCandidate.nonce = `0x${'22'.repeat(32)}`;
    await expect(verifyWalletRecoveryRotation(changedCandidate, draft, signature)).rejects.toThrow();
    for (const mutate of [
      (d: typeof draft) => { d.swapOwner.data += '00'; },
      (d: typeof draft) => { d.createSigner.data += '00'; },
      (d: typeof draft) => { d.createSigner.to = zeroAddress; },
      (d: typeof draft) => { Object.assign(d.swapOwner, { operation: 1 }); },
      (d: typeof draft) => { d.swapOwner.value = '1' as never; },
      (d: typeof draft) => { d.previousOwner = zeroAddress; },
      (d: typeof draft) => { Object.assign(d, { allowed: true }); },
    ]) { const changed = structuredClone(draft); mutate(changed); await expect(verifyWalletRecoveryRotation(candidate, changed, signature)).rejects.toThrow(); }
  });
  it('rejects redirected Safe calldata even with a valid independent-owner signature', async () => {
    const draft = review(), document = walletRecoveryRotationDocument(draft), changed = structuredClone(draft);
    changed.swapOwner.to = enrollmentBackupAccount.address;
    const redirected = { ...document, message: { ...document.message, to: enrollmentBackupAccount.address } };
    await expect(verifyWalletRecoveryRotation(candidate, changed, await enrollmentBackupAccount.signTypedData(redirected))).rejects.toThrow();
    const changedNonce = review('8');
    expect((await verifyWalletRecoveryRotation(candidate, changedNonce, await enrollmentBackupAccount.signTypedData(walletRecoveryRotationDocument(changedNonce)))).safeTxHash)
      .not.toBe(hashTypedData(document));
  });
});
