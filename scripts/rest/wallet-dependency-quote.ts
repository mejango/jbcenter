import { RestError } from '../../src/rest/core.js';
import { resolve } from 'node:path';
import { walletOperatorSource, walletDependencyJournalDirectory } from './wallet-dependency-operator.js';
import { createRestRpc } from '../../src/rest/rpc.js';
import { walletDependencyRpcUpstreams } from './wallet-dependency-rpc.js';
import { RelayrProvider, RelayrResponseError } from '../../src/rest/sponsorship/provider.js';
import { inspectWalletDependencyChain, WALLET_DEPENDENCY_CHAINS } from '../../src/rest/wallet/dependencyBundle.js';
import { publishWalletDependencyQuote, WalletDependencyJournalError, recoveryBundleUuid } from '../../src/rest/wallet/dependencyPublication.js';

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--audited-fingerprint' || !/^[0-9a-f]{64}$/.test(args[1] ?? '')
  || args[2] !== '--family' || !['mainnet', 'testnet'].includes(args[3] ?? ''))
  throw new Error('Usage: npm run wallet:dependency-quote -- --audited-fingerprint SHA256 --family mainnet|testnet');
// This is an explicit operator attestation of completed review, not a machine-generated
// audit approval. The operator must obtain the fingerprint from the reviewed release record.
const root = resolve(import.meta.dirname, '../..'), expected = args[1];
async function reviewed() {
  const source = await walletOperatorSource(root);
  if (source.fingerprint !== expected || source.dirty)
    throw new RestError(409, 'WALLET_DEPENDENCY_SOURCE_CHANGED', 'Source differs from the clean operator-reviewed release.');
  return { revision: source.revision, fingerprint: source.fingerprint };
}
try {
  await reviewed();
  const rpc = createRestRpc({ upstreams: walletDependencyRpcUpstreams(process.env.DWELLIR_API_KEY) });
  const signal = AbortSignal.timeout(15000);
  const observations = await Promise.all(WALLET_DEPENDENCY_CHAINS.map(chainId => inspectWalletDependencyChain({ chainId, rpc, signal })));
  signal.throwIfAborted();
  const source = await reviewed();
  const result = await publishWalletDependencyQuote({ observations, source, family: args[3] as 'mainnet' | 'testnet', directory: walletDependencyJournalDirectory(), provider: new RelayrProvider(),
    signal: AbortSignal.timeout(45000) });
  console.log(JSON.stringify({ state: result.record.state, family: result.record.family, journal: result.path, bundleUuid: result.record.quote.bundleUuid,
    payments: result.record.quote.payments, fundingEnabled: result.record.fundingEnabled }));
} catch (error) {
  const code = error instanceof RestError ? error.code :
    error !== null && typeof error === 'object' && 'code' in error &&
    typeof error.code === 'string' && /^(?:E[A-Z0-9_]{1,40})$/.test(error.code) ? error.code : 'WALLET_DEPENDENCY_QUOTE_FAILED';
  console.error(JSON.stringify({ code, ...(error instanceof WalletDependencyJournalError ?
    { recoveryBundleUuid: error.recoveryBundleUuid, httpResponse: error.httpResponse } : {}), ...(error instanceof RelayrResponseError ? {
      httpStatus: error.responseDetails.status, detail: error.responseDetails.body.slice(0, 240),
      recoveryBundleUuid: recoveryBundleUuid(error.responseDetails.body),
      complete: error.responseDetails.complete, truncated: error.responseDetails.truncated } : {}) }));
  console.error('Dependency quote preparation did not complete. Inspect the journal before any further action; never automatically resubmit. No payment was signed or sent.');
  process.exitCode = 1;
}
