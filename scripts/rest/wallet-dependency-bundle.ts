import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRestRpc } from '../../src/rest/rpc.js';
import { RestError } from '../../src/rest/core.js';
import { inspectWalletDependencyChain, prepareWalletDependencyBundle, WALLET_DEPENDENCY_CHAINS } from '../../src/rest/wallet/dependencyBundle.js';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output' || !args[1]) {
  throw new Error('Usage: npm run wallet:dependency-bundle -- --output /absolute/path/bundle.json');
}
const output = resolve(args[1]);
const rpc = createRestRpc({ upstreams: new Map(WALLET_DEPENDENCY_CHAINS.map(chain =>
  [chain, [`https://juicebox.center/v1/rpc/${chain}`]])) });
try {
  const observations = [];
  // At most two chain inspections, each with at most four code reads in flight.
  for (let index = 0; index < WALLET_DEPENDENCY_CHAINS.length; index += 2) {
    const results = await Promise.allSettled(WALLET_DEPENDENCY_CHAINS.slice(index, index + 2).map(async chainId => {
      try {
        const observation = await inspectWalletDependencyChain({ chainId, rpc });
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
  }
  const bundle = await prepareWalletDependencyBundle(observations);
  await writeFile(output, JSON.stringify(bundle, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ bodyHash: bundle.bodyHash, transactions: bundle.body.transactions.length,
    audit: bundle.audit, publicationEnabled: bundle.publicationEnabled, output }));
} catch {
  console.error('Eight-chain dependency bundle was not prepared. No bundle was published and no transaction was signed or sent.');
  process.exitCode = 1;
}
