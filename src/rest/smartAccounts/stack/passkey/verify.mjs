import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compile, root } from './compiler.mjs';
import { verifyBootstrap } from './bootstrap/verify.mjs';

const forge = process.env.FORGE_BINARY ?? 'forge';
const foundryCommit = 'f83bad912a9dba7bf0371def1e70bb1896048356';
const version = spawnSync(forge, ['--version'], { encoding: 'utf8', timeout: 10_000 });
if (version.status !== 0 || !version.stdout.includes(`Commit SHA: ${foundryCommit}\n`)) {
  throw new Error('Passkey compatibility requires the exact pinned Foundry v1.7.0 release.');
}
await compile();
const result = spawnSync(forge, ['test', '--force', '--root', root,
  '--evm-version', 'cancun', '--match-contract', 'PasskeyStackTest', '--json', '-vv'], {
  encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000,
});
if (result.error || result.status !== 0) {
  // Test output uses only committed public synthetic credentials, never real ceremony material.
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  throw new Error('Required passkey compatibility failed; inspect the exact test failure above.');
}
const output = JSON.parse(result.stdout);
const expectedSuite = 'test/PasskeyStack.t.sol:PasskeyStackTest';
const tests = output[expectedSuite]?.test_results;
if (!tests || Object.keys(tests).length < 24) throw new Error('Required passkey compatibility suite is absent or incomplete.');
const measurements = {};
let passed = 0;
let fuzzRuns = 0;
for (const [name, test] of Object.entries(tests)) {
  if (test.status !== 'Success') throw new Error(`Passkey compatibility ${name} failed or skipped.`);
  if (test.kind?.Fuzz) {
    if (test.kind.Fuzz.runs < 256) throw new Error('Passkey cryptographic fuzz verification requires at least 256 runs.');
    fuzzRuns += test.kind.Fuzz.runs;
  }
  for (const line of test.decoded_logs ?? []) {
    const match = /^(safeMessageVerificationGas|safeMessageSignatureBytes|entryPointHandleOpsGas|userOperationSignatureBytes|userOperationCalldataBytes|userOperationActualGasUsed|maxAssertionVerificationGas|maxAssertionSignatureBytes|maxUserOperationActualGasUsed|maxUserOperationSignatureBytes): ([0-9]+)$/.exec(line);
    if (match) measurements[match[1]] = Number(match[2]);
  }
  passed++;
}
for (const name of ['safeMessageVerificationGas', 'safeMessageSignatureBytes', 'entryPointHandleOpsGas',
  'userOperationSignatureBytes', 'userOperationCalldataBytes', 'userOperationActualGasUsed',
  'maxAssertionVerificationGas', 'maxAssertionSignatureBytes', 'maxUserOperationActualGasUsed', 'maxUserOperationSignatureBytes']) {
  if (!(measurements[name] > 0)) throw new Error(`Required passkey gas/calldata observation missing: ${name}`);
}
if (fuzzRuns < 256) throw new Error('Required passkey cryptographic fuzz suite is missing.');
const bootstrap = await verifyBootstrap();
const evidenceInputsSha256 = Object.fromEntries(await Promise.all([
  'manifest.json', 'test/PasskeyStack.t.sol', 'compiler.mjs', 'verify.mjs', 'solc-cache.mjs',
  'foundry.toml', 'bootstrap/manifest.json', 'bootstrap/verify.mjs', 'bootstrap/foundry.toml', 'bootstrap/test/Bootstrap.t.sol',
].map(async path => [path, createHash('sha256').update(await readFile(resolve(root, path))).digest('hex')])));
const report = {
  schemaVersion: 1, profile: 'experimental-unreleased',
  scope: 'Local EVM with actual pinned FCL/signers/Safe7579/EntryPoint; simulated authenticator; no device, production deployment, precompile or provider claim.',
  sourceCommit: 'dfd3b05966e727dbb7a2fdeef52e4b230f63304e',
  suites: [{ name: expectedSuite, passed, failed: 0, skipped: 0, total: passed }, ...bootstrap.suites],
  fuzzRuns, measurements, bootstrap, evidenceInputsSha256,
};
if (process.env.CENTER_PASSKEY_REPORT) {
  const reportPath = resolve(process.env.CENTER_PASSKEY_REPORT);
  const temporary = `${reportPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`);
  await rename(temporary, reportPath);
}
console.log(`Passkey compatibility: ${passed + bootstrap.suites[0].passed} actual stack tests passed; ${fuzzRuns} fuzz runs; zero skips.`);
console.log(`FCL UserOperation: ${measurements.userOperationSignatureBytes} signature bytes; ${measurements.userOperationActualGasUsed} actual gas used in the local receipt.`);
