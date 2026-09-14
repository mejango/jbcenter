import { randomBytes, randomUUID } from "node:crypto";
import { hashTypedData, isAddress, type Address, type Hex } from "viem";
import { RestError } from "../core.js";
import type { createSmartAccountService } from "../smartAccounts/service.js";
import type { VerifiedSmartAccountRegistry } from "../smartAccounts/types.js";
import { enrollmentDigest, walletEnrollmentDocument } from "./enrollment.js";
import { copyWalletEnrollmentProof, copyWalletEnrollmentRegistration, type PostgresWalletEnrollmentStore } from "./enrollmentPostgres.js";
import { copyWalletSignupAssertion, type PostgresWalletSignupStore, type WalletSignupSetup } from "./signupPostgres.js";
import { prepareWalletDeploymentApproval, walletDeploymentDocument } from "./deployment.js";
import type { PostgresWalletDeploymentStore, WalletDeploymentRecoveryCursor } from "./deploymentPostgres.js";
import type { createWalletDeploymentChain } from "./deploymentChain.js";
import type { createWalletDeploymentExecution } from "./deploymentExecution.js";
import type { createLocalAnvilWalletDeploymentSettlement } from "./deploymentSettlementLocalAnvil.js";
import type { createWalletAuthorityService } from "./authorityService.js";
import type { WalletRegistrationResponse } from "./registration.js";
import type { WalletAssertion } from "./webauthn.js";
import { verifyWalletAssertion } from "./webauthn.js";
import { encodeSafe7579MessageSignature } from "../smartAccounts/passkeySignatures.js";
import { passkeyOnboardingProofDocument } from "../smartAccounts/passkeyOnboarding.js";

export interface LocalWalletSignupDependencies {
  flows: PostgresWalletSignupStore; enrollments: PostgresWalletEnrollmentStore; deployments: PostgresWalletDeploymentStore;
  settlement: ReturnType<typeof createLocalAnvilWalletDeploymentSettlement>; execution: ReturnType<typeof createWalletDeploymentExecution>;
  chain: ReturnType<typeof createWalletDeploymentChain>; smart: ReturnType<typeof createSmartAccountService>;
  registry: Pick<VerifiedSmartAccountRegistry, "list">; authority: ReturnType<typeof createWalletAuthorityService>; poolId: string;
  onEvent?: (event: { stage: "worker" | "deployment" | "setup"; outcome: string; operationId?: string; elapsedMs?: number }) => void;
}
export type WalletSignupPhase = "awaiting_registration" | "awaiting_possession" | "awaiting_deployment_approval" |
  "deploying" | "deployment_failed" | "awaiting_setup" | "ready_to_sign_in" | "expired";
function state(): never { throw new RestError(409, "WALLET_SIGNUP_STATE", "Reload this signup and complete its current step."); }
function fields(value: unknown, keys: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Reflect.ownKeys(value).length !== keys.length ||
    keys.some(key => !Object.hasOwn(value, key) || !("value" in Object.getOwnPropertyDescriptor(value, key)!)))
    throw new RestError(400, "WALLET_SIGNUP_INVALID", "Signup input is invalid.");
}

/** Local orchestration of existing authority boundaries. It cannot construct a treasury
 * capability from HTTP input, issue sessions, or turn continuation tokens into owner consent.
 * Host initializes the qualified local allocation explicitly before starting this worker. */
export function createLocalWalletSignup(options: LocalWalletSignupDependencies) {
  const { flows, enrollments, deployments, settlement, execution, chain, smart, registry } = options;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(options.poolId)) state();
  const poolId = options.poolId;
  function event(value: Parameters<NonNullable<LocalWalletSignupDependencies["onEvent"]>>[0]) {
    try { options.onEvent?.(value); } catch { /* Observation hooks never change durable authority. */ }
  }
  async function context(flowToken: string) {
    const flow = await flows.authenticate(flowToken);
    if (!flow) throw new RestError(403, "WALLET_SIGNUP_UNAUTHORIZED", "Resume signup with your passkey to continue.");
    const enrollment = await enrollments.get(flow.enrollmentId);
    if (!enrollment) state();
    return { flow, enrollment };
  }
  async function status(flowToken: string) {
    const { flow, enrollment } = await context(flowToken), now = await flows.now();
    const operation = flow.deploymentId ? await deployments.get(flow.deploymentId) : null;
    if (operation && (operation.enrollmentId !== enrollment.intent.id || operation.poolId !== poolId)) state();
    const receipt = operation ? await deployments.getSettlement(operation.id) : null;
    const configured = enrollment.receipt ? (await registry.list(enrollment.receipt.accountId)).some(binding =>
      binding.wallet.chainId === 8453 && binding.wallet.address.toLowerCase() === enrollment.creation!.address.toLowerCase() &&
      binding.authorization.method === "safe-passkey-owner-threshold-and-api-grant" &&
      binding.authorization.setup?.initializerHash === enrollment.creation!.initializerHash) : false;
    const phase: WalletSignupPhase = enrollment.state !== "verified" ? (enrollment.intent.expiresAt <= now ? "expired" : enrollment.state)
      : configured ? "ready_to_sign_in"
      : receipt ? (receipt.evidence.observation.wallet.state === "verified" && receipt.evidence.observation.transaction.state === "canonical-success"
        ? "awaiting_setup" : "deployment_failed")
      : !operation || operation.state === "prepared" ? "awaiting_deployment_approval" : "deploying";
    // Explicit DTO. Signed treasury bytes, accounting capability, raw credential and setup
    // browser proof are never returned. A configured binding still needs fresh W6 login.
    return { phase, enrollmentId: enrollment.intent.id, passkeyName: flow.passkeyName, rpId: enrollment.intent.rpId,
      origin: enrollment.intent.origin, expiresAtMs: flow.expiresAtMs, enrollmentExpiresAtMs: enrollment.intent.expiresAt,
      recoveryOwner: enrollment.intent.recoveryOwner, walletAddress: enrollment.creation?.address ?? null,
      initializerHash: enrollment.creation?.initializerHash ?? null,
      registration: phase === "awaiting_registration" ? { challenge: enrollment.intent.registration.challenge, userHandle: enrollment.intent.userHandle } : null,
      possession: phase === "awaiting_possession" ? { credentialId: enrollment.candidate!.credentialId, document: walletEnrollmentDocument(enrollment),
        challenge: hashTypedData(walletEnrollmentDocument(enrollment)) } : null,
      deploymentId: operation?.id ?? null, transactionHash: operation?.signed?.hash ?? null };
  }
  async function begin(input: { recoveryOwner: Address; passkeyName: string }) {
    const begun = await flows.begin(input);
    return { flowToken: begun.flowToken, view: await status(begun.flowToken) };
  }
  async function register(flowToken: string, input: WalletRegistrationResponse) {
    const registration = copyWalletEnrollmentRegistration(input), { enrollment } = await context(flowToken);
    await enrollments.acceptRegistration(enrollment.intent.id, registration);
    return status(flowToken);
  }
  async function proveEnrollment(flowToken: string, input: { assertion: WalletAssertion; backupSignature: Hex }) {
    const proof = copyWalletEnrollmentProof(input), { enrollment } = await context(flowToken);
    await enrollments.finalize(enrollment.intent.id, proof);
    return status(flowToken);
  }
  async function prepareDeployment(flowToken: string) {
    let { flow, enrollment } = await context(flowToken);
    if (enrollment.state !== "verified") state();
    let operation = flow.deploymentId ? await deployments.get(flow.deploymentId) : null;
    if (operation && (operation.enrollmentId !== enrollment.intent.id || operation.poolId !== poolId || operation.state !== "prepared")) state();
    const now = await flows.now();
    if (!operation || operation.approval.expiresAt <= now) {
      const approval = prepareWalletDeploymentApproval(enrollment, { issuedAt: now, expiresAt: now + 180_000 });
      const prepared = await deployments.prepare({ poolId, approval });
      flow = await flows.associateDeployment(flowToken, flow.revision, prepared.id);
      operation = prepared;
    }
    const document = walletDeploymentDocument(enrollment, operation.approval);
    return { id: operation.id, walletAddress: enrollment.creation!.address, recoveryOwner: enrollment.intent.recoveryOwner,
      initializerHash: enrollment.creation!.initializerHash, expiresAtMs: operation.approval.expiresAt, rpId: enrollment.intent.rpId,
      credentialId: enrollment.candidate!.credentialId, document, challenge: hashTypedData(document) };
  }
  async function approveDeployment(flowToken: string, input: { approvalId: string; assertion: WalletAssertion }) {
    fields(input, ["approvalId", "assertion"]);
    const approvalId = input.approvalId, assertion = copyWalletSignupAssertion(input.assertion);
    const { flow, enrollment } = await context(flowToken);
    if (flow.deploymentId !== approvalId || enrollment.state !== "verified") state();
    const operation = await deployments.get(approvalId);
    if (!operation || operation.poolId !== poolId || operation.enrollmentId !== enrollment.intent.id) state();
    // The original claim already consumed this purpose. Recovery reads its immutable state;
    // it does not issue another signature, claim, nonce or allocation.
    if (operation.state !== "prepared") return status(flowToken);
    const admission = await chain.preflight(enrollment, operation.approval);
    const funding = await settlement.observeFunding(await deployments.loadFundingContext(poolId));
    if ((await context(flowToken)).flow.deploymentId !== approvalId) state();
    await deployments.claim({ operationId: approvalId, assertion, admission: admission.admission, funding });
    return status(flowToken);
  }
  async function setupReview(setup: WalletSignupSetup) {
    const review = await smart.passkeyOnboardingChallenge(setup.input);
    if (review.state.stateHash !== setup.stateHash || review.state.manifestRevision !== setup.manifestRevision ||
      review.typedData.message.initializerHash !== setup.initializerHash) state();
    return { id: setup.id, input: setup.input, document: review.typedData, proofDocument: passkeyOnboardingProofDocument(review.typedData), signingPayload: review.signingPayload,
      walletAddress: setup.input.address, recoveryOwner: review.state.ownerProfile!.recoveryOwner.address,
      passkeySigner: review.state.ownerProfile!.signer.address, expiresAtMs: setup.input.expiresAt * 1000 };
  }
  async function prepareSetup(flowToken: string, input: { browserPublicAddress: Address }) {
    fields(input, ["browserPublicAddress"]);
    const browserPublicAddress = input.browserPublicAddress;
    if (!isAddress(browserPublicAddress) || BigInt(browserPublicAddress) <= 1n) state();
    const { flow, enrollment } = await context(flowToken);
    if ((await status(flowToken)).phase !== "awaiting_setup") state();
    const now = Math.floor(await flows.now() / 1000);
    if (flow.setup && flow.setup.input.expiresAt > now) {
      if (flow.setup.input.grant.botAddress.toLowerCase() !== browserPublicAddress.toLowerCase()) state();
      return setupReview(flow.setup);
    }
    const request = { profile: "center-passkey-v1" as const, address: enrollment.creation!.address,
      manifestId: enrollment.intent.manifest.id, nonce: `0x${randomBytes(32).toString("hex")}` as Hex,
      issuedAt: now, expiresAt: now + 300, grant: { id: randomUUID(), botAddress: browserPublicAddress,
        scopes: ["read", "plan", "relay"] as ["read", "plan", "relay"], expiresAt: now + 3600, label: "Juicebox wallet setup" } };
    const review = await smart.passkeyOnboardingChallenge(request);
    const setup: WalletSignupSetup = { id: randomUUID(), input: request, stateHash: review.state.stateHash,
      manifestRevision: review.state.manifestRevision, initializerHash: review.typedData.message.initializerHash };
    await flows.associateSetup(flowToken, flow.revision, setup);
    return setupReview(setup);
  }
  async function completeSetup(flowToken: string, input: { setupId: string; signature: Hex; browserProof: Hex }) {
    fields(input, ["setupId", "signature", "browserProof"]);
    const { setupId, signature, browserProof } = input;
    if (typeof signature !== "string" || !/^0x(?:[0-9a-fA-F]{2}){1,8192}$/.test(signature) ||
      typeof browserProof !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(browserProof)) state();
    const { flow } = await context(flowToken), setup = flow.setup;
    if (!setup || setup.id !== setupId) state();
    // Commit through the existing canonical owner verifier and atomic setup store. Never
    // reconstruct account, binding or grants from the continuation row itself.
    await smart.finalizePasskeyOnboarding({ ...setup.input, stateHash: setup.stateHash, manifestRevision: setup.manifestRevision,
      initializerHash: setup.initializerHash, signature, proofSignature: browserProof });
    event({ stage: "setup", outcome: "committed" });
    return status(flowToken);
  }

  async function completeSetupPasskey(flowToken: string, input: { setupId: string; assertion: WalletAssertion; browserProof: Hex }) {
    fields(input, ["setupId", "assertion", "browserProof"]);
    const assertion = copyWalletSignupAssertion(input.assertion), { setupId, browserProof } = input;
    if (typeof browserProof !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(browserProof)) state();
    const { flow, enrollment } = await context(flowToken);
    if (!flow.setup || flow.setup.id !== setupId || !enrollment.candidate || !enrollment.receipt) state();
    // A lost response after the setup commit only reads the original account. It does
    // not consume another ceremony, change owners, or grant a second browser key.
    if ((await status(flowToken)).phase === "ready_to_sign_in") return status(flowToken);
    const review = await setupReview(flow.setup);
    const proof = verifyWalletAssertion(assertion, { purpose: "session", challenge: review.signingPayload.digest,
      rpId: enrollment.intent.rpId, origin: enrollment.intent.origin, requireUserHandle: true,
      credential: { id: enrollment.candidate.credentialId, userHandle: enrollment.intent.userHandle,
        publicKey: enrollment.candidate.publicKey, backupEligible: enrollment.candidate.backupEligible } });
    return completeSetup(flowToken, { setupId, browserProof,
      signature: encodeSafe7579MessageSignature([{ kind: "contract", owner: review.passkeySigner, signature: proof.contractSignature }]) });
  }

  let cursor: WalletDeploymentRecoveryCursor | null = null, running: Promise<void> | null = null;
  let stopped = false, timer: ReturnType<typeof setTimeout> | null = null;
  const stopSignal = new AbortController();
  async function pass() {
    const start = performance.now();
    const page = await deployments.listUnresolved({ ...(cursor ? { cursor } : {}), limit: 1 });
    cursor = page.nextCursor;
    for (const item of page.items) {
      if (stopped) break;
      try {
        const record = await deployments.get(item.id);
        if (!record || record.poolId !== poolId) continue;
        await execution.recover(item.id, stopSignal.signal);
        const latest = await deployments.get(item.id);
        if (latest?.state === "signed" && !await deployments.getSettlement(item.id)) {
          const context = await deployments.loadSettlementContext(item.id);
          if (!context.dispatch || context.dispatch.leaseUntil <= await flows.now()) {
            const evidence = await settlement.observeSettlement(context, stopSignal.signal);
            const result = await deployments.settle(context, evidence);
            event({ stage: "deployment", outcome: result.settlement ? "settled" : "fenced", operationId: item.id });
          }
        }
      } catch {
        // Existing stores preserve exact bytes, unknown outcomes and fences. A failed
        // observation cannot release a sender lane or invent a replacement operation.
        event({ stage: "deployment", outcome: "pending_or_unavailable", operationId: item.id });
      }
    }
    event({ stage: "worker", outcome: "pass", elapsedMs: Math.round(performance.now() - start) });
  }
  function tick(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = pass().finally(() => { running = null; });
    return running;
  }
  function start() {
    if (stopped || timer !== null) return;
    const schedule = () => { timer = setTimeout(() => {
      void tick().catch(() => event({ stage: "worker", outcome: "unavailable" })).finally(() => {
        timer = null; if (!stopped) schedule();
      });
    }, 1000); timer.unref(); };
    schedule();
  }
  async function stop(): Promise<boolean> {
    stopped = true; stopSignal.abort(); if (timer !== null) clearTimeout(timer); timer = null;
    if (!running) return true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([running.then(() => true, () => true), new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 5000); })]); }
    finally { if (timeout) clearTimeout(timeout); }
  }
  return { begin, status, register, proveEnrollment, prepareDeployment, approveDeployment, prepareSetup, completeSetup, completeSetupPasskey,
    beginResume: flows.beginResume.bind(flows), completeResume: flows.completeResume.bind(flows), tick, start, stop };
}
