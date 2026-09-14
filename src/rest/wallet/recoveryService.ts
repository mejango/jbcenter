import { randomBytes, randomUUID } from 'node:crypto';
import { getAddress, hashTypedData, isAddress, type Address, type Hex } from 'viem';
import { RestError } from '../core.js';
import { validateAudience } from '../auth/signatures.js';
import { enrollmentDigest } from './enrollment.js';
import { walletRecoveryDocument } from './recovery.js';
import { walletRecoveryRotationDocument } from './recoveryRotation.js';
import type { PostgresWalletRecoveryStore } from './recoveryPostgres.js';
import type { PostgresWalletRecoveryFlowStore } from './recoveryFlowPostgres.js';
import type { createLocalAnvilWalletRecovery } from './recoveryLocalAnvil.js';
import type { createSmartAccountService } from '../smartAccounts/service.js';
import type { createWalletAuthorityService } from './authorityService.js';
import type { WalletRegistrationResponse } from './registration.js';
import type { WalletAssertion } from './webauthn.js';
import { verifyWalletAssertion } from './webauthn.js';
import { copyWalletSignupAssertion, type WalletSignupSetup } from './signupPostgres.js';
import { passkeyOnboardingProofDocument } from '../smartAccounts/passkeyOnboarding.js';
import { encodeSafe7579MessageSignature } from '../smartAccounts/passkeySignatures.js';

export type WalletRecoveryPhase = 'awaiting_registration' | 'awaiting_possession' | 'awaiting_rotation_approval'
  | 'rotating' | 'rotation_failed' | 'awaiting_setup' | 'ready_to_sign_in' | 'expired';
export interface WalletRecoveryView {
  id: string; passkeyName: string; rpId: string; origin: string; audience: string; expiresAtMs: number; proofExpiresAtMs: number;
  walletAddress: Address; recoveryOwner: Address; initializerHash: Hex; priorSigner: Address; replacementSigner: Address | null;
  phase: WalletRecoveryPhase; candidateDigest: string | null;
  rotationContext: { publicKey: { x: Hex; y: Hex }; signerFactory: Address; verifiers: Hex } | null;
  registration: { challenge: string; userHandle: string } | null;
  possession: { credentialId: string; document: ReturnType<typeof walletRecoveryDocument>; challenge: Hex } | null;
  transactionHashes: Hex[];
}
export interface LocalWalletRecoveryDependencies {
  audience: string;
  recoveries: PostgresWalletRecoveryStore; flows: PostgresWalletRecoveryFlowStore;
  rotation: ReturnType<typeof createLocalAnvilWalletRecovery>;
  smart: ReturnType<typeof createSmartAccountService>; authority: ReturnType<typeof createWalletAuthorityService>;
  onEvent?: (event: { stage: 'rotation' | 'setup' | 'activation'; outcome: string; recoveryId: string }) => void;
}
function state(): never { throw new RestError(409, 'WALLET_RECOVERY_STATE', 'Check the original recovery and complete its current step.'); }
function unauthorized(): never { throw new RestError(403, 'WALLET_RECOVERY_UNAUTHORIZED', 'Resume the original recovery with both owners.'); }
function fields(value: unknown, names: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== names.length
    || names.some(key => !Object.hasOwn(value, key) || !('value' in Object.getOwnPropertyDescriptor(value, key)!))) state();
}

/** Explicit local-host composition. Neither a locator, continuation nor proof receipt is
 * transaction authority. Rotation dispatch retains its independent exact owner approval,
 * local chain capability and durable fee reservations. A fresh W6 login remains separate. */
export function createLocalWalletRecovery(options: LocalWalletRecoveryDependencies) {
  const { recoveries, flows, rotation, smart, authority } = options;
  const audience = validateAudience(options.audience);
  const event = (value: Parameters<NonNullable<LocalWalletRecoveryDependencies['onEvent']>>[0]) => {
    try { options.onEvent?.(value); } catch { /* Observation is not authority. */ }
  };
  async function context(flowToken: string) {
    const flow = await flows.authenticate(flowToken);
    if (!flow) unauthorized();
    const record = await recoveries.get(flow.id, flowToken);
    if (!record) unauthorized();
    return { flow, record };
  }
  async function status(flowToken: string): Promise<WalletRecoveryView> {
    const { flow, record } = await context(flowToken), { intent, candidate, proof, activation } = record;
    let phase: WalletRecoveryPhase;
    let transactionHashes: Hex[] = [];
    if (activation) {
      // Old completed recovery continuations cannot claim to be the current identity.
      if (!await recoveries.isCurrentActivation(intent.id, flowToken)) state();
      const current = await authority.refreshAuthority(intent.accountId);
      if (current.snapshot.readiness !== 'verified') state();
      phase = 'ready_to_sign_in';
    } else if (!proof) {
      phase = intent.expiresAtMs <= Date.now() ? 'expired' : candidate ? 'awaiting_possession' : 'awaiting_registration';
    } else {
      const observed = await rotation.status(intent.id);
      transactionHashes = Object.values(observed.transactions).filter((value): value is Hex => value !== null);
      phase = observed.state === 'review' ? 'awaiting_rotation_approval' : observed.state === 'ready' ? 'awaiting_setup'
        : observed.state === 'failed' ? 'rotation_failed' : 'rotating';
    }
    return { id: intent.id, passkeyName: flow.passkeyName, rpId: intent.rpId, origin: intent.origin, audience,
      expiresAtMs: flow.expiresAtMs, proofExpiresAtMs: intent.expiresAtMs, walletAddress: getAddress(intent.accountId.slice(12)),
      recoveryOwner: intent.recoveryOwner, initializerHash: intent.initializerHash, priorSigner: intent.priorSigner,
      replacementSigner: candidate?.signerAddress ?? null, phase, transactionHashes,
      candidateDigest: candidate ? enrollmentDigest(candidate) : null,
      rotationContext: candidate ? { publicKey: candidate.credential.publicKey, signerFactory: intent.manifest.ownerProfile!.signerFactory.address,
        verifiers: intent.manifest.ownerProfile!.p256Verifier.address } : null,
      registration: phase === 'awaiting_registration' ? { challenge: intent.registration.challenge, userHandle: intent.userHandle } : null,
      possession: phase === 'awaiting_possession' ? { credentialId: candidate!.credential.credentialId,
        document: walletRecoveryDocument(candidate!), challenge: hashTypedData(walletRecoveryDocument(candidate!)) } : null };
  }
  async function begin(input: { walletAddress: Address; passkeyName: string }) {
    fields(input, ['walletAddress', 'passkeyName']);
    if (!isAddress(input.walletAddress) || BigInt(input.walletAddress) <= 1n || typeof input.passkeyName !== 'string'
      || !input.passkeyName.length || input.passkeyName !== input.passkeyName.trim() || Buffer.byteLength(input.passkeyName) > 120
      || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(input.passkeyName)) state();
    const begun = await recoveries.begin('eip155:8453:' + input.walletAddress.toLowerCase());
    await flows.initialize({ recoveryId: begun.record.intent.id, flowToken: begun.flowToken, passkeyName: input.passkeyName });
    return { flowToken: begun.flowToken, view: await status(begun.flowToken) };
  }
  async function register(flowToken: string, input: WalletRegistrationResponse) {
    const { record } = await context(flowToken);
    await recoveries.register(record.intent.id, flowToken, input); return status(flowToken);
  }
  async function prove(flowToken: string, input: { assertion: WalletAssertion; backupSignature: Hex }) {
    const { record } = await context(flowToken);
    await recoveries.prove(record.intent.id, flowToken, input); return status(flowToken);
  }
  async function prepareRotation(flowToken: string) {
    const { record } = await context(flowToken);
    if (!record.proof || record.activation) state();
    const review = await rotation.prepare(record.intent.id);
    return { review, document: walletRecoveryRotationDocument(review) };
  }
  async function approveRotation(flowToken: string, backupSignature: Hex) {
    const { record } = await context(flowToken);
    if (!record.proof) state();
    if (record.activation) return status(flowToken);
    const review = await rotation.prepare(record.intent.id);
    await rotation.approve(record.intent.id, review, backupSignature, flowToken);
    event({ stage: 'rotation', outcome: 'checked_original_attempt', recoveryId: record.intent.id });
    return status(flowToken);
  }
  async function setupReview(setup: WalletSignupSetup) {
    const review = await smart.passkeyOnboardingChallenge(setup.input);
    if (review.state.stateHash !== setup.stateHash || review.state.manifestRevision !== setup.manifestRevision
      || review.typedData.message.initializerHash !== setup.initializerHash) state();
    return { id: setup.id, input: setup.input, document: review.typedData, proofDocument: passkeyOnboardingProofDocument(review.typedData),
      signingPayload: review.signingPayload, walletAddress: setup.input.address,
      recoveryOwner: review.state.ownerProfile!.recoveryOwner.address, passkeySigner: review.state.ownerProfile!.signer.address,
      expiresAtMs: setup.input.expiresAt * 1000 };
  }
  async function prepareSetup(flowToken: string, input: { browserPublicAddress: Address }) {
    fields(input, ['browserPublicAddress']);
    if (!isAddress(input.browserPublicAddress) || BigInt(input.browserPublicAddress) <= 1n) state();
    const { flow, record } = await context(flowToken);
    if (!record.candidate || !record.proof || (await status(flowToken)).phase !== 'awaiting_setup') state();
    const now = Math.floor(Date.now() / 1000);
    if (flow.setup && flow.setup.input.expiresAt > now) {
      if (flow.setup.input.grant.botAddress.toLowerCase() !== input.browserPublicAddress.toLowerCase()) state();
      return setupReview(flow.setup);
    }
    const request = { profile: 'center-passkey-v1' as const, address: record.intent.accountId.slice(12) as Address,
      manifestId: record.intent.manifest.id, nonce: `0x${randomBytes(32).toString('hex')}` as Hex,
      issuedAt: now, expiresAt: now + 300, grant: { id: randomUUID(), botAddress: input.browserPublicAddress,
        scopes: ['read', 'plan', 'relay'] as ['read', 'plan', 'relay'], expiresAt: now + 3600, label: 'Juicebox wallet recovery' } };
    const review = await smart.passkeyOnboardingChallenge(request);
    if (review.state.ownerProfile!.signer.address.toLowerCase() !== record.candidate.signerAddress.toLowerCase()
      || review.typedData.message.initializerHash !== record.intent.initializerHash) state();
    const setup: WalletSignupSetup = { id: randomUUID(), input: request, stateHash: review.state.stateHash,
      manifestRevision: review.state.manifestRevision, initializerHash: review.typedData.message.initializerHash };
    await flows.associateSetup(flowToken, flow.revision, setup); return setupReview(setup);
  }
  async function completeSetup(flowToken: string, input: { setupId: string; assertion: WalletAssertion; browserProof: Hex }) {
    fields(input, ['setupId', 'assertion', 'browserProof']);
    const assertion = copyWalletSignupAssertion(input.assertion), { setupId, browserProof } = input;
    if (typeof browserProof !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(browserProof)) state();
    const { flow, record } = await context(flowToken), setup = flow.setup, candidate = record.candidate;
    if (!setup || setup.id !== setupId || !candidate || !record.proof) state();
    if (record.activation) {
      await recoveries.activate(record.intent.id, flowToken, assertion);
      return status(flowToken);
    }
    if ((await rotation.status(record.intent.id)).state !== 'ready') state();
    const review = await setupReview(setup);
    const verified = verifyWalletAssertion(assertion, { purpose: 'session', challenge: review.signingPayload.digest,
      rpId: record.intent.rpId, origin: record.intent.origin, requireUserHandle: true,
      credential: { id: candidate.credential.credentialId, userHandle: candidate.credential.userHandle,
        publicKey: candidate.credential.publicKey, backupEligible: candidate.credential.backupEligible } });
    await smart.finalizePasskeyOnboarding({ ...setup.input, stateHash: setup.stateHash, manifestRevision: setup.manifestRevision,
      initializerHash: setup.initializerHash, proofSignature: browserProof,
      signature: encodeSafe7579MessageSignature([{ kind: 'contract', owner: candidate.signerAddress, signature: verified.contractSignature }]) });
    event({ stage: 'setup', outcome: 'committed', recoveryId: record.intent.id });
    await recoveries.activate(record.intent.id, flowToken, assertion);
    event({ stage: 'activation', outcome: 'committed', recoveryId: record.intent.id });
    return status(flowToken);
  }
  let stopped = false, timer: ReturnType<typeof setTimeout> | null = null, running: Promise<void> | null = null;
  const controller = new AbortController();
  const tick = () => {
    if (stopped) return Promise.resolve();
    return running ??= rotation.tick(controller.signal).finally(() => { running = null; });
  };
  function start() {
    if (stopped || timer) return;
    const pass = async () => {
      try { await tick(); } catch { /* Durable original attempts remain available for reconciliation. */ }
      if (!stopped) timer = setTimeout(() => { void pass(); }, 1000);
    };
    timer = setTimeout(() => { void pass(); }, 0);
  }
  async function stop() {
    stopped = true; controller.abort(); if (timer) clearTimeout(timer);
    await running?.catch(() => {});
  }
  return { begin, status, register, prove, prepareRotation, approveRotation, prepareSetup, completeSetup, tick, start, stop,
    restart: (flowToken: string) => flows.assertRestartable(flowToken),
    beginResume: (id: string) => flows.beginResume(id),
    completeResume: (input: Parameters<PostgresWalletRecoveryFlowStore['completeResume']>[0]) => flows.completeResume(input) };
}
