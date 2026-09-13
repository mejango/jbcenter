import { randomUUID } from "node:crypto";
import { isAddress, keccak256, type Address, type Hex } from "viem";
import type { ContractCatalog } from "../contracts/catalog.js";
import {
  RestError,
  type RestActor,
  type RestPlanDraft,
  type RestRpc,
} from "../core.js";
import type { TransactionStore } from "../transactions/store.js";
import type { SemanticVerifier, StoredPlan } from "../transactions/types.js";
import { SponsorshipChain } from "./chain.js";
import {
  DEFAULT_SPONSORSHIP_POLICY,
  FORWARD_REQUEST_TYPES,
  RELAYR_LIMITS,
  RELAYR_MAINNET_CHAINS,
  RELAYR_PAYMENT_GAS,
} from "./constants.js";
import { observeDestination } from "./execution.js";
import {
  assertPaymentEligible,
  parseQuoteBinding,
  parseStatus,
  RelayrProvider,
} from "./provider.js";
import {
  assertDispatchAuthorization,
  conflict,
  missing,
  type SponsorshipStore,
} from "./store.js";
import type {
  DestinationObservation,
  RelayrEntry,
  SponsorshipPolicy,
  SponsorshipPrepareInput,
  SponsorshipRecord,
  SponsorshipSubmission,
} from "./types.js";
import {
  assertKey,
  assertSignal,
  clone,
  digest,
  fail,
  hash,
  hex,
  object,
  quantity,
  same,
} from "./validation.js";

export interface RelayrSponsorshipOptions {
  rpc: RestRpc;
  catalog: ContractCatalog;
  store: SponsorshipStore;
  transactionStore: TransactionStore;
  semanticVerifier?: SemanticVerifier;
  /** The host verifies a fresh owner approval bound to this exact publication. */
  authorizeDispatch?: (
    record: SponsorshipRecord,
    submissionHash: Hex,
  ) => Promise<{ issuedAt: number; expiresAt: number }>;
  policy?: Partial<SponsorshipPolicy>;
  fetch?: typeof fetch;
  now?: () => number;
}
type RequestOptions = { signal?: AbortSignal };

/** Noncustodial: prepares commitments and publishes externally signed exact calls; never signs or funds. */
export class RelayrSponsorshipService {
  readonly policy: SponsorshipPolicy;
  private readonly provider: RelayrProvider;
  private readonly now: () => number;
  constructor(private readonly options: RelayrSponsorshipOptions) {
    this.now = options.now ?? Date.now;
    const policy = { ...DEFAULT_SPONSORSHIP_POLICY, ...options.policy };
    if (
      typeof policy.enabled !== "boolean" ||
      !Array.isArray(policy.allowedChainIds) ||
      policy.allowedChainIds.length < 1 ||
      new Set(policy.allowedChainIds).size !== policy.allowedChainIds.length ||
      policy.allowedChainIds.some(
        (chain) => !RELAYR_MAINNET_CHAINS.some((id) => id === chain),
      ) ||
      !Number.isInteger(policy.requestTtlSeconds) ||
      policy.requestTtlSeconds < 120 ||
      policy.requestTtlSeconds > 47 * 3600 ||
      !Number.isInteger(policy.minimumRemainingSeconds) ||
      policy.minimumRemainingSeconds < 30 ||
      policy.minimumRemainingSeconds >= policy.requestTtlSeconds ||
      typeof policy.maximumGas !== "bigint" ||
      policy.maximumGas < 21_000n ||
      policy.maximumGas > 20_000_000n ||
      typeof policy.maximumFundingValue !== "bigint" ||
      policy.maximumFundingValue <= 0n ||
      policy.maximumFundingValue > 1000n * 10n ** 18n ||
      !Number.isInteger(policy.confirmations) ||
      policy.confirmations < 1 ||
      policy.confirmations > 1024 ||
      !Number.isInteger(policy.rpcTimeoutMs) ||
      policy.rpcTimeoutMs < 1 ||
      policy.rpcTimeoutMs > 10_000
    )
      fail(
        "INVALID_SPONSORSHIP_POLICY",
        "Sponsorship policy has inconsistent chain, expiry or cost bounds.",
        500,
      );
    this.policy = Object.freeze({
      ...policy,
      allowedChainIds: Object.freeze([...policy.allowedChainIds]),
    });
    this.provider = new RelayrProvider(
      options.fetch ?? fetch,
      policy.providerTimeoutMs,
    );
  }
  capabilities() {
    return {
      kind: "relayr-prepaid-erc2771",
      state: this.policy.enabled ? "configured" : "requires_configuration",
      chains: RELAYR_MAINNET_CHAINS.map((chainId) => ({
        chainId,
        state:
          this.policy.enabled && this.policy.allowedChainIds.includes(chainId)
            ? "configured"
            : "unavailable",
        runtimeVerifiedDuringPreparation: true,
      })),
      funding: {
        required: true,
        externalPayerAllowed: true,
        serverSignsOrFunds: false,
        currency: "native",
        maximumValue: this.policy.maximumFundingValue.toString(),
      },
      signing: {
        eachCallRequiresOwnerSignature: true,
        freshPublicationApprovalRequired: Boolean(
          this.options.authorizeDispatch,
        ),
        sessionAuthority: false,
        maximumForwardRequestValiditySeconds: this.policy.requestTtlSeconds,
        sourcePlanExpiryOnlyLimitsPublication: true,
      },
      limits: {
        maximumIndependentCalls: RELAYR_LIMITS.maximumCalls,
        maximumCallsPerChain: RELAYR_LIMITS.maximumCalls,
      },
      unsupported: [
        "erc4337-paymaster",
        "safe-module-execution",
        "erc1271-forwarding",
        "erc6492-forwarding",
        "onchain-session-keys",
        "prepaid-wallet-spending-budget",
      ],
      atomicAcrossChains: false,
    };
  }
  private enabled() {
    if (!this.policy.enabled)
      fail(
        "SPONSORSHIP_NOT_CONFIGURED",
        "The host has not enabled prepaid execution.",
        503,
      );
  }
  private chain(signal?: AbortSignal) {
    return new SponsorshipChain(
      this.options.rpc,
      this.policy,
      signal,
      this.now,
    );
  }
  private bounded(request: RequestOptions): RequestOptions {
    const deadline = AbortSignal.timeout(60_000);
    return {
      signal: request.signal
        ? AbortSignal.any([request.signal, deadline])
        : deadline,
    };
  }
  private async plan(actor: RestActor, id: string): Promise<StoredPlan> {
    const plan = await this.options.transactionStore.get(actor, id);
    if (!plan)
      fail("PLAN_NOT_FOUND", "The source transaction plan was not found.", 404);
    return plan;
  }
  private async required(
    actor: RestActor,
    id: string,
  ): Promise<SponsorshipRecord> {
    return (await this.options.store.get(actor, id)) ?? missing();
  }
  private mutable(plan: StoredPlan, actor: RestActor) {
    if (
      plan.actor.accountId !== actor.accountId ||
      plan.actor.principalId !== actor.principalId
    )
      fail(
        "SPONSORSHIP_PRINCIPAL_MISMATCH",
        "A new authorization must use the principal that created its source plan.",
        403,
      );
    if (plan.expiresAt <= this.now())
      fail(
        "PLAN_EXPIRED",
        "The source plan expired before authorization publication.",
        409,
      );
    const address = actor.accountId.split(":");
    if (
      address.length !== 3 ||
      address[0] !== "eip155" ||
      !isAddress(address[2]!) ||
      !same(address[2]!, plan.draft.account)
    )
      fail(
        "PLAN_ACCOUNT_MISMATCH",
        "The plan account differs from the authenticated wallet.",
        403,
      );
  }
  private async dependencies(
    plan: StoredPlan,
    stepIndexes: number[],
    chain: SponsorshipChain,
  ) {
    const required = new Set(
      stepIndexes.flatMap((i) => plan.draft.calls[i]!.dependsOn),
    );
    for (const index of required) {
      const step = plan.steps[index];
      if (
        !step ||
        step.state !== "confirmed" ||
        !step.receipt?.canonical ||
        step.receipt.status !== "success" ||
        !step.semantic ||
        !["verified", "unmodeled"].includes(step.semantic.status)
      )
        fail(
          "DEPENDENCIES_UNCONFIRMED",
          "Only independently confirmed prerequisite steps can precede a sponsored wave.",
          409,
        );
      const chainId = plan.draft.calls[index]!.chainId;
      const [receipt, block, head] = await Promise.all([
        chain.request(chainId, "eth_getTransactionReceipt", [
          step.receipt.transactionHash,
        ]),
        chain.request(chainId, "eth_getBlockByNumber", [
          hex(BigInt(step.receipt.blockNumber)),
          false,
        ]),
        chain.snapshot(chainId),
      ]);
      if (
        !object(receipt) ||
        receipt.status !== "0x1" ||
        !hash(receipt.transactionHash) ||
        !same(receipt.transactionHash, step.receipt.transactionHash) ||
        !hash(receipt.blockHash) ||
        !same(receipt.blockHash, step.receipt.blockHash) ||
        !object(block) ||
        !hash(block.hash) ||
        !same(block.hash, step.receipt.blockHash) ||
        quantity(receipt.blockNumber, "dependency block").toString() !==
          step.receipt.blockNumber ||
        BigInt(head.blockNumber) - BigInt(step.receipt.blockNumber) + 1n <
          BigInt(this.policy.confirmations)
      )
        fail(
          "DEPENDENCY_REORGED",
          "A prerequisite is no longer sufficiently confirmed on the canonical chain.",
          409,
        );
    }
  }
  async prepare(
    actor: RestActor,
    planId: string,
    input: SponsorshipPrepareInput,
    key: string,
    request: RequestOptions = {},
  ) {
    request = this.bounded(request);
    this.enabled();
    assertKey(key);
    assertSignal(request.signal);
    if (
      !object(input) ||
      Object.keys(input).some((name) => name !== "stepIndexes")
    )
      fail(
        "INVALID_SPONSORSHIP_INPUT",
        "Preparation accepts only optional stepIndexes.",
        400,
      );
    const inputHash = digest({ planId, input });
    const existing = await this.options.store.find(actor, key, inputHash);
    if (existing) return this.view(existing);
    const plan = await this.plan(actor, planId);
    this.mutable(plan, actor);
    const indexes = input.stepIndexes ?? plan.draft.calls.map((_, i) => i);
    if (
      !Array.isArray(indexes) ||
      indexes.length < 1 ||
      indexes.length > RELAYR_LIMITS.maximumCalls ||
      new Set(indexes).size !== indexes.length ||
      indexes.some(
        (index) =>
          !Number.isInteger(index) ||
          index < 0 ||
          index >= plan.draft.calls.length,
      )
    )
      fail(
        "INVALID_SPONSORSHIP_STEPS",
        "Choose distinct source plan steps within Center’s 32-step plan capacity.",
        400,
      );
    const sorted = [...indexes].sort((a, b) => a - b);
    const calls = sorted.map((index) => plan.draft.calls[index]!);
    if (
      calls.some((call) => !this.policy.allowedChainIds.includes(call.chainId))
    )
      fail(
        "SPONSORSHIP_CHAIN_UNAVAILABLE",
        "The prepaid adapter is enabled only for its configured mainnet chains.",
      );
    if (
      sorted.some(
        (index) =>
          plan.steps[index]!.state !== "waiting" ||
          plan.steps[index]!.attempt ||
          plan.steps[index]!.externalExecution,
      )
    )
      fail(
        "SPONSORSHIP_STEP_RESERVED",
        "One selected step already has an execution binding.",
        409,
      );
    const chain = this.chain(request.signal);
    await this.dependencies(plan, sorted, chain);
    for (const evidence of plan.draft.evidence.filter((e) =>
      calls.some((call) => call.chainId === e.chainId),
    ))
      await chain.canonical(evidence);
    const createdAt = this.now();
    const deadline =
      Math.floor(createdAt / 1000) + this.policy.requestTtlSeconds;
    const requests = await Promise.all(
      calls.map((call, i) =>
        chain.prepare(
          this.options.catalog,
          call,
          plan.draft.account,
          sorted[i]!,
          deadline,
        ),
      ),
    );
    const nextNonces = new Map<number, { base: string; offset: number }>();
    for (const prepared of requests) {
      const position = nextNonces.get(prepared.chainId) ?? { base: prepared.message.nonce, offset: 0 };
      if (position.base !== prepared.message.nonce)
        fail("FORWARD_REQUEST_CHANGED", "The forwarding nonce changed during preparation. Prepare again.", 409);
      prepared.message.nonce = (BigInt(position.base) + BigInt(position.offset++)).toString();
      nextNonces.set(prepared.chainId, position);
    }
    this.mutable(plan, actor);
    assertSignal(request.signal);
    const commitment = digest({
      actor,
      planId,
      planCommitment: plan.commitment,
      requests,
      authorization: "exact-forward-requests",
    });
    const record: SponsorshipRecord = {
      id: randomUUID(),
      actor: { ...actor },
      planId,
      planCommitment: plan.commitment,
      preparationKey: key,
      inputHash,
      commitment,
      requests,
      createdAt,
      expiresAt: plan.expiresAt,
      state: "prepared",
      revision: 0,
      observations: [],
    };
    return this.view(await this.options.store.create(record, this.now()));
  }
  async submit(
    actor: RestActor,
    id: string,
    input: SponsorshipSubmission,
    key: string,
    request: RequestOptions = {},
  ) {
    request = this.bounded(request);
    this.enabled();
    assertKey(key);
    assertSignal(request.signal);
    let record = await this.required(actor, id);
    if (
      !object(input) ||
      Object.keys(input).some((name) => name !== "signatures") ||
      !Array.isArray(input.signatures) ||
      input.signatures.length !== record.requests.length ||
      input.signatures.some(
        (sig) => typeof sig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(sig),
      )
    )
      fail(
        "INVALID_FORWARD_SIGNATURES",
        "Provide one exact ECDSA signature for each prepared request, in order.",
        400,
      );
    const submissionHash = digest({
      commitment: record.commitment,
      signatures: input.signatures.map((sig) => sig.toLowerCase()),
    });
    if (record.submission) {
      const repeated = await this.options.store.claim({
        actor,
        id,
        key,
        hash: submissionHash,
        entries: record.submission.entries,
        now: this.now(),
      });
      return this.view(repeated.record);
    }
    const plan = await this.plan(actor, record.planId);
    this.mutable(plan, actor);
    if (plan.commitment !== record.planCommitment) conflict();
    const chain = this.chain(request.signal);
    await this.dependencies(
      plan,
      record.requests.map((r) => r.stepIndex),
      chain,
    );
    const entries: RelayrEntry[] = [];
    for (const [i, value] of record.requests.entries()) {
      const preceding = entries.filter((entry) => entry.chain === value.chainId);
      entries.push(await chain.signed(value, input.signatures[i]!, preceding));
    }
    if (
      Buffer.byteLength(JSON.stringify(record)) +
        2 * Buffer.byteLength(JSON.stringify(entries)) >
      RELAYR_LIMITS.maximumBytes - 16_384
    )
      fail(
        "SPONSORSHIP_TOO_LARGE",
        "The signed wave exceeds the durable quote binding byte limit.",
        413,
      );
    const authorization = this.options.authorizeDispatch
      ? await this.options.authorizeDispatch(clone(record), submissionHash)
      : undefined;
    if (this.options.authorizeDispatch)
      assertDispatchAuthorization(authorization!, this.now());
    assertSignal(request.signal);
    const claim = await this.options.store.claim({
      actor,
      id,
      key,
      hash: submissionHash,
      entries,
      now: this.now(),
      ...(authorization ? { authorization } : {}),
    });
    if (!claim.dispatch) return this.view(claim.record);
    try {
      // Shared transport is already irrevocably reserved. Tag the original
      // journey before exposing signatures to the provider; recovery can also
      // discover this binding from the shared reservation table after a crash.
      await this.options.transactionStore.reserveExternalExecution(
        actor,
        record.planId,
        record.requests.map((r) => r.stepIndex),
        id,
      );
      if (authorization) assertDispatchAuthorization(authorization, this.now());
      if (record.expiresAt <= this.now())
        fail(
          "SPONSORSHIP_EXPIRED",
          "The publication window expired before provider dispatch.",
          409,
        );
      const raw = await this.provider.create(entries, request.signal);
      const quote = parseQuoteBinding(raw, entries, this.now());
      // Persist a structurally authenticated UUID immediately. RPC failure
      // during runtime proof must not erase a recoverable provider identity.
      record = await this.options.store.settle(
        id,
        submissionHash,
        quote,
        false,
      );
      for (const payment of quote.payments)
        assertPaymentEligible(
          payment,
          this.now(),
          this.policy.maximumFundingValue,
        );
      const lastFundingDeadline =
        Math.min(...record.requests.map((r) => Number(r.message.deadline))) -
        this.policy.minimumRemainingSeconds;
      if (
        quote.payments.some(
          (payment) => Number(payment.deadline) > lastFundingDeadline,
        )
      )
        fail(
          "RELAYR_QUOTE_OUTLIVES_AUTHORIZATION",
          "The funding quote can execute after its forwarding authorization expires. No funding draft is available.",
        );
      if (
        quote.payments.some(
          (payment) => !this.policy.allowedChainIds.includes(payment.chainId),
        )
      )
        fail(
          "RELAYR_PAYMENT_CHAIN_DISABLED",
          "The quote includes a payment chain disabled by host policy.",
        );
      await Promise.all([
        ...quote.payments.map((payment) =>
          chain.paymentRuntime(payment.chainId),
        ),
        this.provider
          .status(quote.bundleUuid, request.signal)
          .then((status) => parseStatus(status, quote)),
      ]);
      record = await this.options.store.settle(id, submissionHash, quote);
    } catch {
      // This includes malformed responses and storage/provider cancellation:
      // creation may have happened, so none of these permit a second POST.
      record = await this.options.store.settle(id, submissionHash);
    }
    return this.view(record);
  }
  async get(actor: RestActor, id: string) {
    return this.view(await this.required(actor, id));
  }
  async refresh(actor: RestActor, id: string, request: RequestOptions = {}) {
    request = this.bounded(request);
    assertSignal(request.signal);
    const record = await this.required(actor, id);
    if (!record.quote) return this.view(record);
    const plan = await this.plan(actor, record.planId);
    const observations = await this.observe(record, plan, request.signal);
    // Receipt logs are consumed transiently by semantic verification, never
    // kept as unbounded provider material in a durable sponsorship record.
    const bounded = observations.map((value) => ({
      ...value,
      ...(value.receipt
        ? { receipt: { ...value.receipt, logs: [], logsStored: false } }
        : {}),
    }));
    return this.view(
      await this.options.store.observe(id, record.revision, bounded),
    );
  }
  async observePlanStep(
    plan: StoredPlan,
    index: number,
    bindingId: string,
    request: RequestOptions = {},
  ): Promise<DestinationObservation> {
    request = this.bounded(request);
    assertSignal(request.signal);
    const record = await this.required(plan.actor, bindingId);
    if (
      record.planId !== plan.id ||
      record.planCommitment !== plan.commitment ||
      !record.requests.some((r) => r.stepIndex === index)
    )
      conflict();
    if (!record.quote)
      return {
        stepIndex: index,
        chainId: plan.draft.calls[index]!.chainId,
        providerState: record.state,
        state: "unknown",
        reason:
          "No authenticated quote is available; do not repeat publication.",
      };
    return (await this.observe(record, plan, request.signal, index))[0]!;
  }
  private async observe(
    record: SponsorshipRecord,
    plan: StoredPlan,
    signal?: AbortSignal,
    onlyIndex?: number,
  ) {
    const quote = record.quote!;
    const chain = this.chain(signal);
    const positions = record.requests
      .map((value, position) => ({ value, position }))
      .filter(
        ({ value }) => onlyIndex === undefined || value.stepIndex === onlyIndex,
      );
    const verify = (
      position: number,
      hint: { providerState: string; hash?: Hex },
    ) =>
      observeDestination({
        chain,
        request: record.requests[position]!,
        entry: quote.entries[position]!.entry,
        hint,
        plan,
        policy: this.policy,
        ...(this.options.semanticVerifier
          ? { semanticVerifier: this.options.semanticVerifier }
          : {}),
        now: this.now(),
      });
    const known = await Promise.all(
      positions.map(({ value, position }) => {
        const knownHash =
          plan.steps[value.stepIndex]?.externalExecution?.transactionHash ??
          record.observations.find(
            (observation) => observation.stepIndex === value.stepIndex,
          )?.hash;
        return knownHash
          ? verify(position, {
              providerState: "stored-hash-rechecked-onchain",
              hash: knownHash,
            })
          : undefined;
      }),
    );
    const succeeded = (value: DestinationObservation | undefined) =>
      value?.receipt?.status === "success" &&
      ["confirmed", "confirming"].includes(value.state);
    if (known.every(succeeded)) return known as DestinationObservation[];
    let hints: ReturnType<typeof parseStatus>;
    try {
      hints = parseStatus(
        await this.provider.status(quote.bundleUuid, signal),
        quote,
      );
    } catch (error) {
      assertSignal(signal);
      // Failed outer attempts can be retried by Relayr without consuming the
      // forwarding nonce. Preserve their independent proof during an outage,
      // while still looking for a later successful attempt when available.
      if (known.every((value) => value?.receipt?.canonical))
        return known as DestinationObservation[];
      throw error;
    }
    return Promise.all(
      positions.map(({ position }, i) => {
        if (succeeded(known[i])) return known[i]!;
        const hint = hints.find((value) => value.step === position)!;
        if (!hint.hash && known[i]?.receipt?.canonical) return known[i]!;
        return verify(position, hint);
      }),
    );
  }
  async prepareFunding(
    actor: RestActor,
    id: string,
    input: { chainId: number; payer: Address },
    request: RequestOptions = {},
  ): Promise<RestPlanDraft> {
    request = this.bounded(request);
    this.enabled();
    assertSignal(request.signal);
    if (
      !object(input) ||
      Object.keys(input).some((key) => !["chainId", "payer"].includes(key)) ||
      !isAddress(input.payer)
    )
      fail(
        "INVALID_FUNDING_INPUT",
        "Provide a payment chain and the wallet that will review and sign funding.",
        400,
      );
    const record = await this.required(actor, id);
    const quote = record.quote;
    if (!quote)
      fail(
        "RELAYR_QUOTE_UNAVAILABLE",
        "An authenticated, unambiguous prepaid quote is required before funding.",
        409,
      );
    const payment = quote.payments.find(
      (value) => value.chainId === input.chainId,
    );
    if (!payment || !this.policy.allowedChainIds.includes(input.chainId))
      fail(
        "RELAYR_PAYMENT_UNAVAILABLE",
        "This stored quote has no supported payment option for the requested chain.",
      );
    assertPaymentEligible(payment, this.now(), this.policy.maximumFundingValue);
    if (
      Number(payment.deadline) <=
      Math.floor(this.now() / 1000) + this.policy.minimumRemainingSeconds
    )
      fail(
        "RELAYR_QUOTE_EXPIRED",
        "This exact payment quote expired; do not fund it.",
        409,
      );
    if (
      Number(payment.deadline) >
      Math.min(
        ...record.requests.map((value) => Number(value.message.deadline)),
      ) -
        this.policy.minimumRemainingSeconds
    )
      fail(
        "RELAYR_QUOTE_OUTLIVES_AUTHORIZATION",
        "The funding deadline exceeds the reviewed forwarding authorization.",
      );
    const plan = await this.plan(actor, record.planId);
    const chain = this.chain(request.signal);
    parseStatus(
      await this.provider.status(quote.bundleUuid, request.signal),
      quote,
    );
    await this.dependencies(
      plan,
      record.requests.map((value) => value.stepIndex),
      chain,
    );
    const offsets = new Map<number, number>();
    await Promise.all(record.requests.map((value) => {
      const offset = offsets.get(value.chainId) ?? 0;
      offsets.set(value.chainId, offset + 1);
      return chain.revalidate(value, offset);
    }));
    const evidence = await chain.payment(payment, input.payer);
    assertSignal(request.signal);
    if (
      Number(payment.deadline) <=
        Math.floor(this.now() / 1000) + this.policy.minimumRemainingSeconds ||
      record.requests.some(
        (value) =>
          Number(value.message.deadline) <=
          Math.floor(this.now() / 1000) + this.policy.minimumRemainingSeconds,
      )
    )
      fail(
        "RELAYR_QUOTE_EXPIRED",
        "The funding or forwarding review window expired during preparation.",
        409,
      );
    return clone({
      operation: "relayr_bundle_funding",
      account: input.payer,
      calls: [
        {
          chainId: payment.chainId,
          to: payment.to,
          data: payment.data,
          value: payment.value,
          label: "Fund the approved transaction bundle",
          dependsOn: [],
          decoded: {
            bundleUuid: quote.bundleUuid,
            deadline: payment.deadline,
            gasLimitUsedForSimulation: RELAYR_PAYMENT_GAS.toString(),
          },
        },
      ],
      evidence: [evidence],
      summary: {
        sponsorshipId: id,
        bundleUuid: quote.bundleUuid,
        quoteCommitment: quote.commitment,
        executionCommitment: record.commitment,
        payer: input.payer,
        externallySignedFundingOnly: true,
        economicCompletion: false,
      },
      warnings: [
        "This payment funds prepaid execution; it does not prove destination success or bridge settlement.",
        "Fund this bundle only once. Inspect an existing funding transaction before sending another.",
        "The payer must independently review and sign this exact draft. Another account’s API authorization does not authorize the payer’s wallet.",
      ],
    });
  }
  private view(record: SponsorshipRecord) {
    const executionVerified =
      record.observations.length === record.requests.length &&
      record.observations.every((value) => value.state === "confirmed");
    const economicCompletion =
      executionVerified &&
      record.observations.every(
        (value) => value.semantic?.status === "verified",
      );
    return clone({
      id: record.id,
      planId: record.planId,
      planCommitment: record.planCommitment,
      commitment: record.commitment,
      state: record.state,
      availability: economicCompletion
        ? "completed"
        : executionVerified
          ? "execution_verified"
          : record.quote
            ? record.quoteRuntimeVerified
              ? "funding_quote_available"
              : "requires_verification"
            : record.state === "prepared"
              ? "available"
              : "submission_unknown",
      createdAt: record.createdAt,
      publicationExpiresAt: record.expiresAt,
      revision: record.revision,
      authorizations: record.requests.map((value) => ({
        ...value,
        primaryType: "ForwardRequest",
        types: FORWARD_REQUEST_TYPES,
      })),
      ...(record.submission
        ? {
            submission: {
              hash: record.submission.hash,
              startedAt: record.submission.startedAt,
              repeatPublicationAllowed: false,
            },
          }
        : {}),
      ...(record.quote
        ? {
            quote: {
              bundleUuid: record.quote.bundleUuid,
              commitment: record.quote.commitment,
              payments: record.quoteRuntimeVerified
                ? record.quote.payments
                : [],
              runtimeVerified: record.quoteRuntimeVerified === true,
              observedAt: record.quote.observedAt,
              transactions: record.quote.entries.map((value) => ({
                txUuid: value.txUuid,
                chainId: value.entry.chain,
                outerCallHash: keccak256(value.entry.data),
              })),
            },
          }
        : {}),
      observations: record.observations,
      authorizationNotice:
        "Owner signatures authorize these exact calls until each onchain deadline. The shorter source-plan expiry limits publication only; it cannot revoke a published signature.",
      fundingNotice:
        "A quote does not establish whether somebody already funded this bundle. Check the funding transaction before paying; never infer another payment is needed from pending destination execution.",
      ...(record.state === "submission_unknown" || record.state === "submitting"
        ? {
            recovery:
              "Publication may have succeeded. This adapter never repeats an uncertain POST. Without the provider bundle ID, independent recovery is unavailable.",
          }
        : {}),
      economicCompletion,
    });
  }
}
