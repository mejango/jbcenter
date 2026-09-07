import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256 } from "viem";

const root = dirname(fileURLToPath(import.meta.url));
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const fail = (message) => { throw new Error(message); };
const read = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));
const catalog = await read("evidence/artifact-catalog.json");
const gasEvidence = await read("evidence/gas-and-usage-policy.json");
const chainIds = [1, 10, 8453, 42161, 84532, 421614, 11155111, 11155420];
const components = {};

function verifyRuntime(name, artifact) {
  const code = artifact.deployedRuntimeBytecode || artifact.deployedBytecode;
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(code) || keccak256(code) !== artifact.runtimeCodeHash) {
    fail(`${name}: runtime hash mismatch`);
  }
  if (!Array.isArray(artifact.abi) || artifact.abi.length === 0) fail(`${name}: missing ABI`);
  if (artifact.deployedRuntimeBytecode) {
    let reconstructed = artifact.deployedBytecode.slice(2);
    const touched = new Set();
    for (const binding of Object.values(artifact.immutables)) {
      for (const reference of binding.references) {
        if (binding.value.length !== reference.length * 2 + 2 || reference.start < 0 ||
          reference.start + reference.length > reconstructed.length / 2) fail(`${name}: bad immutable range`);
        for (let offset = reference.start; offset < reference.start + reference.length; offset += 1) {
          if (touched.has(offset)) fail(`${name}: overlapping immutable range`);
          touched.add(offset);
        }
        const start = reference.start * 2;
        reconstructed = reconstructed.slice(0, start) + binding.value.slice(2) +
          reconstructed.slice(start + reference.length * 2);
      }
    }
    if (`0x${reconstructed}` !== code) fail(`${name}: immutable substitution mismatch`);
  }
}

for (const [name, record] of Object.entries(catalog.artifacts)) {
  const relativePath = `artifacts/${name}.json`;
  if (record.path !== `../${relativePath}`) fail(`${name}: unexpected artifact path`);
  const bytes = await readFile(resolve(root, relativePath));
  if (sha256(bytes) !== record.catalogFileSha256) fail(`${name}: catalog file hash mismatch`);
  const artifact = JSON.parse(bytes.toString());
  verifyRuntime(name, artifact);
  if (artifact.runtimeCodeHash !== record.runtimeCodeHash) fail(`${name}: catalog runtime mismatch`);
  if (JSON.stringify(record.chainIds) !== JSON.stringify(chainIds)) fail(`${name}: incomplete chain evidence`);
  components[name] = {
    path: relativePath,
    fileSha256: sha256(bytes),
    address: artifact.address,
    runtimeCodeHash: artifact.runtimeCodeHash,
    source: artifact.source,
    role: record.role,
    deploymentStatus: record.role === "sharedDeployment" ? "historically-observed" : "factory-runtime-template",
    chainIds,
    evidence: "evidence/artifact-catalog.json",
  };
}

for (const name of ["SimpleGasPolicy", "UsageLimitPolicy"]) {
  const path = `artifacts/${name}.json`;
  const bytes = await readFile(resolve(root, path));
  const artifact = JSON.parse(bytes.toString());
  verifyRuntime(name, artifact);
  const observed = gasEvidence.observations.map((observation) => {
    const contract = observation.contracts?.find((entry) => entry.name === name);
    if (!contract?.artifactRuntimeMatches || contract.runtimeCodeHash !== artifact.runtimeCodeHash ||
      !/^0x[0-9a-f]{64}$/.test(observation.blockHash)) fail(`${name}: incomplete runtime observation`);
    return observation.chainId;
  }).sort((a, b) => a - b);
  if (JSON.stringify(observed) !== JSON.stringify(chainIds)) fail(`${name}: incomplete chain evidence`);
  components[name] = { path, fileSha256: sha256(bytes), address: artifact.address,
    runtimeCodeHash: artifact.runtimeCodeHash, source: artifact.source, role: "optional-policy-evidence",
    deploymentStatus: "historically-observed", chainIds, evidence: "evidence/gas-and-usage-policy.json" };
}

const guardPath = "artifacts/CenterSessionGuard.json";
const paymasterPath = "artifacts/PimlicoSingletonPaymasterV7.json";
const paymasterBytes = await readFile(resolve(root, paymasterPath));
const paymaster = JSON.parse(paymasterBytes.toString());
const paymasterEvidence = await read("evidence/pimlico-paymaster.json");
verifyRuntime("PimlicoSingletonPaymasterV7", paymaster);
if (sha256(paymasterBytes) !== paymasterEvidence.artifactFileSha256 ||
  JSON.stringify([...paymasterEvidence.chainIds].sort((a,b) => a-b)) !== JSON.stringify(chainIds) ||
  paymasterEvidence.observations.length !== chainIds.length ||
  paymasterEvidence.observations.some((observation) => !observation.artifactRuntimeMatches ||
    observation.runtimeCodeHash !== paymaster.runtimeCodeHash)) fail("Pimlico paymaster: incomplete artifact or chain evidence");
components.PimlicoSingletonPaymasterV7 = {
  path: paymasterPath, fileSha256: sha256(paymasterBytes), address: paymaster.address,
  runtimeCodeHash: paymaster.runtimeCodeHash, source: paymaster.source,
  role: "reviewed-gas-only-paymaster-profile", deploymentStatus: "historically-observed", chainIds,
  gasOnlyProfile: paymaster.gasOnlyProfile, evidence: "evidence/pimlico-paymaster.json",
};

const guardBytes = await readFile(resolve(root, guardPath));
const guard = JSON.parse(guardBytes.toString());
verifyRuntime("CenterSessionGuard", guard);
const source = await readFile(resolve(root, "contracts/CenterSessionGuard.sol"));
if (sha256(source) !== guard.source.sha256 || guard.address !== null || guard.deploymentStatus !== "undeployed") {
  fail("CenterSessionGuard: stale source binding or invalid deployment claim");
}
components.CenterSessionGuard = { path: guardPath, fileSha256: sha256(guardBytes), address: null,
  runtimeCodeHash: guard.runtimeCodeHash, source: guard.source, role: "required-sponsor-policy",
  deploymentStatus: "undeployed", chainIds: [], evidence: "contracts/CenterSessionGuard.sol" };

const manifest = {
  schemaVersion: 1,
  stack: "SafeL2-1.4.1-Safe7579-f22a194-SmartSession-f24dddf-EntryPoint-0.7",
  chainIds,
  executionEnabled: false,
  activationNote: "Artifacts and historical deployment evidence do not verify a user's live account. CenterSessionGuard requires a verified deployment and a reviewed gas-only paymaster before activation.",
  components,
};
const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
if (process.argv.includes("--write-manifest")) await writeFile(resolve(root, "manifest.json"), serialized);
else if (await readFile(resolve(root, "manifest.json"), "utf8") !== serialized) fail("Stale aggregate stack manifest");
console.log(JSON.stringify({ verifiedArtifacts: Object.keys(components).length, historicalChains: chainIds.length,
  guardRuntimeCodeHash: guard.runtimeCodeHash, guardDeploymentStatus: "undeployed", executionEnabled: false }));
