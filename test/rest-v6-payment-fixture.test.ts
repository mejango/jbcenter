import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { loadV6PaymentArtifacts } from "./fixtures/v6-payment/contracts.js";
// @ts-expect-error The release preparation entrypoint intentionally uses plain Node ESM.
import { prepareV6PaymentFixture } from "../scripts/rest/prepare-v6-payment-fixture.mjs";
const roots: string[] = [];
async function directory() { const path = await realpath(await mkdtemp(join(tmpdir(), "center-v6-fixture-test-"))); roots.push(path); return path; }
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const bundleUrl = new URL("./fixtures/v6-payment/pinned.json.gz", import.meta.url);
const manifestUrl = new URL("./fixtures/v6-payment/pinned-manifest.json", import.meta.url);
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type TestManifest = { bundle: { sha256: string; byteLength: number; uncompressedSha256: string; uncompressedByteLength: number };
  files: { path: string; kind: string; sha256: string; byteLength: number }[] };
async function altered(change: (payload: { version: string; files: Record<string, string> }, manifest: TestManifest) => void) {
  const parent = await directory(), manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as TestManifest;
  const payload = JSON.parse(gunzipSync(await readFile(bundleUrl)).toString("utf8"));
  change(payload, manifest);
  payload.files = Object.fromEntries(Object.entries(payload.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  manifest.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const uncompressed = Buffer.from(JSON.stringify(payload)), compressed = gzipSync(uncompressed, { level: 9 });
  manifest.bundle = { ...manifest.bundle, sha256: sha256(compressed), byteLength: compressed.length,
    uncompressedSha256: sha256(uncompressed), uncompressedByteLength: uncompressed.length };
  const bundlePath = join(parent, "bundle.gz"), manifestPath = join(parent, "manifest.json"), destination = join(parent, "extracted");
  await writeFile(bundlePath, compressed); await writeFile(manifestPath, JSON.stringify(manifest));
  return { parent, destination, bundlePath, manifestPath, manifest };
}
function rename(payload: { files: Record<string, string> }, manifest: TestManifest, original: string, replacement: string) {
  payload.files[replacement] = payload.files[original]!; delete payload.files[original];
  manifest.files.find(file => file.path === original)!.path = replacement;
}

describe("portable pinned V6 payment fixture", () => {
  it("extracts the complete exact reviewed artifact and compiler-source closure", async () => {
    const destination = join(await directory(), "extracted");
    expect(await prepareV6PaymentFixture(destination)).toMatchObject({ version: "center-v6-payment-fixture-prepared-v1", files: 156, artifacts: 16, compilerSources: 135 });
    expect(JSON.parse(await readFile(join(destination, "out/JBMultiTerminal.sol/JBMultiTerminal.json"), "utf8")).metadata.compiler.version).toBe("0.8.28+commit.7893614a");
    const previous = process.env.CENTER_V6_SOURCE_ROOT;
    try { process.env.CENTER_V6_SOURCE_ROOT = destination; const verified = await loadV6PaymentArtifacts(); expect(verified.contracts.size).toBe(15); expect(verified.verifiedSourceCount).toBe(135); }
    finally { if (previous === undefined) delete process.env.CENTER_V6_SOURCE_ROOT; else process.env.CENTER_V6_SOURCE_ROOT = previous; }
  });
  it("rejects changed compressed bytes before creating any output", async () => {
    const fixture = await altered(() => {}), bytes = await readFile(fixture.bundlePath); bytes[20] = bytes[20]! ^ 1;
    await writeFile(fixture.bundlePath, bytes);
    await expect(prepareV6PaymentFixture(fixture.destination, fixture)).rejects.toThrow("compressed integrity");
    await expect(access(fixture.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects a changed file despite matching gzip-level integrity", async () => {
    const fixture = await altered(payload => { payload.files["LICENSE"] += " altered"; });
    await expect(prepareV6PaymentFixture(fixture.destination, fixture)).rejects.toThrow("file integrity");
    await expect(access(fixture.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects an expanded payload beyond the pinned decompression length", async () => {
    const fixture = await altered(() => {}); fixture.manifest.bundle.uncompressedByteLength--;
    await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest));
    await expect(prepareV6PaymentFixture(fixture.destination, fixture)).rejects.toThrow();
    await expect(access(fixture.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects manifest decompression bounds above the fixed ceiling", async () => {
    const fixture = await altered(() => {}); fixture.manifest.bundle.uncompressedByteLength = 8_388_609;
    await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest));
    await expect(prepareV6PaymentFixture(fixture.destination, fixture)).rejects.toThrow("bundle bounds");
  });
  it.each(["../escape", "/escape", "out\\escape", "C:escape", "src//escape.sol", "src/./escape.sol", "src/../escape.sol"])("rejects nonportable or escaping path %s before extraction", async path => {
    const fixture = await altered((payload, manifest) => rename(payload, manifest, "LICENSE", path));
    await expect(prepareV6PaymentFixture(fixture.destination, fixture)).rejects.toThrow("unsafe fixture path");
    await expect(access(fixture.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects a file-directory collision across otherwise safe source paths", async () => {
    const fixture = await altered((payload, manifest) => {
      const [a, b] = manifest.files.filter(file => file.kind === "compiler-source").map(file => file.path);
      rename(payload, manifest, a!, "node_modules/collision.sol"); rename(payload, manifest, b!, "node_modules/collision.sol/child.sol");
    });
    await expect(prepareV6PaymentFixture(fixture.destination, fixture)).rejects.toThrow("file/directory collision");
    await expect(access(fixture.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects incomplete and surplus inventories", async () => {
    for (const extra of [false, true]) {
      const fixture = await altered(payload => { if (extra) payload.files.extra = "extra"; else delete payload.files.LICENSE; });
      await expect(prepareV6PaymentFixture(fixture.destination, fixture)).rejects.toThrow("ordered exact inventory");
    }
  });
  it("preserves an existing output and does not follow an output symlink", async () => {
    const parent = await directory(), outside = join(parent, "outside"), destination = join(parent, "output");
    await mkdir(outside); await writeFile(join(outside, "sentinel"), "preserved");
    await expect(prepareV6PaymentFixture(outside)).rejects.toThrow("output already exists");
    await symlink(outside, destination, "dir");
    await expect(prepareV6PaymentFixture(destination)).rejects.toThrow("output already exists");
    expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("preserved");
  });
  it("does not follow a symlinked output parent or bundle", async () => {
    const parent = await directory(), directoryLink = join(parent, "linked"); await symlink(parent, directoryLink, "dir");
    await expect(prepareV6PaymentFixture(join(directoryLink, "output"))).rejects.toThrow("symlinked output parent");
    const linkedBundle = join(parent, "bundle.gz"); await symlink(bundleUrl, linkedBundle, "file");
    await expect(prepareV6PaymentFixture(join(parent, "output"), { bundlePath: linkedBundle })).rejects.toThrow("file type or size");
  });
  it("admits one concurrent extraction without deleting the winning fixture", async () => {
    const destination = join(await directory(), "output");
    const results = await Promise.allSettled([prepareV6PaymentFixture(destination), prepareV6PaymentFixture(destination)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(await readFile(join(destination, "LICENSE"), "utf8")).toContain("Permission is hereby granted");
  });
});
