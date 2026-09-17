import type {UserOperationSponsorRoutes} from './sponsorRoutes.js';
import { randomUUID } from "node:crypto";
import { toHex, type Hex } from "viem";
import type { RestPrincipal } from "../auth/store.js";
import {
  RestError,
  type RestActor,
  type RestBlockEvidence,
  type RestRpc,
} from "../core.js";
import { exactObject } from "../protocol/abi.js";
import type { SessionService } from "../sessions/service.js";
import type {
  StoredSession,
  UserOperationSessionBinding,
} from "../sessions/types.js";
import {
  encodeLegacyUseSignature,
  encodeSafe7579Execution,
  encodeSafe7579OwnerSignature,
  legacySessionSigningPayload,
  safe7579NonceKey,
  safe7579OwnerSigningPayload,
  verifyLegacySessionSignature,
  verifySafe7579OwnerSignature,
} from "../smartAccounts/accountExecution.js";
import type {
  SmartAccountBinding,
  SmartAccountManifest,
} from "../smartAccounts/types.js";
import { assertCompiledSessionCall } from "../smartAccounts/compiler.js";
import type { TransactionStore } from "../transactions/store.js";
import type { TransactionService } from "../transactions/service.js";
import type {
  SemanticVerifier,
  StoredPlan,
  StoredReceipt,
  ExternalExecutionObservation,
} from "../transactions/types.js";
import { UserOperationChain } from "./chain.js";
import {
  applyUserOperationEstimate,
  assertUserOperationGasPolicy,
  getUserOperationHash,
  normalizeUserOperation,
  uoCanonical,
  uoHash,
  uoQuantity,
  userOperationCommitment,
} from "./codec.js";
import { observeUserOperation } from "./execution.js";
import { walletV6UsdcPaymentDomain, verifyWalletV6UsdcPaymentEffects, type WalletV6UsdcPaymentConfig } from "./semantics.js";
import { UserOperationProvider } from "./provider.js";
import { createSessionGasEstimation } from "./estimation.js";
import { passkeyDummySignature, passkeyEstimateProvider } from "./passkeyEstimation.js";
import { assertPasskeyUserOperationEnvelope, userOperationPasskeyProfile, verifyPasskeyUserOperation } from "./passkeyVerification.js";
import { safe7579PasskeyOwnerSigningPayload } from "../smartAccounts/passkeySignatures.js";
import { createPasskeyContractSignatureVerifier } from "../smartAccounts/passkeyContractVerifier.js";
import { finalizeUserOperationSponsorship } from "./sponsorship.js";
import {
  digest,
  isRecoverable,
  recoveryCursor,
  type UserOperationRecord,
  type UserOperationStore,
} from "./store.js";
import type {
  UserOperationExecutionBinding,
  UserOperationGasPolicy,
  UserOperationV07,
} from "./types.js";

export interface UserOperationChainPolicy {
  chainId: number;
  gas: UserOperationGasPolicy;
  confirmations: number;
}
export interface UserOperationServiceDependencies {
  rpc: RestRpc;
  provider: UserOperationProvider;
  sponsorRoutes?: Pick<UserOperationSponsorRoutes, "authorize" | "stored">;
  store: UserOperationStore;
  transactionStore: TransactionStore;
  transactions: TransactionService;
  sessions?: SessionService;
  policies: readonly UserOperationChainPolicy[];
  currentBinding(
    accountId: string,
    id: Hex,
    signal?: AbortSignal,
  ): Promise<SmartAccountBinding>;
  currentBindingAt(
    accountId: string,
    id: Hex,
    evidence: RestBlockEvidence,
    signal?: AbortSignal,
  ): Promise<SmartAccountBinding>;
  manifestFor(binding: SmartAccountBinding): SmartAccountManifest;
  manifestForPlan(plan: StoredPlan): SmartAccountManifest;
  verifyHistoricalAccount(
    plan: StoredPlan,
    evidence: RestBlockEvidence,
    signal?: AbortSignal,
  ): Promise<void>;
  authorizeRequest(
    actor: RestActor,
    id: string,
    signature: Hex,
  ): Promise<{ issuedAt: number; expiresAt: number }>;
  semanticVerifier: SemanticVerifier;
  /** Optional reviewed host profile; absent configuration retains generic batch uncertainty. */
  v6UsdcPayment?: WalletV6UsdcPaymentConfig;
  now?: () => number;
}
export interface UserOperationPreparationInput {
  sponsorAuthorization?: string;
  planId: string;
  stepIndexes: number[];
  sessionId?: string;
}
const actorOf = (p: RestPrincipal): RestActor => ({
  accountId: p.account.id,
  principalId: p.principalId,
});
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const dummySignature = `0x${"11".repeat(32)}${"22".repeat(32)}1b` as Hex;
const max = (a: bigint, b: bigint) => (a > b ? a : b);
function fail(code: string, message: string, status = 409): never {
  throw new RestError(status, code, message);
}
function exactActor(actor: RestActor, record: { actor: RestActor }) {
  if (
    actor.accountId !== record.actor.accountId ||
    actor.principalId !== record.actor.principalId
  )
    fail(
      "USER_OPERATION_NOT_FOUND",
      "The preparation belongs to another principal.",
      404,
    );
}
function appOperation(principal: RestPrincipal, chainId: number, hasSession: boolean): void {
  if (principal.kind !== "wallet-app") return;
  if (hasSession)
    fail("USER_OPERATION_APP_SESSION_UNAVAILABLE", "Apps require fresh wallet owner approval for each operation.", 403);
  if (chainId !== 8453 || principal.account.authorityChainId !== 8453)
    fail("USER_OPERATION_APP_CHAIN_UNAVAILABLE", "App wallet operations are available only on Base.", 403);
}

/** Prepares, verifies and relays externally signed operations. It never holds a signing key. */
export class UserOperationService {
  private readonly now: () => number;
  private recoveryCursor: string | undefined;
  constructor(private readonly options: UserOperationServiceDependencies) {
    this.now = options.now ?? Date.now;
    if (
      new Set(options.policies.map((p) => p.chainId)).size !==
        options.policies.length ||
      options.policies.some(
        (p) =>
          !Number.isSafeInteger(p.confirmations) ||
          p.confirmations < 1 ||
          p.confirmations > 1024,
      )
    )
      fail(
        "USER_OPERATION_POLICY_INVALID",
        "Each configured chain requires one bounded confirmation policy.",
        500,
      );
  }
  capabilities() {
    const providers = this.options.provider.capabilities();
    return {
      transport: "eip4337-user-operation",
      version: "0.7",
      providers,
      preparation: providers.length > 0,
      relay: providers.length > 0,
      privateKeysStored: false,
      automaticResubmission: false,
      sessionMaximumCallsPerOperation: 1,
      ownerMaximumCallsPerOperation: 16,
      freshOwnerApprovalOutsideSession: true,
      activationRequirements: [
        "verified-account-creation-and-authority-history",
        "reviewed-per-chain-runtime-pins",
        "configured-hosted-bundler-and-paymaster",
        "deployed-session-guard-for-recurring-authority",
      ],
    };
  }
  private chain(signal?: AbortSignal) {
    return new UserOperationChain(this.options.rpc, {
      now: this.now,
      ...(signal ? { signal } : {}),
    });
  }
  private policy(chainId: number) {
    return (
      this.options.policies.find((p) => p.chainId === chainId) ??
      fail(
        "USER_OPERATION_CHAIN_UNAVAILABLE",
        "No reviewed execution policy is configured for this chain.",
        503,
      )
    );
  }
  private async plan(actor: RestActor, id: string, fresh: boolean) {
    if (fresh) await this.options.transactions.getPlan(actor, id);
    const plan = await this.options.transactionStore.get(actor, id);
    if (!plan)
      return fail(
        "PLAN_NOT_FOUND",
        "The plan was not found for this principal.",
        404,
      );
    exactActor(actor, plan);
    if (!plan.smartAccount)
      fail(
        "USER_OPERATION_SMART_PLAN_REQUIRED",
        "Prepare the plan through its verified smart-account binding.",
      );
    if (fresh && plan.expiresAt <= this.now())
      fail(
        "PLAN_EXPIRED",
        "Prepare a fresh plan before requesting another operation.",
      );
    return plan;
  }
  private async account(plan: StoredPlan, signal?: AbortSignal, at?: RestBlockEvidence) {
    const approved = plan.smartAccount!;
    const binding = at
      ? await this.options.currentBindingAt(plan.actor.accountId, approved.bindingId, at, signal)
      : await this.options.currentBinding(plan.actor.accountId, approved.bindingId, signal);
    if (
      !binding.state.moduleConfigurationVerified ||
      !same(binding.state.stateHash, approved.stateHash) ||
      binding.wallet.chainId !== approved.chainId ||
      !same(binding.wallet.address, plan.draft.account) ||
      !same(binding.state.manifestRevision, approved.manifestRevision)
    )
      fail(
        "USER_OPERATION_ACCOUNT_CHANGED",
        "The plan's reviewed owner or module configuration changed.",
      );
    const manifest = this.options.manifestFor(binding);
    if (manifest.mode !== "execution-candidate" || !manifest.entryPoint)
      fail(
        "USER_OPERATION_STACK_UNAVAILABLE",
        "This account manifest supports ownership binding but not verified execution.",
        503,
      );
    const provider = this.options.provider.configuration(
      binding.wallet.chainId,
    );
    if (
      !same(provider.entryPoint.address, manifest.entryPoint.address) ||
      !same(
        provider.entryPoint.runtimeCodeHash,
        manifest.entryPoint.runtimeCodeHash,
      )
    )
      fail(
        "USER_OPERATION_PROVIDER_MISMATCH",
        "The bundler and account must use the same reviewed EntryPoint.",
      );
    return { binding, manifest };
  }

  async prepare(
    principal: RestPrincipal,
    input: UserOperationPreparationInput,
    key: string,
    requestHash: Hex,
    signal?: AbortSignal,
  ) {
    if (!principal.scopes.includes("plan"))
      fail(
        "USER_OPERATION_SCOPE_REQUIRED",
        "Preparation requires plan scope.",
        403,
      );
    exactObject(
      input,
      ["planId", "stepIndexes", "sessionId", "sponsorAuthorization"],
      "user operation",
    );
    appOperation(principal, principal.account.authorityChainId, Object.hasOwn(input, "sessionId"));
    if (
      Object.hasOwn(input, "sessionId") &&
      (typeof input.sessionId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          input.sessionId,
        ))
    )
      fail(
        "USER_OPERATION_SESSION_INVALID",
        "A supplied sessionId must be an exact session UUID.",
        400,
      );
    const actor = actorOf(principal),
      inputHash = uoHash(requestHash, "request hash");
    const existing = await this.options.store.find(actor, key, inputHash);
    if (existing) {
      appOperation(principal, existing.chainId, existing.session !== undefined);
      return this.view(existing);
    }
    const plan = await this.plan(actor, input.planId, true);
    appOperation(principal, plan.smartAccount!.chainId, false);
    await this.options.sessions?.assertOwnerPlan(principal, plan);
    if (
      !Array.isArray(input.stepIndexes) ||
      input.stepIndexes.length < 1 ||
      input.stepIndexes.length > 16 ||
      input.stepIndexes.some(
        (index, i) =>
          !Number.isSafeInteger(index) ||
          !plan.steps[index] ||
          (i > 0 && index <= input.stepIndexes[i - 1]!),
      )
    )
      fail(
        "USER_OPERATION_STEPS_INVALID",
        "Select 1–16 distinct steps in their original order.",
        400,
      );
    if (input.sessionId && input.stepIndexes.length !== 1)
      fail(
        "SESSION_SINGLE_EXECUTION_REQUIRED",
        "The reviewed session guard permits one exact action per UserOperation.",
        400,
      );
    const selected = new Set(input.stepIndexes);
    for (const index of selected) {
      const step = plan.steps[index]!;
      if (step.state !== "waiting" || step.attempt || step.externalExecution)
        fail(
          "USER_OPERATION_STEP_RESERVED",
          "A selected step already has an execution transport.",
        );
      for (const dependency of plan.draft.calls[index]!.dependsOn) {
        if (selected.has(dependency)) continue;
        const prerequisite = plan.steps[dependency]!;
        if (
          prerequisite.state !== "confirmed" ||
          !prerequisite.receipt?.canonical ||
          prerequisite.receipt.status !== "success" ||
          !prerequisite.semantic ||
          !["verified", "unmodeled"].includes(prerequisite.semantic.status)
        )
          fail(
            "USER_OPERATION_DEPENDENCIES_UNCONFIRMED",
            "Prerequisites outside this atomic operation need verified canonical results.",
          );
      }
    }
    const { binding, manifest } = await this.account(plan, signal);
    const passkeyProfile = userOperationPasskeyProfile(binding, manifest);
    if (passkeyProfile && input.sessionId)
      fail("USER_OPERATION_PASSKEY_SESSION_UNAVAILABLE", "The passkey pilot requires fresh owner approval for every operation.", 422);
    const policy = this.policy(binding.wallet.chainId);
    if (input.sessionId && input.sponsorAuthorization !== undefined)
      fail('SPONSOR_OWNER_REQUIRED', 'Application sponsorship requires fresh owner approval.', 403);
    const provider = input.sponsorAuthorization === undefined ? this.options.provider :
      this.options.sponsorRoutes?.authorize(input.sponsorAuthorization, {
        accountId: actor.accountId, planId: plan.id, chainId: binding.wallet.chainId,
        stepIndexes: input.stepIndexes, idempotencyKey: key,
      }) ?? fail('SPONSOR_ROUTE_UNAVAILABLE', 'Application sponsorship is not configured.', 403);
    let session: UserOperationSessionBinding | undefined;
    let gasSession: StoredSession | undefined;
    if (input.sessionId) {
      const verified = await this.session(principal, input.sessionId, signal);
      if (verified.record.compiled.bindingId !== binding.id)
        fail(
          "SESSION_ACCOUNT_MISMATCH",
          "The session belongs to another wallet.",
        );
      session = verified.binding;
      gasSession = verified.record;
      for (const index of input.stepIndexes) {
        const call = plan.draft.calls[index]!;
        assertCompiledSessionCall(verified.record.compiled, {
          target: call.to,
          value: call.value,
          callData: call.data,
        });
      }
    }
    const chain = this.chain(signal);
    const nonceKey = session
      ? BigInt(safe7579NonceKey(manifest.smartSessions.address))
      : 0n;
    // The bundler's readiness, the nonce at the head (which carries the base fee) and the two fee
    // quotes are independent: they go out together.
    const [, { nonce, evidence, baseFeePerGas }, nodePriority, floor] = await Promise.all([
      provider.readiness(binding.wallet.chainId, signal),
      chain.nonce(binding.wallet.chainId, binding.wallet.address, nonceKey, manifest.entryPoint!),
      chain.request(binding.wallet.chainId, "eth_maxPriorityFeePerGas", []),
      provider.gasPrice(binding.wallet.chainId, signal),
    ]);
    // Never below the bundler's floor: a cheaper operation is accepted, then waits until it expires.
    const priority = max(uoQuantity(nodePriority, "priority fee"), floor?.maxPriorityFeePerGas ?? 0n);
    const fee = max(uoQuantity(baseFeePerGas, "base fee") * 2n + priority, floor?.maxFeePerGas ?? 0n);
    if (
      fee > policy.gas.maximumFeePerGas ||
      priority > policy.gas.maximumPriorityFeePerGas
    )
      fail(
        "USER_OPERATION_FEE_LIMIT",
        "Current network fees exceed the operator's approved gas policy.",
      );
    let operation: UserOperationV07 = {
      sender: binding.wallet.address,
      nonce,
      signature: "0x",
      callData: encodeSafe7579Execution(
        input.stepIndexes.map((index) => {
          const call = plan.draft.calls[index]!;
          return { target: call.to, value: call.value, callData: call.data };
        }),
      ),
      callGasLimit: toHex(policy.gas.maximumCallGas),
      verificationGasLimit: toHex(policy.gas.maximumVerificationGas),
      preVerificationGas: toHex(policy.gas.maximumPreVerificationGas),
      maxFeePerGas: toHex(fee),
      maxPriorityFeePerGas: toHex(priority),
    };
    const createdAt = this.now();
    let expiresAt = Math.min(plan.expiresAt, createdAt + 300_000);
    const dummy = (expiry = expiresAt) =>
      session
        ? encodeLegacyUseSignature(session.permissionId, dummySignature)
        : passkeyProfile
        ? passkeyDummySignature({ signer: passkeyProfile.signer.address,
            validAfter: String(Math.floor(createdAt / 1000)), validUntil: String(Math.floor(expiry / 1000)) })
        : encodeSafe7579OwnerSignature({
            validAfter: String(Math.floor(createdAt / 1000)),
            validUntil: String(Math.floor(expiry / 1000)),
            signatures: `0x${dummySignature.slice(2).repeat(binding.state.threshold)}`,
          });
    const providerConfig = provider.configuration(
      binding.wallet.chainId,
    );
    const sponsored = Boolean(providerConfig.paymasterPolicy);
    if ((session || policy.gas.requirePaymaster) && !sponsored)
      fail(
        "USER_OPERATION_PAYMASTER_REQUIRED",
        "This operation requires the reviewed gas-only sponsor.",
        503,
      );
    const gasEstimation = gasSession
      ? await createSessionGasEstimation(gasSession, policy.gas, operation)
      : undefined;
    if (gasEstimation) operation = gasEstimation.fit(operation, true);
    const stub = sponsored
      ? await provider.stub(
          binding.wallet.chainId,
          operation,
          signal,
        )
      : undefined;
    if (stub) operation = stub.operation;
    if (gasEstimation && !stub?.isFinal)
      operation = gasEstimation.fit(operation);
    gasEstimation?.assert(operation);
    const estimateProvider = passkeyProfile ? passkeyEstimateProvider(provider, policy.gas.maximumVerificationGas) : provider;
    const estimate = await estimateProvider.estimate(
      binding.wallet.chainId,
      { ...operation, signature: dummy() },
      signal,
      gasEstimation,
    );
    if (stub?.isFinal) {
      // A final stub binds its exact supplied gas fields. Keep them if they cover the independent estimate.
      for (const [field, amount] of Object.entries(estimate))
        if (
          BigInt(amount) >
          BigInt(operation[field as keyof UserOperationV07] ?? "0x0")
        )
          fail(
            "USER_OPERATION_SPONSOR_GAS_CHANGED",
            "The final stub cannot cover the current gas estimate. Prepare a fresh sponsored operation.",
          );
      expiresAt = Math.min(expiresAt, stub.proof.validUntil * 1000);
    } else operation = applyUserOperationEstimate(operation, estimate);
    gasEstimation?.assert(operation);
    if (sponsored && !stub?.isFinal) {
      const funded = await finalizeUserOperationSponsorship({
        chainId: binding.wallet.chainId,
        operation,
        gasPolicy: policy.gas,
        profile: providerConfig.paymasterPolicy?.profile,
        expiresAt,
        dummySignature: dummy,
        provider: estimateProvider,
        sessionGas: gasEstimation,
        signal,
        // The passkey margins (calldata bytes and verification headroom) cover a same-size sponsorship.
        marginsCoverSameSizeSponsorship: passkeyProfile !== undefined,
      });
      operation = funded.operation;
      expiresAt = funded.expiresAt;
    }
    assertUserOperationGasPolicy(operation, policy.gas);
    gasEstimation?.assert(operation);
    await chain.canonical(evidence);
    operation = normalizeUserOperation(operation);
    const operationHash = getUserOperationHash(
      operation,
      manifest.entryPoint!.address,
      binding.wallet.chainId,
    );
    const record: UserOperationRecord = {
      id: randomUUID(),
      actor,
      planId: plan.id,
      planCommitment: plan.commitment,
      stepIndexes: [...input.stepIndexes],
      chainId: binding.wallet.chainId,
      entryPoint: manifest.entryPoint!.address,
      sender: binding.wallet.address,
      operation,
      operationHash,
      preparationKey: key,
      inputHash,
      commitment: digest({
        planId: plan.id,
        planCommitment: plan.commitment,
        operation,
        operationHash,
        accountBindingId: binding.id,
        accountStateHash: binding.state.stateHash,
        ...(session ? { session } : {}),
        gasPolicyId: policy.gas.id,
        providerId: providerConfig.providerId,
        createdAt,
        expiresAt,
      }),
      accountBindingId: binding.id,
      accountStateHash: binding.state.stateHash,
      ...(session ? { session } : {}),
      gasPolicyId: policy.gas.id,
      providerId: providerConfig.providerId,
      createdAt,
      expiresAt,
      revision: 0,
      state: "prepared",
    };
    return this.view(await this.options.store.create(record, this.now()));
  }

  private session(
    principal: RestPrincipal,
    id: string,
    signal?: AbortSignal,
    evidence?: RestBlockEvidence,
  ) {
    appOperation(principal, principal.account.authorityChainId, true);
    if (!this.options.sessions)
      return fail(
        "SESSIONS_UNAVAILABLE",
        "No reviewed session execution stack is configured.",
        503,
      );
    return this.options.sessions.executionBinding(
      principal,
      id,
      signal,
      evidence,
    );
  }

  async submit(
    principal: RestPrincipal,
    id: string,
    signature: Hex,
    key: string,
    signal?: AbortSignal,
  ) {
    const actor = actorOf(principal);
    const record =
      (await this.options.store.get(actor, id)) ??
      fail(
        "USER_OPERATION_NOT_FOUND",
        "UserOperation preparation was not found.",
        404,
      );
    exactActor(actor, record);
    appOperation(principal, record.chainId, record.session !== undefined);
    const operation = normalizeUserOperation({
      ...record.operation,
      signature,
    });
    const signedCommitment = userOperationCommitment(
      operation,
      record.entryPoint,
      record.chainId,
    );
    if (record.submission) return this.replayed(record, signedCommitment, signal);
    const requestAuthority = await this.options.authorizeRequest(
      actor,
      id,
      signature,
    );
    const plan = await this.plan(actor, record.planId, true);
    await this.options.sessions?.assertOwnerPlan(principal, plan);
    return this.dispatch({ actor, principal, record, plan, operation, signedCommitment, key, authority: requestAuthority, signal });
  }

  /** The same signed bytes are published once: a second caller carrying them under another
   * publication key (the approval's own submission and the app's hand-back) observes the first. */
  private async replayed(record: UserOperationRecord, signedCommitment: Hex, signal?: AbortSignal) {
    if (record.submission!.commitment !== signedCommitment)
      fail(
        "USER_OPERATION_CONFLICT",
        "A different signed operation is already reserved.",
      );
    return this.view(await this.refresh(record, signal));
  }

  /** Submission on a payment review's own authority: the app asked for exactly this operation to be
   * reviewed with a signed request, and the owner approved it with the passkey. Every gate before
   * the send is the one an app-signed submission passes; only the request-level authorization is
   * replaced by the review's, and the grant's relay scope is still required at the claim. */
  async submitApproved(
    input: { actor: RestActor; operationId: string; signature: Hex; key: string; authority: { issuedAt: number; expiresAt: number } },
    signal?: AbortSignal,
  ) {
    const record =
      (await this.options.store.get(input.actor, input.operationId)) ??
      fail("USER_OPERATION_NOT_FOUND", "UserOperation preparation was not found.", 404);
    exactActor(input.actor, record);
    if (record.session)
      fail("USER_OPERATION_PASSKEY_SESSION_UNAVAILABLE", "The passkey pilot requires fresh owner approval for every operation.", 422);
    if (record.chainId !== 8453) fail("USER_OPERATION_APP_CHAIN_UNAVAILABLE", "App wallet operations are available only on Base.", 403);
    const operation = normalizeUserOperation({ ...record.operation, signature: input.signature });
    const signedCommitment = userOperationCommitment(operation, record.entryPoint, record.chainId);
    if (record.submission) return this.replayed(record, signedCommitment, signal);
    const plan = await this.plan(input.actor, record.planId, true);
    return this.dispatch({ actor: input.actor, principal: undefined, record, plan, operation, signedCommitment, key: input.key, authority: input.authority, signal });
  }

  private async dispatch(input: {
    actor: RestActor; principal: RestPrincipal | undefined; record: UserOperationRecord; plan: StoredPlan; operation: UserOperationV07;
    signedCommitment: Hex; key: string; authority: { issuedAt: number; expiresAt: number }; signal: AbortSignal | undefined;
  }) {
    const { actor, record, signedCommitment, signal } = input;
    // The approval's own submission and the app's hand-back can run these checks at the same time;
    // whichever loses (a check failing against an operation the other already published, or the
    // claim) observes the submission that landed instead of reporting a failure.
    let claim: Awaited<ReturnType<UserOperationServiceDependencies["store"]["claim"]>>;
    try { claim = await this.admit(input); }
    catch (error) {
      const current = await this.options.store.get(actor, record.id);
      if (current?.submission && same(current.submission.commitment, signedCommitment)) return this.view(await this.refresh(current, signal));
      throw error;
    }
    if (!claim.dispatch)
      return this.view(await this.refresh(claim.record, signal));
    // Admission permanently reserves both plan transport and nonce before the only publication attempt.
    let state: "pending" | "submission_unknown" = "pending";
    try {
      await this.providerForRecord(record).send(record.chainId, input.operation, signal);
    } catch {
      state = "submission_unknown";
    }
    const submitted = await this.options.store.settle(
      record.id,
      signedCommitment,
      state,
    );
    return this.view(submitted);
  }

  /** Every gate before the nonce claim, then the claim itself. */
  private async admit(input: {
    actor: RestActor; principal: RestPrincipal | undefined; record: UserOperationRecord; plan: StoredPlan; operation: UserOperationV07;
    signedCommitment: Hex; key: string; authority: { issuedAt: number; expiresAt: number }; signal: AbortSignal | undefined;
  }) {
    const { actor, principal, record, plan, operation, signedCommitment, key, authority: requestAuthority, signal } = input;
    const id = record.id;
    const policy = this.policy(record.chainId);
    const provider = this.providerForRecord(record);
    if (
      record.expiresAt <= this.now() ||
      record.gasPolicyId !== policy.gas.id ||
      provider.configuration(record.chainId).providerId !==
        record.providerId
    )
      fail(
        "USER_OPERATION_PREPARATION_EXPIRED",
        "The operation expired or its provider policy changed.",
      );
    // One canonical head for the whole submission. The account verification and the EntryPoint
    // preflight are independent of each other at that head, so they run together; both must pass
    // before the signature check, the signed estimate and the nonce claim.
    const head = await this.chain(signal).snapshot(record.chainId);
    // The plan's manifest is the binding's: the account check requires the same revision.
    const planManifest = this.options.manifestForPlan(plan);
    // A passkey profile requires threshold one; the account check below enforces it.
    if (planManifest.ownerProfile && !record.session) assertPasskeyUserOperationEnvelope({ operation, threshold: 1,
      validAfter: String(Math.floor(record.createdAt / 1000)), validUntil: String(Math.floor(record.expiresAt / 1000)) });
    const checks = await Promise.allSettled([
      this.account(plan, signal, head),
      this.chain(signal).preflight(this.execution(record, operation, plan, planManifest), policy.gas, provider, head),
    ]);
    // Both finished at that head; the first failure in this order is the one reported.
    for (const check of checks) if (check.status === "rejected") throw check.reason;
    const { binding, manifest } = (checks[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof this.account>>>).value;
    const preflight = (checks[1] as PromiseFulfilledResult<Awaited<ReturnType<UserOperationChain["preflight"]>>>).value;
    if (manifest.id !== planManifest.id || manifest.revision !== planManifest.revision)
      fail("USER_OPERATION_ACCOUNT_CHANGED", "The plan's reviewed owner or module configuration changed.");
    const passkeyProfile = userOperationPasskeyProfile(binding, manifest);
    if (passkeyProfile && record.session)
      fail("USER_OPERATION_PASSKEY_SESSION_UNAVAILABLE", "The passkey pilot requires fresh owner approval for every operation.", 422);
    let sessionObservationHash: Hex | undefined;
    let validAfter = Math.floor(record.createdAt / 1000),
      validUntil = Math.floor(record.expiresAt / 1000);
    if (record.session) {
      if (!principal) fail("USER_OPERATION_APP_SESSION_UNAVAILABLE", "Session operations need the requesting principal.", 403);
      const fresh = await this.session(principal, record.session.id, signal);
      const { observationHash: _old, ...priorIdentity } = record.session;
      const { observationHash, ...freshIdentity } = fresh.binding;
      if (uoCanonical(priorIdentity) !== uoCanonical(freshIdentity))
        fail(
          "SESSION_GENERATION_CHANGED",
          "The exact installed session generation changed.",
        );
      sessionObservationHash = observationHash;
      await verifyLegacySessionSignature({
        operation,
        chainId: record.chainId,
        entryPoint: record.entryPoint,
        smartSessions: manifest.smartSessions.address,
        permissionId: record.session.permissionId,
        sessionKey: record.session.sessionKey,
      });
      validAfter = Math.max(validAfter, fresh.record.compiled.validAfter);
      validUntil = Math.min(validUntil, fresh.record.compiled.validUntil);
    } else if (passkeyProfile) {
      // The signature check and the signed estimate both need only the verified account, so they
      // run together. The bundler sees the signed bytes only after the account check passed. The
      // dummy margin covers ordinary calldata bytes, not Base L1 compression fees or every FCL
      // verification path: the exact signed operation is checked before claim. This is
      // point-in-time provider evidence; later fee changes remain possible.
      const admission = await Promise.allSettled([
        verifyPasskeyUserOperation({ operation, binding, manifest, chain: this.chain(signal),
          validAfter: String(validAfter), validUntil: String(validUntil),
          verifyContractSignature: createPasskeyContractSignatureVerifier({ state: binding.state, manifest,
            rpc: this.options.rpc, now: this.now, ...(signal ? { signal } : {}) }) }),
        provider.estimate(record.chainId, operation, signal).then((signedEstimate) => {
          for (const [field, amount] of Object.entries(signedEstimate))
            if (BigInt(amount) > BigInt(operation[field as keyof UserOperationV07] ?? "0x0"))
              fail("USER_OPERATION_SIGNED_GAS_CHANGED",
                "The exact signed operation requires more gas than was approved. Prepare and approve a fresh operation.");
        }),
      ]);
      for (const check of admission) if (check.status === "rejected") throw check.reason;
    } else {
      await verifySafe7579OwnerSignature({
        operation,
        chainId: record.chainId,
        entryPoint: record.entryPoint,
        safe7579: manifest.safe7579.address,
        validAfter: String(validAfter),
        validUntil: String(validUntil),
        owners: binding.state.owners,
        threshold: binding.state.threshold,
      });
    }
    if (record.session) {
      const fresh = await this.session(
        principal!,
        record.session.id,
        signal,
        preflight.evidence,
      );
      const { observationHash: _old, ...priorIdentity } = record.session;
      const { observationHash, ...freshIdentity } = fresh.binding;
      if (uoCanonical(priorIdentity) !== uoCanonical(freshIdentity))
        fail(
          "SESSION_GENERATION_CHANGED",
          "The session changed during canonical preflight.",
        );
      sessionObservationHash = observationHash;
    }
    const authorization = {
      issuedAt: Math.max(requestAuthority.issuedAt, validAfter),
      expiresAt: Math.min(requestAuthority.expiresAt, validUntil),
    };
    return this.options.store.claim({
      actor,
      id,
      key,
      operation,
      signedCommitment,
      authorization,
      ...(sessionObservationHash ? { sessionObservationHash } : {}),
      now: this.now(),
    });
  }

  async get(principal: RestPrincipal, id: string, signal?: AbortSignal) {
    if (!principal.scopes.includes("read"))
      fail(
        "USER_OPERATION_SCOPE_REQUIRED",
        "Reading operations requires read scope.",
        403,
      );
    const record =
      (await this.options.store.get(actorOf(principal), id)) ??
      fail("USER_OPERATION_NOT_FOUND", "The UserOperation was not found.", 404);
    appOperation(principal, record.chainId, record.session !== undefined);
    return this.view(
      record.submission ? await this.refresh(record, signal) : record,
    );
  }

  private execution(
    record: UserOperationRecord,
    operation: UserOperationV07,
    plan: StoredPlan,
    manifest: SmartAccountManifest,
  ): UserOperationExecutionBinding {
    return {
      chainId: record.chainId,
      entryPoint: manifest.entryPoint!,
      accountCode: {
        address: record.sender,
        runtimeCodeHash: manifest.proxyRuntimeCodeHash,
      },
      operation,
      operationHash: record.operationHash,
      calls: record.stepIndexes.map((index) => plan.draft.calls[index]!),
    };
  }

  private providerForRecord(record: UserOperationRecord) {
    if (this.options.provider.configuration(record.chainId).providerId === record.providerId) return this.options.provider;
    return this.options.sponsorRoutes?.stored(record.providerId) ?? fail('SPONSOR_ROUTE_UNAVAILABLE', 'The stored sponsorship route is unavailable.');
  }

  private async refresh(record: UserOperationRecord, signal?: AbortSignal) {
    // Expired was proven against the chain and released its nonce; it is never re-observed.
    if (!record.submission || record.state === "expired") return record;
    const plan = await this.plan(record.actor, record.planId, false);
    const manifest = this.options.manifestForPlan(plan);
    if (
      !manifest.entryPoint ||
      !same(manifest.entryPoint.address, record.entryPoint)
    )
      fail(
        "USER_OPERATION_STACK_CHANGED",
        "The stored operation's reviewed EntryPoint is unavailable.",
      );
    let transactionHash = record.observation?.transactionHash;
    // Preserve a previously verified execution while it remains canonical. A provider hint cannot replace it.
    let retain = false;
    if (
      record.observation?.state === "confirmed" &&
      record.observation.receipt?.canonical &&
      transactionHash
    ) {
      const block = (await this.chain(signal).request(
        record.chainId,
        "eth_getBlockByNumber",
        [toHex(BigInt(record.observation.receipt.blockNumber)), false],
      )) as { hash?: string };
      retain = same(block?.hash ?? "", record.observation.receipt.blockHash);
    }
    try {
      if (!retain)
        transactionHash =
          (
            await this.providerForRecord(record).receipt(
              record.chainId,
              record.operationHash,
              signal,
            )
          )?.transactionHash ?? transactionHash;
    } catch {
      /* A provider outage cannot replace independently observed chain evidence. */
    }
    const observation = await observeUserOperation({
      chain: this.chain(signal),
      binding: this.execution(
        record,
        record.submission.operation,
        plan,
        manifest,
      ),
      signedCommitment: record.submission.commitment,
      ...(transactionHash ? { transactionHash } : {}),
      // The signed validity ends with the preparation; past it the operation can only be redone.
      validUntil: Math.floor(record.expiresAt / 1000),
      confirmations: this.policy(record.chainId).confirmations,
      now: this.now(),
      verifyAccountAtBlock: async (_execution, evidence) => {
        await this.options.verifyHistoricalAccount(plan, evidence, signal);
      },
      verifySemantics: async (receipt: StoredReceipt) => {
        // A pay of the configured token through the configured terminal is the strict Base pay
        // domain: a rejected one cannot downgrade into weaker legacy single-step economic
        // evidence. Pays in other tokens or to other terminals keep the generic verification.
        if (this.options.v6UsdcPayment && record.chainId === this.options.v6UsdcPayment.chainId
          && walletV6UsdcPaymentDomain(plan, this.options.v6UsdcPayment)) {
          return verifyWalletV6UsdcPaymentEffects(plan, record.stepIndexes, this.options.v6UsdcPayment, receipt);
        }
        const results = await Promise.all(
          record.stepIndexes.map((index) =>
            this.options.semanticVerifier.verify(
              plan,
              index,
              receipt,
              this.options.rpc,
            ),
          ),
        );
        const status = results.some((r) => r.status === "failed")
          ? "failed"
          : results.some((r) => r.status === "unknown")
            ? "unknown"
            : results.every((r) => r.status === "unmodeled")
              ? "unmodeled"
              : results.length === 1
                ? "verified"
                : "unknown";
        return {
          status,
          details: {
            steps: results,
            ...(results.length > 1 && status === "unknown"
              ? {
                  reason:
                    "Atomic invocation is proved, but per-call economic results need independent event assignment. Use one operation per modeled journey step.",
                }
              : {}),
          },
        };
      },
    });
    return this.options.store.observe(record.id, record.revision, observation);
  }

  async observePlanStep(
    plan: StoredPlan,
    index: number,
    id: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ExternalExecutionObservation> {
    const record = await this.options.store.get(plan.actor, id);
    if (
      !record ||
      record.planId !== plan.id ||
      record.planCommitment !== plan.commitment ||
      !record.stepIndexes.includes(index)
    )
      fail(
        "USER_OPERATION_PLAN_MISMATCH",
        "The external execution does not bind this exact plan step.",
      );
    const updated = await this.refresh(record, options.signal);
    const observation = updated.observation;
    return {
      stepIndex: index,
      chainId: record.chainId,
      providerState: updated.state,
      state:
        observation?.state ??
        (updated.state === "submission_unknown" ? "unknown" : "pending"),
      ...(observation?.transactionHash
        ? { hash: observation.transactionHash }
        : {}),
      ...(observation?.receipt ? { receipt: observation.receipt } : {}),
      ...(observation?.semantic ? { semantic: observation.semantic } : {}),
      ...(observation?.reason ? { reason: observation.reason } : {}),
    };
  }

  async recoverPending(limit = 5) {
    const records = await this.options.store.recoverable(
      limit,
      this.recoveryCursor,
    );
    const results = [];
    let oldestPendingAt: number | null = null;
    for (const record of records) {
      let current = record;
      try {
        current = await this.refresh(record);
        results.push({
          id: record.id,
          state: current.state,
        });
      } catch {
        results.push({ id: record.id, state: "verification-unavailable" });
      }
      if (isRecoverable(current)) {
        oldestPendingAt = Math.min(oldestPendingAt ?? Infinity, current.submission!.startedAt);
      }
    }
    this.recoveryCursor =
      records.length === limit
        ? recoveryCursor(records[records.length - 1]!)
        : undefined;
    return { items: results, broadcastAttempted: false, oldestPendingAt };
  }

  private async view(record: UserOperationRecord) {
    const plan = await this.plan(record.actor, record.planId, false);
    const manifest = this.options.manifestForPlan(plan);
    const signing = record.session
      ? legacySessionSigningPayload({
          operation: record.operation,
          chainId: record.chainId,
          entryPoint: record.entryPoint,
          smartSessions: manifest.smartSessions.address,
          permissionId: record.session.permissionId,
        })
      : manifest.ownerProfile?.version === "center-passkey-v1"
      ? { ...safe7579PasskeyOwnerSigningPayload({
          operation: record.operation,
          chainId: record.chainId,
          entryPoint: record.entryPoint,
          safe7579: manifest.safe7579.address,
          validAfter: String(Math.floor(record.createdAt / 1000)),
          validUntil: String(Math.floor(record.expiresAt / 1000)),
        }), ownerProfile: manifest.ownerProfile.version }
      : safe7579OwnerSigningPayload({
          operation: record.operation,
          chainId: record.chainId,
          entryPoint: record.entryPoint,
          safe7579: manifest.safe7579.address,
          validAfter: String(Math.floor(record.createdAt / 1000)),
          validUntil: String(Math.floor(record.expiresAt / 1000)),
        });
    return {
      id: record.id,
      planId: record.planId,
      planCommitment: record.planCommitment,
      stepIndexes: record.stepIndexes,
      chainId: record.chainId,
      entryPoint: record.entryPoint,
      operation: { ...record.operation, signature: "0x" },
      operationHash: record.operationHash,
      commitment: record.commitment,
      accountBindingId: record.accountBindingId,
      accountStateHash: record.accountStateHash,
      ...(record.session ? { session: record.session } : {}),
      gasPolicyId: record.gasPolicyId,
      providerId: record.providerId,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      revision: record.revision,
      state: record.state,
      signing,
      ...(record.submission
        ? {
            submission: {
              commitment: record.submission.commitment,
              startedAt: record.submission.startedAt,
            },
          }
        : {}),
      ...(record.observation ? { observation: record.observation } : {}),
    };
  }
}
