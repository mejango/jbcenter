import { build } from "esbuild";
import { fileURLToPath } from "node:url";

/** The browser bundles Center serves. */
export const webBuildOptions = {
  absWorkingDir: fileURLToPath(new URL("../../", import.meta.url)),
  entryPoints: { docs: "src/rest/docs/main.ts" },
  outdir: ".generated/rest",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: ["es2022"],
  minify: true,
  sourcemap: false,
  legalComments: "eof",
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await build(webBuildOptions);
