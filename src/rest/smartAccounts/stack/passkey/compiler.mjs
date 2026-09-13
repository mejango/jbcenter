import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const root = dirname(fileURLToPath(import.meta.url));
const digest = (data) => createHash('sha256').update(data).digest('hex');

/** Independently rebuild vendored, unmodified upstream contracts with its exact compiler settings. */
export async function compile({ update = false } = {}) {
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  if (manifest.commit !== 'dfd3b05966e727dbb7a2fdeef52e4b230f63304e' ||
      manifest.compiler.version !== '0.8.26+commit.8a97fa7a') throw new Error('Passkey source/compiler pin changed.');
  for (const [name, expected] of Object.entries(manifest.existingStackArtifactsSha256)) {
    if (digest(await readFile(resolve(root, '../artifacts', `${name}.json`))) !== expected) {
      throw new Error(`Existing pinned stack artifact differs: ${name}`);
    }
  }
  if (digest(await readFile(resolve(root, '../manifest.json'))) !== manifest.existingStackManifestSha256) {
    throw new Error('Existing Safe7579 stack manifest differs from the reviewed compatibility target.');
  }
  if (digest(await readFile(resolve(root, 'evidence/audit-source-comparison.json'))) !== manifest.auditSourceComparisonSha256) {
    throw new Error('Passkey upstream audit-source comparison record changed.');
  }
  const sources = {};
  for (const [path, expected] of Object.entries(manifest.sourceSha256)) {
    const data = await readFile(resolve(root, 'vendor', path));
    if (digest(data) !== expected) throw new Error(`Vendored passkey source hash differs: ${path}`);
    if (path.endsWith('.sol')) sources[path.replace('modules/passkey/', '')] = { content: data.toString('utf8') };
  }
  const solc = process.env.CENTER_PASSKEY_SOLC ?? resolve(
    process.env.SVM_HOME ?? resolve(homedir(), '.svm'), '0.8.26/solc-0.8.26');
  const binary = await readFile(solc);
  if (!Object.values(manifest.compilerBinaries).some((pin) => pin.sha256 === `0x${digest(binary)}`)) {
    throw new Error('Safe passkey compilation requires the exact officially pinned Solidity0.8.26 binary.');
  }
  const version = spawnSync(solc, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  if (version.status !== 0 || !version.stdout.includes(manifest.compiler.version)) throw new Error('Wrong passkey compiler version.');
  const artifacts = [
    ['SafeWebAuthnSignerFactory', 'contracts/SafeWebAuthnSignerFactory.sol', true],
    ['SafeWebAuthnSignerSingleton', 'contracts/SafeWebAuthnSignerSingleton.sol', true],
    ['SafeWebAuthnSignerProxy', 'contracts/SafeWebAuthnSignerProxy.sol', true],
    ['FCLP256Verifier', 'contracts/verifiers/FCLP256Verifier.sol', false],
  ];
  for (const viaIR of [true, false]) {
    const { version: ignored, ...settings } = manifest.compiler;
    const input = { language: 'Solidity', sources, settings: { ...settings, viaIR,
      outputSelection: Object.fromEntries(artifacts.filter((a) => a[2] === viaIR).map(([name, path]) => [path, {
        [name]: ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences', 'metadata'],
      }])),
    } };
    const built = spawnSync(solc, ['--standard-json'], {
      input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60_000,
    });
    if (built.error || built.status !== 0) throw new Error('Pinned passkey compiler failed.');
    const output = JSON.parse(built.stdout);
    const errors = output.errors?.filter((error) => error.severity === 'error') ?? [];
    if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
    for (const [name, source, usesIR] of artifacts.filter((a) => a[2] === viaIR)) {
      const compiled = output.contracts[source][name];
      const artifact = {
        schemaVersion: 1, contractName: name, deploymentStatus: 'undeployed',
        source: { repository: manifest.repository, commit: manifest.commit,
          path: `modules/passkey/${source}`, sha256: manifest.sourceSha256[`modules/passkey/${source}`] },
        compiler: { ...manifest.compiler, viaIR: usesIR },
        compilerInputSha256: digest(JSON.stringify(input)),
        abi: compiled.abi, bytecode: `0x${compiled.evm.bytecode.object}`,
        deployedBytecode: `0x${compiled.evm.deployedBytecode.object}`,
        immutableReferences: compiled.evm.deployedBytecode.immutableReferences,
        metadata: JSON.parse(compiled.metadata),
      };
      const path = resolve(root, 'artifacts', `${name}.json`);
      if (update) await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`);
      else if (!isDeepStrictEqual(artifact, JSON.parse(await readFile(path, 'utf8')))) {
        throw new Error(`Fresh upstream passkey compilation differs from reviewed ${name} artifact.`);
      }
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--update-reviewed-artifacts') throw new Error('Artifact updates require the explicit --update-reviewed-artifacts flag.');
  await compile({ update: true });
  console.log('Passkey artifacts rebuilt from source. Review every changed source pin and artifact before release.');
}
