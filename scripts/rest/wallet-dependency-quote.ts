import { resolve } from 'node:path';
import { captureSourceSnapshot } from './check-required-tests.mjs';
import { createRestRpc } from '../../src/rest/rpc.js';
import { PUBLICNODE_RPC_URLS } from '../../src/rpc.js';
import { RelayrProvider } from '../../src/rest/sponsorship/provider.js';
import { inspectWalletDependencyChain, WALLET_DEPENDENCY_CHAINS } from '../../src/rest/wallet/dependencyBundle.js';
import { publishWalletDependencyQuote } from '../../src/rest/wallet/dependencyPublication.js';

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--audited-fingerprint' || !/^[0-9a-f]{64}$/.test(args[1] ?? '')
  || args[2] !== '--journal' || !args[3])
  throw new Error('Usage: npm run wallet:dependency-quote -- --audited-fingerprint SHA256 --journal /absolute/new/directory');
// This is an explicit operator attestation of completed review, not a machine-generated
// audit approval. The operator must obtain the fingerprint from the reviewed release record.
const root = resolve(import.meta.dirname, '../..'), expected = args[1];
async function reviewed() {
  if ((await captureSourceSnapshot(root)).fingerprint !== expected) throw new Error('Source differs from the operator-reviewed fingerprint.');
}
try {
  await reviewed();
  const rpc = createRestRpc({ upstreams: new Map(WALLET_DEPENDENCY_CHAINS.map(chain => [chain, [PUBLICNODE_RPC_URLS[chain]!]])) });
  const signal = AbortSignal.timeout(15000);
  const observations = await Promise.all(WALLET_DEPENDENCY_CHAINS.map(chainId => inspectWalletDependencyChain({ chainId, rpc, signal })));
  signal.throwIfAborted();
  await reviewed();
  const result = await publishWalletDependencyQuote({ observations, directory: args[3], provider: new RelayrProvider(),
    signal: AbortSignal.timeout(45000) });
  console.log(JSON.stringify({ state: result.record.state, journal: result.path, bundleUuid: result.record.quote.bundleUuid,
    payments: result.record.quote.payments, fundingEnabled: result.record.fundingEnabled }));
} catch {
  console.error('Dependency quote preparation did not complete. Inspect the journal before any further action; never automatically resubmit. No payment was signed or sent.');
  process.exitCode = 1;
}
