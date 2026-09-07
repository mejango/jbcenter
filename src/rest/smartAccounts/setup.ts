import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";
import { RestError } from "../core.js";
import { address, integer } from "../protocol/abi.js";
import {
  encodeSafe7579Execution,
  type Safe7579Call,
} from "./accountExecution.js";
import type { CompiledSession, LegacySession } from "./compiler/types.js";
import { compiledSessionHash } from "./compiler.js";
import { fingerprint } from "./service.js";

export type { LegacySession } from "./compiler/types.js";

const policyComponents = [
  { name: "policy", type: "address" },
  { name: "initData", type: "bytes" },
] as const;
/** Exact f24dddf Session tuple. Owner setup uses source-verified UNSAFE_ENABLE explicitly. */
export const LEGACY_SESSION_PARAMETERS = [
  {
    name: "sessions",
    type: "tuple[]",
    components: [
      { name: "sessionValidator", type: "address" },
      { name: "sessionValidatorInitData", type: "bytes" },
      { name: "salt", type: "bytes32" },
      { name: "userOpPolicies", type: "tuple[]", components: policyComponents },
      {
        name: "erc7739Policies",
        type: "tuple",
        components: [
          {
            name: "allowedERC7739Content",
            type: "tuple[]",
            components: [
              { name: "appDomainSeparator", type: "bytes32" },
              { name: "contentNames", type: "string[]" },
            ],
          },
          {
            name: "erc1271Policies",
            type: "tuple[]",
            components: policyComponents,
          },
        ],
      },
      {
        name: "actions",
        type: "tuple[]",
        components: [
          { name: "actionTargetSelector", type: "bytes4" },
          { name: "actionTarget", type: "address" },
          {
            name: "actionPolicies",
            type: "tuple[]",
            components: policyComponents,
          },
        ],
      },
      { name: "permitERC4337Paymaster", type: "bool" },
    ],
  },
] as const;
export const LEGACY_SESSION_SETUP_ABI = [
  {
    type: "function",
    name: "enableSessions",
    stateMutability: "nonpayable",
    inputs: LEGACY_SESSION_PARAMETERS,
    outputs: [{ name: "permissionIds", type: "bytes32[]" }],
  },
  ...parseAbi([
    "function removeSession(bytes32 permissionId)",
    "function revokeEnableSignature(bytes32 permissionId)",
    "function getNonce(bytes32 permissionId, address account) view returns (uint256)",
    "function onInstall(bytes data)",
  ]),
] as const;
export const SAFE7579_SETUP_ABI = parseAbi([
  "function installModule(uint256 moduleType, address module, bytes initData)",
]);

export interface OwnerSessionTransaction {
  /** A Safe owner transaction performs CALL to the Safe itself; its fallback reaches Safe7579. */
  to: Address;
  value: "0";
  data: Hex;
  operation: 0;
}

function fail(message: string): never {
  throw new RestError(400, "SMART_SESSION_SETUP_INVALID", message);
}
function permissionIdOf(session: LegacySession): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("address, bytes, bytes32"), [
      session.sessionValidator,
      session.sessionValidatorInitData,
      session.salt,
    ]),
  );
}
function checkedCompiled(compiled: CompiledSession): void {
  if (
    compiled.compiledHash !== compiledSessionHash(compiled) ||
    compiled.policyHash !== fingerprint(compiled.reviewedPolicy)
  )
    fail("The compiled session or its reviewed policy has changed.");
  if (compiled.stack !== "legacy-f24dddf-safe7579-f22a194")
    fail("Owner setup requires the exact compiled legacy stack.");
  address(compiled.wallet, "wallet", true);
  address(compiled.smartSessions.address, "smartSessions", true);
  integer(compiled.activationEnableNonce, "activationEnableNonce");
  const session = compiled.session;
  if (
    session.salt.toLowerCase() !== compiled.salt.toLowerCase() ||
    BigInt(session.salt) === 0n ||
    permissionIdOf(session).toLowerCase() !==
      compiled.permissionId.toLowerCase()
  )
    fail("The compiled session salt and permission identity must match.");
  if (
    session.erc7739Policies.allowedERC7739Content.length !== 0 ||
    session.erc7739Policies.erc1271Policies.length !== 0
  )
    fail("Session setup cannot authorize arbitrary signing.");
  if (session.actions.length < 1 || session.actions.length > 16)
    fail("Session setup requires a bounded nonempty action list.");
  for (const action of session.actions) {
    const target = address(action.actionTarget, "action.target", true);
    if (
      BigInt(target) === 1n ||
      target.toLowerCase() === compiled.wallet.toLowerCase() ||
      target.toLowerCase() === compiled.smartSessions.address.toLowerCase() ||
      action.actionPolicies.length === 0
    )
      fail(
        "Session setup cannot enable wildcard, self, module, or policy-free actions.",
      );
  }
}
function ownerTransaction(
  wallet: Address,
  calls: readonly Safe7579Call[],
): OwnerSessionTransaction {
  return {
    to: wallet,
    value: "0",
    data: encodeSafe7579Execution(calls),
    operation: 0,
  };
}
function identity(compiled: CompiledSession) {
  return {
    chainId: compiled.chainId,
    wallet: compiled.wallet,
    bindingId: compiled.bindingId,
    grantId: compiled.grantId,
    generation: compiled.generation,
    policyHash: compiled.policyHash,
    compiledHash: compiled.compiledHash,
    permissionId: compiled.permissionId,
    manifestRevision: compiled.manifestRevision,
    activationEnableNonce: compiled.activationEnableNonce,
  };
}

/** Trusted compiler output only. This prepares owner calldata and does not claim activation. */
export function encodeOwnerSessionSetup(input: {
  compiled: CompiledSession;
  moduleInstalled: boolean;
  /** Complete canonical-chain enumeration supplied by the installed-state verifier. */
  enabledPermissionIds: readonly Hex[];
}) {
  const { compiled } = input;
  checkedCompiled(compiled);
  if (typeof input.moduleInstalled !== "boolean")
    fail("Use verified module installation state.");
  if (
    !Array.isArray(input.enabledPermissionIds) ||
    input.enabledPermissionIds.length !== 0
  )
    fail(
      "Owner setup requires proof of zero enabled sessions; revoke existing sessions explicitly first.",
    );
  // f24dddf onInstall slices the first byte, then decodes abi.encode(Session[]).
  const installData = concatHex([
    "0x02",
    encodeAbiParameters(LEGACY_SESSION_PARAMETERS, [[compiled.session]]),
  ]);
  const call: Safe7579Call = input.moduleInstalled
    ? {
        target: compiled.smartSessions.address,
        value: "0",
        callData: encodeFunctionData({
          abi: LEGACY_SESSION_SETUP_ABI,
          functionName: "onInstall",
          args: [installData],
        }),
      }
    : {
        target: compiled.wallet,
        value: "0",
        callData: encodeFunctionData({
          abi: SAFE7579_SETUP_ABI,
          functionName: "installModule",
          args: [1n, compiled.smartSessions.address, installData],
        }),
      };
  return {
    ...identity(compiled),
    requiredAuthority: "safe-current-owner-threshold" as const,
    registryMode: "owner-approved-source-verified-unsafe-enable" as const,
    operation: input.moduleInstalled
      ? ("initialize-empty-session-module" as const)
      : ("install-validator-and-session" as const),
    calls: [call],
    transaction: ownerTransaction(compiled.wallet, [call]),
  };
}

/** Both calls execute atomically under default batch CALL; neither session removal alone nor module
 * uninstallation proves durable revocation because outstanding owner enable signatures have nonces. */
export function encodeOwnerSessionRevocation(input: {
  compiled: CompiledSession;
  currentEnableNonce: string;
}) {
  const { compiled } = input;
  checkedCompiled(compiled);
  const current = integer(input.currentEnableNonce, "currentEnableNonce");
  if (current < BigInt(compiled.activationEnableNonce))
    fail("The observed enable nonce predates the activation review.");
  if (current === (1n << 256n) - 1n)
    fail("The enable nonce cannot be advanced.");
  const calls: Safe7579Call[] = (
    ["removeSession", "revokeEnableSignature"] as const
  ).map((functionName) => ({
    target: compiled.smartSessions.address,
    value: "0",
    callData: encodeFunctionData({
      abi: LEGACY_SESSION_SETUP_ABI,
      functionName,
      args: [compiled.permissionId],
    }),
  }));
  return {
    ...identity(compiled),
    requiredAuthority: "safe-current-owner-threshold" as const,
    operation: "remove-session-and-invalidate-enable-signature" as const,
    observedEnableNonce: current.toString(),
    requiredPostState: {
      enabled: false as const,
      minimumEnableNonce: (current + 1n).toString(),
    },
    calls,
    transaction: ownerTransaction(compiled.wallet, calls),
  };
}
