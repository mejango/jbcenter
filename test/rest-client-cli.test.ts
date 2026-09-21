import { afterEach, describe, expect, it } from "vitest";
import { chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
const filename = new URL("../scripts/rest/center.mjs", import.meta.url);
const cli = await import(filename.href) as {
  main: (argv: string[], output?: (value: string) => void) => Promise<void>;
  readProtectedKey: (path: string) => Promise<{ address: string }>;
};
const dirs: string[] = [];
async function folder() { const dir = await mkdtemp(join(tmpdir(), "juicebox-rest-key-test-")); dirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("CLI local key handling", () => {
  it("creates a 0600 exclusive key file, reports only public data, and refuses overwrites", async () => {
    const keyFile = join(await folder(), "bot.json"); const output: string[] = [];
    await cli.main(["keygen", "--out", keyFile], (value) => output.push(value));
    const original = await readFile(keyFile, "utf8"); const key = JSON.parse(original) as { privateKey: string; botAddress: string };
    expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
    expect(output.join("")).toContain(key.botAddress); expect(output.join("")).not.toContain(key.privateKey);
    expect(output.join("")).not.toContain("privateKey");
    expect((await cli.readProtectedKey(keyFile)).address).toBe(key.botAddress);
    await expect(cli.main(["keygen", "--out", keyFile])).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(keyFile, "utf8")).toBe(original);
    await chmod(keyFile, 0o400); expect((await cli.readProtectedKey(keyFile)).address).toBe(key.botAddress);
  });

  it("refuses world-readable, symlinked, and hard-linked private keys", async () => {
    const dir = await folder(); const keyFile = join(dir, "bot.json");
    await cli.main(["keygen", "--out", keyFile], () => undefined);
    await chmod(keyFile, 0o644); await expect(cli.readProtectedKey(keyFile)).rejects.toThrow();
    await chmod(keyFile, 0o600);
    const symbolic = join(dir, "symbolic.json"); await symlink(keyFile, symbolic);
    await expect(cli.readProtectedKey(symbolic)).rejects.toThrow();
    const hard = join(dir, "hard.json"); await link(keyFile, hard);
    await expect(cli.readProtectedKey(hard)).rejects.toThrow();
  });

  it("rejects tampered key identities and never prints secret input on errors", async () => {
    const dir = await folder(); const keyFile = join(dir, "bad.json");
    const secret = `0x${"01".padStart(64, "0")}`;
    await writeFile(keyFile, JSON.stringify({ format: "juicebox-center-bot-key-v1", privateKey: secret, botAddress: `0x${"11".repeat(20)}` }), { mode: 0o600 });
    await expect(cli.readProtectedKey(keyFile)).rejects.toThrow("does not match");
    try {
      await execute(process.execPath, [filename.pathname, "keygen", "--private-key", secret]);
      throw new Error("Expected command rejection");
    } catch (error) {
      const result = error as { stderr: string; stdout: string };
      expect(result.stderr).toContain("Command failed."); expect(result.stderr).not.toContain(secret); expect(result.stdout).toBe("");
    }
  });

  it("runs normally when the CLI entry path is a symlink", async () => {
    const dir = await folder(); const entry = join(dir, "center.mjs"); const keyFile = join(dir, "bot.json");
    await symlink(filename.pathname, entry);
    const result = await execute(process.execPath, [entry, "keygen", "--out", keyFile]);
    const key = JSON.parse(await readFile(keyFile, "utf8")) as { privateKey: string; botAddress: string };
    expect(result.stdout).toContain(key.botAddress); expect(result.stdout).not.toContain(key.privateKey); expect(result.stderr).toBe("");
  });
});
