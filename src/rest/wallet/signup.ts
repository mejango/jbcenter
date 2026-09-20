import { hashTypedData, type Address, type Hex } from "viem";
import { RestError } from "../core.js";
import type { createSmartAccountService } from "../smartAccounts/service.js";
import type { VerifiedSmartAccountRegistry } from "../smartAccounts/types.js";
import { enrollmentDigest, walletEnrollmentDocument } from "./enrollment.js";
import { copyWalletEnrollmentProof, copyWalletEnrollmentRegistration, type PostgresWalletEnrollmentStore } from "./enrollmentPostgres.js";
import { copyWalletSignupAssertion, type PostgresWalletSignupStore } from "./signupPostgres.js";
import { prepareWalletDeploymentApproval, walletDeploymentDocument } from "./deployment.js";
import type { PostgresWalletDeploymentStore } from "./deploymentPostgres.js";
import { walletDeploymentSettlementLimits } from "./deploymentSettlement.js";
import type { createWalletDeploymentChain } from "./deploymentChain.js";
import type { createWalletDeploymentExecution } from "./deploymentExecution.js";
import type { createLocalAnvilWalletDeploymentSettlement } from "./deploymentSettlementLocalAnvil.js";
import type { createWalletAuthorityService } from "./authorityService.js";
import type { WalletRegistrationResponse } from "./registration.js";
import type { WalletAssertion } from "./webauthn.js";

export interface LocalWalletSignupDependencies {
  flows: PostgresWalletSignupStore; enrollments: PostgresWalletEnrollmentStore; deployments: PostgresWalletDeploymentStore;
  settlement: ReturnType<typeof createLocalAnvilWalletDeploymentSettlement>; execution: ReturnType<typeof createWalletDeploymentExecution>;
  chain: ReturnType<typeof createWalletDeploymentChain>; smart: ReturnType<typeof createSmartAccountService>;
  registry: Pick<VerifiedSmartAccountRegistry, "list">; authority: ReturnType<typeof createWalletAuthorityService>; poolId: string;
  /** How often a released inclusion is re-read while it waits for finality (default 15 s; a local chain may use 0). */
  releasedObservationIntervalMs?: number;
  onEvent?: (event: { stage: "worker" | "deployment" | "setup"; outcome: string; operationId?: string; elapsedMs?: number; reason?: string; detail?: Record<string, unknown> }) => void;
}
export type WalletSignupPhase = "awaiting_registration" | "awaiting_possession" | "awaiting_deployment_approval" |
  "deploying" | "deployment_failed" | "awaiting_activation" | "preparing_sign_in" | "ready_to_sign_in" | "expired";
function state(): never { throw new RestError(409, "WALLET_SIGNUP_STATE", "Reload this signup and complete its current step."); }
function fields(value: unknown, keys: string[], optional: string[] = []) {
  const own = value && typeof value === "object" ? Reflect.ownKeys(value) : [];
  if (!value || typeof value !== "object" || Array.isArray(value) || own.length < keys.length || own.length > keys.length + optional.length ||
    own.some(key => typeof key !== "string" || (!keys.includes(key) && !optional.includes(key))) ||
    keys.some(key => !Object.hasOwn(value, key) || !("value" in Object.getOwnPropertyDescriptor(value, key)!)))
    throw new RestError(400, "WALLET_SIGNUP_INVALID", "Signup input is invalid.");
}

/** Local orchestration of existing authority boundaries. It cannot construct a treasury
 * capability from HTTP input, issue sessions, or turn continuation tokens into owner consent.
 * Host initializes the qualified local allocation explicitly before starting this worker. */
export function createLocalWalletSignup(options: LocalWalletSignupDependencies) {
  const { flows, enrollments, deployments, settlement, execution, chain, smart, registry } = options;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(options.poolId)) state();
  const poolId = options.poolId, releasedInterval = options.releasedObservationIntervalMs ?? 15_000;
  if (!Number.isSafeInteger(releasedInterval) || releasedInterval < 0 || releasedInterval > 300_000) state();
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
    // The account exists once a binding carries this wallet's consent: the creation consent (the
    // enrollment proof, or a later recovery's proof once a replacement passkey took over) or, for
    // accounts from before it, the owner-signed setup document. Bindings are written only by the
    // trusted service from proofs on record; the authority context revalidates them.
    const configured = enrollment.receipt ? (await registry.list(enrollment.receipt.accountId)).some(binding =>
      binding.wallet.chainId === 8453 && binding.wallet.address.toLowerCase() === enrollment.creation!.address.toLowerCase() &&
      (binding.authorization.method === "center-wallet-passkey-creation-v1"
        || (binding.authorization.method === "safe-passkey-owner-threshold-and-api-grant" &&
          binding.authorization.setup?.initializerHash === enrollment.creation!.initializerHash))) : false;
    // Login needs the worker's verified authority observation (~25 s over a hosted provider);
    // until then the signup is "preparing", and the page polls rather than prompting.
    const current = configured ? await options.authority.currentAuthority(enrollment.receipt!.accountId) : null;
    const signInReady = current?.readiness === "verified" && !current.bootstrapRequired;
    // Setup re-inspects the current canonical wallet and requires fresh owner and
    // browser proofs. It need not wait for the treasury's finalized fee receipt.
    // Use only the latest observation here; retained history is not current evidence.
    const creation = receipt?.evidence.observation ?? operation?.observation;
    const created = creation?.transaction.state === "canonical-success" && creation.wallet.state === "verified";
    const phase: WalletSignupPhase = enrollment.state !== "verified" ? (enrollment.intent.expiresAt <= now ? "expired" : enrollment.state)
      : configured ? (signInReady ? "ready_to_sign_in" : "preparing_sign_in")
      : created ? "awaiting_activation"
      : receipt ? "deployment_failed"
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
    const proof = copyWalletEnrollmentProof(input), { flow, enrollment } = await context(flowToken);
    await enrollments.finalize(enrollment.intent.id, proof, { passkeyName: flow.passkeyName });
    return status(flowToken);
  }
  async function prepareDeployment(flowToken: string) {
    let { flow, enrollment } = await context(flowToken);
    if (enrollment.state !== "verified" && enrollment.state !== "awaiting_possession") state();
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
  async function approveDeployment(flowToken: string, input: { approvalId: string; assertion: WalletAssertion; backupSignature?: Hex }) {
    fields(input, ["approvalId", "assertion"], ["backupSignature"]);
    const approvalId = input.approvalId, assertion = copyWalletSignupAssertion(input.assertion);
    let { flow, enrollment } = await context(flowToken);
    if (flow.deploymentId !== approvalId || (enrollment.state !== "verified" && enrollment.state !== "awaiting_possession")) state();
    const operation = await deployments.get(approvalId);
    if (!operation || operation.poolId !== poolId || operation.enrollmentId !== enrollment.intent.id) state();
    // The original claim already consumed this purpose. Recovery reads its immutable state;
    // it does not issue another signature, claim, nonce or allocation.
    if (operation.state !== "prepared") return status(flowToken);
    if (enrollment.state === "awaiting_possession") {
      // One passkey prompt: the assertion over the creation document approves creation and proves
      // possession; the recovery owner's signature over the enrollment document rides along.
      if (input.backupSignature === undefined) state();
      await enrollments.finalize(enrollment.intent.id, { assertion: input.assertion, backupSignature: input.backupSignature },
        { passkeyChallenge: hashTypedData(walletDeploymentDocument(enrollment, operation.approval)), passkeyName: flow.passkeyName });
      ({ flow, enrollment } = await context(flowToken));
      if (flow.deploymentId !== approvalId || enrollment.state !== "verified") state();
    }
    // Base mines every two seconds: the funding read fixes the head and the preflight is pinned
    // to it, so the claim always pairs one block's admission with that block's funding.
    const funding = await settlement.observeFunding(await deployments.loadFundingContext(poolId));
    const admission = await chain.preflight(enrollment, operation.approval, undefined, funding.head);
    if ((await context(flowToken)).flow.deploymentId !== approvalId) state();
    await deployments.claim({ operationId: approvalId, assertion, admission: admission.admission, funding });
    return status(flowToken);
  }
  /** Binds the created wallet to its account from the consent the passkey already gave at
   * enrollment. No prompt and no browser grant; login needs only the worker's verified authority. */
  async function activate(flowToken: string) {
    const { enrollment } = await context(flowToken), current = await status(flowToken);
    if (["preparing_sign_in", "ready_to_sign_in"].includes(current.phase)) return current;
    if (current.phase !== "awaiting_activation" || !enrollment.receipt) state();
    await smart.bindPasskeyAccount({ manifestId: enrollment.intent.manifest.id, address: enrollment.creation!.address,
      consent: { id: enrollment.receipt.enrollmentId, digest: `0x${enrollment.receipt.verificationDigest}` },
      expected: { signerAddress: enrollment.creation!.bootstrap.signerAddress, initializerHash: enrollment.creation!.initializerHash } });
    event({ stage: "setup", outcome: "committed" });
    return status(flowToken);
  }

  let running: Promise<void> | null = null;
  let stopped = false, timer: ReturnType<typeof setTimeout> | null = null;
  const stopSignal = new AbortController();
  const canonical = (state: string) => state === "canonical-success" || state === "canonical-revert";
  function failure(operationId: string, error: unknown) {
    // Existing stores preserve exact bytes, unknown outcomes and fences. A failed observation
    // cannot release a sender lane or invent a replacement operation. The error class and
    // bounded details are logged so a stuck operation is diagnosable.
    const detail = error instanceof RestError && error.details && typeof error.details === "object"
      ? Object.fromEntries(Object.entries(error.details as Record<string, unknown>).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value)).slice(0, 12)) : undefined;
    event({ stage: "deployment", outcome: "pending_or_unavailable", operationId,
      reason: error instanceof RestError ? error.code : error instanceof Error ? error.name : "unknown", ...(detail ? { detail } : {}) });
  }
  /** One pass moves the active operation (sign, send, observe, release at canonical inclusion)
   * and then the lowest released nonce (observe, fence if it left the canonical chain, settle at
   * finality). Settlement is in nonce order, so only the lowest released row is watched. */
  async function pass() {
    const start = performance.now();
    const page = await deployments.listUnresolved({ limit: walletDeploymentSettlementLimits.maximumUnsettled + 1 });
    const mine = page.items.filter(item => item.state === "signed" || item.state === "claimed");
    const active = mine.find(item => item.releasedAt === null);
    const queue = mine.filter(item => item.releasedAt !== null && item.nonce !== null).sort((a, b) => Number(BigInt(a.nonce!) - BigInt(b.nonce!)));
    if (active && !stopped) {
      try {
        const record = await deployments.get(active.id);
        if (record && record.poolId === poolId) {
          await execution.recover(active.id, stopSignal.signal);
          const latest = await deployments.get(active.id);
          if (latest?.state === "signed" && latest.releasedAt === null && latest.observation && canonical(latest.observation.transaction.state)) {
            const released = await deployments.release({ operationId: latest.id, expectedRevision: latest.revision });
            event({ stage: "deployment", outcome: released.pool.accounting?.fence ? "fenced" : "released", operationId: latest.id });
            if (released.operation.releasedAt !== null && released.operation.template)
              queue.push({ ...active, nonce: released.operation.template.transaction.nonce, releasedAt: released.operation.releasedAt });
          }
        }
      } catch (error) { failure(active.id, error); }
    }
    const lowest = queue.sort((a, b) => Number(BigInt(a.nonce!) - BigInt(b.nonce!)))[0];
    if (lowest && !stopped) {
      try {
        const context = await deployments.loadSettlementContext(lowest.id), now = await flows.now();
        // ponytail: a released inclusion is re-read at most every releasedInterval; finality takes
        // minutes and a reorg surfaces on the next read. The active operation's pass stays fast in between.
        if (context.operation.poolId === poolId && (!context.dispatch || context.dispatch.leaseUntil <= now) &&
            (context.operation.observationSavedAt === null || now - context.operation.observationSavedAt >= releasedInterval)) {
          const observation = await chain.observeSigned(structuredClone({ enrollment: context.enrollment, operation: context.operation }), stopSignal.signal);
          await deployments.saveObservation({ operationId: lowest.id, expectedRevision: context.operation.revision,
            signedHash: context.operation.signed!.hash, observation });
          const state = observation.transaction.state;
          if (["reorged", "nonce-conflict", "not-observed", "pending"].includes(state)) {
            await deployments.fenceAccounting(await deployments.loadFundingContext(poolId), { reason: "inclusion-reorged", operationId: lowest.id });
            event({ stage: "deployment", outcome: "fenced", operationId: lowest.id, reason: state });
          } else if (canonical(state) && observation.finality.state === "finalized") {
            const fresh = await deployments.loadSettlementContext(lowest.id);
            const evidence = await settlement.observeSettlement(fresh, stopSignal.signal);
            const result = await deployments.settle(fresh, evidence);
            event({ stage: "deployment", outcome: result.settlement ? "settled" : "fenced", operationId: lowest.id });
          }
        }
      } catch (error) { failure(lowest.id, error); }
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
  return { begin, status, register, proveEnrollment, prepareDeployment, approveDeployment, activate,
    beginResume: flows.beginResume.bind(flows), completeResume: flows.completeResume.bind(flows), tick, start, stop };
}
