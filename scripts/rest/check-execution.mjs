import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const stack = resolve(root, "src/rest/smartAccounts/stack");
// Official v1.7.0 binaries report "1.6.0-v1.7.0"; the exact release commit is authoritative.
const foundryCommit = "f83bad912a9dba7bf0371def1e70bb1896048356";
const forge = process.env.FORGE_BINARY ?? "forge";
const anvil = process.env.ANVIL_BINARY ?? "anvil";

function run(binary, args, capture = false, env = {}) {
  const result = spawnSync(binary, args, {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  if (result.error || result.status !== 0) {
    if (capture && result.stdout) process.stderr.write(result.stdout);
    throw new Error(result.error
      ? "A required execution tool could not start; install the pinned Forge and Anvil binaries."
      : "Required execution verification failed; see the preceding test or build failure. No check may be skipped.");
  }
  return result.stdout;
}

for (const [name, binary] of [["forge", forge], ["anvil", anvil]]) {
  const version = run(binary, ["--version"], true);
  if (!version.includes(`Commit SHA: ${foundryCommit}\n`)) {
    throw new Error(`${name} must use the pinned Foundry v1.7.0 release commit ${foundryCommit}.`);
  }
  console.log(`${name}: verified Foundry v1.7.0 (${foundryCommit})`);
}

run(process.execPath, [resolve(stack, "verify-artifacts.mjs")]);
// Force a fresh build; never regenerate the reviewed artifact or manifest during verification.
run(forge, ["build", "--force", "--root", stack]);
const built = JSON.parse(await readFile(resolve(stack, "out/CenterSessionGuard.sol/CenterSessionGuard.json"), "utf8"));
const reviewed = JSON.parse(await readFile(resolve(stack, "artifacts/CenterSessionGuard.json"), "utf8"));
const compiler = {
  version: built.metadata.compiler.version,
  evmVersion: built.metadata.settings.evmVersion,
  optimizer: built.metadata.settings.optimizer,
  metadata: built.metadata.settings.metadata,
};
if (compiler.version !== "0.8.28+commit.7893614a" || compiler.evmVersion !== "cancun" ||
  !isDeepStrictEqual(compiler, reviewed.compiler) || !isDeepStrictEqual(built.abi, reviewed.abi) ||
  built.bytecode.object !== reviewed.bytecode || built.deployedBytecode.object !== reviewed.deployedBytecode) {
  throw new Error("Fresh CenterSessionGuard compilation differs from the reviewed ABI, creation/runtime bytecode or compiler settings.");
}
console.log("CenterSessionGuard: fresh solc 0.8.28 build matches the reviewed artifact");

const gasLayout = JSON.parse(await readFile(resolve(root,
  "src/rest/userOperations/evidence/guard-storage.json"), "utf8"));
const freshLayout = JSON.parse(run(forge,
  ["inspect", "--json", "--root", stack, "CenterSessionGuard", "storageLayout"], true));
if (gasLayout.schemaVersion !== 1 || gasLayout.sourceSha256 !== reviewed.source.sha256 ||
  gasLayout.runtimeCodeHash !== reviewed.runtimeCodeHash || gasLayout.compilerVersion !== compiler.version ||
  !isDeepStrictEqual(freshLayout, gasLayout.storageLayout)) {
  throw new Error("Session gas-estimation storage layout differs from the freshly compiled, source-pinned guard.");
}
console.log("Session gas estimation: complete storage layout matches the source-pinned guard compiler output");

// Forge has installed the exact compiler through SVM. The target verifier independently checks
// the official compiler binary hash and owns its disposable local Anvil process.
const targetSolc = process.env.CENTER_TARGET_SOLC ?? resolve(
  process.env.SVM_HOME ?? resolve(homedir(), ".svm"), "0.8.28/solc-0.8.28",
);
run(process.execPath, ["--import", "tsx", "--test",
  resolve(root, "src/rest/smartAccounts/targets-evidence/verify.test.mjs")], false,
  { CENTER_TARGET_SOLC: targetSolc });

const suites = JSON.parse(run(forge, ["test", "--root", stack, "--json"], true));
const requiredSuites = {
  "test/CenterSessionGuard.t.sol:CenterSessionGuardTest": 12,
  "test/FullStack.t.sol:FullStackTest": 6,
};
for (const [name, minimum] of Object.entries(requiredSuites)) {
  if (!suites[name]?.test_results || Object.keys(suites[name].test_results).length < minimum) {
    throw new Error(`Required Foundry suite ${name} is missing or has fewer than ${minimum} tests.`);
  }
}
let passed = 0;
for (const [suite, output] of Object.entries(suites)) {
  for (const [name, result] of Object.entries(output.test_results)) {
    if (result.status !== "Success") throw new Error(`Foundry test ${suite}/${name} failed or was skipped.`);
    if (result.kind?.Fuzz && result.kind.Fuzz.runs < 256) throw new Error(`Foundry fuzz test ${name} requires at least 256 runs.`);
    passed += 1;
  }
}
console.log(`Foundry: ${passed} tests passed, including the actual EntryPoint/Safe/SmartSession/Pimlico stack; zero skips`);

// Current hosted Pimlico is a separately versioned package. Never rewrite the
// original stack manifest: existing account bindings depend on its exact hash.
const currentPimlico = resolve(stack, "current-pimlico");
run(forge, ["build", "--root", resolve(currentPimlico, "paymaster-compiler")]);
run(process.execPath, [resolve(currentPimlico, "verify-paymaster.mjs")]);
run(process.execPath, [resolve(currentPimlico, "verify-guard.mjs")]);
const currentSuites = JSON.parse(run(forge, ["test", "--root", currentPimlico, "--json"], true));
const currentRequiredSuites = {
  "test/CenterSessionGuardV2.t.sol:CenterSessionGuardV2Test": 20,
  "test/FullStackV2.t.sol:FullStackV2Test": 15,
};
for (const [name, minimum] of Object.entries(currentRequiredSuites)) {
  if (!currentSuites[name]?.test_results || Object.keys(currentSuites[name].test_results).length < minimum) {
    throw new Error(`Required current Pimlico suite ${name} is missing or has fewer than ${minimum} tests.`);
  }
}
let currentPassed = 0;
for (const [suite, output] of Object.entries(currentSuites)) {
  for (const [name, result] of Object.entries(output.test_results)) {
    if (result.status !== "Success") throw new Error(`Current Pimlico test ${suite}/${name} failed or was skipped.`);
    if (result.kind?.Fuzz && result.kind.Fuzz.runs < 256) throw new Error(`Current Pimlico fuzz test ${name} requires at least 256 runs.`);
    currentPassed++;
  }
}
console.log(`Current Pimlico: ${currentPassed} Foundry tests passed with independently reproduced paymaster and guard; zero skips`);
