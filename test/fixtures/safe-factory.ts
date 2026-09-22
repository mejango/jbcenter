import { readFileSync } from "node:fs";
import type { Hex } from "viem";

/** The runtime of the canonical Safe 1.4.1 proxy factory, read from Base with
 * `cast code 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67`. */
export const SAFE_FACTORY_RUNTIME = (
  JSON.parse(
    readFileSync(new URL("./safe-factory-runtime.json", import.meta.url), "utf8"),
  ) as { runtime: Hex }
).runtime;
