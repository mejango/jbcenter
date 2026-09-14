import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { spawnSync } from 'node:child_process';
import { walletDependencyJournalDirectory, walletOperatorGitEnvironment, takeWalletDependencySecrets } from '../scripts/rest/wallet-dependency-operator.js';
import { join } from 'node:path';
import { fromRlp, keccak256, toHex, toRlp, parseTransaction, serializeTransaction, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { RELAYR_PAYMENT_RUNTIME } from './fixtures/relayr-payment.js';
import { RELAYR_PAYMENT_ADDRESS, RELAYR_NATIVE_TOKEN, RELAYR_PAYMENT_SELECTOR } from '../src/rest/sponsorship/constants.js';
import { inspectWalletDependencyChain, prepareWalletDependencyBundle, WALLET_DEPENDENCY_CHAINS } from '../src/rest/wallet/dependencyBundle.js';
import { preparePasskeyDependencyDeployment } from '../src/rest/smartAccounts/passkeyProfile.js';
import { publishWalletDependencyQuote } from '../src/rest/wallet/dependencyPublication.js';
import { prepareWalletDependencyFunding, fundWalletDependencyQuote, validateWalletDependencyFundingSignature } from '../src/rest/wallet/dependencyFunding.js';
import { reconcileWalletDependencyFunding, rebroadcastWalletDependencyFunding } from '../src/rest/wallet/dependencyFundingRecovery.js';
import { RELAYR_PAYMENT_EVENT } from '../src/rest/sponsorship/paymentContract.js';
import { renewWalletDependencyQuote } from '../src/rest/wallet/dependencyRenewal.js';
import type { RestRpc } from '../src/rest/core.js';

const NOW = 1789419600000, BLOCK = keccak256('0x1234');
// Public fixture only; no signing key or transaction reaches a real provider.
const payer = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const stranger = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const folders: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); for (const p of folders.splice(0)) await rm(p, { recursive: true, force: true }); });
async function fixture(family: 'mainnet' | 'testnet' = 'mainnet') {
  const directory = await mkdtemp(join(tmpdir(), 'center-dependency-funding-')); folders.push(directory);
  const recipe = await preparePasskeyDependencyDeployment();
  const flags = { now: NOW, balance: 10n ** 18n, nonce: 0n, pendingNonce: 0n, code: '0x', paymentCode: RELAYR_PAYMENT_RUNTIME,
    baseFee: 80n, paymentGas: 100000n, paymentReceived: false, state: 'Pending', foreignChain: false, wrongBlock: false, simulation: '0x', send: 'success' };
  const calls: { chain: number; method: string; params: readonly unknown[] }[] = [];
  const rpc: RestRpc = { async request(chain, method, params) {
    calls.push({ chain, method, params });
    if (method === 'eth_chainId') return toHex(flags.foreignChain ? 999 : chain);
    if (method === 'eth_getBlockByNumber') return { number: '0x100', hash: flags.wrongBlock && params[0] !== 'latest' ? keccak256('0x5678') : BLOCK,
      timestamp: toHex(flags.now / 1000), baseFeePerGas: toHex(flags.baseFee) };
    if (method === 'eth_getCode') {
      const address = String(params[0]).toLowerCase();
      if (address === recipe.deployer.address.toLowerCase()) return recipe.deployer.runtime;
      if (address === RELAYR_PAYMENT_ADDRESS.toLowerCase()) return flags.paymentCode;
      if (address === payer.address.toLowerCase()) return flags.code;
      return '0x';
    }
    if (method === 'eth_getBalance') return toHex(flags.balance);
    if (method === 'eth_getTransactionCount') return toHex(params[1] === 'pending' ? flags.pendingNonce : flags.nonce);
    if (method === 'eth_call') {
      const call = params[0] as { to: string; data: Hex };
      if (call.to.toLowerCase() === RELAYR_PAYMENT_ADDRESS.toLowerCase()) return flags.simulation;
      return recipe.deployments.find(item => item.transaction.data === call.data)!.pin.address;
    }
    if (method === 'eth_estimateGas') return (params[0] as { to: string }).to.toLowerCase() === RELAYR_PAYMENT_ADDRESS.toLowerCase() ? toHex(flags.paymentGas) : '0x1e8480';
    if (method === 'eth_sendRawTransaction') {
      if (flags.send === 'lost') throw new Error('private upstream message');
      if (flags.send === 'wrong-hash') return keccak256('0x9876');
      return keccak256(params[0] as Hex);
    }
    throw new Error('Unexpected RPC: ' + method);
  } };
  const observations = await Promise.all(WALLET_DEPENDENCY_CHAINS.map(chainId => inspectWalletDependencyChain({ chainId, rpc, now: () => flags.now })));
  const plan = await prepareWalletDependencyBundle(observations, flags.now), bundle = plan.bundles.find(item => item.family === family)!;
  const id = 'a0a555ff-4444-4111-aaaa-333333333333', deadline = NOW / 1000 + 900;
  const statusIds = new Set([id]);
  const txIds = bundle.body.transactions.map((_item, i) => `b0a555ff-4444-4111-aaaa-${String(i).padStart(12, '0')}`);
  const response = { bundle_uuid: id, tx_uuids: [...txIds].reverse(), payment_info: [{ chain: family === 'mainnet' ? 1 : 11155111,
    token: RELAYR_NATIVE_TOKEN, target: RELAYR_PAYMENT_ADDRESS, amount: '0x3e8',
    calldata: RELAYR_PAYMENT_SELECTOR + id.replaceAll('-', '').padEnd(64, '0') + deadline.toString(16).padStart(64, '0'),
    payment_deadline: new Date(deadline * 1000).toISOString() }] };
  const provider = { createIndependent: vi.fn(async () => response), status: vi.fn(async (bundleUuid: string) => ({ bundle_uuid: statusIds.has(bundleUuid) ? bundleUuid : 'wrong-uuid',
    payment_received: flags.paymentReceived, transactions: bundle.body.transactions.map((entry, index) => ({
      tx_uuid: txIds[index], request: { ...entry, value: '0x0', virtual_nonce: null }, status: { state: flags.state },
    })) })) };
  const source = { revision: 'a'.repeat(40), fingerprint: 'b'.repeat(64) };
  await publishWalletDependencyQuote({ observations, directory, family, source, provider, now: () => flags.now });
  calls.length = 0;
  const options = { directory, bodyHash: bundle.bodyHash.slice(2), bundleUuid: id, source, provider, rpc, payer: payer.address,
    maximumTotalWei: '40000000', maxFeePerGasWei: '200', maxPriorityFeePerGasWei: '10', now: () => flags.now };
  const signer = vi.fn(async (transaction: Parameters<typeof payer.signTransaction>[0]) => payer.signTransaction(transaction));
  return { flags, calls, options, signer, directory, provider, response, statusIds };
}
describe('bounded operator dependency funding', () => {
  it('uses one durable journal outside checkouts and strips secrets before source-inspection children', () => {
    expect(walletDependencyJournalDirectory()).toBe(join(userInfo().homedir, '.juicebox-center', 'wallet-dependencies'));
    const environment = { CENTER_WALLET_DEPLOYMENT_FUNDING_PRIVATE_KEY: 'fixture-only-key', DWELLIR_API_KEY: 'fixture-only-provider-key' };
    expect(takeWalletDependencySecrets(environment)).toEqual({ fundingKey: 'fixture-only-key', dwellirKey: 'fixture-only-provider-key' });
    expect(environment).toEqual({});
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env)))'],
      { env: walletOperatorGitEnvironment(), encoding: 'utf8' });
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).not.toContain('CENTER_WALLET_DEPLOYMENT_FUNDING_PRIVATE_KEY');
    expect(JSON.parse(child.stdout)).not.toContain('DWELLIR_API_KEY');
    expect(Object.keys(walletOperatorGitEnvironment()).sort()).toEqual(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT', 'PATH']);
    expect(walletOperatorGitEnvironment().PATH).toBe('/usr/bin:/bin');
  });
  it('refuses an unreviewed CLI source without using a PATH git shim or exposing inherited secrets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'center-operator-git-')); folders.push(directory);
    const marker = join(directory, 'untrusted-git-ran');
    await writeFile(join(directory, 'git'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`); await chmod(join(directory, 'git'), 0o700);
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/rest/wallet-dependency-funding.ts', 'fund',
      '--audited-fingerprint', '0'.repeat(64), '--body-hash', 'a'.repeat(64), '--bundle', 'a0a555ff-4444-4111-aaaa-333333333333'],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 15000, env: { ...walletOperatorGitEnvironment(),
      PATH: `${directory}:/usr/bin:/bin`, CENTER_WALLET_DEPLOYMENT_FUNDING_PRIVATE_KEY: 'fixture-private-key', DWELLIR_API_KEY: 'fixture-provider-key' } });
    expect(result.status).toBe(1); expect(result.stderr).toContain('WALLET_DEPENDENCY_SOURCE_CHANGED');
    expect(result.stdout + result.stderr).not.toContain('fixture-private-key');
    expect(result.stdout + result.stderr).not.toContain('fixture-provider-key');
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['mainnet', 'testnet'] as const)('prepares exact %s payment with a hard type-2 total bound without signing or sending', async family => {
    const f = await fixture(family), template = await prepareWalletDependencyFunding(f.options);
    expect(template.transaction).toMatchObject({ chainId: family === 'mainnet' ? 1 : 11155111, to: RELAYR_PAYMENT_ADDRESS,
      value: '1000', gas: '150000', maxFeePerGas: '200', maxPriorityFeePerGas: '10', nonce: 0 });
    expect(template.maximumCostWei).toBe('30001000');
    expect(f.calls.some(c => c.method === 'eth_sendRawTransaction')).toBe(false);
  });
  it.each(['balance', 'nonce', 'used-payer', 'code', 'paymentCode', 'paymentGas', 'baseFee', 'paymentReceived', 'state', 'foreignChain', 'wrongBlock', 'simulation', 'expired', 'short-margin', 'cap'])('rejects unsafe %s before asking for a signature', async fault => {
    const f = await fixture();
    if (fault === 'balance') f.flags.balance = 0n;
    if (fault === 'nonce') f.flags.pendingNonce = 1n;
    if (fault === 'used-payer') f.flags.nonce = f.flags.pendingNonce = 1n;
    if (fault === 'code') f.flags.code = '0x6000';
    if (fault === 'paymentCode') f.flags.paymentCode = '0x6000';
    if (fault === 'paymentGas') f.flags.paymentGas = 150001n;
    if (fault === 'baseFee') f.flags.baseFee = 201n;
    if (fault === 'paymentReceived') f.flags.paymentReceived = true;
    if (fault === 'state') f.flags.state = 'Success';
    if (fault === 'foreignChain') f.flags.foreignChain = true;
    if (fault === 'wrongBlock') f.flags.wrongBlock = true;
    if (fault === 'simulation') f.flags.simulation = '0x00';
    if (fault === 'expired') f.flags.now += 800000;
    if (fault === 'short-margin') f.flags.now += 650000;
    if (fault === 'cap') f.options.maximumTotalWei = '1000';
    await expect(fundWalletDependencyQuote({ ...f.options, sign: f.signer })).rejects.toThrow();
    expect(f.signer).not.toHaveBeenCalled();
    expect(f.calls.filter(c => c.method === 'eth_sendRawTransaction')).toHaveLength(0);
  });
  it('persists exact verified signed bytes before the only broadcast and refuses concurrent or later payments', async () => {
    const f = await fixture(), originalRequest = f.options.rpc.request;
    f.options.rpc.request = async (chain, method, params, signal) => {
      if (method === 'eth_sendRawTransaction') {
        const r = JSON.parse(await readFile(join(f.directory, 'funding', f.response.bundle_uuid, 'funding.json'), 'utf8'));
        expect(r.state).toBe('sending'); expect(r.signed.rawTransaction).toBe(params[0]);
        expect(r.signed.hash).toBe(keccak256(params[0] as Hex));
      }
      return originalRequest(chain, method, params, signal);
    };
    const result = await Promise.allSettled([1,2].map(() => fundWalletDependencyQuote({ ...f.options, sign: f.signer })));
    expect(result.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect(f.signer).toHaveBeenCalledTimes(1);
    expect(f.calls.filter(c => c.method === 'eth_sendRawTransaction')).toHaveLength(1);
    await expect(fundWalletDependencyQuote({ ...f.options, sign: f.signer })).rejects.toThrow();
    expect(f.signer).toHaveBeenCalledTimes(1);
  });
  it.each(['lost', 'wrong-hash'])('retains the signed identity on %s broadcast response and never pays again', async send => {
    const f = await fixture(); f.flags.send = send;
    await expect(fundWalletDependencyQuote({ ...f.options, sign: f.signer })).rejects.toThrow();
    const r = JSON.parse(await readFile(join(f.directory, 'funding', f.response.bundle_uuid, 'funding.json'), 'utf8'));
    expect(r.state).toBe('sending'); expect(r.signed.hash).toBe(keccak256(r.signed.rawTransaction));
    await expect(fundWalletDependencyQuote({ ...f.options, sign: f.signer })).rejects.toThrow();
    expect(f.calls.filter(c => c.method === 'eth_sendRawTransaction')).toHaveLength(1);
  });
  it('rejects a changed signer or any changed signed payment field', async () => {
    const f = await fixture(), template = await prepareWalletDependencyFunding(f.options);
    const tx = { type: 'eip1559' as const, chainId: template.transaction.chainId, nonce: template.transaction.nonce,
      to: template.transaction.to, data: template.transaction.data, value: 1000n, gas: 150000n, maxFeePerGas: 200n, maxPriorityFeePerGas: 10n, accessList: [] };
    const raw = await payer.signTransaction(tx);
    await expect(validateWalletDependencyFundingSignature(template, raw)).resolves.toMatchObject({ hash: keccak256(raw) });
    await expect(validateWalletDependencyFundingSignature(template, await stranger.signTransaction(tx))).rejects.toThrow();
    for (const patch of [{ value: 1001n }, { gas: 150001n }, { nonce: 1 }, { chainId: 11155111 }, { data: '0x00' as Hex },
      { to: stranger.address }, { maxFeePerGas: 201n }, { maxPriorityFeePerGas: 11n }, { accessList: [{ address: stranger.address, storageKeys: [] }] }])
      await expect(validateWalletDependencyFundingSignature(template, await payer.signTransaction({ ...tx, ...patch }))).rejects.toThrow();
    expect(parseTransaction(raw).value).toBe(1000n);
    for (const malformed of ['0x', '0x01', '0x02'] as Hex[])
      await expect(validateWalletDependencyFundingSignature(template, malformed)).rejects.toThrow();
    const parsed = parseTransaction(raw), order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const highS = serializeTransaction(parsed, { r: parsed.r!, s: toHex(order - BigInt(parsed.s!), { size: 32 }), yParity: parsed.yParity === 0 ? 1 : 0 });
    await expect(validateWalletDependencyFundingSignature(template, highS)).rejects.toThrow();
    for (const [index, value] of [[0, '0x0001'], [1, '0x00'], [6, '0x0003e8']] as const) {
      const fields = fromRlp(`0x${raw.slice(4)}`, 'hex') as Hex[]; fields[index] = value;
      await expect(validateWalletDependencyFundingSignature(template, `0x02${toRlp(fields).slice(2)}`)).rejects.toThrow();
    }
  });
  it('preserves a prepared claim after signer failure and refuses automatic recovery or another signature', async () => {
    const f = await fixture(); f.signer.mockRejectedValue(new Error('Fixture signer failed'));
    await expect(fundWalletDependencyQuote({ ...f.options, sign: f.signer })).rejects.toThrow();
    const saved = JSON.parse(await readFile(join(f.directory, 'funding', f.response.bundle_uuid, 'funding.json'), 'utf8'));
    expect(saved.state).toBe('prepared'); expect(saved.signed).toBeUndefined();
    await expect(reconcileWalletDependencyFunding(f.options)).rejects.toThrow();
    await expect(rebroadcastWalletDependencyFunding(f.options)).rejects.toThrow();
    await expect(fundWalletDependencyQuote({ ...f.options, sign: f.signer })).rejects.toThrow();
    expect(f.signer).toHaveBeenCalledTimes(1);
    expect(f.calls.filter(c => c.method === 'eth_sendRawTransaction')).toHaveLength(0);
  });
  it('refuses a previously claimed payer nonce before consuming another bundle', async () => {
    const f = await fixture();
    await mkdir(join(f.directory, 'nonce-claims', `1-${payer.address.toLowerCase()}-0`), { recursive: true });
    await expect(fundWalletDependencyQuote({ ...f.options, sign: f.signer })).rejects.toThrow();
    await expect(access(join(f.directory, 'bundle-claims', f.response.bundle_uuid))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.signer).not.toHaveBeenCalled();
  });
  it('bounds a send that ignores cancellation and keeps its persisted identity', async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => { const controller = new AbortController();
      setTimeout(() => controller.abort(), ms); return controller.signal; });
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    const request = f.options.rpc.request;
    f.options.rpc.request = (chain, method, params, signal) => {
      if (method === 'eth_sendRawTransaction') { entered(); return new Promise(() => {}); }
      return request(chain, method, params, signal);
    };
    const rejected = expect(fundWalletDependencyQuote({ ...f.options, sign: f.signer })).rejects.toMatchObject({ code: 'WALLET_DEPENDENCY_FUNDING_UNKNOWN' });
    await started; await vi.advanceTimersByTimeAsync(15001); await rejected;
    const saved = JSON.parse(await readFile(join(f.directory, 'funding', f.response.bundle_uuid, 'funding.json'), 'utf8'));
    expect(saved.state).toBe('sending'); expect(saved.signed.hash).toBe(keccak256(saved.signed.rawTransaction));
  });
  it('revalidates after an open-ended signer wait before sending', async () => {
    const f = await fixture(), original = f.signer.getMockImplementation()!;
    f.signer.mockImplementation(async tx => { const raw = await original(tx); f.flags.paymentReceived = true; return raw; });
    await expect(fundWalletDependencyQuote({ ...f.options, sign: f.signer })).rejects.toThrow();
    expect(f.calls.filter(c => c.method === 'eth_sendRawTransaction')).toHaveLength(0);
  });
  it.each(['not-found', 'pending', 'receipt-unavailable', 'included', 'included-reverted', 'finalized', 'reverted', 'reorg', 'wrong-tx', 'wrong-event',
    'receipt-without-tx', 'mismatched-receipt-block', 'receipt-above-head', 'bad-finality', 'old-runtime', 'excess-gas', 'excess-price',
    'duplicate-event', 'removed-event', 'reverted-with-log'])('reconciles %s from the saved payment identity without signing or sending', async scenario => {
    const f = await fixture();
    const funded = await fundWalletDependencyQuote({ ...f.options, sign: f.signer });
    const { template, signed } = funded.record;
    f.calls.length = 0;
    const request = f.options.rpc.request; let paymentCodeReads = 0;
    const reverted = ['reverted', 'included-reverted', 'reverted-with-log'].includes(scenario);
    const unfinalized = ['included', 'included-reverted'].includes(scenario);
    const tx = { hash: signed.hash, from: template.payer, to: template.transaction.to, input: template.transaction.data,
      type: '0x2', chainId: '0x1', nonce: '0x0', value: scenario === 'wrong-tx' ? '0x3e9' : '0x3e8', gas: '0x249f0',
      maxFeePerGas: '0xc8', maxPriorityFeePerGas: '0xa', accessList: [],
      blockHash: scenario === 'pending' ? null : BLOCK, blockNumber: scenario === 'pending' ? null : scenario === 'receipt-above-head' ? '0x101' : '0x100' };
    const log = { address: RELAYR_PAYMENT_ADDRESS, topics: [RELAYR_PAYMENT_EVENT,
      `0x${template.bundleUuid.replaceAll('-', '').padEnd(64, '0')}`],
      data: '0x' + (scenario === 'wrong-event' ? 1001n : 1000n).toString(16).padStart(64, '0') + BigInt(template.paymentDeadline).toString(16).padStart(64, '0'),
      transactionHash: signed.hash, blockHash: BLOCK, blockNumber: '0x100', removed: scenario === 'removed-event' };
    f.options.rpc.request = async (chain, method, params, signal) => {
      if (method === 'eth_getTransactionByHash') return ['not-found', 'receipt-without-tx'].includes(scenario) ? null : tx;
      if (method === 'eth_getTransactionReceipt') return ['not-found', 'pending', 'receipt-unavailable'].includes(scenario) ? null : {
        transactionHash: signed.hash, from: template.payer, to: template.transaction.to,
        blockHash: scenario === 'mismatched-receipt-block' ? keccak256('0x4321') : BLOCK, blockNumber: scenario === 'receipt-above-head' ? '0x101' : '0x100',
        status: reverted ? '0x0' : '0x1', gasUsed: scenario === 'excess-gas' ? '0x249f1' : '0x7530',
        effectiveGasPrice: scenario === 'excess-price' ? '0xc9' : '0x6e',
        logs: reverted && scenario !== 'reverted-with-log' ? [] : scenario === 'duplicate-event' ? [log, log] : [log] };
      if (method === 'eth_getBlockByNumber' && params[0] === 'finalized') return {
        number: unfinalized ? '0xff' : '0x100', hash: scenario === 'bad-finality' ? keccak256('0x4321') : BLOCK, timestamp: toHex(f.flags.now / 1000) };
      if (method === 'eth_getBlockByNumber' && params[0] === '0xff') return {
        number: '0xff', hash: BLOCK, timestamp: toHex(f.flags.now / 1000) };
      if (method === 'eth_getBlockByNumber' && params[0] === '0x100' && scenario === 'reorg') return {
        number: '0x100', hash: keccak256('0x4321'), timestamp: toHex(f.flags.now / 1000) };
      if (method === 'eth_getCode' && String(params[0]).toLowerCase() === RELAYR_PAYMENT_ADDRESS.toLowerCase()
        && ++paymentCodeReads === 2 && scenario === 'old-runtime') return '0x6000';
      return request(chain, method, params, signal);
    };
    const work = reconcileWalletDependencyFunding({ ...f.options, bundleUuid: template.bundleUuid });
    if (!['not-found', 'pending', 'receipt-unavailable', 'included', 'included-reverted', 'finalized', 'reverted'].includes(scenario)) await expect(work).rejects.toThrow();
    else {
      const result = await work;
      expect(result.record.state).toBe(scenario);
      expect(result.record.paymentFinalized).toBe(scenario === 'finalized');
    }
    expect(f.signer).toHaveBeenCalledTimes(1);
    expect(f.calls.filter(c => c.method === 'eth_sendRawTransaction')).toHaveLength(0);
  });
  it('rebroadcasts the identical saved envelope at most once after a lost response, without signing again', async () => {
    const f = await fixture(); f.flags.send = 'lost';
    await expect(fundWalletDependencyQuote({ ...f.options, sign: f.signer })).rejects.toThrow();
    f.flags.send = 'success';
    const request = f.options.rpc.request;
    f.options.rpc.request = (chain, method, params, signal) => ['eth_getTransactionByHash', 'eth_getTransactionReceipt'].includes(method)
      ? Promise.resolve(null) : request(chain, method, params, signal);
    const result = await Promise.allSettled([1,2].map(() => rebroadcastWalletDependencyFunding({ ...f.options, bundleUuid: f.response.bundle_uuid })));
    expect(result.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    const sends = f.calls.filter(c => c.method === 'eth_sendRawTransaction');
    expect(sends).toHaveLength(2); expect(sends[1]!.params).toEqual(sends[0]!.params);
    expect(f.signer).toHaveBeenCalledTimes(1);
    await expect(rebroadcastWalletDependencyFunding({ ...f.options, bundleUuid: f.response.bundle_uuid })).rejects.toThrow();
    expect(f.calls.filter(c => c.method === 'eth_sendRawTransaction')).toHaveLength(2);
  });
  it.each(['nonce', 'expired', 'paid'])('never rebroadcasts an unsafe %s payment', async fault => {
    const f = await fixture(); await fundWalletDependencyQuote({ ...f.options, sign: f.signer });
    const request = f.options.rpc.request;
    f.options.rpc.request = (chain, method, params, signal) => ['eth_getTransactionByHash', 'eth_getTransactionReceipt'].includes(method)
      ? Promise.resolve(null) : request(chain, method, params, signal);
    if (fault === 'nonce') f.flags.pendingNonce = 1n;
    if (fault === 'expired') f.flags.now += 1000000;
    if (fault === 'paid') f.flags.paymentReceived = true;
    await expect(rebroadcastWalletDependencyFunding({ ...f.options, bundleUuid: f.response.bundle_uuid })).rejects.toThrow();
    expect(f.calls.filter(c => c.method === 'eth_sendRawTransaction')).toHaveLength(1);
    expect(f.signer).toHaveBeenCalledTimes(1);
  });
  it('renews one expired unpaid bundle into one successor and preserves the original bytes', async () => {
    const f = await fixture(), originalPath = join(f.directory, f.options.bodyHash, 'publication.json');
    const before = await readFile(originalPath);
    f.flags.now += 1300000;
    const next = 'a0a555ff-4444-4111-aaaa-444444444444', deadline = f.flags.now / 1000 + 900;
    f.statusIds.add(next);
    f.provider.createIndependent.mockImplementation(async () => ({ ...f.response, bundle_uuid: next,
      payment_info: f.response.payment_info.map(item => ({ ...item, payment_deadline: new Date(deadline * 1000).toISOString(),
        calldata: RELAYR_PAYMENT_SELECTOR + next.replaceAll('-', '').padEnd(64, '0') + deadline.toString(16).padStart(64, '0') })) }));
    const attempts = await Promise.allSettled([1,2].map(() => renewWalletDependencyQuote({ ...f.options, bundleUuid: f.response.bundle_uuid })));
    const success = attempts.find(item => item.status === 'fulfilled'); expect(success?.status).toBe('fulfilled');
    expect(attempts.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(f.provider.createIndependent).toHaveBeenCalledTimes(2); // Original plus sole successor.
    expect(await readFile(originalPath)).toEqual(before);
    if (success?.status === 'fulfilled') expect(success.value.record.quote.bundleUuid).toBe(next);
    await expect(prepareWalletDependencyFunding(f.options)).rejects.toThrow();
    const renewed = await prepareWalletDependencyFunding({ ...f.options, bundleUuid: next }); expect(renewed.bundleUuid).toBe(next);
    await expect(renewWalletDependencyQuote({ ...f.options, bundleUuid: f.response.bundle_uuid })).rejects.toThrow();
    expect(f.provider.createIndependent).toHaveBeenCalledTimes(2);
  });
  it.each(['not-expired', 'paid', 'nonce', 'funding-claim', 'unknown-claim', 'unknown-post'])('refuses renewal for %s', async fault => {
    const f = await fixture();
    if (fault === 'funding-claim') await fundWalletDependencyQuote({ ...f.options, sign: f.signer });
    if (fault !== 'not-expired') f.flags.now += 1300000;
    if (fault === 'paid') f.flags.paymentReceived = true;
    if (fault === 'nonce') f.flags.pendingNonce = 1n;
    if (fault === 'unknown-claim') await mkdir(join(f.directory, 'bundle-claims', f.response.bundle_uuid), { recursive: true });
    if (fault === 'unknown-post') {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(f.directory, f.options.bodyHash, 'publication.json'), JSON.stringify({ bodyHash: `0x${f.options.bodyHash}`, state: 'submission-unknown' }));
    }
    await expect(renewWalletDependencyQuote({ ...f.options, bundleUuid: f.response.bundle_uuid })).rejects.toThrow();
    expect(f.provider.createIndependent).toHaveBeenCalledTimes(1);
  });
  it('keeps an unknown successor POST permanently claimed and never renews around it', async () => {
    const f = await fixture(); f.flags.now += 1300000;
    f.provider.createIndependent.mockRejectedValue(new Error('Fixture response lost'));
    await expect(renewWalletDependencyQuote(f.options)).rejects.toThrow('Fixture response lost');
    await expect(renewWalletDependencyQuote(f.options)).rejects.toThrow();
    const child = JSON.parse(await readFile(join(f.directory, f.options.bodyHash, `renewal-${f.response.bundle_uuid}`, 'publication.json'), 'utf8'));
    expect(child.state).toBe('submission-unknown'); expect(f.provider.createIndependent).toHaveBeenCalledTimes(2);
  });
  it('retains retirement without a POST when the fresh missing set changes', async () => {
    const f = await fixture(); f.flags.now += 1300000;
    const recipe = await preparePasskeyDependencyDeployment(), request = f.options.rpc.request;
    const verifierRuntime = JSON.parse(await readFile(new URL('../src/rest/smartAccounts/stack/passkey/artifacts/FCLP256Verifier.json', import.meta.url), 'utf8')).deployedBytecode;
    f.options.rpc.request = (chain, method, params, signal) => {
      if (method === 'eth_getCode') {
        const verifier = recipe.deployments[0]!;
        if (String(params[0]).toLowerCase() === verifier.pin.address.toLowerCase()) return Promise.resolve(verifierRuntime);
      }
      return request(chain, method, params, signal);
    };
    await expect(renewWalletDependencyQuote(f.options)).rejects.toMatchObject({ code: 'WALLET_DEPENDENCY_REQUEST_CHANGED' });
    const claim = JSON.parse(await readFile(join(f.directory, 'bundle-claims', f.response.bundle_uuid, 'claim.json'), 'utf8'));
    expect(claim.purpose).toBe('retired'); expect(f.provider.createIndependent).toHaveBeenCalledTimes(1);
  });
});
