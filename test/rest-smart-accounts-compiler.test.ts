import { describe, expect, it } from "vitest";
import {
  encodeFunctionData,
  parseAbi,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import {
  assertCompiledSessionCall,
  createLegacySessionCompiler,
  LEGACY_COMPILER_RUNTIME_HASHES,
  type SessionReview,
} from "../src/rest/smartAccounts/compiler.js";
import { createConfiguredSmartAccountStack } from "../src/rest/smartAccounts/stack/config.js";
import { fingerprint } from "../src/rest/smartAccounts/service.js";

const guard = {
  address: "0x6000000000000000000000000000000000000006" as Address,
  runtimeCodeHash: LEGACY_COMPILER_RUNTIME_HASHES.sessionGuard,
};
const wallet = "0x1000000000000000000000000000000000000001" as Address;
const target = "0x2000000000000000000000000000000000000002" as Address;
const key = "0x3000000000000000000000000000000000000003" as Address;
const abi = parseAbi([
  "function setUriOf(uint256 projectId,string uri)",
  "function pay(uint256 projectId,address token,uint256 amount,address beneficiary,uint256 minReturnedTokens,string memo,bytes metadata) payable returns(uint256)",
]);
function reviewed(): SessionReview {
  const policy = {
    schemaVersion: 1,
    ownerAccountId: `eip155:1:${key}`,
    bindingId: zeroHash,
    grantId: "fixture",
    sessionKey: key,
    chainId: 11155111,
    wallet,
    generation: "1",
    nonce: `0x${"ab".repeat(32)}`,
    validAfter: 1800000000,
    validUntil: 1800604800,
    maximumCalls: "5",
    salt: `0x${"cd".repeat(32)}`,
    restrictToActions: true,
    signing: { mode: "disabled" },
    crossChainPermits: false,
    claimPolicies: false,
    wildcardFallback: false,
    allocations: [],
    gasBudget: {
      paymaster: target,
      paymasterCodeHash: zeroHash,
      paymasterReviewId: "fixture-only",
      maxGasPerOperation: "1000000",
      maxFeePerGas: "2000000000",
      maxPriorityFeePerGas: "1000000000",
      totalGasLimit: "5000000",
      totalSponsoredCostLimit: "10000000000000000",
      maxPaymasterDataLength: 130,
    },
    actions: [
      {
        kind: "v6-project-uri",
        chainId: 11155111,
        target,
        selector: "0x9381d0cd",
        projectId: "123",
        runtimeCodeHash: zeroHash,
        targetReviewId: "fixture-only",
        requiredEnforcement: [],
      },
    ],
  };
  policy.actions[0]!.selector = encodeFunctionData({
    abi,
    functionName: "setUriOf",
    args: [123n, "ipfs://one"],
  }).slice(0, 10);
  return {
    policy,
    policyHash: fingerprint(policy),
    manifestRevision: zeroHash,
  } as unknown as SessionReview;
}
describe("pinned session compiler and deployment configuration", () => {
  it("loads all eight exact stacks without fabricating a guard deployment", async () => {
    for (const chainId of [
      1, 10, 8453, 42161, 84532, 421614, 11155111, 11155420,
    ]) {
      const stack = await createConfiguredSmartAccountStack({ chainId });
      expect(stack.manifest.chainId).toBe(chainId);
      expect(stack.manifest.entryPoint?.version).toBe("0.7");
      expect(stack.compilerStack).toBeUndefined();
      expect(() => stack.createCompiler()).toThrow(/deployment/);
    }
    await expect(
      createConfiguredSmartAccountStack({ chainId: 99 }),
    ).rejects.toMatchObject({ code: "SMART_STACK_CHAIN_UNSUPPORTED" });
  });
  it("requires the exact operator-configured guard runtime and preserves honest local provenance", async () => {
    await expect(
      createConfiguredSmartAccountStack({
        chainId: 11155111,
        sessionGuard: { ...guard, runtimeCodeHash: zeroHash },
      }),
    ).rejects.toMatchObject({ code: "SMART_STACK_CONFIGURATION_INVALID" });
    const stack = await createConfiguredSmartAccountStack({
      chainId: 11155111,
      sessionGuard: guard,
    });
    expect(stack.compilerStack?.sessionGuard.source).toMatchObject({
      repository: "juicebox-center",
      contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(stack.compilerStack?.sessionGuard.source.commit).toBeUndefined();
  });
  it("compiles a nonfinancial URI session and independently rejects wrong project/value/selectors/tails", async () => {
    const stack = await createConfiguredSmartAccountStack({
      chainId: 11155111,
      sessionGuard: guard,
    });
    const review = reviewed();
    const compiled = stack
      .createCompiler()
      .compile({ review, activationEnableNonce: "0" });
    const callData = encodeFunctionData({
      abi,
      functionName: "setUriOf",
      args: [123n, "ipfs://two"],
    });
    expect(() =>
      assertCompiledSessionCall(compiled, { target, value: "0", callData }),
    ).not.toThrow();
    for (const call of [
      { target, value: "1", callData },
      { target: wallet, value: "0", callData },
      { target, value: "0", callData: `${callData}00` as Hex },
      {
        target,
        value: "0",
        callData: encodeFunctionData({
          abi,
          functionName: "setUriOf",
          args: [124n, "ipfs://two"],
        }),
      },
    ])
      expect(() => assertCompiledSessionCall(compiled, call)).toThrow();
    const corrupted = structuredClone(compiled);
    corrupted.session.actions[0]!.actionTarget = wallet;
    expect(() =>
      assertCompiledSessionCall(corrupted, { target, value: "0", callData }),
    ).toThrow(/changed/);
  });
  it("rejects missing sponsorship and a mismatched module generation before setup", async () => {
    const stack = await createConfiguredSmartAccountStack({
      chainId: 11155111,
      sessionGuard: guard,
    });
    const review = reviewed();
    delete review.policy.gasBudget;
    review.policyHash = fingerprint(review.policy);
    expect(() =>
      stack.createCompiler().compile({ review, activationEnableNonce: "0" }),
    ).toThrow(/hosted-paymaster/);
    const badStack = structuredClone(stack.compilerStack!);
    badStack.universalAction.runtimeCodeHash = zeroHash;
    expect(() =>
      createLegacySessionCompiler({ stack: badStack }).compile({
        review: reviewed(),
        activationEnableNonce: "0",
      }),
    ).toThrow(/module generation/);
  });
});
