import type { Address, Hex } from "viem";
import type { RestBlockEvidence } from "../../core.js";
import type { ContractPin } from "../types.js";

export interface LegacyPolicyData {
  policy: Address;
  initData: Hex;
}
export interface LegacyActionData {
  actionTargetSelector: Hex;
  actionTarget: Address;
  actionPolicies: LegacyPolicyData[];
}
/** Exact f24dddf Session tuple; this type is not accepted as caller-supplied policy authority. */
export interface LegacySession {
  sessionValidator: Address;
  sessionValidatorInitData: Hex;
  salt: Hex;
  userOpPolicies: LegacyPolicyData[];
  erc7739Policies: { allowedERC7739Content: []; erc1271Policies: [] };
  actions: LegacyActionData[];
  permitERC4337Paymaster: boolean;
}
export interface ParameterRule {
  condition: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  offset: string;
  isLimited: boolean;
  ref: Hex;
  usage: { limit: string; used: string };
}
export interface UniversalActionConfig {
  valueLimitPerUse: string;
  paramRules: { length: string; rules: ParameterRule[] };
}
export interface CompiledPolicyConfiguration {
  kind:
    | "time-frame"
    | "universal-action"
    | "value-limit"
    | "usage-limit"
    | "gas-budget";
  policy: ContractPin;
  configId: Hex;
  scope: "user-operation" | "action";
  actionId?: Hex;
  initData: Hex;
  decoded: unknown;
}
export interface CompiledSession {
  schemaVersion: 1;
  stack: "legacy-f24dddf-safe7579-f22a194";
  ownerAccountId: string;
  bindingId: Hex;
  grantId: string;
  sessionKey: Address;
  chainId: number;
  wallet: Address;
  generation: string;
  nonce: Hex;
  validAfter: number;
  validUntil: number;
  salt: Hex;
  policyHash: Hex;
  compiledHash: Hex;
  permissionId: Hex;
  manifestRevision: Hex;
  /** Owner review includes this nonce; revocation must advance it and remove the session. */
  activationEnableNonce: string;
  reviewedPolicy: unknown;
  smartSessions: ContractPin;
  sessionValidator: ContractPin;
  session: LegacySession;
  configurations: CompiledPolicyConfiguration[];
}
export interface InstalledSessionObservation {
  permissionId: Hex;
  compiledHash: Hex;
  account: Address;
  chainId: number;
  enabled: boolean;
  enableNonce: string;
  configurationHash: Hex;
  evidence: RestBlockEvidence;
  counters: {
    policy: Address;
    configId: Hex;
    name: string;
    used: string;
    limit: string;
  }[];
  /** Complete canonical administration trace evidence attached by the lifecycle service at the same block. */
  administration?: {
    epoch: string;
    hash: Hex;
    lastInitialization?: { epoch: string; permissionIds: Hex[] };
  };
}
