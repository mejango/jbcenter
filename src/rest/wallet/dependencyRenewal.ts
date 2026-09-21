import { join } from 'node:path';
import { type Address } from 'viem';
import { RestError, type RestRpc } from '../core.js';
import { SponsorshipChain } from '../sponsorship/chain.js';
import { DEFAULT_SPONSORSHIP_POLICY } from '../sponsorship/constants.js';
import { type RelayrProvider } from '../sponsorship/provider.js';
import { object, quantity, uuid } from '../sponsorship/validation.js';
import { claimWalletDependencyBundle } from './dependencyFunding.js';
import { inspectWalletDependencyChain, prepareWalletDependencyBundle, WALLET_DEPENDENCY_CHAINS } from './dependencyBundle.js';
import { readWalletDependencyJournal, walletDependencyPathExists, walletDependencyPublicationLocation } from './dependencyJournal.js';
import { publishWalletDependencyQuote, reconcileWalletDependencyQuote } from './dependencyPublication.js';

/** Explicit retirement of one known, expired, unpaid bundle, followed by one new
 * quote. Old publication bytes are retained. Any uncertain successor blocks more POSTs. */
export async function renewWalletDependencyQuote(options: {
  directory: string; bodyHash: string; bundleUuid: string; payer: Address;
  source: { revision: string; fingerprint: string }; rpc: RestRpc;
  provider: Pick<RelayrProvider, 'status' | 'createIndependent'>;
  now?: () => number; signal?: AbortSignal; assertReviewedSource?: () => Promise<void>;
}) {
  const invalid = (): never => { throw new RestError(409, 'WALLET_DEPENDENCY_RENEWAL_REJECTED', 'Only the current, fully known, expired and unpaid quote can be explicitly renewed.'); };
  if (!uuid(options.bundleUuid)) invalid();
  const now = options.now ?? Date.now, signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000);
  const location = await walletDependencyPublicationLocation(options.directory, options.bodyHash);
  if (location.depth >= 7 || (location.retired && location.retired.bundleUuid !== options.bundleUuid)) invalid();
  const recovered = await reconcileWalletDependencyQuote({ ...options, signal });
  const { quote, statusResponse, providerStatus } = recovered.record;
  if (quote.bundleUuid !== options.bundleUuid || !object(statusResponse) || statusResponse.payment_received !== false
    || providerStatus.some(item => item.providerState !== 'Pending')
    || quote.payments.some(payment => BigInt(payment.deadline) + 300n >= BigInt(Math.floor(now() / 1000)))) invalid();
  const family = quote.entries.every(item => [1,10,8453,42161].includes(item.entry.chain)) ? 'mainnet' : 'testnet';
  const chainId = family === 'mainnet' ? 1 : 11155111;
  if (!quote.payments.some(payment => payment.chainId === chainId)) invalid();
  const chain = new SponsorshipChain(options.rpc, { ...DEFAULT_SPONSORSHIP_POLICY, rpcTimeoutMs: 3000 }, signal, now);
  const head = await chain.paymentRuntime(chainId);
  if (BigInt(head.timestamp) * 1000n < BigInt(now() - 60000)) invalid();
  const [code, nonce, pendingNonce] = await Promise.all([
    chain.request(chainId, 'eth_getCode', [options.payer, chain.tag(head)]),
    chain.request(chainId, 'eth_getTransactionCount', [options.payer, chain.tag(head)]),
    chain.request(chainId, 'eth_getTransactionCount', [options.payer, 'pending']),
  ]);
  if (code !== '0x' || quantity(nonce, 'payer nonce') !== 0n || quantity(pendingNonce, 'pending nonce') !== 0n
    || await walletDependencyPathExists(join(options.directory, 'nonce-claims', `${chainId}-${options.payer.toLowerCase()}-0`))) invalid();
  await chain.canonical(head); signal.throwIfAborted();
  const original = await readWalletDependencyJournal(join(location.directory, 'publication.json'));
  if (original.sha256 !== recovered.record.originalSha256) invalid();
  await options.assertReviewedSource?.();
  if (!location.retired) await claimWalletDependencyBundle(options.directory, options.bundleUuid, 'retired', {
    source: options.source, bodyHash: options.bodyHash, bundleUuid: options.bundleUuid, publicationSha256: original.sha256,
    successor: `renewal-${options.bundleUuid}`, retiredAt: now(), evidence: head,
  });
  const inspectSignal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  const observations = await Promise.all(WALLET_DEPENDENCY_CHAINS.map(chainId => inspectWalletDependencyChain({ chainId, rpc: options.rpc, signal: inspectSignal, now })));
  const plan = await prepareWalletDependencyBundle(observations, now());
  if (plan.bundles.find(bundle => bundle.family === family)?.bodyHash !== `0x${options.bodyHash}`)
    throw new RestError(409, 'WALLET_DEPENDENCY_REQUEST_CHANGED', 'The old quote is retired, but missing deployments changed. Prepare the new body explicitly.');
  await options.assertReviewedSource?.(); signal.throwIfAborted();
  return publishWalletDependencyQuote({ observations, directory: options.directory, family, source: options.source,
    provider: options.provider, now, signal, renewalOf: options.bundleUuid });
}
