import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  absWorkingDir: fileURLToPath(new URL("../../", import.meta.url)),
  entryPoints: ["src/rest/web/main.ts"],
  outfile: ".generated/rest/accounts.js",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: ["es2022"],
  minify: true,
  sourcemap: false,
  legalComments: "eof",
});
