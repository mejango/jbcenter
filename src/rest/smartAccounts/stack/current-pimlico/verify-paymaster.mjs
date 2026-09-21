import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256 } from "viem";

// Offline reproduction: all compiler inputs are checked in. No credentials, RPC calls or transactions.
const root = dirname(fileURLToPath(import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readBytes = (path) => readFileSync(resolve(root, path));
const read = (path) => JSON.parse(readBytes(path));
const sorted = (value) => Array.isArray(value) ? value.map(sorted) :
  value !== null && typeof value === "object" ? Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, sorted(v)]),
  ) : value;
const canonical = (value) => `${JSON.stringify(sorted(value))}\n`;
const ADDRESS = "0x777777777777AeC03fd955926DbF81597e66834C";
const RUNTIME_HASH = "0x337b6e1b6c2167c0528c5240c028ead407c673595b2820029b69741b76d98fbc";
const ENTRY_POINT = "0x0000000000000000000000000000000071727de22e5e9d8baf0edac6f37da032";
const CHAIN_IDS = [1, 10, 8453, 42161];
const EXPECTED_PROFILE = {
  id: "pimlico-v7-current-flags", paymasterAndDataBytes: 130, paymasterDataBytes: 78,
  flagsOffset: 52, allowedFlags: [0, 1], modeShift: 1, verifyingMode: 0, allowAllBundlersMask: 1,
  validUntilOffset: 53, validAfterOffset: 59, signatureOffset: 65, signatureBytes: 65,
  validationContext: "empty", tokenCharge: "none",
};
// Official ethereum/solc-bin release hashes, independently checked against its pinned gh-pages revision.
// A version string is checked only after the executable's complete bytes have passed this allowlist.
const COMPILER_SHA256 = new Set([
  "d5f23436f443edb85d8e76906d12f0a86ce0490e7663a9e608efeb7a93f149ef", // Linux amd64
  "0ff016aef2396b12d1fc65429d8ea6cf53c2ee4b041bb8925644615ee1c30ab9", // macOS universal
]);
const compilerProvenance = read("evidence/pimlico-compiler-binaries.json");
assert.equal(compilerProvenance.officialRepository, "https://github.com/ethereum/solc-bin");
assert.equal(compilerProvenance.manifestGitCommit, "dd4f9bd179a15910a8c02ebeccc3d016614d97b0");
assert.equal(compilerProvenance.compilerRelease, "0.8.26+commit.8a97fa7a");
assert.deepEqual(new Set(Object.values(compilerProvenance.platforms).map((platform) => platform.sha256)), COMPILER_SHA256);

const manifest = read("paymaster-manifest.json");
assert.equal(manifest.schemaVersion, 1);
assert.deepEqual(manifest.chainIds, CHAIN_IDS);
assert.deepEqual(manifest.component.chainIds, CHAIN_IDS);
assert.equal(manifest.component.path, "artifacts/PimlicoSingletonPaymasterV7.json");
assert.equal(manifest.component.evidence, "evidence/pimlico-paymaster.json");
assert.equal(manifest.compilerInput.path, "evidence/pimlico-compiler-input.json");
const artifactBytes = readBytes(manifest.component.path);
const artifact = JSON.parse(artifactBytes);
const evidenceBytes = readBytes(manifest.component.evidence);
const evidence = JSON.parse(evidenceBytes);
const inputBytes = readBytes(manifest.compilerInput.path);
const input = JSON.parse(inputBytes);
assert.equal(sha256(artifactBytes), manifest.component.fileSha256);
assert.equal(sha256(artifactBytes), evidence.artifactFileSha256);
assert.equal(sha256(evidenceBytes), manifest.component.evidenceSha256);
assert.equal(sha256(inputBytes), manifest.compilerInput.sha256);
assert.equal(sha256(inputBytes), evidence.compilerInputSha256);
assert.equal(sha256(inputBytes), artifact.source.verificationInputSha256);
assert.deepEqual(artifact.source, manifest.component.source);
assert.deepEqual(artifact.source, evidence.source);
assert.deepEqual(artifact.compiler, evidence.compiler);
assert.deepEqual(artifact.gasOnlyProfile, EXPECTED_PROFILE);
assert.deepEqual(manifest.gasOnlyProfile, EXPECTED_PROFILE);
assert.deepEqual(evidence.gasOnlyProfile, EXPECTED_PROFILE);
assert.equal(artifact.address, ADDRESS);
assert.equal(manifest.component.address, ADDRESS);
assert.equal(artifact.runtimeCodeHash, RUNTIME_HASH);
assert.equal(manifest.component.runtimeCodeHash, RUNTIME_HASH);
assert.equal(evidence.runtimeCodeHash, RUNTIME_HASH);
assert.equal(keccak256(artifact.deployedRuntimeBytecode), RUNTIME_HASH);
assert.equal((artifact.deployedRuntimeBytecode.length - 2) / 2, 15118);
assert.equal(evidence.runtimeBytes, 15118);
assert.equal(keccak256(artifact.deployedBytecode), evidence.rawRuntimeCodeHash);
assert.deepEqual(artifact.immutables, evidence.immutableBindings);
assert.equal(artifact.source.commit, "2f710c1cee1ae2d5f5bbf3c41aade9ff8e4d4c05");
assert.equal(artifact.compiler.compilerVersion, "0.8.26+commit.8a97fa7a");
assert.equal(artifact.compiler.compilerSettings.evmVersion, "london");
const { outputSelection, ...settings } = input.settings;
assert.deepEqual(settings, artifact.compiler.compilerSettings);
assert.deepEqual(outputSelection, { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata"], "": ["ast"] } });

// Verify the complete dependency closure against both official Git blobs and verified metadata hashes.
assert.equal(evidence.sourcePins.length, 28);
assert.deepEqual(Object.keys(input.sources).sort(), evidence.sourcePins.map((pin) => pin.path).sort());
assert.deepEqual(Object.keys(input.sources).sort(), Object.keys(evidence.metadata.sources).sort());
for (const pin of evidence.sourcePins) {
  const bytes = Buffer.from(input.sources[pin.path].content, "utf8");
  assert.equal(sha256(bytes), pin.sha256, `${pin.path}: source SHA256`);
  assert.equal(keccak256(bytes), pin.keccak256, `${pin.path}: source Keccak256`);
  assert.equal(pin.keccak256, evidence.metadata.sources[pin.path].keccak256);
  const gitHash = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  assert.equal(gitHash, pin.gitBlobSha1, `${pin.path}: official Git blob`);
  assert.equal(pin.pinnedSourceMatchesVerified, true);
  assert.ok(pin.sourceUrl.includes(`/blob/${pin.commit}/`));
}

// Use only the recorded, block-identified observations; live activation performs fresh reads separately.
assert.deepEqual(evidence.chainIds, CHAIN_IDS);
assert.deepEqual(evidence.observations.map((entry) => entry.chainId), CHAIN_IDS);
assert.deepEqual(evidence.verifiedSources.map((entry) => entry.chainId), CHAIN_IDS);
for (const observation of evidence.observations) {
  assert.equal(observation.address, ADDRESS);
  assert.equal(observation.runtimeCodeHash, RUNTIME_HASH);
  assert.equal(observation.bytes, 15118);
  assert.equal(observation.artifactRuntimeMatches, true);
  assert.match(observation.block.number, /^0x[0-9a-f]+$/);
  assert.match(observation.block.hash, /^0x[0-9a-f]{64}$/);
}
for (const verification of evidence.verifiedSources) {
  assert.equal(verification.address, ADDRESS);
  assert.equal(verification.creationMatch, "exact_match");
  assert.equal(verification.runtimeMatch, "exact_match");
  for (const field of ["locallyReproducedRawRuntimeMatches", "locallyReproducedBoundRuntimeMatches",
    "blockscoutFullyVerified", "blockscoutRuntimeMatches"]) assert.equal(verification[field], true);
  assert.match(verification.sourcifyResponseSha256, /^[0-9a-f]{64}$/);
  assert.match(verification.blockscoutResponseSha256, /^[0-9a-f]{64}$/);
}

const solcOption = process.argv.indexOf("--solc");
const installedSolc = resolve(process.env.SVM_HOME || resolve(homedir(), ".svm"), "0.8.26/solc-0.8.26");
const solcPath = solcOption >= 0 ? process.argv[solcOption + 1] :
  process.env.SOLC_0_8_26 || installedSolc;
assert.ok(solcPath, "--solc requires a path");
// Resolve explicit paths before both hashing and execution, avoiding any PATH lookup discrepancy.
const solc = realpathSync(resolve(solcPath));
const compilerStat = statSync(solc);
assert.ok(compilerStat.isFile() && compilerStat.size > 0 && compilerStat.size <= 100 * 1024 * 1024,
  "Use an official pinned solc 0.8.26 binary file (at most 100 MiB)");
const compilerSha256 = sha256(readFileSync(solc));
assert.ok(COMPILER_SHA256.has(compilerSha256), "Use the official pinned solc 0.8.26 Linux or macOS binary");
const version = execFileSync(solc, ["--version"], { encoding: "utf8", timeout: 10_000 });
assert.match(version, /Version: 0\.8\.26\+commit\.8a97fa7a(?:[.\s]|$)/);
const output = JSON.parse(execFileSync(solc, ["--standard-json"], {
  input: inputBytes, encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 60_000,
}));
assert.deepEqual((output.errors || []).filter((error) => error.severity === "error"), []);
const compiled = output.contracts["src/SingletonPaymasterV7.sol"].SingletonPaymasterV7;
assert.equal(sha256(canonical(compiled)), artifact.source.artifactSha256);
assert.deepEqual(compiled.abi, artifact.abi);
assert.equal(`0x${compiled.evm.bytecode.object}`, artifact.bytecode);
assert.equal(`0x${compiled.evm.deployedBytecode.object}`, artifact.deployedBytecode);
assert.deepEqual(JSON.parse(compiled.metadata), evidence.metadata);

// Confirm the compiler's immutable slots and AST declaration identities before substitution.
const declarations = new Map();
function visit(node, path) {
  if (!node || typeof node !== "object") return;
  if (node.nodeType === "VariableDeclaration") declarations.set(String(node.id), { name: node.name, path });
  for (const value of Object.values(node)) visit(value, path);
}
for (const [path, source] of Object.entries(output.sources)) visit(source.ast, path);
const refs = compiled.evm.deployedBytecode.immutableReferences;
assert.deepEqual(Object.keys(refs).sort(), Object.keys(artifact.immutables).sort());
const expectedValues = {
  PAYMASTER_DATA_OFFSET: 52n, entryPoint: BigInt(ENTRY_POINT), VERIFYING_MODE: 0n, ERC20_MODE: 1n,
  MODE_AND_ALLOW_ALL_BUNDLERS_LENGTH: 1n, ERC20_PAYMASTER_DATA_LENGTH: 117n, VERIFYING_PAYMASTER_DATA_LENGTH: 12n,
};
let runtime = Buffer.from(compiled.evm.deployedBytecode.object, "hex");
const touched = new Set();
for (const [id, binding] of Object.entries(artifact.immutables)) {
  assert.deepEqual(refs[id], binding.references);
  assert.deepEqual(declarations.get(id), { name: binding.name, path: binding.sourcePath });
  assert.equal(BigInt(binding.value), expectedValues[binding.name]);
  const value = Buffer.from(binding.value.slice(2), "hex");
  for (const reference of binding.references) {
    assert.equal(reference.length, value.length);
    assert.ok(reference.start >= 0 && reference.start + reference.length <= runtime.length);
    for (let offset = reference.start; offset < reference.start + reference.length; offset++) {
      assert.ok(!touched.has(offset), "overlapping immutable references");
      touched.add(offset);
    }
    value.copy(runtime, reference.start);
  }
}
assert.equal(`0x${runtime.toString("hex")}`, artifact.deployedRuntimeBytecode);
console.log(JSON.stringify({ verified: true, sourceFiles: evidence.sourcePins.length,
  compiler: artifact.compiler.compilerVersion, compilerSha256, historicalChains: CHAIN_IDS, runtimeCodeHash: RUNTIME_HASH,
  profile: EXPECTED_PROFILE.id, liveSponsorshipVerified: false }));
