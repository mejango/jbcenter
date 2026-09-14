import { resolve } from 'node:path';
import { RestError } from '../../src/rest/core.js';
import { RelayrProvider } from '../../src/rest/sponsorship/provider.js';
import { reconcileWalletDependencyQuote } from '../../src/rest/wallet/dependencyPublication.js';
import { captureSourceSnapshot } from './check-required-tests.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--body-hash' || !/^[0-9a-f]{64}$/.test(args[1] ?? ''))
  throw new Error('Usage: npm run wallet:dependency-reconcile -- --body-hash SHA256');
const root = resolve(import.meta.dirname, '../..');
try {
  const source = await captureSourceSnapshot(root);
  if (source.dirty) throw new RestError(409, 'WALLET_DEPENDENCY_SOURCE_CHANGED', 'Reconcile from a clean, reviewed checkout.');
  const result = await reconcileWalletDependencyQuote({ directory: resolve(root, '.generated/wallet-dependency-publications'),
    bodyHash: args[1]!, source, provider: new RelayrProvider(), signal: AbortSignal.timeout(45000) });
  const after = await captureSourceSnapshot(root);
  if (after.dirty || after.fingerprint !== source.fingerprint)
    throw new RestError(409, 'WALLET_DEPENDENCY_SOURCE_CHANGED', 'Source changed during read-only reconciliation.');
  console.log(JSON.stringify({ state: result.record.state, bundleUuid: result.record.quote.bundleUuid, journal: result.path,
    transactions: result.record.quote.entries.length, payments: result.record.quote.payments,
    providerReportedPayment: result.record.providerReportedPayment, historicalRecipeOnly: true, fundingEnabled: false }));
} catch (error) {
  console.error(JSON.stringify({ code: error instanceof RestError ? error.code : 'WALLET_DEPENDENCY_RECONCILE_FAILED' }));
  console.error('Read-only reconciliation did not complete. Original publication records remain unchanged. No quote or payment was submitted.');
  process.exitCode = 1;
}
