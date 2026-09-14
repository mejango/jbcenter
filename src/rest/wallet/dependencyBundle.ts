import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, type Hex } from 'viem';
import { RestError, type RestRpc } from '../core.js';
import { rpcHex } from '../protocol/code.js';
import { preparePasskeyDependencyDeployment } from '../smartAccounts/passkeyProfile.js';
import { fingerprint, stable } from '../smartAccounts/service.js';
import { RELAYR_MAINNET_CHAINS, RELAYR_TESTNET_CHAINS } from '../sponsorship/constants.js';
import type { RelayrIndependentEntry } from '../sponsorship/types.js';
import { operationRpc, walletPreflightRpcBounds } from './operationRpc.js';

export const WALLET_DEPENDENCY_CHAINS = Object.freeze([...RELAYR_MAINNET_CHAINS, ...RELAYR_TESTNET_CHAINS] as const);
export type WalletDependencyFamily = 'mainnet' | 'testnet';
const VERSION = 'center-wallet-dependency-observation-v1';
const singletonAbi = parseAbi(['function SINGLETON() view returns(address)']);
type Recipe = Awaited<ReturnType<typeof preparePasskeyDependencyDeployment>>;
function invalid(message: string): never { throw new RestError(503, 'WALLET_DEPENDENCY_BUNDLE_UNVERIFIED', message); }
function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(value)) invalid('Invalid chain quantity.');
  return BigInt(value);
}
function fresh(timestamp: number, now: number) {
  if (!Number.isSafeInteger(now) || now <= 60000 || !Number.isSafeInteger(timestamp)
    || timestamp < now - 60000 || timestamp > now + 30000) invalid('Fresh chain evidence is required.');
}
function block(value: unknown, now: number) {
  const v = value as { hash?: unknown; number?: unknown; timestamp?: unknown } | null;
  if (!v || typeof v.hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(v.hash) || BigInt(v.hash) === 0n) invalid('Missing canonical block.');
  const number = quantity(v.number), timestamp = quantity(v.timestamp);
  fresh(Number(timestamp * 1000n), now);
  return { number: v.number as Hex, hash: v.hash as Hex, timestamp: String(timestamp), blockNumber: String(number) };
}
function pins(recipe: Recipe) {
  return [
    { name: 'DeploymentProxy', address: recipe.deployer.address, runtimeCodeHash: keccak256(recipe.deployer.runtime) },
    ...recipe.deployments.map(item => ({ name: item.name, address: item.pin.address, runtimeCodeHash: item.pin.runtimeCodeHash })),
    { name: 'SafeWebAuthnSignerSingleton', address: recipe.profile.signerSingleton.address,
      runtimeCodeHash: recipe.profile.signerSingleton.runtimeCodeHash },
  ];
}

/** Operator-only, read-only dependency observation. This does not enable wallet authority
 * on any chain, create a Relayr quote, sign, submit, or establish an audit approval. */
export async function inspectWalletDependencyChain(options: { chainId: number; rpc: RestRpc; signal?: AbortSignal; now?: () => number }) {
  if (!WALLET_DEPENDENCY_CHAINS.some(chain => chain === options.chainId)) invalid('Unsupported dependency chain.');
  const recipe = await preparePasskeyDependencyDeployment();
  const now = options.now ?? Date.now, observedAt = now();
  const rpc = operationRpc(options.rpc, walletPreflightRpcBounds, options.signal, false, options.chainId);
  try {
    if (quantity(await rpc.request('eth_chainId', [])) !== BigInt(options.chainId)) invalid('The provider returned another chain.');
    const head = block(await rpc.request('eth_getBlockByNumber', ['latest', false]), observedAt);
    const tag = { blockHash: head.hash, requireCanonical: true };
    const observed = await Promise.all(pins(recipe).map(async pin => {
      const code = rpcHex(await rpc.request('eth_getCode', [pin.address, tag]), 'dependency runtime');
      const deployed = code !== '0x', runtimeCodeHash = keccak256(code);
      if ((!deployed && pin.name === 'DeploymentProxy') || (deployed && runtimeCodeHash !== pin.runtimeCodeHash))
        invalid(`${pin.name} runtime differs from the tested artifact.`);
      return { name: pin.name, address: pin.address, runtimeCodeHash, deployed };
    }));
    const factory = observed[2]!, singleton = observed[3]!;
    if (factory.deployed !== singleton.deployed) invalid('Factory and singleton deployment evidence is inconsistent.');
    if (factory.deployed) {
      const result = rpcHex(await rpc.request('eth_call', [{ to: factory.address,
        data: encodeFunctionData({ abi: singletonAbi, functionName: 'SINGLETON' }) }, tag]), 'factory singleton');
      if (decodeFunctionResult({ abi: singletonAbi, functionName: 'SINGLETON', data: result }).toLowerCase()
        !== singleton.address.toLowerCase()) invalid('The factory uses another singleton.');
    }
    const missing: { name: Recipe['deployments'][number]['name']; address: string; runtimeCodeHash: Hex; initCodeHash: Hex;
      transaction: Recipe['deployments'][number]['transaction']; estimatedGas: string }[] = [];
    for (const item of recipe.deployments) {
      if (observed.find(pin => pin.name === item.name)!.deployed) continue;
      const call = { ...item.transaction, value: '0x0' };
      const result = rpcHex(await rpc.request('eth_call', [call, tag]), 'dependency deployment simulation');
      if (result.toLowerCase() !== item.pin.address.toLowerCase()) invalid('Deployment simulation returned another address.');
      const gas = quantity(await rpc.request('eth_estimateGas', [call, head.number]));
      if (gas <= 0n || gas > 8000000n) invalid('The deployment estimate exceeds the reviewed bound.');
      missing.push({ name: item.name, address: item.pin.address, runtimeCodeHash: item.pin.runtimeCodeHash,
        initCodeHash: item.initCodeHash, transaction: item.transaction, estimatedGas: String(gas) });
    }
    const current = block(await rpc.request('eth_getBlockByNumber', [head.number, false]), now());
    if (stable(current) !== stable(head)) invalid('The canonical observation changed.');
    rpc.check();
    return { version: VERSION, chainId: options.chainId, observedAt,
      evidence: { blockNumber: head.blockNumber, blockHash: head.hash, timestamp: head.timestamp }, observed, missing };
  } finally { rpc.close(); }
}

/** Build reviewable unsigned Relayr bytes from fresh operator observations. Reconstruct all
 * calls from compiler artifacts, never from supplied transaction fields. This consistency
 * check does not authenticate saved JSON as chain evidence or authorize its publication. */
export async function prepareWalletDependencyBundle(input: Awaited<ReturnType<typeof inspectWalletDependencyChain>>[], now = Date.now()) {
  const observations = structuredClone(input);
  const recipe = await preparePasskeyDependencyDeployment(), expectedPins = pins(recipe);
  if (!Array.isArray(observations) || observations.length !== WALLET_DEPENDENCY_CHAINS.length
    || new Set(observations.map(item => item.chainId)).size !== WALLET_DEPENDENCY_CHAINS.length)
    invalid('Exactly one observation for each of the eight chains is required.');
  const transactions: RelayrIndependentEntry[] = [];
  for (const chain of WALLET_DEPENDENCY_CHAINS) {
    const item = observations.find(item => item.chainId === chain);
    if (!item || item.version !== VERSION) invalid('The dependency observation chain or version differs.');
    fresh(item.observedAt, now);
    if (!/^(0|[1-9][0-9]{0,77})$/.test(item.evidence.blockNumber)
      || !/^(0|[1-9][0-9]{0,77})$/.test(item.evidence.timestamp)) invalid('Invalid canonical evidence.');
    block({ number: `0x${BigInt(item.evidence.blockNumber).toString(16)}`, hash: item.evidence.blockHash,
      timestamp: `0x${BigInt(item.evidence.timestamp).toString(16)}` }, item.observedAt);
    fresh(Number(BigInt(item.evidence.timestamp) * 1000n), now);
    if (item.observed.length !== expectedPins.length) invalid('Incomplete runtime evidence.');
    expectedPins.forEach((pin, index) => {
      const observed = item.observed[index];
      if (!observed || typeof observed.deployed !== 'boolean'
        || stable(observed) !== stable({ ...pin, deployed: observed.deployed,
          runtimeCodeHash: observed.deployed ? pin.runtimeCodeHash : keccak256('0x') })
        || (index === 0 && !observed.deployed)) invalid('Dependency runtime evidence differs from the recipe.');
    });
    if (item.observed[2]!.deployed !== item.observed[3]!.deployed) invalid('Factory and singleton deployment evidence is inconsistent.');
    const expectedMissing = recipe.deployments.filter(deployment => !item.observed.find(pin => pin.name === deployment.name)!.deployed);
    if (item.missing.length !== expectedMissing.length) invalid('Incomplete missing-dependency evidence.');
    expectedMissing.forEach((deployment, index) => {
      const missing = item.missing[index]!;
      if (!missing || !/^[1-9][0-9]{0,6}$/.test(missing.estimatedGas) || BigInt(missing.estimatedGas) > 8000000n
        || stable(missing) !== stable({ name: deployment.name, address: deployment.pin.address,
          runtimeCodeHash: deployment.pin.runtimeCodeHash, initCodeHash: deployment.initCodeHash,
          transaction: deployment.transaction, estimatedGas: missing.estimatedGas })) invalid('The planned deployment bytes or estimate differ.');
      transactions.push({ chain, target: deployment.transaction.to, data: deployment.transaction.data,
        value: '0' });
    });
  }
  // Neither constructor depends on the other deployment. A failure on one chain
  // must not block independent calls elsewhere in the same prepaid bundle.
  // Match the clients' payment boundary: testnet actions never request mainnet ETH.
  const bundles = ([['mainnet', RELAYR_MAINNET_CHAINS], ['testnet', RELAYR_TESTNET_CHAINS]] as const).map(([family, chains]) => {
    const body = { transactions: transactions.filter(entry => chains.some(chain => chain === entry.chain)),
      virtual_nonce_mode: 'Disabled' as const };
    return { family, body, bodyHash: fingerprint(body) };
  });
  return { version: 'center-wallet-dependency-bundle-v2', preparedAt: now,
    audit: { status: 'pending' as const }, publicationEnabled: false as const, walletActivationChains: [],
    recipe, observations, bundles,
    feeScope: 'execution-gas-estimates-only-not-a-Relayr-quote' as const };
}
