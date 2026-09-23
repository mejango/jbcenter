import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  absWorkingDir: fileURLToPath(new URL("../../", import.meta.url)),
  entryPoints: {
    "wallet-recovery": "src/rest/web/walletRecoveryJourney.ts",
    "wallet-device": "src/rest/web/walletDevice.ts",
    "wallet-signup": "src/rest/web/walletSignup.ts",
    "wallet-payment": "src/rest/web/walletPayment.ts",
    wallet: "src/rest/web/wallet.ts",
    accounts: "src/rest/web/main.ts",
    docs: "src/rest/docs/main.ts",
    para: "src/rest/web/para.ts",
  },
  outdir: ".generated/rest",
  bundle: true,
  external: ["./para.js"],
  platform: "browser",
  format: "esm",
  target: ["es2022"],
  minify: true,
  sourcemap: false,
  legalComments: "eof",
});
