import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { findCachedSolc } from '../solc-cache.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const foundryCommit = 'f83bad912a9dba7bf0371def1e70bb1896048356';

function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...options,
  });
  if (result.error || result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error('Required bootstrap compiler or execution check failed.');
  }
  return result.stdout;
}

async function findCompiler(forge) {
  let installed = await findCachedSolc('0.7.6', process.env.CENTER_MULTISEND_SOLC);
  if (!installed) {
    // Foundry installs/caches the requested official compiler. Its build output
    // is unused: the binary checksum and source compilation are checked below.
    run(forge, ['build', '--force', '--root', resolve(root, 'compiler'), '--use', '0.7.6']);
    installed = await findCachedSolc('0.7.6');
  }
  if (!installed) throw new Error('Solidity 0.7.6 cache is unavailable; set CENTER_MULTISEND_SOLC to its pinned binary.');
  return installed;
}

/** Required local compatibility proof. This never activates the bootstrap profile. */
export async function verifyBootstrap() {
  const forge = process.env.FORGE_BINARY ?? 'forge';
  if (!run(forge, ['--version'], { timeout: 10_000 }).includes('Commit SHA: ' + foundryCommit + '\n')) {
    throw new Error('Bootstrap compatibility requires the exact pinned Foundry v1.7.0 build.');
  }
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  if (manifest.source.commit !== 'bf943f80fec5ac647159d26161446ac5d716a294' ||
      manifest.compiler.version !== '0.7.6+commit.7338295f') {
    throw new Error('Reviewed MultiSend source or compiler identity changed.');
  }
  const source = await readFile(resolve(root, 'vendor/MultiSend.sol'));
  if (sha256(source) !== manifest.source.sha256) throw new Error('MultiSend source pin changed.');
  if (manifest.license.spdx !== 'LGPL-3.0-only' ||
      sha256(await readFile(resolve(root, 'vendor/LICENSE'))) !== manifest.license.sha256) {
    throw new Error('MultiSend upstream license pin changed.');
  }
  const inputRaw = await readFile(resolve(root, 'evidence/multisend-compiler-input.json'));
  if (sha256(inputRaw) !== manifest.compilerInputSha256) throw new Error('MultiSend compiler input changed.');
  const input = JSON.parse(inputRaw);
  if (input.sources['contracts/libraries/MultiSend.sol'].content !== source.toString()) {
    throw new Error('MultiSend compiler input does not contain the pinned source.');
  }
  const catalogRaw = await readFile(resolve(root, 'evidence/multisend-deployments.json'));
  if (sha256(catalogRaw) !== manifest.deploymentCatalog.sha256) throw new Error('MultiSend deployment catalog changed.');
  const catalog = JSON.parse(catalogRaw);
  if (catalog.deployments.canonical.address !== manifest.deploymentCatalog.canonicalAddress ||
      catalog.deployments.canonical.codeHash !== manifest.deploymentCatalog.canonicalRuntimeCodeHash ||
      catalog.networkAddresses['8453'] !== 'canonical') {
    throw new Error('Reviewed Base MultiSend catalog identity differs.');
  }

  const solc = await findCompiler(forge);
  const compilerBinary = await readFile(solc);
  if (!Object.values(manifest.compilerBinaries).some((pin) => pin.sha256 === '0x' + sha256(compilerBinary))) {
    throw new Error('MultiSend requires the exact officially pinned Solidity 0.7.6 compiler binary.');
  }
  const built = JSON.parse(run(solc, ['--standard-json'], {
    input: JSON.stringify(input), timeout: 60_000,
  }));
  const errors = built.errors?.filter((error) => error.severity === 'error') ?? [];
  if (errors.length) throw new Error(errors.map((error) => error.formattedMessage).join('\n'));
  const compiled = built.contracts['contracts/libraries/MultiSend.sol'].MultiSend;
  const artifactRaw = await readFile(resolve(root, 'artifacts/MultiSend.json'));
  if (sha256(artifactRaw) !== manifest.artifactSha256) throw new Error('Reviewed MultiSend artifact changed.');
  const artifact = JSON.parse(artifactRaw);
  if (!isDeepStrictEqual(compiled.abi, artifact.abi) ||
      '0x' + compiled.evm.bytecode.object !== artifact.bytecode ||
      '0x' + compiled.evm.deployedBytecode.object !== artifact.deployedBytecode ||
      !isDeepStrictEqual(compiled.evm.deployedBytecode.immutableReferences, artifact.immutableReferences) ||
      !isDeepStrictEqual(JSON.parse(compiled.metadata), artifact.metadata)) {
    throw new Error('Fresh MultiSend compilation differs from the reviewed official artifact.');
  }
  const stack = resolve(root, '../..');
  for (const [path, expected] of Object.entries(manifest.existingArtifactSha256)) {
    if (sha256(await readFile(resolve(stack, path))) !== expected) {
      throw new Error('Existing bootstrap dependency artifact changed: ' + path);
    }
  }
  const output = JSON.parse(run(forge, ['test', '--force', '--root', root, '--evm-version', 'cancun',
    '--match-contract', 'PasskeyBootstrapTest', '--json', '-vv']));
  const suiteName = 'test/Bootstrap.t.sol:PasskeyBootstrapTest';
  const tests = output[suiteName]?.test_results;
  if (!tests || Object.keys(tests).length < 10) throw new Error('Required bootstrap suite is absent or incomplete.');
  const measurements = {};
  let passed = 0;
  for (const [name, result] of Object.entries(tests)) {
    if (result.status !== 'Success') throw new Error('Failed or skipped bootstrap test: ' + name);
    passed++;
    for (const line of result.decoded_logs ?? []) {
      const match = /^(bootstrapActualGasUsed|bootstrapInitCodeBytes|bootstrapPackedUserOperationBytes|directFactoryExecutionGas): ([0-9]+)$/.exec(line);
      if (match) measurements[match[1]] = Number(match[2]);
    }
  }
  for (const name of ['bootstrapActualGasUsed', 'bootstrapInitCodeBytes', 'bootstrapPackedUserOperationBytes', 'directFactoryExecutionGas']) {
    if (!(measurements[name] > 0)) throw new Error('Required bootstrap measurement missing: ' + name);
  }
  return {
    schemaVersion: 1, profile: 'bootstrap-experiment-not-activated',
    suites: [{ name: suiteName, passed, failed: 0, skipped: 0, total: passed }],
    measurements,
    limits: [
      'Required local execution evidence; no hosted bundler or production deployment claim.',
      'The canonical 500,000 verification-gas limit explicitly rejects this EntryPoint bootstrap.',
      'The extra signer CREATE2 conflicts with current factory canonical mempool restrictions.',
      'Initial UserOperation uses a prefunded EntryPoint deposit; direct factory uses test caller gas.',
    ],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await verifyBootstrap();
  if (process.env.CENTER_BOOTSTRAP_REPORT) {
    const path = resolve(process.env.CENTER_BOOTSTRAP_REPORT);
    const temporary = path + '.' + process.pid + '.tmp';
    await writeFile(temporary, JSON.stringify(report, null, 2) + '\n');
    await rename(temporary, path);
  }
  console.log('Bootstrap compatibility: ' + report.suites[0].passed + ' actual stack tests passed; zero skips.');
  console.log('Direct factory execution gas: ' + report.measurements.directFactoryExecutionGas + '; local EVM only.');
}
