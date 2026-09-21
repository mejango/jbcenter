import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { RestError } from '../../src/rest/core.js';
import { createRestRpc } from '../../src/rest/rpc.js';
import { RelayrProvider } from '../../src/rest/sponsorship/provider.js';
import { decimal, same, uuid } from '../../src/rest/sponsorship/validation.js';
import { fundWalletDependencyQuote, prepareWalletDependencyFunding, WALLET_DEPENDENCY_FUNDING_PAYER } from '../../src/rest/wallet/dependencyFunding.js';
import { reconcileWalletDependencyFunding, rebroadcastWalletDependencyFunding } from '../../src/rest/wallet/dependencyFundingRecovery.js';
import { renewWalletDependencyQuote } from '../../src/rest/wallet/dependencyRenewal.js';
import { takeWalletDependencySecrets, walletDependencyJournalDirectory, walletOperatorSource } from './wallet-dependency-operator.js';
import { walletDependencyRpcUpstreams } from './wallet-dependency-rpc.js';

// Remove secrets from the process environment before any source-check child runs.
const secrets = takeWalletDependencySecrets();
try {
  const { positionals, values } = parseArgs({ allowPositionals: true, strict: true, options: {
    'audited-fingerprint': { type: 'string' }, 'body-hash': { type: 'string' }, 'bundle': { type: 'string' },
    'maximum-total-wei': { type: 'string' }, 'max-fee-per-gas-wei': { type: 'string' }, 'priority-fee-per-gas-wei': { type: 'string' },
  } });
  const action = positionals[0], expected = values['audited-fingerprint'], bodyHash = values['body-hash'], bundleUuid = values.bundle;
  if (positionals.length !== 1 || !action || !['prepare', 'fund', 'status', 'resume', 'renew'].includes(action)
    || !expected || !/^[0-9a-f]{64}$/.test(expected) || !bodyHash || !/^[0-9a-f]{64}$/.test(bodyHash) || !uuid(bundleUuid))
    throw new RestError(400, 'WALLET_DEPENDENCY_OPERATOR_ARGUMENTS', 'Choose prepare|fund|status|resume|renew and an audited fingerprint, body hash and exact bundle UUID.');
  const root = resolve(import.meta.dirname, '../..');
  async function reviewed() {
    const source = await walletOperatorSource(root);
    if (source.dirty || source.fingerprint !== expected)
      throw new RestError(409, 'WALLET_DEPENDENCY_SOURCE_CHANGED', 'Source differs from the clean operator-reviewed release.');
    return { revision: source.revision, fingerprint: source.fingerprint };
  }
  const source = await reviewed();
  const options = { directory: walletDependencyJournalDirectory(), bodyHash, bundleUuid, source,
    payer: WALLET_DEPENDENCY_FUNDING_PAYER, rpc: createRestRpc({ upstreams: walletDependencyRpcUpstreams(secrets.dwellirKey) }),
    provider: new RelayrProvider(), signal: AbortSignal.timeout(180000), assertReviewedSource: async () => { await reviewed(); } };
  if (action === 'prepare' || action === 'fund') {
    const maximumTotalWei = values['maximum-total-wei'], maxFeePerGasWei = values['max-fee-per-gas-wei'], maxPriorityFeePerGasWei = values['priority-fee-per-gas-wei'];
    if (!maximumTotalWei || !maxFeePerGasWei || !maxPriorityFeePerGasWei)
      throw new RestError(400, 'WALLET_DEPENDENCY_OPERATOR_BUDGET', 'Explicit total, maximum gas fee and priority fee limits are required.');
    for (const value of [maximumTotalWei, maxFeePerGasWei, maxPriorityFeePerGasWei]) decimal(value, 'fee limit');
    const funding = { ...options, maximumTotalWei, maxFeePerGasWei, maxPriorityFeePerGasWei };
    const template = await prepareWalletDependencyFunding(funding);
    await reviewed();
    if (action === 'prepare') console.log(JSON.stringify({ state: 'prepared', template, signed: false, sent: false }));
    else {
      // Validate the local signer after admission but before permanent claims, so
      // a missing or wrong key cannot consume the bundle's sole funding attempt.
      if (!secrets.fundingKey || !/^0x[0-9a-fA-F]{64}$/.test(secrets.fundingKey))
        throw new RestError(409, 'WALLET_DEPENDENCY_SIGNER_UNAVAILABLE', 'The dedicated deployment signer is unavailable.');
      const account = privateKeyToAccount(secrets.fundingKey as `0x${string}`);
      secrets.fundingKey = undefined;
      if (!same(account.address, WALLET_DEPENDENCY_FUNDING_PAYER))
        throw new RestError(409, 'WALLET_DEPENDENCY_SIGNER_MISMATCH', 'The signer differs from the pinned deployment payer.');
      const result = await fundWalletDependencyQuote({ ...funding, sign: transaction => account.signTransaction(transaction) });
      console.log(JSON.stringify({ state: result.record.state, bundleUuid, chainId: result.record.template.transaction.chainId,
        hash: result.record.signed.hash, maximumCostWei: result.record.template.maximumCostWei, journal: result.path, paymentFinalized: false }));
    }
  } else {
    secrets.fundingKey = undefined;
    if (values['maximum-total-wei'] || values['max-fee-per-gas-wei'] || values['priority-fee-per-gas-wei'])
      throw new RestError(400, 'WALLET_DEPENDENCY_OPERATOR_ARGUMENTS', 'Only prepare and fund accept new fee limits.');
    if (action === 'renew') {
      const result = await renewWalletDependencyQuote(options);
      console.log(JSON.stringify({ state: result.record.state, bundleUuid: result.record.quote.bundleUuid,
        payments: result.record.quote.payments, journal: result.path, fundingEnabled: false }));
    } else if (action === 'resume') {
      const result = await rebroadcastWalletDependencyFunding(options);
      console.log(JSON.stringify({ state: result.record.state, kind: result.record.kind, hash: result.record.signed.hash,
        journal: result.path, paymentFinalized: false }));
    } else {
      const result = await reconcileWalletDependencyFunding(options); await reviewed();
      console.log(JSON.stringify({ state: result.record.state, hash: result.record.hash, actualCostWei: result.record.actualCostWei,
        paymentFinalized: result.record.paymentFinalized, providerReportedPayment: result.record.providerReportedPayment, journal: result.path }));
    }
  }
} catch (error) {
  console.error(JSON.stringify({ code: error instanceof RestError ? error.code : 'WALLET_DEPENDENCY_OPERATOR_STOPPED' }));
  console.error('Inspect the permanent journal before continuing. An interrupted send is unknown; never create a replacement payment.');
  process.exitCode = 1;
} finally { secrets.fundingKey = undefined; secrets.dwellirKey = undefined; }
