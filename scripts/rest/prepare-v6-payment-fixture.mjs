#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const version = "center-v6-payment-fixture-v1";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const hash = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const check = (value, reason) => { if (!value) throw new Error(`V6_FIXTURE_INVALID: ${reason}`); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const licenses = new Set(["LICENSE", "node_modules/@bananapus/permission-ids-v6/LICENSE", "node_modules/@openzeppelin/contracts/LICENSE", "node_modules/@prb/math/LICENSE.md", "node_modules/@uniswap/permit2/LICENSE"]);
function safePath(path) {
  check(typeof path === "string" && path.length <= 512 && !isAbsolute(path) && path === posix.normalize(path) &&
    path.split("/").every(part => /^[A-Za-z0-9@_+.-]+$/.test(part) && part !== "." && part !== ".."), "unsafe fixture path");
}
async function readRegular(path, maximum) {
  const stat = await lstat(path);
  check(stat.isFile() && stat.size > 0 && stat.size <= maximum, "file type or size");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    check(current.isFile() && current.size === stat.size && current.size <= maximum, "file changed during read");
    // A fixed buffer plus one EOF probe bounds allocation even if another local
    // process grows the file after fstat. Never let readFile allocate its new size.
    const buffer = Buffer.allocUnsafe(current.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    check(length === current.size, "file changed during read");
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}

/** Offline test dependency preparation only. CLI always uses the committed
 * bundle and manifest; alternate paths exist solely for integrity regression tests.
 * Verify every bounded byte and path before creating a fresh private directory.
 */
export async function prepareV6PaymentFixture(destination, options = {}) {
  check(typeof destination === "string" && isAbsolute(destination) && resolve(destination) === destination, "absolute normalized output required");
  const parent = dirname(destination);
  check(await realpath(parent) === parent, "symlinked output parent");
  try { await lstat(destination); throw new Error("V6_FIXTURE_INVALID: output already exists"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const manifestBytes = await readRegular(options.manifestPath ?? new URL("../../test/fixtures/v6-payment/pinned-manifest.json", import.meta.url), 131_072);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  check(object(manifest) && manifest.version === "center-v6-payment-fixture-manifest-v1" && object(manifest.source) &&
    manifest.source.repository === "https://github.com/Bananapus/nana-core-v6" &&
    manifest.source.commit === "feff600654aee6fb1747dded692f18068b2230a6" && manifest.source.compiler === "0.8.28+commit.7893614a", "source identity");
  const bundle = manifest.bundle;
  check(object(bundle) && bundle.file === "pinned.json.gz" && bundle.compression === "gzip" && hash(bundle.sha256) && hash(bundle.uncompressedSha256) &&
    Number.isSafeInteger(bundle.byteLength) && bundle.byteLength > 0 && bundle.byteLength <= 1_048_576 &&
    Number.isSafeInteger(bundle.uncompressedByteLength) && bundle.uncompressedByteLength > 0 && bundle.uncompressedByteLength <= 8_388_608, "bundle bounds");
  check(object(manifest.counts) && manifest.counts.files === 156 && manifest.counts.artifacts === 16 && manifest.counts.compilerSources === 135 && manifest.counts.licenses === 5 &&
    Array.isArray(manifest.files) && manifest.files.length === 156, "file counts");
  const compressed = await readRegular(options.bundlePath ?? new URL("../../test/fixtures/v6-payment/pinned.json.gz", import.meta.url), 1_048_576);
  check(compressed.length === bundle.byteLength && sha256(compressed) === bundle.sha256, "compressed integrity");
  const uncompressed = gunzipSync(compressed, { maxOutputLength: bundle.uncompressedByteLength });
  check(uncompressed.length === bundle.uncompressedByteLength && sha256(uncompressed) === bundle.uncompressedSha256, "uncompressed integrity");
  const payload = JSON.parse(uncompressed.toString("utf8"));
  check(object(payload) && payload.version === version && Object.keys(payload).length === 2 && object(payload.files), "payload shape");
  const paths = Object.keys(payload.files), expected = manifest.files.map(file => file?.path);
  check(paths.length === 156 && paths.every((path, index) => path === expected[index]) && new Set(paths).size === paths.length &&
    paths.every((path, index) => index === 0 || paths[index - 1] < path), "ordered exact inventory");
  const pathSet = new Set(paths), kinds = { artifact: 0, "compiler-source": 0, license: 0 }, files = [];
  for (const file of manifest.files) {
    check(object(file), "file record"); safePath(file.path);
    check(Object.hasOwn(kinds, file.kind) && hash(file.sha256) && Number.isSafeInteger(file.byteLength) && file.byteLength > 0 && file.byteLength <= 1_048_576, "file record bounds");
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) check(!pathSet.has(parts.slice(0, i).join("/")), "file/directory collision");
    const text = payload.files[file.path];
    check(typeof text === "string" && text.length <= 1_048_576, "file text bounds");
    const bytes = Buffer.from(text, "utf8");
    check(bytes.length === file.byteLength && sha256(bytes) === file.sha256, "file integrity");
    if (file.kind === "artifact") {
      check(typeof file.contractName === "string" && /^[A-Za-z0-9_]+$/.test(file.contractName) &&
        file.path === `out/${file.contractName}.sol/${file.contractName}.json`, "artifact path");
    } else if (file.kind === "compiler-source") {
      check(/^(?:src|test|node_modules|lib)\/.+\.sol$/.test(file.path) && /^0x[0-9a-f]{64}$/.test(file.keccak256) && file.spdxLicense === "MIT" &&
        text.match(/SPDX-License-Identifier:\s*([^\r\n]+)/)?.[1]?.trim() === "MIT", "compiler source identity");
    } else {
      check(licenses.has(file.path) && file.spdxLicense === "MIT" && text.includes("Permission is hereby granted, free of charge"), "license notice");
    }
    kinds[file.kind]++; files.push({ path: file.path, bytes });
  }
  check(kinds.artifact === 16 && kinds["compiler-source"] === 135 && kinds.license === 5, "typed file counts");
  // The committed manifest pins original full artifact SHA256s and source bytes.
  // The normal gate subsequently verifies them independently against the catalog
  // and Solidity compiler metadata using loadV6PaymentArtifacts(), unchanged.
  let created = false;
  try {
    await mkdir(destination, { mode: 0o700 }); created = true;
    for (const file of files) {
      const parts = file.path.split("/"); let current = destination;
      for (const part of parts.slice(0, -1)) {
        current = join(current, part);
        try { await mkdir(current, { mode: 0o700 }); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
        check((await lstat(current)).isDirectory() && await realpath(current) === current, "symlinked extraction directory");
      }
      const handle = await open(join(destination, file.path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o444);
      try { await handle.writeFile(file.bytes); } finally { await handle.close(); }
    }
    return { version: "center-v6-payment-fixture-prepared-v1", files: 156, artifacts: 16, compilerSources: 135, bundleSha256: bundle.sha256, root: destination };
  } catch (error) {
    if (created) await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--output") throw new Error("arguments");
    console.log(JSON.stringify(await prepareV6PaymentFixture(process.argv[3])));
  } catch {
    process.stderr.write("V6 payment fixture preparation failed: verify the pinned bundle and use a new absolute output directory.\n");
    process.exitCode = 1;
  }
}
