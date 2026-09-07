import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

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
