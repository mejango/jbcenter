import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { RestError } from '../core.js';
import { object, uuid } from '../sponsorship/validation.js';
import { stable } from '../smartAccounts/service.js';
import { bindIndependentQuoteStatus, parseIndependentQuoteBinding, parseIndependentStatus, RelayrResponseError, type RelayrResponseDetails, type RelayrProvider } from '../sponsorship/provider.js';
import { prepareWalletDependencyBundle, type inspectWalletDependencyChain, type WalletDependencyFamily } from './dependencyBundle.js';

type Observation = Awaited<ReturnType<typeof inspectWalletDependencyChain>>;

export class WalletDependencyJournalError extends RestError {
  constructor(readonly recoveryBundleUuid: string | null, readonly httpResponse?: Omit<RelayrResponseDetails, 'body'>) {
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
  let previousAttemptId: string | null = null;
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    // Only a durable proof that the POST never started permits another invocation.
    // A permanent claim keyed to the previous attempt prevents concurrent/stale readers
    // from admitting more than one successor, without deleting any history or locks.
    let previous: unknown;
    try { previous = JSON.parse(await readFile(path, 'utf8')); } catch { throw error; }
    if (!object(previous) || previous.state !== 'not-submitted' || !uuid(previous.attemptId)
      || previous.bodyHash !== bundle.bodyHash || previous.family !== bundle.family) throw error;
    await mkdir(join(directory, `retry-${previous.attemptId}`), { mode: 0o700 });
    const folder = await open(directory, 'r');
    try { await folder.sync(); } finally { await folder.close(); }
    previousAttemptId = previous.attemptId;
  }
  const parent = await open(resolve(directory, '..'), 'r');
  try { await parent.sync(); } finally { await parent.close(); }
  const save = (record: unknown, name = 'publication.json') => saveRecord(directory, record, name);
  const attempt = { version: 'center-wallet-dependency-publication-v2', family: bundle.family,
    state: 'submission-unknown', attemptId: randomUUID(), previousAttemptId, startedAt: now(), bodyHash: bundle.bodyHash,
    body: bundle.body, observations: plan.observations, source };
  await save(attempt);
  // Recheck freshness after filesystem waits and immediately before the sole network write.
  try {
    const refreshed = await prepareWalletDependencyBundle(plan.observations, now());
    if (refreshed.bundles.find(item => item.family === bundle.family)?.bodyHash !== bundle.bodyHash)
      throw new RestError(409, 'WALLET_DEPENDENCY_REQUEST_CHANGED', 'Dependency request changed before publication.');
    options.signal?.throwIfAborted();
  } catch (error) {
    const stopped = { ...attempt, state: 'not-submitted', stoppedAt: now(),
      errorCode: error instanceof RestError ? error.code : 'WALLET_DEPENDENCY_PREFLIGHT_FAILED' };
    await save(stopped, `not-submitted-${attempt.attemptId}.json`);
    await save(stopped);
    throw error;
  }
  async function receive(work: () => Promise<unknown>, previous: object, phase: 'quote' | 'status', knownBundleUuid: string | null = null) {
    try { return await work(); }
    catch (error) {
      if (error instanceof RelayrResponseError) {
        try { await save({ ...previous, state: phase === 'quote' ? 'response-received' : 'status-received',
          responseReceivedAt: now(), errorCode: error.code, httpResponse: error.responseDetails }); }
        catch {
          const { status, complete, truncated } = error.responseDetails;
          throw new WalletDependencyJournalError(knownBundleUuid ?? recoveryBundleUuid(error.responseDetails.body), { status, complete, truncated });
        }
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
  const provisionalQuote = parseIndependentQuoteBinding(response, bundle.body.transactions, now());
  const receivedQuote = { ...received, state: 'quote-received', provisionalQuote, fundingEnabled: false as const };
  await save(receivedQuote);
  const status = await receive(() => options.provider.status(provisionalQuote.bundleUuid, options.signal), receivedQuote, 'status', provisionalQuote.bundleUuid);
  // A UUID list alone does not echo the requested calls. Require the provider's
  // stored bundle to contain the exact targets, calldata, values and nonce fields.
  const statusReceived = { ...receivedQuote, state: 'status-received', statusResponse: status };
  await save(statusReceived);
  const quote = bindIndependentQuoteStatus(status, provisionalQuote);
  const providerStatus = parseIndependentStatus(status, quote);
  const record = { ...statusReceived, state: 'quoted', quote, providerStatus };
  await save(record);
  return { record, path };
}

/** Error text is untrusted; only a complete parsed top-level UUID is a recovery locator. */
export function recoveryBundleUuid(body: string): string | null {
  try { const value = JSON.parse(body); return object(value) && uuid(value.bundle_uuid) ? value.bundle_uuid : null; }
  catch { return null; }
}

/** Atomic local evidence writes. Callers retain the permanent publication claim and history. */
async function saveRecord(directory: string, record: unknown, name: string) {
  const temporary = join(directory, `${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(record, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, join(directory, name));
  const folder = await open(directory, 'r');
  try { await folder.sync(); } finally { await folder.close(); }
}

/** GET-only recovery of a known quote. Historical observations reconstruct the original
 * recipe at publication time; they are never fresh funding or deployment evidence. */
export async function reconcileWalletDependencyQuote(options: {
  directory: string; bodyHash: string; source: { revision: string; fingerprint: string };
  provider: Pick<RelayrProvider, 'status'>; now?: () => number; signal?: AbortSignal;
}) {
  function invalid(): never { throw new RestError(409, 'WALLET_DEPENDENCY_JOURNAL_INVALID', 'A complete, unchanged publication record is required for read-only reconciliation.'); }
  const validSource = (value: unknown) => object(value) && typeof value.revision === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.revision)
    && typeof value.fingerprint === 'string' && /^[0-9a-f]{64}$/.test(value.fingerprint);
  if (!/^[0-9a-f]{64}$/.test(options.bodyHash) || !validSource(options.source)) invalid();
  const directory = join(resolve(options.directory), options.bodyHash), originalPath = join(directory, 'publication.json');
  const file = await open(originalPath, 'r');
  let bytes: Buffer;
  try {
    const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await file.read(buffer, length, buffer.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length === buffer.length) invalid();
    bytes = buffer.subarray(0, length);
  } finally { await file.close(); }
  const original: unknown = JSON.parse(bytes.toString('utf8'));
  const now = options.now ?? Date.now;
  if (!object(original) || original.version !== 'center-wallet-dependency-publication-v2'
    || !['response-received', 'quote-received', 'quote-bound', 'status-received', 'quoted'].includes(String(original.state))
    || !validSource(original.source) || !Number.isSafeInteger(original.startedAt) || Number(original.startedAt) > now()
    || !Number.isSafeInteger(original.responseReceivedAt) || Number(original.responseReceivedAt) < Number(original.startedAt)
    || !Array.isArray(original.observations) || !object(original.response)
    || original.bodyHash !== `0x${options.bodyHash}`) invalid();
  const plan = await prepareWalletDependencyBundle(original.observations as Observation[], Number(original.startedAt));
  const bundle = plan.bundles.find(item => item.family === original.family);
  if (!bundle || bundle.bodyHash !== original.bodyHash || stable(bundle.body) !== stable(original.body)) invalid();
  const provisionalQuote = parseIndependentQuoteBinding(original.response, bundle.body.transactions, Number(original.responseReceivedAt));
  const evidence = { version: 'center-wallet-dependency-reconciliation-v1', bodyHash: original.bodyHash,
    publicationSource: original.source, reconciliationSource: structuredClone(options.source),
    originalSha256: createHash('sha256').update(bytes).digest('hex'), bundleUuid: provisionalQuote.bundleUuid,
    fundingEnabled: false as const, historicalRecipeOnly: true as const };
  const name = `reconciliation-${randomUUID()}`;
  let status: unknown;
  try { status = await options.provider.status(provisionalQuote.bundleUuid, options.signal); }
  catch (error) {
    if (error instanceof RelayrResponseError) await saveRecord(directory,
      { ...evidence, observedAt: now(), httpResponse: error.responseDetails }, `${name}-response.json`);
    throw error;
  }
  // No parser or status failure can erase this response or the original POST identity.
  const received = { ...evidence, observedAt: now(), statusResponse: status };
  await saveRecord(directory, received, `${name}-response.json`);
  const quote = bindIndependentQuoteStatus(status, provisionalQuote);
  const providerStatus = parseIndependentStatus(status, quote);
  const record = { ...received, state: 'reconciled', quote, providerStatus,
    providerReportedPayment: object(status) && status.payment_received === true ? 'received' :
      object(status) && status.payment_received === false ? 'unpaid' : 'unknown' };
  const path = join(directory, `${name}.json`);
  await saveRecord(directory, record, `${name}.json`);
  return { record, path };
}
