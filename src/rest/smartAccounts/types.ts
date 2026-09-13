import type { Address, Hex } from "viem";
import type { RestBlockEvidence, RestRpc } from "../core.js";
import type { BotScope } from "../auth/store.js";
import type { OnboardingStore } from "./onboarding.js";

export interface ContractPin {
  address: Address;
  runtimeCodeHash: Hex;
  source: {
    repository: string;
    commit?: string;
    contentSha256?: string;
    artifactSha256: string;
  };
}
/** Explicit opt-in; the legacy EOA profile remains the default for existing manifests. */
export interface PasskeyOwnerProfile {
  version: "center-passkey-v1";
  signerFactory: ContractPin;
  signerSingleton: ContractPin;
  /** Reviewed Solidity FCL verifier only. No implicit chain precompile assumption. */
  p256Verifier: ContractPin;
}
export interface PasskeyOwnerState {
  version: "center-passkey-v1";
  signer: {
    address: Address;
    kind: "contract";
    x: Hex;
    y: Hex;
    verifiers: Hex;
    runtimeCodeHash: Hex;
  };
  recoveryOwner: { address: Address; kind: "ecdsa" };
}
export interface PasskeyCreationProfile {
  version: "center-passkey-bootstrap-v1";
  multiSend: ContractPin;
}
/** Server-owned reviewed deployment configuration. Never accepted from HTTP request bodies. */
export interface SmartAccountManifest {
  id: string;
  mode: "ownership-only" | "execution-candidate";
  chainId: number;
  revision: Hex;
  safeVersion: "1.4.1";
  proxyRuntimeCodeHash: Hex;
  singleton: ContractPin;
  factory: ContractPin;
  safe7579: ContractPin;
  launchpad: ContractPin;
  /** Omitted for an ownership-binding-only manifest whose EntryPoint source identity is unproved. */
  entryPoint?: ContractPin & { version: "0.7" };
  smartSessions: ContractPin & { generation: "legacy-validator" | "emissary" };
  policies: readonly ContractPin[];
  /** Pin the adapter that enumerates validators/executors/hooks/fallbacks/attesters. */
  moduleInspectorId: string;
  ownerProfile?: PasskeyOwnerProfile;
  creationProfile?: PasskeyCreationProfile;
}
export interface SmartSnapshot {
  evidence: RestBlockEvidence;
  tag: { blockHash: Hex; requireCanonical: true };
  request(
    method: string,
    paramsBeforeBlock: readonly unknown[],
  ): Promise<unknown>;
}
export interface ModuleStateEvidence {
  /** Hash of the complete module/validator/hook/fallback/registry/attester configuration. */
  stateHash: Hex;
  complete: true;
  arbitrarySigningDisabled: true;
  wildcardExecutionDisabled: true;
  details: unknown;
}
/** Implementations are trusted host adapters tied to a reviewed source revision, not client proofs. */
export interface SmartModuleInspector {
  id: string;
  inspect(input: {
    account: Address;
    manifest: SmartAccountManifest;
    snapshot: SmartSnapshot;
  }): Promise<ModuleStateEvidence>;
}
export interface SmartAccountState {
  chainId: number;
  address: Address;
  manifestId: string;
  manifestRevision: Hex;
  owners: Address[];
  threshold: number;
  safeNonce: string;
  stateHash: Hex;
  evidence: RestBlockEvidence;
  codeHashes: { address: Address; runtimeCodeHash: Hex }[];
  modules: ModuleStateEvidence | null;
  moduleConfigurationVerified: boolean;
  executionVerified: boolean;
  ownerProfile?: PasskeyOwnerState;
}
export interface SmartAccountBinding {
  id: Hex;
  ownerAccountId: string;
  ownerAddress: Address;
  wallet: { chainId: number; address: Address };
  manifestId: string;
  authorization: {
    digest: Hex;
    nonce: Hex;
    expiresAt: number;
    method: "safe-current-owner-threshold" | "safe-current-owner-threshold-and-api-grant" | "safe-passkey-owner-threshold-and-api-grant";
    setup?: {
      manifestRevision: Hex; initializerHash: Hex; issuedAt: number; grantId: string;
      botAddress: Address; scopes: BotScope[]; grantExpiresAt: number; label: string;
    };
  };
  state: SmartAccountState;
}
/** Production hosts must provide durable nonce uniqueness and account ownership isolation. */
export interface VerifiedSmartAccountRegistry {
  bind(record: SmartAccountBinding): Promise<SmartAccountBinding>;
  get(
    ownerAccountId: string,
    id: Hex,
  ): Promise<SmartAccountBinding | undefined>;
  revoke(ownerAccountId: string, id: Hex): Promise<void>;
  list(ownerAccountId: string): Promise<SmartAccountBinding[]>;
}
export interface SmartBundler {
  /** Configured transport; callers cannot supply URLs or credentials. */
  request(
    chainId: number,
    method: "eth_chainId" | "eth_supportedEntryPoints",
    params: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<unknown>;
}
export interface SmartAccountDependencies {
  rpc: RestRpc;
  manifests: readonly SmartAccountManifest[];
  /** Source-pinned older manifests retained for existing bindings and receipt reconciliation. */
  retainedManifests?: readonly SmartAccountManifest[];
  registry: VerifiedSmartAccountRegistry;
  onboarding?: OnboardingStore;
  audience: string;
  moduleInspectors?: readonly SmartModuleInspector[];
  bundler?: SmartBundler;
  now?: () => number;
}

export interface Allocation {
  id: string;
  chainId: number;
  asset: Address;
  limit: string;
}
export interface AllocationGroup {
  id: string;
  total: string;
  allocations: Allocation[];
}
export type SessionAction =
  | {
      kind: "v6-project-uri";
      controller: Address;
      projectId: string;
    }
  | {
      kind: "erc20-transfer";
      allocationId: string;
      beneficiary: Address;
      perCallLimit: string;
      totalLimit: string;
    }
  | {
      kind: "v6-pay";
      allocationId: string;
      terminal: Address;
      projectId: string;
      beneficiary: Address;
      perCallLimit: string;
      totalLimit: string;
      /** Exact minimum; the bot cannot replace it with zero. */
      minReturnedTokens: string;
    };
export interface SessionPolicyInput {
  bindingId: Hex;
  grantId: string;
  generation: string;
  nonce: Hex;
  validAfter: number;
  durationDays: 7 | 30;
  maximumCalls: string;
  gasBudget?: {
    paymaster: Address;
    maxGasPerOperation: string;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
    totalGasLimit: string;
    totalSponsoredCostLimit: string;
    maxPaymasterDataLength: number;
  };
  allocations: AllocationGroup[];
  actions: SessionAction[];
}
