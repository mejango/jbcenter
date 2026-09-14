import { randomUUID } from 'node:crypto';
import { mkdir, open, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { RestError } from '../core.js';
import { parseQuoteBinding, parseStatus, type RelayrProvider } from '../sponsorship/provider.js';
import { prepareWalletDependencyBundle, type inspectWalletDependencyChain } from './dependencyBundle.js';

type Observation = Awaited<ReturnType<typeof inspectWalletDependencyChain>>;

/** Exclusive operator journal, separate from application and user-wallet authority. A new
 * directory is a one-shot publication attempt. Never reuse or automatically replace it. */
export async function publishWalletDependencyQuote(options: {
  observations: Observation[]; directory: string;
  provider: Pick<RelayrProvider, 'createIndependent' | 'status'>;
  now?: () => number; signal?: AbortSignal;
}) {
  const now = options.now ?? Date.now;
  const bundle = await prepareWalletDependencyBundle(options.observations, now());
  if (!bundle.body.transactions.length) throw new RestError(409, 'WALLET_DEPENDENCIES_PRESENT', 'Every dependency is already present.');
  const directory = resolve(options.directory), path = join(directory, 'publication.json');
  // mkdir is the cross-process claim. If a prior attempt exists, fail without contacting Relayr.
  await mkdir(directory, { mode: 0o700 });
  const parent = await open(resolve(directory, '..'), 'r');
  try { await parent.sync(); } finally { await parent.close(); }
  async function save(record: unknown) {
    const temporary = join(directory, `${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(record, null, 2) + '\n'); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    const folder = await open(directory, 'r');
    try { await folder.sync(); } finally { await folder.close(); }
  }
  const attempt = { version: 'center-wallet-dependency-publication-v1',
    state: 'submission-unknown', startedAt: now(), bodyHash: bundle.bodyHash,
    body: bundle.body, observations: bundle.observations };
  await save(attempt);
  // Recheck freshness after filesystem waits and immediately before the sole network write.
  await prepareWalletDependencyBundle(bundle.observations, now());
  options.signal?.throwIfAborted();
  const response = await options.provider.createIndependent(bundle.body.transactions, options.signal);
  // Preserve even a malformed response (including any recovery UUID) before policy parsing.
  const received = { ...attempt, state: 'response-received', responseReceivedAt: now(), response };
  await save(received);
  const quote = parseQuoteBinding(response, bundle.body.transactions, now());
  const bound = { ...received, state: 'quote-bound', quote, fundingEnabled: false as const };
  await save(bound);
  const status = await options.provider.status(quote.bundleUuid, options.signal);
  // A UUID list alone does not echo the requested calls. Require the provider's
  // stored bundle to contain the exact targets, calldata, values and nonce fields.
  const providerStatus = parseStatus(status, quote);
  const record = { ...bound, state: 'quoted', providerStatus };
  await save(record);
  return { record, path };
}
