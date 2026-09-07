import { describe, expect, it, vi } from "vitest";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ContractCatalog } from "../src/rest/contracts/catalog.js";
import { RestError, type RestActor, type RestRpc } from "../src/rest/core.js";
import { MemoryTransactionStore } from "../src/rest/transactions/memory.js";
import { MemoryTransportReservations } from "../src/rest/transactions/transport-reservations.js";
import type { StoredPlan } from "../src/rest/transactions/types.js";
import {
  MemorySponsorshipStore,
  RelayrSponsorshipService,
  type RelayrSponsorshipOptions,
} from "../src/rest/sponsorship/index.js";
import {
  FORWARDER_ABI,
  FORWARD_REQUEST_TYPES,
  RELAYR_NATIVE_TOKEN,
  RELAYR_PAYMENT_ADDRESS,
  RELAYR_PAYMENT_CODE_HASH,
} from "../src/rest/sponsorship/constants.js";
import type {
  RelayrEntry,
  SponsorshipPolicy,
} from "../src/rest/sponsorship/types.js";

// Public fixture keys only; signatures never leave the injected offline provider.
const owner = privateKeyToAccount(`0x${"11".repeat(32)}`);
const bot = privateKeyToAccount(`0x${"22".repeat(32)}`);
const TARGET = "0x3333333333333333333333333333333333333333" as Address;
const FORWARDER = "0x4444444444444444444444444444444444444444" as Address;
const BLOCK = `0x${"ab".repeat(32)}` as Hex;
const CODE = "0x6001600055" as Hex;
const PAYMENT_CODE =
  "0x608060405260043610156010575f80fd5b5f3560e01c63103903a7146022575f80fd5b604036600319011260ef576004356fffffffffffffffffffffffffffffffff19811680910360ef5760243564ffffffffff811680910360ef5780421160ce575f341560c6575b5f8080809373755ff2f75a0a586ecfa2b9a3c959cb662458a1053491f11560bb5760407fb96b060a9c075a83da0cf1f9405deeb5df21df681a762de16c3d5eaf99531cd8918151903482526020820152a2005b6040513d5f823e3d90fd5b506108fc6068565b90630f01bd8760e21b5f5260045260245264ffffffffff421660445260645ffd5b5f80fdfea26469706673582212206ea0d2ba1e0cb26cc9293b24f1a7aecc1de7e328ca83d6b3bf5382ac44c7390064736f6c634300081a0033" as Hex;
const BUNDLE = "a0a555ff-4444-4111-aaaa-333333333333";
const TX_ID = "b0a555ff-4444-4111-aaaa-333333333333";
const hex = (value: number | bigint): Hex => `0x${BigInt(value).toString(16)}`;

async function fixture(
  policy: Partial<SponsorshipPolicy> = {},
  authorizeDispatch?: RelayrSponsorshipOptions["authorizeDispatch"],
) {
  let now = Math.floor(Date.now() / 1000) * 1000;
  const actor: RestActor = {
    accountId: `eip155:1:${owner.address.toLowerCase()}`,
    principalId: "fixture-bot",
  };
  const flags = {
    revoked: false,
    trusts: true,
    nonce: 0n,
    code: CODE,
    targetCode: CODE,
    ownerCode: "0x" as Hex,
    paymentCode: PAYMENT_CODE,
    domainChain: 1n,
    quoteFailure: false,
    paymentDeadline: Math.floor(now / 1000) + 300,
    providerState: "Success",
  };
  let lock = Promise.resolve<unknown>(undefined);
  const authority = {
    withActiveActor: async <T>(
      _actor: RestActor,
      _scopes: unknown,
      _time: number,
      operation: () => Promise<T>,
    ) => {
      const next = lock.then(() => {
        if (flags.revoked)
          throw new RestError(403, "REVOKED", "Revoked fixture");
        return operation();
      });
      lock = next.catch(() => {});
      return next;
    },
  };
  const reservations = new MemoryTransportReservations();
  const transactionStore = new MemoryTransactionStore(authority, reservations);
  const store = new MemorySponsorshipStore(authority, reservations);
  const plan: StoredPlan = {
    id: "fixture-plan",
    actor,
    draft: {
      operation: "fixture",
      account: owner.address,
      calls: [
        {
          chainId: 1,
          to: TARGET,
          data: "0x12345678",
          value: "0",
          dependsOn: [],
          label: "Reviewed call",
          decoded: {},
        },
      ],
      evidence: [
        {
          chainId: 1,
          blockNumber: "100",
          blockHash: BLOCK,
          timestamp: String(now / 1000),
          source: "onchain",
        },
      ],
      summary: {},
      warnings: [],
    },
    commitment: `0x${"cd".repeat(32)}`,
    createdAt: now,
    expiresAt: now + 60_000,
    revision: 0,
    steps: [{ index: 0, state: "waiting" }],
  };
  await transactionStore.create(
    plan,
    { key: "source", requestHash: "fixture", operation: "create" },
    now,
  );
  const rpc = vi.fn<RestRpc["request"]>(async (chainId, method, params) => {
    if (method === "eth_chainId") return hex(chainId);
    if (method === "eth_getBlockByNumber")
      return {
        number: "0x64",
        hash: BLOCK,
        timestamp: hex(Math.floor(now / 1000)),
      };
    if (method === "eth_getCode") {
      const address = String(params[0]).toLowerCase();
      if (address === FORWARDER.toLowerCase()) return flags.code;
      if (address === TARGET.toLowerCase()) return flags.targetCode;
      if (address === RELAYR_PAYMENT_ADDRESS) return flags.paymentCode;
      return flags.ownerCode;
    }
    if (method === "eth_estimateGas") return "0xc350";
    if (
      method === "eth_getTransactionReceipt" ||
      method === "eth_getTransactionByHash"
    )
      return null;
    if (method === "eth_call") {
      const call = params[0] as { to: Address; data: Hex };
      let decoded;
      try {
        decoded = decodeFunctionData({ abi: FORWARDER_ABI, data: call.data });
      } catch {
        return "0x";
      }
      if (decoded.functionName === "eip712Domain")
        return encodeFunctionResult({
          abi: FORWARDER_ABI,
          functionName: "eip712Domain",
          result: [
            "0x0f",
            "Juicebox",
            "1",
            flags.domainChain,
            FORWARDER,
            `0x${"0".repeat(64)}`,
            [],
          ],
        });
      if (decoded.functionName === "nonces")
        return encodeFunctionResult({
          abi: FORWARDER_ABI,
          functionName: "nonces",
          result: flags.nonce,
        });
      if (decoded.functionName === "isTrustedForwarder")
        return encodeFunctionResult({
          abi: FORWARDER_ABI,
          functionName: "isTrustedForwarder",
          result: flags.trusts,
        });
      if (decoded.functionName === "verify")
        return encodeFunctionResult({
          abi: FORWARDER_ABI,
          functionName: "verify",
          result: true,
        });
      return "0x";
    }
    throw new Error(`Unexpected RPC ${method}`);
  });
  // This fixture models the catalog port with a small independently hashed runtime.
  const catalog = {
    list: () => [
      {
        name: "ERC2771Forwarder",
        executable: true,
        deployments: [
          {
            chainId: 1,
            instances: [{ address: FORWARDER, codeId: "fixture" }],
          },
        ],
      },
    ],
    code: () => ({
      runtimeTemplate: CODE,
      runtimeTemplateKeccak256: keccak256(CODE),
      runtimeTemplateByteLength: (CODE.length - 2) / 2,
      id: "fixture",
      immutableReferences: [],
      linkReferences: [],
      compilerEvidence: null,
    }),
  } as unknown as ContractCatalog;
  let posted: RelayrEntry[] = [];
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === "POST") {
      posted = JSON.parse(String(init.body)).transactions as RelayrEntry[];
      if (flags.quoteFailure) throw new Error("private provider detail");
      const encoded = encodeAbiParameters(
        [{ type: "bytes16" }, { type: "uint40" }],
        [`0x${BUNDLE.replaceAll("-", "")}`, flags.paymentDeadline],
      );
      return Response.json({
        bundle_uuid: BUNDLE,
        tx_uuids: [TX_ID],
        payment_info: [
          {
            chain: 1,
            target: RELAYR_PAYMENT_ADDRESS,
            token: RELAYR_NATIVE_TOKEN,
            amount: "123",
            calldata: `0x103903a7${encoded.slice(2)}`,
            payment_deadline: String(flags.paymentDeadline),
          },
        ],
      });
    }
    return Response.json({
      bundle_uuid: BUNDLE,
      transactions: posted.map((entry) => ({
        tx_uuid: TX_ID,
        request: entry,
        status: { state: flags.providerState },
      })),
    });
  });
  const service = new RelayrSponsorshipService({
    rpc: { request: rpc },
    catalog,
    store,
    transactionStore,
    fetch: fetcher,
    now: () => now,
    policy: { enabled: true, ...policy },
    ...(authorizeDispatch ? { authorizeDispatch } : {}),
  });
  const prepare = () => service.prepare(actor, plan.id, {}, "prepare");
  const sign = async (
    prepared: Awaited<ReturnType<typeof prepare>>,
    signer = owner,
  ) =>
    Promise.all(
      prepared.authorizations.map(async (value) =>
        signer.signTypedData({
          domain: value.domain,
          types: FORWARD_REQUEST_TYPES,
          primaryType: "ForwardRequest",
          message: {
            ...value.message,
            value: BigInt(value.message.value),
            gas: BigInt(value.message.gas),
            nonce: BigInt(value.message.nonce),
            deadline: Number(value.message.deadline),
          },
        }),
      ),
    );
  return {
    actor,
    flags,
    service,
    store,
    transactionStore,
    reservations,
    rpc,
    fetcher,
    plan,
    prepare,
    sign,
    setNow: (value: number) => {
      now = value;
    },
    now: () => now,
  };
}

async function knownExecution(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  executions: { hash: Hex; success: boolean }[],
) {
  const record = (await f.store.get(f.actor, id))!;
  const entry = record.submission!.entries[0]!;
  const transaction = (hash: Hex) => ({
    hash,
    from: bot.address,
    to: entry.target,
    input: entry.data,
    value: hex(BigInt(entry.value)),
    chainId: "0x1",
    blockNumber: "0x64",
    blockHash: BLOCK,
    transactionIndex: "0x0",
  });
  const receipt = (hash: Hex, success: boolean) => ({
    transactionHash: hash,
    from: bot.address,
    to: entry.target,
    blockNumber: "0x64",
    blockHash: BLOCK,
    transactionIndex: "0x0",
    status: success ? "0x1" : "0x0",
    logs: success
      ? [
          {
            address: FORWARDER,
            topics: encodeEventTopics({
              abi: FORWARDER_ABI,
              eventName: "ExecutedForwardRequest",
              args: { signer: owner.address },
            }),
            data: encodeAbiParameters(
              [{ type: "uint256" }, { type: "bool" }],
              [0n, true],
            ),
            transactionHash: hash,
            blockNumber: "0x64",
            blockHash: BLOCK,
            transactionIndex: "0x0",
            logIndex: "0x0",
            removed: false,
          },
        ]
      : [],
  });
  const original = f.rpc.getMockImplementation()!;
  f.rpc.mockImplementation(async (...args) => {
    const execution = executions.find((value) => value.hash === args[2][0]);
    if (args[1] === "eth_getTransactionByHash" && execution)
      return transaction(execution.hash);
    if (args[1] === "eth_getTransactionReceipt" && execution)
      return receipt(execution.hash, execution.success);
    return original(...args);
  });
  await f.store.observe(id, record.revision, [
    {
      stepIndex: 0,
      chainId: 1,
      providerState: "stored",
      state: "pending",
      hash: executions[0]!.hash,
    },
  ]);
  return record;
}

describe("Relayr sponsorship service", () => {
  it.each(["publication", "owner-approval"] as const)(
    "does not expose signatures when the %s window expires during original-plan tagging",
    async (mode) => {
      const current = Math.floor(Date.now() / 1000);
      const f = await fixture(
        {},
        mode === "owner-approval"
          ? async () => ({ issuedAt: current, expiresAt: current + 5 })
          : undefined,
      );
      const prepared = await f.prepare();
      const original = f.transactionStore.reserveExternalExecution.bind(
        f.transactionStore,
      );
      vi.spyOn(
        f.transactionStore,
        "reserveExternalExecution",
      ).mockImplementation(async (...args) => {
        const result = await original(...args);
        f.setNow(f.now() + (mode === "publication" ? 61_000 : 6_000));
        return result;
      });
      const result = await f.service.submit(
        f.actor,
        prepared.id,
        { signatures: await f.sign(prepared) },
        "submit",
      );
      expect(result.state).toBe("submission_unknown");
      expect(f.fetcher).not.toHaveBeenCalled();
      expect(() =>
        f.reservations.claim(f.plan.id, [0], "direct", `0x${"dd".repeat(32)}`),
      ).toThrow();
    },
  );
  it("prepares a separate exact execution commitment and stable idempotent signing payload", async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    const calls = f.rpc.mock.calls.length;
    expect(prepared.authorizations[0]!.message).toMatchObject({
      from: owner.address,
      to: TARGET,
      data: "0x12345678",
      value: "0",
      nonce: "0",
    });
    expect(
      Number(prepared.authorizations[0]!.message.deadline) * 1000,
    ).toBeGreaterThan(prepared.publicationExpiresAt);
    expect(prepared.authorizationNotice).toContain(
      "cannot revoke a published signature",
    );
    expect(await f.prepare()).toEqual(prepared);
    expect(f.rpc.mock.calls).toHaveLength(calls);
    expect(f.fetcher).not.toHaveBeenCalled();
    await expect(
      f.service.prepare(f.actor, f.plan.id, { stepIndexes: [0] }, "prepare"),
    ).rejects.toMatchObject({ code: "SPONSORSHIP_CONFLICT" });
  });
  it("publishes exactly once, reserves the original journey and returns only authenticated funding", async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    const signatures = await f.sign(prepared);
    const results = await Promise.all([
      f.service.submit(f.actor, prepared.id, { signatures }, "submit"),
      f.service.submit(f.actor, prepared.id, { signatures }, "submit"),
    ]);
    expect(
      f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    expect(results.some((result) => result.state === "quoted")).toBe(true);
    const stored = await f.transactionStore.get(f.actor, f.plan.id);
    expect(stored!.steps[0]!.externalExecution).toMatchObject({
      transport: "relayr",
      bindingId: prepared.id,
    });
    expect(stored!.steps[0]!.attempt).toBeUndefined();
    const again = await f.service.submit(
      f.actor,
      prepared.id,
      { signatures },
      "submit",
    );
    expect(again.quote!.payments[0]!.to).toBe(RELAYR_PAYMENT_ADDRESS);
    expect(JSON.stringify(again)).not.toContain(signatures[0]);
    expect(() =>
      f.reservations.claim(f.plan.id, [0], "direct", `0x${"dd".repeat(32)}`),
    ).toThrow();
  });
  it("never substitutes a registered bot signature for the owner transaction signature", async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    await expect(
      f.service.submit(
        f.actor,
        prepared.id,
        { signatures: await f.sign(prepared, bot) },
        "submit",
      ),
    ).rejects.toMatchObject({ code: "FORWARD_SIGNATURE_ACCOUNT_MISMATCH" });
    expect(f.fetcher).not.toHaveBeenCalled();
    expect((await f.store.get(f.actor, prepared.id))!.state).toBe("prepared");
  });
  it.each(["nonce", "code", "targetCode", "trusts"] as const)(
    "refuses publication when %s changed after owner review",
    async (field) => {
      const f = await fixture();
      const prepared = await f.prepare();
      const signatures = await f.sign(prepared);
      if (field === "nonce") f.flags.nonce = 1n;
      else if (field === "trusts") f.flags.trusts = false;
      else f.flags[field] = "0x6002600055";
      await expect(
        f.service.submit(f.actor, prepared.id, { signatures }, "submit"),
      ).rejects.toMatchObject({ code: "FORWARD_REQUEST_CHANGED" });
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );
  it("checks API revocation at the durable publication boundary", async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    const signatures = await f.sign(prepared);
    f.flags.revoked = true;
    await expect(
      f.service.submit(f.actor, prepared.id, { signatures }, "submit"),
    ).rejects.toMatchObject({ code: "REVOKED" });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("requires fresh owner publication approval and does not ask again for a nondispatching replay", async () => {
    const approve = vi.fn(async () => ({
      issuedAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + 120,
    }));
    const f = await fixture({}, approve);
    const prepared = await f.prepare();
    const signatures = await f.sign(prepared);
    await f.service.submit(f.actor, prepared.id, { signatures }, "submit");
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({
        id: prepared.id,
        actor: f.actor,
        commitment: prepared.commitment,
      }),
      expect.stringMatching(/^0x[0-9a-f]{64}$/),
    );
    expect(
      f.service.capabilities().signing.freshPublicationApprovalRequired,
    ).toBe(true);
    approve.mockRejectedValue(new Error("Approval is no longer available"));
    await f.service.submit(f.actor, prepared.id, { signatures }, "submit");
    expect(approve).toHaveBeenCalledTimes(1);
    expect(
      f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  });
  it.each(["expired", "future", "too-long", "denied"] as const)(
    "refuses %s publication approval before reserving or exposing signatures",
    async (mode) => {
      const now = Math.floor(Date.now() / 1000);
      const approve = vi.fn(async () => {
        if (mode === "denied")
          throw new RestError(
            403,
            "OWNER_APPROVAL_REQUIRED",
            "Fresh owner approval required",
          );
        return {
          issuedAt: mode === "future" ? now + 60 : now,
          expiresAt:
            mode === "expired"
              ? now
              : mode === "too-long"
                ? now + 301
                : now + 120,
        };
      });
      const f = await fixture({}, approve);
      const prepared = await f.prepare();
      await expect(
        f.service.submit(
          f.actor,
          prepared.id,
          { signatures: await f.sign(prepared) },
          "submit",
        ),
      ).rejects.toBeInstanceOf(RestError);
      expect(f.fetcher).not.toHaveBeenCalled();
      expect(
        (await f.store.get(f.actor, prepared.id))!.submission,
      ).toBeUndefined();
      expect(() =>
        f.reservations.claim(f.plan.id, [0], "direct", `0x${"dd".repeat(32)}`),
      ).not.toThrow();
    },
  );
  it("keeps ambiguous publication permanent across a repeated submit", async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    const signatures = await f.sign(prepared);
    f.flags.quoteFailure = true;
    const first = await f.service.submit(
      f.actor,
      prepared.id,
      { signatures },
      "submit",
    );
    expect(first.state).toBe("submission_unknown");
    expect(first.recovery).toContain("never repeats");
    f.flags.quoteFailure = false;
    expect(
      (await f.service.submit(f.actor, prepared.id, { signatures }, "submit"))
        .state,
    ).toBe("submission_unknown");
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    await expect(
      f.service.submit(f.actor, prepared.id, { signatures }, "another"),
    ).rejects.toMatchObject({ code: "SPONSORSHIP_CONFLICT" });
  });
  it("preserves a known quote UUID when runtime verification is unavailable, without exposing funding calldata", async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    f.flags.paymentCode = "0x6000";
    const result = await f.service.submit(
      f.actor,
      prepared.id,
      { signatures: await f.sign(prepared) },
      "submit",
    );
    expect(result.quote!.bundleUuid).toBe(BUNDLE);
    expect(result.quote!.payments).toEqual([]);
    expect(result.availability).toBe("requires_verification");
    await expect(
      f.service.prepareFunding(f.actor, prepared.id, {
        chainId: 1,
        payer: owner.address,
      }),
    ).rejects.toMatchObject({ code: "RELAYR_PAYMENT_RUNTIME" });
    f.flags.paymentCode = PAYMENT_CODE;
    expect(
      (
        await f.service.prepareFunding(f.actor, prepared.id, {
          chainId: 1,
          payer: owner.address,
        })
      ).calls[0]!.to,
    ).toBe(RELAYR_PAYMENT_ADDRESS);
  });
  it.each(["cost", "expiry"] as const)(
    "preserves structurally authenticated recovery identity when funding %s is ineligible",
    async (mode) => {
      const f = await fixture(
        mode === "cost" ? { maximumFundingValue: 100n } : {},
      );
      const prepared = await f.prepare();
      if (mode === "expiry")
        f.flags.paymentDeadline = Math.floor(f.now() / 1000) + 20;
      const quoted = await f.service.submit(
        f.actor,
        prepared.id,
        { signatures: await f.sign(prepared) },
        "submit",
      );
      expect(quoted.quote!.bundleUuid).toBe(BUNDLE);
      expect(quoted.quote!.payments).toEqual([]);
      expect(quoted.state).toBe("quoted");
      await expect(
        f.service.prepareFunding(f.actor, prepared.id, {
          chainId: 1,
          payer: owner.address,
        }),
      ).rejects.toMatchObject({
        code: mode === "cost" ? "RELAYR_FUNDING_LIMIT" : "RELAYR_QUOTE_EXPIRED",
      });
      expect(
        (await f.service.refresh(f.actor, prepared.id)).observations[0]!.state,
      ).toBe("pending");
    },
  );
  it("withholds funding when the provider cannot reproduce its exact stored transaction binding", async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    const original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (...args) => {
      const response = await original(...args);
      if (args[1]?.method !== "GET") return response;
      const value = await response.json();
      value.transactions[0].request.target = TARGET;
      return Response.json(value);
    });
    const result = await f.service.submit(
      f.actor,
      prepared.id,
      { signatures: await f.sign(prepared) },
      "submit",
    );
    expect(result.quote!.bundleUuid).toBe(BUNDLE);
    expect(result.quote!.payments).toEqual([]);
    await expect(
      f.service.prepareFunding(f.actor, prepared.id, {
        chainId: 1,
        payer: owner.address,
      }),
    ).rejects.toMatchObject({ code: "RELAYR_INVALID_STATUS" });
  });
  it("returns an unsigned draft for an explicit independent sponsor, without granting signing authority", async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    await f.service.submit(
      f.actor,
      prepared.id,
      { signatures: await f.sign(prepared) },
      "submit",
    );
    const draft = await f.service.prepareFunding(f.actor, prepared.id, {
      chainId: 1,
      payer: bot.address,
    });
    expect(draft.account).toBe(bot.address);
    expect(draft.calls[0]!.value).toBe("123");
    expect(draft.summary).toMatchObject({
      bundleUuid: BUNDLE,
      externallySignedFundingOnly: true,
    });
    expect(
      f.rpc.mock.calls.some(
        ([, method]) => method === "eth_sendRawTransaction",
      ),
    ).toBe(false);
    const simulation = f.rpc.mock.calls
      .filter(
        ([, method, params]) =>
          method === "eth_call" &&
          (params[0] as { to?: string }).to === RELAYR_PAYMENT_ADDRESS,
      )
      .at(-1)!;
    expect(simulation[2][0]).toMatchObject({
      from: bot.address,
      value: "0x7b",
      gas: "0x249f0",
    });
  });
  it("does not confuse provider success with destination success", async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    await f.service.submit(
      f.actor,
      prepared.id,
      { signatures: await f.sign(prepared) },
      "submit",
    );
    const result = await f.service.refresh(f.actor, prepared.id);
    expect(result.observations[0]!.state).toBe("pending");
    expect(result.economicCompletion).toBe(false);
    expect(result.availability).toBe("funding_quote_available");
    expect(result.fundingNotice).toContain("already funded");
  });
  it("rechecks canonical successful forwarding independently during a provider outage", async () => {
    const f = await fixture({ confirmations: 1 });
    const prepared = await f.prepare();
    await f.service.submit(
      f.actor,
      prepared.id,
      { signatures: await f.sign(prepared) },
      "submit",
    );
    const hash = `0x${"ed".repeat(32)}` as Hex;
    await knownExecution(f, prepared.id, [{ hash, success: true }]);
    f.fetcher.mockClear().mockRejectedValue(new Error("Provider unavailable"));
    const result = await f.service.refresh(f.actor, prepared.id);
    expect(result.observations[0]).toMatchObject({
      hash,
      state: "confirmed",
      receipt: { canonical: true, logsStored: false, logs: [] },
    });
    expect(result.availability).toBe("execution_verified");
    expect(result.economicCompletion).toBe(false);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("preserves a proven revert during provider outage and recognizes a later exact successful retry", async () => {
    const f = await fixture({ confirmations: 1 });
    const prepared = await f.prepare();
    await f.service.submit(
      f.actor,
      prepared.id,
      { signatures: await f.sign(prepared) },
      "submit",
    );
    const oldHash = `0x${"ed".repeat(32)}` as Hex;
    const retryHash = `0x${"ef".repeat(32)}` as Hex;
    const record = await knownExecution(f, prepared.id, [
      { hash: oldHash, success: false },
      { hash: retryHash, success: true },
    ]);
    f.fetcher.mockRejectedValue(new Error("Provider unavailable"));
    const plan = (await f.transactionStore.get(f.actor, f.plan.id))!;
    expect(await f.service.observePlanStep(plan, 0, prepared.id)).toMatchObject(
      { hash: oldHash, state: "reverted" },
    );
    f.fetcher.mockResolvedValue(
      Response.json({
        bundle_uuid: BUNDLE,
        transactions: [
          {
            tx_uuid: TX_ID,
            request: record.submission!.entries[0],
            status: { state: "Success", data: { hash: retryHash } },
          },
        ],
      }),
    );
    expect(await f.service.observePlanStep(plan, 0, prepared.id)).toMatchObject(
      { hash: retryHash, state: "confirmed" },
    );
  });
  it("does not return a funding draft that expired during final RPC verification", async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    await f.service.submit(
      f.actor,
      prepared.id,
      { signatures: await f.sign(prepared) },
      "submit",
    );
    const original = f.rpc.getMockImplementation()!;
    let paymentSimulated = false;
    f.rpc.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (
        args[1] === "eth_call" &&
        (args[2][0] as { to?: string }).to === RELAYR_PAYMENT_ADDRESS
      )
        paymentSimulated = true;
      if (
        paymentSimulated &&
        args[1] === "eth_getBlockByNumber" &&
        args[2][0] === "0x64"
      )
        f.setNow(f.now() + 301_000);
      return result;
    });
    await expect(
      f.service.prepareFunding(f.actor, prepared.id, {
        chainId: 1,
        payer: owner.address,
      }),
    ).rejects.toMatchObject({ code: "RELAYR_QUOTE_EXPIRED" });
  });
  it("keeps source publication expiry effective even though owner authorization has a later explicit deadline", async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    const signatures = await f.sign(prepared);
    f.setNow(f.now() + 61_000);
    await expect(
      f.service.submit(f.actor, prepared.id, { signatures }, "submit"),
    ).rejects.toMatchObject({ code: "PLAN_EXPIRED" });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("refuses funding quotes that can outlive their signed destination authorization", async () => {
    const f = await fixture({ requestTtlSeconds: 180 });
    const prepared = await f.prepare();
    const result = await f.service.submit(
      f.actor,
      prepared.id,
      { signatures: await f.sign(prepared) },
      "submit",
    );
    expect(result.quote!.bundleUuid).toBe(BUNDLE);
    expect(result.quote!.payments).toEqual([]);
    await expect(
      f.service.prepareFunding(f.actor, prepared.id, {
        chainId: 1,
        payer: owner.address,
      }),
    ).rejects.toMatchObject({ code: "RELAYR_QUOTE_OUTLIVES_AUTHORIZATION" });
  });
  it.each(["domain", "contract-owner", "untrusted-target"] as const)(
    "rejects unsupported preparation: %s",
    async (mode) => {
      const f = await fixture();
      if (mode === "domain") f.flags.domainChain = 10n;
      else if (mode === "contract-owner") f.flags.ownerCode = CODE;
      else f.flags.trusts = false;
      await expect(f.prepare()).rejects.toBeInstanceOf(RestError);
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );
  it("rejects unconfigured hosts and unsupported or repeated steps without provider publication", async () => {
    const disabled = await fixture({ enabled: false });
    await expect(disabled.prepare()).rejects.toMatchObject({
      code: "SPONSORSHIP_NOT_CONFIGURED",
    });
    const f = await fixture();
    await expect(
      f.service.prepare(
        f.actor,
        f.plan.id,
        { stepIndexes: [0, 0] },
        "duplicates",
      ),
    ).rejects.toMatchObject({ code: "INVALID_SPONSORSHIP_STEPS" });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("does no work after request cancellation", async () => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.service.prepare(f.actor, f.plan.id, {}, "cancel", {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("pins payment runtime and demonstrates it does not inspect payer identity", () => {
    expect(keccak256(PAYMENT_CODE)).toBe(RELAYR_PAYMENT_CODE_HASH);
    // Walk executable instructions, skipping PUSH immediates and trailing metadata.
    const code = Buffer.from(PAYMENT_CODE.slice(2), "hex");
    const opcodes: number[] = [];
    for (let i = 0; i < code.length; i++) {
      const opcode = code[i]!;
      if (opcode === 0xfe) break;
      opcodes.push(opcode);
      if (opcode >= 0x60 && opcode <= 0x7f) i += opcode - 0x5f;
    }
    expect(opcodes).not.toContain(0x32); // ORIGIN
    expect(opcodes).not.toContain(0x33); // CALLER
    expect(opcodes).toContain(0x34); // CALLVALUE
  });
});
