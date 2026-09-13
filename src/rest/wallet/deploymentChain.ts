import { encodeAbiParameters, getAddress, isAddress, keccak256, serializeTransaction, toHex, type Address, type Hex } from "viem";
import { isProxy } from "node:util/types";
import { RestError, type RestBlockEvidence, type RestRpc } from "../core.js";
import type { ContractPin, SmartAccountManifest } from "../smartAccounts/types.js";
import { validatePasskeyCreationManifest, verifySafe7579CreationCall } from "../smartAccounts/creation.js";
import { inspectPasskeyCreationSigner } from "../smartAccounts/passkeyProfile.js";
import { SAFE7579_INSPECTOR_ID, SAFE7579_STORAGE_SOURCE } from "../smartAccounts/inspector.js";
import { rpcHex } from "../protocol/code.js";
import type { RelayPolicy } from "../transactions/types.js";
import { prepareWalletDeploymentTemplate, walletDeploymentDocument, type WalletDeploymentApproval, type WalletDeploymentTemplate } from "./deployment.js";
import type { WalletDeploymentAdmission, WalletDeploymentPoolConfiguration } from "./deploymentPostgres.js";
import { enrollmentDigest, type WalletEnrollment } from "./enrollment.js";

export interface WalletDeploymentChainOptions {
  rpc: RestRpc;
  configuration: WalletDeploymentPoolConfiguration;
  manifest: SmartAccountManifest;
  utility: ContractPin;
  now?: () => number;
  /** Host-owned overrides may only reduce the hard request bounds. */
  limits?: { rpcCalls?: number; rpcTimeoutMs?: number; totalTimeoutMs?: number; responseBytes?: number };
}
export interface WalletDeploymentPreflight {
  admission: WalletDeploymentAdmission;
  template: WalletDeploymentTemplate;
  evidence: RestBlockEvidence;
  signer: { address: Address; deployed: boolean };
  feeModel: {
    kind: "base-execution-only-v1";
    balance: string;
    estimatedGas: string;
    baseFeePerGas: string;
    maximumExecutionCost: string;
    executionEnvelopeCovered: true;
    baseTotalAffordability: "unknown";
  };
  dispatchEligible: false;
}

const bounds = Object.freeze({ rpcCalls: 64, rpcTimeoutMs: 3000, totalTimeoutMs: 15_000, responseBytes: 2 * 1024 * 1024 });
const maxUint256 = (1n << 256n) - 1n;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function fail(code: string, message: string, status = 422): never { throw new RestError(status, code, message); }
function decimal(value: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) > maxUint256)
    fail("WALLET_DEPLOYMENT_CONFIG_INVALID", "Deployment limits require bounded decimal quantities.", 500);
  return BigInt(value);
}
function quantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value) || value.length > 66)
    fail("WALLET_DEPLOYMENT_RPC_INVALID", "The provider returned a noncanonical quantity.", 502);
  return BigInt(value);
}
function word(value: unknown): value is Hex { return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) && BigInt(value) !== 0n; }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function clock(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }

/** A single read-only operation owns all calls, response bytes and cancellation, including helper
 * reads. Promise races also bound transports that fail to honor their AbortSignal. */
function operationRpc(rpc: RestRpc, limits: Record<keyof typeof bounds, number>, signal?: AbortSignal) {
  const controller = new AbortController();
  const operationDeadline = performance.now() + limits.totalTimeoutMs;
  let failure: RestError | undefined, remaining = limits.rpcCalls, remainingBytes = limits.responseBytes;
  const stop = (error: RestError) => { failure ??= error; controller.abort(); };
  const cancel = () => stop(new RestError(499, "WALLET_DEPLOYMENT_CANCELLED", "Deployment observation was cancelled."));
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const deadline = setTimeout(() => stop(new RestError(504, "WALLET_DEPLOYMENT_DEADLINE", "Deployment observation exceeded its total deadline.")), limits.totalTimeoutMs);
  const check = (callDeadline?: number) => {
    const current = performance.now();
    // Timers cannot interrupt synchronous work or a continuously resolving microtask chain.
    if (!failure && current >= operationDeadline)
      stop(new RestError(504, "WALLET_DEPLOYMENT_DEADLINE", "Deployment observation exceeded its total deadline."));
    if (!failure && callDeadline !== undefined && current >= callDeadline)
      stop(new RestError(504, "WALLET_DEPLOYMENT_RPC_TIMEOUT", "The configured RPC did not answer within its deadline."));
    if (failure) throw failure;
  };
  function checkedResponse(value: unknown): unknown {
    // Build only the bounded sanitized copy. Do not clone sparse arrays, invoke proxies/accessors,
    // allocate every descriptor, or serialize an unbounded property name before admission.
    let nodes = 0, bytes = 0;
    const stringBytes = (value: string) => {
      if (Buffer.byteLength(value, "utf8") > remainingBytes || value.length > 524_288)
        fail("WALLET_DEPLOYMENT_RPC_BYTES", "Deployment observation exhausted its response-byte budget.", 429);
      return Buffer.byteLength(JSON.stringify(value), "utf8");
    };
    function visit(item: unknown, depth: number): unknown {
      if (++nodes > 4096 || depth > 8) fail("WALLET_DEPLOYMENT_RPC_BYTES", "The provider response exceeds its structural bound.", 429);
      let result: unknown = item;
      if (typeof item === "string") {
        bytes += stringBytes(item);
      }
      else if (item === null || typeof item === "boolean") bytes += 5;
      else if (typeof item === "number" && Number.isSafeInteger(item)) bytes += 24;
      else if (item && typeof item === "object" && !isProxy(item) &&
        (Array.isArray(item) || Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)) {
        const array = Array.isArray(item);
        if (array && item.length > 4096) fail("WALLET_DEPLOYMENT_RPC_BYTES", "The provider array exceeds its structural bound.", 429);
        const keys = Reflect.ownKeys(item);
        if (keys.length > 4096 || (array && keys.length !== item.length + 1))
          fail("WALLET_DEPLOYMENT_RPC_BYTES", "The provider object exceeds its structural bound.", 429);
        const copy: Record<string, unknown> | unknown[] = array ? [] : Object.create(null) as Record<string, unknown>;
        bytes += 2;
        for (const key of keys) {
          if (typeof key !== "string" || (array && key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)))
            fail("WALLET_DEPLOYMENT_RPC_INVALID", "Expected ordinary provider JSON.", 502);
          if (array && key === "length") continue;
          bytes += stringBytes(key) + 2;
          const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
          if (!("value" in descriptor) || !descriptor.enumerable) fail("WALLET_DEPLOYMENT_RPC_INVALID", "Expected ordinary provider JSON.", 502);
          (copy as Record<string, unknown>)[key] = visit(descriptor.value, depth + 1);
        }
        result = copy;
      } else fail("WALLET_DEPLOYMENT_RPC_INVALID", "Expected ordinary provider JSON.", 502);
      if (bytes > remainingBytes || bytes > 524_288) fail("WALLET_DEPLOYMENT_RPC_BYTES", "Deployment observation exhausted its response-byte budget.", 429);
      return result;
    }
    const result = visit(value, 0); remainingBytes -= bytes;
    return result;
  }
  return {
    check,
    close() { clearTimeout(deadline); signal?.removeEventListener("abort", cancel); controller.abort(); },
    async request(method: string, params: readonly unknown[]): Promise<unknown> {
      check();
      if (--remaining < 0) {
        stop(new RestError(429, "WALLET_DEPLOYMENT_RPC_BUDGET", "Deployment observation exhausted its RPC call budget.")); check();
      }
      const call = new AbortController();
      const callDeadline = performance.now() + limits.rpcTimeoutMs;
      const abort = () => call.abort();
      controller.signal.addEventListener("abort", abort, { once: true });
      const interrupted = new Promise<never>((_, reject) => call.signal.addEventListener("abort", () => reject(failure), { once: true }));
      const timer = setTimeout(() => stop(new RestError(504, "WALLET_DEPLOYMENT_RPC_TIMEOUT", "The configured RPC did not answer within its deadline.")), limits.rpcTimeoutMs);
      try {
        const result = await Promise.race([rpc.request(8453, method, structuredClone(params), call.signal), interrupted]);
        check(callDeadline); const checked = checkedResponse(result); check(callDeadline); return checked;
      } catch (error) {
        stop(error instanceof RestError ? error : new RestError(502, "WALLET_DEPLOYMENT_RPC_UNAVAILABLE", "The configured RPC could not verify the exact deployment."));
        check(); throw error;
      } finally { clearTimeout(timer); controller.signal.removeEventListener("abort", abort); call.abort(); }
    },
  };
}

/** Server-only observation, not authorization, nonce reservation or dispatch. Enrollment and
 * approval must be loaded from the durable store; matching JSON cannot prove that provenance. */
export function createWalletDeploymentChain(options: WalletDeploymentChainOptions) {
  for (const value of [options.configuration, options.manifest, options.utility, options.limits ?? {}]) enrollmentDigest(value);
  const config = structuredClone(options.configuration), manifest = structuredClone(options.manifest), utility = structuredClone(options.utility);
  const limits = { ...bounds, ...options.limits }, now = options.now ?? Date.now, transport = options.rpc;
  if (Object.keys(limits).some(key => !(key in bounds)) || Object.entries(limits).some(([key, value]) =>
    !Number.isSafeInteger(value) || value < 1 || value > bounds[key as keyof typeof bounds]))
    fail("WALLET_DEPLOYMENT_CONFIG_INVALID", "RPC overrides may only reduce the reviewed hard bounds.", 500);
  validatePasskeyCreationManifest(manifest);
  if (config.chainId !== 8453 || !isAddress(config.sender) || BigInt(config.sender) <= 1n ||
    manifest.mode !== "execution-candidate" || manifest.moduleInspectorId !== SAFE7579_INSPECTOR_ID ||
    manifest.entryPoint?.version !== "0.7" || manifest.policies.length > 32 ||
    utility.source.commit !== SAFE7579_STORAGE_SOURCE.commit || !isAddress(utility.address) || BigInt(utility.address) <= 1n ||
    !word(utility.runtimeCodeHash) || !clock(config.policy.maximumObservationAgeMs) || config.policy.maximumObservationAgeMs > 60_000 ||
    !Number.isSafeInteger(config.policy.maximumRawBytes) || config.policy.maximumRawBytes < 1 || config.policy.maximumRawBytes > 131_072)
    fail("WALLET_DEPLOYMENT_CONFIG_INVALID", "Use one configured Base sender, immutable deployment profile and bounded policy.", 500);
  const sender = getAddress(config.sender).toLowerCase() as Address;
  const maximumGas = decimal(config.policy.maximumGas), maximumFeePerGas = decimal(config.policy.maximumFeePerGas),
    maximumTransactionCost = decimal(config.policy.maximumTransactionCost), allocation = decimal(config.allocationWei);
  if (!maximumGas || !maximumFeePerGas || !maximumTransactionCost || maximumTransactionCost > allocation || allocation > decimal(config.globalAllocationLimitWei))
    fail("WALLET_DEPLOYMENT_CONFIG_INVALID", "Execution limits must fit the configured whole allocation.", 500);
  const policy: RelayPolicy = { planTtlMs: 300_000, maximumPlanTtlMs: 300_000, leaseMs: 15_000, rpcTimeoutMs: limits.rpcTimeoutMs,
    maximumRawBytes: config.policy.maximumRawBytes, maximumGas, maximumFeePerGas, maximumTransactionCost, confirmations: 1, allowedChainIds: [8453] };
  return {
    async preflight(input: WalletEnrollment, inputApproval: WalletDeploymentApproval,
      signal?: AbortSignal): Promise<WalletDeploymentPreflight> {
      enrollmentDigest(input); enrollmentDigest(inputApproval);
      const enrollment = structuredClone(input), approval = structuredClone(inputApproval), observedAt = now();
      walletDeploymentDocument(enrollment, approval);
      if (enrollmentDigest(enrollment.intent.manifest) !== enrollmentDigest(manifest))
        fail("WALLET_DEPLOYMENT_MANIFEST_MISMATCH", "Enrollment must use the exact configured manifest.", 409);
      const creation = verifySafe7579CreationCall(manifest, enrollment.creation!.address, enrollment.creation!.transaction.data);
      if (enrollmentDigest(creation) !== enrollmentDigest(enrollment.creation) || !same(creation.transaction.to, manifest.factory.address) || creation.transaction.value !== "0")
        fail("WALLET_DEPLOYMENT_CREATION_MISMATCH", "Enrollment must retain its exact reviewed factory transaction.", 409);
      function live() {
        const current = now();
        if (!clock(observedAt) || !clock(current) || current < observedAt || observedAt < approval.issuedAt ||
          current >= approval.expiresAt || current - observedAt > config.policy.maximumObservationAgeMs)
          fail("WALLET_DEPLOYMENT_OBSERVATION_EXPIRED", "The approval or original chain observation is no longer fresh.", 410);
      }
      live();
      const rpc = operationRpc(transport, limits, signal);
      try {
        rpc.check();
        const [chainId, block] = await Promise.all([rpc.request("eth_chainId", []), rpc.request("eth_getBlockByNumber", ["latest", false])]);
        if (quantity(chainId) !== 8453n || !object(block) || !word(block.hash))
          fail("WALLET_DEPLOYMENT_CHAIN_MISMATCH", "The configured provider did not establish a mined Base block.", 502);
        const number = quantity(block.number), timestamp = quantity(block.timestamp), baseFee = quantity(block.baseFeePerGas);
        if (timestamp > BigInt(Math.floor(observedAt / 1000) + 30) || timestamp + 300n < BigInt(Math.floor(observedAt / 1000)))
          fail("WALLET_DEPLOYMENT_STALE_CHAIN", "The provider block is stale or ahead of the server clock.", 502);
        const evidence: RestBlockEvidence = { chainId: 8453, blockNumber: String(number), blockHash: block.hash.toLowerCase() as Hex,
          timestamp: String(timestamp), source: "onchain" };
        const tag = { blockHash: evidence.blockHash, requireCanonical: true as const };
        const snapshot = { evidence, tag, request: (method: string, params: readonly unknown[]) => rpc.request(method, [...params, tag]) };
        const dependencies = [manifest.factory, manifest.singleton, manifest.safe7579, manifest.launchpad, manifest.entryPoint!,
          manifest.smartSessions, utility, manifest.creationProfile!.multiSend, ...manifest.policies];
        // Bounded fan-out; every helper uses this same operation budget and canonical snapshot.
        for (let start = 0; start < dependencies.length; start += 8)
          await Promise.all(dependencies.slice(start, start + 8).map(async pin => {
            const code = rpcHex(await snapshot.request("eth_getCode", [pin.address]), "deployment dependency runtime", 49_152);
            if (code === "0x" || !same(keccak256(code), pin.runtimeCodeHash))
              fail("WALLET_DEPLOYMENT_RUNTIME_MISMATCH", "A deployment dependency differs from its configured runtime pin.");
          }));
        const signer = await inspectPasskeyCreationSigner({ manifest, publicKey: enrollment.candidate!.publicKey, snapshot });
        if (!same(signer.address, enrollment.creation!.bootstrap.signerAddress))
          fail("WALLET_DEPLOYMENT_CREATION_MISMATCH", "The reviewed signer does not match enrolled creation.", 409);
        await Promise.all([sender, enrollment.intent.recoveryOwner, creation.address].map(async address => {
          if (rpcHex(await snapshot.request("eth_getCode", [address]), "deployment account runtime", 49_152) !== "0x")
            fail("WALLET_DEPLOYMENT_ACCOUNT_CODE", "The sender and recovery owner must be code-free and the Safe must be undeployed.");
        }));
        const [confirmedRaw, pendingRaw, balanceRaw] = await Promise.all([
          snapshot.request("eth_getTransactionCount", [sender]), rpc.request("eth_getTransactionCount", [sender, "pending"]),
          snapshot.request("eth_getBalance", [sender]),
        ]);
        const confirmed = quantity(confirmedRaw), pending = quantity(pendingRaw), balance = quantity(balanceRaw);
        if (confirmed > BigInt(Number.MAX_SAFE_INTEGER) || confirmed !== pending)
          fail("WALLET_DEPLOYMENT_NONCE_NOT_READY", "The canonical confirmed nonce and provider pending signal must agree for this sender lane.", 409);
        // Fixed server fee policy. This bounds execution only; Base data/operator fees remain unknown.
        const priority = 1_000_000n, maxFee = baseFee * 2n + priority;
        if (maxFee > maximumFeePerGas)
          fail("WALLET_DEPLOYMENT_FEE_LIMIT", "The current execution fee envelope exceeds configured policy.");
        const call = { from: sender, to: creation.transaction.to, data: creation.transaction.data, value: "0x0", nonce: toHex(confirmed),
          gas: toHex(maximumGas), maxFeePerGas: toHex(maxFee), maxPriorityFeePerGas: toHex(priority), accessList: [] };
        const expectedResult = encodeAbiParameters([{ type: "address" }], [creation.address]);
        function exactSimulation(result: unknown) {
          if (!same(rpcHex(result, "factory simulation", 32), expectedResult))
            fail("WALLET_DEPLOYMENT_SIMULATION_MISMATCH", "The exact factory call did not return the predicted Safe.");
        }
        const [simulation, estimateRaw] = await Promise.all([
          snapshot.request("eth_call", [call]),
          // estimateGas uses its standard block-number selector; final canonical checks bind that
          // number back to the same hash. All supported state reads and simulations use EIP-1898.
          rpc.request("eth_estimateGas", [call, toHex(number)]),
        ]);
        exactSimulation(simulation);
        const estimatedGas = quantity(estimateRaw), gas = (estimatedGas * 5n + 3n) / 4n + 25_000n;
        if (!estimatedGas || gas > maximumGas)
          fail("WALLET_DEPLOYMENT_GAS_LIMIT", "The exact deployment exceeds its configured execution gas limit.");
        const template = prepareWalletDeploymentTemplate(enrollment, approval, { sender, nonce: String(confirmed), gas: String(gas),
          maxFeePerGas: String(maxFee), maxPriorityFeePerGas: String(priority) }, policy);
        const tx = template.transaction;
        const unsigned = serializeTransaction({ ...tx, nonce: Number(tx.nonce), gas, value: 0n, maxFeePerGas: maxFee, maxPriorityFeePerGas: priority });
        // Two 32-byte scalars, parity, and any resulting RLP list-prefix growth. No signature is produced.
        if ((unsigned.length - 2) / 2 + 68 > config.policy.maximumRawBytes)
          fail("WALLET_DEPLOYMENT_RAW_LIMIT", "The deployment envelope exceeds the configured signed-byte limit.");
        const maximumExecutionCost = gas * maxFee;
        if (balance < maximumExecutionCost)
          fail("WALLET_DEPLOYMENT_EXECUTION_BALANCE", "The observed balance cannot cover the execution gas envelope.");
        exactSimulation(await snapshot.request("eth_call", [{ ...call, gas: toHex(gas) }]));
        const [canonical, pendingAgain] = await Promise.all([
          rpc.request("eth_getBlockByNumber", [toHex(number), false]), rpc.request("eth_getTransactionCount", [sender, "pending"]),
        ]);
        if (!object(canonical) || !word(canonical.hash) || !same(canonical.hash, evidence.blockHash) || quantity(canonical.number) !== number ||
          quantity(canonical.timestamp) !== timestamp || quantity(canonical.baseFeePerGas) !== baseFee)
          fail("WALLET_DEPLOYMENT_REORGED", "The simulation block changed before admission.", 409);
        if (quantity(pendingAgain) !== confirmed)
          fail("WALLET_DEPLOYMENT_NONCE_NOT_READY", "The sender pending nonce changed during observation.", 409);
        rpc.check(); live();
        return { admission: { version: "center-wallet-deployment-admission-v1", chainId: 8453, sender,
          blockNumber: evidence.blockNumber, blockHash: evidence.blockHash, confirmedNonce: String(confirmed), pendingNonce: String(pending), observedAt,
          enrollmentCommitment: approval.enrollmentCommitment, manifestRevision: manifest.revision, initializerHash: creation.initializerHash,
          gas: String(gas), maxFeePerGas: String(maxFee), maxPriorityFeePerGas: String(priority) }, template, evidence, signer,
          feeModel: { kind: "base-execution-only-v1", balance: String(balance), estimatedGas: String(estimatedGas), baseFeePerGas: String(baseFee),
            maximumExecutionCost: String(maximumExecutionCost), executionEnvelopeCovered: true, baseTotalAffordability: "unknown" }, dispatchEligible: false };
      } catch (error) { rpc.check(); throw error; } finally { rpc.close(); }
    },
  };
}
