import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { keccak256, toHex, type Hex } from 'viem';
import { preparePasskeyDependencyDeployment } from '../src/rest/smartAccounts/passkeyProfile.js';
import { inspectWalletDependencyChain, prepareWalletDependencyBundle, WALLET_DEPENDENCY_CHAINS } from '../src/rest/wallet/dependencyBundle.js';
import type { RelayrEntry } from '../src/rest/sponsorship/types.js';
import type { RestRpc } from '../src/rest/core.js';
import { RelayrProvider } from '../src/rest/sponsorship/provider.js';
import { publishWalletDependencyQuote } from '../src/rest/wallet/dependencyPublication.js';
import { RELAYR_NATIVE_TOKEN, RELAYR_PAYMENT_ADDRESS, RELAYR_PAYMENT_SELECTOR } from '../src/rest/sponsorship/constants.js';

const blockHash = keccak256('0x1234'), clock = 1800000000000;
// Outgoing fields are non-null; strip OpenAPI's nullable extension for JSON Schema validation.
const providerSchema = JSON.parse(readFileSync(new URL('./fixtures/relayr/prepaid-request.schema.json', import.meta.url), 'utf8'),
  (key, value) => key === 'nullable' ? undefined : value);
const validProviderBody = new Ajv2020({ strict: false, validateFormats: false }).compile(providerSchema);
async function fixture(chainId: number, wrongChain = false, verifierExists = false) {
  const plan = await preparePasskeyDependencyDeployment(), calls: string[] = [];
  const rpc: RestRpc = { async request(chain, method, params) {
    expect(chain).toBe(chainId); calls.push(method);
    if (method === 'eth_chainId') return toHex(wrongChain ? 137 : chainId);
    if (method === 'eth_getBlockByNumber') return { number: '0x1', hash: blockHash, timestamp: toHex(clock / 1000) };
    if (method === 'eth_getCode') {
      if (params[0] === plan.deployer.address) return plan.deployer.runtime;
      if (verifierExists && params[0] === plan.profile.p256Verifier.address)
        return JSON.parse(readFileSync(new URL('../src/rest/smartAccounts/stack/passkey/artifacts/FCLP256Verifier.json', import.meta.url), 'utf8')).deployedBytecode;
      return '0x';
    }
    if (method === 'eth_call') return plan.deployments.find(item => item.transaction.data === (params[0] as { data: Hex }).data)!.pin.address;
    if (method === 'eth_estimateGas') return '0x1e8480';
    throw new Error('Unexpected RPC method: ' + method);
  } };
  return { rpc, calls };
}
describe('audit-gated eight-chain Relayr dependency plan', () => {
  it('reproduces all three reviewed deployment addresses and keeps the operator table aligned', async () => {
    const { profile } = await preparePasskeyDependencyDeployment();
    const addresses = {
      p256Verifier: '0xFbe0614fFB2226cd6d1D3F9A79BC73d7647b4C61',
      signerFactory: '0x48c4F4B3d2684f39437F68faC4Ecc49f8F85163D',
      signerSingleton: '0x6613cA05f68002B7091963D9D4AB0DB232ed0648',
    };
    const documentation = readFileSync(new URL('../docs/rest/WALLET-DEPENDENCY-ROLLOUT.md', import.meta.url), 'utf8');
    for (const [name, address] of Object.entries(addresses)) {
      expect(profile[name as keyof typeof addresses].address).toBe(address);
      expect(documentation).toContain('`' + address + '`');
    }
  });
  it('prepares the same two CREATE2 deployments on all eight explicit chains without publishing or signing', async () => {
    const observations = [];
    for (const chainId of WALLET_DEPENDENCY_CHAINS) {
      const { rpc, calls } = await fixture(chainId);
      observations.push(await inspectWalletDependencyChain({ chainId, rpc, now: () => clock }));
      expect(calls.every(method => ['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call', 'eth_estimateGas'].includes(method))).toBe(true);
    }
    const result = await prepareWalletDependencyBundle(observations, clock);
    expect(result.audit.status).toBe('pending');
    expect(result.publicationEnabled).toBe(false);
    // Constructors are independent; a failed testnet call must not gate other chains.
    expect(result.bundles.map(bundle => bundle.family)).toEqual(['mainnet', 'testnet']);
    expect(result.bundles.map(bundle => bundle.body.transactions.length)).toEqual([8, 8]);
    for (const bundle of result.bundles) {
      expect(bundle.body.virtual_nonce_mode).toBe('Disabled');
      expect(validProviderBody(bundle.body), JSON.stringify(validProviderBody.errors)).toBe(true);
      expect(validProviderBody({ ...bundle.body, virtual_nonce_mode: 'Multichain' })).toBe(false);
    }
    const transactions = result.bundles.flatMap(bundle => bundle.body.transactions);
    for (const chain of WALLET_DEPENDENCY_CHAINS) {
      expect(transactions.filter(entry => entry.chain === chain).map(entry => entry.virtual_nonce)).toEqual([0, 0]);
    }
    expect(new Set(transactions.map(entry => entry.target)).size).toBe(1);
    expect(new Set(transactions.map(entry => entry.data)).size).toBe(2);
    expect(transactions.every(entry => entry.value === '0')).toBe(true);
    expect(result.walletActivationChains).toEqual([]);
  });
  it('omits exact existing verifiers and gives the fourteen remaining calls no ordering dependency', async () => {
    const observations = await Promise.all(WALLET_DEPENDENCY_CHAINS.map(async chainId => {
      const { rpc } = await fixture(chainId, false, chainId === 11155111 || chainId === 84532);
      return inspectWalletDependencyChain({ chainId, rpc, now: () => clock });
    }));
    const bundle = await prepareWalletDependencyBundle(observations, clock);
    expect(bundle.bundles.map(bundle => bundle.body.transactions.length)).toEqual([8, 6]);
    const transactions = bundle.bundles.flatMap(bundle => bundle.body.transactions);
    expect(transactions.every(entry => entry.virtual_nonce === 0)).toBe(true);
    for (const chain of [11155111, 84532]) {
      const entries = transactions.filter(entry => entry.chain === chain);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.data).toBe(bundle.recipe.deployments[1]!.transaction.data);
    }
  });
  it.each([1, 10, 8453, 42161, 11155111, 11155420, 84532, 421614])('rejects a wrong provider chain for %s', async chainId => {
    const f = await fixture(chainId, true);
    await expect(inspectWalletDependencyChain({ chainId, rpc: f.rpc, now: () => clock })).rejects.toThrow(/chain/i);
    expect(f.calls).toEqual(['eth_chainId']);
  });
  it('requires all eight observations with fresh original evidence and exact planned bytes', async () => {
    const observations = await Promise.all(WALLET_DEPENDENCY_CHAINS.map(async chainId => {
      const { rpc } = await fixture(chainId);
      return inspectWalletDependencyChain({ chainId, rpc, now: () => clock });
    }));
    await expect(prepareWalletDependencyBundle(observations.slice(1), clock)).rejects.toThrow();
    await expect(prepareWalletDependencyBundle([...observations.slice(1), observations[1]!], clock)).rejects.toThrow();
    await expect(prepareWalletDependencyBundle(observations, clock + 60001)).rejects.toThrow();
    const changed = structuredClone(observations);
    changed[0]!.missing[0]!.transaction.value = '1' as '0';
    await expect(prepareWalletDependencyBundle(changed, clock)).rejects.toThrow();
  });
  it.each(['proxy', 'occupied', 'wrong-address', 'gas', 'reorg', 'stale', 'future'])(
    'rejects unsafe chain observation: %s', async failure => {
      const f = await fixture(1), recipe = await preparePasskeyDependencyDeployment();
      const rpc: RestRpc = { async request(chain, method, params, signal) {
        const result = await f.rpc.request(chain, method, params, signal);
        if (method === 'eth_getCode' && ((failure === 'proxy' && params[0] === recipe.deployer.address)
          || (failure === 'occupied' && params[0] === recipe.profile.p256Verifier.address))) return '0x6000';
        if (method === 'eth_call' && failure === 'wrong-address') return recipe.deployer.address;
        if (method === 'eth_estimateGas' && failure === 'gas') return toHex(8000001);
        if (method === 'eth_getBlockByNumber') {
          if (failure === 'stale' || failure === 'future') return { ...(result as object), timestamp: toHex((clock + (failure === 'stale' ? -61000 : 31000)) / 1000) };
          if (failure === 'reorg' && params[0] !== 'latest') return { ...(result as object), hash: keccak256('0xabcd') };
        }
        return result;
      } };
      await expect(inspectWalletDependencyChain({ chainId: 1, rpc, now: () => clock })).rejects.toThrow();
    });
  it('rejects unsupported chains and cancellation without contacting a provider', async () => {
    const f = await fixture(137), controller = new AbortController();
    await expect(inspectWalletDependencyChain({ chainId: 137, rpc: f.rpc, now: () => clock })).rejects.toThrow(/chain/i);
    controller.abort();
    await expect(inspectWalletDependencyChain({ chainId: 1, rpc: f.rpc, signal: controller.signal, now: () => clock })).rejects.toThrow(/cancelled/i);
    expect(f.calls).toEqual([]);
  });
});

describe('one-shot operator Relayr publication journal', () => {
  const folders: string[] = [];
  afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
  async function publication(family: 'mainnet' | 'testnet' = 'mainnet') {
    const root = await mkdtemp(join(tmpdir(), 'center-dependency-publication-')); folders.push(root);
    const directory = join(root, 'attempt');
    const observations = await Promise.all(WALLET_DEPENDENCY_CHAINS.map(async chainId =>
      inspectWalletDependencyChain({ chainId, rpc: (await fixture(chainId)).rpc, now: () => clock })));
    const plan = await prepareWalletDependencyBundle(observations, clock);
    const bundle = plan.bundles.find(bundle => bundle.family === family)!, body = bundle.body;
    const source = { revision: 'a'.repeat(40), fingerprint: 'b'.repeat(64) };
    const journal = join(directory, bundle.bodyHash.slice(2));
    const id = randomUUID(), deadline = clock / 1000 + 300;
    const response = { bundle_uuid: id, tx_uuids: body.transactions.map(() => randomUUID()), payment_info: [{
      chain: family === 'mainnet' ? 8453 : 84532, token: RELAYR_NATIVE_TOKEN, target: RELAYR_PAYMENT_ADDRESS, amount: '1234',
      calldata: RELAYR_PAYMENT_SELECTOR + id.replaceAll('-', '').padEnd(64, '0') + deadline.toString(16).padStart(64, '0'),
      payment_deadline: new Date(deadline * 1000).toISOString(),
    }] };
    const record = async () => JSON.parse(await readFile(join(journal, 'publication.json'), 'utf8'));
    const status = vi.fn(async () => ({ bundle_uuid: id, transactions: body.transactions.map((entry, index) => ({
      tx_uuid: response.tx_uuids[index], request: entry, status: { state: 'Pending' },
    })) }));
    return { family, directory, journal, source, observations, response, body, record, status };
  }
  it('persists the reviewed source and exact transaction fields before publication and retains the quote binding without enabling funding', async () => {
    const f = await publication();
    const provider = { status: f.status, createIndependent: vi.fn(async (entries: RelayrEntry[]) => {
      const before = await f.record();
      expect(before.state).toBe('submission-unknown');
      expect(before.body).toEqual(f.body);
      expect(before.source).toEqual(f.source);
      expect(entries).toEqual(before.body.transactions);
      return f.response;
    }) };
    const result = await publishWalletDependencyQuote({ ...f, provider, now: () => clock });
    expect(result.record.quote.bundleUuid).toBe(f.response.bundle_uuid);
    expect(result.record.fundingEnabled).toBe(false);
    expect(await f.record()).toEqual(result.record);
    await expect(publishWalletDependencyQuote({ ...f, provider, now: () => clock })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(provider.createIndependent).toHaveBeenCalledTimes(1);
  });
  it.each(['mainnet', 'testnet'] as const)('quotes only %s calls and accepts only payment options from that family', async family => {
    const f = await publication(family);
    const provider = { status: f.status, createIndependent: vi.fn(async (entries: RelayrEntry[]) => {
      const allowed = family === 'mainnet' ? [1, 10, 8453, 42161] : [11155111, 11155420, 84532, 421614];
      expect(entries.every(entry => allowed.includes(entry.chain))).toBe(true);
      return f.response;
    }) };
    const result = await publishWalletDependencyQuote({ ...f, provider, now: () => clock });
    expect(result.record.family).toBe(family);
    expect(result.record.fundingEnabled).toBe(false);
    const wrong = await publication(family);
    wrong.response.payment_info[0]!.chain = family === 'mainnet' ? 84532 : 8453;
    await expect(publishWalletDependencyQuote({ ...wrong, provider: { ...provider, createIndependent: async () => wrong.response }, now: () => clock }))
      .rejects.toMatchObject({ code: 'RELAYR_INVALID_QUOTE' });
    expect((await wrong.record()).state).toBe('response-received');
  });
  it.each([403, 406, 500])('retains HTTP %s and its response body, including a bundle UUID, without parsing it as a payable quote', async status => {
    const f = await publication();
    const body = JSON.stringify({ bundle_uuid: f.response.bundle_uuid, error: 'Use one network family' });
    const fetcher = vi.fn<typeof fetch>(async () => new Response(body, { status }));
    await expect(publishWalletDependencyQuote({ ...f, provider: new RelayrProvider(fetcher), now: () => clock }))
      .rejects.toMatchObject({ code: 'RELAYR_UNAVAILABLE' });
    expect(await f.record()).toMatchObject({ state: 'response-received', family: 'mainnet',
      httpResponse: { status, body, complete: true, truncated: false } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(publishWalletDependencyQuote({ ...f, provider: new RelayrProvider(fetcher), now: () => clock })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects an unknown network family before claiming or publishing', async () => {
    const f = await publication(), provider = { status: f.status, createIndependent: vi.fn(async () => f.response) };
    await expect(publishWalletDependencyQuote({ ...f, family: 'all' as 'mainnet', provider, now: () => clock })).rejects.toThrow();
    expect(provider.createIndependent).not.toHaveBeenCalled();
    await expect(f.record()).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('lets only one concurrent attempt claim the same journal', async () => {
    const f = await publication(), provider = { status: f.status, createIndependent: vi.fn(async () => f.response) };
    const results = await Promise.allSettled([1, 2].map(() => publishWalletDependencyQuote({ ...f, provider, now: () => clock })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(provider.createIndependent).toHaveBeenCalledTimes(1);
    expect((await f.record()).state).toBe('quoted');
  });
  it('retains an unknown outcome after a lost response and refuses a second publication', async () => {
    const f = await publication(), provider = { status: f.status, createIndependent: vi.fn(async () => { throw new Error('Response lost after acceptance'); }) };
    await expect(publishWalletDependencyQuote({ ...f, provider, now: () => clock })).rejects.toThrow('Response lost');
    expect((await f.record()).state).toBe('submission-unknown');
    await expect(publishWalletDependencyQuote({ ...f, provider, now: () => clock })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(provider.createIndependent).toHaveBeenCalledTimes(1);
  });
  it('persists malformed provider responses for UUID recovery before parsing fails', async () => {
    const f = await publication(), response = { ...f.response, tx_uuids: [] };
    const provider = { status: f.status, createIndependent: vi.fn(async () => response) };
    await expect(publishWalletDependencyQuote({ ...f, provider, now: () => clock })).rejects.toThrow();
    expect(await f.record()).toMatchObject({ state: 'response-received', response });
    expect(provider.createIndependent).toHaveBeenCalledTimes(1);
  });
  it('refuses stale evidence without creating a journal or contacting Relayr', async () => {
    const f = await publication(), provider = { status: f.status, createIndependent: vi.fn(async () => f.response) };
    await expect(publishWalletDependencyQuote({ ...f, provider, now: () => clock + 60001 })).rejects.toThrow(/fresh/i);
    await expect(f.record()).rejects.toMatchObject({ code: 'ENOENT' });
    expect(provider.createIndependent).not.toHaveBeenCalled();
  });
  it('retains the recovery identity but refuses a quote whose stored provider calls differ', async () => {
    const f = await publication(), status = await f.status();
    status.transactions[0]!.request = { ...status.transactions[0]!.request, value: '1' };
    const provider = { createIndependent: vi.fn(async () => f.response), status: vi.fn(async () => status) };
    await expect(publishWalletDependencyQuote({ ...f, provider, now: () => clock })).rejects.toThrow();
    expect(await f.record()).toMatchObject({ state: 'status-received', statusResponse: status, fundingEnabled: false,
      quote: { bundleUuid: f.response.bundle_uuid } });
  });
  it('returns the recovery UUID on disk failure after POST without repeating the submission', async () => {
    const f = await publication();
    const provider = { status: f.status, createIndependent: vi.fn(async () => {
      // Force rename failure after the response arrives, while preserving the pre-POST record.
      await rename(join(f.journal, 'publication.json'), join(f.journal, 'before.json'));
      await mkdir(join(f.journal, 'publication.json'));
      return { ...f.response, unsafeDetail: 'do not put provider text in an error' };
    }) };
    await expect(publishWalletDependencyQuote({ ...f, provider, now: () => clock })).rejects.toMatchObject({
      code: 'WALLET_DEPENDENCY_JOURNAL_WRITE_FAILED', recoveryBundleUuid: f.response.bundle_uuid,
    });
    const before = JSON.parse(await readFile(join(f.journal, 'before.json'), 'utf8'));
    expect(before.state).toBe('submission-unknown');
    expect(before.source).toEqual(f.source);
    expect(provider.createIndependent).toHaveBeenCalledTimes(1);
    expect(provider.status).not.toHaveBeenCalled();
    await expect(publishWalletDependencyQuote({ ...f, provider, now: () => clock })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(provider.createIndependent).toHaveBeenCalledTimes(1);
  });
  it('rejects missing or malformed source attribution before publication', async () => {
    const f = await publication(), provider = { status: f.status, createIndependent: vi.fn(async () => f.response) };
    for (const source of [undefined, { revision: 'x', fingerprint: 'b'.repeat(64) }, { ...f.source, fingerprint: '' }]) {
      await expect(publishWalletDependencyQuote({ ...f, source: source as typeof f.source, provider, now: () => clock })).rejects.toThrow();
    }
    expect(provider.createIndependent).not.toHaveBeenCalled();
  });

});
