import { randomBytes, randomUUID } from 'node:crypto';
import { getAddress, hashTypedData, isAddress, recoverAddress, type Address, type Hex } from 'viem';
import { RestError } from '../core.js';
import type { SmartAccountManifest } from '../smartAccounts/types.js';
import { canonicalEoaSignature } from '../smartAccounts/accountExecution.js';
import { predictPasskeySignerAddress, validatePasskeyCreationManifest } from '../smartAccounts/passkeyCreation.js';
import { validateWalletAuthorityContext, type WalletAuthorityContext } from './authority.js';
import { enrollmentDigest } from './enrollment.js';
import { assertWalletCeremonyDraft, createWalletCeremony, type WalletCeremonyDraft } from './ceremonies.js';
import { parseWalletRegistration, type WalletRegistrationCandidate, type WalletRegistrationResponse } from './registration.js';
import { validateWalletRpConfiguration, verifyWalletAssertion, type WalletAssertion } from './webauthn.js';
import { copyWalletEnrollmentRegistration } from './enrollmentPostgres.js';
import { copyWalletSignupAssertion } from './signupPostgres.js';
import { assertWalletAuthorityCredential, type WalletCredentialRecovery } from './credentialRecovery.js';
import { passkeyOnboardingDocument, type PasskeyOnboardingInput } from '../smartAccounts/passkeyOnboarding.js';

/** An internal captured context, not authority to change owners or a login principal. */
export interface WalletRecoveryIntent {
  version: 'center-wallet-recovery-v1'; id: string; accountId: string; enrollmentId: string;
  enrollmentDigest: string; priorCredentialDigest: string; priorBindingDigest: Hex;
  manifest: SmartAccountManifest; initializerHash: Hex; priorSigner: Address; recoveryOwner: Address;
  userHandle: string; rpId: string; origin: string; issuedAtMs: number; expiresAtMs: number;
  registration: WalletCeremonyDraft;
}
export interface WalletRecoveryCandidate {
  intent: WalletRecoveryIntent; credential: WalletRegistrationCandidate; signerAddress: Address;
  nonce: Hex; possession: WalletCeremonyDraft;
}
export interface WalletRecoveryProof {
  recoveryId: string; accountId: string; enrollmentId: string; intentDigest: string; candidateDigest: string;
  verificationDigest: string; verifiedAtMs: number;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/, word = /^0x[0-9a-f]{64}$/;
const intentFields = ['version', 'id', 'accountId', 'enrollmentId', 'enrollmentDigest', 'priorCredentialDigest', 'priorBindingDigest',
  'manifest', 'initializerHash', 'priorSigner', 'recoveryOwner', 'userHandle', 'rpId', 'origin', 'issuedAtMs', 'expiresAtMs', 'registration'];
function invalid(): never { throw new RestError(400, 'WALLET_RECOVERY_INVALID', 'Recovery fields or the selected wallet context are invalid.'); }
function unauthorized(): never { throw new RestError(403, 'WALLET_RECOVERY_PROOF_INVALID', 'Recovery requires the independent owner and the exact replacement passkey.'); }
function fields(value: unknown, names: string[]) {
  // This rejects accessors, proxies, custom serialization, typed arrays and excessive
  // public JSON before copying. Cryptographic response bytes use their bounded copier.
  enrollmentDigest(value);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) invalid();
}
function bytes(value: unknown, maximum: number, minimum = maximum) {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length < minimum || decoded.length > maximum || decoded.toString('base64url') !== value) invalid();
}
const account = (value: unknown): value is string => typeof value === 'string' && /^eip155:8453:0x[0-9a-f]{40}$/.test(value) && BigInt(value.slice(12)) > 1n;
const owner = (value: unknown): value is Address => typeof value === 'string' && isAddress(value) && BigInt(value) > 1n && value === value.toLowerCase();
function base(intent: WalletRecoveryIntent) { const { registration: _registration, ...value } = intent; return value; }
function ceremonyAccount(intent: WalletRecoveryIntent) { return 'wallet-recovery:' + intent.id; }
export function assertWalletRecoveryIntent(value: WalletRecoveryIntent): void {
  try {
    fields(value, intentFields); validateWalletRpConfiguration(value); validatePasskeyCreationManifest(value.manifest);
    if (value.version !== 'center-wallet-recovery-v1' || !uuid.test(value.id) || !uuid.test(value.enrollmentId) || !account(value.accountId)
      || !digest.test(value.enrollmentDigest) || !digest.test(value.priorCredentialDigest) || !word.test(value.priorBindingDigest)
      || !word.test(value.initializerHash) || !owner(value.priorSigner) || !owner(value.recoveryOwner) || value.priorSigner === value.recoveryOwner
      || !Number.isSafeInteger(value.issuedAtMs) || value.issuedAtMs < 1 || !Number.isSafeInteger(value.expiresAtMs)
      || value.expiresAtMs <= value.issuedAtMs || value.expiresAtMs > value.issuedAtMs + 300000) invalid();
    bytes(value.userHandle, 32); assertWalletCeremonyDraft(value.registration);
    if (value.registration.accountId !== ceremonyAccount(value) || value.registration.purpose !== 'registration'
      || value.registration.contextDigest !== enrollmentDigest(base(value)) || value.registration.expiresAt !== value.expiresAtMs) invalid();
  } catch { invalid(); }
}
export function createWalletRecoveryIntent(inputContext: WalletAuthorityContext, options: {
  rpId: string; origin: string; nowMs: number; expiresAtMs: number;
}): WalletRecoveryIntent {
  fields(options, ['rpId', 'origin', 'nowMs', 'expiresAtMs']);
  const context = validateWalletAuthorityContext(inputContext);
  const value = { version: 'center-wallet-recovery-v1' as const, id: randomUUID(), accountId: context.accountId,
    enrollmentId: context.enrollment.intent.id, enrollmentDigest: enrollmentDigest(context.enrollment),
    priorCredentialDigest: enrollmentDigest(context.credential), priorBindingDigest: context.binding.authorization.digest,
    manifest: structuredClone(context.enrollment.intent.manifest), initializerHash: context.enrollment.creation!.initializerHash,
    priorSigner: context.binding.state.ownerProfile!.signer.address.toLowerCase() as Address,
    recoveryOwner: context.enrollment.intent.recoveryOwner.toLowerCase() as Address,
    userHandle: context.enrollment.intent.userHandle, rpId: options.rpId, origin: options.origin,
    issuedAtMs: options.nowMs, expiresAtMs: options.expiresAtMs };
  const intent = { ...value, registration: createWalletCeremony({ accountId: 'wallet-recovery:' + value.id, purpose: 'registration',
    contextDigest: enrollmentDigest(value), expiresAt: value.expiresAtMs }) };
  assertWalletRecoveryIntent(intent); return intent;
}
function checkedCredential(intent: WalletRecoveryIntent, credential: WalletRegistrationCandidate) {
  fields(credential, ['credentialId', 'userHandle', 'publicKey', 'signCount', 'backupEligible', 'backedUp', 'aaguid']);
  fields(credential.publicKey, ['x', 'y']); bytes(credential.credentialId, 1023, 1);
  if (credential.userHandle !== intent.userHandle || !word.test(credential.publicKey.x) || !word.test(credential.publicKey.y)
    || !Number.isInteger(credential.signCount) || credential.signCount < 0 || credential.signCount > 0xffffffff
    || typeof credential.backupEligible !== 'boolean' || typeof credential.backedUp !== 'boolean' || credential.backedUp && !credential.backupEligible
    || typeof credential.aaguid !== 'string' || !/^0x[0-9a-f]{32}$/.test(credential.aaguid)) invalid();
}
const types = { WalletRecovery: [
  { name: 'purpose', type: 'string' }, { name: 'recoveryId', type: 'string' }, { name: 'accountId', type: 'string' },
  { name: 'enrollmentId', type: 'string' }, { name: 'enrollmentDigest', type: 'bytes32' },
  { name: 'priorCredentialDigest', type: 'bytes32' }, { name: 'priorBindingDigest', type: 'bytes32' },
  { name: 'initializerHash', type: 'bytes32' }, { name: 'manifestCommitment', type: 'bytes32' },
  { name: 'priorSigner', type: 'address' }, { name: 'replacementSigner', type: 'address' }, { name: 'recoveryOwner', type: 'address' },
  { name: 'replacementCredentialDigest', type: 'bytes32' }, { name: 'rpId', type: 'string' }, { name: 'origin', type: 'string' },
  { name: 'nonce', type: 'bytes32' }, { name: 'issuedAtMs', type: 'uint64' }, { name: 'expiresAtMs', type: 'uint64' },
] } as const;
function document(value: Pick<WalletRecoveryCandidate, 'intent' | 'credential' | 'nonce' | 'signerAddress'>) {
  const intent = value.intent;
  return { domain: { name: 'Juicebox Center Wallet Recovery', version: '1', chainId: 8453,
    verifyingContract: getAddress(intent.accountId.slice(12)) }, types, primaryType: 'WalletRecovery' as const,
    message: { purpose: 'replace-passkey', recoveryId: intent.id, accountId: intent.accountId, enrollmentId: intent.enrollmentId,
      enrollmentDigest: `0x${intent.enrollmentDigest}` as Hex, priorCredentialDigest: `0x${intent.priorCredentialDigest}` as Hex,
      priorBindingDigest: intent.priorBindingDigest, initializerHash: intent.initializerHash,
      manifestCommitment: `0x${enrollmentDigest(intent.manifest)}` as Hex, priorSigner: intent.priorSigner, replacementSigner: value.signerAddress,
      recoveryOwner: intent.recoveryOwner, replacementCredentialDigest: `0x${enrollmentDigest(value.credential)}` as Hex,
      rpId: intent.rpId, origin: intent.origin, nonce: value.nonce, issuedAtMs: BigInt(intent.issuedAtMs), expiresAtMs: BigInt(intent.expiresAtMs) } };
}
function candidateBase(value: WalletRecoveryCandidate) { const { possession: _possession, ...result } = value; return result; }
export function assertWalletRecoveryCandidate(value: WalletRecoveryCandidate) {
  fields(value, ['intent', 'credential', 'nonce', 'signerAddress', 'possession']);
  assertWalletRecoveryIntent(value.intent); checkedCredential(value.intent, value.credential);
  if (!word.test(value.nonce) || BigInt(value.nonce) === 0n || !isAddress(value.signerAddress)
    || value.signerAddress.toLowerCase() === value.intent.priorSigner || value.signerAddress.toLowerCase() === value.intent.recoveryOwner
    || value.signerAddress !== predictPasskeySignerAddress({ manifest: value.intent.manifest, publicKey: value.credential.publicKey })) invalid();
  assertWalletCeremonyDraft(value.possession);
  if (value.possession.accountId !== ceremonyAccount(value.intent) || value.possession.purpose !== 'rotate'
    || value.possession.expiresAt !== value.intent.expiresAtMs || value.possession.contextDigest !== enrollmentDigest(candidateBase(value))
    || value.possession.challenge !== Buffer.from(hashTypedData(document(value)).slice(2), 'hex').toString('base64url')) invalid();
}
export function prepareWalletRecoveryCandidate(input: WalletRecoveryIntent, response: WalletRegistrationResponse): WalletRecoveryCandidate {
  assertWalletRecoveryIntent(input); const intent = structuredClone(input), registration = copyWalletEnrollmentRegistration(response);
  const credential = parseWalletRegistration(registration, { rpId: intent.rpId, origin: intent.origin, userHandle: intent.userHandle,
    challenge: `0x${Buffer.from(intent.registration.challenge, 'base64url').toString('hex')}` });
  const base = { intent, credential, signerAddress: predictPasskeySignerAddress({ manifest: intent.manifest, publicKey: credential.publicKey }),
    nonce: `0x${randomBytes(32).toString('hex')}` as Hex };
  const result = { ...base, possession: { ...createWalletCeremony({ accountId: ceremonyAccount(intent), purpose: 'rotate',
    contextDigest: enrollmentDigest(base), expiresAt: intent.expiresAtMs }), challenge: Buffer.from(hashTypedData(document(base)).slice(2), 'hex').toString('base64url') } };
  assertWalletRecoveryCandidate(result); return result;
}
export function walletRecoveryDocument(value: WalletRecoveryCandidate) { assertWalletRecoveryCandidate(value); return document(value); }
/** Pure proof receipt only. Durable consumption, current-owner comparison, canonical
 * rotation, mapping replacement and epoch/grant invalidation remain separate boundaries. */
export async function verifyWalletRecoveryProof(input: WalletRecoveryCandidate, inputProof: { assertion: WalletAssertion; backupSignature: Hex }, nowMs: number): Promise<WalletRecoveryProof> {
  assertWalletRecoveryCandidate(input); const value = structuredClone(input), intent = value.intent;
  if (!Number.isSafeInteger(nowMs) || nowMs < intent.issuedAtMs || nowMs >= intent.expiresAtMs)
    throw new RestError(410, 'WALLET_RECOVERY_EXPIRED', 'Prepare a fresh recovery proof. The previous deadline cannot be extended.');
  let signature: Hex, assertion: WalletAssertion;
  try {
    if (!inputProof || Reflect.ownKeys(inputProof).length !== 2 || ['assertion', 'backupSignature'].some(key =>
      !Object.hasOwn(inputProof, key) || !('value' in Object.getOwnPropertyDescriptor(inputProof, key)!))) unauthorized();
    signature = canonicalEoaSignature(inputProof.backupSignature); assertion = copyWalletSignupAssertion(inputProof.assertion);
  } catch { return unauthorized(); }
  const challenge = hashTypedData(document(value));
  try {
    verifyWalletAssertion(assertion, { purpose: 'rotate', challenge, rpId: intent.rpId, origin: intent.origin, requireUserHandle: true,
      credential: { id: value.credential.credentialId, userHandle: intent.userHandle, publicKey: value.credential.publicKey, backupEligible: value.credential.backupEligible } });
    if ((await recoverAddress({ hash: challenge, signature })).toLowerCase() !== intent.recoveryOwner) unauthorized();
  } catch { return unauthorized(); }
  const result = { recoveryId: intent.id, accountId: intent.accountId, enrollmentId: intent.enrollmentId,
    intentDigest: enrollmentDigest(intent), candidateDigest: enrollmentDigest(value), verifiedAtMs: nowMs };
  const { verifiedAtMs: _verifiedAtMs, ...identity } = result;
  return { ...result, verificationDigest: enrollmentDigest({ ...identity, challenge, verifiedOwner: intent.recoveryOwner }) };
}

/** A prospective mapping only. The configured observer and atomic storage transaction
 * must establish canonical provenance, consume current identity and revoke prior access. */
export function createWalletRecoveryMapping(record: { intent: WalletRecoveryIntent; candidate: WalletRecoveryCandidate | null; proof: WalletRecoveryProof | null },
  inputContext: WalletAuthorityContext, nowMs: number, setupAudience: string) {
  enrollmentDigest([record, inputContext]);
  if (!record.candidate || !record.proof) invalid();
  const candidate = structuredClone(record.candidate), proof = structuredClone(record.proof), context = structuredClone(inputContext), intent = candidate.intent;
  assertWalletRecoveryCandidate(candidate); assertWalletAuthorityCredential(context.credential, context.enrollment);
  fields(proof, ['recoveryId', 'accountId', 'enrollmentId', 'intentDigest', 'candidateDigest', 'verificationDigest', 'verifiedAtMs']);
  const proofIdentity = { recoveryId: intent.id, accountId: intent.accountId, enrollmentId: intent.enrollmentId,
    intentDigest: enrollmentDigest(intent), candidateDigest: enrollmentDigest(candidate) };
  if (enrollmentDigest(record.intent) !== proofIdentity.intentDigest || Object.entries(proofIdentity).some(([key, value]) => proof[key as keyof WalletRecoveryProof] !== value)
    || proof.verificationDigest !== enrollmentDigest({ ...proofIdentity, challenge: hashTypedData(document(candidate)), verifiedOwner: intent.recoveryOwner })
    || !Number.isSafeInteger(proof.verifiedAtMs) || proof.verifiedAtMs < intent.issuedAtMs || proof.verifiedAtMs >= intent.expiresAtMs
    || !Number.isSafeInteger(nowMs) || nowMs < proof.verifiedAtMs || context.accountId !== intent.accountId
    || enrollmentDigest(context.enrollment) !== intent.enrollmentDigest || enrollmentDigest(context.credential) !== intent.priorCredentialDigest) invalid();
  const b = context.binding, a = b.authorization, setup = a.setup;
  if (!setup || a.digest === intent.priorBindingDigest || a.expiresAt * 1000 <= nowMs
    || setup.issuedAt < Math.floor(proof.verifiedAtMs / 1000) || setup.issuedAt * 1000 > nowMs + 30000) invalid();
  const input: PasskeyOnboardingInput = { profile: 'center-passkey-v1', address: b.wallet.address, manifestId: b.manifestId,
    nonce: a.nonce, issuedAt: setup.issuedAt, expiresAt: a.expiresAt,
    grant: { id: setup.grantId, botAddress: setup.botAddress, scopes: setup.scopes, expiresAt: setup.grantExpiresAt, label: setup.label } };
  const setupDocument = passkeyOnboardingDocument(setupAudience, input, b.state);
  if (hashTypedData(setupDocument) !== a.digest) invalid();
  const receipt: WalletCredentialRecovery = { version: 'center-wallet-credential-recovery-v1', id: intent.id, accountId: intent.accountId,
    enrollmentId: intent.enrollmentId, enrollmentDigest: intent.enrollmentDigest, priorCredentialDigest: intent.priorCredentialDigest,
    priorBindingDigest: intent.priorBindingDigest, priorSigner: intent.priorSigner, signerAddress: candidate.signerAddress,
    credential: candidate.credential, rpId: intent.rpId, origin: intent.origin, initializerHash: intent.initializerHash,
    proofDigest: proof.verificationDigest, bindingDigest: a.digest, anchor: structuredClone(b.state.evidence),
    verifiedAtMs: proof.verifiedAtMs, acceptedAtMs: nowMs };
  context.credential = { accountId: intent.accountId, enrollmentId: intent.enrollmentId, rpId: intent.rpId,
    credentialId: candidate.credential.credentialId, userHandle: candidate.credential.userHandle, publicKey: candidate.credential.publicKey,
    backupEligible: candidate.credential.backupEligible, verifiedAtMs: proof.verifiedAtMs, supersededAtMs: null, recovery: receipt };
  return { context: validateWalletAuthorityContext(context), receipt, setupDocument };
}
