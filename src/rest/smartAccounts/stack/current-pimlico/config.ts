import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getAddress, isAddress, keccak256, type Address, type Hex } from "viem";
import { RestError } from "../../../core.js";
import { fingerprint } from "../../service.js";
import type { ContractPin } from "../../types.js";
import {
  CURRENT_PIMLICO_GUARD_MANIFEST_SHA256,
  CURRENT_PIMLICO_GUARD_RUNTIME_HASH,
  CURRENT_PIMLICO_PAYMASTER,
  CURRENT_PIMLICO_PAYMASTER_MANIFEST_SHA256,
} from "./pins.js";

type Source = {
  repo?: string; repository?: string; commit?: string; sha256?: string;
  artifactSha256?: string; compilerArtifactSha256?: string; compilerOutputSha256?: string;
};
type Component = {
  path: string; fileSha256: string; address: Address | null; runtimeCodeHash: Hex;
  source: Source; chainIds: number[];
};
type Artifact = {
  contractName: string; deployedRuntimeBytecode?: Hex; deployedBytecode?: Hex;
  address: Address | null; runtimeCodeHash: Hex; source: Source;
  compiler?: { version: string };
};
function invalid(message: string): never {
  throw new RestError(500, "SMART_STACK_CONFIGURATION_INVALID", message);
}
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function checkedJson(path: string, expectedSha: string) {
  const bytes = await readFile(new URL(path, import.meta.url));
  if (bytes.length > 2_000_000 || sha(bytes) !== expectedSha)
    invalid("The current sponsor package differs from its reviewed content hash.");
  return JSON.parse(bytes.toString("utf8"));
}
async function checkedComponent(component: Component, name: string, runtimeHash: Hex): Promise<Artifact> {
  if (!component || component.path !== `artifacts/${name}.json` || component.runtimeCodeHash !== runtimeHash)
    invalid("The current sponsor component has an unreviewed identity.");
  const artifact = await checkedJson(component.path, component.fileSha256) as Artifact;
  const runtime = artifact.deployedRuntimeBytecode ?? artifact.deployedBytecode;
  if (artifact.contractName !== name || typeof runtime !== "string" ||
      !/^0x(?:[0-9a-fA-F]{2})+$/.test(runtime) || keccak256(runtime) !== runtimeHash ||
      artifact.runtimeCodeHash !== runtimeHash || fingerprint(artifact.source) !== fingerprint(component.source) ||
      artifact.address?.toLowerCase() !== component.address?.toLowerCase())
    invalid("The current sponsor ABI, runtime and source artifact are inconsistent.");
  return artifact;
}
function pin(component: Component, address = component.address): ContractPin {
  if (!address || !isAddress(address) || BigInt(address) === 0n)
    invalid("A verified operator deployment address is required.");
  const source = component.source, repository = source.repo ?? source.repository;
  const artifactSha256 = source.artifactSha256 ?? source.compilerArtifactSha256 ?? source.compilerOutputSha256;
  if (!repository || !/^[0-9a-f]{64}$/.test(artifactSha256 ?? "") ||
      (source.commit ? !/^[0-9a-f]{40}$/.test(source.commit) :
        repository !== "juicebox-center" || !/^[0-9a-f]{64}$/.test(source.sha256 ?? "")))
    invalid("The current sponsor component has no exact reviewed source identity.");
  return { address: getAddress(address), runtimeCodeHash: component.runtimeCodeHash,
    source: source.commit ? { repository, commit: source.commit, artifactSha256: artifactSha256! } :
      { repository, contentSha256: source.sha256!, artifactSha256: artifactSha256! } };
}
export async function currentPimlicoPaymaster(chainId: number) {
  const manifest = await checkedJson("paymaster-manifest.json", CURRENT_PIMLICO_PAYMASTER_MANIFEST_SHA256);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.chainIds) || !manifest.chainIds.includes(chainId) ||
      !manifest.component?.chainIds?.includes(chainId))
    invalid("The current sponsor deployment has no reviewed evidence for this chain.");
  await checkedComponent(manifest.component, "PimlicoSingletonPaymasterV7", CURRENT_PIMLICO_PAYMASTER.runtimeCodeHash);
  if (manifest.component.address?.toLowerCase() !== CURRENT_PIMLICO_PAYMASTER.address)
    invalid("The current sponsor address differs from the reviewed deployment.");
  return { ...pin(manifest.component), profileId: "pimlico-v7-current-flags" as const,
    paymasterAndDataBytes: 130 as const, paymasterDataBytes: 78 as const,
    modeOffset: 52 as const, modeValue: 0 as const, modeShift: 1 as const };
}
export async function currentPimlicoGuardPackage() {
  const manifest = await checkedJson("guard-manifest.json", CURRENT_PIMLICO_GUARD_MANIFEST_SHA256);
  if (manifest.schemaVersion !== 1 || manifest.component?.address !== null ||
      !Array.isArray(manifest.component?.chainIds) || manifest.component.chainIds.length !== 0 ||
      manifest.storageProof?.path !== "evidence/guard-storage.json")
    invalid("The current guard package must preserve its undeployed source provenance.");
  const artifact = await checkedComponent(manifest.component, "CenterSessionGuardV2", CURRENT_PIMLICO_GUARD_RUNTIME_HASH);
  const proof = await checkedJson(manifest.storageProof.path, manifest.storageProof.fileSha256);
  if (proof.schemaVersion !== 1 || proof.runtimeCodeHash !== CURRENT_PIMLICO_GUARD_RUNTIME_HASH ||
      proof.sourceSha256 !== artifact.source.sha256 || proof.compiler?.version !== artifact.compiler?.version)
    invalid("The current guard storage proof differs from its reviewed source and compiler.");
  return { component: manifest.component as Component, artifact, proof };
}
export async function currentPimlicoGuard(address: Address) {
  return pin((await currentPimlicoGuardPackage()).component, address);
}
