import type { Address, Hex } from "viem";
import type { RestBlockEvidence, RestRpc } from "../core.js";

export interface ContractPin {
  address: Address;
  runtimeCodeHash: Hex;
  source: { repository: string; commit: string; artifactSha256: string };
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
    method: "safe-current-owner-threshold";
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
  registry: VerifiedSmartAccountRegistry;
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
  allocations: AllocationGroup[];
  actions: SessionAction[];
}
