import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeFunctionData, keccak256, parseAbi, type Hex } from 'viem';
import { createBaseWalletProductionStack, inspectBaseWalletProductionStack } from '../src/rest/wallet/productionStack.js';
import { inspectWalletDependencyChain } from '../src/rest/wallet/dependencyBundle.js';
import { preparePasskeySafe7579Creation } from '../src/rest/smartAccounts/creation.js';
import { startWalletDeploymentAnvil } from './fixtures/wallet-deployment-anvil.js';
import { createRegistration, enrollmentBackupAccount } from './fixtures/wallet-enrollment-crypto.js';
import type { RestRpc } from '../src/rest/core.js';

describe('production wallet dependency plan against real local constructors', () => {
  let fixture: Awaited<ReturnType<typeof startWalletDeploymentAnvil>>;
  let stack: Awaited<ReturnType<typeof createBaseWalletProductionStack>>;
  let baseline: Hex;
  beforeAll(async () => {
    fixture = await startWalletDeploymentAnvil();
    stack = await createBaseWalletProductionStack();
    await fixture.rpc('anvil_setCode', [stack.deployer.address, stack.deployer.runtime]);
    baseline = await fixture.rpc<Hex>('evm_snapshot');
  }, 30000);
  afterAll(async () => { await fixture?.close(); });
  async function reset() {
    expect(await fixture.rpc('evm_revert', [baseline])).toBe(true);
    baseline = await fixture.rpc<Hex>('evm_snapshot');
  }
  const inspect = (rpc?: RestRpc) => inspectBaseWalletProductionStack({ rpc: rpc ?? fixture.readOnlyRpc });

  it('returns only the two exact missing deployments and proves constructor addresses and the complete atomic Safe initializer', async () => {
    await reset();
    const before = await inspect();
    expect(before.status).toBe('dependencies-missing');
    expect(before.missing.map(item => item.name)).toEqual(['FCLP256Verifier', 'SafeWebAuthnSignerFactory']);
    expect(before.missing.every(item => item.transaction.value === '0' && BigInt(item.estimatedGas) > 0n)).toBe(true);
    for (const item of before.missing) {
      const hash = await fixture.rpc<Hex>('eth_sendTransaction', [{ from: fixture.sender, ...item.transaction, value: '0x0', gas: '0x7a1200' }]);
      expect((await fixture.rpc<{status: string}>('eth_getTransactionReceipt', [hash])).status).toBe('0x1');
    }
    const after = await inspect();
    expect(after.status).toBe('dependencies-verified');
    expect(after.missing).toEqual([]);
    expect(after.manifest).toEqual(stack.manifest);
    expect(after.dispatchEnabled).toBe(false);
    const dependencies = await inspectWalletDependencyChain({ chainId: 8453, rpc: fixture.readOnlyRpc });
    expect(dependencies.missing).toEqual([]);
    expect(dependencies.observed.every(item => item.deployed)).toBe(true);
    const credential = createRegistration({ challenge: `0x${'11'.repeat(32)}`, rpId: 'wallet.juicebox.center',
      origin: 'https://wallet.juicebox.center', userHandle: Buffer.alloc(32, 1).toString('base64url') });
    const creation = preparePasskeySafe7579Creation({ manifest: stack.manifest, publicKey: credential.publicKey,
      recoveryOwner: enrollmentBackupAccount.address, saltNonce: '123' });
    const hash = await fixture.rpc<Hex>('eth_sendTransaction', [{ from: fixture.sender, ...creation.transaction, value: '0x0', gas: '0x7a1200' }]);
    expect((await fixture.rpc<{status: string}>('eth_getTransactionReceipt', [hash])).status).toBe('0x1');
    expect(await fixture.rpc('eth_getCode', [creation.address, 'latest'])).not.toBe('0x');
    const owners = await fixture.rpc('eth_call', [{ to: creation.address, data: encodeFunctionData({ abi: parseAbi(['function getOwners() view returns(address[])']), functionName: 'getOwners' }) }, 'latest']);
    expect(String(owners).toLowerCase()).toContain(creation.bootstrap.signerAddress.slice(2).toLowerCase());
    expect(String(owners).toLowerCase()).toContain(enrollmentBackupAccount.address.slice(2).toLowerCase());
  }, 30000);

  it('fails on an occupied dependency address instead of preparing a replacement', async () => {
    await reset();
    await fixture.rpc('anvil_setCode', [stack.manifest.ownerProfile!.signerFactory.address, '0x60006000f3']);
    await expect(inspect()).rejects.toThrow(/runtime/i);
  });
  it('rejects an unexpected deployment proxy runtime', async () => {
    await reset();
    await fixture.rpc('anvil_setCode', [stack.deployer.address, '0x6000']);
    await expect(inspect()).rejects.toThrow(/runtime/i);
  });
  it('rejects a provider returning the wrong chain before further observation', async () => {
    let calls = 0;
    await expect(inspect({ request: async () => { calls++; return '0x1'; } })).rejects.toThrow(/chain/i);
    expect(calls).toBe(1);
  });
  it('rejects stale head evidence without returning a deployable plan', async () => {
    await reset();
    const rpc: RestRpc = { request: async (chain, method, params, signal) => {
      const result = await fixture.readOnlyRpc.request(chain, method, params, signal);
      return method === 'eth_getBlockByNumber' ? { ...(result as object), timestamp: '0x1' } : result;
    } };
    await expect(inspect(rpc)).rejects.toThrow(/fresh/i);
  });
  it('rejects a reorganized observation after simulation', async () => {
    await reset();
    const rpc: RestRpc = { request: async (chain, method, params, signal) => {
      const result = await fixture.readOnlyRpc.request(chain, method, params, signal);
      return method === 'eth_getBlockByNumber' && params[0] !== 'latest'
        ? { ...(result as object), hash: keccak256('0x1234') } : result;
    } };
    await expect(inspect(rpc)).rejects.toThrow(/canonical/i);
  });
  it('keeps the manifest revision stable and does not share mutable plan objects', async () => {
    const another = await createBaseWalletProductionStack();
    expect(another.manifest).toEqual(stack.manifest);
    another.manifest.ownerProfile!.signerFactory.address = enrollmentBackupAccount.address;
    expect((await createBaseWalletProductionStack()).manifest).toEqual(stack.manifest);
  });
});
