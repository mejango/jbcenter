import { mkdir, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { keccak256, type Address } from 'viem';
import { RestError, type RestRpc } from '../core.js';
import { SponsorshipChain } from '../sponsorship/chain.js';
import { DEFAULT_SPONSORSHIP_POLICY, RELAYR_PAYMENT_ADDRESS, RELAYR_PAYMENT_CODE_HASH, RELAYR_PAYMENT_GAS } from '../sponsorship/constants.js';
import { verifyRelayrPaymentEvent } from '../sponsorship/paymentContract.js';
import { decimal, digest, hash, object, quantity, same, uuid } from '../sponsorship/validation.js';
import { type RelayrProvider } from '../sponsorship/provider.js';
import { reconcileWalletDependencyQuote, writeWalletDependencyEvidence } from './dependencyPublication.js';
import { prepareWalletDependencyFunding, sendWalletDependencyFundingRaw, validateWalletDependencyFundingSignature,
  WALLET_DEPENDENCY_FUNDING_MARGIN_SECONDS, type WalletDependencyFundingTemplate } from './dependencyFunding.js';

function invalid(): never {
  throw new RestError(409, 'WALLET_DEPENDENCY_FUNDING_EVIDENCE_INVALID', 'The saved payment and canonical chain evidence must agree exactly.');
}
async function readBounded(path: string): Promise<unknown> {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(256 * 1024 + 1); let length = 0;
    while (length < buffer.length) {
      const result = await file.read(buffer, length, buffer.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length === buffer.length) invalid();
    return JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } finally { await file.close(); }
}
export type WalletDependencyFundingRecoveryOptions = {
  directory: string; bodyHash: string; bundleUuid: string; payer: Address;
  source: { revision: string; fingerprint: string }; rpc: RestRpc;
  provider: Pick<RelayrProvider, 'status'>; now?: () => number; signal?: AbortSignal;
};
/** Never calls a signer or a write RPC. Original signed identity is immutable;
 * observation records are separate, including when a payment reorgs or reverts. */
export async function reconcileWalletDependencyFunding(options: WalletDependencyFundingRecoveryOptions) {
  if (!uuid(options.bundleUuid) || !/^[0-9a-f]{64}$/.test(options.bodyHash)) invalid();
  const directory = join(resolve(options.directory), 'funding', options.bundleUuid);
  const saved = await readBounded(join(directory, 'funding.json'));
  if (!object(saved) || saved.version !== 'center-wallet-dependency-funding-record-v1'
    || !['signed', 'sending', 'submitted'].includes(String(saved.state)) || !object(saved.template) || !object(saved.signed)) invalid();
  const template = saved.template as WalletDependencyFundingTemplate;
  if (template.version !== 'center-wallet-dependency-funding-v1' || saved.templateDigest !== digest(template)
    || template.bodyHash !== options.bodyHash || template.bundleUuid !== options.bundleUuid
    || typeof template.payer !== 'string' || !same(template.payer, options.payer) || !object(template.transaction)
    || ![1, 11155111].includes(template.transaction.chainId) || template.transaction.nonce !== 0
    || template.transaction.gas !== RELAYR_PAYMENT_GAS.toString() || template.transaction.to !== RELAYR_PAYMENT_ADDRESS
    || !object(template.source) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(template.source.revision) || !/^[0-9a-f]{64}$/.test(template.source.fingerprint)
    || !Number.isSafeInteger(template.observedAt)) invalid();
  const t = template.transaction;
  const maximumCost = decimal(t.value, 'payment value') + decimal(t.gas, 'gas') * decimal(t.maxFeePerGas, 'maximum fee');
  if (maximumCost.toString() !== template.maximumCostWei || maximumCost > decimal(template.maximumTotalWei, 'spending cap')
    || decimal(t.maxPriorityFeePerGas, 'priority fee') > decimal(t.maxFeePerGas, 'maximum fee')) invalid();
  const signed = await validateWalletDependencyFundingSignature(template, saved.signed.rawTransaction as `0x${string}`);
  if (signed.hash !== saved.signed.hash) invalid();
  const bundleClaim = await readBounded(join(resolve(options.directory), 'bundle-claims', options.bundleUuid, 'claim.json'));
  const nonceClaim = await readBounded(join(resolve(options.directory), 'nonce-claims', `${t.chainId}-${template.payer.toLowerCase()}-${t.nonce}`, 'claim.json'));
  if (!object(bundleClaim) || bundleClaim.purpose !== 'funding' || !object(bundleClaim.evidence)
    || bundleClaim.evidence.bodyHash !== options.bodyHash || digest(bundleClaim.evidence.source) !== digest(template.source)
    || !object(nonceClaim) || nonceClaim.bundleUuid !== options.bundleUuid || digest(nonceClaim.source) !== digest(template.source)) invalid();
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000);
  const recovered = await reconcileWalletDependencyQuote({ ...options, signal });
  const quote = recovered.record.quote, payment = quote.payments.find(item => item.chainId === t.chainId);
  if (quote.bundleUuid !== template.bundleUuid || quote.commitment !== template.quoteCommitment || !payment
    || payment.to !== t.to || payment.data !== t.data || payment.value !== t.value || payment.deadline !== template.paymentDeadline) invalid();
  const now = options.now ?? Date.now;
  const chain = new SponsorshipChain(options.rpc, { ...DEFAULT_SPONSORSHIP_POLICY, rpcTimeoutMs: 3000 }, signal, now);
  const head = await chain.paymentRuntime(t.chainId);
  if (BigInt(head.timestamp) * 1000n < BigInt(now() - 60000)) invalid();
  const [transaction, receipt] = await Promise.all([
    chain.request(t.chainId, 'eth_getTransactionByHash', [signed.hash]),
    chain.request(t.chainId, 'eth_getTransactionReceipt', [signed.hash]),
  ]);
  type State = 'not-found' | 'pending' | 'receipt-unavailable' | 'included' | 'included-reverted' | 'finalized' | 'reverted';
  let state: State, finalized: unknown = null, canonical: unknown = null, actualCostWei: string | null = null;
  if (transaction === null && receipt === null) state = 'not-found';
  else {
    if (!object(transaction) || transaction.hash !== signed.hash || typeof transaction.from !== 'string' || !same(transaction.from, template.payer)
      || typeof transaction.to !== 'string' || !same(transaction.to, t.to) || transaction.input !== t.data
      || quantity(transaction.type, 'transaction type') !== 2n || quantity(transaction.chainId, 'transaction chain') !== BigInt(t.chainId)
      || quantity(transaction.nonce, 'transaction nonce') !== BigInt(t.nonce) || quantity(transaction.value, 'transaction value').toString() !== t.value
      || quantity(transaction.gas, 'transaction gas').toString() !== t.gas || quantity(transaction.maxFeePerGas, 'transaction maximum fee').toString() !== t.maxFeePerGas
      || quantity(transaction.maxPriorityFeePerGas, 'transaction priority fee').toString() !== t.maxPriorityFeePerGas
      || !Array.isArray(transaction.accessList) || transaction.accessList.length !== 0) invalid();
    if (receipt === null) {
      if (transaction.blockHash === null && transaction.blockNumber === null) state = 'pending';
      else if (hash(transaction.blockHash) && quantity(transaction.blockNumber, 'transaction block') >= 0n) state = 'receipt-unavailable';
      else invalid();
    } else {
      if (!object(receipt) || receipt.transactionHash !== signed.hash || typeof receipt.from !== 'string' || !same(receipt.from, template.payer)
        || typeof receipt.to !== 'string' || !same(receipt.to, t.to) || !hash(receipt.blockHash) || receipt.blockHash !== transaction.blockHash
        || quantity(receipt.blockNumber, 'receipt block') !== quantity(transaction.blockNumber, 'transaction block')
        || quantity(receipt.blockNumber, 'receipt block') > BigInt(head.blockNumber) || !Array.isArray(receipt.logs)) invalid();
      const height = quantity(receipt.blockNumber, 'receipt block');
      [canonical, finalized] = await Promise.all([
        chain.request(t.chainId, 'eth_getBlockByNumber', [`0x${height.toString(16)}`, false]),
        chain.request(t.chainId, 'eth_getBlockByNumber', ['finalized', false]),
      ]);
      if (!object(canonical) || canonical.hash !== receipt.blockHash || quantity(canonical.number, 'canonical height') !== height
        || !object(finalized) || !hash(finalized.hash) || quantity(finalized.number, 'finalized height') > BigInt(head.blockNumber)) invalid();
      const finalizedBlock = await chain.request(t.chainId, 'eth_getBlockByNumber', [`0x${quantity(finalized.number, 'finalized height').toString(16)}`, false]);
      if (!object(finalizedBlock) || finalizedBlock.hash !== finalized.hash
        || quantity(finalizedBlock.number, 'finalized block height') !== quantity(finalized.number, 'finalized height')) invalid();
      const code = await chain.request(t.chainId, 'eth_getCode', [RELAYR_PAYMENT_ADDRESS, { blockHash: receipt.blockHash, requireCanonical: true }]);
      if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})+$/.test(code) || keccak256(code as `0x${string}`) !== RELAYR_PAYMENT_CODE_HASH) invalid();
      const status = quantity(receipt.status, 'receipt status'), gasUsed = quantity(receipt.gasUsed, 'used gas'), price = quantity(receipt.effectiveGasPrice, 'effective fee');
      if (![0n, 1n].includes(status) || gasUsed > BigInt(t.gas) || price > BigInt(t.maxFeePerGas)) invalid();
      actualCostWei = (gasUsed * price + (status === 1n ? BigInt(t.value) : 0n)).toString();
      if (status === 1n) {
        for (const log of receipt.logs) if (object(log) && typeof log.address === 'string' && same(log.address, RELAYR_PAYMENT_ADDRESS)) {
          if (log.transactionHash !== signed.hash || log.blockHash !== receipt.blockHash || quantity(log.blockNumber, 'log block') !== height || log.removed !== false) invalid();
        }
        verifyRelayrPaymentEvent(receipt.logs, template.bundleUuid, t.value, template.paymentDeadline);
      } else if (receipt.logs.length !== 0) invalid();
      state = height > quantity(finalized.number, 'finalized height') ? (status === 1n ? 'included' : 'included-reverted') : status === 1n ? 'finalized' : 'reverted';
    }
  }
  await chain.canonical(head); signal.throwIfAborted();
  const record = { version: 'center-wallet-dependency-funding-observation-v1', observedAt: now(), state,
    bundleUuid: options.bundleUuid, bodyHash: options.bodyHash, source: options.source, templateDigest: saved.templateDigest,
    hash: signed.hash, chainId: t.chainId, payer: template.payer, paymentFinalized: state === 'finalized', actualCostWei,
    providerReportedPayment: recovered.record.providerReportedPayment, transaction, receipt, head, canonical, finalized };
  const name = `observation-${randomUUID()}.json`;
  await writeWalletDependencyEvidence(directory, record, name);
  return { record, path: join(directory, name), template, signed, savedState: String(saved.state) };
}

/** One explicit, identical-byte retry after a missing transaction. Never changes
 * nonce, amount, gas or signature. A lost retry response permanently exhausts it. */
export async function rebroadcastWalletDependencyFunding(options: WalletDependencyFundingRecoveryOptions & {
  assertReviewedSource?: () => Promise<void>;
}) {
  // Keep both source gates: before recovery work and immediately before claiming.
  await options.assertReviewedSource?.();
  const recovered = await reconcileWalletDependencyFunding(options);
  if (recovered.record.state !== 'not-found' || recovered.record.providerReportedPayment !== 'unpaid') invalid();
  const { template, signed } = recovered;
  const fresh = await prepareWalletDependencyFunding({ ...options, maximumTotalWei: template.maximumTotalWei,
    maxFeePerGasWei: template.transaction.maxFeePerGas, maxPriorityFeePerGasWei: template.transaction.maxPriorityFeePerGas });
  if (fresh.bundleUuid !== template.bundleUuid || fresh.quoteCommitment !== template.quoteCommitment
    || digest(fresh.transaction) !== digest(template.transaction)) invalid();
  const admittedAt = performance.now();
  const freshEnough = () => {
    options.signal?.throwIfAborted();
    const current = (options.now ?? Date.now)();
    if (performance.now() - admittedAt > 15000 || current - fresh.observedAt > 15000
      || BigInt(template.paymentDeadline) < BigInt(Math.floor(current / 1000) + WALLET_DEPENDENCY_FUNDING_MARGIN_SECONDS)) invalid();
  };
  await options.assertReviewedSource?.(); freshEnough();
  const parent = join(resolve(options.directory), 'funding', template.bundleUuid), directory = join(parent, 'rebroadcast-once');
  await mkdir(directory, { mode: 0o700 });
  const folder = await open(parent, 'r'); try { await folder.sync(); } finally { await folder.close(); }
  const sending = { version: 'center-wallet-dependency-rebroadcast-v1', state: 'sending', source: options.source,
    kind: recovered.savedState === 'signed' ? 'first-send-from-signed' : 'rebroadcast',
    observedAt: (options.now ?? Date.now)(), templateDigest: digest(template), signed, admissionEvidence: fresh.evidence };
  await writeWalletDependencyEvidence(directory, sending, 'rebroadcast.json');
  // The final expensive source gate above already ran before mkdir. Only this
  // cheap freshness/cancellation check belongs after the permanent claim.
  freshEnough();
  await sendWalletDependencyFundingRaw(options, template.transaction.chainId, signed);
  const record = { ...sending, state: 'submitted' };
  await writeWalletDependencyEvidence(directory, record, 'rebroadcast.json');
  return { record, path: join(directory, 'rebroadcast.json') };
}
