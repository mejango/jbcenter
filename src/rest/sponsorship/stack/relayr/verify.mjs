import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { keccak256 } from 'viem';
import { findCachedSolc } from '../../../smartAccounts/stack/passkey/solc-cache.mjs';

/** Offline equivalence evidence. Original upstream source provenance is unknown. */
export async function verifyRelayrPaymentReference() {
  const manifest = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url), 'utf8'));
  const content = await readFile(new URL('./RelayrPaymentReference.sol', import.meta.url), 'utf8');
  const sha256 = value => createHash('sha256').update(value).digest('hex');
  if (sha256(content) !== manifest.sourceSha256 || manifest.compiler.version !== '0.8.26+commit.8a97fa7a'
    || manifest.runtimeHash !== '0x6006b5acadb4cd60aa5c00cb844c34563e182dff83d4f4ff4fde226f7df16fa6'
    || keccak256(manifest.runtime) !== manifest.runtimeHash) throw new Error('Relayr reference evidence changed.');
  const solc = await findCachedSolc('0.8.26');
  const compilerHash = solc ? `0x${sha256(await readFile(solc))}` : null;
  if (!solc || !Object.values(manifest.compilerBinaries).some(pin => pin.sha256 === compilerHash))
    throw new Error('Pinned Solidity compiler is unavailable.');
  const { version: _version, ...settings } = manifest.compiler;
  const input = { language: 'Solidity', sources: { 'RelayrPaymentReference.sol': { content } }, settings: {
    ...settings, outputSelection: { '*': { '*': ['evm.deployedBytecode.object'] } },
  } };
  const built = spawnSync(solc, ['--standard-json'], { input: JSON.stringify(input), encoding: 'utf8',
    timeout: 15000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin' } });
  if (built.error || built.status !== 0) throw new Error('Relayr reference compilation failed.');
  const output = JSON.parse(built.stdout);
  if (output.errors?.some(item => item.severity === 'error')) throw new Error('Relayr reference did not compile.');
  const actual = output.contracts['RelayrPaymentReference.sol'].RelayrPaymentReference.evm.deployedBytecode.object;
  const expected = manifest.runtime.slice(2);
  // Both trailers have the exact Solidity 0.8.26 CBOR layout. Compare every byte
  // before that fixed trailer, including the unreachable INVALID separator.
  const trailer = /^a2646970667358221220[0-9a-f]{64}64736f6c634300081a0033$/;
  if (manifest.executableBytes !== 244 || actual.length !== 594 || expected.length !== 594
    || !trailer.test(actual.slice(488)) || !trailer.test(expected.slice(488))
    || actual.slice(0, 488) !== expected.slice(0, 488) || expected.slice(486, 488) !== 'fe')
    throw new Error('Reconstructed source differs from the pinned executable.');
  return { executableMatches: true, upstreamSourceVerified: false, runtimeHash: manifest.runtimeHash };
}
