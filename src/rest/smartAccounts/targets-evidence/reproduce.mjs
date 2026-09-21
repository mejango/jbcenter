#!/usr/bin/env node
/** Reproduce the exact published v1.0.2 compiler outputs from hash-checked source bytes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { keccak256 } from 'viem';

const here = dirname(fileURLToPath(import.meta.url));
const argument = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const workspace = resolve(argument('--workspace', resolve(here, '../../../../../..')));
const solc = argument('--solc', resolve(homedir(), '.svm/0.8.28/solc-0.8.28'));
const deployPin = '20883a7c7fcd58b6264f8375b6156a59ab9a2597';
const corePin = '386a9dc71c73a1e614da9cf2a98e207788034a4b';
const permissionPin = 'e75d962ebcade48c0e19d849fe27a7e200b3ed74';
const targetNames = ['JBController', 'JBMultiTerminal'];
const libraryNames = ['JBHeldFees', 'JBPayoutSplitGroupLib'];
const names = [...targetNames, ...libraryNames];
const sourcePathFor = name => `src/${libraryNames.includes(name) ? 'libraries/' : ''}${name}.sol`;
const compilerReleases = {
  '81515b0e53deaa266d549545ccaac0a5a96e6d4e8201c77f673b2c710976d9ea': 'macosx-amd64',
  '9a0fb7e0db2c0641dbae1c5cc645dc686820c83af516226abb1c0a2f76636f25': 'linux-amd64',
};
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const git = (repo, ...args) => execFileSync('git', ['-C', resolve(workspace, repo), ...args], { maxBuffer: 32 * 1024 * 1024 });
const readPinned = (repo, commit, path) => git(repo, 'show', `${commit}:${path}`);
const writeJson = (path, value) => {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  assert(!bytes.includes(workspace), 'Evidence must not contain local workspace paths');
  writeFileSync(resolve(here, path), bytes);
  return sha256(bytes);
};
const hex = value => `0x${(typeof value === 'object' ? value.object : value).replace(/^0x/, '').toLowerCase()}`;
const normalizedMetadata = metadata => ({ ...metadata, settings: {
  ...metadata.settings, remappings: (metadata.settings.remappings ?? []).map(item => item.replace(/^:/, '')).sort(),
} });
// The published artifact contains Foundry's parsed metadata projection rather
// than rawMetadata: empty function outputs and top-level NatSpec sections are
// omitted. Compiler input identity and every source entry remain exact; the
// complete ABI is separately compared with the artifact's full ABI below.
const deploymentMetadataProjection = metadata => {
  const result = structuredClone(normalizedMetadata(metadata));
  result.output.abi = result.output.abi.map(item => {
    if (item.type === 'function' && item.outputs?.length === 0) delete item.outputs;
    return item;
  });
  for (const kind of ['devdoc', 'userdoc']) result.output[kind] = Object.fromEntries(
    Object.entries(result.output[kind]).filter(([key]) => ['kind', 'methods', 'version'].includes(key)),
  );
  return result;
};
const inputIdentity = metadata => sha256(stable({
  compiler: metadata.compiler,
  settings: normalizedMetadata(metadata).settings,
  sources: Object.fromEntries(Object.entries(metadata.sources).map(([path, value]) => [path, value.keccak256])),
}));
const abiIdentity = abi => sha256(stable([...abi].sort((a, b) => stable(a).localeCompare(stable(b)))));
const spans = references => Object.values(references ?? {}).flatMap(value => Array.isArray(value) ? value : spans(value))
  .map(({ start, length }) => ({ start, length })).sort((a, b) => a.start - b.start || a.length - b.length);
const catalogBytes = readFileSync(resolve(here, '../../contracts/data/catalog.json'));
const catalog = JSON.parse(catalogBytes);
assert.equal(catalog.deploymentManifest.commit, deployPin);

const sourceOrigins = {};
const sources = {};
const deployments = [];
const metadataByName = {};
const dependencyPackages = ['@openzeppelin/contracts', '@prb/math', '@uniswap/permit2'];
for (const name of names) {
  const contract = catalog.contracts.find(item => item.id === `@bananapus/core-v6:${sourcePathFor(name)}:${name}`);
  assert(contract);
  for (const chain of contract.deployments) {
    assert.equal(chain.instances.length, 1);
    const published = chain.instances[0];
    assert.equal(published.sourceRef, 'npm:@bananapus/core-v6@1.0.2');
    const repoPath = published.artifactPath.replace(/^deploy-all-v6\//, '');
    const bytes = readPinned('deploy-all-v6', deployPin, repoPath);
    assert.equal(sha256(bytes), published.artifactSha256);
    const artifact = JSON.parse(bytes);
    const metadata = typeof artifact.metadata === 'string' ? JSON.parse(artifact.metadata) : artifact.metadata;
    assert.equal(inputIdentity(metadata), published.compilerInputIdentitySha256);
    const code = catalog.codes.find(item => item.id === published.codeId);
    assert(code);
    assert.equal(hex(artifact.deployedBytecode), code.runtimeTemplate);
    assert.equal(sha256(hex(artifact.bytecode)), code.creationSha256);
    if (metadataByName[name]) assert.equal(stable(metadata), stable(metadataByName[name]));
    else metadataByName[name] = metadata;
    deployments.push({ name, contractId: contract.id, chainId: chain.chainId, deployment: published, artifactSha256: sha256(bytes), abiIdentity: abiIdentity(artifact.abi) });
  }
  for (const [path, expected] of Object.entries(metadataByName[name].sources)) {
    assert(!path.startsWith('/') && !path.split('/').includes('..'));
    let bytes, origin;
    if (path.startsWith('node_modules/@bananapus/core-v6/')) {
      const gitPath = path.replace('node_modules/@bananapus/core-v6/', '');
      bytes = readPinned('nana-core-v6', corePin, gitPath);
      origin = { kind: 'pinned-git', repository: 'https://github.com/Bananapus/nana-core-v6', commit: corePin, gitPath, package: '@bananapus/core-v6', version: '1.0.2' };
    } else if (path.startsWith('node_modules/@bananapus/permission-ids-v6/')) {
      const gitPath = path.replace('node_modules/@bananapus/permission-ids-v6/', '');
      bytes = readPinned('nana-permission-ids-v6', permissionPin, gitPath);
      origin = { kind: 'pinned-git', repository: 'https://github.com/Bananapus/nana-permission-ids-v6', commit: permissionPin, gitPath, package: '@bananapus/permission-ids-v6', version: '1.0.0' };
    } else {
      bytes = readFileSync(resolve(workspace, 'deploy-all-v6', path));
      const packageName = path.replace(/^node_modules\//, '').split('/').slice(0, 2).join('/');
      assert(dependencyPackages.includes(packageName));
      // Metadata proves these exact dependency bytes, not their npm release origin.
      origin = { kind: 'dependency-bytes-matching-pinned-deployment-metadata', package: packageName };
    }
    assert.equal(keccak256(bytes), expected.keccak256, `Source mismatch: ${path}`);
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    assert.equal(Buffer.compare(Buffer.from(content), bytes), 0);
    if (sources[path]) assert.equal(sources[path].content, content);
    sources[path] = { content };
    sourceOrigins[path] = { ...origin, keccak256: expected.keccak256, sha256: sha256(bytes), byteLength: bytes.length };
  }
}
const settings = structuredClone(metadataByName[names[0]].settings);
delete settings.compilationTarget;
for (const metadata of Object.values(metadataByName)) {
  const other = structuredClone(metadata.settings); delete other.compilationTarget;
  assert.equal(stable(settings), stable(other));
}
settings.outputSelection = Object.fromEntries(names.map(name => [
  `node_modules/@bananapus/core-v6/${sourcePathFor(name)}`, { [name]: ['abi', 'metadata', 'evm.bytecode', 'evm.deployedBytecode', 'evm.methodIdentifiers'] },
]));
const input = { language: 'Solidity', sources: Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b))), settings };
const inputBytes = `${JSON.stringify(input, null, 2)}\n`;
const version = execFileSync(solc, ['--version'], { encoding: 'utf8' });
assert(version.includes('0.8.28+commit.7893614a'));
const compilerBinarySha256 = sha256(readFileSync(solc));
assert(compilerBinarySha256 in compilerReleases, 'Compiler binary differs from the official solc-bin 0.8.28 releases');
const compiled = spawnSync(solc, ['--standard-json'], { input: inputBytes, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
assert.equal(compiled.status, 0, compiled.stderr);
const output = JSON.parse(compiled.stdout);
if (process.argv.includes('--debug-output')) writeFileSync(argument('--debug-output'), JSON.stringify(output));
assert.equal((output.errors ?? []).filter(error => error.severity === 'error').length, 0, JSON.stringify(output.errors));
const verified = [];
function linkBytecode(bytecode) {
  let result = hex(bytecode);
  for (const [sourcePath, libraries] of Object.entries(bytecode.linkReferences ?? {})) for (const [libraryName, locations] of Object.entries(libraries)) {
    assert(libraryNames.includes(libraryName));
    assert.equal(sourcePath, `node_modules/@bananapus/core-v6/${sourcePathFor(libraryName)}`);
    const publications = deployments.filter(item => item.name === libraryName);
    const addresses = [...new Set(publications.map(item => item.deployment.address.toLowerCase()))];
    assert.equal(addresses.length, 1);
    const placeholder = `__$${keccak256(Buffer.from(`${sourcePath}:${libraryName}`)).slice(2, 36)}$__`;
    for (const { start, length } of locations) {
      assert.equal(length, 20);
      const first = 2 + start * 2, end = first + length * 2;
      assert.equal(result.slice(first, end), placeholder);
      result = result.slice(0, first) + addresses[0].slice(2) + result.slice(end);
    }
  }
  assert(/^0x(?:[0-9a-f]{2})+$/.test(result), 'Unresolved compiler link placeholder');
  return result;
}
for (const name of names) {
  const compilerPath = `node_modules/@bananapus/core-v6/${sourcePathFor(name)}`;
  const artifact = output.contracts[compilerPath][name];
  const metadata = JSON.parse(artifact.metadata);
  assert.equal(inputIdentity(metadata), inputIdentity(metadataByName[name]), `Compiler input identity mismatch: ${name}`);
  assert.equal(stable(metadata.sources), stable(metadataByName[name].sources), `Full source metadata mismatch: ${name}`);
  if (stable(deploymentMetadataProjection(metadata)) !== stable(deploymentMetadataProjection(metadataByName[name]))) {
    const changes = [];
    const inspect = (actual, expected, path = '') => {
      if (stable(actual) === stable(expected)) return;
      if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
        for (const key of new Set([...Object.keys(actual), ...Object.keys(expected)])) inspect(actual[key], expected[key], `${path}.${key}`);
      } else changes.push({ path, actual, expected });
    };
    inspect(deploymentMetadataProjection(metadata), deploymentMetadataProjection(metadataByName[name]));
    throw new Error(`Exact metadata mismatch: ${name}: ${JSON.stringify(changes.slice(0, 20))}`);
  }
  const publications = deployments.filter(item => item.name === name);
  const existing = catalog.codes.find(item => item.id === publications[0].deployment.codeId);
  assert.equal(sha256(linkBytecode(artifact.evm.deployedBytecode)), existing.runtimeTemplateSha256, `Runtime mismatch: ${name}`);
  assert.equal(sha256(linkBytecode(artifact.evm.bytecode)), existing.creationSha256, `Creation mismatch: ${name}`);
  for (const publication of publications) assert.equal(abiIdentity(artifact.abi), publication.abiIdentity);
  const immutableReferences = spans(artifact.evm.deployedBytecode.immutableReferences);
  const linkReferences = spans(artifact.evm.deployedBytecode.linkReferences);
  if (targetNames.includes(name)) assert(immutableReferences.length > 0);
  else { assert.equal(immutableReferences.length, 0); assert.equal(linkReferences.length, 0); }
  verified.push({ name, compilerPath, artifact, metadata, publications, existing, immutableReferences, linkReferences });
}
const inputSha256 = writeJson('compiler-input.json', input);
const outputSha256 = writeJson('compiler-output.json', output);
const sourceClosureSha256 = writeJson('source-closure.json', { schemaVersion: 1, sources: sourceOrigins });
const publicationSha256 = writeJson('publications.json', { schemaVersion: 1, repository: catalog.deploymentManifest.repository, commit: deployPin, deployments });
const evmUrl = new URL(argument('--evm-url', 'http://127.0.0.1:47191'));
assert.equal(evmUrl.protocol, 'http:');
assert(['localhost', '127.0.0.1', '[::1]'].includes(evmUrl.hostname));
assert(!evmUrl.username && !evmUrl.password && !evmUrl.search && !evmUrl.hash);
let rpcId = 0;
async function rpc(method, params) {
  const response = await fetch(evmUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }), redirect: 'error', signal: AbortSignal.timeout(15_000) });
  assert(response.ok);
  const text = await response.text(); assert(Buffer.byteLength(text) < 2 * 1024 * 1024);
  const result = JSON.parse(text); assert(!result.error, JSON.stringify(result.error)); return result.result;
}
assert.equal(Number(BigInt(await rpc('eth_chainId', []))), 31337, 'Use an isolated local Anvil chain');
const clientVersion = await rpc('web3_clientVersion', []);
assert(/anvil/i.test(clientVersion));
const initialization = [];
for (const item of verified.filter(item => libraryNames.includes(item.name))) {
  const address = item.publications[0].deployment.address;
  const creation = linkBytecode(item.artifact.evm.bytecode);
  const params = [{ to: address, data: '0x', value: '0x0', gas: '0x989680' }, 'latest', { [address]: { code: creation } }];
  const runtime = await rpc('eth_call', params);
  assert(/^0x(?:[0-9a-f]{2})+$/.test(runtime));
  const trace = await rpc('debug_traceCall', [params[0], params[1], { stateOverrides: params[2] }]);
  assert.equal(trace.failed, false);
  assert.equal(`0x${trace.returnValue.replace(/^0x/, '')}`.toLowerCase(), runtime.toLowerCase());
  const forbidden = /^(?:SLOAD|SSTORE|TLOAD|TSTORE|CALL|CALLCODE|DELEGATECALL|STATICCALL|CREATE|CREATE2|SELFDESTRUCT|BALANCE|SELFBALANCE|EXTCODE.*|BLOCKHASH|NUMBER|TIMESTAMP|PREVRANDAO|COINBASE|BASEFEE|BLOBBASEFEE|CHAINID|CALLER|ORIGIN|GASPRICE)$/;
  assert(!trace.structLogs.some(log => forbidden.test(log.op)), 'Library constructor unexpectedly depends on external state');
  assert.equal((runtime.length - 2) / 2, item.existing.runtimeTemplateByteLength);
  initialization.push({ contractName: item.name, address, compilerCreationSha256: item.existing.creationSha256,
    method: 'eth_call with compiler creation bytecode as target code via state override', clientVersion,
    request: params[0], runtime: runtime.toLowerCase(), runtimeKeccak256: keccak256(runtime),
    constructorTrace: trace.structLogs.map(({ pc, op, depth }) => ({ pc, op, depth })),
    assurance: 'Full compiler constructor return value; no inferred runtime masks, external calls or state reads.' });
}
const initializationSha256 = writeJson('library-initialization.json', { schemaVersion: 1, initialization });
const codeFor = item => ({ ...item.existing, immutableReferences: item.immutableReferences, linkReferences: item.linkReferences, compilerEvidence: {
  artifactPath: 'src/rest/smartAccounts/targets-evidence/compiler-output.json', artifactSha256: outputSha256,
  compilerVersion: item.metadata.compiler.version, metadataSha256: sha256(stable(item.metadata)),
  sourceInputIdentitySha256: inputIdentity(item.metadata), deploymentPaths: item.publications.map(publication => publication.deployment.artifactPath).sort(),
} });
const manifest = {
  schemaVersion: 1, protocolVersion: 6,
  assurance: 'Exact compiler version/settings, complete source metadata, full ABI, creation bytecode and runtime templates reproduced; Foundry parsed documentation projection is explicitly normalized. Only compiler-declared immutable spans may differ onchain. Library addresses remain fixed and their entire constructor-returned runtimes are independently verified.',
  files: { 'compiler-input.json': inputSha256, 'compiler-output.json': outputSha256, 'source-closure.json': sourceClosureSha256, 'publications.json': publicationSha256, 'library-initialization.json': initializationSha256 },
  compiler: { version: '0.8.28+commit.7893614a', platformVersion: version.trim(), binarySha256: compilerBinarySha256, command: 'solc --standard-json',
    releaseManifest: `https://raw.githubusercontent.com/ethereum/solc-bin/gh-pages/${compilerReleases[compilerBinarySha256]}/list.json`, releasePath: `solc-${compilerReleases[compilerBinarySha256]}-v0.8.28+commit.7893614a` },
  records: verified.filter(item => targetNames.includes(item.name)).map(item => {
    const { name, compilerPath, metadata, publications, existing } = item;
    return ({
    contractId: publications[0].contractId, catalogCodeId: existing.id,
    code: codeFor(item),
    linkage: Object.entries(item.artifact.evm.deployedBytecode.linkReferences).flatMap(([sourcePath, libraries]) => Object.entries(libraries).map(([libraryName, runtimeReferences]) => {
      const lib = verified.find(item => item.name === libraryName);
      const initialized = initialization.find(item => item.contractName === libraryName);
      const runtime = initialized.runtime;
      return { sourcePath, libraryName, address: initialized.address, runtimeReferences,
        code: { ...codeFor(lib), id: `initialized:${lib.existing.id}:${initialized.address.toLowerCase()}`,
          runtimeTemplate: runtime, runtimeTemplateSha256: sha256(runtime), runtimeTemplateKeccak256: keccak256(runtime), runtimeTemplateByteLength: (runtime.length - 2) / 2 },
        provenance: { contractId: lib.publications[0].contractId, catalogCodeId: lib.existing.id,
          sourceInputIdentitySha256: inputIdentity(lib.metadata), deploymentCommit: deployPin,
          deploymentPaths: lib.publications.map(item => item.deployment.artifactPath).sort(),
          deployments: lib.publications.map(item => ({ chainId: item.chainId, artifactPath: item.deployment.artifactPath, artifactSha256: item.artifactSha256 })),
          initializationPath: 'src/rest/smartAccounts/targets-evidence/library-initialization.json', initializationSha256,
          compilerCreationSha256: lib.existing.creationSha256 },
      };
    })),
    source: { compilerPath, contractName: name, compilerInputSha256: inputSha256, sourceClosureSha256, deploymentRepository: catalog.deploymentManifest.repository,
      deploymentCommit: deployPin, sourceRepository: 'https://github.com/Bananapus/nana-core-v6', sourceCommit: corePin,
      package: '@bananapus/core-v6', version: '1.0.2', sourceKeccak256: metadata.sources[compilerPath].keccak256,
      compilerSourceIds: Object.fromEntries(Object.keys(metadata.sources).map(path => [path, output.sources[path].id])),
    },
  }); }),
};
if (existsSync(resolve(here, 'observations.json'))) manifest.files['observations.json'] = sha256(readFileSync(resolve(here, 'observations.json')));
writeJson('manifest.json', manifest);
console.log(JSON.stringify({ contracts: verified.map(item => ({ name: item.name, runtimeBytes: item.existing.runtimeTemplateByteLength, immutableSpans: item.immutableReferences.length, compilerInputIdentity: inputIdentity(item.metadata) })), sourceFiles: Object.keys(sources).length, deployments: deployments.length, outputSha256 }));
