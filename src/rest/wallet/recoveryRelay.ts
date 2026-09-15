import type { Pool, PoolClient } from 'pg';
import { keccak256, parseTransaction, recoverTransactionAddress, toHex, type Hex } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { RestError, type RestBlockEvidence, type RestRpc } from '../core.js';
import type { ContractPin, SmartAccountManifest } from '../smartAccounts/types.js';
import { createSmartAccountService, stable } from '../smartAccounts/service.js';
import { createSafe7579Inspector } from '../smartAccounts/inspector.js';
import { createInstalledSessionVerifier } from '../smartAccounts/installed.js';
import { MemorySmartAccountRegistry } from '../smartAccounts/registry.js';
import { assertPasskeyOnboardingState } from '../smartAccounts/passkeyOnboarding.js';
import { inspectPasskeyCreationSigner } from '../smartAccounts/passkeyProfile.js';
import { validatePasskeyCreationManifest } from '../smartAccounts/passkeyCreation.js';
import { operationRpc, walletObservationRpcBounds } from './operationRpc.js';
import { enrollmentDigest } from './enrollment.js';
import { loadWalletAuthorityContextInTransaction, PostgresWalletAuthorityStore } from './authorityPostgres.js';
import { assertWalletRecoveryCandidate, type WalletRecoveryCandidate } from './recovery.js';
import { prepareWalletRecoveryRotation, verifyWalletRecoveryRotation, type WalletRecoveryRotation } from './recoveryRotation.js';
import type { WalletRecoveryRecord } from './recoveryPostgres.js';
import type { WalletDeploymentEnvironment } from './deploymentSettlement.js';
import type { WalletDeploymentRpcScope } from './deploymentTransport.js';
import { assertRecoveryContinuationInTransaction } from './recoveryFlowPostgres.js';

export interface LocalWalletRecoveryStatus {
  recoveryId: string; state: 'review' | 'unknown' | 'failed' | 'ready';
  transactions: { createSigner: Hex | null; rotateOwner: Hex | null }; reason: string | null;
}
export interface WalletRecoveryFeeQuote { gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
export type WalletRecoveryReceiptFees = { executionWei: string } | { executionWei: string; l1Wei: string; operatorWei: string; totalWei: string };
/** One explicit chain behind the recovery lane. Never constructed from a request or environment flag. */
export interface WalletRecoveryRelayAdapter {
  configurationVersion: 'unforked-anvil-recovery-v1' | 'base-mainnet-recovery-v1';
  kind: WalletDeploymentEnvironment['kind'];
  genesisHash: Hex;
  reads: RestRpc;
  identity(rpc: WalletDeploymentRpcScope): Promise<WalletDeploymentEnvironment>;
  /** One physical eth_sendRawTransaction; a thrown or lost reply leaves the attempt unknown. */
  send(rawTransaction: Hex, signal: AbortSignal): Promise<unknown>;
  quote(rpc: WalletDeploymentRpcScope, latest: RestBlockEvidence): Promise<WalletRecoveryFeeQuote>;
  /** Base only: L1/operator estimate for exact signed bytes, added twice to the reservation. */
  reserve?(rpc: WalletDeploymentRpcScope, head: RestBlockEvidence, rawTransaction: Hex): Promise<{ l1WeiAtParameters: string; operatorMaximumWei: string }>;
  /** Fees actually charged for a canonical receipt. Throws rather than substituting zero. */
  fees(rpc: WalletDeploymentRpcScope, rawTransaction: Hex, receipt: { block: RestBlockEvidence; gasUsed: bigint; effectiveGasPrice: bigint; status: 'success' | 'revert' }): Promise<WalletRecoveryReceiptFees>;
  /** Release the sender lane only once both receipts are behind the finalized tag. */
  releaseAfterFinality: boolean;
}
type Approval = Awaited<ReturnType<typeof verifyWalletRecoveryRotation>> & { backupSignature: Hex };
type Lane = { sender: string; configuration: unknown; environment: WalletDeploymentEnvironment; next_nonce: string;
  operations: number; reserved_wei: string; spent_wei: string; active_recovery: string | null; anchor: RestBlockEvidence; fence: string | null };
type Dispatch = { recovery_id: string; sender: string; review: WalletRecoveryRotation; creation_transaction: Hex; approval: Approval | null };
type Receipt = { block: RestBlockEvidence; status: 'success' | 'revert' } & WalletRecoveryReceiptFees;
type Transaction = { recovery_id: string; step: number; sender: string; nonce: string; hash: Hex; raw_transaction: Hex;
  attempted_at_ms: string | null; receipt: Receipt | null };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
const addressSame = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
function invalid(): never { throw new RestError(409, 'WALLET_RECOVERY_DISPATCH_CONFLICT', 'The reviewed recovery or relay state changed.'); }
function unavailable(): never { throw new RestError(503, 'WALLET_RECOVERY_DISPATCH_UNAVAILABLE', 'The bounded recovery relay is unavailable.'); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value)) unavailable(); return BigInt(value);
}
function head(value: unknown): RestBlockEvidence {
  if (!object(value) || typeof value.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value.hash) || BigInt(value.hash) === 0n) unavailable();
  return { chainId: 8453, blockNumber: String(quantity(value.number)), blockHash: value.hash.toLowerCase() as Hex,
    timestamp: String(quantity(value.timestamp)), source: 'onchain' };
}
const tag = (value: RestBlockEvidence) => ({ blockHash: value.blockHash, requireCanonical: true as const });
function envelope(raw: Hex) {
  const tx = parseTransaction(raw);
  if (tx.type !== 'eip1559' || tx.gas === undefined || tx.maxFeePerGas === undefined) invalid();
  return { gas: tx.gas, maxFeePerGas: tx.maxFeePerGas };
}
const total = (fees: WalletRecoveryReceiptFees) => BigInt('totalWei' in fees ? fees.totalWei : fees.executionWei);

/** Explicit host-created relay for the two reviewed recovery transactions. It never mounts itself,
 * accepts an RPC from HTTP, shares a signup treasury or handles a recovery private key. Reservations
 * never recycle; actual fees are retained and an overspend fences the lane. */
export function createWalletRecoveryRelay(options: {
  pool: Pool; adapter: WalletRecoveryRelayAdapter; signer: PrivateKeyAccount;
  manifest: SmartAccountManifest; utility: ContractPin; maximumOperations: number; maximumCostWei: string;
}) {
  const { pool, adapter } = options;
  for (const value of [options.manifest, options.utility]) enrollmentDigest(value);
  const manifest = structuredClone(options.manifest), utility = structuredClone(options.utility), sender = options.signer.address.toLowerCase();
  const sign = options.signer.signTransaction.bind(options.signer);
  validatePasskeyCreationManifest(manifest);
  if (!Number.isSafeInteger(options.maximumOperations) || options.maximumOperations < 1 || options.maximumOperations > 1000
    || typeof options.maximumCostWei !== 'string' || !/^[1-9][0-9]{0,20}$/.test(options.maximumCostWei)
    || BigInt(options.maximumCostWei) > 100n * 10n ** 18n) invalid();
  const config = { version: adapter.configurationVersion, sender, genesisHash: adapter.genesisHash.toLowerCase(),
    manifestDigest: enrollmentDigest(manifest), utilityDigest: enrollmentDigest(utility),
    maximumOperations: options.maximumOperations, maximumCostWei: options.maximumCostWei };
  const authority = new PostgresWalletAuthorityStore(pool);
  type Scope = WalletDeploymentRpcScope;
  async function transaction<T>(client: PoolClient, action: () => Promise<T>) {
    await client.query('BEGIN');
    try { await client.query("SET LOCAL lock_timeout='5000ms'"); await client.query("SET LOCAL statement_timeout='10000ms'");
      const value = await action(); await client.query('COMMIT'); return value;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  }
  async function locked<T>(run: (client: PoolClient, rpc: Scope) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const client = await pool.connect(), rpc = operationRpc(adapter.reads, walletObservationRpcBounds, signal, true);
    let locked = false;
    try {
      // ponytail: one bounded sender lane per relay; a nonce pipeline needs its own reviewed design.
      const result = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtextextended('rest_wallet_recovery_lanes'::regclass::oid::text||$1,0)) AS locked", ['recovery-local:' + sender]);
      if (!result.rows[0]!.locked) throw new RestError(409, 'WALLET_RECOVERY_RELAY_BUSY', 'The recovery sender is reconciling an existing operation.');
      locked = true; return await run(client, rpc);
    } finally {
      rpc.close(); if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended('rest_wallet_recovery_lanes'::regclass::oid::text||$1,0))", ['recovery-local:' + sender]); client.release();
    }
  }
  async function required(id: string): Promise<WalletRecoveryRecord & { candidate: WalletRecoveryCandidate }> {
    if (typeof id !== 'string' || !uuid.test(id)) invalid();
    const value = (await pool.query<WalletRecoveryRecord>('SELECT intent,candidate,proof,activation FROM rest_wallet_recoveries WHERE id=$1', [id])).rows[0];
    if (!value?.candidate || !value.proof) invalid(); assertWalletRecoveryCandidate(value.candidate);
    if (!same(value.candidate.intent, value.intent) || value.proof.candidateDigest !== enrollmentDigest(value.candidate)
      || value.proof.intentDigest !== enrollmentDigest(value.intent) || value.proof.recoveryId !== id
      || enrollmentDigest(value.intent.manifest) !== config.manifestDigest) invalid();
    return value as WalletRecoveryRecord & { candidate: WalletRecoveryCandidate };
  }
  async function current(record: Awaited<ReturnType<typeof required>>) {
    const context = await authority.loadContext(record.intent.accountId);
    if (enrollmentDigest(context.enrollment) !== record.intent.enrollmentDigest || enrollmentDigest(context.credential) !== record.intent.priorCredentialDigest
      || context.binding.authorization.digest !== record.intent.priorBindingDigest || record.activation) invalid();
    return context;
  }
  async function fence(client: PoolClient, reason: string): Promise<never> {
    await client.query('UPDATE rest_wallet_recovery_lanes SET fence=COALESCE(fence,$2) WHERE sender=$1', [sender, reason]); unavailable();
  }
  async function lane(client: PoolClient, rpc: Scope): Promise<{ value: Lane; latest: RestBlockEvidence }> {
    const environment = await adapter.identity(rpc), latest = head(await rpc.request('eth_getBlockByNumber', ['latest', false]));
    if (environment.kind !== adapter.kind) unavailable();
    let value = (await client.query<Lane>('SELECT * FROM rest_wallet_recovery_lanes WHERE sender=$1', [sender])).rows[0];
    if (!value) {
      if (environment.genesisHash !== config.genesisHash) unavailable();
      const [confirmed, pending, code] = await Promise.all([rpc.request('eth_getTransactionCount', [sender, tag(latest)]),
        rpc.request('eth_getTransactionCount', [sender, 'pending']), rpc.request('eth_getCode', [sender, tag(latest)])]);
      if (quantity(confirmed) !== quantity(pending) || quantity(confirmed) > BigInt(Number.MAX_SAFE_INTEGER) || code !== '0x') unavailable();
      // No permission to share or race a configured signup treasury, on any chain.
      if ((await client.query('SELECT 1 FROM rest_wallet_deployment_pools WHERE sender=$1 LIMIT 1', [sender])).rowCount) invalid();
      value = (await client.query<Lane>(`INSERT INTO rest_wallet_recovery_lanes(sender,configuration,environment,next_nonce,anchor)
        VALUES($1,$2,$3,$4,$5) RETURNING *`, [sender, config, environment, String(quantity(confirmed)), latest])).rows[0]!;
    }
    if (!same(value.configuration, config)) invalid();
    if (value.fence) unavailable();
    if (!same(value.environment, environment)) return fence(client, 'local-environment-changed');
    const anchor = await rpc.request('eth_getBlockByNumber', [toHex(BigInt(value.anchor.blockNumber)), false]);
    if (anchor === null || !same(head(anchor), value.anchor) || BigInt(latest.blockNumber) < BigInt(value.anchor.blockNumber))
      return fence(client, 'canonical-anchor-replaced');
    const now = Date.now(), timestamp = BigInt(latest.timestamp) * 1000n;
    if (timestamp > BigInt(now + 30000) || timestamp + 300000n <= BigInt(now)) unavailable();
    return { value, latest };
  }
  async function canonical(client: PoolClient, rpc: Scope, value: Lane, latest: RestBlockEvidence) {
    if (!same(await adapter.identity(rpc), value.environment)) return fence(client, 'local-environment-changed');
    const observed = await rpc.request('eth_getBlockByNumber', [toHex(BigInt(latest.blockNumber)), false]);
    if (observed === null || !same(head(observed), latest)) return fence(client, 'canonical-anchor-replaced');
    rpc.check();
  }
  async function inspect(record: Awaited<ReturnType<typeof required>>, rpc: Scope, latest: RestBlockEvidence, replacement: boolean) {
    const scoped: RestRpc = { request(chain, method, params) { if (chain !== 8453) unavailable(); return rpc.request(method, params); } };
    const smart = createSmartAccountService({ rpc: scoped, manifests: [manifest], registry: new MemorySmartAccountRegistry(), audience: record.intent.origin,
      moduleInspectors: [createSafe7579Inspector({ rpc: scoped, utility, inspectSessions: createInstalledSessionVerifier({ rpc: scoped }).inspectAllAt })] });
    const state = await smart.inspect({ manifestId: manifest.id, address: record.intent.accountId.slice(12) as Hex }, undefined, latest);
    const checked = assertPasskeyOnboardingState(state), details = state.modules!.details;
    if (checked.initializerHash !== record.intent.initializerHash || !same(state.evidence, latest)
      || !object(details) || !object(details.provenance) || details.provenance.method !== 'canonical-factory-creation-and-complete-authority-ingress-traces'
      || details.provenance.throughBlock !== latest.blockNumber || details.provenance.throughBlockHash !== latest.blockHash
      || typeof details.provenance.creationTransaction !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(details.provenance.creationTransaction)
      || !addressSame(checked.profile.recoveryOwner.address, record.intent.recoveryOwner)
      || !addressSame(checked.profile.signer.address, replacement ? record.candidate.signerAddress : record.intent.priorSigner)) unavailable();
    if (replacement && (!addressSame(checked.profile.signer.x, record.candidate.credential.publicKey.x)
      || !addressSame(checked.profile.signer.y, record.candidate.credential.publicKey.y))) unavailable();
    return { state, creation: details.provenance.creationTransaction.toLowerCase() as Hex };
  }
  const dispatch = async (client: PoolClient, id: string) => (await client.query<Dispatch>('SELECT * FROM rest_wallet_recovery_dispatch WHERE recovery_id=$1 AND sender=$2', [id, sender])).rows[0];
  const transactions = async (client: PoolClient, id: string) => (await client.query<Transaction>('SELECT * FROM rest_wallet_recovery_transactions WHERE recovery_id=$1 ORDER BY step', [id])).rows;
  async function reconcile(client: PoolClient, rpc: Scope, id: string): Promise<LocalWalletRecoveryStatus> {
    const record = await required(id), operation = await dispatch(client, id), txs = await transactions(client, id);
    const result: LocalWalletRecoveryStatus = { recoveryId: id, state: operation?.approval ? 'unknown' : 'review',
      transactions: { createSigner: txs[0]?.hash ?? null, rotateOwner: txs[1]?.hash ?? null }, reason: null };
    try {
      const { value, latest } = await lane(client, rpc);
      if (!operation) return result;
      for (const tx of txs) {
        if (!tx.attempted_at_ms) continue;
        const receipt = await rpc.request('eth_getTransactionReceipt', [tx.hash]);
        if (receipt === null) { if (tx.receipt) await fence(client, 'canonical-transaction-disappeared'); continue; }
        const limits = envelope(tx.raw_transaction);
        if (!object(receipt) || !addressSame(receipt.transactionHash, tx.hash) || !addressSame(receipt.from, sender)
          || quantity(receipt.gasUsed) > limits.gas || quantity(receipt.effectiveGasPrice) > limits.maxFeePerGas) unavailable();
        const block = head(await rpc.request('eth_getBlockByNumber', [receipt.blockNumber, false]));
        if (!addressSame(receipt.blockHash, block.blockHash) || BigInt(block.blockNumber) > BigInt(latest.blockNumber)) unavailable();
        const raw = await rpc.request('eth_getRawTransactionByHash', [tx.hash]);
        if (raw !== tx.raw_transaction) unavailable();
        const status = quantity(receipt.status); if (status !== 0n && status !== 1n) unavailable();
        const summary = { block, gasUsed: quantity(receipt.gasUsed), effectiveGasPrice: quantity(receipt.effectiveGasPrice), status: status === 1n ? 'success' as const : 'revert' as const };
        const fees = await adapter.fees(rpc, tx.raw_transaction, summary);
        if (BigInt(fees.executionWei) !== summary.gasUsed * summary.effectiveGasPrice) unavailable();
        const accepted: Receipt = { block, status: summary.status, ...fees };
        if (tx.receipt && !same(tx.receipt, accepted)) await fence(client, 'canonical-transaction-replaced');
        await canonical(client, rpc, value, latest);
        if (!tx.receipt) await transaction(client, async () => {
          const written = await client.query('UPDATE rest_wallet_recovery_transactions SET receipt=$3 WHERE recovery_id=$1 AND step=$2 AND receipt IS NULL', [id, tx.step, accepted]);
          // The actual debit is retained even above the budget; the lane then fences instead of admitting more.
          if (written.rowCount) await client.query(`UPDATE rest_wallet_recovery_lanes SET spent_wei=spent_wei+$2::numeric,
            fence=CASE WHEN spent_wei+$2::numeric>(configuration->>'maximumCostWei')::numeric THEN COALESCE(fence,'allocation-exceeded') ELSE fence END
            WHERE sender=$1`, [sender, String(total(fees))]);
        });
        tx.receipt = accepted;
      }
      if (txs.some(tx => tx.receipt?.status === 'revert')) {
        await client.query('UPDATE rest_wallet_recovery_lanes SET fence=COALESCE(fence,$2) WHERE sender=$1', [sender, 'approved-transaction-reverted']);
        return { ...result, state: 'failed', reason: 'approved-transaction-reverted' };
      }
      if (txs.length === 2 && txs.every(tx => tx.receipt?.status === 'success')) {
        const observed = await inspect(record, rpc, latest, true);
        if (observed.creation !== operation.creation_transaction || BigInt(observed.state.safeNonce) !== BigInt(operation.review.safeNonce) + 1n) unavailable();
        let release = true;
        if (adapter.releaseAfterFinality) {
          const finalized = head(await rpc.request('eth_getBlockByNumber', ['finalized', false]));
          release = txs.every(tx => BigInt(tx.receipt!.block.blockNumber) <= BigInt(finalized.blockNumber));
          for (const tx of release ? txs : []) {
            const included = await rpc.request('eth_getBlockByNumber', [toHex(BigInt(tx.receipt!.block.blockNumber)), false]);
            if (included === null || !same(head(included), tx.receipt!.block)) return fence(client, 'canonical-transaction-replaced');
          }
        }
        await canonical(client, rpc, value, latest);
        if (release) await client.query('UPDATE rest_wallet_recovery_lanes SET active_recovery=NULL,anchor=$2 WHERE sender=$1 AND active_recovery=$3', [sender, latest, id]);
        result.state = 'ready';
      }
      return result;
    } catch (error) {
      if (!(error instanceof RestError)) throw error;
      return { ...result, state: 'unknown', reason: error.code };
    }
  }
  async function progress(client: PoolClient, rpc: Scope, id: string) {
    let result = await reconcile(client, rpc, id);
    if (result.state !== 'unknown' || result.reason) return result;
    const operation = await dispatch(client, id); if (!operation?.approval) return result;
    for (let step = 0; step < 2; step++) {
      const txs = await transactions(client, id), tx = txs[step]!;
      if (tx.attempted_at_ms || (step === 1 && txs[0]!.receipt?.status !== 'success')) continue;
      const record = await required(id); await current(record);
      const { value, latest } = await lane(client, rpc);
      if (value.active_recovery !== id) invalid();
      const observed = await inspect(record, rpc, latest, false);
      if (observed.creation !== operation.creation_transaction || !same(prepareWalletRecoveryRotation(record.candidate, {
        owners: observed.state.owners, threshold: observed.state.threshold, safeNonce: observed.state.safeNonce }), operation.review)) invalid();
      if (step === 1) {
        const snapshot = { evidence: latest, tag: tag(latest), request: (method: string, params: readonly unknown[]) => rpc.request(method, [...params, tag(latest)]) };
        const signer = await inspectPasskeyCreationSigner({ manifest, publicKey: record.candidate.credential.publicKey, snapshot });
        if (!addressSame(signer.address, record.candidate.signerAddress) || await snapshot.request('eth_getCode', [signer.address]) === '0x') unavailable();
      }
      const limits = envelope(tx.raw_transaction);
      const [confirmed, pending, balance] = await Promise.all([rpc.request('eth_getTransactionCount', [sender, tag(latest)]),
        rpc.request('eth_getTransactionCount', [sender, 'pending']), rpc.request('eth_getBalance', [sender, tag(latest)])]);
      if (String(quantity(confirmed)) !== tx.nonce || String(quantity(pending)) !== tx.nonce) await fence(client, 'sender-nonce-changed');
      if (quantity(balance) < limits.gas * limits.maxFeePerGas) unavailable();
      const call = step === 0 ? operation.approval.createSigner : operation.approval.rotateOwner;
      const input = { from: sender, to: call.to, data: call.data, value: '0x0', gas: toHex(limits.gas) };
      const simulation = await rpc.request('eth_call', [input, tag(latest)]);
      if (step === 1 && simulation !== `0x${'0'.repeat(63)}1`) unavailable();
      if (quantity(await rpc.request('eth_estimateGas', [input, toHex(BigInt(latest.blockNumber))])) > limits.gas) unavailable();
      await canonical(client, rpc, value, latest);
      // Commit the one-shot attempt BEFORE the network call. A crash here permanently
      // retains an unknown original hash; neither retries nor restarts mint replacement bytes.
      const attempted = await client.query(`UPDATE rest_wallet_recovery_transactions SET attempted_at_ms=floor(extract(epoch FROM clock_timestamp())*1000)::bigint
        WHERE recovery_id=$1 AND step=$2 AND attempted_at_ms IS NULL RETURNING hash`, [id, step]);
      if (attempted.rowCount !== 1) invalid();
      try { rpc.check(); await adapter.send(tx.raw_transaction, AbortSignal.timeout(2000)); }
      catch { /* reconcile only the durable hash after any uncertain network result */ }
      // One physical send per bounded worker pass. A subsequent observation reconciles
      // this hash before the next exact approved step can be attempted.
      return result;
    }
    return result;
  }
  // ponytail: in-memory throttle; a ready-but-unfinalized lane is re-inspected at most once a minute.
  let readySince: { id: string; at: number } | null = null;
  return {
    async prepare(id: string): Promise<WalletRecoveryRotation> {
      return locked(async (client, rpc) => {
        const record = await required(id), saved = await dispatch(client, id);
        if (saved) return saved.review;
        await current(record);
        const { value, latest } = await lane(client, rpc), observed = await inspect(record, rpc, latest, false);
        const review = prepareWalletRecoveryRotation(record.candidate, { owners: observed.state.owners, threshold: observed.state.threshold, safeNonce: observed.state.safeNonce });
        await canonical(client, rpc, value, latest);
        await client.query(`INSERT INTO rest_wallet_recovery_dispatch(recovery_id,sender,review,creation_transaction,created_at_ms)
          VALUES($1,$2,$3,$4,floor(extract(epoch FROM clock_timestamp())*1000)::bigint)`, [id, sender, review, observed.creation]);
        return review;
      });
    },
    async approve(id: string, input: WalletRecoveryRotation, backupSignature: Hex, flowToken?: string): Promise<LocalWalletRecoveryStatus> {
      const record = await required(id), approved = await verifyWalletRecoveryRotation(record.candidate, input, backupSignature);
      const review = structuredClone(input), approval = { ...approved, backupSignature };
      return locked(async (client, rpc) => {
        const saved = await dispatch(client, id);
        if (!saved || !same(saved.review, review)) invalid();
        if (saved.approval) { if (!same(saved.approval, approval)) invalid(); return progress(client, rpc, id); }
        await current(record);
        const { value, latest } = await lane(client, rpc);
        if (value.active_recovery || value.operations >= config.maximumOperations) unavailable();
        const observed = await inspect(record, rpc, latest, false);
        if (!same(prepareWalletRecoveryRotation(record.candidate, { owners: observed.state.owners, threshold: observed.state.threshold, safeNonce: observed.state.safeNonce }), review)) invalid();
        const confirmed = quantity(await rpc.request('eth_getTransactionCount', [sender, tag(latest)]));
        if (confirmed !== BigInt(value.next_nonce) || confirmed !== quantity(await rpc.request('eth_getTransactionCount', [sender, 'pending'])))
          return fence(client, 'sender-nonce-changed');
        if (confirmed + 2n > BigInt(Number.MAX_SAFE_INTEGER)) unavailable();
        const quote = await adapter.quote(rpc, latest);
        if (quote.gas <= 0n || quote.maxFeePerGas <= 0n || quote.maxPriorityFeePerGas > quote.maxFeePerGas) unavailable();
        const raw = await Promise.all([approved.createSigner, approved.rotateOwner].map((call, step) => sign({ type: 'eip1559', chainId: 8453,
          to: call.to, data: call.data, value: 0n, nonce: Number(confirmed) + step, gas: quote.gas, maxFeePerGas: quote.maxFeePerGas,
          maxPriorityFeePerGas: quote.maxPriorityFeePerGas, accessList: [] })));
        let reservation = 0n;
        for (let step = 0; step < raw.length; step++) {
          const bytes = raw[step]!;
          if (!/^0x02[0-9a-f]+$/.test(bytes) || bytes.length > 32768) invalid();
          const serializedTransaction = bytes as `0x02${string}`, tx = parseTransaction(serializedTransaction);
          const call = step === 0 ? approved.createSigner : approved.rotateOwner;
          if (!addressSame(await recoverTransactionAddress({ serializedTransaction }), sender) || tx.type !== 'eip1559'
            || tx.chainId !== 8453 || tx.nonce !== Number(confirmed) + step || !addressSame(tx.to, call.to) || tx.data !== call.data
            || (tx.value ?? 0n) !== 0n || tx.gas !== quote.gas || tx.maxFeePerGas !== quote.maxFeePerGas || tx.maxPriorityFeePerGas !== quote.maxPriorityFeePerGas
            || (tx.accessList?.length ?? 0) !== 0) invalid();
          // Execution maximum plus twice the current L1/operator estimate; local chains have execution only.
          const priced = adapter.reserve ? await adapter.reserve(rpc, latest, bytes) : null;
          reservation += quote.gas * quote.maxFeePerGas + (priced ? 2n * (BigInt(priced.l1WeiAtParameters) + BigInt(priced.operatorMaximumWei)) : 0n);
        }
        if (BigInt(value.reserved_wei) + reservation > BigInt(config.maximumCostWei)) unavailable();
        await canonical(client, rpc, value, latest);
        await transaction(client, async () => {
          const captured = await loadWalletAuthorityContextInTransaction(client, record.intent.accountId);
          if (enrollmentDigest(captured.credential) !== record.intent.priorCredentialDigest
            || enrollmentDigest(captured.enrollment) !== record.intent.enrollmentDigest
            || captured.binding.authorization.digest !== record.intent.priorBindingDigest) invalid();
          const recovery = (await client.query<{ id: string; token_hash: string }>('SELECT id,token_hash FROM rest_wallet_recoveries WHERE id=$1 FOR UPDATE', [id])).rows[0]!;
          // Browser continuations are rechecked under the same recovery→flow lock order
          // as token rotation. Host-only fixtures have no browser flow to authorize.
          if (flowToken !== undefined) await assertRecoveryContinuationInTransaction(client, recovery, flowToken);
          else if ((await client.query('SELECT 1 FROM rest_wallet_recovery_flows WHERE id=$1', [id])).rowCount) invalid();
          await client.query('UPDATE rest_wallet_recovery_dispatch SET approval=$2,approved_at_ms=floor(extract(epoch FROM clock_timestamp())*1000)::bigint WHERE recovery_id=$1', [id, approval]);
          for (let step = 0; step < 2; step++) await client.query(`INSERT INTO rest_wallet_recovery_transactions(recovery_id,step,sender,nonce,hash,raw_transaction)
            VALUES($1,$2,$3,$4,$5,$6)`, [id, step, sender, String(confirmed + BigInt(step)), keccak256(raw[step]!), raw[step]!]);
          await client.query('UPDATE rest_wallet_recovery_lanes SET next_nonce=$2,operations=operations+1,reserved_wei=reserved_wei+$3,active_recovery=$4,anchor=$5 WHERE sender=$1',
            [sender, String(confirmed + 2n), String(reservation), id, latest]);
          if (flowToken !== undefined) await assertRecoveryContinuationInTransaction(client, recovery, flowToken);
          // Intake's deadline remains immutable. Accepted proof may be followed later
          // by this separate exact SafeTx owner signature and fresh canonical observation.
          rpc.check();
        });
        return { recoveryId: id, state: 'unknown', transactions: { createSigner: keccak256(raw[0]!), rotateOwner: keccak256(raw[1]!) }, reason: null };
      });
    },
    // HTTP GET may reconcile receipts, but only an explicit POST/host worker progresses retained approval.
    status(id: string) { return locked((client, rpc) => reconcile(client, rpc, id)); },
    async tick(signal?: AbortSignal): Promise<void> {
      signal?.throwIfAborted();
      const active = (await pool.query<{ active_recovery: string | null }>('SELECT active_recovery FROM rest_wallet_recovery_lanes WHERE sender=$1 AND fence IS NULL', [sender])).rows[0]?.active_recovery;
      if (!active) { readySince = null; return; }
      if (readySince?.id === active && Date.now() - readySince.at < 60_000) return;
      const result = await locked((client, rpc) => progress(client, rpc, active), signal);
      readySince = result.state === 'ready' ? { id: active, at: Date.now() } : null;
    },
  };
}
