#!/usr/bin/env node
/** Read-only public RPC evidence collection. Never changes the trusted manifest. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { keccak256 } from 'viem';

const args = process.argv.slice(2);
assert((args.length === 2 || (args.length === 4 && args[2] === '--anchors' && args[3]))
  && args[0] === '--output' && args[1], 'Usage: node observe.mjs --output PATH [--anchors PREVIOUS_OBSERVATIONS_JSON]');
const outputPath = resolve(args[1]);
const catalogPath = new URL('../../contracts/data/catalog.json', import.meta.url);
const input = await readFile(catalogPath, 'utf8');
const catalog = JSON.parse(input);
assert.equal(catalog.schemaVersion, 1);
assert.equal(catalog.protocolVersion, 6);

// Public endpoints only: no environment variables, tokens, or caller-supplied URLs.
const endpoints = {
  1: ['https://ethereum.publicnode.com', 'https://ethereum.reth.rs/rpc'],
  10: ['https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com'],
  8453: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
  42161: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'],
  84532: ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'],
  421614: ['https://sepolia-rollup.arbitrum.io/rpc', 'https://arbitrum-sepolia-rpc.publicnode.com'],
  11155111: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://11155111.rpc.thirdweb.com'],
  11155420: ['https://sepolia.optimism.io', 'https://optimism-sepolia-rpc.publicnode.com'],
};
assert.deepEqual(catalog.chains.map(chain => chain.id).sort((a, b) => a - b), Object.keys(endpoints).map(Number).sort((a, b) => a - b));
const anchorBytes = args[3] ? await readFile(resolve(args[3]), 'utf8') : undefined;
const anchors = anchorBytes ? JSON.parse(anchorBytes) : undefined;
if (anchors) {
  assert.equal(anchors.schemaVersion, 1);
  assert.equal(anchors.protocolVersion, 6);
  assert.deepEqual(anchors.chains.map(chain => chain.chainId).sort((a, b) => a - b), Object.keys(endpoints).map(Number).sort((a, b) => a - b));
  assert(anchors.chains.every(chain => chain.status === 'observed' && /^0x[0-9a-f]+$/i.test(chain.blockNumber)
    && /^0x[0-9a-f]{64}$/i.test(chain.blockHash)), 'Every provided anchor needs an explicit block number and hash');
}
const byteLimit = 1024 * 1024;
let requestId = 0;
async function rpc(url, method, params) {
  const id = ++requestId;
  const signal = AbortSignal.timeout(20_000);
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal, redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > byteLimit) {
    await response.body?.cancel();
    throw new Error('RPC response exceeds 1 MiB');
  }
  assert(response.body, 'RPC response has no body');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      assert(length <= byteLimit, 'RPC response exceeds 1 MiB');
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length));
  const result = JSON.parse(decoded);
  assert(result && typeof result === 'object' && !Array.isArray(result), 'Invalid RPC response');
  assert.equal(result.jsonrpc, '2.0');
  assert.equal(result.id, id, 'RPC response ID mismatch');
  if (result.error) throw new Error(`RPC ${result.error.code}: ${String(result.error.message).slice(0, 500)}`);
  assert(Object.hasOwn(result, 'result'), 'Missing RPC result');
  return result.result;
}
const errorText = error => String(error instanceof Error ? error.message : error).slice(0, 1000);
const targetNames = ['JBController', 'JBMultiTerminal', 'JBHeldFees', 'JBPayoutSplitGroupLib'];
const targets = catalog.contracts.filter(contract => contract.packageId === '@bananapus/core-v6'
  && targetNames.includes(contract.name));
assert.equal(targets.length, targetNames.length, 'Expected exactly four contract identities');

const runtimes = {};
const results = await Promise.all(catalog.chains.map(async chain => {
  const observations = targets.map(contract => {
    const deployment = contract.deployments.find(item => item.chainId === chain.id);
    assert(deployment && deployment.status === 'published' && deployment.instances.length === 1,
      `Unexpected published deployment count: ${chain.id} ${contract.name}`);
    const instance = deployment.instances[0];
    assert.equal(instance.chainId, chain.id);
    assert.equal(instance.sourceRef, 'npm:@bananapus/core-v6@1.0.2');
    assert(/^0x[0-9a-fA-F]{40}$/.test(instance.address));
    return {
      contractId: contract.id, contractName: contract.name, chainId: chain.id,
      address: instance.address, sourceRef: instance.sourceRef, codeId: instance.codeId,
      abiHash: instance.abiHash, deploymentReceipt: instance.receipt,
    };
  });
  const failures = [];
  for (const endpoint of endpoints[chain.id]) {
    try {
      assert.equal(Number(BigInt(await rpc(endpoint, 'eth_chainId', []))), chain.id, 'RPC chain ID mismatch');
      let block;
      let anchorTag = 'finalized';
      const providedAnchor = anchors?.chains.find(item => item.chainId === chain.id);
      if (providedAnchor) {
        anchorTag = 'provided';
        block = await rpc(endpoint, 'eth_getBlockByNumber', [providedAnchor.blockNumber, false]);
        assert.equal(block?.number?.toLowerCase(), providedAnchor.blockNumber.toLowerCase(), 'Provided anchor number mismatch');
        assert.equal(block?.hash?.toLowerCase(), providedAnchor.blockHash.toLowerCase(), 'Provided anchor is no longer canonical');
      } else {
        try {
          block = await rpc(endpoint, 'eth_getBlockByNumber', [anchorTag, false]);
        } catch (error) {
          failures.push({ endpoint, stage: 'finalized-anchor', error: errorText(error) });
          anchorTag = 'latest';
          block = await rpc(endpoint, 'eth_getBlockByNumber', [anchorTag, false]);
        }
      }
      assert(block && /^0x[0-9a-f]{64}$/i.test(block.hash) && /^0x[0-9a-f]+$/i.test(block.number), 'Invalid anchor block');
      assert(!observations.some(item => BigInt(item.deploymentReceipt.blockNumber) > BigInt(block.number)), 'Anchor precedes deployment');
      const readResults = [];
      const readRuntimes = {};
      for (const observation of observations) {
        let runtimeHex;
        let readMode = 'EIP-1898-requireCanonical';
        try {
          runtimeHex = await rpc(endpoint, 'eth_getCode', [observation.address, { blockHash: block.hash, requireCanonical: true }]);
        } catch (error) {
          failures.push({ endpoint, stage: 'hash-anchored-code', address: observation.address, error: errorText(error) });
          readMode = 'block-number-with-hash-revalidation';
          runtimeHex = await rpc(endpoint, 'eth_getCode', [observation.address, block.number]);
        }
        assert(typeof runtimeHex === 'string' && /^0x(?:[0-9a-f]{2})+$/i.test(runtimeHex),
          `Empty or malformed code at ${observation.address}`);
        runtimeHex = runtimeHex.toLowerCase();
        const runtimeKeccak256 = keccak256(runtimeHex);
        readRuntimes[runtimeKeccak256] = { runtimeHex, runtimeByteLength: (runtimeHex.length - 2) / 2 };
        readResults.push({ ...observation, blockNumber: block.number, blockHash: block.hash.toLowerCase(), readMode, runtimeKeccak256 });
      }
      const after = await rpc(endpoint, 'eth_getBlockByNumber', [block.number, false]);
      assert.equal(after?.hash?.toLowerCase(), block.hash.toLowerCase(), 'Anchor canonical hash changed after reads');
      assert.equal(after?.number?.toLowerCase(), block.number.toLowerCase(), 'Revalidated block number mismatch');
      for (const [hash, runtime] of Object.entries(readRuntimes)) {
        if (Object.hasOwn(runtimes, hash)) assert.deepEqual(runtimes[hash], runtime, 'Runtime hash collision');
        runtimes[hash] = runtime;
      }
      return {
        chainId: chain.id, chainName: chain.name, status: 'observed', endpoint, anchorTag,
        blockNumber: block.number, blockHash: block.hash.toLowerCase(), canonicalHashRevalidated: true,
        observedAt: new Date().toISOString(), observations: readResults, failures,
      };
    } catch (error) {
      failures.push({ endpoint, stage: 'endpoint', error: errorText(error) });
    }
  }
  return { chainId: chain.id, chainName: chain.name, status: 'failed', observations: [], failures };
}));
const output = {
  schemaVersion: 1, protocolVersion: 6, createdAt: new Date().toISOString(),
  catalogPath: 'src/rest/contracts/data/catalog.json', catalogSha256: createHash('sha256').update(input).digest('hex'),
  scope: 'Published @bananapus/core-v6@1.0.2 JBController, JBMultiTerminal, JBHeldFees and JBPayoutSplitGroupLib on all eight catalog chains',
  ...(anchorBytes ? { providedAnchorsSha256: createHash('sha256').update(anchorBytes).digest('hex') } : {}),
  requestedObservations: 32, completedObservations: results.reduce((sum, result) => sum + result.observations.length, 0),
  runtimes: Object.fromEntries(Object.entries(runtimes).sort(([a], [b]) => a.localeCompare(b))), chains: results,
};
const outputBytes = `${JSON.stringify(output, null, 2)}\n`;
await writeFile(outputPath, outputBytes);
console.log(JSON.stringify({
  completedObservations: output.completedObservations, requestedObservations: output.requestedObservations,
  observationsSha256: createHash('sha256').update(outputBytes).digest('hex'),
  chains: results.map(({ chainId, status, blockNumber, blockHash, anchorTag, failures }) => ({ chainId, status, blockNumber, blockHash, anchorTag, failures })),
}));
if (output.completedObservations !== output.requestedObservations) process.exitCode = 1;
