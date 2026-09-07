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
import { UserOperationProvider } from "./provider.js";
import { createSessionGasEstimation } from "./estimation.js";
import {
  digest,
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
  now?: () => number;
}
export interface UserOperationPreparationInput {
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
  private async account(plan: StoredPlan, signal?: AbortSignal) {
    const approved = plan.smartAccount!;
    const binding = await this.options.currentBinding(
      plan.actor.accountId,
      approved.bindingId,
      signal,
    );
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
      ["planId", "stepIndexes", "sessionId"],
      "user operation",
    );
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
    if (existing) return this.view(existing);
    const plan = await this.plan(actor, input.planId, true);
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
    const policy = this.policy(binding.wallet.chainId);
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
    await this.options.provider.readiness(binding.wallet.chainId, signal);
    const nonceKey = session
      ? BigInt(safe7579NonceKey(manifest.smartSessions.address))
      : 0n;
    const { nonce, evidence } = await chain.nonce(
      binding.wallet.chainId,
      binding.wallet.address,
      nonceKey,
      manifest.entryPoint!,
    );
    const block = (await chain.request(
      binding.wallet.chainId,
      "eth_getBlockByNumber",
      [toHex(BigInt(evidence.blockNumber)), false],
    )) as Record<string, unknown>;
    const priority = uoQuantity(
      await chain.request(
        binding.wallet.chainId,
        "eth_maxPriorityFeePerGas",
        [],
      ),
      "priority fee",
    );
    const fee = uoQuantity(block.baseFeePerGas, "base fee") * 2n + priority;
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
    const dummy = () =>
      session
        ? encodeLegacyUseSignature(session.permissionId, dummySignature)
        : encodeSafe7579OwnerSignature({
            validAfter: String(Math.floor(createdAt / 1000)),
            validUntil: String(Math.floor(expiresAt / 1000)),
            signatures: `0x${dummySignature.slice(2).repeat(binding.state.threshold)}`,
          });
    const providerConfig = this.options.provider.configuration(
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
      ? await this.options.provider.stub(
          binding.wallet.chainId,
          operation,
          signal,
        )
      : undefined;
    if (stub) operation = stub.operation;
    if (gasEstimation && !stub?.isFinal)
      operation = gasEstimation.fit(operation);
    gasEstimation?.assert(operation);
    const estimate = await this.options.provider.estimate(
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
      const funded = await this.options.provider.sponsor(
        binding.wallet.chainId,
        operation,
        signal,
      );
      operation = funded.operation;
      expiresAt = Math.min(expiresAt, funded.proof.validUntil * 1000);
      // Final sponsorship may alter validation cost. Never sign fields that have not been estimated together.
      const finalEstimate = await this.options.provider.estimate(
        binding.wallet.chainId,
        { ...operation, signature: dummy() },
        signal,
        gasEstimation,
      );
      for (const [field, amount] of Object.entries(finalEstimate))
        if (
          BigInt(amount) >
          BigInt(operation[field as keyof UserOperationV07] ?? "0x0")
        )
          fail(
            "USER_OPERATION_SPONSOR_GAS_CHANGED",
            "Final sponsorship requires more gas than the reviewed operation. Prepare again with the provider's current estimate.",
          );
    }
    assertUserOperationGasPolicy(operation, policy.gas);
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
    const operation = normalizeUserOperation({
      ...record.operation,
      signature,
    });
    const signedCommitment = userOperationCommitment(
      operation,
      record.entryPoint,
      record.chainId,
    );
    if (record.submission) {
      if (
        record.submission.key !== key ||
        record.submission.commitment !== signedCommitment
      )
        fail(
          "USER_OPERATION_CONFLICT",
          "A different signed operation or publication key is already reserved.",
        );
      return this.view(await this.refresh(record, signal));
    }
    const requestAuthority = await this.options.authorizeRequest(
      actor,
      id,
      signature,
    );
    const plan = await this.plan(actor, record.planId, true);
    await this.options.sessions?.assertOwnerPlan(principal, plan);
    const { binding, manifest } = await this.account(plan, signal);
    const policy = this.policy(record.chainId);
    if (
      record.expiresAt <= this.now() ||
      record.gasPolicyId !== policy.gas.id ||
      this.options.provider.configuration(record.chainId).providerId !==
        record.providerId
    )
      fail(
        "USER_OPERATION_PREPARATION_EXPIRED",
        "The operation expired or its provider policy changed.",
      );
    let sessionObservationHash: Hex | undefined;
    let validAfter = Math.floor(record.createdAt / 1000),
      validUntil = Math.floor(record.expiresAt / 1000);
    if (record.session) {
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
    const execution = this.execution(record, operation, plan, manifest);
    const preflight = await this.chain(signal).preflight(
      execution,
      policy.gas,
      this.options.provider,
    );
    await this.options.currentBindingAt(
      actor.accountId,
      record.accountBindingId,
      preflight.evidence,
      signal,
    );
    if (record.session) {
      const fresh = await this.session(
        principal,
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
    const claim = await this.options.store.claim({
      actor,
      id,
      key,
      operation,
      signedCommitment,
      authorization,
      ...(sessionObservationHash ? { sessionObservationHash } : {}),
      now: this.now(),
    });
    if (!claim.dispatch)
      return this.view(await this.refresh(claim.record, signal));
    // Admission permanently reserves both plan transport and nonce before the only publication attempt.
    let state: "pending" | "submission_unknown" = "pending";
    try {
      await this.options.provider.send(record.chainId, operation, signal);
    } catch {
      state = "submission_unknown";
    }
    const submitted = await this.options.store.settle(
      id,
      signedCommitment,
      state,
    );
    return this.view(submitted);
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

  private async refresh(record: UserOperationRecord, signal?: AbortSignal) {
    if (!record.submission) return record;
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
            await this.options.provider.receipt(
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
      confirmations: this.policy(record.chainId).confirmations,
      now: this.now(),
      verifyAccountAtBlock: async (_execution, evidence) => {
        await this.options.verifyHistoricalAccount(plan, evidence, signal);
      },
      verifySemantics: async (receipt: StoredReceipt) => {
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
    for (const record of records) {
      try {
        results.push({
          id: record.id,
          state: (await this.refresh(record)).state,
        });
      } catch {
        results.push({ id: record.id, state: "verification-unavailable" });
      }
    }
    this.recoveryCursor =
      records.length === limit
        ? recoveryCursor(records[records.length - 1]!)
        : undefined;
    return { items: results, broadcastAttempted: false };
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
