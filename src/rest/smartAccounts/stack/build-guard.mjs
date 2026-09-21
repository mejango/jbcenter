import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256 } from "viem";

const root = dirname(fileURLToPath(import.meta.url));
const built = spawnSync(process.env.FORGE_BINARY || "forge", ["build", "--root", root], {
  stdio: "inherit",
});
if (built.status !== 0) throw new Error("Pinned Foundry build failed");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const source = await readFile(resolve(root, "contracts/CenterSessionGuard.sol"));
const original = await readFile(resolve(root, "out/CenterSessionGuard.sol/CenterSessionGuard.json"));
const artifact = JSON.parse(original.toString());
if (artifact.metadata.compiler.version !== "0.8.28+commit.7893614a") {
  throw new Error("Unexpected Solidity compiler version");
}
const published = {
  schemaVersion: 1,
  contractName: "CenterSessionGuard",
  address: null,
  deploymentStatus: "undeployed",
  abi: artifact.abi,
  bytecode: artifact.bytecode.object,
  deployedBytecode: artifact.deployedBytecode.object,
  runtimeCodeHash: keccak256(artifact.deployedBytecode.object),
  source: {
    repository: "juicebox-center",
    path: "src/rest/smartAccounts/stack/contracts/CenterSessionGuard.sol",
    sha256: sha256(source),
    compilerArtifactSha256: sha256(original),
  },
  compiler: {
    version: artifact.metadata.compiler.version,
    evmVersion: artifact.metadata.settings.evmVersion,
    optimizer: artifact.metadata.settings.optimizer,
    metadata: artifact.metadata.settings.metadata,
  },
  immutableBindings: [],
  limitations: [
    "This artifact is not a deployment, audit or configured production capability.",
    "A configured paymaster must be independently reviewed as gas-only; matching its runtime does not prove its configuration or future upgrade behavior.",
    "Legacy SmartSession installation, complete account inspection, time/action policies and EntryPoint 0.7 are required separately.",
    "Validation consumes gas/cost/call counters even if the inner execution later fails.",
  ],
};
await mkdir(resolve(root, "artifacts"), { recursive: true });
await writeFile(resolve(root, "artifacts/CenterSessionGuard.json"), `${JSON.stringify(published, null, 2)}\n`);
console.log(JSON.stringify({ contract: published.contractName, runtimeCodeHash: published.runtimeCodeHash,
  sourceSha256: published.source.sha256, deploymentStatus: published.deploymentStatus }));
