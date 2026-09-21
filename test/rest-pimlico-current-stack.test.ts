import { describe, expect, it } from "vitest";
import { decodeAbiParameters, encodeAbiParameters, keccak256, toHex, zeroHash, type Address } from "viem";
import { readRestExecutionConfiguration } from "../src/rest/executionConfig.js";
import { createConfiguredSmartAccountStack } from "../src/rest/smartAccounts/stack/config.js";
import {
  CURRENT_PIMLICO_GUARD_RUNTIME_HASH,
  CURRENT_PIMLICO_PAYMASTER,
} from "../src/rest/smartAccounts/stack/current-pimlico/pins.js";
import {
  createLegacySessionCompiler, LEGACY_COMPILER_RUNTIME_HASHES, SESSION_GUARD_INIT_ABI,
  type SessionReview,
} from "../src/rest/smartAccounts/compiler.js";
import { fingerprint } from "../src/rest/smartAccounts/service.js";
import { createSessionGasEstimation, sessionGasEstimationOverrides } from "../src/rest/userOperations/estimation.js";
import type { UserOperationGasPolicy, UserOperationV07 } from "../src/rest/userOperations/types.js";
import { sessionFixture, sessionObservation } from "./fixtures/sessions.js";

const guardAddress = "0x6000000000000000000000000000000000000006" as Address;
const provider = {
  chainId: 8453,
  bundlerUrl: "https://provider.invalid/rpc?apikey=DO_NOT_LEAK_TEST_KEY",
  paymasterUrl: "https://provider.invalid/rpc?apikey=DO_NOT_LEAK_TEST_KEY",
  paymasterPolicyId: "fixture",
  paymasterProfile: "pimlico-v7-current-flags",
  gas: {
    maximumCallGas: "1000000", maximumVerificationGas: "1000000", maximumPreVerificationGas: "100000",
    maximumPaymasterVerificationGas: "1000000", maximumPaymasterPostOpGas: "0",
    maximumFeePerGas: "3000000000", maximumPriorityFeePerGas: "1000000000", maximumCost: "10000000000000000",
  },
};
const parse = (entry: unknown) => readRestExecutionConfiguration(JSON.stringify({ chains: [entry] }));
const ownerRevisions = {
  1: "0x9920cc571e183e95efa0404d9a1da3d5743a53593e1597c4fec3a031307aace7",
  10: "0x1fd92f2692144e362395fd733c523439bf1d24db40d58efdbe1a1cd25148b3ba",
  8453: "0x297dd049369b5a0f074096957200df457ac57c1c8fde97de8cfa283bb226f485",
  42161: "0xe4027e1c01ee02e74af57c9c2a4fb2897c82910736b983a2391048b904dc4a9b",
  84532: "0xc906db73a53f68b948db1531946d951aa6ece49dd67ed5f02a9f6df71dc9d43a",
  421614: "0xb432676373aad7f1f32b15a856c4aff767812fc5e27fcb22e7d50d279af3ec44",
  11155111: "0xf71edd66a9ffb065a24100ed40d500ef00778be4895a7b9d4924b3ad6817ad02",
  11155420: "0x07c1b6a8c693fea038714ad7c38f9f35052cce2a0b2d0e90a5f0bb4562855dd5",
};
async function currentSession() {
  const stack = await createConfiguredSmartAccountStack({
    chainId: 8453, paymasterProfile: "pimlico-v7-current-flags",
    sessionGuard: { address: guardAddress, runtimeCodeHash: CURRENT_PIMLICO_GUARD_RUNTIME_HASH, version: "current-v2" },
  });
  const { record, walletBinding } = sessionFixture(1_800_000_000_000, { chainId: 8453 });
  const policy = structuredClone(record.compiled.reviewedPolicy) as SessionReview["policy"];
  policy.gasBudget = { ...policy.gasBudget!, paymaster: CURRENT_PIMLICO_PAYMASTER.address,
    paymasterCodeHash: CURRENT_PIMLICO_PAYMASTER.runtimeCodeHash, paymasterReviewId: "pimlico-v7-current-flags" };
  const review: SessionReview = {
    status: "reviewable-not-activated", policy, policyHash: fingerprint(policy),
    manifestRevision: stack.manifest.revision, walletStateHash: walletBinding.state.stateHash,
    evidence: walletBinding.state.evidence,
    ownerApproval: { required: true, signerRole: "smart-account-owner-threshold",
      action: "install-or-enable-exact-session-policy", noPermanentBotProjectPermission: true },
    activationRequirements: [], warnings: [],
  };
  record.compiled = stack.createCompiler().compile({ review, activationEnableNonce: "0" });
  return { stack, record, review };
}

describe("independent current Pimlico deployment profile", () => {
  it("preserves every deployed owner manifest revision and history namespace without a provider", async () => {
    const result = await readRestExecutionConfiguration({});
    for (const stack of result.stacks) {
      const chainId = stack.manifest.chainId as keyof typeof ownerRevisions;
      expect(stack.manifest.id).toBe(`safe7579-f22a194-legacy-f24dddf-${chainId}-owner`);
      expect(stack.manifest.revision).toBe(ownerRevisions[chainId]);
    }
    expect(result.providers).toEqual([]);
  });
  it.each([1, 10, 8453, 42161])("opts into the current provider on reviewed chain %i without changing owner bindings", async chainId => {
    const result = await parse({ ...provider, chainId });
    const stack = result.stacks.find(s => s.manifest.chainId === chainId)!;
    expect(stack.manifest.revision).toBe(ownerRevisions[chainId as 1 | 10 | 8453 | 42161]);
    expect(stack.compilerStack).toBeUndefined();
    expect(() => stack.createCompiler()).toThrow(/deployment/);
    expect(result.providers[0]!.paymasterPolicy).toMatchObject({
      profile: "pimlico-v7-current-flags", contract: CURRENT_PIMLICO_PAYMASTER, maximumPaymasterDataLength: 130,
    });
    expect(result.paymasters[0]!.reviewId).toBe("pimlico-v7-current-flags");
  });
  it("does not extend current deployment evidence to unreviewed chains", async () => {
    await expect(parse({ ...provider, chainId: 11155111 })).rejects.toMatchObject({ code: "SMART_STACK_CONFIGURATION_INVALID" });
  });
  it("loads a private explicit current simulation origin without changing the owner manifest", async () => {
    const result = await parse({ ...provider, simulationBundlerAddress: guardAddress });
    expect(result.providers[0]!.simulationBundlerAddress).toBe(guardAddress);
    expect(result.stacks.find(s => s.manifest.chainId === 8453)!.manifest.revision).toBe(ownerRevisions[8453]);
  });
  it.each([
    { ...provider, paymasterProfile: "arbitrary" },
    { ...provider, sessionGuardVersion: "current-v2" },
    { ...provider, sessionGuardAddress: guardAddress },
    { ...provider, sessionGuardAddress: guardAddress, sessionGuardVersion: "legacy-v1" },
    { ...provider, paymasterProfile: "pimlico-v7-legacy-mode", sessionGuardAddress: guardAddress, sessionGuardVersion: "current-v2" },
    { ...provider, simulationBundlerAddress: "0x0000000000000000000000000000000000000000" },
    { ...provider, simulationBundlerAddress: "DO_NOT_LEAK_TEST_KEY" },
    { ...provider, paymasterProfile: "pimlico-v7-legacy-mode", simulationBundlerAddress: guardAddress },
  ])("rejects unknown or incompatible operator profile/guard selections (%#)", async input => {
    await expect(parse(input)).rejects.toMatchObject({ code: "REST_EXECUTION_CONFIG_INVALID" });
  });
  it("gives a reviewed V2 deployment its own manifest and retains the original compiler runtime pin", async () => {
    const result = await parse({ ...provider, sessionGuardAddress: guardAddress, sessionGuardVersion: "current-v2" });
    const stack = result.stacks.find(s => s.manifest.chainId === 8453)!;
    expect(stack.manifest.id).toBe("safe7579-f22a194-legacy-f24dddf-8453-guard-v2");
    expect(stack.manifest.revision).not.toBe(ownerRevisions[8453]);
    expect(stack.compilerStack!.sessionGuard).toMatchObject({ address: guardAddress, runtimeCodeHash: CURRENT_PIMLICO_GUARD_RUNTIME_HASH,
      source: { repository: "juicebox-center", contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(LEGACY_COMPILER_RUNTIME_HASHES.sessionGuard).toBe("0x996eea0614de4cd5549d17464e0352745411666d42650b20b7a9252dfd1c328c");
    await expect(createConfiguredSmartAccountStack({ chainId: 8453, paymasterProfile: "pimlico-v7-current-flags",
      sessionGuard: { address: guardAddress, runtimeCodeHash: LEGACY_COMPILER_RUNTIME_HASHES.sessionGuard, version: "current-v2" },
    })).rejects.toMatchObject({ code: "SMART_STACK_CONFIGURATION_INVALID" });
  });
  it("compiles unchanged SmartSession encoding with an exact V2 guard/paymaster binding", async () => {
    const { stack, record, review } = await currentSession();
    const guard = record.compiled.configurations.find(c => c.kind === "gas-budget")!;
    expect(record.compiled.stack).toBe("legacy-f24dddf-safe7579-f22a194");
    expect(record.compiled.manifestRevision).toBe(stack.manifest.revision);
    expect(guard.policy.runtimeCodeHash).toBe(CURRENT_PIMLICO_GUARD_RUNTIME_HASH);
    const decoded = decodeAbiParameters(SESSION_GUARD_INIT_ABI, guard.initData);
    expect(decoded[0].toLowerCase()).toBe(CURRENT_PIMLICO_PAYMASTER.address);
    expect(decoded[1]).toBe(CURRENT_PIMLICO_PAYMASTER.runtimeCodeHash);
    expect(decoded[8]).toBe(130);
    for (const change of [{ paymaster: guardAddress }, { paymasterCodeHash: zeroHash }, { paymasterReviewId: "legacy" }, { maxPaymasterDataLength: 131 }]) {
      const changed = structuredClone(review);
      Object.assign(changed.policy.gasBudget!, change);
      changed.policyHash = fingerprint(changed.policy);
      expect(() => stack.createCompiler().compile({ review: changed, activationEnableNonce: "0" })).toThrow(/exact reviewed current/);
    }
    expect(() => createLegacySessionCompiler({ stack: stack.compilerStack! }).compile({ review, activationEnableNonce: "0" }))
      .toThrow(/exact runtime/);
  });
  it("uses the V2 compiler storage proof while limiting estimates to the five original ceiling fields", async () => {
    const { record } = await currentSession();
    const guard = record.compiled.configurations.find(c => c.kind === "gas-budget")!;
    record.observation = sessionObservation(record, 1_800_000_000_000, { counters:
      [["requestedGas", "100000"], ["sponsoredCost", "200000"], ["calls", "100"]].map(([name, limit]) =>
        ({ policy: guard.policy.address, configId: guard.configId, name: name!, limit: limit!, used: "0" })) });
    const policy: UserOperationGasPolicy = {
      id: "fixture", maximumCallGas: 1000n, maximumVerificationGas: 1000n, maximumPreVerificationGas: 1000n,
      maximumPaymasterVerificationGas: 1000n, maximumPaymasterPostOpGas: 1000n,
      maximumFeePerGas: 2n, maximumPriorityFeePerGas: 1n, maximumCost: 200000n, requirePaymaster: true,
    };
    const op: UserOperationV07 = { sender: record.compiled.wallet, nonce: "0x0", callData: "0x12345678",
      callGasLimit: "0x64", verificationGasLimit: "0x64", preVerificationGas: "0x64", maxFeePerGas: "0x1",
      maxPriorityFeePerGas: "0x1", signature: "0x", paymaster: CURRENT_PIMLICO_PAYMASTER.address,
      paymasterData: `0x01${"00".repeat(77)}`, paymasterVerificationGasLimit: "0x64", paymasterPostOpGasLimit: "0x0" };
    const context = await createSessionGasEstimation(record, policy, op);
    const override = sessionGasEstimationOverrides(context, 8453, op);
    const mapping = (types: readonly { type: string }[], values: readonly unknown[]) =>
      keccak256(encodeAbiParameters(types, values));
    const idSlot = mapping([{ type: "bytes32" }, { type: "uint256" }], [guard.configId, 0n]);
    const moduleSlot = mapping([{ type: "address" }, { type: "bytes32" }], [record.compiled.smartSessions.address, idSlot]);
    const base = BigInt(mapping([{ type: "address" }, { type: "bytes32" }], [record.compiled.wallet, moduleSlot]));
    expect(Object.keys(override)).toEqual([guardAddress]);
    expect(Object.keys(override[guardAddress]!.stateDiff)).toEqual([2, 3, 4, 5, 6].map(offset => toHex(base + BigInt(offset), { size: 32 })));
    expect(() => context.assert({ ...op, callGasLimit: "0x3e8" })).toThrow(/owner-approved/);
    expect(() => sessionGasEstimationOverrides(context, 8453, { ...op, callData: "0xabcd" })).toThrow();
    guard.policy.runtimeCodeHash = zeroHash;
    await expect(createSessionGasEstimation(record, policy, op)).rejects.toMatchObject({ code: "SESSION_GAS_POLICY_UNVERIFIED" });
  });
});
