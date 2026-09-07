import { describe, expect, it, vi } from "vitest";
import { keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  RestError,
  type RestActor,
  type RestPlanDraft,
  type RestRpc,
} from "../src/rest/core.js";
import { MemoryTransactionStore } from "../src/rest/transactions/memory.js";
import { TransactionService } from "../src/rest/transactions/service.js";
import type {
  ExternalExecutionObservation,
  ExternalExecutionObserver,
  SemanticVerifier,
  StoredPlan,
} from "../src/rest/transactions/types.js";
import { MemoryTransportReservations } from "../src/rest/transactions/transport-reservations.js";

// Deterministic, public test key. Transactions are only passed to this file's mock RPC.
const wallet = privateKeyToAccount(`0x${"11".repeat(32)}`);
const recipient = "0x2222222222222222222222222222222222222222" as Address;
const h = (byte: string) => `0x${byte.repeat(64)}` as Hex;
const evidenceHash = h("a");
const receiptHash = h("b");
const accountId = `eip155:8453:${wallet.address.toLowerCase()}`;
const actor: RestActor = { accountId, principalId: `owner:${accountId}` };
const requestHash = "12".repeat(32);
const now = 1_700_000_000_000;

function harness(
  options: {
    verifier?: SemanticVerifier;
    externalObserver?: ExternalExecutionObserver;
    authorizeDispatch?: (
      plan: StoredPlan,
      index: number,
      transactionHash: Hex,
    ) => Promise<{ issuedAt: number; expiresAt: number }>;
    ttl?: number;
    timeout?: number;
  } = {},
) {
  let clock = now;
  let nonce = 0;
  let revoked = false;
  let sendMode: "normal" | "accepted-timeout" | "unknown" | "hang" = "normal";
  const receipts = new Map<string, Record<string, unknown>>();
  const transactions = new Map<string, Record<string, unknown>>();
  const blockHashes = new Map<bigint, Hex>([
    [100n, evidenceHash],
    [101n, receiptHash],
    [102n, h("c")],
  ]);
  const rpc = vi.fn(
    async (
      _chainId: number,
      method: string,
      params: readonly unknown[],
    ): Promise<unknown> => {
      switch (method) {
        case "eth_chainId":
          return "0x2105";
        case "eth_blockNumber":
          return "0x66";
        case "eth_getBlockByNumber": {
          const height =
            params[0] === "latest" ? 101n : BigInt(params[0] as string);
          return {
            hash: blockHashes.get(height),
            number: `0x${height.toString(16)}`,
            timestamp: `0x${Math.floor(now / 1000).toString(16)}`,
            baseFeePerGas: "0x1",
          };
        }
        case "eth_getTransactionCount":
          return `0x${nonce.toString(16)}`;
        case "eth_getBalance":
          return "0xde0b6b3a7640000";
        case "eth_call":
          return "0x";
        case "eth_estimateGas":
          return "0xc350";
        case "eth_getTransactionReceipt":
          return receipts.get((params[0] as string).toLowerCase()) ?? null;
        case "eth_getTransactionByHash":
          return transactions.get((params[0] as string).toLowerCase()) ?? null;
        case "eth_sendRawTransaction": {
          const hash = keccak256(params[0] as Hex);
          if (sendMode === "unknown")
            throw new Error("Mock network unavailable before response");
          if (sendMode === "hang") return new Promise(() => {});
          transactions.set(hash, { hash });
          nonce++;
          if (sendMode === "accepted-timeout")
            throw new Error("Mock response lost after acceptance");
          return hash;
        }
        default:
          throw new Error(`Unexpected mock method ${method}`);
      }
    },
  );
  let lock: Promise<unknown> = Promise.resolve();
  const guard = {
    async withActiveActor<T>(
      _actor: RestActor,
      _scopes: unknown,
      _now: number,
      operation: () => Promise<T>,
    ): Promise<T> {
      const next = lock.then(async () => {
        if (revoked)
          throw new RestError(403, "REVOKED", "Mock principal revoked");
        return operation();
      });
      lock = next.catch(() => {});
      return next;
    },
  };
  const transports = new MemoryTransportReservations();
  const store = new MemoryTransactionStore(guard, transports);
  const rpcInterface: RestRpc = { request: rpc };
  const service = new TransactionService({
    store,
    rpc: rpcInterface,
    now: () => clock,
    ...(options.verifier ? { semanticVerifier: options.verifier } : {}),
    ...(options.externalObserver
      ? { externalObserver: options.externalObserver }
      : {}),
    ...(options.authorizeDispatch
      ? { authorizeDispatch: options.authorizeDispatch }
      : {}),
    policy: {
      ...(options.ttl ? { planTtlMs: options.ttl } : {}),
      ...(options.timeout ? { rpcTimeoutMs: options.timeout } : {}),
    },
  });
  const draft = (dependencies = false): RestPlanDraft => ({
    operation: "generic-contract-method",
    account: wallet.address,
    calls: [0, ...(dependencies ? [1] : [])].map((index) => ({
      chainId: 8453,
      to: recipient,
      data: index ? "0xabcd" : "0x1234",
      value: "0",
      label: `Call ${index}`,
      decoded: {},
      dependsOn: index ? [0] : [],
    })),
    evidence: [
      {
        chainId: 8453,
        blockNumber: "100",
        blockHash: evidenceHash,
        timestamp: String(now / 1000),
        source: "onchain",
      },
    ],
    summary: {},
    warnings: [],
  });
  async function signed(
    overrides: {
      nonce?: number;
      data?: Hex;
      value?: bigint;
      chainId?: number;
      gas?: bigint;
      maxFeePerGas?: bigint;
    } = {},
  ) {
    return wallet.signTransaction({
      chainId: 8453,
      type: "eip1559",
      to: recipient,
      data: "0x1234",
      value: 0n,
      nonce: 0,
      gas: 100_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1n,
      ...overrides,
    });
  }
  function confirm(raw: Hex, status = "0x1") {
    const hash = keccak256(raw);
    transactions.set(hash, { hash });
    receipts.set(hash, {
      transactionHash: hash,
      blockHash: receiptHash,
      blockNumber: "0x65",
      status,
      logs: [],
    });
    nonce = 1;
  }
  return {
    service,
    store,
    transports,
    rpc,
    rpcInterface,
    draft,
    signed,
    confirm,
    receipts,
    transactions,
    blockHashes,
    setNow: (value: number) => {
      clock = value;
    },
    setNonce: (value: number) => {
      nonce = value;
    },
    revoke: () => {
      revoked = true;
    },
    setSendMode: (value: typeof sendMode) => {
      sendMode = value;
    },
  };
}

describe("durable signed transaction relay", () => {
  it("requires configured fresh owner authorization after preflight and skips it for an active dispatch replay", async () => {
    const authorizeDispatch = vi.fn(
      async (_plan: StoredPlan, _index: number, _hash: Hex) => {
        expect(
          h.rpc.mock.calls.some(([, method]) => method === "eth_call"),
        ).toBe(true);
        return { issuedAt: now / 1000, expiresAt: now / 1000 + 60 };
      },
    );
    const h = harness({ authorizeDispatch });
    const plan = await h.service.createPlan(
      actor,
      h.draft(),
      "fresh-owner",
      requestHash,
    );
    const raw = await h.signed();
    h.setSendMode("unknown");
    expect(
      (
        await h.service.submitStep(
          actor,
          plan.id,
          0,
          raw,
          "fresh-submit",
          requestHash,
        )
      ).dispatch.status,
    ).toBe("unknown");
    expect(authorizeDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ id: plan.id }),
      0,
      keccak256(raw),
    );
    authorizeDispatch.mockRejectedValue(
      new Error("No new owner approval provided for this read-only replay"),
    );
    const replay = await h.service.submitStep(
      actor,
      plan.id,
      0,
      raw,
      "fresh-replay",
      requestHash,
    );
    expect(replay.dispatch.status).toBe("in-flight");
    expect(authorizeDispatch).toHaveBeenCalledTimes(1);
    expect(
      h.service.capabilities().authorization.freshOwnerApprovalRequired,
    ).toBe(true);
  });

  it("refuses dispatch when approval expires during asynchronous verification without reserving a transaction", async () => {
    const authorizeDispatch = vi.fn(async () => {
      h.setNow(now + 61_000);
      return { issuedAt: now / 1000, expiresAt: now / 1000 + 60 };
    });
    const h = harness({ authorizeDispatch });
    const plan = await h.service.createPlan(
      actor,
      h.draft(),
      "expired-owner",
      requestHash,
    );
    await expect(
      h.service.submitStep(
        actor,
        plan.id,
        0,
        await h.signed(),
        "expired-submit",
        requestHash,
      ),
    ).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(
      (await h.store.get(actor, plan.id))?.steps[0]?.attempt,
    ).toBeUndefined();
    expect(
      h.rpc.mock.calls.filter(
        ([, method]) => method === "eth_sendRawTransaction",
      ),
    ).toHaveLength(0);
  });

  it("does not treat a valid raw EOA signature as fresh owner consent when the production authorizer rejects it", async () => {
    const h = harness({
      authorizeDispatch: async () => {
        throw new RestError(
          403,
          "OWNER_APPROVAL_REQUIRED",
          "Fresh owner approval missing",
        );
      },
    });
    const plan = await h.service.createPlan(
      actor,
      h.draft(),
      "missing-owner",
      requestHash,
    );
    await expect(
      h.service.submitStep(
        actor,
        plan.id,
        0,
        await h.signed(),
        "missing-submit",
        requestHash,
      ),
    ).rejects.toMatchObject({ code: "OWNER_APPROVAL_REQUIRED" });
    expect(
      (await h.store.get(actor, plan.id))?.steps[0]?.attempt,
    ).toBeUndefined();
  });

  it("owns the reviewed draft before asynchronous evidence checks", async () => {
    const h = harness();
    const draft = h.draft();
    h.rpc.mockImplementationOnce(async () => {
      draft.calls[0]!.value = "999";
      draft.calls[0]!.dependsOn = [0];
      draft.evidence[0]!.blockHash = receiptHash;
      return {
        hash: evidenceHash,
        number: "0x64",
        timestamp: `0x${Math.floor(now / 1000).toString(16)}`,
      };
    });
    const plan = await h.service.createPlan(
      actor,
      draft,
      "immutable",
      requestHash,
    );
    expect(plan.draft.calls[0]).toMatchObject({ value: "0", dependsOn: [] });
    expect(plan.draft.evidence[0]?.blockHash).toBe(evidenceHash);
    expect((await h.service.getPlan(actor, plan.id)).commitment).toBe(
      plan.commitment,
    );
  });

  it("checks exact signed bytes and simulates canonical account state without override before relay", async () => {
    const h = harness();
    const plan = await h.service.createPlan(
      actor,
      h.draft(),
      "create",
      requestHash,
    );
    const raw = await h.signed();
    const result = await h.service.submitStep(
      actor,
      plan.id,
      0,
      raw,
      "submit",
      requestHash,
    );
    expect(result.dispatch).toEqual({
      status: "submitted",
      hash: keccak256(raw),
    });
    expect(
      h.rpc.mock.calls.filter(
        ([, method]) => method === "eth_sendRawTransaction",
      ),
    ).toHaveLength(1);
    const simulation = h.rpc.mock.calls.find(
      ([, method]) => method === "eth_call",
    )![2];
    expect(simulation).toHaveLength(2);
    expect(simulation[0]).toMatchObject({
      from: wallet.address,
      to: recipient,
      data: "0x1234",
      value: "0x0",
      gas: "0x186a0",
    });
    expect(simulation[1]).toBe("0x65");
    expect(JSON.stringify(result)).not.toContain(raw);
    expect(result.plan.steps[0]?.transaction).toMatchObject({
      hash: keccak256(raw),
      nonce: "0",
      dispatchCount: 1,
    });
  });

  it.each([
    { data: "0x9999" as Hex },
    { value: 1n },
    { chainId: 1 },
    { gas: 21_000_001n },
    { maxFeePerGas: 1_000_000_000_001n },
  ])(
    "rejects mismatched or excessive signed envelope %#",
    async (overrides) => {
      const h = harness();
      const plan = await h.service.createPlan(
        actor,
        h.draft(),
        "create",
        requestHash,
      );
      await expect(
        h.service.submitStep(
          actor,
          plan.id,
          0,
          await h.signed(overrides),
          "submit",
          requestHash,
        ),
      ).rejects.toBeInstanceOf(RestError);
      expect(
        h.rpc.mock.calls.some(
          ([, method]) => method === "eth_sendRawTransaction",
        ),
      ).toBe(false);
    },
  );

  it("rejects wrong wallets, future nonces, unprotected legacy and EIP-7702 envelopes", async () => {
    const h = harness();
    const plan = await h.service.createPlan(
      actor,
      h.draft(),
      "create",
      requestHash,
    );
    const another = privateKeyToAccount(`0x${"22".repeat(32)}`);
    const wrongSigner = await another.signTransaction({
      chainId: 8453,
      type: "legacy",
      to: recipient,
      data: "0x1234",
      nonce: 0,
      gas: 100_000n,
      gasPrice: 1n,
    });
    await expect(
      h.service.submitStep(
        actor,
        plan.id,
        0,
        wrongSigner,
        "wrong",
        requestHash,
      ),
    ).rejects.toMatchObject({ code: "SIGNED_PLAN_MISMATCH" });
    await expect(
      h.service.submitStep(
        actor,
        plan.id,
        0,
        await h.signed({ nonce: 1 }),
        "future",
        requestHash,
      ),
    ).rejects.toMatchObject({ code: "NONCE_NOT_READY" });
    const unprotected = await wallet.signTransaction({
      type: "legacy",
      to: recipient,
      data: "0x1234",
      nonce: 0,
      gas: 100_000n,
      gasPrice: 1n,
    });
    await expect(
      h.service.submitStep(
        actor,
        plan.id,
        0,
        unprotected,
        "legacy",
        requestHash,
      ),
    ).rejects.toMatchObject({ code: "TRANSACTION_CHAIN_OR_NONCE_MISMATCH" });
    const delegated = await wallet.signTransaction({
      chainId: 8453,
      type: "eip7702",
      to: recipient,
      data: "0x1234",
      nonce: 0,
      gas: 100_000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      authorizationList: [
        {
          chainId: 8453,
          address: recipient,
          nonce: 0,
          r: hHash(),
          s: hHash(),
          yParity: 0,
        },
      ],
    });
    await expect(
      h.service.submitStep(actor, plan.id, 0, delegated, "7702", requestHash),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_TRANSACTION_TYPE" });
  });

  it("reserves before dispatch and reconciles response loss and process restart by the same deterministic hash", async () => {
    const h = harness();
    const plan = await h.service.createPlan(
      actor,
      h.draft(),
      "create",
      requestHash,
    );
    const raw = await h.signed();
    h.setSendMode("accepted-timeout");
    const first = await h.service.submitStep(
      actor,
      plan.id,
      0,
      raw,
      "submit",
      requestHash,
    );
    expect(first.dispatch.status).toBe("unknown");
    const restarted = new TransactionService({
      store: h.store,
      rpc: h.rpcInterface,
      now: () => now,
    });
    const repeat = await restarted.submitStep(
      actor,
      plan.id,
      0,
      raw,
      "submit",
      requestHash,
    );
    expect(repeat.dispatch.status).toBe("already-observed");
    expect(
      h.rpc.mock.calls.filter(
        ([, method]) => method === "eth_sendRawTransaction",
      ),
    ).toHaveLength(1);
    h.confirm(raw);
    expect((await restarted.refresh(actor, plan.id)).status).toBe(
      "transactions_confirmed",
    );
  });

  it("serializes duplicate submissions and globally prevents competing nonce reservations", async () => {
    const h = harness();
    const plan = await h.service.createPlan(
      actor,
      h.draft(),
      "create",
      requestHash,
    );
    const raw = await h.signed();
    const results = await Promise.all([
      h.service.submitStep(actor, plan.id, 0, raw, "submit", requestHash),
      h.service.submitStep(actor, plan.id, 0, raw, "submit", requestHash),
    ]);
    expect(results.map((result) => result.dispatch.status)).toContain(
      "submitted",
    );
    expect(
      h.rpc.mock.calls.filter(
        ([, method]) => method === "eth_sendRawTransaction",
      ),
    ).toHaveLength(1);
    const second = await h.service.createPlan(
      actor,
      h.draft(),
      "create2",
      requestHash,
    );
    await expect(
      h.service.submitStep(actor, second.id, 0, raw, "submit2", requestHash),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("requires prerequisite confirmations and semantic proofs, then blocks after a reorg", async () => {
    const h = harness();
    const plan = await h.service.createPlan(
      actor,
      h.draft(true),
      "create",
      requestHash,
    );
    const raw = await h.signed();
    const downstream = await h.signed({ nonce: 1, data: "0xabcd" });
    await h.service.submitStep(actor, plan.id, 0, raw, "submit", requestHash);
    await expect(
      h.service.submitStep(
        actor,
        plan.id,
        1,
        downstream,
        "downstream",
        requestHash,
      ),
    ).rejects.toMatchObject({ code: "DEPENDENCIES_UNCONFIRMED" });
    h.confirm(raw);
    expect((await h.service.refresh(actor, plan.id)).status).toBe("partial");
    h.blockHashes.set(101n, hHash());
    const reorg = await h.service.refresh(actor, plan.id);
    expect(reorg.status).toBe("reorged");
    expect(reorg.steps[1]?.blockedBy).toEqual([0]);
    await expect(
      h.service.submitStep(
        actor,
        plan.id,
        1,
        downstream,
        "downstream",
        requestHash,
      ),
    ).rejects.toMatchObject({ code: "DEPENDENCIES_UNCONFIRMED" });
  });

  it("never treats unknown modeled effects as completed dependency or bridge settlement", async () => {
    const h = harness({
      verifier: {
        verify: async () => ({
          status: "unknown",
          details: "Destination bridge settlement still pending.",
        }),
      },
    });
    const plan = await h.service.createPlan(
      actor,
      h.draft(true),
      "create",
      requestHash,
    );
    const raw = await h.signed();
    h.confirm(raw);
    const observed = await h.service.submitStep(
      actor,
      plan.id,
      0,
      raw,
      "attach",
      requestHash,
    );
    expect(observed.plan.steps[0]?.state).toBe("confirmed");
    expect(observed.plan.steps[0]?.semantic?.status).toBe("unknown");
    expect(observed.plan.steps[1]?.blockedBy).toEqual([0]);
    expect(observed.plan.status).not.toBe("transactions_confirmed");
    expect(
      h.rpc.mock.calls.some(
        ([, method]) => method === "eth_sendRawTransaction",
      ),
    ).toBe(false);
  });

  it("reports partial bundle admission explicitly and preserves the first pending hash", async () => {
    const h = harness();
    const plan = await h.service.createPlan(
      actor,
      h.draft(true),
      "create",
      requestHash,
    );
    const result = await h.service.submitBundle(
      actor,
      plan.id,
      [
        { stepIndex: 0, rawSignedTransaction: await h.signed() },
        {
          stepIndex: 1,
          rawSignedTransaction: await h.signed({ nonce: 1, data: "0xabcd" }),
        },
      ],
      "bundle",
      requestHash,
    );
    expect(result).toMatchObject({
      atomic: false,
      complete: false,
      stoppedAt: 1,
      remainingStepIndices: [1],
      error: { code: "DEPENDENCIES_UNCONFIRMED" },
    });
    expect(result.plan.steps[0]?.transaction?.hash).toBeDefined();
  });

  it("blocks expired or revoked new admissions while retaining read-only reconciliation", async () => {
    const h = harness({ ttl: 1000 });
    const plan = await h.service.createPlan(
      actor,
      h.draft(),
      "create",
      requestHash,
    );
    const raw = await h.signed();
    h.setNow(now + 1001);
    await expect(
      h.service.submitStep(actor, plan.id, 0, raw, "submit", requestHash),
    ).rejects.toMatchObject({ code: "PLAN_EXPIRED" });
    h.setNow(now);
    h.revoke();
    await expect(
      h.service.submitStep(actor, plan.id, 0, raw, "submit", requestHash),
    ).rejects.toMatchObject({ code: "REVOKED" });
    expect((await h.service.getPlan(actor, plan.id)).id).toBe(plan.id);
    expect((await h.service.recoverPending()).broadcastAttempted).toBe(false);
  });

  it("returns an expired idempotent preparation without repeating failed upstream work", async () => {
    const h = harness({ ttl: 1000 });
    const draft = h.draft();
    const plan = await h.service.createPlan(
      actor,
      draft,
      "create",
      requestHash,
    );
    h.setNow(now + 2000);
    h.rpc.mockRejectedValue(new Error("Mock RPC offline"));
    expect(
      (await h.service.findPlanByIdempotency(actor, "create", requestHash))?.id,
    ).toBe(plan.id);
    expect(
      (await h.service.createPlan(actor, draft, "create", requestHash)).id,
    ).toBe(plan.id);
    await expect(
      h.service.findPlanByIdempotency(actor, "create", "34".repeat(32)),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("does not reserve or broadcast after an exact simulation failure", async () => {
    const h = harness();
    const plan = await h.service.createPlan(
      actor,
      h.draft(),
      "create",
      requestHash,
    );
    const original = h.rpc.getMockImplementation()!;
    h.rpc.mockImplementation(async (chain, method, params) => {
      if (method === "eth_call") throw new Error("Mock allowance missing");
      return original(chain, method, params);
    });
    await expect(
      h.service.submitStep(
        actor,
        plan.id,
        0,
        await h.signed(),
        "submit",
        requestHash,
      ),
    ).rejects.toMatchObject({ code: "SIMULATION_UNAVAILABLE" });
    expect(
      (await h.service.getPlan(actor, plan.id)).steps[0]?.transaction,
    ).toBeUndefined();
    expect(
      h.rpc.mock.calls.some(
        ([, method]) => method === "eth_sendRawTransaction",
      ),
    ).toBe(false);
  });

  it("passes complete logs to semantic verification and persists their explicit compact commitment", async () => {
    const verify = vi.fn(async () => ({ status: "verified" as const }));
    const h = harness({ verifier: { verify } });
    const plan = await h.service.createPlan(
      actor,
      h.draft(),
      "create",
      requestHash,
    );
    const raw = await h.signed();
    h.confirm(raw);
    const receipt = h.receipts.get(keccak256(raw))!;
    receipt.logs = [
      {
        address: recipient,
        data: "0x1234",
        topics: [hHash()],
        logIndex: "0x0",
      },
    ];
    const result = await h.service.submitStep(
      actor,
      plan.id,
      0,
      raw,
      "attach",
      requestHash,
    );
    expect(verify).toHaveBeenCalledWith(
      expect.anything(),
      0,
      expect.objectContaining({ logs: receipt.logs }),
      expect.anything(),
    );
    expect(result.plan.steps[0]?.receipt).toMatchObject({
      logs: [],
      logsStored: false,
      logCount: 1,
    });
    expect(result.plan.steps[0]?.receipt?.logsHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("bounds a nonresponsive broadcast and keeps recovery read-only", async () => {
    const h = harness({ timeout: 25 });
    const plan = await h.service.createPlan(
      actor,
      h.draft(),
      "create",
      requestHash,
    );
    h.setSendMode("hang");
    const result = await h.service.submitStep(
      actor,
      plan.id,
      0,
      await h.signed(),
      "submit",
      requestHash,
    );
    expect(result.dispatch.status).toBe("unknown");
    expect(result.plan.steps[0]?.transaction?.hash).toBeDefined();
    await h.service.recoverPending();
    expect(
      h.rpc.mock.calls.filter(
        ([, method]) => method === "eth_sendRawTransaction",
      ),
    ).toHaveLength(1);
  });

  it("enforces account ownership, DAG order and redacted principal-scoped reads", async () => {
    const h = harness();
    await expect(
      h.service.createPlan(
        actor,
        { ...h.draft(), account: recipient },
        "bad-account",
        requestHash,
      ),
    ).rejects.toMatchObject({ code: "PLAN_ACCOUNT_MISMATCH" });
    const cyclic = h.draft();
    cyclic.calls[0]!.dependsOn = [0];
    await expect(
      h.service.createPlan(actor, cyclic, "cycle", requestHash),
    ).rejects.toMatchObject({ code: "INVALID_PLAN_CALL" });
    const plan = await h.service.createPlan(
      actor,
      h.draft(),
      "create",
      requestHash,
    );
    await expect(
      h.service.getPlan({ ...actor, principalId: "bot:other" }, plan.id),
    ).rejects.toMatchObject({ code: "PLAN_NOT_FOUND" });
    expect(h.service.capabilities().transports[1]).toMatchObject({
      kind: "eip4337-user-operation",
      supported: false,
    });
  });
});

function hHash() {
  return `0x${"44".repeat(32)}` as Hex;
}

function externalFixture() {
  const rawOuter = "0x998877" as Hex;
  const outerHash = keccak256(rawOuter);
  const observer = {
    kind: "relayr" as const,
    observePlanStep: vi.fn(
      async (): Promise<ExternalExecutionObservation> => ({
        stepIndex: 0,
        chainId: 8453,
        providerState: "executed",
        state: "confirmed",
        hash: outerHash,
        receipt: {
          transactionHash: outerHash,
          blockHash: receiptHash,
          blockNumber: "101",
          status: "success",
          canonical: true,
          confirmations: 2,
          observedAt: now,
          logs: [],
        },
        semantic: { status: "verified" },
      }),
    ),
  };
  return { rawOuter, outerHash, observer };
}

describe("sponsored execution observations on original plans", () => {
  it("keeps operation-scoped semantic evidence when an ERC-4337 provider changes its hint", async () => {
    const fixture = externalFixture();
    const verify = vi.fn(async () => ({ status: "failed" as const }));
    const observer = { ...fixture.observer, kind: "erc4337" as const };
    const h = harness({ externalObserver: observer, verifier: { verify } });
    const plan = await h.service.createPlan(
      actor,
      h.draft(true),
      "uo-retry-hint",
      requestHash,
    );
    h.transports.claim(plan.id, [0], "erc4337", "uo-binding");
    h.confirm(fixture.rawOuter);
    const first = await h.service.getPlan(actor, plan.id);
    expect(first.steps[0]).toMatchObject({
      state: "confirmed",
      semantic: { status: "verified" },
    });
    fixture.observer.observePlanStep.mockResolvedValue({
      stepIndex: 0,
      chainId: 8453,
      providerState: "retry",
      state: "reverted",
      hash: hHash(),
    });
    const refreshed = await h.service.getPlan(actor, plan.id);
    expect(refreshed.steps[0]).toMatchObject({
      state: "confirmed",
      semantic: { status: "verified" },
      execution: { hash: fixture.outerHash },
    });
    expect(refreshed.steps[1]?.blockedBy).toEqual([]);
    expect(verify).not.toHaveBeenCalled();
  });
  it("retains a freshly reverified canonical inner success when a provider advertises a later retry", async () => {
    const fixture = externalFixture();
    const h = harness({ externalObserver: fixture.observer });
    const plan = await h.service.createPlan(
      actor,
      h.draft(true),
      "external-retry-hint",
      requestHash,
    );
    h.transports.claim(plan.id, [0], "relayr", "relayr-binding");
    h.confirm(fixture.rawOuter);
    expect((await h.service.getPlan(actor, plan.id)).steps[0]?.state).toBe(
      "confirmed",
    );
    fixture.observer.observePlanStep.mockResolvedValue({
      stepIndex: 0,
      chainId: 8453,
      providerState: "failed-retry",
      state: "reverted",
      hash: hHash(),
    });
    const refreshed = await h.service.getPlan(actor, plan.id);
    expect(refreshed.steps[0]).toMatchObject({
      state: "confirmed",
      execution: { hash: fixture.outerHash },
      receipt: { canonical: true },
    });
    expect(refreshed.steps[1]?.blockedBy).toEqual([]);
  });

  it("discovers an admitted external binding after a crash without inventing an EOA attempt", async () => {
    const h = harness();
    const plan = await h.service.createPlan(
      actor,
      h.draft(true),
      "external-discovery",
      requestHash,
    );
    h.transports.claim(plan.id, [0], "relayr", "relayr-binding");
    const recovered = await h.service.getPlan(actor, plan.id);
    expect(recovered.steps[0]).toMatchObject({
      state: "unknown",
      execution: {
        transport: "relayr-prepaid-erc2771",
        bindingId: "relayr-binding",
        chainId: 8453,
      },
    });
    expect(recovered.steps[0]?.transaction).toBeUndefined();
    expect(
      (await h.store.get(actor, plan.id))?.steps[0]?.attempt,
    ).toBeUndefined();
    await expect(
      h.service.submitStep(
        actor,
        plan.id,
        0,
        await h.signed(),
        "direct-collision",
        requestHash,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      h.rpc.mock.calls.filter(
        ([, method]) => method === "eth_sendRawTransaction",
      ),
    ).toHaveLength(0);
  });

  it("confirms the bound inner execution and unlocks an owner EOA step with its actual nonce", async () => {
    const fixture = externalFixture();
    const h = harness({ externalObserver: fixture.observer });
    const plan = await h.service.createPlan(
      actor,
      h.draft(true),
      "external-confirm",
      requestHash,
    );
    h.transports.claim(plan.id, [0], "relayr", "relayr-binding");
    h.confirm(fixture.rawOuter);
    h.setNonce(0); // The sponsor's outer transaction did not consume the owner's EOA nonce.
    const refreshed = await h.service.getPlan(actor, plan.id);
    expect(refreshed.steps[0]).toMatchObject({
      state: "confirmed",
      execution: { hash: fixture.outerHash },
      semantic: { status: "verified" },
      receipt: { logsStored: false },
    });
    expect(refreshed.steps[1]?.blockedBy).toEqual([]);
    expect(fixture.observer.observePlanStep.mock.calls.length).toBeGreaterThan(
      0,
    );
    const submission = await h.service.submitStep(
      actor,
      plan.id,
      1,
      await h.signed({ data: "0xabcd", nonce: 0 }),
      "owner-after-external",
      requestHash,
    );
    expect(submission.dispatch.status).toBe("submitted");
    expect(submission.plan.steps[0]?.transaction).toBeUndefined();
    expect(submission.plan.steps[1]?.transaction?.nonce).toBe("0");
  });

  it("blocks downstream calls when the outer receipt succeeds but the inner proof is unknown or failed", async () => {
    const fixture = externalFixture();
    fixture.observer.observePlanStep.mockImplementation(async () => ({
      stepIndex: 0,
      chainId: 8453,
      providerState: "executed",
      state: "unknown",
      hash: fixture.outerHash,
    }));
    const h = harness({ externalObserver: fixture.observer });
    const plan = await h.service.createPlan(
      actor,
      h.draft(true),
      "external-unknown",
      requestHash,
    );
    h.transports.claim(plan.id, [0], "relayr", "relayr-binding");
    h.confirm(fixture.rawOuter);
    h.setNonce(0);
    expect((await h.service.getPlan(actor, plan.id)).steps[0]?.state).toBe(
      "unknown",
    );
    await expect(
      h.service.submitStep(
        actor,
        plan.id,
        1,
        await h.signed({ data: "0xabcd" }),
        "blocked-inner",
        requestHash,
      ),
    ).rejects.toMatchObject({ code: "DEPENDENCIES_UNCONFIRMED" });
    const proof = await externalFixture().observer.observePlanStep();
    fixture.observer.observePlanStep.mockResolvedValue({
      ...proof,
      state: "reverted",
      semantic: { status: "failed" },
    });
    expect((await h.service.getPlan(actor, plan.id)).status).toBe("blocked");
  });

  it("rechecks external canonical receipts and blocks dependencies after reorg despite cached adapter success", async () => {
    const fixture = externalFixture();
    const h = harness({ externalObserver: fixture.observer });
    const plan = await h.service.createPlan(
      actor,
      h.draft(true),
      "external-reorg",
      requestHash,
    );
    h.transports.claim(plan.id, [0], "relayr", "relayr-binding");
    h.confirm(fixture.rawOuter);
    h.setNonce(0);
    expect((await h.service.getPlan(actor, plan.id)).steps[0]?.state).toBe(
      "confirmed",
    );
    h.blockHashes.set(101n, hHash());
    const reorged = await h.service.getPlan(actor, plan.id);
    expect(reorged.steps[0]).toMatchObject({
      state: "reorged",
      receipt: { canonical: false },
    });
    expect(reorged.steps[1]?.blockedBy).toEqual([0]);
    await expect(
      h.service.simulateStep(actor, plan.id, 1),
    ).rejects.toMatchObject({ code: "DEPENDENCIES_UNCONFIRMED" });
  });

  it("requires semantic predicates and invalidates old success when the external verifier becomes unavailable", async () => {
    const fixture = externalFixture();
    const verifier = {
      verify: vi.fn(async () => ({
        status: "unknown" as const,
        details: "Required asset-transfer event missing",
      })),
    };
    const h = harness({ externalObserver: fixture.observer, verifier });
    const plan = await h.service.createPlan(
      actor,
      h.draft(true),
      "external-semantic",
      requestHash,
    );
    h.transports.claim(plan.id, [0], "relayr", "relayr-binding");
    h.confirm(fixture.rawOuter);
    expect(
      (await h.service.getPlan(actor, plan.id)).steps[1]?.blockedBy,
    ).toEqual([0]);
    expect(verifier.verify).toHaveBeenCalled();
    fixture.observer.observePlanStep.mockRejectedValue(
      new Error("External verifier offline"),
    );
    const unavailable = await h.service.getPlan(actor, plan.id);
    expect(unavailable.steps[0]?.state).toBe("unknown");
    expect(unavailable.steps[1]?.blockedBy).toEqual([0]);
  });
});
