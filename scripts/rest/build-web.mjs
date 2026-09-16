import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  absWorkingDir: fileURLToPath(new URL("../../", import.meta.url)),
  entryPoints: ["src/rest/web/walletRecoveryJourney.ts"], outfile: ".generated/rest/wallet-recovery.js",
  bundle: true, platform: "browser", format: "esm", target: ["es2022"], minify: true,
  sourcemap: false, legalComments: "eof",
});

await build({
  absWorkingDir: fileURLToPath(new URL("../../", import.meta.url)),
  entryPoints: ["src/rest/web/walletDevice.ts"], outfile: ".generated/rest/wallet-device.js",
  bundle: true, platform: "browser", format: "esm", target: ["es2022"], minify: true,
  sourcemap: false, legalComments: "eof",
});

await build({
  absWorkingDir: fileURLToPath(new URL("../../", import.meta.url)),
  entryPoints: ["src/rest/web/walletSignup.ts"], outfile: ".generated/rest/wallet-signup.js",
  bundle: true, platform: "browser", format: "esm", target: ["es2022"], minify: true,
  sourcemap: false, legalComments: "eof",
});

await build({
  absWorkingDir: fileURLToPath(new URL("../../", import.meta.url)),
  entryPoints: ["src/rest/web/walletPayment.ts"], outfile: ".generated/rest/wallet-payment.js",
  bundle: true, platform: "browser", format: "esm", target: ["es2022"], minify: true,
  sourcemap: false, legalComments: "eof",
});

await build({
  absWorkingDir: fileURLToPath(new URL("../../", import.meta.url)),
  entryPoints: ["src/rest/web/wallet.ts"], outfile: ".generated/rest/wallet.js",
  bundle: true, platform: "browser", format: "esm", target: ["es2022"], minify: true,
  sourcemap: false, legalComments: "eof",
});

await build({
  absWorkingDir: fileURLToPath(new URL("../../", import.meta.url)),
  entryPoints: ["src/rest/web/main.ts"],
  outfile: ".generated/rest/accounts.js",
  bundle: true,
  external: ["./para.js"],
  platform: "browser",
  format: "esm",
  target: ["es2022"],
  minify: true,
  sourcemap: false,
  legalComments: "eof",
});

await build({
  absWorkingDir: fileURLToPath(new URL("../../", import.meta.url)),
  entryPoints: ["src/rest/docs/main.ts"], outfile: ".generated/rest/docs.js",
  bundle: true, platform: "browser", format: "esm", target: ["es2022"], minify: true,
});

await build({
  absWorkingDir: fileURLToPath(new URL("../../", import.meta.url)),
  entryPoints: ["src/rest/web/para.ts"], outfile: ".generated/rest/para.js",
  bundle: true, platform: "browser", format: "esm", target: ["es2022"], minify: true,
  sourcemap: false, legalComments: "eof",
});
