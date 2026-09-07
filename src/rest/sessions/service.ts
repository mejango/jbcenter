import {
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  toHex,
  type Hex,
} from "viem";
import type { RestPrincipal } from "../auth/store.js";
import {
  RestError,
  type RestActor,
  type RestBlockEvidence,
  type RestRpc,
} from "../core.js";
import { exactObject } from "../protocol/abi.js";
import { rpcHex } from "../protocol/code.js";
import type { createSessionPolicyReviewer } from "../smartAccounts/policy.js";
import { fingerprint } from "../smartAccounts/service.js";
import {
  encodeOwnerSessionRevocation,
  encodeOwnerSessionSetup,
} from "../smartAccounts/setup.js";
import type {
  CompiledSession,
  InstalledSessionObservation,
} from "../smartAccounts/compiler/types.js";
import type {
  SessionPolicyInput,
  SmartAccountBinding,
  SmartSnapshot,
} from "../smartAccounts/types.js";
import type { TransactionService } from "../transactions/service.js";
import type { StoredPlan } from "../transactions/types.js";
import {
  createSessionRecord,
  createSessionObservation,
  type SessionStore,
} from "./store.js";
import type {
  SessionOwnerApproval,
  StoredSession,
  UserOperationSessionBinding,
} from "./types.js";

type Reviewer = ReturnType<typeof createSessionPolicyReviewer>;
type Review = Awaited<ReturnType<Reviewer["review"]>>;
export interface SessionCompiler {
  compile(input: {
    review: Review;
    activationEnableNonce: string;
  }): CompiledSession;
}
export interface SessionInstalledVerifier {
  verify(
    compiled: CompiledSession,
    signal?: AbortSignal,
  ): Promise<InstalledSessionObservation>;
  verifyRevoked(
    compiled: CompiledSession,
    minimumEnableNonce: string,
    signal?: AbortSignal,
  ): Promise<InstalledSessionObservation>;
  verifyAt(
    compiled: CompiledSession,
    snapshot: SmartSnapshot,
  ): Promise<InstalledSessionObservation>;
}
export interface SessionServiceDependencies {
  store: SessionStore;
  rpc: RestRpc;
  reviewer: Reviewer;
  compilerFor(binding: SmartAccountBinding): SessionCompiler;
  verifier: SessionInstalledVerifier;
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
  transactions: TransactionService;
  authorizeOwnerPlan(
    actor: RestActor,
    id: string,
    kind: "activation" | "revocation",
    compiledHash: Hex,
  ): Promise<{ digest: Hex; issuedAt: number; expiresAt: number }>;
  now?: () => number;
  configuredChainIds?: readonly number[];
}
const abi = parseAbi([
  "function getNonce(bytes32 permissionId,address account) view returns (uint256)",
  "function getPermissionIDs(address account) view returns (bytes32[])",
  "function isPermissionEnabled(bytes32 permissionId,address account) view returns (bool)",
]);
const actorOf = (p: RestPrincipal): RestActor => ({
  accountId: p.account.id,
  principalId: p.principalId,
});
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function owner(p: RestPrincipal): void {
  if (
    !p.isOwner ||
    p.grantId !== null ||
    p.principalId !== `owner:${p.account.id}`
  )
    throw new RestError(
      403,
      "SESSION_OWNER_REQUIRED",
      "Only the API owner can approve session installation or revocation plans.",
    );
}
function scope(p: RestPrincipal, required: "read" | "plan" | "relay"): void {
  if (!p.scopes.includes(required))
    throw new RestError(
      403,
      "SESSION_SCOPE_REQUIRED",
      `This operation requires ${required} scope.`,
    );
}
function identity(principal: RestPrincipal, record: StoredSession): void {
  if (
    record.actor.accountId !== principal.account.id ||
    (!principal.isOwner && record.compiled.grantId !== principal.grantId)
  )
    throw new RestError(
      404,
      "SESSION_NOT_FOUND",
      "The session was not found for this principal.",
    );
}
function administration(
  binding: SmartAccountBinding,
): NonNullable<InstalledSessionObservation["administration"]> {
  const details = binding.state.modules?.details as {
    sessionAdministration?: InstalledSessionObservation["administration"];
  } | null;
  const value = details?.sessionAdministration;
  if (
    !value ||
    !/^(0|[1-9][0-9]{0,77})$/.test(value.epoch) ||
    !/^0x[0-9a-fA-F]{64}$/.test(value.hash)
  )
    throw new RestError(
      409,
      "SESSION_ADMINISTRATION_UNVERIFIED",
      "Complete canonical session administration history is required.",
    );
  return structuredClone(value);
}

/** Durable lifecycle. Chain policies enforce authority, while this store prevents accidental renewal/reset. */
export class SessionService {
  private readonly now: () => number;
  constructor(private readonly options: SessionServiceDependencies) {
    this.now = options.now ?? Date.now;
  }
  capabilities() {
    const configuredChainIds = [...(this.options.configuredChainIds ?? [])];
    return {
      durationsDays: [7, 30],
      availableActions: ["v6-project-uri", "v6-pay", "erc20-transfer"],
      configuredChainIds,
      requiresVerifiedGuardDeployment: true,
      activationReady: configuredChainIds.length > 0,
    };
  }

  private async required(principal: RestPrincipal, id: string) {
    const record = await this.options.store.get(actorOf(principal), id);
    if (!record)
      throw new RestError(
        404,
        "SESSION_NOT_FOUND",
        "The session was not found for this principal.",
      );
    identity(principal, record);
    return record;
  }

  async prepare(
    principal: RestPrincipal,
    input: SessionPolicyInput,
    key: string,
    requestHash: string,
    signal?: AbortSignal,
  ) {
    scope(principal, "plan");
    const idem = { key, requestHash };
    const existing = await this.options.store.find(actorOf(principal), idem);
    if (existing) return existing;
    const review = await this.options.reviewer.review(principal, input, signal);
    const binding = await this.options.currentBinding(
      principal.account.id,
      input.bindingId,
      signal,
    );
    if (
      binding.state.stateHash !== review.walletStateHash ||
      !binding.state.moduleConfigurationVerified
    )
      throw new RestError(
        409,
        "SESSION_ACCOUNT_UNVERIFIED",
        "Session preparation requires the unchanged, completely inspected smart account.",
      );
    const compiler = this.options.compilerFor(binding);
    // Permission identity does not include enableNonce, so derive it once and then pin the actual chain nonce.
    const preliminary = compiler.compile({
      review,
      activationEnableNonce: "0",
    });
    const value = await this.read(
      binding,
      preliminary,
      "getNonce",
      [preliminary.permissionId, preliminary.wallet],
      signal,
    );
    if (typeof value !== "bigint")
      throw new RestError(
        502,
        "SESSION_RPC_INVALID",
        "The session enable nonce is unavailable.",
      );
    const compiled = compiler.compile({
      review,
      activationEnableNonce: value.toString(),
    });
    const now = this.now();
    const baseline = administration(binding);
    return this.options.store.create(
      createSessionRecord({
        actor: actorOf(principal),
        compiled,
        preparedAdministration: { epoch: baseline.epoch, hash: baseline.hash },
        now,
      }),
      idem,
      now,
    );
  }

  async list(
    principal: RestPrincipal,
    options: { limit: number; cursor?: string },
  ) {
    scope(principal, "read");
    return this.options.store.list(actorOf(principal), options);
  }

  async get(
    principal: RestPrincipal,
    id: string,
    refresh = true,
    signal?: AbortSignal,
  ) {
    scope(principal, "read");
    const record = await this.required(principal, id);
    return refresh && record.activation
      ? this.refresh(principal, record, signal)
      : record;
  }

  async quota(principal: RestPrincipal, id: string, signal?: AbortSignal) {
    await this.get(principal, id, true, signal);
    return this.options.store.quota(actorOf(principal), id);
  }

  /** Rejected or superseded setup plans never become executable through the generic owner transport. */
  async assertOwnerPlan(principal: RestPrincipal, plan: StoredPlan) {
    const kind =
      plan.draft.operation === "activate_smart_account_session"
        ? "activation"
        : plan.draft.operation === "revoke_smart_account_session"
          ? "revocation"
          : undefined;
    if (!kind) return;
    owner(principal);
    const summary = plan.draft.summary as {
      sessionId?: string;
      compiledHash?: Hex;
    } | null;
    if (!summary?.sessionId)
      throw new RestError(
        409,
        "SESSION_PLAN_NOT_ADMITTED",
        "Session setup requires its durable owner approval.",
      );
    const record = await this.required(principal, summary.sessionId);
    const approval =
      kind === "activation" ? record.activation : record.revocation;
    if (
      !approval ||
      approval.planId !== plan.id ||
      approval.planCommitment !== plan.commitment ||
      approval.compiledHash !== summary.compiledHash ||
      record.state !== (kind === "activation" ? "installing" : "revoking")
    )
      throw new RestError(
        409,
        "SESSION_PLAN_NOT_ADMITTED",
        "The exact session setup plan is not the currently admitted owner action.",
      );
  }

  async prepareOwnerPlan(
    principal: RestPrincipal,
    id: string,
    kind: "activation" | "revocation",
    input: { compiledHash: Hex },
    key: string,
    requestHash: string,
    signal?: AbortSignal,
  ) {
    owner(principal);
    exactObject(input, ["compiledHash"], "session plan");
    const record = await this.required(principal, id);
    if (input.compiledHash !== record.compiled.compiledHash)
      throw new RestError(
        409,
        "SESSION_REVIEW_CHANGED",
        "Approve the exact immutable compiled policy returned by session preparation.",
      );
    const actor = actorOf(principal);
    const previousPlan = await this.options.transactions.findPlanByIdempotency(
      actor,
      key,
      requestHash,
    );
    const previousClaim =
      kind === "activation" ? record.activation : record.revocation;
    if (
      previousPlan &&
      previousClaim?.planId === previousPlan.id &&
      previousClaim.compiledHash === input.compiledHash
    )
      return {
        session: record,
        plan: previousPlan,
        installationConfirmed: record.state === "active",
      };
    if (
      previousPlan &&
      (previousPlan.draft.operation !==
        (kind === "activation"
          ? "activate_smart_account_session"
          : "revoke_smart_account_session") ||
        (previousPlan.draft.summary as { sessionId?: string } | null)
          ?.sessionId !== id)
    )
      throw new RestError(
        409,
        "SESSION_PLAN_CONFLICT",
        "The idempotency key belongs to a different session lifecycle action.",
      );
    const consent = await this.options.authorizeOwnerPlan(
      actor,
      id,
      kind,
      input.compiledHash,
    );
    const binding = await this.options.currentBinding(
      principal.account.id,
      record.compiled.bindingId,
      signal,
    );
    let setup:
      | ReturnType<typeof encodeOwnerSessionSetup>
      | ReturnType<typeof encodeOwnerSessionRevocation>;
    if (kind === "activation") {
      const permissions = await this.read(
        binding,
        record.compiled,
        "getPermissionIDs",
        [record.compiled.wallet],
        signal,
      );
      if (!Array.isArray(permissions) || permissions.length !== 0)
        throw new RestError(
          409,
          "SESSION_RETIREMENT_REQUIRED",
          "Revoke the existing onchain session and invalidate its enable signature before activating a replacement.",
        );
      const nonce = await this.read(
        binding,
        record.compiled,
        "getNonce",
        [record.compiled.permissionId, record.compiled.wallet],
        signal,
      );
      if (String(nonce) !== record.compiled.activationEnableNonce)
        throw new RestError(
          409,
          "SESSION_ENABLE_NONCE_CHANGED",
          "The enable nonce changed. Prepare a fresh immutable session generation.",
        );
      // Empty validator installation is part of the reviewed wallet creation/binding, never an implicit mutation here.
      setup = encodeOwnerSessionSetup({
        compiled: record.compiled,
        moduleInstalled: true,
        enabledPermissionIds: [],
      });
    } else {
      const nonce = await this.read(
        binding,
        record.compiled,
        "getNonce",
        [record.compiled.permissionId, record.compiled.wallet],
        signal,
      );
      if (typeof nonce !== "bigint")
        throw new RestError(
          502,
          "SESSION_RPC_INVALID",
          "The current enable nonce is unavailable.",
        );
      setup = encodeOwnerSessionRevocation({
        compiled: record.compiled,
        currentEnableNonce: nonce.toString(),
      });
    }
    const plan = await this.options.transactions.createSmartAccountPlan(
      actor,
      binding.id,
      {
        operation:
          kind === "activation"
            ? "activate_smart_account_session"
            : "revoke_smart_account_session",
        account: record.compiled.wallet,
        calls: setup.calls.map((call, index) => ({
          chainId: record.compiled.chainId,
          to: call.target,
          data: call.callData,
          value: call.value,
          label: `${kind} session`,
          dependsOn: index ? [index - 1] : [],
          decoded: {
            operation: setup.operation,
            compiledHash: record.compiled.compiledHash,
          },
        })),
        evidence: [binding.state.evidence],
        summary: {
          sessionId: id,
          compiledHash: record.compiled.compiledHash,
          setup,
        },
        warnings: [
          "Preparing this plan does not install or revoke the onchain permission. Sign and submit the exact Safe owner UserOperation, then verify the installed state.",
        ],
      },
      key,
      requestHash,
    );
    const approval: SessionOwnerApproval = {
      kind,
      accountId: principal.account.id,
      sessionId: id,
      policyHash: record.compiled.policyHash,
      compiledHash: record.compiled.compiledHash,
      planId: plan.id,
      planCommitment: plan.commitment,
      ...consent,
    };
    const claim = {
      actor,
      id,
      expectedRevision: record.revision,
      approval,
      idempotency: { key, requestHash },
      now: this.now(),
    };
    const admitted =
      kind === "activation"
        ? await this.options.store.claimActivation(claim)
        : await this.options.store.claimRevocation(claim);
    return { session: admitted.record, plan, installationConfirmed: false };
  }

  /** Returns current chain authority only for this exact bot key and generation. */
  async executionBinding(
    principal: RestPrincipal,
    id: string,
    signal?: AbortSignal,
    evidence?: RestBlockEvidence,
  ): Promise<{ record: StoredSession; binding: UserOperationSessionBinding }> {
    scope(principal, "relay");
    if (principal.isOwner || !principal.grantId)
      throw new RestError(
        403,
        "SESSION_BOT_REQUIRED",
        "Session execution requires its bound bot request signature.",
      );
    let record = await this.get(principal, id, !evidence, signal);
    if (evidence) {
      if (evidence.chainId !== record.compiled.chainId)
        throw new RestError(
          409,
          "SESSION_CHAIN_MISMATCH",
          "Session execution evidence belongs to another chain.",
        );
      const tag = {
        blockHash: evidence.blockHash,
        requireCanonical: true as const,
      };
      const account = await this.options.currentBindingAt(
        principal.account.id,
        record.compiled.bindingId,
        evidence,
        signal,
      );
      const installed = await this.options.verifier.verifyAt(record.compiled, {
        evidence,
        tag,
        request: (method, params) =>
          this.options.rpc.request(
            evidence.chainId,
            method,
            [...params, tag],
            signal,
          ),
      });
      installed.administration = administration(account);
      const now = this.now();
      record = (
        await this.options.store.observe({
          actor: actorOf(principal),
          id,
          expectedRevision: record.revision,
          expectedObservationHash: record.observation?.proofHash ?? null,
          observation: createSessionObservation(installed, now),
          now,
        })
      ).record;
      if (
        record.observation?.installed.evidence.blockHash !== evidence.blockHash
      )
        throw new RestError(
          409,
          "SESSION_OBSERVATION_CHANGED",
          "Concurrent session verification advanced the observed state. Retry with fresh execution evidence.",
        );
    }
    if (
      record.state !== "active" ||
      !record.observation ||
      record.compiled.grantId !== principal.grantId ||
      !same(record.compiled.sessionKey, principal.signer)
    )
      throw new RestError(
        409,
        "SESSION_NOT_ACTIVE",
        "The exact bot session is not currently verified and active.",
      );
    const c = record.compiled;
    return {
      record,
      binding: {
        id: record.id,
        policyHash: c.policyHash,
        compiledHash: c.compiledHash,
        generation: c.generation,
        grantId: c.grantId,
        permissionId: c.permissionId,
        sessionKey: c.sessionKey,
        observationHash: record.observation.proofHash,
      },
    };
  }

  private async refresh(
    principal: RestPrincipal,
    record: StoredSession,
    signal?: AbortSignal,
  ) {
    try {
      let installed: InstalledSessionObservation;
      try {
        const account = await this.options.currentBinding(
          principal.account.id,
          record.compiled.bindingId,
          signal,
        );
        const evidence = account.state.evidence;
        const tag = {
          blockHash: evidence.blockHash,
          requireCanonical: true as const,
        };
        installed =
          (await this.observeAbsent(account, record.compiled, signal)) ??
          (await this.options.verifier.verifyAt(record.compiled, {
            evidence,
            tag,
            request: (method, params) =>
              this.options.rpc.request(
                evidence.chainId,
                method,
                [...params, tag],
                signal,
              ),
          }));
        installed.administration = administration(account);
      } catch (error) {
        if (!record.revocation) throw error;
        installed = await this.options.verifier.verifyRevoked(
          record.compiled,
          (BigInt(record.compiled.activationEnableNonce) + 1n).toString(),
          signal,
        );
      }
      const finalized = await this.isFinalized(installed, signal);
      const observedAt = this.now();
      const observation = createSessionObservation(
        installed,
        observedAt,
        finalized,
      );
      return (
        await this.options.store.observe({
          actor: actorOf(principal),
          id: record.id,
          expectedRevision: record.revision,
          expectedObservationHash: record.observation?.proofHash ?? null,
          observation,
          now: observedAt,
        })
      ).record;
    } catch (error) {
      await this.options.store.markStale({
        actor: actorOf(principal),
        id: record.id,
        expectedRevision: record.revision,
        reason:
          error instanceof RestError &&
          ["SESSION_OBSERVATION_STALE", "SMART_EVIDENCE_REORGED"].includes(
            error.code,
          )
            ? "reorg"
            : "verification-unavailable",
        now: this.now(),
      });
      throw error;
    }
  }

  /** Absence is a lifecycle observation, never a synthetic installed policy or spendable quota. */
  private async observeAbsent(
    binding: SmartAccountBinding,
    compiled: CompiledSession,
    signal?: AbortSignal,
  ): Promise<InstalledSessionObservation | undefined> {
    // currentBinding has inspected this exact account/module runtime and administration at this block.
    const ids = await this.read(
      binding,
      compiled,
      "getPermissionIDs",
      [compiled.wallet],
      signal,
    );
    if (
      !Array.isArray(ids) ||
      ids.length > 1 ||
      ids.some(
        (id) => typeof id !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(id),
      )
    )
      throw new RestError(
        409,
        "SESSION_PERMISSION_LAYOUT_CHANGED",
        "The verified single-session permission layout changed.",
      );
    if (ids.some((id) => same(id, compiled.permissionId))) return undefined;
    const [enabled, nonce] = await Promise.all([
      this.read(
        binding,
        compiled,
        "isPermissionEnabled",
        [compiled.permissionId, compiled.wallet],
        signal,
      ),
      this.read(
        binding,
        compiled,
        "getNonce",
        [compiled.permissionId, compiled.wallet],
        signal,
      ),
    ]);
    if (
      enabled !== false ||
      typeof nonce !== "bigint" ||
      nonce < BigInt(compiled.activationEnableNonce)
    )
      throw new RestError(
        409,
        "SESSION_ABSENCE_UNVERIFIED",
        "Disabled permission and a non-regressing enable nonce must agree at the verified block.",
      );
    return {
      permissionId: compiled.permissionId,
      compiledHash: compiled.compiledHash,
      account: compiled.wallet,
      chainId: compiled.chainId,
      enabled: false,
      enableNonce: nonce.toString(),
      configurationHash: fingerprint({
        permissionAbsent: true,
        permissionId: compiled.permissionId,
        account: compiled.wallet,
        chainId: compiled.chainId,
        enableNonce: nonce.toString(),
      }),
      evidence: structuredClone(binding.state.evidence),
      counters: [],
    };
  }

  private async isFinalized(
    installed: InstalledSessionObservation,
    signal?: AbortSignal,
  ) {
    try {
      const finalized = (await this.options.rpc.request(
        installed.chainId,
        "eth_getBlockByNumber",
        ["finalized", false],
        signal,
      )) as { number?: string; hash?: string };
      if (
        !finalized ||
        !/^0x[0-9a-fA-F]+$/.test(finalized.number ?? "") ||
        BigInt(finalized.number!) < BigInt(installed.evidence.blockNumber)
      )
        return false;
      const canonical = (await this.options.rpc.request(
        installed.chainId,
        "eth_getBlockByNumber",
        [toHex(BigInt(installed.evidence.blockNumber)), false],
        signal,
      )) as { hash?: string };
      return same(canonical?.hash ?? "", installed.evidence.blockHash);
    } catch {
      return false;
    }
  }

  private async read(
    binding: SmartAccountBinding,
    compiled: CompiledSession,
    functionName: "getNonce" | "getPermissionIDs" | "isPermissionEnabled",
    args: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<unknown> {
    const data = encodeFunctionData({ abi, functionName, args } as Parameters<
      typeof encodeFunctionData
    >[0]);
    const result = rpcHex(
      await this.options.rpc.request(
        binding.wallet.chainId,
        "eth_call",
        [
          { to: compiled.smartSessions.address, data, gas: "0xf4240" },
          {
            blockHash: binding.state.evidence.blockHash,
            requireCanonical: true,
          },
        ],
        signal,
      ),
      "session state",
    );
    return decodeFunctionResult({ abi, functionName, data: result });
  }
}
