import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { keccak256 } from "viem";

const root = dirname(fileURLToPath(import.meta.url));
const write = process.argv.includes("--write");
if (process.argv.slice(2).some((arg) => arg !== "--write")) throw new Error("Unknown verification option");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const jsonBytes = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sourcePath = "contracts/CenterSessionGuardV2.sol";
const artifactPath = "artifacts/CenterSessionGuardV2.json";
const storagePath = "evidence/guard-storage.json";
const manifestPath = "guard-manifest.json";
const compilerVersion = "0.8.28+commit.7893614a";
const paymaster = "0x777777777777AeC03fd955926DbF81597e66834C";
const paymasterCodeHash = "0x337b6e1b6c2167c0528c5240c028ead407c673595b2820029b69741b76d98fbc";
const source = await readFile(resolve(root, sourcePath));
const temp = await mkdtemp(resolve(tmpdir(), "center-guard-v2-"));
let compiled;
try {
  const built = spawnSync(process.env.FORGE_BINARY || "forge", [
    "build", "--root", root, "--skip", "test", "--out", resolve(temp, "out"),
    "--cache-path", resolve(temp, "cache"),
  ], { encoding: "utf8" });
  if (built.status !== 0) throw new Error(`Current guard compilation failed: ${built.stderr || built.stdout}`);
  compiled = JSON.parse(await readFile(resolve(temp, "out/CenterSessionGuardV2.sol/CenterSessionGuardV2.json"), "utf8"));
} finally {
  await rm(temp, { recursive: true, force: true });
}
assert.equal(compiled.metadata.compiler.version, compilerVersion, "compiler version");
assert.equal(compiled.metadata.settings.evmVersion, "cancun", "EVM target");
assert.deepEqual(compiled.metadata.settings.optimizer, { enabled: true, runs: 200 }, "optimizer");
assert.deepEqual(compiled.metadata.settings.metadata, { bytecodeHash: "none" }, "metadata settings");
assert.deepEqual(compiled.deployedBytecode.immutableReferences || {}, {}, "unexpected immutable state");

// Verify compiler-produced storage recursively rather than accepting a hand-written slot table.
const layout = compiled.storageLayout;
assert.equal(layout.storage.length, 1, "unexpected top-level storage");
const mapping = layout.storage[0];
assert.deepEqual([mapping.label, mapping.slot, mapping.offset], ["_states", "0", 0]);
let type = layout.types[mapping.type];
for (const key of ["t_bytes32", "t_address", "t_address"]) {
  assert.equal(type.encoding, "mapping");
  assert.equal(type.key, key);
  type = layout.types[type.value];
}
const members = (value) => value.members.map((member) => ({
  name: member.label, slot: Number(member.slot), offset: member.offset,
  type: layout.types[member.type].label.replace("struct CenterSessionGuardV2.", ""),
}));
const stateMembers = members(type);
assert.deepEqual(stateMembers, [
  { name: "config", slot: 0, offset: 0, type: "Config" },
  { name: "gasUsed", slot: 8, offset: 0, type: "uint256" },
  { name: "costUsed", slot: 9, offset: 0, type: "uint256" },
  { name: "callsUsed", slot: 10, offset: 0, type: "uint128" },
]);
const configMembers = members(layout.types[type.members[0].type]);
assert.deepEqual(configMembers, [
  { name: "paymaster", slot: 0, offset: 0, type: "address" },
  { name: "paymasterCodeHash", slot: 1, offset: 0, type: "bytes32" },
  { name: "maxGasPerOperation", slot: 2, offset: 0, type: "uint256" },
  { name: "maxFeePerGas", slot: 3, offset: 0, type: "uint256" },
  { name: "maxPriorityFeePerGas", slot: 4, offset: 0, type: "uint256" },
  { name: "totalGasLimit", slot: 5, offset: 0, type: "uint256" },
  { name: "totalSponsoredCostLimit", slot: 6, offset: 0, type: "uint256" },
  { name: "maximumCalls", slot: 7, offset: 0, type: "uint128" },
  { name: "maxPaymasterDataLength", slot: 7, offset: 16, type: "uint32" },
]);
const getConfig = compiled.abi.find((entry) => entry.name === "getConfig");
assert.deepEqual(getConfig.outputs[0].components.map(({ name, type }) => ({ name, type })),
  configMembers.map(({ name, type }) => ({ name, type })), "Config ABI order");
const legacyArtifact = JSON.parse(await readFile(resolve(root, "../artifacts/CenterSessionGuard.json"), "utf8"));
const wireAbi = (value) => JSON.parse(JSON.stringify(value, (key, item) => key === "internalType" ? undefined : item));
for (const name of ["initializeWithMultiplexer", "getConfig", "checkUserOpPolicy", "supportsInterface"]) {
  assert.deepEqual(wireAbi(compiled.abi.find((entry) => entry.name === name)),
    wireAbi(legacyArtifact.abi.find((entry) => entry.name === name)), `${name}: legacy wire ABI changed`);
}
assert.equal(compiled.methodIdentifiers["initializeWithMultiplexer(address,bytes32,bytes)"], "989c9e46");
assert.equal(compiled.methodIdentifiers["checkUserOpPolicy(bytes32,(address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes))"], "7129edce");

const compiler = {
  version: compilerVersion,
  evmVersion: compiled.metadata.settings.evmVersion,
  optimizer: compiled.metadata.settings.optimizer,
  metadata: compiled.metadata.settings.metadata,
};
const compilerOutput = {
  abi: compiled.abi, bytecode: compiled.bytecode, deployedBytecode: compiled.deployedBytecode,
  methodIdentifiers: compiled.methodIdentifiers, metadata: compiled.metadata, storageLayout: layout,
};
const published = {
  schemaVersion: 1,
  contractName: "CenterSessionGuardV2",
  address: null,
  deploymentStatus: "undeployed",
  abi: compiled.abi,
  bytecode: compiled.bytecode.object,
  deployedBytecode: compiled.deployedBytecode.object,
  runtimeCodeHash: keccak256(compiled.deployedBytecode.object),
  source: {
    repository: "juicebox-center",
    path: `src/rest/smartAccounts/stack/current-pimlico/${sourcePath}`,
    sha256: sha256(source),
    compilerOutputSha256: sha256(jsonBytes(compilerOutput)),
  },
  compiler,
  immutableBindings: [],
  paymasterBinding: { address: paymaster, runtimeCodeHash: paymasterCodeHash },
  limitations: [
    "Local compiler evidence only; this artifact is not a deployment or audit.",
    "Requires a separately owner-authorized guard deployment, installed SmartSession and independently enforced time, action and value policies.",
    "Only the exact current Pimlico V7 address/runtime and 130-byte paymasterAndData flags 0x00 or 0x01 are accepted.",
    "Pimlico validates sponsor signatures, validity and bundler authorization; the guard bounds maximum prefund and cumulative gas, cost and calls.",
    "Validation counters remain consumed when a validated action later reverts; a reverted handleOps transaction rolls them back.",
  ],
};
const storageProof = {
  schemaVersion: 1,
  contractName: published.contractName,
  compiler,
  sourceSha256: published.source.sha256,
  runtimeCodeHash: published.runtimeCodeHash,
  compilerOutputSha256: published.source.compilerOutputSha256,
  initializerBytes: 288,
  configAbi: getConfig.outputs[0].components,
  stateMappingSlot: 0,
  mappingKeyOrder: ["id", "multiplexer", "account"],
  stateMembers,
  configMembers,
  storageLayout: layout,
};
const manifest = {
  schemaVersion: 1,
  profileId: "pimlico-singleton-v7-current-verifying",
  executionEnabled: false,
  component: {
    path: artifactPath,
    fileSha256: sha256(jsonBytes(published)),
    address: null,
    runtimeCodeHash: published.runtimeCodeHash,
    source: published.source,
    role: "required-current-sponsor-policy",
    deploymentStatus: "undeployed",
    chainIds: [],
  },
  storageProof: { path: storagePath, fileSha256: sha256(jsonBytes(storageProof)) },
  paymasterBinding: published.paymasterBinding,
  gasOnlyProfile: {
    paymasterAndDataBytes: 130, paymasterDataBytes: 78, flagsOffset: 52,
    acceptedFlags: [0, 1], modeRightShift: 1, modeValue: 0,
    validUntilOffset: 53, validAfterOffset: 59, signatureOffset: 65, signatureBytes: 65,
    validationContext: "empty", tokenCharge: "none",
  },
};
for (const [path, value] of [[artifactPath, published], [storagePath, storageProof], [manifestPath, manifest]]) {
  const expected = jsonBytes(value);
  if (write) await writeFile(resolve(root, path), expected);
  else assert.equal(await readFile(resolve(root, path), "utf8"), expected, `${path}: reproduced compiler evidence differs`);
}
console.log(JSON.stringify({ verified: !write, written: write, contract: published.contractName,
  runtimeCodeHash: published.runtimeCodeHash, sourceSha256: published.source.sha256,
  artifactFileSha256: manifest.component.fileSha256, storageProofFileSha256: manifest.storageProof.fileSha256,
  manifestFileSha256: sha256(jsonBytes(manifest)), deploymentStatus: published.deploymentStatus }));
