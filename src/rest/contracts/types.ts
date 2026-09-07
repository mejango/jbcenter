import type { Abi, AbiFunction, AbiParameter, Address, Hex } from "viem";

export type ContractCategory = "contract" | "abstract" | "interface" | "library" | "script";
export interface CatalogChain { id: number; name: string; testnet: boolean }
export interface CatalogPackage {
  id: string;
  repository: string;
  repositoryUrl: string;
  commit: string;
  version: string;
  category: "protocol" | "deployment" | "dependency";
}
export interface CodeSpan { start: number; length: number }
export interface CodeRecord {
  id: string;
  hashEncoding: "lowercase-hex-text";
  /** Compiler output, never a claim that this is the code at a deployed address. */
  runtimeTemplate: Hex;
  runtimeTemplateSha256: string;
  runtimeTemplateKeccak256: Hex;
  runtimeTemplateByteLength: number;
  creationSha256: string;
  /** null means no matching authoritative compiler output was available. */
  immutableReferences: readonly CodeSpan[] | null;
  linkReferences: readonly CodeSpan[] | null;
  compilerEvidence: null | {
    artifactPath: string;
    artifactSha256: string;
    compilerVersion: string;
    metadataSha256: string;
    sourceInputIdentitySha256?: string;
    deploymentPaths?: readonly string[];
  };
}
export interface SourceProvenance {
  kind: "deployment-artifact" | "clean-source-build";
  repository: string;
  repositoryUrl: string;
  commit: string;
  sourceRef: string;
  sourcePath: string;
  sourceKeccak256: Hex;
  compilerVersion: string;
  artifactPath: string;
  artifactSha256: string;
  metadataSha256: string;
  /** Solidity metadata hashes cover the complete compiler source closure. */
  sourceHashes: Readonly<Record<string, string>>;
  buildKind?: "verified-foundry-artifact" | "compiled-clean-git-sources" | "source-declaration";
  compilerInputSha256?: string;
  compilerBinarySha256?: string;
}
export interface ContractMethod {
  signature: string;
  /** Library external signatures may differ from normal ABI signatures. */
  selector: Hex | null;
  name: string;
  stateMutability: AbiFunction["stateMutability"];
  kind: "read" | "write";
  inputs: readonly AbiParameter[];
  outputs: readonly AbiParameter[];
}
export interface ContractAbiVariant {
  abiHash: string;
  abi: Abi;
  methods: readonly ContractMethod[];
  provenance: readonly SourceProvenance[];
  /** A source build can expose newer methods than published deployments. */
  usage: "published" | "source-only";
  /** Code from this ABI's source build; deployment entries select their own code. */
  codeIds: readonly string[];
}
export interface CloneFamily {
  standard: "erc-1167" | "solady-libclone";
  implementationContractId: string;
  factoryContractId: string;
  implementationGetter: string;
  sourcePath: string;
  sourceRef: string;
}
export interface DeploymentRecord {
  alias: string;
  address: Address;
  chainId: number;
  abiHash: string;
  codeId: string;
  artifactPath: string;
  artifactSha256: string;
  sourceRef: string;
  solcInputHash: string;
  compilerInputIdentitySha256: string;
  constructorArguments: readonly unknown[];
  receipt: { transactionHash: Hex; blockNumber: string; blockHash: Hex };
  /** Alias names and compiler bytecode alone do not establish clone identity. */
  instanceKind: "unclassified";
}
export interface ChainDeployments {
  chainId: number;
  status: "published" | "missing";
  instances: readonly DeploymentRecord[];
}
export interface ContractRecord {
  /** Package + source path + declaration name; contract names alone are not unique. */
  id: string;
  packageId: string;
  sourcePath: string;
  name: string;
  category: ContractCategory;
  executable: boolean;
  /** Published ABI preferred; use a deployment's abiHash for exact selection. */
  abi: Abi;
  abiHash: string;
  methods: readonly ContractMethod[];
  variants: readonly ContractAbiVariant[];
  deployments: readonly ChainDeployments[];
  cloneFamilies: readonly CloneFamily[];
}
export interface ContractCatalogData {
  schemaVersion: 1;
  protocolVersion: 6;
  chains: readonly CatalogChain[];
  packages: readonly CatalogPackage[];
  deploymentManifest: { repository: string; commit: string; treeDigest: string };
  generation: { sourceManifestHash: string; contentHash: string };
  exclusions: readonly { path: string; reason: string }[];
  contracts: readonly ContractRecord[];
  codes: readonly CodeRecord[];
}
export interface ContractFilter {
  packageId?: string;
  category?: ContractCategory;
  chainId?: number;
  deployedOnly?: boolean;
  executableOnly?: boolean;
}
export interface ContractDeploymentMatch { contract: ContractRecord; deployment: DeploymentRecord }
/** JSON Schema 2020-12. Integer ABI values use lossless decimal strings. */
export type JsonSchema = Readonly<Record<string, unknown>>;
