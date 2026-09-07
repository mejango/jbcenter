#!/usr/bin/env node
/**
 * Offline V6 catalog generation. Inputs are fixed git commits and compiler artifacts
 * whose complete source closures are checked. No deployment address is inferred from
 * a name, SDK default, another chain, or a source-only build.
 *
 * node scripts/rest/generate-contracts.mjs [--workspace PATH] [--check] [--refresh]
 * --refresh deliberately advances source/deployment pins to local git HEADs.
 */
import { createHash } from "node:crypto";
import { execFileSync, execFile, spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve, relative, basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { keccak256, toFunctionSelector, getAddress } from "viem";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const dataDirectory = resolve(here, "../../src/rest/contracts/data");
const options = process.argv.slice(2);
function option(name, fallback) {
  const index = options.indexOf(name);
  if (index < 0) return fallback;
  if (!options[index + 1] || options[index + 1].startsWith("--")) throw new Error(`${name} needs a value`);
  return options[index + 1];
}
const workspace = resolve(option("--workspace", resolve(here, "../../../..")));
const refresh = options.includes("--refresh");
const check = options.includes("--check");
if (check && refresh) throw new Error("--check and --refresh are mutually exclusive");
const officialRepositories = [
  ["nana-core-v6", "Bananapus/nana-core-v6"],
  ["nana-721-hook-v6", "Bananapus/nana-721-hook-v6"],
  ["nana-address-registry-v6", "Bananapus/nana-address-registry-v6"],
  ["nana-buyback-hook-v6", "Bananapus/nana-buyback-hook-v6"],
  ["nana-fee-project-deployer-v6", "Bananapus/nana-fee-project-deployer-v6"],
  ["nana-omnichain-deployers-v6", "Bananapus/nana-omnichain-deployers-v6"],
  ["nana-ownable-v6", "Bananapus/nana-ownable-v6"],
  ["nana-permission-ids-v6", "Bananapus/nana-permission-ids-v6"],
  ["nana-router-terminal-v6", "Bananapus/nana-router-terminal-v6"],
  ["nana-suckers-v6", "Bananapus/nana-suckers-v6"],
  ["revnet-core-v6", "rev-net/revnet-core-v6"],
  ["croptop-core-v6", "mejango/croptop-core-v6"],
  ["banny-retail-v6", "mejango/banny-retail-v6"],
  ["univ4-lp-split-hook-v6", "Bananapus/nana-univ4-lp-split-hook-v6"],
  ["univ4-router-v6", "Bananapus/nana-univ4-router-v6"],
  ["deploy-all-v6", "Bananapus/deploy-all-v6"],
  ["defifa", "BallKidz/defifa"],
  ["nana-distributor-v6", "Bananapus/nana-distributor-v6"],
  ["nana-project-handles-v6", "Bananapus/nana-project-handles-v6"],
  ["nana-project-payer-v6", "Bananapus/nana-project-payer-v6"],
  ["nana-jbx-distributor-v6", "Bananapus/nana-jbx-distributor-v6"],
  ["nana-swap-split-hook-v6", "Bananapus/nana-swap-split-hook-v6"],
];
const chains = [
  { id: 1, name: "Ethereum", testnet: false }, { id: 10, name: "Optimism", testnet: false },
  { id: 8453, name: "Base", testnet: false }, { id: 42161, name: "Arbitrum One", testnet: false },
  { id: 84532, name: "Base Sepolia", testnet: true }, { id: 421614, name: "Arbitrum Sepolia", testnet: true },
  { id: 11155111, name: "Sepolia", testnet: true }, { id: 11155420, name: "OP Sepolia", testnet: true },
];
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function git(repo, ...args) { return execFileSync("git", ["-C", repo, ...args], { maxBuffer: 128 * 1024 * 1024 }); }
function gitJson(repo, commit, path) { return JSON.parse(git(repo, "show", `${commit}:${path}`).toString()); }
function canonicalType(parameter) {
  return parameter.type.startsWith("tuple")
    ? `(${parameter.components.map(canonicalType).join(",")})${parameter.type.slice(5)}` : parameter.type;
}
function abiSorted(abi) { return [...abi].sort((a, b) => stable(a).localeCompare(stable(b), "en")); }
function abiMetadataIdentity(abi) {
  // Foundry's parsed metadata omits empty function outputs and adds empty
  // receive/fallback inputs. These defaults change no ABI encoding.
  return stable(abiSorted(abi.map((entry) => {
    const normalized = { ...entry };
    if (entry.type === "function" && normalized.outputs === undefined) normalized.outputs = [];
    if (["receive", "fallback"].includes(entry.type) && Array.isArray(normalized.inputs) && normalized.inputs.length === 0) delete normalized.inputs;
    return normalized;
  })));
}
function compilerInputIdentity(metadata) {
  const settings = { ...metadata.settings };
  settings.remappings = (settings.remappings ?? []).map((item) => item.replace(/^:/, "")).sort();
  const sources = Object.fromEntries(Object.entries(metadata.sources).map(([key, value]) => [key, value.keccak256]));
  return sha256(stable({ compiler: metadata.compiler, settings, sources }));
}
function methodsFor(abi, category, identifiers = {}) {
  const seen = new Set();
  return abi.filter((entry) => entry.type === "function").map((entry) => {
    const signature = `${entry.name}(${entry.inputs.map(canonicalType).join(",")})`;
    if (seen.has(signature)) throw new Error(`Duplicate ABI function ${signature}`);
    seen.add(signature);
    const declaredSelector = identifiers[signature];
    return {
      signature, selector: declaredSelector ? `0x${declaredSelector.replace(/^0x/, "")}`
        : category === "library" ? null : toFunctionSelector(signature),
      name: entry.name, stateMutability: entry.stateMutability,
      kind: entry.stateMutability === "view" || entry.stateMutability === "pure" ? "read" : "write",
      inputs: entry.inputs, outputs: entry.outputs,
    };
  }).sort((a, b) => a.signature.localeCompare(b.signature, "en"));
}
function spans(references) {
  if (references === undefined || references === null) return null;
  const result = [];
  function visit(value) {
    if (Array.isArray(value)) { for (const item of value) visit(item); }
    else if (value && typeof value === "object") {
      if (Number.isInteger(value.start) && Number.isInteger(value.length)) result.push({ start: value.start, length: value.length });
      else for (const child of Object.values(value)) visit(child);
    }
  }
  visit(references);
  return result.sort((a, b) => a.start - b.start || a.length - b.length);
}
const pinPath = join(dataDirectory, "pins.json");
let pins = !refresh && existsSync(pinPath) ? JSON.parse(readFileSync(pinPath, "utf8")) : null;
if (!pins && !refresh) throw new Error("Missing catalog pins; generate intentionally with --refresh first");
if (refresh) pins = { schemaVersion: 1, repositories: officialRepositories.map(([repository, slug]) => {
  const repo = join(workspace, repository);
  const commit = git(repo, "rev-parse", "HEAD").toString().trim();
  const pkg = gitJson(repo, commit, "package.json");
  return { repository, repositoryUrl: `https://github.com/${slug}`, commit, id: pkg.name, version: pkg.version };
}) };
if (pins.repositories.length !== officialRepositories.length
  || officialRepositories.some(([name]) => !pins.repositories.some((entry) => entry.repository === name))) {
  throw new Error("Pins must contain precisely the official V6 repository allowlist");
}
const packageByRepo = new Map(pins.repositories.map((entry) => [entry.repository, entry]));
const packages = pins.repositories.map((entry) => ({ ...entry,
  category: ["deploy-all-v6", "nana-fee-project-deployer-v6"].includes(entry.repository) ? "deployment" : "protocol",
}));
const packageById = new Map(packages.map((entry) => [entry.id, entry]));
const deployPin = packageByRepo.get("deploy-all-v6");
const deployRepo = join(workspace, "deploy-all-v6");

// Source builds are independent of deployment-address proof. A newer source ABI
// is retained as a distinct variant rather than silently replacing a deployed ABI.
const sources = await generateSourceAbis({
  workspace, keccak256,
  commits: Object.fromEntries(pins.repositories.map((entry) => [entry.repository, entry.commit])),
  repoNames: officialRepositories.map(([name]) => name),
});
const contracts = new Map();
const codes = new Map();
const evidenceByRuntime = new Map();
const exclusions = sources.exclusions.map((entry) => ({ path: `${entry.repo}/${entry.sourcePath}:${entry.contractName}`, reason: entry.reason }));
function contractId(packageId, sourcePath, name) { return `${packageId}:${sourcePath}:${name}`; }
function ensureContract(packageId, sourcePath, name, category) {
  const id = contractId(packageId, sourcePath, name);
  let contract = contracts.get(id);
  if (!contract) {
    contract = { id, packageId, sourcePath, name, category, executable: category === "contract",
      variants: [], deployments: chains.map((chain) => ({ chainId: chain.id, status: "missing", instances: [] })), cloneFamilies: [] };
    contracts.set(id, contract);
  } else if (contract.category !== category) throw new Error(`Conflicting category: ${id}`);
  return contract;
}
function addVariant(contract, rawAbi, provenance, usage, identifiers) {
  const abi = abiSorted(rawAbi);
  const abiHash = sha256(stable(abi));
  let variant = contract.variants.find((entry) => entry.abiHash === abiHash);
  if (!variant) {
    variant = { abiHash, abi, methods: methodsFor(abi, contract.category, identifiers), provenance: [], usage, codeIds: [] };
    contract.variants.push(variant);
  }
  if (usage === "published") variant.usage = "published";
  if (!variant.provenance.some((entry) => entry.sourceRef === provenance.sourceRef && entry.metadataSha256 === provenance.metadataSha256)) {
    variant.provenance.push(provenance);
  }
  return variant;
}
function addCode(runtime, creation, proof, scope = "deployment") {
  runtime = runtime.toLowerCase(); creation = creation.toLowerCase();
  if (!/^0x[0-9a-f]*$/.test(runtime) || !/^0x[0-9a-f]*$/.test(creation)) return null;
  const runtimeHash = sha256(runtime);
  const creationHash = sha256(creation);
  const codeId = `sha256:${sha256(stable({ runtime: runtimeHash, creation: creationHash, scope }))}`;
  if (!codes.has(codeId)) codes.set(codeId, {
    id: codeId, hashEncoding: "lowercase-hex-text", runtimeTemplate: runtime,
    runtimeTemplateSha256: runtimeHash, runtimeTemplateKeccak256: keccak256(runtime),
    runtimeTemplateByteLength: (runtime.length - 2) / 2, creationSha256: creationHash,
    immutableReferences: proof?.immutableReferences ?? null, linkReferences: proof?.linkReferences ?? null,
    compilerEvidence: proof?.compilerEvidence ?? null,
  });
  return codeId;
}
for (const source of sources.contracts) {
  const pkg = packageByRepo.get(source.repo);
  if (!pkg) throw new Error(`Non-official source repository ${source.repo}`);
  const contract = ensureContract(pkg.id, source.sourcePath, source.contractName, source.contractKind);
  const prov = source.provenance;
  const sourceProvenance = {
    kind: "clean-source-build", repository: source.repo, repositoryUrl: pkg.repositoryUrl,
    commit: source.gitCommit, sourceRef: source.gitCommit, sourcePath: source.sourcePath,
    sourceKeccak256: source.sourceKeccak256, compilerVersion: prov.compilerVersion,
    artifactPath: prov.artifactPath ?? `${source.repo}/compiled/${source.sourcePath}:${source.contractName}`,
    artifactSha256: prov.artifactSha256 ?? sha256(stable({ abi: source.abi, bytecode: source.bytecode, deployedBytecode: source.deployedBytecode, metadataSha256: prov.metadataSha256 })),
    metadataSha256: prov.metadataSha256,
    sourceHashes: { ...prov.sourceHashes, ...prov.dependencyHashes },
    buildKind: prov.kind,
    ...(prov.inputSha256 ? { compilerInputSha256: prov.inputSha256, compilerBinarySha256: prov.compilerBinarySha256 } : {}),
  };
  const variant = addVariant(contract, source.abi, sourceProvenance, "source-only", source.methodIdentifiers);
  const runtime = source.deployedBytecode.object;
  if (/^0x[0-9a-fA-F]+$/.test(runtime)) {
    const proof = {
      immutableReferences: spans(source.deployedBytecode.immutableReferences),
      linkReferences: spans(source.deployedBytecode.linkReferences),
      methodIdentifiers: source.methodIdentifiers,
      compilerEvidence: {
        artifactPath: sourceProvenance.artifactPath, artifactSha256: sourceProvenance.artifactSha256,
        compilerVersion: prov.compilerVersion, metadataSha256: prov.metadataSha256,
      },
    };
    // These proofs describe clean current source builds. Deployment proofs below
    // additionally require exact deployed compiler metadata/source identity.
    const codeId = addCode(runtime, source.bytecode.object, proof, `source:${contract.id}:${source.gitCommit}`);
    if (codeId) variant.codeIds.push(codeId);
  }
}
// Build scripts remain discoverable inventory entries, with no callable ABI.
for (const source of sources.scripts) {
  const pkg = packageByRepo.get(source.repo);
  const contract = ensureContract(pkg.id, source.sourcePath, source.contractName, "script");
  addVariant(contract, [], {
    kind: "clean-source-build", repository: source.repo, repositoryUrl: pkg.repositoryUrl,
    commit: source.gitCommit, sourceRef: source.gitCommit, sourcePath: source.sourcePath,
    sourceKeccak256: source.sourceKeccak256, compilerVersion: "not-compiled",
    artifactPath: `${source.repo}/${source.sourcePath}`, artifactSha256: sha256(git(join(workspace, source.repo), "show", `${source.gitCommit}:${source.sourcePath}`)),
    metadataSha256: "", sourceHashes: { [source.sourcePath]: source.sourceKeccak256 }, buildKind: "source-declaration",
  }, "source-only");
}

// Supplement source outputs with compiler outputs matching an exact deployment
// template. The proof helper validates metadata/ABI and never guesses zero spans.
const extraProofs = await findDeploymentCodeProofs({ workspace, deployRepo, deployCommit: deployPin.commit, keccak256 });
for (const [hash, proof] of Object.entries(extraProofs)) evidenceByRuntime.set(hash, proof);

const artifactPaths = git(deployRepo, "ls-tree", "-r", "--name-only", deployPin.commit, "deployments").toString().trim().split("\n")
  .filter((path) => /^deployments\/[^/]+\/[^/]+\.json$/.test(path)).sort();
const treeHash = createHash("sha256");
for (const path of artifactPaths) {
  const alias = basename(path, ".json");
  if (/_deprecated\d*$/.test(alias) || alias.endsWith("__TwapOracleUpgrade")) {
    exclusions.push({ path: `deploy-all-v6/${path}`, reason: "superseded-deployment-snapshot" });
    continue;
  }
  const raw = git(deployRepo, "show", `${deployPin.commit}:${path}`);
  const artifact = JSON.parse(raw.toString());
  if (!artifact.address || !Array.isArray(artifact.abi) || !artifact.chainId) continue;
  if (artifact.gitDirty !== false || !artifact.receipt?.transactionHash || !artifact.gitCommit) throw new Error(`Unproven deployment artifact: ${path}`);
  const chainId = Number(artifact.chainId);
  if (!chains.some((chain) => chain.id === chainId)) throw new Error(`Unsupported chain in official manifest: ${path}`);
  const matched = /^node_modules\/(@[^/]+\/[^/]+)\/(.+)$/.exec(artifact.sourceName);
  if (!matched) throw new Error(`Unexpected deployment source: ${artifact.sourceName}`);
  const [, packageId, sourcePath] = matched;
  if (sourcePath.startsWith("script/") || sourcePath.includes("/archive/")) {
    exclusions.push({ path: `deploy-all-v6/${path}`, reason: "non-runtime-source" });
    continue;
  }
  if (!packageById.has(packageId)) {
    if (packageId !== "@openzeppelin/contracts" || artifact.contractName !== "ERC2771Forwarder") throw new Error(`Non-official deployment dependency: ${packageId}`);
    const pkg = { id: packageId, repository: "openzeppelin-contracts", repositoryUrl: "https://github.com/OpenZeppelin/openzeppelin-contracts",
      commit: artifact.gitCommit, version: artifact.gitCommit.slice(artifact.gitCommit.lastIndexOf("@") + 1), category: "dependency" };
    packages.push(pkg); packageById.set(packageId, pkg);
  }
  const pkg = packageById.get(packageId);
  const metadata = typeof artifact.metadata === "string" ? JSON.parse(artifact.metadata) : artifact.metadata;
  if (abiMetadataIdentity(artifact.abi) !== abiMetadataIdentity(metadata.output.abi)) throw new Error(`ABI/metadata mismatch: ${path}`);
  if (metadata.settings.compilationTarget[artifact.sourceName] !== artifact.contractName) throw new Error(`Compiler target mismatch: ${path}`);
  const id = contractId(packageId, sourcePath, artifact.contractName);
  const category = contracts.get(id)?.category ?? (sourcePath.includes("/libraries/") ? "library" : "contract");
  const contract = ensureContract(packageId, sourcePath, artifact.contractName, category);
  const runtime = artifact.deployedBytecode.toLowerCase();
  if (!/^0x[0-9a-f]*$/.test(runtime)) throw new Error(`Unlinked deployment runtime: ${path}`);
  const runtimeHash = sha256(runtime);
  const proof = (evidenceByRuntime.get(runtimeHash) ?? []).find((candidate) =>
    candidate.compilerEvidence.deploymentPaths.includes(`deploy-all-v6/${path}`));
  const compilerInputIdentitySha256 = compilerInputIdentity(metadata);
  if (proof && proof.compilerEvidence.sourceInputIdentitySha256 !== compilerInputIdentitySha256) {
    throw new Error(`Compiler proof belongs to a different deployment source identity: ${path}`);
  }
  const variant = addVariant(contract, artifact.abi, {
    kind: "deployment-artifact", repository: "deploy-all-v6", repositoryUrl: deployPin.repositoryUrl,
    commit: deployPin.commit, sourceRef: artifact.gitCommit, sourcePath,
    sourceKeccak256: metadata.sources[artifact.sourceName].keccak256,
    compilerVersion: metadata.compiler.version, artifactPath: `deploy-all-v6/${path}`, artifactSha256: sha256(raw),
    metadataSha256: sha256(stable(metadata)),
    sourceHashes: Object.fromEntries(Object.entries(metadata.sources).map(([key, value]) => [key, value.keccak256])),
  }, "published", proof?.methodIdentifiers);
  const codeId = addCode(runtime, artifact.bytecode, proof,
    proof ? `deployment:compiler:${proof.compilerEvidence.sourceInputIdentitySha256}` : "deployment:unverified");
  if (!codeId) throw new Error(`Unlinked deployment creation code: ${path}`);
  if (!variant.codeIds.includes(codeId)) variant.codeIds.push(codeId);
  const deployment = {
    alias, address: getAddress(artifact.address), chainId, abiHash: variant.abiHash, codeId,
    artifactPath: `deploy-all-v6/${path}`, artifactSha256: sha256(raw), sourceRef: artifact.gitCommit,
    solcInputHash: artifact.solcInputHash, constructorArguments: artifact.args ?? [],
    compilerInputIdentitySha256,
    receipt: { transactionHash: artifact.receipt.transactionHash, blockNumber: String(artifact.receipt.blockNumber), blockHash: artifact.receipt.blockHash },
    instanceKind: "unclassified",
  };
  const chain = contract.deployments.find((entry) => entry.chainId === chainId);
  chain.status = "published"; chain.instances.push(deployment);
  treeHash.update(path).update("\0").update(raw).update("\0");
}

const families = [
  ["@bananapus/core-v6", "JBERC20", "JBTokens", "TOKEN()", "erc-1167"],
  ["@bananapus/721-hook-v6", "JB721TiersHook", "JB721TiersHookDeployer", "HOOK()", "solady-libclone"],
  ["@bananapus/721-hook-v6", "JB721Checkpoints", "JB721CheckpointsDeployer", "IMPLEMENTATION()", "solady-libclone"],
  ["@bananapus/project-payer-v6", "JBProjectPayer", "JBProjectPayerDeployer", "IMPLEMENTATION()", "erc-1167"],
  ["@bananapus/univ4-lp-split-hook-v6", "JBUniswapV4LPSplitHook", "JBUniswapV4LPSplitHookDeployer", "hookImplementation()", "solady-libclone"],
  ...["JBArbitrumSucker", "JBBaseSucker", "JBCCIPSucker", "JBOptimismSucker"].map((name) =>
    ["@bananapus/suckers-v6", name, `${name}Deployer`, "singleton()", "solady-libclone"]),
  ["@ballkidz/defifa", "DefifaHook", "DefifaDeployer", "HOOK_CODE_ORIGIN()", "erc-1167"],
];
for (const [packageId, implementationName, factoryName, getter, standard] of families) {
  const implementation = [...contracts.values()].find((entry) => entry.packageId === packageId && entry.name === implementationName && entry.category === "contract");
  const factory = [...contracts.values()].find((entry) => entry.packageId === packageId && entry.name === factoryName && entry.category === "contract");
  if (!implementation || !factory) throw new Error(`Missing clone family ${implementationName}`);
  if (!factory.variants.some((variant) => variant.methods.some((method) => method.signature === getter))) throw new Error(`Missing clone implementation getter ${factoryName}.${getter}`);
  implementation.cloneFamilies.push({ standard, implementationContractId: implementation.id, factoryContractId: factory.id,
    implementationGetter: getter, sourcePath: factory.sourcePath, sourceRef: packageById.get(packageId).commit });
}
for (const contract of contracts.values()) {
  contract.variants.sort((a, b) => (a.usage === b.usage ? a.abiHash.localeCompare(b.abiHash) : a.usage === "published" ? -1 : 1));
  const primary = contract.variants[0];
  contract.abi = primary.abi; contract.abiHash = primary.abiHash; contract.methods = primary.methods;
  for (const chain of contract.deployments) chain.instances.sort((a, b) => a.alias.localeCompare(b.alias, "en"));
}
const data = {
  schemaVersion: 1, protocolVersion: 6, chains, packages: packages.sort((a, b) => a.id.localeCompare(b.id, "en")),
  deploymentManifest: { repository: deployPin.repositoryUrl, commit: deployPin.commit, treeDigest: treeHash.digest("hex") },
  generation: { sourceManifestHash: sha256(stable(pins)), contentHash: "" },
  exclusions: exclusions.sort((a, b) => a.path.localeCompare(b.path, "en")),
  contracts: [...contracts.values()].sort((a, b) => a.id.localeCompare(b.id, "en")),
  codes: [...codes.values()].sort((a, b) => a.id.localeCompare(b.id, "en")),
};
data.generation.contentHash = sha256(stable(data));
const serialized = `${JSON.stringify(data)}\n`;
if (serialized.includes(workspace) || /\/Users\/|\/private\/tmp\//.test(serialized)) throw new Error("Private filesystem paths leaked into catalog");
const output = join(dataDirectory, "catalog.json");
if (check) {
  if (readFileSync(output, "utf8") !== serialized) throw new Error("Pinned catalog is stale; inspect inputs and regenerate intentionally");
} else {
  mkdirSync(dataDirectory, { recursive: true });
  writeFileSync(output, serialized);
  if (refresh) writeFileSync(pinPath, `${JSON.stringify(pins, null, 2)}\n`);
}
console.log(`${check ? "Verified" : "Generated"} ${data.contracts.length} contract declarations, ${data.contracts.reduce((sum, item) => sum + item.deployments.reduce((count, chain) => count + chain.instances.length, 0), 0)} deployments, ${data.codes.length} code templates.`);

// The source-closure and exact compiler-output helpers follow below.

/**
 * Generate compiler ABIs from tracked official source declarations.
 * keccak256 is injected (e.g. viem.keccak256), accepting a Uint8Array.
 * commits pins source provenance; omitted entries default to the current HEAD.
 * repoNames is an explicit caller-owned allowlist; extensions are always rejected.
 * No repository files are written. Only solc's standard input/output are used.
 */
export async function generateSourceAbis({
  workspace,
  keccak256,
  commits = {},
  repoNames,
  solcPath,
  onProgress = () => {},
}) {
  if (!workspace || typeof keccak256 !== 'function' || !Array.isArray(repoNames)) {
    throw new Error('generateSourceAbis requires workspace, keccak256, and explicit repoNames');
  }
  const root = path.resolve(workspace);
  const sha256 = value => createHash('sha256').update(value).digest('hex');
  const stable = value => {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  };
  const hash = bytes => keccak256(new Uint8Array(bytes));
  const normalizedAbi = abi => abi.map(stable).sort().join('\n');
  const clone = value => JSON.parse(JSON.stringify(value));
  const git = async (repo, ...args) => {
    const { stdout } = await execFileAsync('git', ['-C', repo, ...args], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  };
  const sourceCache = new Map();
  const dependencyCache = new Map();
  const readHeadSource = async (repo, commit, sourcePath) => {
    const key = `${repo}:${commit}:${sourcePath}`;
    if (!sourceCache.has(key)) sourceCache.set(key, await git(repo, 'show', `${commit}:${sourcePath}`));
    return sourceCache.get(key);
  };
  const assertRelative = sourcePath => {
    if (path.isAbsolute(sourcePath) || sourcePath.split(/[\\/]/).includes('..')) {
      throw new Error(`Non-relative compiler source path: ${sourcePath}`);
    }
  };
  const readDependency = async (repo, sourcePath) => {
    assertRelative(sourcePath);
    const key = `${repo}:${sourcePath}`;
    if (!dependencyCache.has(key)) dependencyCache.set(key, await readFile(path.join(repo, sourcePath)));
    return dependencyCache.get(key);
  };
  const declarations = source => {
    const text = source.toString('utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    return [...text.matchAll(/^\s*(abstract\s+)?(contract|interface|library)\s+(\w+)\b/gm)]
      .map(match => ({ kind: match[1] ? 'abstract' : match[2], name: match[3] }));
  };
  const runSolc = (binary, input) => new Promise((resolve, reject) => {
    const child = spawn(binary, ['--standard-json'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', data => stdout.push(data));
    child.stderr.on('data', data => stderr.push(data));
    child.on('error', reject);
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`solc exited ${code}: ${Buffer.concat(stderr).toString('utf8')}`));
      try { resolve(JSON.parse(Buffer.concat(stdout).toString('utf8'))); } catch (error) { reject(error); }
    });
    child.stdin.end(input);
  });
  const result = { schemaVersion: 1, repositories: [], contracts: [], scripts: [], exclusions: [] };
  const pendingGroups = new Map();
  const observedHeads = new Map();
  for (const repoName of [...new Set(repoNames)].sort()) {
    if (!/^[A-Za-z0-9._-]+$/.test(repoName) || repoName === 'extensions') {
      throw new Error(`Invalid official repository name: ${repoName}`);
    }
    const repo = path.join(root, repoName);
    try { await stat(path.join(repo, 'foundry.toml')); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const head = (await git(repo, 'rev-parse', 'HEAD')).toString('utf8').trim();
    observedHeads.set(repoName, head);
    const pin = commits[repoName] ?? head;
    if (!/^[0-9a-f]{40,64}$/i.test(pin)) throw new Error(`Expected a full git commit for ${repoName}`);
    const commit = (await git(repo, 'rev-parse', `${pin}^{commit}`)).toString('utf8').trim();
    const repoRecord = { repo: repoName, gitCommit: commit, contractCount: 0, scriptCount: 0 };
    result.repositories.push(repoRecord);
    const files = (await git(repo, 'ls-tree', '-r', '--name-only', commit, 'src', 'script')).toString('utf8').trim().split('\n').filter(Boolean).sort();
    for (const sourcePath of files) {
      if (!sourcePath.endsWith('.sol')) continue;
      const source = await readHeadSource(repo, commit, sourcePath);
      for (const { kind, name } of declarations(source)) {
        if (sourcePath.startsWith('src/archive/')) {
          result.exclusions.push({ repo: repoName, sourcePath, contractName: name, reason: 'archived-source' });
          continue;
        }
        const record = {
          id: `${repoName}:${sourcePath}:${name}`,
          repo: repoName,
          sourcePath,
          contractName: name,
          contractKind: kind,
          gitCommit: commit,
          sourceKeccak256: hash(source),
          gitBlobSha1: createHash('sha1').update(Buffer.from(`blob ${source.length}\0`)).update(source).digest('hex'),
        };
        if (sourcePath.startsWith('script/')) {
          Object.assign(record, { contractKind: 'script', declarationKind: kind, executable: false });
          result.scripts.push(record);
          repoRecord.scriptCount++;
          continue;
        }
        const artifactRelative = `${repoName}/out/${path.basename(sourcePath)}/${name}.json`;
        const artifactBytes = await readFile(path.join(root, artifactRelative));
        const artifact = JSON.parse(artifactBytes.toString('utf8'));
        // Foundry's parsed metadata rewrites ABI ordering, NatSpec, and remappings.
        // Raw metadata is the exact compiler form and is the provenance authority.
        const metadata = artifact.rawMetadata ? JSON.parse(artifact.rawMetadata)
          : typeof artifact.metadata === 'string' ? JSON.parse(artifact.metadata) : artifact.metadata;
        if (stable(metadata.settings.compilationTarget) !== stable({ [sourcePath]: name })) {
          throw new Error(`Artifact compilation target differs from source declaration: ${record.id}`);
        }
        if (normalizedAbi(artifact.abi) !== normalizedAbi(metadata.output.abi)) {
          throw new Error(`ABI differs from compiler metadata: ${record.id}`);
        }
        const sourceHashes = {};
        const dependencyHashes = {};
        const inputs = {};
        const stalePaths = [];
        for (const [inputPath, info] of Object.entries(metadata.sources).sort(([a], [b]) => a.localeCompare(b))) {
          assertRelative(inputPath);
          const owned = inputPath.startsWith('src/');
          const raw = owned ? await readHeadSource(repo, commit, inputPath) : await readDependency(repo, inputPath);
          const actualHash = hash(raw);
          if (owned) {
            sourceHashes[inputPath] = actualHash;
            if (actualHash !== info.keccak256) stalePaths.push(inputPath);
          } else {
            if (actualHash !== info.keccak256) throw new Error(`Dependency differs from compiler metadata: ${repoName}:${inputPath}`);
            dependencyHashes[inputPath] = actualHash;
          }
          inputs[inputPath] = { content: raw.toString('utf8') };
        }
        const settings = clone(metadata.settings);
        delete settings.compilationTarget;
        record.provenance = {
          kind: 'verified-foundry-artifact',
          artifactPath: artifactRelative,
          artifactSha256: sha256(artifactBytes),
          compilerVersion: metadata.compiler.version,
          sourceHashes,
          dependencyHashes,
          compilerSettings: settings,
          metadataSha256: sha256(stable(metadata)),
          assurance: 'Repository-owned inputs match frozen git commit; dependency bytes match compiler metadata keccak256; ABI matches compiler metadata.',
        };
        result.contracts.push(record);
        repoRecord.contractCount++;
        if (stalePaths.length) {
          // Different historical compiler settings form separate compilation groups.
          const groupKey = `${repoName}:${metadata.compiler.version}:${stable(settings)}`;
          if (!pendingGroups.has(groupKey)) pendingGroups.set(groupKey, []);
          pendingGroups.get(groupKey).push({ record, artifact, metadata, inputs, settings, stalePaths });
        } else {
          for (const key of ['abi', 'methodIdentifiers', 'bytecode', 'deployedBytecode']) record[key] = artifact[key];
        }
      }
    }
    onProgress(`${repoName}: ${repoRecord.contractCount} source declarations, ${repoRecord.scriptCount} scripts`);
  }
  for (const entries of pendingGroups.values()) {
    const sources = {};
    const settings = clone(entries[0].settings);
    for (const entry of entries) {
      for (const [inputPath, source] of Object.entries(entry.inputs)) {
        if (sources[inputPath] && sources[inputPath].content !== source.content) throw new Error(`Conflicting source inputs: ${inputPath}`);
        sources[inputPath] = source;
      }
    }
    settings.outputSelection = {};
    for (const { record } of entries) {
      settings.outputSelection[record.sourcePath] ??= {};
      settings.outputSelection[record.sourcePath][record.contractName] = [
        'abi', 'metadata', 'evm.methodIdentifiers', 'evm.bytecode', 'evm.deployedBytecode',
      ];
    }
    const compilerInput = { language: 'Solidity', sources, settings };
    const encodedInput = Buffer.from(stable(compilerInput));
    const compilerVersion = entries[0].metadata.compiler.version.split('+')[0];
    const binary = typeof solcPath === 'function' ? solcPath(compilerVersion)
      : solcPath ?? path.join(homedir(), '.svm', compilerVersion, `solc-${compilerVersion}`);
    onProgress(`Compiling clean git sources: ${entries.map(({ record }) => record.contractName).join(', ')}`);
    const output = await runSolc(binary, encodedInput);
    const errors = (output.errors ?? []).filter(error => error.severity === 'error');
    if (errors.length) throw new Error(`Clean source compilation failed: ${errors.map(error => error.formattedMessage ?? error.message).join('\n')}`);
    const binaryHash = sha256(await readFile(binary));
    for (const { record, artifact, stalePaths } of entries) {
      const compiled = output.contracts[record.sourcePath][record.contractName];
      const evm = compiled.evm;
      Object.assign(record, { abi: compiled.abi, methodIdentifiers: evm.methodIdentifiers, bytecode: evm.bytecode, deployedBytecode: evm.deployedBytecode });
      for (const key of ['bytecode', 'deployedBytecode']) {
        if (!record[key].object.startsWith('0x')) record[key].object = `0x${record[key].object}`;
      }
      const compiledMetadata = JSON.parse(compiled.metadata);
      const provenance = record.provenance;
      Object.assign(provenance, {
        kind: 'compiled-clean-git-sources',
        seedArtifactPath: provenance.artifactPath,
        seedArtifactSha256: provenance.artifactSha256,
        seedMetadataSha256: provenance.metadataSha256,
        replacedSourcePaths: stalePaths,
        inputSha256: sha256(encodedInput),
        compilerBinarySha256: binaryHash,
        metadataSha256: sha256(stable(compiledMetadata)),
        sourceHashes: Object.fromEntries(Object.entries(compiledMetadata.sources).filter(([key]) => key.startsWith('src/')).map(([key, value]) => [key, value.keccak256])),
        dependencyHashes: Object.fromEntries(Object.entries(compiledMetadata.sources).filter(([key]) => !key.startsWith('src/')).map(([key, value]) => [key, value.keccak256])),
        assurance: 'ABI and bytecode compiled from repository-owned inputs at frozen git commit and dependency bytes verified against seed compiler metadata keccak256.',
      });
      delete provenance.artifactPath;
      delete provenance.artifactSha256;
      record.abiMatchesSeedIgnoringOrder = normalizedAbi(record.abi) === normalizedAbi(artifact.abi);
    }
  }
  for (const record of result.contracts) {
    record.abi = [...record.abi].sort((a, b) => stable(a) < stable(b) ? -1 : stable(a) > stable(b) ? 1 : 0);
    record.constructor = record.abi.find(entry => entry.type === 'constructor') ?? null;
    record.hasRuntimeCode = Boolean(record.deployedBytecode.object.replace(/^0x/, ''));
  }
  for (const [repoName, head] of observedHeads) {
    const finalHead = (await git(path.join(root, repoName), 'rev-parse', 'HEAD')).toString('utf8').trim();
    if (finalHead !== head) throw new Error(`Repository HEAD changed during generation: ${repoName}`);
  }
  const serialized = stable(result);
  if (serialized.includes(root) || serialized.includes('/Users/') || serialized.includes('/private/tmp/')) {
    throw new Error('Absolute local path found in source ABI output');
  }
  return result;
}

/**
 * Locate exact compiler evidence for pinned deployment runtime templates.
 * Returns proof arrays keyed by SHA256(UTF-8 lowercase 0x-prefixed runtime HEX TEXT).
 * Each proof retains its own compiler input identity, even when runtime bytes and
 * immutable offsets are identical across source/compiler input variants.
 * Proofs require exact runtime bytes, compiler version/settings/full source-hash
 * identity, and ABI identity. Every metadata source hash must match an input
 * byte sequence; a runtime-only match is insufficient for immutable masks.
 */
export async function findDeploymentCodeProofs({
  workspace,
  deployRepo = 'deploy-all-v6',
  deployCommit,
  keccak256,
  repoNames = [
    'banny-retail-v6', 'croptop-core-v6', 'defifa', 'deploy-all-v6',
    'nana-721-hook-v6', 'nana-address-registry-v6', 'nana-buyback-hook-v6',
    'nana-core-v6', 'nana-distributor-v6', 'nana-fee-project-deployer-v6',
    'nana-jbx-distributor-v6', 'nana-omnichain-deployers-v6', 'nana-ownable-v6',
    'nana-permission-ids-v6', 'nana-project-handles-v6', 'nana-project-payer-v6',
    'nana-router-terminal-v6', 'nana-suckers-v6', 'nana-swap-split-hook-v6',
    'revnet-core-v6', 'univ4-lp-split-hook-v6', 'univ4-router-v6',
  ],
  onProgress = () => {},
}) {
  if (!workspace || typeof keccak256 !== 'function') throw new Error('workspace and keccak256 are required');
  const root = path.resolve(workspace);
  const deploymentRoot = path.isAbsolute(deployRepo) ? deployRepo : path.join(root, deployRepo);
  const relativeDeploymentRoot = path.relative(root, deploymentRoot);
  if (relativeDeploymentRoot.startsWith('..') || path.isAbsolute(relativeDeploymentRoot)) {
    throw new Error('Deployment repository must be within workspace');
  }
  const stable = value => {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
  };
  const sha256 = value => createHash('sha256').update(value).digest('hex');
  const git = async (...args) => {
    const { stdout } = await execFileAsync('git', ['-C', deploymentRoot, ...args], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  };
  const commit = deployCommit ?? (await git('rev-parse', 'HEAD')).toString('utf8').trim();
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) throw new Error('deployCommit must be a full git commit');
  const metadataOf = artifact => {
    const metadata = artifact.rawMetadata || artifact.metadata;
    return typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
  };
  const inputIdentity = metadata => {
    const settings = { ...metadata.settings };
    // Solidity and Foundry represent an empty remapping context as :prefix or prefix.
    settings.remappings = (settings.remappings ?? []).map(item => item.replace(/^:/, '')).sort();
    const sources = Object.fromEntries(Object.entries(metadata.sources).map(([key, value]) => [key, value.keccak256]));
    return sha256(stable({ compiler: metadata.compiler, settings, sources }));
  };
  const abiIdentity = abi => sha256(abi.map(stable).sort().join('\n'));
  const runtimeKey = value => {
    const object = typeof value === 'object' && value ? value.object : value;
    if (typeof object !== 'string') return null;
    const normalized = `0x${object.replace(/^0x/, '').toLowerCase()}`;
    if (!/^0x(?:[0-9a-f]{2})+$/.test(normalized)) return null;
    return sha256(normalized);
  };
  const flattened = value => {
    if (Array.isArray(value)) return value.map(({ start, length }) => ({ start, length })).sort((a, b) => a.start - b.start || a.length - b.length);
    return Object.values(value ?? {}).flatMap(flattened).sort((a, b) => a.start - b.start || a.length - b.length);
  };
  const deployments = new Map();
  const deploymentFiles = (await git('ls-tree', '-r', '--name-only', commit, 'deployments')).toString('utf8').split('\n').filter(name => /^deployments\/[^/]+\/[^/]+\.json$/.test(name));
  for (const deploymentPath of deploymentFiles) {
    const artifact = JSON.parse((await git('show', `${commit}:${deploymentPath}`)).toString('utf8'));
    const key = runtimeKey(artifact.deployedBytecode);
    const metadata = metadataOf(artifact);
    if (!key || !metadata) continue;
    const item = { identity: inputIdentity(metadata), abi: abiIdentity(artifact.abi), path: `${relativeDeploymentRoot}/${deploymentPath}` };
    if (!deployments.has(key)) deployments.set(key, []);
    deployments.get(key).push(item);
  }
  onProgress(`Deployment compiler-proof scan: ${deployments.size} runtime templates`);
  const sourceHashCache = new Map();
  const proofs = {};
  const consider = async ({ artifact, artifactPath, artifactSha256, inputSources, sourceRoot, buildContractPath }) => {
    const evm = artifact.evm ?? artifact;
    const runtime = evm.deployedBytecode;
    if (!runtime || typeof runtime !== 'object') return;
    const key = runtimeKey(runtime);
    if (!deployments.has(key)) return;
    const metadata = metadataOf(artifact);
    if (!metadata || !Array.isArray(artifact.abi)) return;
    const identity = inputIdentity(metadata);
    const abi = abiIdentity(artifact.abi);
    const matching = deployments.get(key).filter(item => item.identity === identity && item.abi === abi);
    if (!matching.length) return;
    for (const [sourcePath, info] of Object.entries(metadata.sources)) {
      let actualHash;
      if (inputSources) {
        const source = inputSources[sourcePath];
        if (!source || typeof source.content !== 'string') return;
        actualHash = keccak256(new Uint8Array(Buffer.from(source.content)));
      } else {
        if (path.isAbsolute(sourcePath) || sourcePath.split(/[\\/]/).includes('..')) return;
        const localPath = path.join(sourceRoot, sourcePath);
        if (!sourceHashCache.has(localPath)) {
          try { sourceHashCache.set(localPath, keccak256(new Uint8Array(await readFile(localPath)))); }
          catch (error) { if (error.code === 'ENOENT') return; throw error; }
        }
        actualHash = sourceHashCache.get(localPath);
      }
      if (actualHash !== info.keccak256) return;
    }
    const proof = {
      immutableReferences: flattened(runtime.immutableReferences),
      linkReferences: flattened(runtime.linkReferences),
      methodIdentifiers: evm.methodIdentifiers ?? {},
      compilerEvidence: {
        artifactPath,
        artifactSha256,
        compilerVersion: metadata.compiler.version,
        metadataSha256: sha256(stable(metadata)),
        sourceInputIdentitySha256: identity,
        kind: inputSources ? 'solc-build-info' : 'verified-foundry-artifact',
        deploymentCommit: commit,
        deploymentPaths: matching.map(item => item.path).sort(),
        hashEncoding: 'sha256-utf8-lowercase-0x-prefixed-runtime-hex',
        verification: 'Exact runtime bytes, ABI, compiler version/settings, and every source hash match deployment metadata; compiler source hashes are verified against input bytes.',
      },
    };
    if (buildContractPath) proof.compilerEvidence.buildContractPath = buildContractPath;
    const alternatives = proofs[key] ?? [];
    const previous = alternatives.find(item => item.compilerEvidence.sourceInputIdentitySha256 === identity);
    if (previous) {
      if (stable(previous.immutableReferences) !== stable(proof.immutableReferences) || stable(previous.linkReferences) !== stable(proof.linkReferences)) {
        throw new Error(`Conflicting compiler reference offsets for runtime ${key}`);
      }
      proof.compilerEvidence.deploymentPaths = [...new Set([...previous.compilerEvidence.deploymentPaths, ...proof.compilerEvidence.deploymentPaths])].sort();
      if (!inputSources) {
        previous.compilerEvidence.deploymentPaths = proof.compilerEvidence.deploymentPaths;
        return;
      }
    }
    const index = alternatives.indexOf(previous);
    if (index >= 0) alternatives[index] = proof;
    else alternatives.push(proof);
    proofs[key] = alternatives;
  };
  for (const repoName of [...new Set(repoNames)].sort()) {
    if (!/^[A-Za-z0-9._-]+$/.test(repoName) || repoName === 'extensions') throw new Error(`Invalid repository name: ${repoName}`);
    const sourceRoot = path.join(root, repoName);
    let folders;
    try { folders = await readdir(path.join(sourceRoot, 'out'), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const folder of folders.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!folder.isDirectory() || folder.name === 'build-info') continue;
      for (const fileName of (await readdir(path.join(sourceRoot, 'out', folder.name))).filter(name => name.endsWith('.json')).sort()) {
        const artifactPath = `${repoName}/out/${folder.name}/${fileName}`;
        const raw = await readFile(path.join(root, artifactPath));
        await consider({ artifact: JSON.parse(raw.toString('utf8')), artifactPath, artifactSha256: sha256(raw), sourceRoot });
      }
    }
    onProgress(`${repoName}: ${Object.keys(proofs).length} proven runtime templates`);
  }
  const buildInfoRoot = path.join(deploymentRoot, 'out', 'build-info');
  let buildInfos;
  try { buildInfos = (await readdir(buildInfoRoot)).filter(name => name.endsWith('.json')).sort(); }
  catch (error) { if (error.code === 'ENOENT') buildInfos = []; else throw error; }
  for (const fileName of buildInfos) {
    const localPath = path.join(buildInfoRoot, fileName);
    // Foundry's tiny build-info records have source indexes but no compiler outputs.
    if ((await stat(localPath)).size < 1_000_000) continue;
    const raw = await readFile(localPath);
    const artifactSha256 = sha256(raw);
    const info = JSON.parse(raw.toString('utf8'));
    if (!info.input?.sources || !info.output?.contracts) continue;
    const artifactPath = `${relativeDeploymentRoot}/out/build-info/${fileName}`;
    for (const [sourcePath, contracts] of Object.entries(info.output.contracts)) {
      for (const [name, artifact] of Object.entries(contracts)) {
        await consider({ artifact, artifactPath, artifactSha256, inputSources: info.input.sources, buildContractPath: `${sourcePath}:${name}` });
      }
    }
    onProgress(`${fileName}: ${Object.keys(proofs).length} proven runtime templates`);
  }
  const result = Object.fromEntries(Object.entries(proofs).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, alternatives]) => [key, alternatives.sort((a, b) =>
      a.compilerEvidence.sourceInputIdentitySha256.localeCompare(b.compilerEvidence.sourceInputIdentitySha256))]));
  if (stable(result).includes(root) || stable(result).includes('/Users/')) throw new Error('Absolute local path found in compiler evidence');
  return result;
}
