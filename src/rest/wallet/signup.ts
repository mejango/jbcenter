import { hashTypedData, type Address, type Hex } from "viem";
import { RestError, type RestRpc } from "../core.js";
import { detachedFromRequest } from "../context.js";
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
import type { WalletDeploymentFundingEvidence } from "./deploymentSettlement.js";
import type { WalletDeploymentAdmission, WalletDeploymentOperation } from "./deploymentPostgres.js";
import type { WalletEnrollment } from "./enrollment.js";
import type { createWalletAuthorityService } from "./authorityService.js";
import type { WalletRegistrationResponse } from "./registration.js";
import type { WalletAssertion } from "./webauthn.js";

export interface LocalWalletSignupDependencies {
  flows: PostgresWalletSignupStore; enrollments: PostgresWalletEnrollmentStore; deployments: PostgresWalletDeploymentStore;
  settlement: ReturnType<typeof createLocalAnvilWalletDeploymentSettlement>; execution: ReturnType<typeof createWalletDeploymentExecution>;
  chain: ReturnType<typeof createWalletDeploymentChain>; smart: ReturnType<typeof createSmartAccountService>;
  registry: Pick<VerifiedSmartAccountRegistry, "list">; authority: ReturnType<typeof createWalletAuthorityService>; poolId: string;
  /** With it, a fresh signup is signed in from its creation approval once the account is ready (see `session`). */
  login?: { completeFromSignup(input: { enrollment: WalletEnrollment; operation: WalletDeploymentOperation; assertion: WalletAssertion }):
    Promise<{ session: unknown; sessionToken: string }> };
  /** How often a released inclusion is re-read while it waits for finality (default 15 s; a local chain may use 0). */
  releasedObservationIntervalMs?: number;
  /** Display only: right after a send, the receipt is read a few times for a Flashblocks
   * preconfirmation (a receipt before the block, zero blockHash). The page shows "included";
   * nothing durable and nothing about the account's authority moves on it. */
  preconfirmationReads?: RestRpc;
  onEvent?: (event: { stage: "worker" | "deployment" | "setup" | "approval"; outcome: string; operationId?: string; elapsedMs?: number; reason?: string; detail?: Record<string, unknown> }) => void;
}
/** The approval's chain reads (treasury funding, creation preflight) run while the passkey prompt is
 * up and are carried into the claim if they are younger than the hosted admission window; the map is
 * bounded and a review is refreshed a few times while it stays open. */
export const walletSignupSpeculation = Object.freeze({ maxAgeMs: 20_000, refreshMs: 12_000, refreshes: 4, cap: 64 });
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
  const poolId = options.poolId, releasedInterval = options.releasedObservationIntervalMs ?? 15_000, speculation = walletSignupSpeculation;
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
    // The account exists at the canonical receipt: the observation proved our exact transaction and
    // its one ProxyCreation log for the predicted address (CREATE2 binds that address to the
    // initializer). The wallet's full inspection runs behind it and gates the binding, not the page.
    const creation = receipt?.evidence.observation ?? operation?.observation;
    const created = creation?.transaction.state === "canonical-success";
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
      deploymentId: operation?.id ?? null, transactionHash: operation?.signed?.hash ?? null,
      preconfirmed: phase === "deploying" && !!operation && preconfirmed.has(operation.id) };
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
  type Speculated = { at: number; funding: WalletDeploymentFundingEvidence; admission: WalletDeploymentAdmission };
  const speculated = new Map<string, Speculated>(), speculating = new Map<string, Promise<void>>(), reviews = new Map<string, number>();
  async function chainReads(enrollment: WalletEnrollment, operation: WalletDeploymentOperation) {
    // Base mines every two seconds: the funding read fixes the head and the preflight is pinned
    // to it, so the claim always pairs one block's admission with that block's funding.
    const funding = await settlement.observeFunding(await deployments.loadFundingContext(poolId));
    const admission = (await chain.preflight(enrollment, operation.approval, undefined, funding.head)).admission;
    return { funding, admission };
  }
  function speculate(enrollment: WalletEnrollment, operation: WalletDeploymentOperation) {
    const id = operation.id, held = speculated.get(id);
    // One at a time, and a review re-read within the refresh interval adds nothing.
    if (speculating.has(id) || stopped || (held && Date.now() - held.at < speculation.refreshMs)) return;
    const work = detachedFromRequest(async () => {
      const started = performance.now();
      try {
        const reads = await chainReads(enrollment, operation), at = Date.now();
        for (const [key, entry] of speculated) if (at - entry.at > speculation.maxAgeMs) speculated.delete(key);
        if (speculated.size >= speculation.cap) speculated.delete(speculated.keys().next().value!);
        speculated.delete(id); speculated.set(id, { at, ...reads }); // re-inserted last: the cap evicts the oldest
        event({ stage: "approval", outcome: "speculated", operationId: id, elapsedMs: Math.round(performance.now() - started) });
      } catch (error) { failure(id, error, "approval", "speculation_failed"); }
    }).finally(() => {
      speculating.delete(id);
      // Refresh while the review is still open, a bounded number of times; approve stops it.
      const left = reviews.get(id) ?? 0;
      if (left > 0 && !stopped) {
        reviews.set(id, left - 1);
        setTimeout(() => { if (reviews.has(id)) speculate(enrollment, operation); }, speculation.refreshMs).unref();
      } else reviews.delete(id); // No refresh scheduled: nothing keeps the key.
    });
    speculating.set(id, work);
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
    if (!reviews.has(operation.id)) reviews.set(operation.id, speculation.refreshes);
    speculate(enrollment, operation);
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
    // The chain reads made while the prompt was up are carried if they are still inside the hosted
    // admission window; the claim validates them exactly as it would fresh ones (funding evidence
    // lifetime, admission age, pool revision), and a refused carry is read again inline.
    reviews.delete(approvalId);
    const held = speculated.get(approvalId); speculated.delete(approvalId);
    const carried = held && Date.now() - held.at <= speculation.maxAgeMs ? held : null;
    if ((await context(flowToken)).flow.deploymentId !== approvalId) state();
    let claimed = false;
    if (carried) {
      try {
        await deployments.claim({ operationId: approvalId, assertion, admission: carried.admission, funding: carried.funding }); claimed = true;
        event({ stage: "approval", outcome: "carried", operationId: approvalId, elapsedMs: Date.now() - carried.at });
      } catch (error) {
        if (!(error instanceof RestError) || ![409, 410].includes(error.status)) throw error;
        failure(approvalId, error, "approval", "carry_refused");
      }
    }
    if (!claimed) {
      const reads = await chainReads(enrollment, operation);
      await deployments.claim({ operationId: approvalId, assertion, admission: reads.admission, funding: reads.funding });
      event({ stage: "approval", outcome: "inline", operationId: approvalId });
    }
    // The approval's assertion is held for the signup session (in memory, this process, ≤ 15 min,
    // once), for this continuation as it is now: a resume rotates the flow, and the hold with it.
    for (const [id, held] of approvals) if (Date.now() - held.at > 900_000) approvals.delete(id);
    if (approvals.size >= 256) approvals.delete(approvals.keys().next().value!);
    approvals.set(enrollment.intent.id, { deploymentId: approvalId, flowRevision: flow.revision, assertion, at: Date.now() });
    // The worker's next pass (sign, admit, send) starts now rather than at its next 1 s tick.
    void detachedFromRequest(tick).catch(() => undefined);
    return status(flowToken);
  }
  const approvals = new Map<string, { deploymentId: string; flowRevision: number; assertion: WalletAssertion; at: number }>();
  /** A fresh signup's session from its creation approval: the assertion this process verified at
   * the claim signs the account in once its authority is verified. The store re-verifies it against
   * the claimed deployment; anything held longer than 15 minutes, a resumed signup or a restarted
   * process gets the ordinary login prompt instead. */
  async function session(flowToken: string) {
    const { flow, enrollment } = await context(flowToken), held = approvals.get(enrollment.intent.id);
    // A resumed continuation (rotated token, advanced revision) is not the one that approved.
    if (!options.login || !held || Date.now() - held.at > 900_000 || held.flowRevision !== flow.revision) state();
    const current = await status(flowToken);
    if (current.phase !== "ready_to_sign_in" || current.deploymentId !== held.deploymentId) state();
    const operation = await deployments.get(held.deploymentId);
    if (!operation) state();
    approvals.delete(enrollment.intent.id);
    const result = await options.login.completeFromSignup({ enrollment, operation, assertion: held.assertion });
    event({ stage: "setup", outcome: "session" });
    return result;
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
    event({ stage: "setup", outcome: "committed" }); notify(enrollment.intent.id);
    return status(flowToken);
  }

  let running: Promise<void> | null = null;
  let stopped = false, timer: ReturnType<typeof setTimeout> | null = null;
  const stopSignal = new AbortController();
  const canonical = (state: string) => state === "canonical-success" || state === "canonical-revert";
  function failure(operationId: string, error: unknown, stage: "deployment" | "approval" = "deployment", outcome = "pending_or_unavailable") {
    // Existing stores preserve exact bytes, unknown outcomes and fences. A failed observation
    // cannot release a sender lane or invent a replacement operation. The error class and
    // bounded details are logged so a stuck operation is diagnosable.
    const detail = error instanceof RestError && error.details && typeof error.details === "object"
      ? Object.fromEntries(Object.entries(error.details as Record<string, unknown>).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value)).slice(0, 12)) : undefined;
    event({ stage, outcome, operationId,
      reason: error instanceof RestError ? error.code : error instanceof Error ? error.name : "unknown", ...(detail ? { detail } : {}) });
  }
  // In-process phase changes keyed by enrollment: the events stream re-reads the view on each. A
  // restart loses the listeners, not the phases; the page reconnects and reads the durable view.
  const watchers = new Map<string, Set<() => void>>();
  function notify(enrollmentId: string) { for (const listener of watchers.get(enrollmentId) ?? []) { try { listener(); } catch { /* observation only */ } } }
  async function watch(flowToken: string, listener: () => void): Promise<() => void> {
    const { enrollment } = await context(flowToken), id = enrollment.intent.id;
    const set = watchers.get(id) ?? new Set<() => void>(); set.add(listener); watchers.set(id, set);
    return () => { set.delete(listener); if (set.size === 0 && watchers.get(id) === set) watchers.delete(id); };
  }
  // ponytail: bounded in-memory display state; a restart forgets it and the page waits for the block.
  const preconfirmed = new Map<string, number>();
  async function preconfirm(operationId: string, enrollmentId: string, transactionHash: Hex) {
    const reads = options.preconfirmationReads;
    if (!reads) return;
    for (const [id, at] of preconfirmed) if (Date.now() - at > 300_000) preconfirmed.delete(id);
    if (preconfirmed.size >= 64) preconfirmed.delete(preconfirmed.keys().next().value!);
    for (let attempt = 0; attempt < 8 && !stopped; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      try {
        const receipt = await reads.request(8453, "eth_getTransactionReceipt", [transactionHash], stopSignal.signal) as { transactionHash?: unknown } | null;
        if (receipt && typeof receipt.transactionHash === "string" && receipt.transactionHash.toLowerCase() === transactionHash) {
          preconfirmed.set(operationId, Date.now()); event({ stage: "deployment", outcome: "preconfirmed", operationId, elapsedMs: (attempt + 1) * 250 });
          notify(enrollmentId); return;
        }
      } catch { /* display only */ }
    }
  }
  /** The wallet's full inspection, behind the released lane: the account service keeps the verified
   * state, activation binds from it and the authority refresh carries it, each after re-checking its
   * block. It runs beside the pass so the next user's send does not wait on it. */
  const inspecting = new Set<string>();
  async function inspectBehind(operationId: string, enrollmentId: string) {
    const started = performance.now(); inspecting.add(operationId);
    try {
      const enrollment = await enrollments.get(enrollmentId);
      if (!enrollment?.creation || smart.remembered(enrollment.intent.manifest.id, enrollment.creation.address)) return;
      await smart.inspect({ manifestId: enrollment.intent.manifest.id, address: enrollment.creation.address }, stopSignal.signal);
      event({ stage: "deployment", outcome: "inspected", operationId, elapsedMs: Math.round(performance.now() - started) });
      notify(enrollmentId);
    } catch (error) { failure(operationId, error, "deployment", "inspection_failed"); }
    finally { inspecting.delete(operationId); }
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
          const recovered = await execution.recover(active.id, stopSignal.signal);
          if (recovered.dispatch === "accepted" && recovered.operation.signed) { notify(record.enrollmentId); void preconfirm(active.id, record.enrollmentId, recovered.operation.signed.hash); }
          const latest = await deployments.get(active.id);
          if (latest?.state === "signed" && latest.releasedAt === null && latest.observation && canonical(latest.observation.transaction.state)) {
            // The account exists at the canonical receipt: the page hears it and the inspection
            // starts now; the lane's release (which may wait out the dispatch lease) follows.
            preconfirmed.delete(latest.id); notify(latest.enrollmentId);
            if (!inspecting.has(latest.id)) void inspectBehind(latest.id, latest.enrollmentId).catch(() => undefined);
            const released = await deployments.release({ operationId: latest.id, expectedRevision: latest.revision });
            event({ stage: "deployment", outcome: released.pool.accounting?.fence ? "fenced" : "released", operationId: latest.id });
            notify(latest.enrollmentId);
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
          // Until finality only the inclusion is re-read: the receipt, the nonce, the finalized tag.
          const observation = await chain.observeSigned(structuredClone({ enrollment: context.enrollment, operation: context.operation }), stopSignal.signal, { inspection: "inclusion" });
          await deployments.saveObservation({ operationId: lowest.id, expectedRevision: context.operation.revision,
            signedHash: context.operation.signed!.hash, observation });
          const state = observation.transaction.state, nonce = observation.transaction.nonce;
          // A reorged read from a provider head before the admission block is staleness, not chain
          // evidence; only a sender nonce rewound below ours (or no inclusion at a fresh head) fences.
          const rewound = state === "reorged" && nonce !== null && BigInt(nonce.confirmed) < BigInt(context.operation.template!.transaction.nonce);
          if (rewound || ["nonce-conflict", "not-observed", "pending"].includes(state)) {
            await deployments.fenceAccounting(await deployments.loadFundingContext(poolId), { reason: "inclusion-reorged", operationId: lowest.id });
            event({ stage: "deployment", outcome: "fenced", operationId: lowest.id, reason: state }); notify(context.enrollment.intent.id);
          } else if (canonical(state) && observation.finality.state === "finalized") {
            const fresh = await deployments.loadSettlementContext(lowest.id);
            const evidence = await settlement.observeSettlement(fresh, stopSignal.signal);
            const result = await deployments.settle(fresh, evidence);
            event({ stage: "deployment", outcome: result.settlement ? "settled" : "fenced", operationId: lowest.id }); notify(context.enrollment.intent.id);
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
  return { begin, status, register, proveEnrollment, prepareDeployment, approveDeployment, activate, session, watch,
    beginResume: flows.beginResume.bind(flows), completeResume: flows.completeResume.bind(flows), tick, start, stop };
}
