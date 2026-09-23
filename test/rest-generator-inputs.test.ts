import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { keccak256, stringToHex } from "viem";
import { afterEach, describe, expect, it } from "vitest";

const temporary: string[] = [];
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), "center-generator-inputs-"));
  temporary.push(path);
  return path;
};
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
const factory = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
const anchorHash = `0x${"12".repeat(32)}`;
const sealer = new URL("../scripts/rest/seal-factory-history.mjs", import.meta.url);

function seal(finalized: unknown) {
  const root = directory(), metadata = join(root, "metadata.json"), pages = join(root, "pages.jsonl"), output = join(root, "sealed");
  writeFileSync(metadata, JSON.stringify({ chainId: 8453, factory,
    topic: keccak256(stringToHex("ProxyCreation(address,address)")), through: 999, hash: anchorHash }));
  writeFileSync(pages, [{ from: 0, logs: [] }, { from: 500, logs: [] }].map(page => JSON.stringify(page)).join("\n"));
  const source = `
    import assert from 'node:assert/strict';
    globalThis.fetch = async (_url, options) => {
      const requests = JSON.parse(options.body);
      assert.deepEqual(requests, [
        { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
        { jsonrpc: '2.0', id: 2, method: 'eth_getBlockByNumber', params: ['0x3e7', false] },
        { jsonrpc: '2.0', id: 3, method: 'eth_getBlockByNumber', params: ['finalized', false] },
      ]);
      return Response.json([
        { jsonrpc: '2.0', id: 3, result: ${JSON.stringify(finalized)} },
        { jsonrpc: '2.0', id: 1, result: '0x2105' },
        { jsonrpc: '2.0', id: 2, result: { number: '0x3e7', hash: ${JSON.stringify(anchorHash)} } },
      ]);
    };
    process.argv = ${JSON.stringify([process.execPath, fileURLToPath(sealer), metadata, pages, output])};
    await import(${JSON.stringify(sealer.href)});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 65_536,
    env: { ...process.env, DWELLIR_API_KEY: "offline-test-only" },
  });
  expect(result.error).toBeUndefined();
  return { result, output };
}

describe("offline generator input boundaries", () => {
  it("stops at a missing required catalog repository before inspecting deployment artifacts or changing output", () => {
    const catalog = new URL("../src/rest/contracts/data/catalog.json", import.meta.url);
    const before = statSync(catalog);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/rest/generate-contracts.mjs", import.meta.url)),
      "--workspace", directory(), "--check"], { encoding: "utf8", timeout: 10_000, maxBuffer: 65_536 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Missing required source build configuration: banny-retail-v6/foundry.toml");
    expect(statSync(catalog).mtimeMs).toBe(before.mtimeMs);
  });

  it.each(["0x3e7", "0x3e8"])("seals a complete prefix at or below finalized block %s", number => {
    const { result, output } = seal({ number, hash: number === "0x3e7" ? anchorHash : `0x${"34".repeat(32)}` });
    expect(result.status, result.stderr).toBe(0);
    const bytes = gunzipSync(readFileSync(join(output, "base.json.gz")));
    expect(JSON.parse(bytes.toString())).toEqual({ chainId: 8453, factory, through: 999, hash: anchorHash, creations: [] });
    expect(readFileSync(join(output, "base.sha256"), "utf8").trim()).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it.each([
    null,
    { number: "0x3e6", hash: anchorHash },
    { number: "0x03e7", hash: anchorHash },
    { number: "0x3e7", hash: "0x" },
    { number: "0x3e7", hash: `0x${"34".repeat(32)}` },
  ])("refuses an unfinalized or unavailable anchor before publishing: %j", finalized => {
    const { result, output } = seal(finalized);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Factory history anchor is not finalized");
    expect(existsSync(output)).toBe(false);
  });
});
