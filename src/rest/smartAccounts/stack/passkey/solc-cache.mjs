import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

// Pinned Foundry/SVM uses the legacy home cache when present, otherwise the
// operating system data directory. SVM_HOME is not a supported cache override.
export function solcCachePaths(version, {
  home = homedir(), platform = process.platform, xdgDataHome = process.env.XDG_DATA_HOME,
} = {}) {
  const roots = [resolve(home, '.svm')];
  if (platform === 'darwin') roots.push(resolve(home, 'Library/Application Support/svm'));
  if (platform === 'linux') roots.push(resolve(
    xdgDataHome && isAbsolute(xdgDataHome) ? xdgDataHome : resolve(home, '.local/share'), 'svm'));
  return roots.map((path) => resolve(path, version, 'solc-' + version));
}

export async function findCachedSolc(version, explicitPath) {
  if (explicitPath) return resolve(explicitPath);
  for (const path of solcCachePaths(version)) {
    try { await access(path); return path; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
