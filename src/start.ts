import { chown, mkdir } from "node:fs/promises";
import { isAbsolute } from "node:path";

// Railway mounts persistent volumes as root. Initialize only the cache directory,
// then drop privileges before loading any application code or credentials.
if (process.getuid?.() === 0) {
  const directory = process.env.IPFS_CACHE_DIR;
  if (directory) {
    if (!isAbsolute(directory) || directory === "/") throw new Error("IPFS_CACHE_DIR must be an absolute cache directory");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chown(directory, 1000, 1000);
  }
  process.setgroups!([]);
  process.setgid!(1000);
  process.setuid!(1000);
}

await import("./index.js");
