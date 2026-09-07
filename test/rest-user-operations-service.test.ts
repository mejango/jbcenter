import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  keccak256,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { MemoryAccountStore } from "../src/rest/auth/memory.js";
import type { BotGrant, RestPrincipal } from "../src/rest/auth/store.js";
import {
  RestError,
  type RestBlockEvidence,
  type RestRpc,
} from "../src/rest/core.js";
import { MemorySessionStore } from "../src/rest/sessions/memory.js";
import type { SessionService } from "../src/rest/sessions/service.js";
import {
  encodeLegacyUseSignature,
  encodeSafe7579OwnerSignature,
} from "../src/rest/smartAccounts/accountExecution.js";
import type { SmartAccountManifest } from "../src/rest/smartAccounts/types.js";
import { MemoryTransactionStore } from "../src/rest/transactions/memory.js";
import { TransactionService } from "../src/rest/transactions/service.js";
import { MemoryTransportReservations } from "../src/rest/transactions/transport-reservations.js";
import type { StoredPlan } from "../src/rest/transactions/types.js";
import { ENTRY_POINT_V07_ABI } from "../src/rest/userOperations/chain.js";
import {
  getUserOperationHash,
  unpackUserOperation,
  packUserOperation,
} from "../src/rest/userOperations/codec.js";
import { MemoryUserOperationStore } from "../src/rest/userOperations/memory.js";
import { UserOperationProvider } from "../src/rest/userOperations/provider.js";
import { UserOperationService } from "../src/rest/userOperations/service.js";
import { assertPlan } from "../src/rest/userOperations/store.js";
import type {
  UserOperationV07,
  UserOperationGasPolicy,
} from "../src/rest/userOperations/types.js";
import {
  account,
  binding,
  entryPoint,
  h,
  owner,
  ownerKey,
  plan,
  safe,
  target,
} from "./fixtures/user-operations.js";
import {
  sessionBinding,
  sessionClaim,
  sessionFixture,
  sessionObservation,
} from "./fixtures/sessions.js";

const testCode = "0x6000" as Hex;
const testCodeHash = keccak256(testCode);
const sessionKey = privateKeyToAccount(`0x${"22".repeat(32)}`);
const wrongKey = privateKeyToAccount(`0x${"33".repeat(32)}`);
const smartSessions = "0x0000000000000000000000000000000000000064" as Address;
const paymaster = "0x000000000000000000000000000000000000006a" as Address;
const txHash = h("service-bundle");
const blockHash = h("service-canonical-block");
const gas: UserOperationGasPolicy = {
  id: "service-gas",
  maximumCallGas: 1_000_000n,
  maximumVerificationGas: 1_000_000n,
  maximumPreVerificationGas: 1_000_000n,
  maximumPaymasterVerificationGas: 1_000_000n,
  maximumPaymasterPostOpGas: 1_000_000n,
  maximumFeePerGas: 100n,
  maximumPriorityFeePerGas: 100n,
  maximumCost: 1_000_000_000n,
  requirePaymaster: false,
};
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Real signatures, services, codecs and stores; only upstream chain/provider I/O is synthetic. */
async function fixture(useSession = false, currentProfile = false) {
  let now = 1_800_000_000_000;
  const blockTimestamp = now / 1000;
  let linked = true;
  let grant: BotGrant | undefined;
  let nonceGate:
    | { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> }
    | undefined;
  const apiAccount = account(now),
    actor = owner(apiAccount),
    wallet = binding(apiAccount, now);
  const authority = new MemoryAccountStore();
  const principal: RestPrincipal = await authority.enroll(apiAccount, {
    accountId: apiAccount.id,
    signer: ownerKey.address,
    grantId: null,
    nonce: h("service-enroll"),
    issuedAt: now / 1000,
    expiresAt: now / 1000 + 60,
    idempotencyKey: null,
    requiredScopes: [],
    ownerOnly: true,
    now: now / 1000,
  });
  const assertLinked = () => {
    if (!linked)
      throw new RestError(
        403,
        "BINDING_REVOKED",
        "The fixture wallet was unlinked.",
      );
  };
  const sessions = new MemorySessionStore(authority, {
    now: () => now,
    assertBinding: assertLinked,
    grant: () => grant ?? null,
  });
  let selectedPrincipal = principal;
  let sessionId: string | undefined;
  if (useSession) {
    const f = sessionFixture(now, { sessionKey: sessionKey.address });
    grant = f.grant;
    await authority.registerBot(grant);
    const created = await sessions.create(
      f.record,
      { key: "session", requestHash: h("session") },
      now,
    );
    const installing = (
      await sessions.claimActivation(sessionClaim(created, now))
    ).record;
    const active = (
      await sessions.observe({
        actor,
        id: created.id,
        expectedRevision: installing.revision,
        expectedObservationHash: null,
        observation: sessionObservation(installing, now, {
          counters: [
            {
              policy: installing.compiled.configurations[1]!.policy.address,
              configId: installing.compiled.configurations[1]!.configId,
              name: "requestedGas",
              used: "0",
              limit: "100000",
            },
            {
              policy: installing.compiled.configurations[1]!.policy.address,
              configId: installing.compiled.configurations[1]!.configId,
              name: "sponsoredCost",
              used: "0",
              limit: "200000",
            },
            {
              policy: installing.compiled.configurations[1]!.policy.address,
              configId: installing.compiled.configurations[1]!.configId,
              name: "calls",
              used: "0",
              limit: "100",
            },
          ],
          evidence: {
            chainId: 1,
            blockNumber: "100",
            blockHash,
            timestamp: String(blockTimestamp),
            source: "onchain",
          },
        }),
        now,
      })
    ).record;
    sessionId = active.id;
    selectedPrincipal = {
      ...principal,
      principalId: f.bot.principalId,
      signer: sessionKey.address,
      grantId: grant.id,
      scopes: grant.scopes,
      isOwner: false,
    };
  }
  const activeActor = {
    accountId: apiAccount.id,
    principalId: selectedPrincipal.principalId,
  };
  const transports = new MemoryTransportReservations();
  const transactionStore = new MemoryTransactionStore(authority, transports);
  const planDocuments = new Map<string, StoredPlan>();
  const store = new MemoryUserOperationStore(authority, transports, {
    now: () => now,
    assertBindingAndSession: (record, clock) => {
      assertLinked();
      assertPlan(record, planDocuments.get(record.planId)!, clock * 1000);
      sessions.assertUserOperationLifecyclePlan(
        record.actor,
        planDocuments.get(record.planId)!,
        clock,
      );
      if (record.session)
        sessions.assertUserOperationSession(
          record.actor,
          record.session,
          record.accountBindingId,
          record.chainId,
          record.sender,
          clock,
        );
    },
  });
  const pin = (address: Address) => ({
    address,
    runtimeCodeHash: testCodeHash,
    source: {
      repository: "https://example.test/fixture-only",
      commit: "1".repeat(40),
      artifactSha256: "2".repeat(64),
    },
  });
  const manifest: SmartAccountManifest = {
    id: wallet.manifestId,
    mode: "execution-candidate",
    chainId: 1,
    revision: wallet.state.manifestRevision,
    safeVersion: "1.4.1",
    proxyRuntimeCodeHash: testCodeHash,
    singleton: pin(target),
    factory: pin(target),
    safe7579: pin(target),
    launchpad: pin(target),
    entryPoint: { ...pin(entryPoint), version: "0.7" },
    smartSessions: { ...pin(smartSessions), generation: "legacy-validator" },
    policies: [],
    moduleInspectorId: "fixture-inspector",
  };
  const state = {
    nonceSequence: 0n,
    sendFailure: false,
    mined: false,
    validationFailure: false,
    signed: undefined as UserOperationV07 | undefined,
    sends: 0,
    nonceCalls: 0,
    stubFinal: false,
    providerHint: txHash,
    sessionProofFailure: false,
    estimatedCallGas: "0x64" as Hex,
    finalQuotes: 0,
    finalGasGrowth: false,
  };
  const log = (
    index: number,
    address: Address,
    topics: readonly Hex[],
    data: Hex,
  ) => ({
    address,
    topics,
    data,
    transactionHash: txHash,
    blockHash,
    blockNumber: "0x64",
    transactionIndex: "0x0",
    logIndex: toHex(index),
    removed: false,
  });
  const effect = () => log(1, target, [h("effect-event")], "0x");
  const transaction = () => ({
    hash: txHash,
    from: target,
    to: entryPoint,
    input: encodeFunctionData({
      abi: ENTRY_POINT_V07_ABI,
      functionName: "handleOps",
      args: [[packUserOperation(state.signed!)], target],
    }),
    value: "0x0",
    chainId: "0x1",
    blockHash,
    blockNumber: "0x64",
    transactionIndex: "0x0",
  });
  const receipt = () => ({
    transactionHash: txHash,
    from: target,
    to: entryPoint,
    blockHash,
    blockNumber: "0x64",
    transactionIndex: "0x0",
    status: "0x1",
    logs: [
      log(
        0,
        entryPoint,
        encodeEventTopics({
          abi: ENTRY_POINT_V07_ABI,
          eventName: "BeforeExecution",
        }) as Hex[],
        "0x",
      ),
      effect(),
      log(
        2,
        entryPoint,
        encodeEventTopics({
          abi: ENTRY_POINT_V07_ABI,
          eventName: "UserOperationEvent",
          args: {
            userOpHash: getUserOperationHash(state.signed!, entryPoint, 1),
            sender: safe,
            paymaster: state.signed!.paymaster ?? zeroAddress,
          },
        }) as Hex[],
        encodeAbiParameters(
          [
            { type: "uint256" },
            { type: "bool" },
            { type: "uint256" },
            { type: "uint256" },
          ],
          [BigInt(state.signed!.nonce), true, 100n, 100n],
        ),
      ),
    ],
  });
  const rpc = vi.fn<RestRpc["request"]>(async (_chain, method, params) => {
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_blockNumber") return "0x70";
    if (method === "eth_getBlockByNumber")
      return {
        number: "0x64",
        hash: blockHash,
        timestamp: toHex(blockTimestamp),
        baseFeePerGas: "0x0",
      };
    if (method === "eth_maxPriorityFeePerGas") return "0x1";
    if (method === "eth_getCode") return testCode;
    if (method === "eth_getBalance") return toHex(10n ** 18n);
    if (method === "eth_getTransactionByHash")
      return state.mined ? transaction() : null;
    if (method === "eth_getTransactionReceipt")
      return state.mined ? receipt() : null;
    if (method === "eth_call") {
      const call = params[0] as { to: Address; data: Hex };
      if (call.to.toLowerCase() === safe) return "0x";
      const decoded = decodeFunctionData({
        abi: ENTRY_POINT_V07_ABI,
        data: call.data,
      });
      if (decoded.functionName === "getNonce") {
        state.nonceCalls++;
        if (nonceGate) {
          const wait = nonceGate;
          nonceGate = undefined;
          wait.entered.open();
          await wait.release.promise;
        }
        return encodeFunctionResult({
          abi: ENTRY_POINT_V07_ABI,
          functionName: "getNonce",
          result: (decoded.args[1] << 64n) | state.nonceSequence,
        });
      }
      if (decoded.functionName === "getUserOpHash")
        return encodeFunctionResult({
          abi: ENTRY_POINT_V07_ABI,
          functionName: "getUserOpHash",
          result: getUserOperationHash(
            unpackUserOperation(decoded.args[0]),
            entryPoint,
            1,
          ),
        });
      if (decoded.functionName === "balanceOf")
        return encodeFunctionResult({
          abi: ENTRY_POINT_V07_ABI,
          functionName: "balanceOf",
          result: 10n ** 18n,
        });
      if (decoded.functionName === "handleOps" && state.validationFailure)
        throw new Error("EntryPoint rejected signature");
      return "0x";
    }
    throw new Error(`Unexpected RPC ${method}`);
  });
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    let result: unknown;
    switch (body.method) {
      case "eth_chainId":
        result = "0x1";
        break;
      case "eth_supportedEntryPoints":
        result = [entryPoint];
        break;
      case "eth_estimateUserOperationGas":
        result = {
          callGasLimit: state.estimatedCallGas,
          verificationGasLimit:
            state.finalGasGrowth && state.finalQuotes === 1 ? "0x65" : "0x64",
          preVerificationGas:
            state.finalGasGrowth && state.finalQuotes === 1 ? "0x65" : "0x64",
        };
        break;
      case "pm_getPaymasterStubData":
      case "pm_getPaymasterData":
        if (body.method === "pm_getPaymasterData") state.finalQuotes++;
        result = {
          paymaster,
          paymasterData: currentProfile && body.method === "pm_getPaymasterData"
            ? toHex(0x1234 + state.finalQuotes, { size: 2 })
            : "0x1234",
          paymasterVerificationGasLimit: "0x64",
          paymasterPostOpGasLimit: "0x0",
          ...(body.method === "pm_getPaymasterStubData" && state.stubFinal
            ? { isFinal: true }
            : {}),
        };
        break;
      case "eth_sendUserOperation":
        state.sends++;
        state.signed = body.params[0];
        if (state.sendFailure)
          throw new Error("Connection lost after accepting the operation");
        result = getUserOperationHash(state.signed!, entryPoint, 1);
        break;
      case "eth_getUserOperationReceipt":
        result = state.mined
          ? {
              userOpHash: body.params[0],
              receipt: { transactionHash: state.providerHint },
            }
          : null;
        break;
      default:
        throw new Error(`Unexpected provider ${body.method}`);
    }
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  });
  const provider = new UserOperationProvider(
    [
      {
        chainId: 1,
        providerId: "fixture-provider",
        entryPoint: pin(entryPoint),
        bundlerUrl: "https://bundler.example/rpc",
        ...(useSession || currentProfile
          ? {
              paymasterUrl: "https://paymaster.example/rpc",
              paymasterPolicy: {
                id: "fixture-policy",
                ...(currentProfile
                  ? { profile: "pimlico-v7-current-flags" as const }
                  : {}),
                contract: pin(paymaster),
                context: {},
                inspect: () => ({
                  policyId: "fixture-policy",
                  gasOnly: true as const,
                  validAfter: 0,
                  validUntil: now / 1000 + 1000,
                  commitment: h("fixture-sponsor"),
                }),
              },
            }
          : {}),
      },
    ],
    fetcher,
    1000,
    () => now,
  );
  const currentBinding = vi.fn(async () => {
    assertLinked();
    return wallet;
  });
  const historical = vi.fn(async () => {});
  const semantic = vi.fn(async () => ({ status: "verified" as const }));
  let service!: UserOperationService;
  const transactions = new TransactionService({
    store: transactionStore,
    rpc: { request: rpc },
    now: () => now,
    semanticVerifier: { verify: semantic },
    externalObservers: [
      {
        kind: "erc4337",
        observePlanStep: (plan, index, id, options) =>
          service.observePlanStep(plan, index, id, options),
      },
    ],
  });
  const executionBinding = vi.fn(
    async (
      _principal: RestPrincipal,
      id: string,
      _signal?: AbortSignal,
      evidence?: RestBlockEvidence,
    ) => {
      let current = await sessions.get(activeActor, id);
      if (!current) throw new Error("Missing fixture session");
      if (evidence) {
        if (state.sessionProofFailure)
          throw new RestError(
            409,
            "SESSION_OBSERVATION_CHANGED",
            "Canonical session proof changed.",
          );
        current = (
          await sessions.observe({
            actor,
            id,
            expectedRevision: current.revision,
            expectedObservationHash: current.observation!.proofHash,
            observation: sessionObservation(current, now, {
              evidence,
              counters: current.observation!.installed.counters,
            }),
            now,
          })
        ).record;
      }
      const exact = sessionBinding(current);
      sessions.assertUserOperationSession(
        activeActor,
        exact,
        wallet.id,
        1,
        safe,
        Math.floor(now / 1000),
      );
      return { record: current, binding: exact };
    },
  );
  const sessionInspector = {
    assertOwnerPlan: async (_principal: RestPrincipal, stored: StoredPlan) =>
      sessions.assertUserOperationLifecyclePlan(
        activeActor,
        stored,
        Math.floor(now / 1000),
      ),
    executionBinding,
  } as unknown as SessionService;
  service = new UserOperationService({
    rpc: { request: rpc },
    provider,
    store,
    transactionStore,
    transactions,
    ...(useSession ? { sessions: sessionInspector } : {}),
    policies: [{ chainId: 1, gas, confirmations: 1 }],
    currentBinding,
    currentBindingAt: currentBinding,
    manifestFor: () => manifest,
    manifestForPlan: () => manifest,
    verifyHistoricalAccount: historical,
    semanticVerifier: { verify: semantic },
    now: () => now,
    authorizeRequest: async () => ({
      issuedAt: Math.floor(now / 1000),
      expiresAt: Math.floor(now / 1000) + 60,
    }),
  });
  async function prepare(id = "service-plan", steps = 1) {
    const stored = plan(id, activeActor, wallet, now, steps);
    planDocuments.set(id, stored);
    if (useSession)
      stored.draft.calls[0]!.data = encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [ownerKey.address, 5n],
      });
    await transactionStore.create(
      stored,
      { key: id, requestHash: h(id), operation: "fixture" },
      now,
    );
    return service.prepare(
      selectedPrincipal,
      {
        planId: id,
        stepIndexes: Array.from({ length: steps }, (_, index) => index),
        ...(sessionId ? { sessionId } : {}),
      },
      id,
      h(id),
    );
  }
  async function sign(
    prepared: Awaited<ReturnType<typeof prepare>>,
    bad = false,
  ) {
    if (prepared.signing.scheme === "eip191-legacy-ownable-user-operation")
      return encodeLegacyUseSignature(
        prepared.signing.permissionId,
        await (bad ? wrongKey : sessionKey).signMessage({
          message: prepared.signing.message,
        }),
      );
    return encodeSafe7579OwnerSignature({
      validAfter: prepared.signing.validAfter,
      validUntil: prepared.signing.validUntil,
      signatures: await (bad ? wrongKey : ownerKey).sign({
        hash: prepared.signing.digest,
      }),
    });
  }
  return {
    service,
    prepare,
    sign,
    store,
    sessions,
    authority,
    transactionStore,
    transactions,
    transports,
    principal: selectedPrincipal,
    activeActor,
    wallet,
    currentBinding,
    executionBinding,
    historical,
    semantic,
    rpc,
    fetcher,
    state,
    effect,
    now: () => now,
    tick: (ms: number) => {
      now += ms;
    },
    unlink: () => {
      linked = false;
    },
    revoke: async () => {
      if (!grant) throw new Error("No grant");
      await authority.revokeBot(
        apiAccount.id,
        grant.id,
        Math.floor(now / 1000),
      );
      grant = { ...grant, revokedAt: Math.floor(now / 1000) };
    },
    waitOnNonce: () => {
      const next = { entered: gate(), release: gate() };
      nonceGate = next;
      return next;
    },
  };
}

describe("UserOperationService integration", () => {
  it("retains sampled submission age during silent provider outages and uncertain receipts, then clears confirmed work", async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    expect((await f.service.recoverPending()).oldestPendingAt).toBeNull();
    f.tick(10_000);
    const submittedAt = f.now();
    await f.service.submit(f.principal, prepared.id, await f.sign(prepared), "age-submit");
    f.tick(31 * 60_000);
    f.fetcher.mockRejectedValueOnce(new Error("Provider receipt outage"));
    expect(await f.service.recoverPending()).toMatchObject({
      oldestPendingAt: submittedAt, items: [{ state: "pending" }], broadcastAttempted: false,
    });
    const rpc = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation(async (chain, method, params, signal) => {
      const result = await rpc(chain, method, params, signal);
      // The head advances while the fixture's historical receipt block stays fixed.
      if (method === "eth_getBlockByNumber" && params[0] === "latest") {
        return { ...(result as object), number: "0x800", hash: h("later-head"), timestamp: toHex(f.now() / 1000) };
      }
      return result;
    });
    f.state.mined = true;
    f.state.providerHint = h("wrong-transaction-hint");
    expect(await f.service.recoverPending()).toMatchObject({
      oldestPendingAt: submittedAt, items: [{ state: "unknown" }],
    });
    f.state.providerHint = txHash;
    expect(await f.service.recoverPending()).toMatchObject({
      oldestPendingAt: null, items: [{ state: "confirmed" }],
    });
    expect(await f.service.recoverPending()).toMatchObject({ oldestPendingAt: null, items: [] });
    expect(f.state.sends).toBe(1);
  });

  it.each([null, false, 0, "", "not-a-session"])(
    "rejects a supplied invalid session selector %j before reading a plan",
    async (sessionId) => {
      const f = await fixture();
      await expect(
        f.service.prepare(
          f.principal,
          { planId: "missing", stepIndexes: [0], sessionId } as never,
          "invalid-selector",
          h("invalid-selector"),
        ),
      ).rejects.toMatchObject({ code: "USER_OPERATION_SESSION_INVALID" });
      expect(f.rpc).not.toHaveBeenCalled();
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );
  it("prepares reviewable owner bytes and broadcasts exactly the externally signed operation", async () => {
    const f = await fixture(),
      prepared = await f.prepare();
    expect(prepared.signing.scheme).toBe("eip712-safe7579-owner");
    const signature = await f.sign(prepared);
    const submitted = await f.service.submit(
      f.principal,
      prepared.id,
      signature,
      "submit",
    );
    expect(submitted.state).toBe("pending");
    expect(f.state.sends).toBe(1);
    expect(f.state.signed).toEqual({ ...prepared.operation, signature });
    expect(f.transports.list(prepared.planId)).toMatchObject([
      { transport: "erc4337", bindingId: prepared.id },
    ]);
    const projection = await f.transactions.getPlan(
      f.activeActor,
      prepared.planId,
    );
    expect(projection.steps[0]).toMatchObject({
      execution: {
        transport: "eip4337-user-operation",
        bindingId: prepared.id,
      },
    });
  });
  it("uses the compiled session nonce and exact session-key signature under durable grant authority", async () => {
    const f = await fixture(true),
      prepared = await f.prepare();
    expect(prepared.signing.scheme).toBe(
      "eip191-legacy-ownable-user-operation",
    );
    expect(BigInt(prepared.operation.nonce) >> 96n).toBe(BigInt(smartSessions));
    expect(prepared.operation.paymaster).toBe(paymaster);
    const signature = await f.sign(prepared);
    const result = await f.service.submit(
      f.principal,
      prepared.id,
      signature,
      "session-submit",
    );
    expect(result.state).toBe("pending");
    expect(
      (await f.store.get(f.activeActor, prepared.id))!.submission!
        .sessionObservationHash,
    ).toBe(prepared.session!.observationHash);
    expect(f.state.sends).toBe(1);
  });
  it.each([false, true])(
    "rejects a wrong %s session signature before provider publication or reservation",
    async (useSession) => {
      const f = await fixture(useSession),
        prepared = await f.prepare();
      await expect(
        f.service.submit(
          f.principal,
          prepared.id,
          await f.sign(prepared, true),
          "wrong-signature",
        ),
      ).rejects.toMatchObject({
        code: useSession
          ? "SMART_SESSION_SIGNATURE_INVALID"
          : "SMART_OWNER_SIGNATURE_INVALID",
      });
      expect(f.state.sends).toBe(0);
      expect(f.transports.list(prepared.planId)).toEqual([]);
      expect(
        (await f.store.get(f.activeActor, prepared.id))!.submission,
      ).toBeUndefined();
    },
  );
  it("never resends an ambiguous submission even after owner unlink and preparation expiry", async () => {
    const f = await fixture(),
      prepared = await f.prepare(),
      signature = await f.sign(prepared);
    f.state.sendFailure = true;
    expect(
      (
        await f.service.submit(
          f.principal,
          prepared.id,
          signature,
          "one-publication",
        )
      ).state,
    ).toBe("submission_unknown");
    f.unlink();
    f.tick(600_000);
    await f.service.submit(
      f.principal,
      prepared.id,
      signature,
      "one-publication",
    );
    expect(f.state.sends).toBe(1);
    await expect(
      f.service.submit(f.principal, prepared.id, signature, "changed-key"),
    ).rejects.toMatchObject({ code: "USER_OPERATION_CONFLICT" });
  });
  it.each(["expiry", "revocation"] as const)(
    "rejects %s during nonce I/O before durable admission",
    async (change) => {
      const f = await fixture(change === "revocation"),
        prepared = await f.prepare(),
        signature = await f.sign(prepared);
      const wait = f.waitOnNonce();
      const submitted = f.service.submit(
        f.principal,
        prepared.id,
        signature,
        "raced",
      );
      const rejected = expect(submitted).rejects.toMatchObject({
        code: change === "expiry" ? "AUTH_EXPIRED" : "SESSION_GRANT_INACTIVE",
      });
      await wait.entered.promise;
      if (change === "expiry") f.tick(61_000);
      else await f.revoke();
      wait.release.open();
      await rejected;
      expect(f.state.sends).toBe(0);
      expect(f.transports.list(prepared.planId)).toEqual([]);
      expect(
        (await f.store.get(f.activeActor, prepared.id))!.submission,
      ).toBeUndefined();
    },
  );
  it("verifies canonical historical execution after unlink and projects the result into its plan", async () => {
    const f = await fixture(),
      prepared = await f.prepare(),
      signature = await f.sign(prepared);
    await f.service.submit(f.principal, prepared.id, signature, "historical");
    f.unlink();
    f.state.mined = true;
    const readsBefore = f.currentBinding.mock.calls.length;
    const result = await f.service.get(f.principal, prepared.id);
    expect(result.state).toBe("confirmed");
    expect(result.observation!.receipt).toMatchObject({
      transactionHash: txHash,
      canonical: true,
      logs: [f.effect()],
    });
    expect(f.currentBinding).toHaveBeenCalledTimes(readsBefore);
    expect(f.historical).toHaveBeenCalledTimes(1);
    const projected = await f.transactions.getPlan(
      f.activeActor,
      prepared.planId,
    );
    expect(projected.steps[0]).toMatchObject({
      state: "confirmed",
      receipt: { transactionHash: txHash, canonical: true },
      semantic: { status: "verified" },
    });
    expect(f.state.sends).toBe(1);
  });
  it("preserves canonical success when the bundler changes its transaction hint", async () => {
    const f = await fixture(),
      prepared = await f.prepare(),
      signature = await f.sign(prepared);
    await f.service.submit(
      f.principal,
      prepared.id,
      signature,
      "canonical-hint",
    );
    f.state.mined = true;
    expect((await f.service.get(f.principal, prepared.id)).state).toBe(
      "confirmed",
    );
    const hintReads = () =>
      f.fetcher.mock.calls.filter(
        ([, init]) =>
          JSON.parse(String(init?.body)).method ===
          "eth_getUserOperationReceipt",
      ).length;
    const before = hintReads();
    f.state.providerHint = h("unrelated-provider-transaction");
    const retained = await f.service.get(f.principal, prepared.id);
    expect(retained.state).toBe("confirmed");
    expect(retained.observation!.transactionHash).toBe(txHash);
    expect(retained.observation!.receipt!.canonical).toBe(true);
    expect(hintReads()).toBe(before);
    expect(f.state.sends).toBe(1);
  });
  it.each([false, true])(
    "requires session proof at the exact preflight block (failure: %s)",
    async (failure) => {
      const f = await fixture(true),
        prepared = await f.prepare(),
        signature = await f.sign(prepared);
      f.tick(1000);
      f.state.sessionProofFailure = failure;
      const submission = f.service.submit(
        f.principal,
        prepared.id,
        signature,
        "same-block",
      );
      if (failure) {
        await expect(submission).rejects.toMatchObject({
          code: "SESSION_OBSERVATION_CHANGED",
        });
        expect(f.state.sends).toBe(0);
        expect(f.transports.list(prepared.planId)).toEqual([]);
        expect(
          (await f.store.get(f.activeActor, prepared.id))!.submission,
        ).toBeUndefined();
      } else {
        expect((await submission).state).toBe("pending");
        const persisted = (await f.store.get(f.activeActor, prepared.id))!;
        const latestSession = (await f.sessions.get(
          f.activeActor,
          prepared.session!.id,
        ))!;
        expect(persisted.session!.observationHash).toBe(
          prepared.session!.observationHash,
        );
        expect(persisted.submission!.sessionObservationHash).toBe(
          latestSession.observation!.proofHash,
        );
        expect(persisted.submission!.sessionObservationHash).not.toBe(
          prepared.session!.observationHash,
        );
      }
      expect(f.executionBinding.mock.calls.at(-1)![3]).toEqual({
        chainId: 1,
        blockNumber: "100",
        blockHash,
        timestamp: "1800000000",
        source: "onchain",
      });
    },
  );
  it("accepts a final paymaster stub without changing its gas fields or requesting another sponsorship", async () => {
    const f = await fixture(true);
    f.state.stubFinal = true;
    const prepared = await f.prepare();
    const methods = f.fetcher.mock.calls.map(
      ([, init]) => JSON.parse(String(init?.body)).method,
    );
    expect(
      methods.filter((method) => method === "pm_getPaymasterStubData"),
    ).toHaveLength(1);
    expect(methods).not.toContain("pm_getPaymasterData");
    expect(
      methods.filter((method) => method === "eth_estimateUserOperationGas"),
    ).toHaveLength(1);
    const stubRequest = f.fetcher.mock.calls
      .map(([, init]) => JSON.parse(String(init?.body)))
      .find((body) => body.method === "pm_getPaymasterStubData");
    expect(prepared.operation.callGasLimit).toBe(
      stubRequest.params[0].callGasLimit,
    );
    expect(prepared.operation.verificationGasLimit).toBe(
      stubRequest.params[0].verificationGasLimit,
    );
    expect(prepared.operation.preVerificationGas).toBe(
      stubRequest.params[0].preVerificationGas,
    );
    expect(BigInt(prepared.operation.callGasLimit)).toBeLessThan(1000n);
    expect(prepared.operation.paymasterVerificationGasLimit).toBe("0x64");
  });
  it.each([false, true])(
    "requotes current sponsorship and stores the exact final estimate for session=%s",
    async (useSession) => {
      const f = await fixture(useSession, true);
      f.state.finalGasGrowth = true;
      const prepared = await f.prepare();
      const bodies = f.fetcher.mock.calls.map(([, init]) =>
        JSON.parse(String(init?.body)),
      );
      const quotes = bodies.filter((body) => body.method === "pm_getPaymasterData");
      const estimates = bodies.filter((body) => body.method === "eth_estimateUserOperationGas");
      expect(quotes).toHaveLength(2);
      expect(estimates).toHaveLength(3);
      expect(quotes[0].params[0].verificationGasLimit).toBe("0x64");
      expect(quotes[1].params[0]).toMatchObject({
        verificationGasLimit: "0x6b",
        preVerificationGas: "0x6b",
        callGasLimit: "0x64",
      });
      for (const quote of quotes) expect(quote.params[0]).not.toHaveProperty("signature");
      expect(prepared.operation).toEqual({
        ...estimates.at(-1).params[0],
        signature: "0x",
      });
      expect(prepared.operation.paymasterData).toBe("0x1236");
      expect(f.state.sends).toBe(0);
      if (useSession)
        for (const estimate of estimates) {
          expect(estimate.params).toHaveLength(3);
          expect(estimate.params[2]).toEqual(estimates[0].params[2]);
        }
    },
  );
  it("does not reuse one effect log to claim independent modeled success for two calls", async () => {
    const f = await fixture(),
      prepared = await f.prepare("two-calls", 2),
      signature = await f.sign(prepared);
    await f.service.submit(f.principal, prepared.id, signature, "batch");
    f.state.mined = true;
    const confirmed = await f.service.get(f.principal, prepared.id);
    expect(confirmed.state).toBe("confirmed");
    expect(f.semantic).toHaveBeenCalledTimes(2);
    expect(confirmed.observation!.receipt!.logs).toEqual([f.effect()]);
    expect(confirmed.observation!.semantic).toMatchObject({
      status: "unknown",
      details: { steps: [{ status: "verified" }, { status: "verified" }] },
    });
  });
  it("fits a session under its original gas cap and uses only five estimation stateDiff words", async () => {
    const f = await fixture(true),
      prepared = await f.prepare();
    const signature = await f.sign(prepared);
    await f.service.submit(f.principal, prepared.id, signature, "bounded-gas");
    const bodies = f.fetcher.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)),
    );
    const estimates = bodies.filter(
      (body) => body.method === "eth_estimateUserOperationGas",
    );
    expect(estimates).toHaveLength(2);
    for (const request of estimates) {
      expect(request.params).toHaveLength(3);
      const overrides = Object.values(request.params[2]) as {
        stateDiff: Record<string, string>;
      }[];
      expect(overrides).toHaveLength(1);
      expect(Object.keys(overrides[0]!)).toEqual(["stateDiff"]);
      expect(Object.keys(overrides[0]!.stateDiff)).toHaveLength(5);
      const op = request.params[0];
      expect(
        BigInt(op.callGasLimit) +
          BigInt(op.verificationGasLimit) +
          BigInt(op.preVerificationGas) +
          BigInt(op.paymasterVerificationGasLimit) +
          BigInt(op.paymasterPostOpGasLimit),
      ).toBeLessThanOrEqual(1000n);
    }
    expect(
      bodies.find((body) => body.method === "eth_sendUserOperation").params,
    ).toHaveLength(2);
    for (const [, method, params] of f.rpc.mock.calls)
      if (method === "eth_call") expect(params).toHaveLength(2);
    expect(prepared.operation).not.toHaveProperty("stateOverrides");
  });
  it("rejects estimates exceeding the original session cap before final sponsorship or publication", async () => {
    const f = await fixture(true);
    f.state.estimatedCallGas = "0x3e8";
    await expect(f.prepare()).rejects.toMatchObject({
      code: "SESSION_GAS_ESTIMATE_EXCEEDS_BUDGET",
    });
    const methods = f.fetcher.mock.calls.map(
      ([, init]) => JSON.parse(String(init?.body)).method,
    );
    expect(methods).not.toContain("pm_getPaymasterData");
    expect(methods).not.toContain("eth_sendUserOperation");
  });
});
