import { decodeEventLog, encodeAbiParameters, getAddress, isAddress, keccak256, padHex, parseTransaction, serializeTransaction,
  stringToHex, toHex, type Address, type Hex } from "viem";
import { RestError, type RestBlockEvidence, type RestRpc } from "../core.js";
import type { ContractPin, SmartAccountManifest } from "../smartAccounts/types.js";
import { SAFE_CREATION_ABI, validatePasskeyCreationManifest, verifySafe7579CreationCall } from "../smartAccounts/creation.js";
import { inspectPasskeyCreationSigner } from "../smartAccounts/passkeyProfile.js";
import { createSafe7579Inspector, SAFE7579_INSPECTOR_ID, SAFE7579_STORAGE_SOURCE } from "../smartAccounts/inspector.js";
import { createSmartAccountService, stable } from "../smartAccounts/service.js";
import { createInstalledSessionVerifier } from "../smartAccounts/installed.js";
import { MemorySmartAccountRegistry } from "../smartAccounts/registry.js";
import { rpcHex } from "../protocol/code.js";
import type { RelayPolicy } from "../transactions/types.js";
import { prepareWalletDeploymentTemplate, validateSignedWalletDeployment, walletDeploymentDocument, type WalletDeploymentApproval, type WalletDeploymentTemplate } from "./deployment.js";
import type { WalletDeploymentAdmission, WalletDeploymentOperation, WalletDeploymentPoolConfiguration } from "./deploymentPostgres.js";
import { assertWalletDeploymentObservation, type WalletDeploymentObservation } from "./deploymentObservation.js";
import { enrollmentDigest, type WalletEnrollment } from "./enrollment.js";
import { operationRpc, walletPreflightRpcBounds as bounds, walletObservationRpcBounds as observationBounds } from "./operationRpc.js";

export interface WalletDeploymentChainOptions {
  rpc: RestRpc;
  configuration: WalletDeploymentPoolConfiguration;
  manifest: SmartAccountManifest;
  utility: ContractPin;
  now?: () => number;
  /** Host-owned overrides may only reduce the hard request bounds. */
  limits?: { rpcCalls?: number; rpcTimeoutMs?: number; totalTimeoutMs?: number; responseBytes?: number };
  /** Separate read-only recovery budget. It does not increase fresh preflight limits. */
  observationLimits?: { rpcCalls?: number; rpcTimeoutMs?: number; totalTimeoutMs?: number; responseBytes?: number };
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
/** RPC clients expose signature integers as either minimal quantities or fixed32-byte DATA.
 * Accept only those two bounded forms; numerical equality below still binds the original raw signature. */
function signatureScalar(value: unknown): bigint {
  if (typeof value !== "string" || value.length > 66 ||
      (!/^0x[1-9a-fA-F][0-9a-fA-F]{0,63}$/.test(value) && !/^0x[0-9a-fA-F]{64}$/.test(value)) || BigInt(value) === 0n)
    fail("WALLET_DEPLOYMENT_RPC_INVALID", "The provider returned an invalid signature scalar.", 502);
  return BigInt(value);
}
function word(value: unknown): value is Hex { return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) && BigInt(value) !== 0n; }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function clock(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }

/** Server-only observation, not authorization, nonce reservation or dispatch. Enrollment and
 * approval must be loaded from the durable store; matching JSON cannot prove that provenance. */
export function createWalletDeploymentChain(options: WalletDeploymentChainOptions) {
  for (const value of [options.configuration, options.manifest, options.utility, options.limits ?? {}, options.observationLimits ?? {}]) enrollmentDigest(value);
  const config = structuredClone(options.configuration), manifest = structuredClone(options.manifest), utility = structuredClone(options.utility);
  const limits = { ...bounds, ...options.limits }, now = options.now ?? Date.now, transport = options.rpc;
  const recoveryLimits = { ...observationBounds, ...options.observationLimits };
  if (Object.keys(limits).some(key => !(key in bounds)) || Object.entries(limits).some(([key, value]) =>
    !Number.isSafeInteger(value) || value < 1 || value > bounds[key as keyof typeof bounds]))
    fail("WALLET_DEPLOYMENT_CONFIG_INVALID", "RPC overrides may only reduce the reviewed hard bounds.", 500);
  if (Object.keys(recoveryLimits).some(key => !(key in observationBounds)) || Object.entries(recoveryLimits).some(([key, value]) =>
    !Number.isSafeInteger(value) || value < 1 || value > observationBounds[key as keyof typeof observationBounds]))
    fail("WALLET_DEPLOYMENT_CONFIG_INVALID", "Observation overrides may only reduce the reviewed hard bounds.", 500);
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
    /** `inspection: "inclusion"` stops at the verified receipt (our exact transaction, its creation
     * log, the sender nonce past it, finality) and leaves the wallet's full inspection for later: the
     * worker's own pass, activation and the authority refresh each prove the account's state before
     * anything binds to it. The default reads the wallet in full, as settlement requires. */
    async observeSigned(input: { enrollment: WalletEnrollment; operation: WalletDeploymentOperation },
      signal?: AbortSignal, options: { inspection?: "full" | "inclusion" } = {}): Promise<WalletDeploymentObservation> {
      enrollmentDigest(input);
      const { enrollment, operation } = structuredClone(input), observedAt = now();
      // Recovery validates the durable winner without requiring its old approval to remain live.
      if (!clock(observedAt) || operation.state !== "signed" || !operation.signed || !operation.template || !operation.admission ||
        operation.id !== operation.approval.id || operation.enrollmentId !== enrollment.intent.id || operation.poolId !== config.id ||
        operation.poolConfigurationDigest !== enrollmentDigest(config) || enrollmentDigest(enrollment.intent.manifest) !== enrollmentDigest(manifest) ||
        !same(operation.template.sender, sender))
        fail("WALLET_DEPLOYMENT_OBSERVATION_CONTEXT", "Observation requires the immutable configured signed operation.", 400);
      const signed = await validateSignedWalletDeployment({ enrollment, approval: operation.approval, template: operation.template,
        rawTransaction: operation.signed.rawTransaction, policy });
      if (!same(signed.hash, operation.signed.hash) || signed.templateCommitment !== operation.templateCommitment ||
        signed.maximumExecutionCost !== operation.signed.maximumExecutionCost)
        fail("WALLET_DEPLOYMENT_OBSERVATION_CONTEXT", "The signed artifact differs from its durable winner.", 400);
      const parsed = parseTransaction(signed.rawTransaction), template = operation.template.transaction, creation = enrollment.creation!;
      const empty: WalletDeploymentObservation = { version: "center-wallet-deployment-observation-v1", operationId: operation.id,
        templateCommitment: signed.templateCommitment, transactionHash: signed.hash, observedAt, head: null,
        transaction: { state: "unknown", reason: "observation-unavailable", receipt: null, conflict: null, nonce: null },
        finality: { state: "unknown", evidence: null }, wallet: { state: "unknown", address: creation.address.toLowerCase() as Address,
          initializerHash: creation.initializerHash, stateHash: null, evidence: null, creationTransaction: null, reason: "wallet-state-unavailable" },
        fees: { executionWei: null, l1Wei: null, operatorWei: null, totalWei: null }, dispatchEligible: false };
      const output = structuredClone(empty), rpc = operationRpc(transport, recoveryLimits, signal, true);
      const anchors = new Map<string, RestBlockEvidence>();
      function invalid(): never { return fail("WALLET_DEPLOYMENT_OBSERVATION_INVALID", "The provider did not prove the exact canonical deployment.", 502); }
      function anchor(raw: unknown): RestBlockEvidence {
        if (!object(raw) || !word(raw.hash)) return invalid();
        const evidence: RestBlockEvidence = { chainId: 8453, blockNumber: String(quantity(raw.number)), blockHash: raw.hash.toLowerCase() as Hex,
          timestamp: String(quantity(raw.timestamp)), source: "onchain" };
        const prior = anchors.get(evidence.blockNumber);
        if (prior && stable(prior) !== stable(evidence)) return invalid();
        anchors.set(evidence.blockNumber, evidence); return evidence;
      }
      const tag = (at: RestBlockEvidence) => ({ blockHash: at.blockHash, requireCanonical: true as const });
      function position(tx: Record<string, unknown>, at: RestBlockEvidence, index: bigint) {
        if (!word(tx.blockHash) || !same(tx.blockHash, at.blockHash) || quantity(tx.blockNumber) !== BigInt(at.blockNumber) ||
          quantity(tx.transactionIndex) !== index) invalid();
      }
      function blockTransactions(block: unknown): Hex[] {
        if (!object(block) || !Array.isArray(block.transactions) || block.transactions.length > 4096 || !block.transactions.every(word)) return invalid();
        return block.transactions;
      }
      function exactTransaction(value: unknown): Record<string, unknown> {
        if (!object(value) || !word(value.hash) || !same(value.hash, signed.hash) ||
          typeof value.from !== "string" || !same(value.from, sender) || typeof value.to !== "string" || !same(value.to, template.to) ||
          typeof value.input !== "string" || !same(value.input, template.data) || quantity(value.chainId) !== 8453n || quantity(value.type) !== 2n ||
          quantity(value.nonce) !== BigInt(template.nonce) || quantity(value.gas) !== BigInt(template.gas) || quantity(value.value) !== 0n ||
          quantity(value.maxFeePerGas) !== BigInt(template.maxFeePerGas) || quantity(value.maxPriorityFeePerGas) !== BigInt(template.maxPriorityFeePerGas) ||
          !Array.isArray(value.accessList) || value.accessList.length !== 0 ||
          signatureScalar(value.r) !== BigInt(parsed.r!) || signatureScalar(value.s) !== BigInt(parsed.s!) ||
          quantity(value.v) !== BigInt(parsed.yParity!) || (value.yParity !== undefined && quantity(value.yParity) !== BigInt(parsed.yParity!))) return invalid();
        return value;
      }
      async function canonical() {
        for (const evidence of anchors.values()) {
          const current = await rpc.request("eth_getBlockByNumber", [toHex(BigInt(evidence.blockNumber)), false]);
          if (stable(anchor(current)) !== stable(evidence)) invalid();
        }
        rpc.check();
      }
      // The canonical ProxyCreation log of this operation's own receipt. CREATE2 cannot reuse an
      // occupied address and Base (post-Cancun) cannot vacate one after its creating transaction,
      // so a successful creation in our receipt is the unique factory deployment: no genesis-to-head
      // factory scan is needed, and none fits the provider's 500-block log windows.
      let creationLog: Record<string, unknown> | null = null;
      async function inspectWallet(head: RestBlockEvidence) {
        const code = rpcHex(await rpc.request("eth_getCode", [creation.address, tag(head)]), "observed Safe runtime", 49_152);
        if (code === "0x") {
          output.wallet = { ...output.wallet, state: "undeployed", evidence: head, reason: null }; return;
        }
        if (options.inspection === "inclusion") { output.wallet.reason = "inspection-deferred"; return; }
        const scoped: RestRpc = { request: (chainId, method, params) => {
          if (chainId !== 8453) return Promise.reject(new RestError(502, "WALLET_DEPLOYMENT_CHAIN_MISMATCH", "Observation requires Base."));
          return rpc.request(method, params);
        } };
        // Disposable instances omit BOTH persistence and creation-log callbacks. No index sync,
        // checkpoint write, receipt-only history shortcut or fabricated REST principal is used.
        const accountService = createSmartAccountService({ rpc: scoped, manifests: [manifest], registry: new MemorySmartAccountRegistry(),
          audience: enrollment.intent.origin, now, moduleInspectors: [createSafe7579Inspector({ rpc: scoped, utility, maxLogRangeBlocks: 500,
            inspectSessions: createInstalledSessionVerifier({ rpc: scoped }).inspectAllAt,
            creationLogs: async (chainId, factory, account, end) => creationLog && chainId === 8453 && same(factory, manifest.factory.address)
              && same(account, creation.address) && end >= BigInt(String(creationLog.blockNumber)) ? [structuredClone(creationLog)] : undefined })] });
        try {
          const state = await accountService.inspect({ manifestId: manifest.id, address: creation.address }, signal, head);
          const details = state.modules?.details;
          if (!object(details) || !object(details.provenance) || !object(details.sessions) ||
            !Array.isArray(details.sessions.permissionIds) || details.sessions.permissionIds.length !== 0 ||
            !state.moduleConfigurationVerified || !state.ownerProfile || state.threshold !== 1 || state.owners.length !== 2 ||
            !same(state.ownerProfile.signer.address, creation.bootstrap.signerAddress) ||
            !same(state.ownerProfile.signer.x, enrollment.candidate!.publicKey.x) || !same(state.ownerProfile.signer.y, enrollment.candidate!.publicKey.y) ||
            !same(state.ownerProfile.recoveryOwner.address, enrollment.intent.recoveryOwner) ||
            details.provenance.initializerHash !== creation.initializerHash || !word(details.provenance.creationTransaction) ||
            (output.transaction.state === "canonical-success" && !same(details.provenance.creationTransaction, signed.hash))) {
            output.wallet.reason = "enrolled-authority-or-creation-changed"; return;
          }
          output.wallet = { ...output.wallet, state: "verified", stateHash: state.stateHash, evidence: head,
            creationTransaction: details.provenance.creationTransaction.toLowerCase() as Hex, reason: null };
        } catch {
          // RPC failures are latched: without a final canonical recheck the WHOLE new observation
          // stays unknown. A semantic unsupported-wallet result alone may preserve treasury facts.
          rpc.check(); output.wallet.reason = "full-wallet-history-unavailable";
        }
      }
      try {
        const [chainId, transaction, receipt, headRaw] = await Promise.all([
          rpc.request("eth_chainId", []), rpc.request("eth_getTransactionByHash", [signed.hash]),
          rpc.request("eth_getTransactionReceipt", [signed.hash]), rpc.request("eth_getBlockByNumber", ["latest", false]),
        ]);
        if (quantity(chainId) !== 8453n) invalid();
        const head = anchor(headRaw); output.head = head;
        if (BigInt(head.timestamp) + 300n < BigInt(Math.floor(observedAt / 1000)) || BigInt(head.timestamp) > BigInt(Math.floor(observedAt / 1000) + 30)) invalid();
        const tx = transaction === null ? null : exactTransaction(transaction);
        if (receipt !== null) {
          if (!tx || !object(receipt) || !word(receipt.transactionHash) || !same(receipt.transactionHash, signed.hash) ||
            typeof receipt.from !== "string" || !same(receipt.from, sender) || typeof receipt.to !== "string" || !same(receipt.to, template.to)) invalid();
          const number = quantity(receipt.blockNumber), index = quantity(receipt.transactionIndex), status = quantity(receipt.status);
          const block = await rpc.request("eth_getBlockByNumber", [toHex(number), false]), at = anchor(block);
          if (number !== BigInt(at.blockNumber) || number > BigInt(head.blockNumber) || (status !== 0n && status !== 1n)) invalid();
          position(tx!, at, index); position(receipt, at, index);
          if (blockTransactions(block)[Number(index)]?.toLowerCase() !== signed.hash) invalid();
          const gasUsed = quantity(receipt.gasUsed), effectiveGasPrice = quantity(receipt.effectiveGasPrice);
          const baseFee = quantity((block as Record<string, unknown>).baseFeePerGas), feeCap = BigInt(template.maxFeePerGas),
            currentPrice = baseFee + BigInt(template.maxPriorityFeePerGas);
          if (!gasUsed || gasUsed > BigInt(template.gas) || feeCap < baseFee || effectiveGasPrice !== (currentPrice < feeCap ? currentPrice : feeCap)) invalid();
          if (!Array.isArray(receipt.logs) || receipt.logs.length > 512 || (status === 0n && receipt.logs.length !== 0)) invalid();
          let previous = -1n, expectedCreations = 0;
          for (const item of receipt.logs) {
            if (!object(item) || typeof item.address !== "string" || !isAddress(item.address) || !Array.isArray(item.topics) || item.topics.length > 4 ||
              !item.topics.every((topic: unknown) => typeof topic === "string" && /^0x[0-9a-fA-F]{64}$/.test(topic)) || item.removed !== false ||
              !word(item.transactionHash) || !same(item.transactionHash, signed.hash)) invalid();
            position(item, at, index); const logIndex = quantity(item.logIndex);
            if (previous >= 0n && logIndex !== previous + 1n) invalid(); previous = logIndex;
            const data = rpcHex(item.data, "receipt log data", 131_072);
            if (same(item.address, manifest.factory.address) && item.topics[0] === keccak256(stringToHex("ProxyCreation(address,address)"))) {
              const decoded = decodeEventLog({ abi: SAFE_CREATION_ABI, data, topics: item.topics as [Hex, ...Hex[]] });
              if (item.topics.length !== 2 || item.topics[1].toLowerCase() !== padHex(creation.address, { size: 32 }).toLowerCase() ||
                !same(decoded.args.proxy, creation.address) || !same(decoded.args.singleton, manifest.singleton.address) ||
                !same(data, encodeAbiParameters([{ type: "address" }], [manifest.singleton.address]))) invalid();
              expectedCreations++; if (status === 1n) creationLog = item;
            }
          }
          if (status === 1n && expectedCreations !== 1) invalid();
          output.transaction = { ...output.transaction, state: status === 1n ? "canonical-success" : "canonical-revert", reason: null,
            receipt: { block: at, transactionIndex: String(index), status: status === 1n ? "success" : "reverted", gasUsed: String(gasUsed),
              effectiveGasPrice: String(effectiveGasPrice), logCount: receipt.logs.length, logsHash: keccak256(stringToHex(stable(receipt.logs))) } };
          output.fees.executionWei = String(gasUsed * effectiveGasPrice);
          // The sender's nonce at this head must be past our inclusion; the lane is released on it.
          const [confirmedRaw, pendingRaw] = await Promise.all([rpc.request("eth_getTransactionCount", [sender, tag(head)]),
            rpc.request("eth_getTransactionCount", [sender, "pending"])]);
          const confirmed = quantity(confirmedRaw), pending = quantity(pendingRaw);
          if (pending < confirmed || confirmed <= BigInt(template.nonce) || pending > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
          output.transaction.nonce = { confirmed: String(confirmed), pending: String(pending) };
          const finalized = anchor(await rpc.request("eth_getBlockByNumber", ["finalized", false]));
          if (BigInt(finalized.blockNumber) > BigInt(head.blockNumber)) invalid();
          output.finality = { state: BigInt(finalized.blockNumber) >= number ? "finalized" : "unfinalized", evidence: finalized };
        } else {
          const [confirmedRaw, pendingRaw] = await Promise.all([rpc.request("eth_getTransactionCount", [sender, tag(head)]),
            rpc.request("eth_getTransactionCount", [sender, "pending"])]);
          const confirmed = quantity(confirmedRaw), pending = quantity(pendingRaw), nonce = BigInt(template.nonce);
          if (pending < confirmed || confirmed > BigInt(Number.MAX_SAFE_INTEGER) || pending > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
          output.transaction.nonce = { confirmed: String(confirmed), pending: String(pending) };
          if (tx && (tx.blockHash !== null || tx.blockNumber !== null || tx.transactionIndex !== null)) {
            if (tx.blockHash === null || tx.blockNumber === null || tx.transactionIndex === null) invalid();
            output.transaction.reason = "receipt-unavailable";
          } else if (confirmed === nonce) {
            output.transaction.state = tx ? "pending" : "not-observed"; output.transaction.reason = null;
          } else if (confirmed < nonce || BigInt(head.blockNumber) < BigInt(operation.admission.blockNumber)) {
            output.transaction.state = "reorged"; output.transaction.reason = "provider-before-reserved-nonce";
          } else {
            output.transaction.reason = "nonce-history-unavailable";
            const start = BigInt(operation.admission.blockNumber), end = BigInt(head.blockNumber);
            // Only a complete small canonical window can locate a conflicting sender/nonce.
            // An unavailable/older window is unknown, never proof that the signed bytes were dropped.
            if (end - start <= 15n) {
              let transactions = 0;
              for (let n = start; n <= end && !output.transaction.conflict; n++) {
                const block = await rpc.request("eth_getBlockByNumber", [toHex(n), false]), at = anchor(block);
                if (n === start && !same(at.blockHash, operation.admission.blockHash)) {
                  output.transaction.state = "reorged"; output.transaction.reason = "admission-anchor-reorged"; break;
                }
                const hashes = blockTransactions(block); transactions += hashes.length;
                if (transactions > 64) break;
                for (const [index, hash] of hashes.entries()) {
                  const candidate = await rpc.request("eth_getTransactionByHash", [hash]);
                  if (!object(candidate) || !word(candidate.hash) || !same(candidate.hash, hash)) invalid();
                  position(candidate, at, BigInt(index));
                  if (typeof candidate.from === "string" && same(candidate.from, sender) && quantity(candidate.nonce) === nonce && !same(hash, signed.hash)) {
                    const conflict = await rpc.request("eth_getTransactionReceipt", [hash]);
                    if (!object(conflict) || !word(conflict.transactionHash) || !same(conflict.transactionHash, hash) ||
                      typeof conflict.from !== "string" || !same(conflict.from, sender) || ![0n, 1n].includes(quantity(conflict.status))) invalid();
                    position(conflict, at, BigInt(index));
                    output.transaction.state = "nonce-conflict"; output.transaction.reason = "canonical-conflicting-transaction";
                    output.transaction.conflict = { transactionHash: hash.toLowerCase() as Hex, block: at, transactionIndex: String(index) }; break;
                  }
                }
              }
            }
          }
        }
        await inspectWallet(head);
        await canonical();
        const observation = assertWalletDeploymentObservation(output); rpc.check(); return observation;
      } catch {
        // Preserve prior durable evidence rather than promote a partial read after a latched
        // transport/budget failure or an incomplete final canonicality check.
        return assertWalletDeploymentObservation(empty);
      } finally { rpc.close(); }
    },
    /** `at` pins the snapshot to an already observed canonical head (the funding read's) so
     * both admission halves describe one block even when the chain advances between them. */
    async preflight(input: WalletEnrollment, inputApproval: WalletDeploymentApproval,
      signal?: AbortSignal, at?: RestBlockEvidence): Promise<WalletDeploymentPreflight> {
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
        const [chainId, block] = await Promise.all([rpc.request("eth_chainId", []),
          rpc.request("eth_getBlockByNumber", [at ? toHex(BigInt(at.blockNumber)) : "latest", false])]);
        if (quantity(chainId) !== 8453n || !object(block) || !word(block.hash) || (at && !same(block.hash, at.blockHash)))
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
