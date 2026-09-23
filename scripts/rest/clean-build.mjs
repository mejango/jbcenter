import { rm } from "node:fs/promises";

// Rebuild derived outputs so removed modules, migrations and assets cannot survive.
await Promise.all(["dist", ".generated/rest"].map(path =>
  rm(new URL(`../../${path}`, import.meta.url), { recursive: true, force: true })));
