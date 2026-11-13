import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const { runStep } = await import(new URL("../scripts/rest/check-required-tests.mjs", import.meta.url).href);
const root = fileURLToPath(new URL("..", import.meta.url));

it("rebuilds only current runtime files and all assets needed by a fresh dev start", async () => {
  const directory = await mkdtemp(join(tmpdir(), "center-build-"));
  try {
    // Share read-only inputs; every compiler, bundler and package output stays in this fixture.
    for (const name of ["src", "docs", "node_modules"]) await symlink(join(root, name), join(directory, name));
    for (const name of ["mcp", "scripts/rest", "test", "dist/src/db/migrations", ".generated/rest", ".generated/checks"])
      await mkdir(join(directory, name), { recursive: true });
    for (const name of ["src", "node_modules"]) await symlink(join(root, "mcp", name), join(directory, "mcp", name));
    for (const name of ["package.json", "tsconfig.json", "tsconfig.build.json", "mcp/package.json", "mcp/tsconfig.json", "mcp/tsconfig.build.json",
      "scripts/rest/clean-build.mjs", "scripts/rest/build-web.mjs", "scripts/rest/copy-assets.mjs"])
      await copyFile(join(root, name), join(directory, name));
    await writeFile(join(directory, "test/build-only.test.ts"), "export const testOnly = true;\n");
    await writeFile(join(directory, "dist/src/removed.js"), "throw new Error('obsolete');\n");
    await writeFile(join(directory, "dist/src/db/migrations/999_removed.sql"), "SELECT 'obsolete';\n");
    await writeFile(join(directory, ".generated/rest/removed-client.tgz"), "obsolete");
    await writeFile(join(directory, ".generated/checks/retained.json"), "{}");

    // A measured production build takes 80 seconds alongside the consumer checks.
    // Reuse release process-group cleanup and streamed diagnostics with a finite budget.
    await runStep("fresh-build", "npm", ["run", "build"], {
      directory, cwd: directory, observation: { steps: [] }, env: process.env,
      save: async () => {}, timeoutMs: 180_000,
    });

    for (const name of ["dist/src/removed.js", "dist/src/db/migrations/999_removed.sql", ".generated/rest/removed-client.tgz",
      "dist/.generated/rest/removed-client.tgz", "dist/test", "dist/scripts"])
      await expect(stat(join(directory, name)), name).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(directory, ".generated/checks/retained.json"), "utf8")).toBe("{}");
    expect((await readdir(join(directory, "dist/src/db/migrations"))).sort())
      .toEqual((await readdir(join(root, "src/db/migrations"))).sort());
    expect((await stat(join(directory, "mcp/dist/host.js"))).isFile()).toBe(true);
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as { scripts: { dev: string } };
    expect(manifest.scripts.dev).toMatch(/^npm run build && /);

    // Load the real emitted asset reader and public package; no server or upstream is started.
    const smoke = await execute(process.execPath, ["--input-type=module", "--eval", `
      import assert from 'node:assert/strict';
      import { readRestAssets } from './dist/src/rest/site.js';
      const assets = await readRestAssets();
      for (const key of ['docsScript'])
        assert(assets[key].length > 0, key);
      assert(assets.documents.size > 0);
      assert(!('accountsScript' in assets));
      assert(!('clientPackage' in assets));
      // The homepage links its stylesheet by the hash of the emitted bytes.
      const { HOMEPAGE_HTML, HOMEPAGE_CSS } = await import('./dist/src/homepage.js');
      const { hashedAssetName } = await import('./dist/src/rest/web/assets.js');
      assert(HOMEPAGE_HTML.includes('/assets/' + hashedAssetName('directory.css', HOMEPAGE_CSS)));
      console.log('assets and client ready');
    `], { cwd: directory, timeout: 15_000, maxBuffer: 1024 * 1024 });
    expect(smoke.stdout.trim()).toBe("assets and client ready");
    expect(await readdir(join(directory, ".generated/rest"))).toEqual(["docs.js"]);
    for (const name of ["dist/src/rest/auth", "dist/src/rest/wallet", "dist/src/rest/sessions", "dist/client"])
      await expect(stat(join(directory, name)), name).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 210_000);
