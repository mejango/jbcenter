// SPDX-License-Identifier: MIT
// Explicit offline fixture generation only; runtime never downloads or rebuilds these contracts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, posix, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { keccak256, toHex, type Hex } from "viem";
import { getContractCatalog } from "../../src/rest/contracts/catalog.js";
import { loadV6PaymentArtifacts } from "../../test/fixtures/v6-payment/contracts.js";

const root = process.env.CENTER_V6_SOURCE_ROOT;
assert(root, "Set CENTER_V6_SOURCE_ROOT to the reviewed nana-core-v6 checkout");
const loaded = await loadV6PaymentArtifacts(); // Mandatory existing full artifact and compiler-input verification.
const catalog = await getContractCatalog();
const commit = "feff600654aee6fb1747dded692f18068b2230a6";
const compiler = "0.8.28+commit.7893614a";
const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
type FileRecord = {
  path: string; kind: "artifact" | "compiler-source" | "license"; sha256: string; byteLength: number;
  contractName?: string; catalogContractId?: string; keccak256?: Hex; spdxLicense?: "MIT";
};
const records = new Map<string, FileRecord>();
const contents = new Map<string, string>();

function capture(path: string, kind: FileRecord["kind"], sourceBytes?: Buffer) {
  assert(!isAbsolute(path) && path === posix.normalize(path) && !path.includes("\\") &&
    path.split("/").every(part => part !== ".." && part !== "." && part.length > 0) && !/[\u0000-\u001f]/.test(path), "Unsafe fixture path");
  assert(!records.has(path), `Duplicate fixture path: ${path}`);
  const bytes = sourceBytes ?? readFileSync(resolve(root!, path));
  const text = bytes.toString("utf8");
  assert(Buffer.from(text, "utf8").equals(bytes), `Fixture file is not exact UTF8: ${path}`);
  const record: FileRecord = { path, kind, sha256: sha256(bytes), byteLength: bytes.length };
  records.set(path, record); contents.set(path, text);
  return { bytes, text, record };
}

const expectedSources = new Map<string, Hex>();
function addArtifact(name: string, path: string, expectedHash: string, catalogContractId?: string) {
  const captured = capture(path, "artifact");
  assert.equal(captured.record.sha256, expectedHash, `Original artifact bytes changed: ${path}`);
  captured.record.contractName = name;
  if (catalogContractId) captured.record.catalogContractId = catalogContractId;
  // Parse only for validation and source inventory. The bundle retains captured.text unchanged.
  const artifact = JSON.parse(captured.text) as {
    metadata: { compiler: { version: string }; sources: Record<string, { keccak256: Hex; license: string }> } };
  assert.equal(artifact.metadata.compiler.version, compiler);
  for (const [source, evidence] of Object.entries(artifact.metadata.sources)) {
    assert.equal(evidence.license, "MIT", `Unreviewed compiler-source license: ${source}`);
    assert(!expectedSources.has(source) || expectedSources.get(source) === evidence.keccak256, `Conflicting source input: ${source}`);
    expectedSources.set(source, evidence.keccak256);
  }
}
for (const name of loaded.contracts.keys()) {
  const contract = catalog.data.contracts.find(value => value.name === name && ["contract", "library"].includes(value.category))!;
  const provenance = contract.variants.flatMap(value => value.provenance).find(value => value.kind === "clean-source-build")!;
  assert.equal(provenance.commit, commit);
  assert(provenance.artifactPath.startsWith("nana-core-v6/"));
  addArtifact(name, provenance.artifactPath.slice("nana-core-v6/".length), provenance.artifactSha256, contract.id);
}
addArtifact("MockERC20", "out/MockERC20.sol/MockERC20.json", "17243795fc862e6583c649c0c92a206fb5322ee327d0d3ea776f1e3e0dd39130");
assert.equal(loaded.contracts.size, 15);
assert.equal(expectedSources.size, 135);
for (const [path, expectedHash] of expectedSources) {
  const captured = capture(path, "compiler-source");
  const actualHash = keccak256(toHex(captured.bytes));
  assert.equal(actualHash, expectedHash, `Captured compiler input changed: ${path}`);
  assert.equal(captured.text.match(/SPDX-License-Identifier:\s*([^\r\n]+)/)?.[1]?.trim(), "MIT", `Unexpected source SPDX: ${path}`);
  captured.record.keccak256 = actualHash; captured.record.spdxLicense = "MIT";
}
for (const path of ["LICENSE", "node_modules/@bananapus/permission-ids-v6/LICENSE", "node_modules/@prb/math/LICENSE.md", "node_modules/@uniswap/permit2/LICENSE"]) {
  const captured = capture(path, "license");
  assert(captured.text.includes("Permission is hereby granted, free of charge"), `Expected MIT notice missing: ${path}`);
  captured.record.spdxLicense = "MIT";
}
// The published OpenZeppelin npm package omits LICENSE. Preserve the separately reviewed
// official v5.6.1 notice instead of depending on a nonexistent file in that installation.
const noticeDirectory = new URL("../../test/fixtures/v6-payment/licenses/", import.meta.url);
const noticeProvenance = JSON.parse(readFileSync(new URL("openzeppelin-contracts-5.6.1-provenance.json", noticeDirectory), "utf8"));
assert.equal(noticeProvenance.commit, "5fd1781b1454fd1ef8e722282f86f9293cacf256");
assert.equal(noticeProvenance.sha256, "20aebc68b11c063133aa2af0ef4bb29875477c6d16d715718f0daec563938b84");
assert.equal(noticeProvenance.byteLength, 1090);
const notice = capture("node_modules/@openzeppelin/contracts/LICENSE", "license",
  readFileSync(new URL("openzeppelin-contracts-5.6.1-MIT.txt", noticeDirectory)));
assert.equal(notice.record.sha256, noticeProvenance.sha256);
assert.equal(notice.record.byteLength, noticeProvenance.byteLength);
assert(notice.text.includes("Permission is hereby granted, free of charge"));
notice.record.spdxLicense = "MIT";
assert.equal(records.size, 156);
const paths = [...records.keys()].sort();
const files = Object.fromEntries(paths.map(path => [path, contents.get(path)!]));
const uncompressed = Buffer.from(JSON.stringify({ version: "center-v6-payment-fixture-v1", files }), "utf8");
const compressed = gzipSync(uncompressed, { level: 9 });
// Explicit reproducible gzip header: no wall clock or platform identifier in the artifact.
compressed.writeUInt32LE(0, 4); compressed[9] = 255;
const manifest = {
  version: "center-v6-payment-fixture-manifest-v1",
  source: { repository: "https://github.com/Bananapus/nana-core-v6", commit, compiler },
  scope: "Offline local V6 payment execution with an unchanged six-decimal MockERC20 fixture. No Circle USDC, Base deployment, live provider, or physical-device evidence.",
  bundle: { file: "pinned.json.gz", compression: "gzip", sha256: sha256(compressed), byteLength: compressed.length,
    uncompressedSha256: sha256(uncompressed), uncompressedByteLength: uncompressed.length },
  counts: { artifacts: 16, compilerSources: 135, licenses: 5, files: 156 },
  files: paths.map(path => records.get(path)!),
};
writeFileSync(new URL("../../test/fixtures/v6-payment/pinned.json.gz", import.meta.url), compressed);
writeFileSync(new URL("../../test/fixtures/v6-payment/pinned-manifest.json", import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ files: manifest.counts, bundle: manifest.bundle }));
