#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { concatHex, getContractAddress, keccak256, toHex } from "viem";

export const GUARD_CHAINS = [1, 10, 8453, 42161];
export const GUARD_FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
// Canonical deterministic-deployment-proxy runtime, also used by the V6 deployment scripts.
// https://github.com/Arachnid/deterministic-deployment-proxy#latest-outputs
export const GUARD_FACTORY_CODE = "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";
export const GUARD_RUNTIME_HASH = "0xb8787af1b7dad3b5fac11ec656824adbe575610ee467661be4acde928e3d7c04";
export const GUARD_INIT_CODE_HASH = "0xeed7bb1fee3d225f8c1482d77c7c86a21f93f5530212eacbe23a667103e58762";
export const GUARD_SOURCE_HASH = "c8af7efe042c7bdc6a31d75f780a78a7f3d52563222c1da40acbda72a75f5069";
const artifactFile = "src/rest/smartAccounts/stack/current-pimlico/artifacts/CenterSessionGuardV2.json";
const root = fileURLToPath(new URL("../../", import.meta.url));
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const quantity = (value) => {
  assert.match(value, /^0x(?:0|[1-9a-f][0-9a-f]*)$/i, "Malformed RPC quantity");
  return BigInt(value);
};

export async function loadGuardArtifact() {
  const bytes = await readFile(resolve(root, artifactFile));
  const artifact = JSON.parse(bytes);
  const manifest = JSON.parse(await readFile(resolve(root, "src/rest/smartAccounts/stack/current-pimlico/guard-manifest.json")));
  assert.equal(sha256(bytes), manifest.component.fileSha256, "Guard artifact differs from reviewed manifest");
  assert.equal(artifact.source.sha256, GUARD_SOURCE_HASH, "Guard source revision changed");
  assert.equal(sha256(await readFile(resolve(root, artifact.source.path))), GUARD_SOURCE_HASH, "Guard source differs from reviewed artifact");
  assert.equal(artifact.runtimeCodeHash, GUARD_RUNTIME_HASH, "Guard runtime pin changed");
  assert.equal(keccak256(artifact.deployedBytecode), GUARD_RUNTIME_HASH, "Guard runtime bytes differ from pin");
  assert.deepEqual(artifact.compiler, {
    version: "0.8.28+commit.7893614a", evmVersion: "cancun",
    optimizer: { enabled: true, runs: 200 }, metadata: { bytecodeHash: "none" },
  });
  assert.equal(artifact.abi.some((entry) => entry.type === "constructor" && entry.inputs.length), false, "Unexpected constructor arguments");
  return { artifact, artifactSha256: sha256(bytes) };
}

export function guardDeploymentTransaction(artifact) {
  assert.equal(keccak256(artifact.deployedBytecode), GUARD_RUNTIME_HASH, "Guard runtime mismatch");
  assert.equal(keccak256(artifact.bytecode), GUARD_INIT_CODE_HASH, "Guard creation bytecode mismatch");
  const salt = keccak256(toHex(`juicebox.center:CenterSessionGuardV2:current-v2:${GUARD_RUNTIME_HASH}`));
  return {
    salt,
    address: getContractAddress({ opcode: "CREATE2", from: GUARD_FACTORY, salt, bytecode: artifact.bytecode }),
    to: GUARD_FACTORY,
    data: concatHex([salt, artifact.bytecode]),
    value: "0x0",
  };
}

export async function inspectGuardChain(chainId, artifact, rpc) {
  assert.ok(GUARD_CHAINS.includes(chainId), "Choose a supported production chain");
  assert.equal(quantity(await rpc(chainId, "eth_chainId", [])), BigInt(chainId), "RPC chain mismatch");
  const block = await rpc(chainId, "eth_getBlockByNumber", ["latest", false]);
  quantity(block?.number);
  assert.match(block?.hash, /^0x[0-9a-f]{64}$/i, "Missing canonical block hash");
  const tag = { blockHash: block.hash, requireCanonical: true };
  const deployment = guardDeploymentTransaction(artifact);
  const [factoryCode, guardCode, paymasterCode] = await Promise.all([
    rpc(chainId, "eth_getCode", [GUARD_FACTORY, tag]),
    rpc(chainId, "eth_getCode", [deployment.address, tag]),
    rpc(chainId, "eth_getCode", [artifact.paymasterBinding.address, tag]),
  ]);
  assert.ok(same(factoryCode, GUARD_FACTORY_CODE), "Canonical deployment factory runtime mismatch");
  assert.equal(keccak256(paymasterCode), artifact.paymasterBinding.runtimeCodeHash, "Pinned sponsor runtime mismatch");
  const deployed = guardCode !== "0x";
  if (deployed) assert.equal(keccak256(guardCode), GUARD_RUNTIME_HASH, "Existing guard runtime mismatch");
  let estimate;
  if (!deployed) {
    const call = { to: deployment.to, data: deployment.data, value: deployment.value };
    const simulatedAddress = await rpc(chainId, "eth_call", [call, tag]);
    assert.ok(same(simulatedAddress, deployment.address), "Factory simulation returned a different address");
    const gas = quantity(await rpc(chainId, "eth_estimateGas", [call, block.number]));
    const gasPrice = quantity(await rpc(chainId, "eth_gasPrice", []));
    assert.ok(gas > 0n && gasPrice > 0n, "Missing positive deployment estimate");
    estimate = {
      gas: gas.toString(), gasLimitWith25PercentMargin: ((gas * 125n + 99n) / 100n).toString(),
      observedGasPriceWei: gasPrice.toString(), estimatedExecutionFeeWei: (gas * gasPrice).toString(),
      scope: chainId === 10 || chainId === 8453
        ? "Execution gas only; L1 data and any operator fees are additional."
        : chainId === 42161 ? "RPC gas estimate includes the current L1 posting estimate; actual fees can change."
          : "Execution gas at the observed gas price; actual fees can change.",
      senderVerified: false,
    };
  }
  const current = await rpc(chainId, "eth_getBlockByNumber", [block.number, false]);
  assert.ok(same(current?.hash, block.hash), "Deployment evidence block was reorganized");
  return {
    chainId, status: deployed ? "already-deployed" : "ready-for-wallet-review",
    guardAddress: deployment.address, runtimeCodeHash: GUARD_RUNTIME_HASH,
    factoryRuntimeCodeHash: keccak256(factoryCode), paymasterRuntimeCodeHash: keccak256(paymasterCode),
    evidence: { blockNumber: quantity(block.number).toString(), blockHash: block.hash, canonical: true },
    ...(deployed ? {} : { transaction: { chainId, to: deployment.to, data: deployment.data, value: deployment.value }, estimate }),
  };
}

export async function verifyGuardReceipt(chainId, artifact, transactionHash, rpc, minimumConfirmations = 2, sphinxSafe) {
  assert.match(transactionHash, /^0x[0-9a-f]{64}$/i, "Use an exact deployment transaction hash");
  assert.ok(Number.isSafeInteger(minimumConfirmations) && minimumConfirmations > 0, "Choose positive confirmations");
  const inspected = await inspectGuardChain(chainId, artifact, rpc);
  assert.equal(inspected.status, "already-deployed", "Guard is not deployed");
  const deployment = guardDeploymentTransaction(artifact);
  const [receipt, tx] = await Promise.all([
    rpc(chainId, "eth_getTransactionReceipt", [transactionHash]),
    rpc(chainId, "eth_getTransactionByHash", [transactionHash]),
  ]);
  assert.ok(receipt && tx && receipt.status === "0x1" && receipt.contractAddress === null, "Expected successful factory receipt");
  assert.ok(same(receipt.transactionHash, transactionHash) && same(tx.hash, transactionHash), "Deployment transaction hash differs");
  assert.ok(same(tx.blockHash, receipt.blockHash) && tx.blockNumber === receipt.blockNumber, "Transaction and receipt blocks differ");
  assert.match(tx.from, /^0x[0-9a-f]{40}$/i, "Missing deployment sender");
  if (tx.chainId !== undefined) assert.equal(quantity(tx.chainId), BigInt(chainId), "Deployment transaction chain differs");
  if (sphinxSafe !== undefined) {
    assert.match(sphinxSafe, /^0x[0-9a-f]{40}$/i, "Use the exact Sphinx Safe address");
    assert.ok(BigInt(sphinxSafe) !== 0n, "Sphinx Safe must be nonzero");
    const trace = await rpc(chainId, "debug_traceTransaction", [transactionHash, { tracer: "callTracer", tracerConfig: { onlyTopCall: false } }]);
    assert.ok(trace && !trace.error && trace.type === "CALL" && same(trace.from, tx.from) && same(trace.to, tx.to)
      && same(trace.input, tx.input) && quantity(trace.value ?? "0x0") === quantity(tx.value), "Trace root differs from canonical transaction");
    let visited = 0, matches = 0;
    const pending = [{ frame: trace, depth: 0, failedAncestor: false }];
    while (pending.length) {
      const { frame, depth, failedAncestor } = pending.pop();
      assert.ok(frame && typeof frame === "object" && ++visited <= 10_000 && depth <= 64, "Incomplete or oversized execution trace");
      const failed = failedAncestor || Boolean(frame.error);
      if (same(frame.to, GUARD_FACTORY) && same(frame.input, deployment.data)) {
        assert.ok(!failed && frame.type === "CALL" && same(frame.from, sphinxSafe)
          && quantity(frame.value ?? "0x0") === 0n && same(frame.output, deployment.address), "Exact factory call failed or came from another Safe");
        matches++;
      }
      if (frame.calls !== undefined) {
        assert.ok(Array.isArray(frame.calls), "Incomplete execution trace");
        for (const child of frame.calls) pending.push({ frame: child, depth: depth + 1, failedAncestor: failed });
      }
    }
    assert.equal(matches, 1, "Trace must prove one exact successful Safe-to-factory call");
  } else {
    assert.ok(same(tx.to, GUARD_FACTORY) && same(tx.input, deployment.data) && quantity(tx.value) === 0n,
      "Deployment transaction differs from exact reviewed factory call");
  }
  const confirmations = BigInt(inspected.evidence.blockNumber) - quantity(receipt.blockNumber) + 1n;
  assert.ok(confirmations >= BigInt(minimumConfirmations), "Deployment needs more confirmations");
  const canonical = async () => {
    const block = await rpc(chainId, "eth_getBlockByNumber", [receipt.blockNumber, false]);
    assert.ok(same(block?.hash, receipt.blockHash), "Deployment receipt block was reorganized");
  };
  await canonical();
  const code = await rpc(chainId, "eth_getCode", [deployment.address, { blockHash: receipt.blockHash, requireCanonical: true }]);
  assert.equal(keccak256(code), GUARD_RUNTIME_HASH, "Deployment receipt runtime mismatch");
  await canonical();
  return {
    chainId, guardAddress: deployment.address, transactionHash, sender: tx.from,
    blockNumber: quantity(receipt.blockNumber).toString(), blockHash: receipt.blockHash,
    confirmations: confirmations.toString(), canonical: true, finalized: false,
    runtimeCodeHash: GUARD_RUNTIME_HASH,
    ...(sphinxSafe ? { sphinxSafe, exactFactoryCallVerified: true } : {}),
    configurationAddition: { chainId, sessionGuardAddress: deployment.address, sessionGuardVersion: "current-v2" },
  };
}

async function main(args) {
  if (args[0] === "--help") {
    process.stdout.write("Prepare unsigned current-v2 guard deployments on chains 1, 10, 8453 and 42161.\nUsage: node scripts/rest/prepare-session-guard.mjs --out PATH\nVerify direct deployment: node scripts/rest/prepare-session-guard.mjs --receipts HASHES_JSON --out PATH\nVerify Sphinx: node scripts/rest/prepare-session-guard.mjs --sphinx-receipts HASHES_JSON --out PATH\nDirect HASHES_JSON maps chain ID to transaction hash. Sphinx maps each chain ID to {transactionHash,safeAddress}; complete callTracer RPC support is required.\nVerification requires at least two confirmations. No keys, signatures, broadcasts or production configuration changes.\nOptional CENTER_GUARD_RPC_URLS is a private JSON mapping from chain ID to fixed HTTPS RPC URL.\n");
    return;
  }
  const sphinx = args[0] === "--sphinx-receipts";
  const verify = args.length === 4 && ["--receipts", "--sphinx-receipts"].includes(args[0]) && args[2] === "--out";
  assert.ok(verify || args.length === 2 && args[0] === "--out" && args[1], "Use --out PATH or --receipts HASHES_JSON --out PATH");
  const output = verify ? args[3] : args[1];
  const receipts = verify ? JSON.parse(await readFile(args[1], "utf8")) : undefined;
  if (sphinx) for (const chainId of GUARD_CHAINS) {
    assert.equal(typeof receipts[chainId]?.safeAddress, "string", "Sphinx receipt entries require safeAddress");
  }
  const configured = process.env.CENTER_GUARD_RPC_URLS ? JSON.parse(process.env.CENTER_GUARD_RPC_URLS) : {};
  const endpoints = new Map(GUARD_CHAINS.map((chainId) => {
    const url = new URL(configured[chainId] ?? `https://juicebox.center/v1/rpc/${chainId}`);
    assert.ok(url.protocol === "https:" && !url.username && !url.password && !url.hash, "Use fixed HTTPS RPC endpoints");
    return [chainId, url];
  }));
  let id = 0;
  const rpc = async (chainId, method, params) => {
    try {
      const response = await fetch(endpoints.get(chainId), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(20_000),
      });
      const body = await response.json();
      assert.ok(response.ok && !body.error && Object.hasOwn(body, "result"));
      return body.result;
    } catch { throw new Error(`Read-only RPC failed on chain ${chainId}: ${method}`); }
  };
  const { artifact, artifactSha256 } = await loadGuardArtifact();
  const deployment = guardDeploymentTransaction(artifact);
  const chains = [];
  for (const chainId of GUARD_CHAINS) {
    chains.push(verify ? await verifyGuardReceipt(chainId, artifact, sphinx ? receipts[chainId]?.transactionHash : receipts[chainId], rpc,
      2, sphinx ? receipts[chainId]?.safeAddress : undefined)
      : await inspectGuardChain(chainId, artifact, rpc));
    process.stderr.write(`Verified ${verify ? "guard deployment receipt" : "unsigned guard deployment"} on chain ${chainId}.\n`);
  }
  const plan = {
    format: verify ? "juicebox-center-session-guard-receipts-v1" : "juicebox-center-session-guard-deployment-v1", preparedAt: new Date().toISOString(),
    guardVersion: "current-v2", paymasterProfile: "pimlico-v7-current-flags", artifactFile, artifactSha256,
    sourceSha256: GUARD_SOURCE_HASH, runtimeCodeHash: GUARD_RUNTIME_HASH,
    factory: GUARD_FACTORY, salt: deployment.salt, guardAddress: deployment.address,
    initCodeHash: keccak256(artifact.bytecode), chains,
    ...(verify ? {} : { approvalRequired: "Choose a funded deployment wallet and approve each exact transaction and fee. No transaction has been signed or broadcast." }),
    afterDeployment: "Verify each successful receipt, exact factory calldata, and guard runtime after confirmations before configuring sessionGuardAddress and sessionGuardVersion. Wallet funding and owner-approved session activation remain separate.",
  };
  await writeFile(output, JSON.stringify(plan, null, 2) + "\n", { flag: "wx" });
  process.stderr.write(verify ? `Verified four deployment receipts; guard address ${deployment.address}. No configuration was changed.\n`
    : `Prepared ${chains.filter((chain) => chain.transaction).length} unsigned transactions; guard address ${deployment.address}.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(error instanceof Error && /^Read-only RPC failed /.test(error.message)
      ? error.message + "\n" : "Guard preparation failed: check reviewed artifacts, chain evidence and output path. No transaction was signed or broadcast.\n");
    process.exitCode = 1;
  });
}
