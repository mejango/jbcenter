import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRestRpc } from '../../src/rest/rpc.js';
import { PUBLICNODE_RPC_URLS } from '../../src/rpc.js';
import { RestError } from '../../src/rest/core.js';
import { inspectWalletDependencyChain, prepareWalletDependencyBundle, WALLET_DEPENDENCY_CHAINS } from '../../src/rest/wallet/dependencyBundle.js';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output' || !args[1]) {
  throw new Error('Usage: npm run wallet:dependency-bundle -- --output /absolute/path/bundle.json');
}
const output = resolve(args[1]);
const rpc = createRestRpc({ upstreams: new Map(WALLET_DEPENDENCY_CHAINS.map(chain =>
  [chain, [PUBLICNODE_RPC_URLS[chain]!]])) });
try {
  const observations = [];
  // Exactly eight read-only inspections, at most 32 code reads in flight, sharing
  // one deadline so sequential slow chains cannot age out the first observation.
  const signal = AbortSignal.timeout(15000);
  const results = await Promise.allSettled(WALLET_DEPENDENCY_CHAINS.map(async chainId => {
    try {
      const observation = await inspectWalletDependencyChain({ chainId, rpc, signal });
      console.log(JSON.stringify({ chainId, evidence: observation.evidence,
        missing: observation.missing.map(({ name, address, estimatedGas }) => ({ name, address, estimatedGas })) }));
      return observation;
    } catch (error) {
      console.error(JSON.stringify({ chainId, status: 'unverified', ...(error instanceof RestError ? { code: error.code } : {}) }));
      throw error;
    }
  }));
  if (results.some(result => result.status === 'rejected')) throw new Error('Incomplete chain evidence.');
  for (const result of results) if (result.status === 'fulfilled') observations.push(result.value);
  signal.throwIfAborted();
  const bundle = await prepareWalletDependencyBundle(observations);
  await writeFile(output, JSON.stringify(bundle, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ bundles: bundle.bundles.map(({ family, bodyHash, body }) => ({ family, bodyHash, transactions: body.transactions.length })),
    dependencies: bundle.recipe.profile,
    audit: bundle.audit, publicationEnabled: bundle.publicationEnabled, output }));
} catch {
  console.error('Eight-chain dependency bundle was not prepared. No bundle was published and no transaction was signed or sent.');
  process.exitCode = 1;
}
