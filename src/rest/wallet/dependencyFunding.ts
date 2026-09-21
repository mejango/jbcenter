import { mkdir, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isAddress, keccak256, parseTransaction, recoverTransactionAddress, serializeTransaction,
  type Address, type Hex, type TransactionSerializableEIP1559 } from 'viem';
import { RestError, type RestRpc } from '../core.js';
import { SponsorshipChain } from '../sponsorship/chain.js';
import { DEFAULT_SPONSORSHIP_POLICY, RELAYR_PAYMENT_GAS } from '../sponsorship/constants.js';
import { assertPaymentEligible, type RelayrProvider } from '../sponsorship/provider.js';
import { decimal, digest, hash, object, quantity, same, uuid } from '../sponsorship/validation.js';
import { inspectWalletDependencyChain, prepareWalletDependencyBundle, WALLET_DEPENDENCY_CHAINS } from './dependencyBundle.js';
import { reconcileWalletDependencyQuote, writeWalletDependencyEvidence } from './dependencyPublication.js';
import { walletDependencyPathExists } from './dependencyJournal.js';

export const WALLET_DEPENDENCY_FUNDING_PAYER = '0x097334063a5c2505d8df1C660B996699c27E6Fd3' as const;
export const WALLET_DEPENDENCY_FUNDING_MARGIN_SECONDS = 300;
type Source = { revision: string; fingerprint: string };
export type WalletDependencyFundingOptions = {
  directory: string; bodyHash: string; bundleUuid: string; source: Source; rpc: RestRpc; provider: Pick<RelayrProvider, 'status'>;
  payer: Address; maximumTotalWei: string; maxFeePerGasWei: string; maxPriorityFeePerGasWei: string;
  now?: () => number; signal?: AbortSignal;
};
export type WalletDependencyFundingTemplate = {
  version: 'center-wallet-dependency-funding-v1'; source: Source; bodyHash: string; bundleUuid: string; quoteCommitment: Hex;
  payer: Address; transaction: { type: 'eip1559'; chainId: 1 | 11155111; to: Address; data: Hex; value: string;
    gas: string; nonce: number; maxFeePerGas: string; maxPriorityFeePerGas: string; accessList: [] };
  maximumTotalWei: string; maximumCostWei: string; paymentDeadline: string; observedAt: number; evidence: unknown;
};
function invalid(message: string): never { throw new RestError(409, 'WALLET_DEPENDENCY_FUNDING_REJECTED', message); }
function source(value: Source): Source {
  if (!value || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.revision) || !/^[0-9a-f]{64}$/.test(value.fingerprint)) invalid('An exact reviewed source is required.');
  return { revision: value.revision, fingerprint: value.fingerprint };
}
function budget(options: WalletDependencyFundingOptions) {
  const maximum = decimal(options.maximumTotalWei, 'maximum total'), maxFee = decimal(options.maxFeePerGasWei, 'maximum gas fee'),
    priority = decimal(options.maxPriorityFeePerGasWei, 'priority fee');
  if (!isAddress(options.payer) || maximum === 0n || maxFee === 0n || priority > maxFee) invalid('Invalid payer or explicit fee limits.');
  return { maximum, maxFee, priority };
}
/** Preparation requires actual funded balance and an exact payment simulation. L1-only payment
 * chains make value + gas * maxFee a hard transaction liability bound. Destinations remain eight chains. */
export async function prepareWalletDependencyFunding(input: WalletDependencyFundingOptions): Promise<WalletDependencyFundingTemplate> {
  const options = { ...input, source: source(input.source) }, { maximum, maxFee, priority } = budget(options);
  if (!uuid(options.bundleUuid)) invalid('Choose the exact current bundle UUID.');
  const now = options.now ?? Date.now;
  const deadline = AbortSignal.timeout(45000), signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  signal.throwIfAborted();
  const recovered = await reconcileWalletDependencyQuote({ directory: options.directory, bodyHash: options.bodyHash,
    source: options.source, provider: options.provider, now, signal });
  const { quote, providerStatus, statusResponse } = recovered.record;
  if (quote.bundleUuid !== options.bundleUuid) invalid('The selected bundle is not the current quote.');
  if (!object(statusResponse) || statusResponse.payment_received !== false || providerStatus.some(item => item.providerState !== 'Pending'))
    invalid('Only an explicitly unpaid, wholly pending bundle can be funded.');
  const inspectSignal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  const observations = await Promise.all(WALLET_DEPENDENCY_CHAINS.map(chainId => inspectWalletDependencyChain({ chainId, rpc: options.rpc, signal: inspectSignal, now })));
  const plan = await prepareWalletDependencyBundle(observations, now());
  const bundle = plan.bundles.find(item => item.bodyHash === `0x${options.bodyHash}`);
  if (!bundle) invalid('The missing deployments changed after quotation.');
  const chainId = bundle.family === 'mainnet' ? 1 : 11155111;
  const payment = quote.payments.find(item => item.chainId === chainId);
  if (!payment) invalid('The quote has no supported L1 funding option.');
  assertPaymentEligible(payment, now(), maximum);
  if (BigInt(payment.deadline) < BigInt(Math.floor(now() / 1000) + WALLET_DEPENDENCY_FUNDING_MARGIN_SECONDS)) invalid('At least five minutes must remain to fund this quote.');
  const maximumCost = BigInt(payment.value) + RELAYR_PAYMENT_GAS * maxFee;
  if (maximumCost > maximum || maximumCost >= 1n << 256n) invalid('The exact payment and maximum gas exceed the total spending cap.');
  const chain = new SponsorshipChain(options.rpc, { ...DEFAULT_SPONSORSHIP_POLICY, rpcTimeoutMs: 3000 }, signal, now);
  const evidence = await chain.payment(payment, options.payer);
  if (BigInt(evidence.timestamp) * 1000n < BigInt(now() - 60000)) invalid('Fresh funding-chain evidence is required.');
  const [balance, nonce, pendingNonce, code, block, estimatedGas] = await Promise.all([
    chain.request(chainId, 'eth_getBalance', [options.payer, chain.tag(evidence)]),
    chain.request(chainId, 'eth_getTransactionCount', [options.payer, chain.tag(evidence)]),
    chain.request(chainId, 'eth_getTransactionCount', [options.payer, 'pending']),
    chain.request(chainId, 'eth_getCode', [options.payer, chain.tag(evidence)]),
    chain.request(chainId, 'eth_getBlockByNumber', [`0x${BigInt(evidence.blockNumber).toString(16)}`, false]),
    chain.request(chainId, 'eth_estimateGas', [{ from: options.payer, to: payment.to, data: payment.data,
      value: `0x${BigInt(payment.value).toString(16)}`, gas: `0x${RELAYR_PAYMENT_GAS.toString(16)}` }, chain.tag(evidence)]),
  ]);
  const nonceValue = quantity(nonce, 'payer nonce');
  if (code !== '0x' || quantity(balance, 'payer balance') < maximumCost || nonceValue !== 0n
    || quantity(pendingNonce, 'pending nonce') !== nonceValue || !object(block) || !hash(block.hash) || !same(block.hash, evidence.blockHash)
    || quantity(block.number, 'block number').toString() !== evidence.blockNumber
    || quantity(estimatedGas, 'estimated payment gas') < 21000n || quantity(estimatedGas, 'estimated payment gas') > RELAYR_PAYMENT_GAS
    || 2n * quantity(block.baseFeePerGas, 'base fee') + priority > maxFee) invalid('Balance, fee headroom, nonce or payer code is not eligible.');
  await chain.canonical(evidence); signal.throwIfAborted();
  if (BigInt(payment.deadline) < BigInt(Math.floor(now() / 1000) + WALLET_DEPENDENCY_FUNDING_MARGIN_SECONDS)) invalid('The quote became too old during preparation.');
  return { version: 'center-wallet-dependency-funding-v1', source: options.source, bodyHash: options.bodyHash,
    bundleUuid: quote.bundleUuid, quoteCommitment: quote.commitment, payer: options.payer, transaction: { type: 'eip1559', chainId,
      to: payment.to, data: payment.data, value: payment.value, gas: RELAYR_PAYMENT_GAS.toString(), nonce: Number(nonceValue),
      maxFeePerGas: maxFee.toString(), maxPriorityFeePerGas: priority.toString(), accessList: [] },
    maximumTotalWei: maximum.toString(), maximumCostWei: maximumCost.toString(), paymentDeadline: payment.deadline, observedAt: now(), evidence };
}
export function walletDependencyFundingTransaction(template: WalletDependencyFundingTemplate): TransactionSerializableEIP1559 {
  const t = template.transaction;
  return { type: 'eip1559', chainId: t.chainId, nonce: t.nonce, to: t.to, data: t.data, value: BigInt(t.value), gas: BigInt(t.gas),
    maxFeePerGas: BigInt(t.maxFeePerGas), maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas), accessList: [] };
}
/** The signer is untrusted until every signed field, canonical encoding and recovered payer matches. */
export async function validateWalletDependencyFundingSignature(template: WalletDependencyFundingTemplate, raw: Hex) {
  if (typeof raw !== 'string' || !/^0x02(?:[0-9a-fA-F]{2})+$/.test(raw) || raw.length > 4096) invalid('Invalid signed payment envelope.');
  const tx = parseTransaction(raw), expected = walletDependencyFundingTransaction(template);
  if (tx.type !== 'eip1559' || tx.chainId !== expected.chainId || tx.nonce !== expected.nonce || !tx.to || !same(tx.to, expected.to!)
    || tx.data !== expected.data || (tx.value ?? 0n) !== expected.value || tx.gas !== expected.gas
    || tx.maxFeePerGas !== expected.maxFeePerGas || tx.maxPriorityFeePerGas !== expected.maxPriorityFeePerGas
    || (tx.accessList?.length ?? 0) !== 0 || !tx.r || !tx.s || (tx.yParity !== 0 && tx.yParity !== 1)
    || BigInt(tx.s) <= 0n || BigInt(tx.s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n
    || serializeTransaction(tx, { r: tx.r, s: tx.s, yParity: tx.yParity }).toLowerCase() !== raw.toLowerCase()
    || !same(await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` }), template.payer)) invalid('The signed payment differs from the exact prepared transaction.');
  return { rawTransaction: raw.toLowerCase() as Hex, hash: keccak256(raw) };
}
async function claim(directory: string) {
  await mkdir(directory, { mode: 0o700 });
  const parent = await open(resolve(directory, '..'), 'r');
  try { await parent.sync(); } finally { await parent.close(); }
}
/** Funding and quote retirement share one permanent bundle claim. No claim is ever deleted. */
export async function claimWalletDependencyBundle(directory: string, bundleUuid: string, purpose: 'funding' | 'retired', evidence: unknown) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bundleUuid)) invalid('Invalid bundle claim.');
  const root = join(resolve(directory), 'bundle-claims'); await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, bundleUuid); await claim(path);
  await writeWalletDependencyEvidence(path, { purpose, evidence }, 'claim.json');
}
/** One new payment only. Lost responses, mismatched hashes and write failures keep the durable
 * claim and signed identity; they never authorize a second signature or a new nonce. */
export async function fundWalletDependencyQuote(options: WalletDependencyFundingOptions & {
  sign(transaction: TransactionSerializableEIP1559): Promise<Hex>; assertReviewedSource?: () => Promise<void>;
}) {
  const template = await prepareWalletDependencyFunding(options);
  await options.assertReviewedSource?.();
  if (await walletDependencyPathExists(join(resolve(options.directory), 'bundle-claims', template.bundleUuid)))
    invalid('This bundle already has a permanent funding or retirement claim.');
  const nonceRoot = join(resolve(options.directory), 'nonce-claims'); await mkdir(nonceRoot, { recursive: true, mode: 0o700 });
  const nonceClaim = join(nonceRoot, `${template.transaction.chainId}-${template.payer.toLowerCase()}-${template.transaction.nonce}`);
  await claim(nonceClaim);
  await writeWalletDependencyEvidence(nonceClaim, { bundleUuid: template.bundleUuid, source: template.source }, 'claim.json');
  await claimWalletDependencyBundle(options.directory, template.bundleUuid, 'funding', { source: template.source, bodyHash: template.bodyHash });
  const root = join(resolve(options.directory), 'funding'); await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = join(root, template.bundleUuid); await claim(directory);
  const prepared = { version: 'center-wallet-dependency-funding-record-v1', state: 'prepared', template, templateDigest: digest(template) };
  await writeWalletDependencyEvidence(directory, prepared, 'funding.json');
  const signed = await validateWalletDependencyFundingSignature(template, await options.sign(walletDependencyFundingTransaction(template)));
  const signedRecord = { ...prepared, state: 'signed', signed };
  await writeWalletDependencyEvidence(directory, signedRecord, 'funding.json');
  const fresh = await prepareWalletDependencyFunding(options);
  if (digest(fresh.transaction) !== digest(template.transaction) || fresh.bundleUuid !== template.bundleUuid
    || fresh.quoteCommitment !== template.quoteCommitment || fresh.maximumTotalWei !== template.maximumTotalWei) invalid('Payment conditions changed while signing.');
  const admittedAt = performance.now();
  const freshEnough = () => {
    options.signal?.throwIfAborted();
    const current = (options.now ?? Date.now)();
    if (performance.now() - admittedAt > 15000 || current - fresh.observedAt > 15000
      || BigInt(template.paymentDeadline) < BigInt(Math.floor(current / 1000) + WALLET_DEPENDENCY_FUNDING_MARGIN_SECONDS)) invalid('Funding admission expired before broadcast.');
  };
  await options.assertReviewedSource?.(); freshEnough();
  const sending = { ...signedRecord, state: 'sending', sendingAt: (options.now ?? Date.now)(), admissionEvidence: fresh.evidence };
  await writeWalletDependencyEvidence(directory, sending, 'funding.json');
  freshEnough();
  await sendWalletDependencyFundingRaw(options, template.transaction.chainId, signed);
  const record = { ...sending, state: 'submitted' };
  await writeWalletDependencyEvidence(directory, record, 'funding.json');
  return { record, path: join(directory, 'funding.json') };
}
/** Callers must persist the exact envelope and acquire their permanent send claim first. */
export async function sendWalletDependencyFundingRaw(options: { rpc: RestRpc; signal?: AbortSignal }, chainId: number,
  signed: { rawTransaction: Hex; hash: Hex }) {
  // Unlike generic gateways, this call has exactly one configured upstream and no retry path.
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  let answer: unknown;
  let abort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    const stopped = new Promise<never>((_resolve, reject) => { abort = () => reject(new Error('Funding response deadline.')); signal.addEventListener('abort', abort, { once: true }); });
    answer = await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return options.rpc.request(chainId, 'eth_sendRawTransaction', [signed.rawTransaction], signal); }), stopped]);
  }
  catch { throw new RestError(502, 'WALLET_DEPENDENCY_FUNDING_UNKNOWN', 'Payment response is unknown. Reconcile the saved transaction hash; never pay again.'); }
  finally { if (abort) signal.removeEventListener('abort', abort); }
  if (typeof answer !== 'string' || !same(answer, signed.hash)) invalid('Provider payment hash differs. Reconcile the saved hash; never pay again.');
}
