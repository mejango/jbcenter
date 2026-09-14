import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { keccak256, toHex, type Hex } from 'viem';
import { preparePasskeyDependencyDeployment } from '../src/rest/smartAccounts/passkeyProfile.js';
import { inspectWalletDependencyChain, prepareWalletDependencyBundle, WALLET_DEPENDENCY_CHAINS } from '../src/rest/wallet/dependencyBundle.js';
import type { RestRpc } from '../src/rest/core.js';

const blockHash = keccak256('0x1234'), clock = 1800000000000;
// Outgoing fields are non-null; strip OpenAPI's nullable extension for JSON Schema validation.
const providerSchema = JSON.parse(readFileSync(new URL('./fixtures/relayr/prepaid-request.schema.json', import.meta.url), 'utf8'),
  (key, value) => key === 'nullable' ? undefined : value);
const validProviderBody = new Ajv2020({ strict: false, validateFormats: false }).compile(providerSchema);
async function fixture(chainId: number, wrongChain = false) {
  const plan = await preparePasskeyDependencyDeployment(), calls: string[] = [];
  const rpc: RestRpc = { async request(chain, method, params) {
    expect(chain).toBe(chainId); calls.push(method);
    if (method === 'eth_chainId') return toHex(wrongChain ? 137 : chainId);
    if (method === 'eth_getBlockByNumber') return { number: '0x1', hash: blockHash, timestamp: toHex(clock / 1000) };
    if (method === 'eth_getCode') return params[0] === plan.deployer.address ? plan.deployer.runtime : '0x';
    if (method === 'eth_call') return plan.deployments.find(item => item.transaction.data === (params[0] as { data: Hex }).data)!.pin.address;
    if (method === 'eth_estimateGas') return '0x1e8480';
    throw new Error('Unexpected RPC method: ' + method);
  } };
  return { rpc, calls };
}
describe('audit-gated eight-chain Relayr dependency plan', () => {
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
    // Exact enum from Relayr's live OpenAPI, not the documentation's prose heading.
    expect(result.body.virtual_nonce_mode).toBe('MultiChain');
    expect(result.body.transactions).toHaveLength(16);
    expect(validProviderBody(result.body), JSON.stringify(validProviderBody.errors)).toBe(true);
    expect(validProviderBody({ ...result.body, virtual_nonce_mode: 'Multichain' })).toBe(false);
    for (const chain of WALLET_DEPENDENCY_CHAINS) {
      expect(result.body.transactions.filter(entry => entry.chain === chain).map(entry => entry.virtual_nonce)).toEqual([0, 1]);
    }
    expect(new Set(result.body.transactions.map(entry => entry.target)).size).toBe(1);
    expect(new Set(result.body.transactions.map(entry => entry.data)).size).toBe(2);
    expect(result.body.transactions.every(entry => entry.value === '0')).toBe(true);
    expect(result.walletActivationChains).toEqual([]);
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
