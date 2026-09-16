import { encodeFunctionData, getAddress, hashTypedData, isAddress, parseAbi, recoverAddress, zeroAddress, type Address, type Hex } from 'viem';
import { RestError } from '../core.js';
import { maximumPasskeySigners } from '../smartAccounts/passkeyProfile.js';
import { canonicalEoaSignature } from '../smartAccounts/accountExecution.js';
import { enrollmentDigest } from './enrollment.js';
import { assertWalletRecoveryCandidate, type WalletRecoveryCandidate } from './recovery.js';
import { walletRecoveryRotationSafeTx } from '../web/walletRecoveryReview.js';

const sentinel = '0x0000000000000000000000000000000000000001' as Address;
const factoryAbi = parseAbi(['function createSigner(uint256 x,uint256 y,uint176 verifiers) returns(address)']);
const safeAbi = parseAbi([
  'function swapOwner(address previousOwner,address oldOwner,address newOwner)',
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns(bool)',
]);
export interface WalletRecoveryRotationCall { to: Address; value: '0'; data: Hex }
export interface WalletRecoveryRotation {
  version: 'center-wallet-recovery-rotation-v1'; recoveryId: string; candidateDigest: string;
  walletAddress: Address; initializerHash: Hex; recoveryOwner: Address; priorSigner: Address; replacementSigner: Address;
  previousOwner: Address; safeNonce: string; createSigner: WalletRecoveryRotationCall; swapOwner: WalletRecoveryRotationCall;
}
function invalid(): never { throw new RestError(400, 'WALLET_RECOVERY_ROTATION_INVALID', 'The exact recovery owner rotation or signer approval changed.'); }
function nonce(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) >= 1n << 256n) invalid();
}
/** Pure draft only. The caller establishes accepted recovery proof, current canonical owner
 * ordering/nonce, reviewed contract pins and durable fee admission before any submission. */
export function prepareWalletRecoveryRotation(input: WalletRecoveryCandidate,
  inputState: { owners: Address[]; threshold: number; safeNonce: string }): WalletRecoveryRotation {
  assertWalletRecoveryCandidate(input); enrollmentDigest(inputState);
  const candidate = structuredClone(input), state = structuredClone(inputState), intent = candidate.intent;
  // Owners are the primary signer, the recovery owner, and any device signers (added at the
  // head of the Safe's list). The swap replaces the primary in place, so the previous owner is
  // whichever owner the list holds just before it. The relay's inspection vouches for the devices.
  if (Object.keys(state).sort().join(',') !== 'owners,safeNonce,threshold' || !Array.isArray(state.owners)
    || state.owners.length < 2 || state.owners.length > maximumPasskeySigners + 1 || state.threshold !== 1
    || state.owners.some(owner => typeof owner !== 'string' || !isAddress(owner))) invalid();
  nonce(state.safeNonce);
  const owners = state.owners.map(owner => owner.toLowerCase());
  if (new Set(owners).size !== owners.length || !owners.includes(intent.priorSigner) || !owners.includes(intent.recoveryOwner)
    || owners.includes(candidate.signerAddress.toLowerCase()) || owners.includes(zeroAddress)) invalid();
  const index = owners.indexOf(intent.priorSigner);
  const walletAddress = getAddress(intent.accountId.slice(12)), previousOwner = index === 0 ? sentinel : owners[index - 1]! as Address;
  return { version: 'center-wallet-recovery-rotation-v1', recoveryId: intent.id, candidateDigest: enrollmentDigest(candidate),
    walletAddress, initializerHash: intent.initializerHash, recoveryOwner: intent.recoveryOwner, priorSigner: intent.priorSigner,
    replacementSigner: candidate.signerAddress, previousOwner, safeNonce: state.safeNonce,
    createSigner: { to: getAddress(intent.manifest.ownerProfile!.signerFactory.address), value: '0',
      data: encodeFunctionData({ abi: factoryAbi, functionName: 'createSigner', args: [BigInt(candidate.credential.publicKey.x),
        BigInt(candidate.credential.publicKey.y), BigInt(intent.manifest.ownerProfile!.p256Verifier.address)] }) },
    swapOwner: { to: walletAddress, value: '0', data: encodeFunctionData({ abi: safeAbi, functionName: 'swapOwner',
      args: [previousOwner, intent.priorSigner, candidate.signerAddress] }) } };
}
/** Standard Safe 1.4.1 owner EIP712 approval. There is no onchain deadline: once signed,
 * expiry or a lost reply cannot cancel it or release its durable transaction liabilities. */
export function walletRecoveryRotationDocument(input: WalletRecoveryRotation) {
  enrollmentDigest(input); const review = structuredClone(input); nonce(review.safeNonce);
  if (Object.keys(review).sort().join(',') !== 'candidateDigest,createSigner,initializerHash,previousOwner,priorSigner,recoveryId,recoveryOwner,replacementSigner,safeNonce,swapOwner,version,walletAddress'
    || review.version !== 'center-wallet-recovery-rotation-v1' || !isAddress(review.walletAddress)
    || !review.swapOwner || Object.keys(review.swapOwner).sort().join(',') !== 'data,to,value'
    || review.swapOwner.to !== review.walletAddress || review.swapOwner.value !== '0'
    || typeof review.swapOwner.data !== 'string' || !/^0x[0-9a-f]{200}$/.test(review.swapOwner.data)) invalid();
  return walletRecoveryRotationSafeTx(review.walletAddress, review.swapOwner.data, review.safeNonce);
}
/** No generic transaction entrypoint. Rebuild both calls from the captured candidate before
 * accepting an EOA signature, then give dispatch only exact permissionless-factory and Safe CALLs. */
export async function verifyWalletRecoveryRotation(input: WalletRecoveryCandidate, inputReview: WalletRecoveryRotation, inputSignature: Hex) {
  assertWalletRecoveryCandidate(input); enrollmentDigest(inputReview);
  const candidate = structuredClone(input), review = structuredClone(inputReview), signature = canonicalEoaSignature(inputSignature);
  const owners = review.previousOwner === sentinel ? [candidate.intent.priorSigner, candidate.intent.recoveryOwner]
    : [candidate.intent.recoveryOwner, candidate.intent.priorSigner];
  const expected = prepareWalletRecoveryRotation(candidate, { owners, threshold: 1, safeNonce: review.safeNonce });
  if (enrollmentDigest(expected) !== enrollmentDigest(review)) invalid();
  const document = walletRecoveryRotationDocument(expected), safeTxHash = hashTypedData(document);
  if ((await recoverAddress({ hash: safeTxHash, signature })).toLowerCase() !== candidate.intent.recoveryOwner) invalid();
  return { createSigner: expected.createSigner, rotateOwner: { to: expected.walletAddress, value: '0' as const,
    data: encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [expected.walletAddress, 0n, expected.swapOwner.data,
      0, 0n, 0n, 0n, zeroAddress, zeroAddress, signature] }) }, safeTxHash };
}
