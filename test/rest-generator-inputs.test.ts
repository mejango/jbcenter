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

});
