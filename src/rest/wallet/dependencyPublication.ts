import { randomUUID } from 'node:crypto';
import { mkdir, open, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { RestError } from '../core.js';
import { uuid } from '../sponsorship/validation.js';
import { parseIndependentQuoteBinding, parseStatus, RelayrResponseError, type RelayrProvider } from '../sponsorship/provider.js';
import { prepareWalletDependencyBundle, type inspectWalletDependencyChain, type WalletDependencyFamily } from './dependencyBundle.js';

type Observation = Awaited<ReturnType<typeof inspectWalletDependencyChain>>;

export class WalletDependencyJournalError extends RestError {
  constructor(readonly recoveryBundleUuid: string | null) {
    super(500, 'WALLET_DEPENDENCY_JOURNAL_WRITE_FAILED',
      'The provider answered but the journal write failed. Recover the existing bundle; never resubmit.');
  }
}

/** One body-hash claim within the operator's fixed journal root. Never remove a claim
 * or switch roots to bypass an uncertain prior publication. No payment authority. */
export async function publishWalletDependencyQuote(options: {
  observations: Observation[]; directory: string; family: WalletDependencyFamily;
  source: { revision: string; fingerprint: string };
  provider: Pick<RelayrProvider, 'createIndependent' | 'status'>;
  now?: () => number; signal?: AbortSignal;
}) {
  const source = structuredClone(options.source);
  if (!source || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(source.revision) || !/^[0-9a-f]{64}$/.test(source.fingerprint))
    throw new RestError(400, 'WALLET_DEPENDENCY_SOURCE_INVALID', 'Reviewed source attribution is required.');
  const now = options.now ?? Date.now;
  const plan = await prepareWalletDependencyBundle(options.observations, now());
  const bundle = plan.bundles.find(bundle => bundle.family === options.family);
  if (!bundle) throw new RestError(400, 'WALLET_DEPENDENCY_FAMILY_INVALID', 'Choose mainnet or testnet.');
  if (!bundle.body.transactions.length) throw new RestError(409, 'WALLET_DEPENDENCIES_PRESENT', 'Every dependency is already present.');
  const root = resolve(options.directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = join(root, bundle.bodyHash.slice(2)), path = join(directory, 'publication.json');
  // mkdir is the cross-process claim keyed by semantic request hash, independent of run IDs.
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
  const attempt = { version: 'center-wallet-dependency-publication-v2', family: bundle.family,
    state: 'submission-unknown', startedAt: now(), bodyHash: bundle.bodyHash,
    body: bundle.body, observations: plan.observations, source };
  await save(attempt);
  // Recheck freshness after filesystem waits and immediately before the sole network write.
  const refreshed = await prepareWalletDependencyBundle(plan.observations, now());
  if (refreshed.bundles.find(item => item.family === bundle.family)?.bodyHash !== bundle.bodyHash)
    throw new RestError(409, 'WALLET_DEPENDENCY_REQUEST_CHANGED', 'Dependency request changed before publication.');
  options.signal?.throwIfAborted();
  async function receive(work: () => Promise<unknown>, previous: object, phase: 'quote' | 'status', knownBundleUuid: string | null = null) {
    try { return await work(); }
    catch (error) {
      if (error instanceof RelayrResponseError) {
        try { await save({ ...previous, state: phase === 'quote' ? 'response-received' : 'status-received',
          responseReceivedAt: now(), errorCode: error.code, httpResponse: error.responseDetails }); }
        catch { throw new WalletDependencyJournalError(knownBundleUuid ?? recoveryBundleUuid(error.responseDetails.body)); }
      }
      throw error;
    }
  }
  const response = await receive(() => options.provider.createIndependent(bundle.body.transactions, options.signal), attempt, 'quote');
  // Preserve even a malformed response (including any recovery UUID) before policy parsing.
  const received = { ...attempt, state: 'response-received', responseReceivedAt: now(), response };
  try { await save(received); }
  catch {
    const id = response !== null && typeof response === 'object' ? (response as Record<string, unknown>).bundle_uuid : null;
    // A validated UUID survives disk failures through the CLI's stderr; never echo provider text.
    throw new WalletDependencyJournalError(uuid(id) ? id : null);
  }
  const quote = parseIndependentQuoteBinding(response, bundle.body.transactions, now());
  const bound = { ...received, state: 'quote-bound', quote, fundingEnabled: false as const };
  await save(bound);
  const status = await receive(() => options.provider.status(quote.bundleUuid, options.signal), bound, 'status', quote.bundleUuid);
  // A UUID list alone does not echo the requested calls. Require the provider's
  // stored bundle to contain the exact targets, calldata, values and nonce fields.
  const statusReceived = { ...bound, state: 'status-received', statusResponse: status };
  await save(statusReceived);
  const providerStatus = parseStatus(status, quote);
  const record = { ...statusReceived, state: 'quoted', providerStatus };
  await save(record);
  return { record, path };
}

/** Error text is untrusted; only a complete parsed top-level UUID is a recovery locator. */
export function recoveryBundleUuid(body: string): string | null {
  try { const value = JSON.parse(body); return value && uuid(value.bundle_uuid) ? value.bundle_uuid : null; }
  catch { return null; }
}
