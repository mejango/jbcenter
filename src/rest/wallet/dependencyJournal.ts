import { open, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { RestError } from '../core.js';
import { object, uuid } from '../sponsorship/validation.js';

export async function readWalletDependencyJournal(path: string, maximumBytes = 2 * 1024 * 1024) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 2 * 1024 * 1024)
    throw new Error('Invalid dependency journal bound.');
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(maximumBytes + 1); let length = 0;
    while (length < buffer.length) {
      const result = await file.read(buffer, length, buffer.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length === buffer.length) throw new Error('Oversized dependency journal.');
    const bytes = buffer.subarray(0, length);
    return { value: JSON.parse(bytes.toString('utf8')) as unknown, sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally { await file.close(); }
}
export async function walletDependencyPathExists(path: string) {
  try { await lstat(path); return true; }
  catch (error) { if (object(error) && error.code === 'ENOENT') return false; throw error; }
}
/** Follow the single immutable retirement chain, never select an arbitrary attempt.
 * A missing record inside an existing directory is an unknown permanent claim. */
export async function walletDependencyPublicationLocation(root: string, bodyHash: string) {
  function invalid(): never { throw new RestError(409, 'WALLET_DEPENDENCY_HISTORY_INVALID', 'The complete, single dependency publication history is required.'); }
  if (!/^[0-9a-f]{64}$/.test(bodyHash)) invalid();
  let directory = join(resolve(root), bodyHash), parentUuid: string | null = null;
  for (let depth = 0; depth < 8; depth++) {
    if (!await walletDependencyPathExists(directory)) return { directory, parentUuid, retired: null, depth };
    if (!await walletDependencyPathExists(join(directory, 'publication.json')))
      throw Object.assign(new Error('An existing dependency claim has no complete record.'), { code: 'EEXIST' });
    let original: Awaited<ReturnType<typeof readWalletDependencyJournal>>;
    try { original = await readWalletDependencyJournal(join(directory, 'publication.json')); }
    catch { throw Object.assign(new Error('An existing dependency claim has no readable record.'), { code: 'EEXIST' }); }
    if (!object(original.value) || original.value.bodyHash !== `0x${bodyHash}`) invalid();
    const response = original.value.response;
    if (!object(response) || !uuid(response.bundle_uuid)) return { directory, parentUuid, retired: null, depth };
    const bundleUuid = response.bundle_uuid, claimPath = join(resolve(root), 'bundle-claims', bundleUuid);
    if (!await walletDependencyPathExists(claimPath)) return { directory, parentUuid, retired: null, depth };
    const { value: claim } = await readWalletDependencyJournal(join(claimPath, 'claim.json'));
    if (!object(claim) || !object(claim.evidence) || claim.evidence.bodyHash !== bodyHash) invalid();
    if (claim.purpose === 'funding') return { directory, parentUuid, retired: null, depth };
    if (claim.purpose !== 'retired' || claim.evidence.publicationSha256 !== original.sha256
      || claim.evidence.bundleUuid !== bundleUuid || claim.evidence.successor !== `renewal-${bundleUuid}`) invalid();
    const successorDirectory = join(directory, `renewal-${bundleUuid}`);
    if (!await walletDependencyPathExists(successorDirectory)) return {
      directory, parentUuid, retired: { bundleUuid, successorDirectory }, depth,
    };
    directory = successorDirectory; parentUuid = bundleUuid;
  }
  return invalid();
}
