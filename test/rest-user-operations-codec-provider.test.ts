import { describe, expect, it, vi } from "vitest";
import { getUserOperationHash as viemHash } from "viem/account-abstraction";
import { keccak256, toHex, type Address, type Hex } from "viem";
import {
  normalizeUserOperation,
  packUserOperation,
  unpackUserOperation,
  getUserOperationHash,
  userOperationCommitment,
  userOperationMaximumCost,
} from "../src/rest/userOperations/codec.js";
import {
  createPimlicoV7PaymasterPolicy,
  PIMLICO_LEGACY_V7_PAYMASTER,
  UserOperationProvider,
} from "../src/rest/userOperations/provider.js";
import type {
  UserOperationProviderConfig,
  UserOperationV07,
} from "../src/rest/userOperations/types.js";

const sender = "0x1111111111111111111111111111111111111111" as Address;
const entryPoint = "0x0000000071727de22e5e9d8baf0edac6f37da032" as Address;
const paymaster = "0x2222222222222222222222222222222222222222" as Address;
const codeHash = keccak256("0x6000");
function operation(): UserOperationV07 {
  return {
    sender,
    nonce: "0x10000000000000000",
    callData: "0x12345678",
    callGasLimit: "0x10000",
    verificationGasLimit: "0x20000",
    preVerificationGas: "0x3000",
    maxFeePerGas: "0x10",
    maxPriorityFeePerGas: "0x2",
    signature: "0x1234",
  };
}
function config(): UserOperationProviderConfig {
  return {
    chainId: 1,
    providerId: "fixture",
    entryPoint: { address: entryPoint, runtimeCodeHash: codeHash },
    bundlerUrl: "https://bundler.example/rpc?apikey=private-test-key",
    paymasterUrl: "https://paymaster.example/rpc",
    paymasterPolicy: {
      id: "fixture-sponsor",
      contract: { address: paymaster, runtimeCodeHash: codeHash },
      context: { policyId: "server-owned" },
      inspect: () => ({
        policyId: "fixture-sponsor",
        gasOnly: true,
        validAfter: 0,
        validUntil: 2_000_000_000,
        commitment: codeHash,
      }),
    },
  };
}
function fixture(
  handler: (method: string, params: unknown[]) => unknown | Promise<unknown>,
) {
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return Response.json({
      jsonrpc: "2.0",
      id: body.id,
      result: await handler(body.method, body.params),
    });
  });
  return { fetcher, provider: new UserOperationProvider([config()], fetcher) };
}
describe("strict EntryPoint v0.7 codec", () => {
  it.each([false, true])(
    "matches independent viem hash with optional factory and paymaster: %s",
    (populated) => {
      const op = operation();
      if (populated)
        Object.assign(op, {
          factory: paymaster,
          factoryData: "0x010203",
          paymaster,
          paymasterVerificationGasLimit: "0x1000",
          paymasterPostOpGasLimit: "0x2000",
          paymasterData: "0xabcdef",
        });
      const packed = packUserOperation(op);
      expect(unpackUserOperation(packed)).toEqual(op);
      const bigintOp = {
        ...op,
        nonce: BigInt(op.nonce),
        callGasLimit: BigInt(op.callGasLimit),
        verificationGasLimit: BigInt(op.verificationGasLimit),
        preVerificationGas: BigInt(op.preVerificationGas),
        maxFeePerGas: BigInt(op.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(op.maxPriorityFeePerGas),
        ...(op.paymaster
          ? {
              paymasterVerificationGasLimit: BigInt(
                op.paymasterVerificationGasLimit!,
              ),
              paymasterPostOpGasLimit: BigInt(op.paymasterPostOpGasLimit!),
            }
          : {}),
      };
      expect(getUserOperationHash(op, entryPoint, 1)).toBe(
        viemHash({
          userOperation: bigintOp as never,
          entryPointAddress: entryPoint,
          entryPointVersion: "0.7",
          chainId: 1,
        }),
      );
      expect(getUserOperationHash(op, entryPoint, 10)).not.toBe(
        getUserOperationHash(op, entryPoint, 1),
      );
    },
  );
  it("separates the canonical operation hash from full signed publication identity", () => {
    const op = operation();
    const changed = { ...op, signature: "0xabcd" as Hex };
    expect(getUserOperationHash(op, entryPoint, 1)).toBe(
      getUserOperationHash(changed, entryPoint, 1),
    );
    expect(userOperationCommitment(op, entryPoint, 1)).not.toBe(
      userOperationCommitment(changed, entryPoint, 1),
    );
    expect(userOperationMaximumCost(op)).toBe(
      (0x10000n + 0x20000n + 0x3000n) * 0x10n,
    );
  });
  it.each([
    { nonce: "0x00" },
    { nonce: "0xA" },
    { nonce: 1 },
    { initCode: "0x" },
    { authorization: {} },
    { factory: paymaster },
    { factoryData: "0x" },
    {
      factory: "0x7702000000000000000000000000000000000000",
      factoryData: "0x",
    },
    {
      factory: "0x0000000000000000000000000000000000007702",
      factoryData: "0x",
    },
    { paymaster },
    { paymasterAndData: "0x" },
    { callData: "0x1" },
    { callGasLimit: toHex(1n << 128n) },
    { maxPriorityFeePerGas: "0x11" },
    { sender: "0x0000000000000000000000000000000000000000" },
    { signature: `0x${"ab".repeat(16_385)}` },
  ])("rejects malformed or cross-version input %#", (mutation) => {
    expect(() =>
      normalizeUserOperation({ ...operation(), ...mutation }),
    ).toThrow();
  });
  it.each(["initCode", "paymasterAndData"] as const)(
    "rejects truncated packed %s",
    (key) => {
      expect(() =>
        unpackUserOperation({
          ...packUserOperation(operation()),
          [key]: "0x1234",
        }),
      ).toThrow();
    },
  );
});
describe("bounded bundler and EIP-7677 transport", () => {
  it("rejects caller-created estimation overrides before any provider request", async () => {
    const f = fixture(() => null);
    await expect(
      f.provider.estimate(1, operation(), undefined, {} as never),
    ).rejects.toMatchObject({ code: "SESSION_GAS_ESTIMATION_CONTEXT" });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("checks exact bundler chain and EntryPoint without exposing endpoint credentials", async () => {
    const f = fixture((method) =>
      method === "eth_chainId" ? "0x1" : [entryPoint],
    );
    expect(await f.provider.readiness(1)).toEqual({
      chainId: 1,
      providerId: "fixture",
      entryPoint,
    });
    expect(JSON.stringify(f.provider.capabilities())).not.toContain(
      "private-test-key",
    );
  });
  it("omits signature and uses only server context for paymaster requests", async () => {
    const f = fixture(() => ({
      paymaster,
      paymasterData: "0x010101",
      paymasterVerificationGasLimit: "0x1000",
      paymasterPostOpGasLimit: "0x0",
    }));
    const result = await f.provider.stub(1, {
      ...operation(),
      signature: "0x",
    });
    const request = JSON.parse(String(f.fetcher.mock.calls[0]![1]!.body));
    expect(request.params[0].signature).toBeUndefined();
    expect(request.params.slice(1)).toEqual([
      entryPoint,
      "0x1",
      { policyId: "server-owned" },
    ]);
    expect(result.operation.sender).toBe(sender);
    expect(result.operation.paymaster).toBe(paymaster);
  });
  it.each([
    { paymaster, paymasterData: "0x01" },
    {
      paymaster: sender,
      paymasterData: "0x01",
      paymasterPostOpGasLimit: "0x0",
    },
    {
      paymaster,
      paymasterData: "0x01",
      paymasterPostOpGasLimit: "0x0",
      callData: "0xdead",
    },
    { paymasterAndData: "0x1234" },
  ])(
    "rejects invalid, cross-version or operation-changing paymaster fields %#",
    (result) => {
      const f = fixture(() => result);
      return expect(
        f.provider.stub(1, { ...operation(), signature: "0x" }),
      ).rejects.toThrow();
    },
  );
  it("rejects final paymaster data that invalidates the stub estimate", async () => {
    const f = fixture(() => ({ paymaster, paymasterData: "0xffffff" }));
    await expect(
      f.provider.sponsor(1, {
        ...operation(),
        signature: "0x",
        paymaster,
        paymasterData: "0x000000",
        paymasterVerificationGasLimit: "0x1000",
        paymasterPostOpGasLimit: "0x0",
      }),
    ).rejects.toMatchObject({ code: "USER_OPERATION_PAYMASTER_STUB_CHANGED" });
  });
  it("never retries or trusts a mismatched operation hash after publication", async () => {
    const f = fixture(() => `0x${"ab".repeat(32)}`);
    await expect(f.provider.send(1, operation())).rejects.toMatchObject({
      code: "USER_OPERATION_SUBMISSION_UNKNOWN",
    });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it("sends only the exact serialized operation once", async () => {
    const op = operation();
    const expected = getUserOperationHash(op, entryPoint, 1);
    const f = fixture(() => expected);
    expect(await f.provider.send(1, op)).toBe(expected);
    expect(
      JSON.parse(String(f.fetcher.mock.calls[0]![1]!.body)).params,
    ).toEqual([op, entryPoint]);
  });
  it("rejects mismatched JSON-RPC identity and hides provider errors", async () => {
    const wrong = new UserOperationProvider([config()], async () =>
      Response.json({ jsonrpc: "2.0", id: "wrong", result: "0x1" }),
    );
    await expect(wrong.readiness(1)).rejects.toMatchObject({
      code: "USER_OPERATION_PROVIDER_RESPONSE",
    });
    const failure = new UserOperationProvider([config()], async (_url, init) =>
      Response.json({
        jsonrpc: "2.0",
        id: JSON.parse(String(init?.body)).id,
        error: { message: "private-test-key" },
      }),
    );
    await expect(failure.readiness(1)).rejects.toThrow(
      "private response details are not exposed",
    );
  });
  it("bounds streamed response bytes without trusting content-length", async () => {
    const provider = new UserOperationProvider(
      [config()],
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(1_048_577));
              controller.close();
            },
          }),
        ),
    );
    await expect(provider.readiness(1)).rejects.toMatchObject({
      code: "USER_OPERATION_PROVIDER_LIMIT",
    });
  });
  it("cancels and times out even when a provider ignores its signal", async () => {
    const provider = new UserOperationProvider(
      [config()],
      async () => new Promise(() => {}),
      10,
    );
    await expect(provider.estimate(1, operation())).rejects.toMatchObject({
      code: "USER_OPERATION_PROVIDER_TIMEOUT",
    });
    const controller = new AbortController();
    const pending = provider.estimate(1, operation(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "USER_OPERATION_CANCELLED",
    });
  });
  it.each([
    "http://provider.example",
    "https://user:password@provider.example",
    "https://provider.example/#fragment",
  ])("rejects unsafe endpoint configuration %s", (bundlerUrl) => {
    expect(
      () => new UserOperationProvider([{ ...config(), bundlerUrl }]),
    ).toThrow();
  });
});
describe("runtime-pinned deployed Pimlico gas-only profile", () => {
  const policy = createPimlicoV7PaymasterPolicy({
    chainId: 1,
    policyId: "reviewed-sponsor",
    context: { sponsorshipPolicyId: "operator-owned" },
  });
  const paymasterOperation = (
    until = 2_000_000_000n,
    after = 1_000_000_000n,
  ): UserOperationV07 => ({
    ...operation(),
    paymaster: PIMLICO_LEGACY_V7_PAYMASTER.address,
    paymasterVerificationGasLimit: "0x10000",
    paymasterPostOpGasLimit: "0x0",
    paymasterData: `0x00${toHex(until, { size: 6 }).slice(2)}${toHex(after, { size: 6 }).slice(2)}${"11".repeat(65)}`,
  });
  it("binds the exact deployed legacy format and separates chain/operation commitments", () => {
    const op = paymasterOperation();
    const proof = policy.inspect(op, "final");
    expect(proof).toMatchObject({
      policyId: "reviewed-sponsor",
      gasOnly: true,
      validAfter: 1_000_000_000,
      validUntil: 2_000_000_000,
    });
    expect(policy.maximumPaymasterDataLength).toBe(130);
    expect(policy.inspect({ ...op, signature: "0x" }, "stub").commitment).toBe(
      proof.commitment,
    );
    expect(
      policy.inspect({ ...op, nonce: "0x2" }, "final").commitment,
    ).not.toBe(proof.commitment);
    expect(
      createPimlicoV7PaymasterPolicy({
        chainId: 10,
        policyId: "reviewed-sponsor",
      }).inspect(op, "final").commitment,
    ).not.toBe(proof.commitment);
  });
  it.each(["01", "02", "ff"])(
    "rejects legacy mode %s including the newer-branch flag alias",
    (mode) => {
      const op = paymasterOperation();
      op.paymasterData = `0x${mode}${op.paymasterData!.slice(4)}`;
      expect(() => policy.inspect(op, "final")).toThrow(
        "Only the runtime-pinned legacy",
      );
    },
  );
  it.each(["short", "long", "compact", "address"])(
    "rejects altered %s paymaster fields",
    (mutation) => {
      const op = paymasterOperation();
      if (mutation === "address") op.paymaster = paymaster;
      else if (mutation === "long") op.paymasterData = `${op.paymasterData!}00`;
      else
        op.paymasterData = op.paymasterData!.slice(
          0,
          mutation === "compact" ? -2 : -20,
        ) as Hex;
      expect(() => policy.inspect(op, "final")).toThrow();
    },
  );
  it("preserves the deployed zero-validUntil convention but rejects not-yet-valid or nearly expired windows", () => {
    const provider = new UserOperationProvider(
      [{ ...config(), paymasterPolicy: policy }],
      fetch,
      20_000,
      () => 1_800_000_000_000,
    );
    expect(
      provider.inspectPaymaster(1, paymasterOperation(0n), "final").validUntil,
    ).toBe(2 ** 48 - 1);
    expect(() =>
      provider.inspectPaymaster(1, paymasterOperation(1_800_000_030n), "final"),
    ).toThrow();
    expect(() =>
      provider.inspectPaymaster(
        1,
        paymasterOperation(2_000_000_000n, 1_800_000_001n),
        "final",
      ),
    ).toThrow();
  });
});
