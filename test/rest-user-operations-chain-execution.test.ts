import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  encodeFunctionResult,
  keccak256,
  stringToHex,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { encodeSafe7579Execution } from "../src/rest/smartAccounts/accountExecution.js";
import {
  UserOperationChain,
  ENTRY_POINT_V07_ABI,
} from "../src/rest/userOperations/chain.js";
import {
  getUserOperationHash,
  packUserOperation,
  userOperationCommitment,
} from "../src/rest/userOperations/codec.js";
import { observeUserOperation } from "../src/rest/userOperations/execution.js";
import {
  createPimlicoV7PaymasterPolicy,
  PIMLICO_LEGACY_V7_PAYMASTER,
  UserOperationProvider,
} from "../src/rest/userOperations/provider.js";
import type {
  UserOperationExecutionBinding,
  UserOperationGasPolicy,
  UserOperationV07,
} from "../src/rest/userOperations/types.js";
import type { RestRpc } from "../src/rest/core.js";

const sender = "0x1111111111111111111111111111111111111111" as Address;
const target = "0x2222222222222222222222222222222222222222" as Address;
const entryPoint = "0x0000000071727de22e5e9d8baf0edac6f37da032" as Address;
const code = "0x6000" as Hex;
const blockHash = keccak256(stringToHex("canonical block"));
const txHash = keccak256(stringToHex("bundle"));
const now = 1_800_000_000_000;
const gas: UserOperationGasPolicy = {
  id: "fixture",
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
function fixture() {
  const operation: UserOperationV07 = {
    sender,
    nonce: "0x0",
    callData: encodeSafe7579Execution([
      { target, value: "0", callData: "0x12345678" },
    ]),
    callGasLimit: "0x186a0",
    verificationGasLimit: "0x186a0",
    preVerificationGas: "0x186a0",
    maxFeePerGas: "0x10",
    maxPriorityFeePerGas: "0x1",
    signature: "0x1234",
  };
  const binding: UserOperationExecutionBinding = {
    chainId: 1,
    entryPoint: { address: entryPoint, runtimeCodeHash: keccak256(code) },
    accountCode: { address: sender, runtimeCodeHash: keccak256(code) },
    operation,
    operationHash: getUserOperationHash(operation, entryPoint, 1),
    calls: [
      {
        chainId: 1,
        to: target,
        value: "0",
        data: "0x12345678",
        label: "Exact call",
        dependsOn: [],
        decoded: {},
      },
    ],
  };
  const state = {
    nonce: 0n,
    code: code as Hex,
    innerFailure: false,
    validationFailure: false,
    reorged: false,
    mined: false,
    receiptStatus: "0x1",
    eventSuccess: true,
    operationSignature: "0x1234" as Hex,
    wrongEvent: false,
    duplicateLogs: false,
    malformedBoundary: false,
    malformedEvent: false,
  };
  const outerOperation = () => ({
    ...operation,
    signature: state.operationSignature,
  });
  const other = { ...operation, sender: target, nonce: "0x1" as Hex };
  const tx = () => ({
    hash: txHash,
    from: target,
    to: entryPoint,
    input: encodeFunctionData({
      abi: ENTRY_POINT_V07_ABI,
      functionName: "handleOps",
      args: [
        [packUserOperation(other), packUserOperation(outerOperation())],
        target,
      ],
    }),
    value: "0x0",
    chainId: "0x1",
    blockHash,
    blockNumber: "0x64",
    transactionIndex: "0x0",
  });
  const log = (
    index: number,
    address: Address,
    topics: readonly Hex[],
    data: Hex,
  ) => ({
    address,
    topics,
    data,
    blockNumber: "0x64",
    blockHash,
    transactionHash: txHash,
    transactionIndex: "0x0",
    logIndex: toHex(state.duplicateLogs ? 0 : index),
    removed: false,
  });
  const operationEvent = (
    index: number,
    op: UserOperationV07,
    success: boolean,
  ) =>
    log(
      index,
      entryPoint,
      encodeEventTopics({
        abi: ENTRY_POINT_V07_ABI,
        eventName: "UserOperationEvent",
        args: {
          userOpHash: state.wrongEvent
            ? txHash
            : getUserOperationHash(op, entryPoint, 1),
          sender: op.sender,
          paymaster: zeroAddress,
        },
      }) as Hex[],
      `${encodeAbiParameters([{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }], [BigInt(op.nonce), success, 1000n, 100n])}${state.malformedEvent ? "00" : ""}`,
    );
  const ownLog = () =>
    log(3, target, [keccak256(stringToHex("OwnEffect()"))], "0x");
  const receipt = () => ({
    transactionHash: txHash,
    from: target,
    to: entryPoint,
    blockHash,
    blockNumber: "0x64",
    transactionIndex: "0x0",
    status: state.receiptStatus,
    logs:
      state.receiptStatus === "0x0"
        ? []
        : [
            log(
              0,
              entryPoint,
              [keccak256(stringToHex("BeforeExecution()"))],
              state.malformedBoundary ? "0x00" : "0x",
            ),
            log(1, target, [keccak256(stringToHex("OtherEffect()"))], "0x"),
            operationEvent(2, other, true),
            ownLog(),
            operationEvent(4, operation, state.eventSuccess),
          ],
  });
  const rpc = vi.fn<RestRpc["request"]>(async (_chain, method, params) => {
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByNumber")
      return {
        number: "0x64",
        hash: state.reorged && params[0] !== "latest" ? txHash : blockHash,
        timestamp: toHex(now / 1000),
      };
    if (method === "eth_getCode") return state.code;
    if (method === "eth_getBalance") return toHex(10n ** 18n);
    if (method === "eth_getTransactionByHash") return state.mined ? tx() : null;
    if (method === "eth_getTransactionReceipt")
      return state.mined ? receipt() : null;
    if (method === "eth_call") {
      const call = params[0] as { to: Address; data: Hex };
      if (call.to.toLowerCase() === sender) {
        if (state.innerFailure) throw new Error("Inner revert");
        return "0x";
      }
      const decoded = decodeFunctionData({
        abi: ENTRY_POINT_V07_ABI,
        data: call.data,
      });
      if (decoded.functionName === "getNonce")
        return encodeFunctionResult({
          abi: ENTRY_POINT_V07_ABI,
          functionName: "getNonce",
          result: state.nonce,
        });
      if (decoded.functionName === "getUserOpHash")
        return encodeFunctionResult({
          abi: ENTRY_POINT_V07_ABI,
          functionName: "getUserOpHash",
          result: binding.operationHash,
        });
      if (decoded.functionName === "balanceOf")
        return encodeFunctionResult({
          abi: ENTRY_POINT_V07_ABI,
          functionName: "balanceOf",
          result: 10n ** 18n,
        });
      if (state.validationFailure) throw new Error("Signature rejected");
      return "0x";
    }
    throw new Error(`Unexpected ${method}`);
  });
  const chain = () =>
    new UserOperationChain({ request: rpc }, { now: () => now });
  const accountVerifier = vi.fn(async () => {});
  const semantic = vi.fn(async () => ({ status: "verified" as const }));
  const observe = () =>
    observeUserOperation({
      chain: chain(),
      binding,
      signedCommitment: userOperationCommitment(operation, entryPoint, 1),
      transactionHash: txHash,
      confirmations: 1,
      now,
      verifyAccountAtBlock: accountVerifier,
      verifySemantics: semantic,
    });
  return {
    operation,
    binding,
    state,
    rpc,
    chain,
    observe,
    accountVerifier,
    semantic,
    ownLog,
  };
}
describe("independent signed user operation preflight", () => {
  it("checks canonical runtime, keyed nonce, deployed hash, validation and separate atomic execution", async () => {
    const f = fixture();
    const result = await f.chain().preflight(f.binding, gas);
    expect(result).toMatchObject({
      operationHash: f.binding.operationHash,
      nonceKey: "0",
      nonceSequence: "0",
    });
    expect(
      f.rpc.mock.calls.some(
        ([, method, params]) =>
          method === "eth_call" &&
          (params[0] as { from?: string }).from === entryPoint,
      ),
    ).toBe(true);
    expect(
      f.rpc.mock.calls.some(
        ([, method]) => method === "eth_sendRawTransaction",
      ),
    ).toBe(false);
  });
  it.each([
    "nonce",
    "code",
    "innerFailure",
    "validationFailure",
    "reorged",
  ] as const)("rejects changed %s before publication", async (field) => {
    const f = fixture();
    if (field === "nonce") f.state.nonce = 1n;
    else if (field === "code") f.state.code = "0x6001";
    else f.state[field] = true;
    await expect(f.chain().preflight(f.binding, gas)).rejects.toThrow();
  });
  it("rejects non-atomic execution mode even if an RPC would report success", async () => {
    const f = fixture();
    f.binding.operation.callData = f.operation.callData.replace(
      "0000000000000000000000000000000000000000000000000000000000000000",
      "0001000000000000000000000000000000000000000000000000000000000000",
    ) as Hex;
    await expect(f.chain().preflight(f.binding, gas)).rejects.toThrow();
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it("bounds an unresponsive RPC even when its adapter ignores abort", async () => {
    const chain = new UserOperationChain(
      { request: async () => new Promise(() => {}) },
      { timeoutMs: 10 },
    );
    await expect(chain.snapshot(1)).rejects.toMatchObject({
      code: "USER_OPERATION_RPC_UNAVAILABLE",
    });
    const controller = new AbortController();
    controller.abort();
    const cancelled = new UserOperationChain(
      { request: vi.fn() },
      { signal: controller.signal },
    );
    await expect(cancelled.snapshot(1)).rejects.toMatchObject({
      code: "USER_OPERATION_CANCELLED",
    });
  });
});
describe("independent runtime-pinned sponsorship signature preflight", () => {
  const artifact = JSON.parse(
    readFileSync(
      new URL(
        "../src/rest/smartAccounts/stack/artifacts/PimlicoSingletonPaymasterV7.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { deployedRuntimeBytecode: Hex };
  function sponsored(
    mutation?: "signature" | "context" | "expired" | "entryPoint" | "runtime",
  ) {
    const f = fixture();
    const until = BigInt(now / 1000 + 600);
    Object.assign(f.operation, {
      paymaster: PIMLICO_LEGACY_V7_PAYMASTER.address,
      paymasterVerificationGasLimit: "0x493e0",
      paymasterPostOpGasLimit: "0x0",
      paymasterData: `0x00${toHex(until, { size: 6 }).slice(2)}${"00".repeat(6)}${"11".repeat(65)}`,
    });
    f.binding.operationHash = getUserOperationHash(f.operation, entryPoint, 1);
    const original = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation(async (chain, method, params, signal) => {
      if (
        method === "eth_getCode" &&
        params[0] === PIMLICO_LEGACY_V7_PAYMASTER.address
      )
        return mutation === "runtime" ? code : artifact.deployedRuntimeBytecode;
      if (method === "eth_call") {
        const call = params[0] as {
          to: Address;
          from: Address;
          data: Hex;
          gas: Hex;
        };
        if (call.to === PIMLICO_LEGACY_V7_PAYMASTER.address) {
          const decoded = decodeFunctionData({
            abi: ENTRY_POINT_V07_ABI,
            data: call.data,
          });
          if (decoded.functionName === "entryPoint")
            return encodeFunctionResult({
              abi: ENTRY_POINT_V07_ABI,
              functionName: "entryPoint",
              result: mutation === "entryPoint" ? sender : entryPoint,
            });
          if (decoded.functionName === "validatePaymasterUserOp") {
            expect(call.from).toBe(entryPoint);
            expect(call.gas).toBe(f.operation.paymasterVerificationGasLimit);
            expect(decoded.args[0]).toEqual(packUserOperation(f.operation));
            expect(decoded.args[1]).toBe(f.binding.operationHash);
            const validation =
              (mutation === "expired" ? BigInt(now / 1000 + 1) : until) << 160n;
            return encodeFunctionResult({
              abi: ENTRY_POINT_V07_ABI,
              functionName: "validatePaymasterUserOp",
              result: [
                mutation === "context" ? "0x01" : "0x",
                validation | (mutation === "signature" ? 1n : 0n),
              ],
            });
          }
        }
      }
      return original(chain, method, params, signal);
    });
    const provider = new UserOperationProvider(
      [
        {
          chainId: 1,
          providerId: "pimlico-fixture",
          entryPoint: f.binding.entryPoint,
          bundlerUrl: "https://bundler.example",
          paymasterUrl: "https://paymaster.example",
          paymasterPolicy: createPimlicoV7PaymasterPolicy({
            chainId: 1,
            policyId: "reviewed",
          }),
        },
      ],
      fetch,
      20_000,
      () => now,
    );
    return { ...f, provider };
  }
  it("requires approved signer validation and empty context from the exact pinned paymaster before account simulation", async () => {
    const f = sponsored();
    expect(await f.chain().preflight(f.binding, gas, f.provider)).toMatchObject(
      { paymasterProof: { policyId: "reviewed", gasOnly: true } },
    );
  });
  it.each([
    "signature",
    "context",
    "expired",
    "entryPoint",
    "runtime",
  ] as const)(
    "rejects mismatched %s sponsorship evidence",
    async (mutation) => {
      const f = sponsored(mutation);
      await expect(
        f.chain().preflight(f.binding, gas, f.provider),
      ).rejects.toThrow();
      expect(
        f.rpc.mock.calls.some(
          ([, method, params]) =>
            method === "eth_call" &&
            (params[0] as { to: Address }).to === sender,
        ),
      ).toBe(false);
    },
  );
});
describe("independent EntryPoint receipt and per-operation log proof", () => {
  it("requires the exact signed operation and scopes semantic logs within its execution interval", async () => {
    const f = fixture();
    f.state.mined = true;
    const result = await f.observe();
    expect(result.state).toBe("confirmed");
    expect(result.scopedLogs).toEqual([f.ownLog()]);
    expect(f.semantic).toHaveBeenCalledWith(
      expect.objectContaining({ logs: [f.ownLog()] }),
    );
    expect(f.accountVerifier).toHaveBeenCalledTimes(1);
  });
  it("keeps absent onchain receipts pending", async () => {
    expect((await fixture().observe()).state).toBe("pending");
  });
  it.each([
    "operationSignature",
    "wrongEvent",
    "duplicateLogs",
    "reorged",
    "malformedBoundary",
    "malformedEvent",
  ] as const)("refuses proof with altered %s", async (field) => {
    const f = fixture();
    f.state.mined = true;
    if (field === "operationSignature") f.state.operationSignature = "0xabcd";
    else f.state[field] = true;
    expect((await f.observe()).state).toBe("unknown");
    expect(f.semantic).not.toHaveBeenCalled();
  });
  it("does not confuse a successful outer transaction with failed account execution", async () => {
    const f = fixture();
    f.state.mined = true;
    f.state.eventSuccess = false;
    const result = await f.observe();
    expect(result).toMatchObject({
      state: "reverted",
      receipt: { status: "success" },
      semantic: { status: "failed" },
    });
    expect(f.semantic).not.toHaveBeenCalled();
  });
  it("preserves an independently proven outer revert", async () => {
    const f = fixture();
    f.state.mined = true;
    f.state.receiptStatus = "0x0";
    expect(await f.observe()).toMatchObject({
      state: "reverted",
      receipt: { status: "reverted" },
    });
  });
  it("refuses successful execution claims if the historical account configuration is not verified", async () => {
    const f = fixture();
    f.state.mined = true;
    f.accountVerifier.mockRejectedValue(new Error("Unknown validator"));
    await expect(f.observe()).rejects.toThrow("Unknown validator");
    expect(f.semantic).not.toHaveBeenCalled();
  });
});
