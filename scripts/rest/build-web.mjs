import { build, transformSync } from "esbuild";
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

/** Minifies a hand-written browser script served from a string (the homepage's directory.js). */
export const minifyScript = code => transformSync(code, { loader: "js", minify: true, target: "es2022" }).code;

if (process.argv[1] === fileURLToPath(import.meta.url)) await build(webBuildOptions);
