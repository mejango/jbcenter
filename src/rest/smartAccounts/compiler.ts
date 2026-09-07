import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  keccak256,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { RestError } from "../core.js";
import { createSessionPolicyReviewer } from "./policy.js";
import { fingerprint } from "./service.js";
import type { ContractPin } from "./types.js";
import type {
  CompiledPolicyConfiguration,
  CompiledSession,
  LegacyPolicyData,
  LegacySession,
} from "./compiler/types.js";
import {
  actionConfigId,
  actionIdOf,
  amountRule,
  encodeTimeFrame,
  encodeUniversalAction,
  equalRule,
  exactUint,
  permissionIdOf,
  userOpConfigId,
} from "./compiler/encoding.js";

export type SessionReview = Awaited<
  ReturnType<ReturnType<typeof createSessionPolicyReviewer>["review"]>
>;
export interface SessionCompilerStack {
  smartSessions: ContractPin;
  sessionValidator: ContractPin;
  timeFrame: ContractPin;
  universalAction: ContractPin;
  valueLimit: ContractPin;
  /** Deployment of the source-bound CenterSessionGuard; never an arbitrary caller-supplied address. */
  sessionGuard: ContractPin;
}
/** Exact runtime identities whose ABI, policy semantics and installed storage this compiler implements. */
export const LEGACY_COMPILER_RUNTIME_HASHES = {
  smartSessions:
    "0xf2817b8943b9fc813ad3602de2f0b973dc6b7e190f1b77dc9eb02b8d3022ab0c",
  sessionValidator:
    "0xd9ad90a204447aec1a1528d764e1d80212c8011dc0125b3995875e58ec9a43bf",
  timeFrame:
    "0xa8c18f7a974673552d03d7325bbc33a102a5aaab5bc5a3c11ecae1648ca4e026",
  universalAction:
    "0xc58f13d259c69d0db90f611347535e2d5642f3352740b7d58fbf6e6b939670dd",
  valueLimit:
    "0x086e8421c6c9daab4a93e63366c83e8f20cc3f736b7be5a97e0e81633581e4ed",
  sessionGuard:
    "0x996eea0614de4cd5549d17464e0352745411666d42650b20b7a9252dfd1c328c",
} as const;
export const SESSION_GUARD_INIT_ABI = [
  { name: "paymaster", type: "address" },
  { name: "paymasterCodeHash", type: "bytes32" },
  { name: "maxGasPerOperation", type: "uint256" },
  { name: "maxFeePerGas", type: "uint256" },
  { name: "maxPriorityFeePerGas", type: "uint256" },
  { name: "totalGasLimit", type: "uint256" },
  { name: "totalSponsoredCostLimit", type: "uint256" },
  { name: "maximumCalls", type: "uint128" },
  { name: "maxPaymasterDataLength", type: "uint32" },
] as const;
const NATIVE = "0x000000000000000000000000000000000000EEEe";
const same = isAddressEqual;
const ACTION_ABI = parseAbi([
  "function transfer(address to,uint256 value) returns (bool)",
  "function pay(uint256 projectId,address token,uint256 amount,address beneficiary,uint256 minReturnedTokens,string memo,bytes metadata) payable returns (uint256)",
  "function setUriOf(uint256 projectId,string uri)",
]);
function invalid(message: string): never {
  throw new RestError(422, "SMART_SESSION_COMPILATION_REJECTED", message);
}
export function compiledSessionHash(
  compiled: Omit<CompiledSession, "compiledHash"> | CompiledSession,
): Hex {
  const { compiledHash: _ignored, ...body } = compiled as CompiledSession;
  return fingerprint(body);
}

/** Pure compiler for server-reviewed policies. Deployment/state verification is a separate mandatory step. */
export function createLegacySessionCompiler(options: {
  stack: SessionCompilerStack;
}) {
  return {
    compile({
      review,
      activationEnableNonce,
    }: {
      review: SessionReview;
      activationEnableNonce: string;
    }): CompiledSession {
      const p = review.policy;
      if (
        review.policyHash !== fingerprint(p) ||
        p.restrictToActions !== true ||
        p.signing.mode !== "disabled" ||
        p.wildcardFallback !== false ||
        p.crossChainPermits !== false ||
        p.claimPolicies !== false
      )
        invalid(
          "Compilation requires the exact closed server-reviewed policy and its complete digest.",
        );
      if (!p.gasBudget)
        invalid(
          "An executable session requires a mandatory hosted-paymaster gas budget.",
        );
      if (
        p.actions.length < 1 ||
        p.actions.length > 16 ||
        BigInt(p.salt) === 0n
      )
        invalid("Use a distinct nonzero salt and bounded explicit actions.");
      exactUint(activationEnableNonce);
      for (const [role, pin] of Object.entries(options.stack)) {
        if (
          !pin ||
          same(pin.address, zeroAddress) ||
          !/^0x[0-9a-fA-F]{64}$/.test(pin.runtimeCodeHash) ||
          !pin.source.artifactSha256
        )
          invalid(
            "Every compiled dependency needs a server-owned exact runtime and source artifact pin.",
          );
        if (
          pin.runtimeCodeHash.toLowerCase() !==
          LEGACY_COMPILER_RUNTIME_HASHES[role as keyof SessionCompilerStack]
        )
          invalid(
            "The configured module generation does not match this compiler's exact runtime and storage semantics.",
          );
      }
      const {
        smartSessions,
        sessionValidator,
        timeFrame,
        universalAction,
        valueLimit,
        sessionGuard,
      } = options.stack;
      const session: LegacySession = {
        sessionValidator: sessionValidator.address,
        sessionValidatorInitData: encodeAbiParameters(
          [{ type: "uint256" }, { type: "address[]" }],
          [1n, [p.sessionKey]],
        ),
        salt: p.salt,
        userOpPolicies: [],
        erc7739Policies: { allowedERC7739Content: [], erc1271Policies: [] },
        actions: [],
        permitERC4337Paymaster: true,
      };
      const permissionId = permissionIdOf(session);
      const globalConfigId = userOpConfigId(p.wallet, permissionId);
      const configurations: CompiledPolicyConfiguration[] = [];
      const add = (
        policy: ContractPin,
        kind: CompiledPolicyConfiguration["kind"],
        initData: Hex,
        decoded: unknown,
        actionId?: Hex,
      ): LegacyPolicyData => {
        configurations.push({
          kind,
          policy,
          configId: actionId
            ? actionConfigId(p.wallet, permissionId, actionId)
            : globalConfigId,
          scope: actionId ? "action" : "user-operation",
          ...(actionId ? { actionId } : {}),
          initData,
          decoded,
        });
        return { policy: policy.address, initData };
      };
      session.userOpPolicies.push(
        add(
          timeFrame,
          "time-frame",
          encodeTimeFrame(p.validAfter, p.validUntil),
          { validAfter: p.validAfter, validUntil: p.validUntil },
        ),
      );
      const gas = p.gasBudget;
      const guardDecoded = {
        paymaster: gas.paymaster,
        paymasterCodeHash: gas.paymasterCodeHash,
        maxGasPerOperation: gas.maxGasPerOperation,
        maxFeePerGas: gas.maxFeePerGas,
        maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
        totalGasLimit: gas.totalGasLimit,
        totalSponsoredCostLimit: gas.totalSponsoredCostLimit,
        maximumCalls: p.maximumCalls,
        maxPaymasterDataLength: gas.maxPaymasterDataLength,
      };
      session.userOpPolicies.push(
        add(
          sessionGuard,
          "gas-budget",
          encodeAbiParameters(SESSION_GUARD_INIT_ABI, [
            gas.paymaster,
            gas.paymasterCodeHash,
            exactUint(gas.maxGasPerOperation),
            exactUint(gas.maxFeePerGas),
            exactUint(gas.maxPriorityFeePerGas),
            exactUint(gas.totalGasLimit),
            exactUint(gas.totalSponsoredCostLimit),
            exactUint(p.maximumCalls, 128),
            gas.maxPaymasterDataLength,
          ]),
          guardDecoded,
        ),
      );
      const usedActions = new Set<string>();
      for (const action of p.actions) {
        if (
          same(action.target, p.wallet) ||
          same(action.target, smartSessions.address) ||
          same(action.target, zeroAddress) ||
          BigInt(action.target) === 1n
        )
          invalid("Wildcard and account/module self-calls are forbidden.");
        const actionId = actionIdOf(action.target, action.selector);
        if (usedActions.has(actionId))
          invalid(
            "Duplicate target/selector action constraints are ambiguous.",
          );
        usedActions.add(actionId);
        const native = action.kind === "v6-pay" && same(action.asset, NATIVE);
        const rules =
          action.kind === "v6-project-uri"
            ? [equalRule(0, action.projectId), equalRule(32, 64n)]
            : action.kind === "erc20-transfer"
              ? [
                  equalRule(0, action.beneficiary),
                  amountRule(32, action.perCallLimit, action.totalLimit),
                ]
              : [
                  equalRule(0, action.projectId!),
                  equalRule(32, action.asset),
                  amountRule(64, action.perCallLimit, action.totalLimit),
                  equalRule(96, action.beneficiary),
                  equalRule(128, action.minReturnedTokens!),
                  equalRule(160, 224n),
                  equalRule(192, 256n),
                  equalRule(224, 0n),
                  equalRule(256, 0n),
                ];
        const config = encodeUniversalAction(
          native ? action.perCallLimit! : "0",
          rules,
        );
        const actionPolicies = [
          add(
            universalAction,
            "universal-action",
            config.initData,
            config.decoded,
            actionId,
          ),
        ];
        if (native)
          actionPolicies.push(
            add(
              valueLimit,
              "value-limit",
              encodeAbiParameters(
                [{ type: "uint256" }],
                [exactUint(action.totalLimit!)],
              ),
              { valueLimit: action.totalLimit },
              actionId,
            ),
          );
        session.actions.push({
          actionTarget: action.target,
          actionTargetSelector: action.selector,
          actionPolicies,
        });
      }
      const body: Omit<CompiledSession, "compiledHash"> = {
        schemaVersion: 1,
        stack: "legacy-f24dddf-safe7579-f22a194",
        ownerAccountId: p.ownerAccountId,
        bindingId: p.bindingId,
        grantId: p.grantId,
        sessionKey: p.sessionKey,
        chainId: p.chainId,
        wallet: p.wallet,
        generation: p.generation,
        nonce: p.nonce,
        validAfter: p.validAfter,
        validUntil: p.validUntil,
        salt: p.salt,
        policyHash: review.policyHash,
        permissionId,
        manifestRevision: review.manifestRevision,
        activationEnableNonce,
        reviewedPolicy: p,
        smartSessions,
        sessionValidator,
        session,
        configurations,
      };
      return { ...body, compiledHash: compiledSessionHash(body) };
    },
  };
}

/** Independent ABI decode/reencode of a proposed SINGLE inner call. Onchain policies enforce counters. */
export function assertCompiledSessionCall(
  compiled: CompiledSession,
  call: { target: Address; value: string; callData: Hex },
): void {
  if (
    compiled.compiledHash !== compiledSessionHash(compiled) ||
    compiled.policyHash !== fingerprint(compiled.reviewedPolicy)
  )
    invalid("The persisted compiled session has changed.");
  const p = compiled.reviewedPolicy as SessionReview["policy"];
  const value = exactUint(call.value);
  const action = p.actions.find(
    (a) =>
      same(a.target, call.target) &&
      a.selector.toLowerCase() === call.callData.slice(0, 10).toLowerCase(),
  );
  if (!action)
    invalid("The call target and selector are outside this session.");
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: ACTION_ABI, data: call.callData });
  } catch {
    return invalid(
      "The call cannot be independently decoded as its allowed V6 action.",
    );
  }
  if (
    encodeFunctionData({
      abi: ACTION_ABI,
      functionName: decoded.functionName,
      args: decoded.args as never,
    }).toLowerCase() !== call.callData.toLowerCase()
  )
    invalid("Noncanonical or trailing action calldata is rejected.");
  if (action.kind === "v6-project-uri") {
    if (
      decoded.functionName !== "setUriOf" ||
      decoded.args[0] !== BigInt(action.projectId) ||
      value !== 0n
    )
      invalid(
        "Project URI writes must keep the fixed project and zero native value.",
      );
    return;
  }
  const native = action.kind === "v6-pay" && same(action.asset, NATIVE);
  if ((!native && value !== 0n) || value > BigInt(action.perCallLimit))
    invalid("The native value exceeds this action's permission.");
  if (action.kind === "erc20-transfer") {
    if (
      decoded.functionName !== "transfer" ||
      !same(decoded.args[0], action.beneficiary) ||
      decoded.args[1] > BigInt(action.perCallLimit)
    )
      invalid(
        "ERC20 transfer arguments exceed the fixed beneficiary or amount policy.",
      );
  } else if (
    decoded.functionName !== "pay" ||
    decoded.args[0] !== BigInt(action.projectId!) ||
    !same(decoded.args[1], action.asset) ||
    decoded.args[2] > BigInt(action.perCallLimit) ||
    !same(decoded.args[3], action.beneficiary) ||
    decoded.args[4] !== BigInt(action.minReturnedTokens!) ||
    decoded.args[5] !== "" ||
    decoded.args[6] !== "0x"
  )
    invalid(
      "V6 pay arguments exceed the fixed project, asset, beneficiary, minimum, amount or empty metadata policy.",
    );
}

export * from "./compiler/types.js";
