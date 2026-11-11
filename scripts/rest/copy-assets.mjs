import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { minifyScript } from "./build-web.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
for (const [from, to] of [
  ["src/db/migrations", "dist/src/db/migrations"],
  ["src/rest/contracts/data", "dist/src/rest/contracts/data"],
  [".generated/rest", "dist/.generated/rest"],
  ["docs/rest", "dist/docs/rest"],
]) {
  await mkdir(join(root, to), { recursive: true });
  await cp(join(root, from), join(root, to), { recursive: true });
}

// The homepage script is a hand-written string; ship it minified.
const directoryClient = join(root, "dist/src/directoryClient.js");
const { HOMEPAGE_JS } = await import(directoryClient);
await writeFile(directoryClient, `/** Minified at build time from src/directoryClient.ts. */\nexport const HOMEPAGE_JS = ${JSON.stringify(minifyScript(HOMEPAGE_JS))};\n`);
