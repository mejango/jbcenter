import { isAddress, keccak256, padHex, stringToHex, toHex, type Address, type Hex } from "viem";
import { RestError, type RestBlockEvidence, type RestRpc } from "../core.js";
import type { ContractPin, SmartAccountManifest, SmartAccountState } from "../smartAccounts/types.js";
import { createSmartAccountService, stable } from "../smartAccounts/service.js";
import { createSafe7579Inspector, SAFE7579_INSPECTOR_ID, SAFE7579_STORAGE_SOURCE } from "../smartAccounts/inspector.js";
import { createInstalledSessionVerifier } from "../smartAccounts/installed.js";
import { MemorySmartAccountRegistry } from "../smartAccounts/registry.js";
import { validatePasskeyCreationManifest } from "../smartAccounts/creation.js";
import { assertPasskeyOnboardingState } from "../smartAccounts/passkeyOnboarding.js";
import { createWalletAuthorityIdentity, validateWalletAuthorityContext, validateWalletAuthorityObservation,
  walletAuthorityContextDigest, walletAuthorityExpectedAnchor, walletAuthorityMaximumAgeMs,
  walletAuthorityMaximumHeadAgeMs, walletAuthorityMaximumFutureHeadMs,
  type WalletAuthorityContext, type WalletAuthorityObservation } from "./authority.js";
import { enrollmentDigest } from "./enrollment.js";
import { operationRpc, walletObservationRpcBounds } from "./operationRpc.js";

/** A complete inspection over a hosted provider measured ~25 s; the observation budget leaves room. */
export const walletAuthorityObservationBounds = Object.freeze({ ...walletObservationRpcBounds, totalTimeoutMs: 90_000 });
const creationTopic = keccak256(stringToHex("ProxyCreation(address,address)"));
function provenanceTransaction(state: SmartAccountState): Hex | null {
  const details = state.modules?.details, provenance = object(details) && object(details.provenance) ? details.provenance : null;
  return provenance && word(provenance.creationTransaction) ? provenance.creationTransaction : null;
}
export interface WalletAuthorityChainOptions {
  rpc: RestRpc;
  manifest: SmartAccountManifest;
  utility: ContractPin;
  now?: () => number;
  /** Host overrides may only reduce the existing read-only observation caps. */
  limits?: Partial<Record<keyof typeof walletObservationRpcBounds, number>>;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function word(value: unknown): value is Hex { return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) && BigInt(value) !== 0n; }
function invalid(): never { throw new RestError(502, "WALLET_AUTHORITY_CHAIN_INVALID", "The provider did not establish complete canonical wallet authority."); }
function quantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value) || value.length > 66) invalid();
  return BigInt(value);
}

/** Internal configured producer only. Context must come from the durable authority loader.
 * Neither a structurally valid context nor the returned JSON authenticates its own provenance. */
export function createWalletAuthorityChain(options: WalletAuthorityChainOptions) {
  for (const value of [options.manifest, options.utility, options.limits ?? {}]) enrollmentDigest(value);
  const manifest = structuredClone(options.manifest), utility = structuredClone(options.utility), now = options.now ?? Date.now, transport = options.rpc;
  const limits = { ...walletAuthorityObservationBounds, ...options.limits };
  validatePasskeyCreationManifest(manifest);
  if (manifest.chainId !== 8453 || manifest.mode !== "execution-candidate" || manifest.moduleInspectorId !== SAFE7579_INSPECTOR_ID ||
    manifest.entryPoint?.version !== "0.7" || manifest.policies.length > 16 ||
    !isAddress(utility.address) || BigInt(utility.address) <= 1n || !word(utility.runtimeCodeHash) ||
    utility.source.commit !== SAFE7579_STORAGE_SOURCE.commit ||
    Object.keys(limits).some(key => !(key in walletAuthorityObservationBounds)) || Object.entries(limits).some(([key, value]) =>
      !Number.isSafeInteger(value) || value < 1 || value > walletAuthorityObservationBounds[key as keyof typeof walletAuthorityObservationBounds]))
    throw new RestError(500, "WALLET_AUTHORITY_CONFIG_INVALID", "Use one configured Base profile and the reviewed observation bounds.");
  return {
    async observe(input: WalletAuthorityContext, signal?: AbortSignal): Promise<WalletAuthorityObservation> {
      const context = validateWalletAuthorityContext(input), observedAtMs = now();
      if (!Number.isSafeInteger(observedAtMs) || observedAtMs <= 0 ||
        enrollmentDigest(context.enrollment.intent.manifest) !== enrollmentDigest(manifest))
        throw new RestError(400, "WALLET_AUTHORITY_CONTEXT_INVALID", "The trusted authority context must use the exact configured manifest.");
      const expected = walletAuthorityExpectedAnchor(context);
      const empty: WalletAuthorityObservation = { version: "center-wallet-authority-observation-v1", accountId: context.accountId,
        contextDigest: walletAuthorityContextDigest(context), observedAtMs, validUntilMs: null, head: null,
        priorAnchor: { status: expected ? "unavailable" : "none", expected, observed: null }, identity: null, eligibility: null,
        reason: "authority-observation-unavailable" };
      const output = structuredClone(empty), rpc = operationRpc(transport, limits, signal, true);
      const anchors = new Map<string, RestBlockEvidence>();
      function anchor(value: unknown, expectedNumber?: string): RestBlockEvidence {
        if (!object(value) || !word(value.hash)) invalid();
        const result: RestBlockEvidence = { chainId: 8453, blockNumber: String(quantity(value.number)), blockHash: value.hash.toLowerCase() as Hex,
          timestamp: String(quantity(value.timestamp)), source: "onchain" };
        if (expectedNumber !== undefined && result.blockNumber !== expectedNumber) invalid();
        const prior = anchors.get(result.blockNumber);
        if (prior && stable(prior) !== stable(result)) invalid();
        anchors.set(result.blockNumber, result); return result;
      }
      function live(head: RestBlockEvidence) {
        rpc.check();
        const current = now(), timestampMs = BigInt(head.timestamp) * 1000n;
        if (!Number.isSafeInteger(current) || current < observedAtMs ||
          timestampMs > BigInt(observedAtMs) + BigInt(walletAuthorityMaximumFutureHeadMs) ||
          timestampMs + BigInt(walletAuthorityMaximumHeadAgeMs) <= BigInt(current) ||
          observedAtMs + walletAuthorityMaximumAgeMs <= current) invalid();
      }
      async function canonical(head: RestBlockEvidence) {
        for (const previous of anchors.values()) {
          const current = anchor(await rpc.request("eth_getBlockByNumber", [toHex(BigInt(previous.blockNumber)), false]), previous.blockNumber);
          if (stable(previous) !== stable(current)) invalid();
        }
        live(head);
      }
      const finish = () => { const result = validateWalletAuthorityObservation(output, context); rpc.check(); return result; };
      try {
        const [chainId, headRaw] = await Promise.all([rpc.request("eth_chainId", []), rpc.request("eth_getBlockByNumber", ["latest", false])]);
        if (quantity(chainId) !== 8453n) invalid();
        const head = anchor(headRaw); live(head);
        if ((expected && BigInt(expected.blockNumber) > BigInt(head.blockNumber)) ||
          (context.prior?.highestObservedBlock !== null && context.prior?.highestObservedBlock !== undefined &&
            BigInt(context.prior.highestObservedBlock) > BigInt(head.blockNumber))) invalid();
        output.head = head;
        if (context.credential.recovery) {
          // Replacement identity retains its canonical setup anchor as durable provenance.
          // A reorg cannot silently rewrite that anchor or restore a superseded credential.
          const saved = context.credential.recovery.anchor;
          if (BigInt(saved.blockNumber) > BigInt(head.blockNumber)) invalid();
          const observed = anchor(await rpc.request('eth_getBlockByNumber', [toHex(BigInt(saved.blockNumber)), false]), saved.blockNumber);
          if (stable(saved) !== stable(observed)) invalid();
        }
        if (expected) {
          const observed = anchor(await rpc.request("eth_getBlockByNumber", [toHex(BigInt(expected.blockNumber)), false]), expected.blockNumber);
          if (same(observed.blockHash, expected.blockHash) && observed.timestamp !== expected.timestamp) invalid();
          output.priorAnchor = { expected, observed, status: same(observed.blockHash, expected.blockHash) ? "same" : "replaced" };
        }
        if (output.priorAnchor.status === "replaced" && (!context.prior?.activeFence || context.prior.activeFence.recoveryAnchor !== null)) {
          // Fence a proven conflict before expensive history inspection. A fence with no recovery
          // candidate instead needs complete new-branch identity below before a later recovery read.
          output.reason = "canonical-anchor-replaced"; await canonical(head); return finish();
        }
        const scoped: RestRpc = { request: (chainId, method, params) => {
          if (chainId !== 8453) return Promise.reject(new RestError(502, "WALLET_AUTHORITY_CHAIN_INVALID", "Authority inspection requires Base."));
          return rpc.request(method, params);
        } };
        // No DB checkpoint/index hooks: all full-history reads share the same finite RPC scope.
        // Hosted providers cap eth_getLogs windows, so creation is proven from the receipt of the
        // creation transaction the bound setup state names, through the same finite RPC scope.
        // The inspector still checks that log against the canonical header; a receipt without
        // the exact factory log proves nothing and never falls back to a history scan.
        const creationTransaction = provenanceTransaction(context.binding.state);
        const creationLogs = async (chainId: number, factory: Address, account: Address, end: bigint): Promise<Record<string, unknown>[]> => {
          if (chainId !== 8453 || !creationTransaction) return [];
          const receipt = await rpc.request("eth_getTransactionReceipt", [creationTransaction]);
          if (!object(receipt) || !Array.isArray(receipt.logs) || receipt.logs.length > 512) return [];
          return receipt.logs.filter((log: unknown): log is Record<string, unknown> => object(log) && typeof log.address === "string" &&
            same(log.address, factory) && Array.isArray(log.topics) && log.topics.length === 2 && log.topics[0] === creationTopic &&
            String(log.topics[1]).toLowerCase() === padHex(account, { size: 32 }).toLowerCase() && word(log.blockHash) &&
            quantity(log.blockNumber) <= end);
        };
        const accounts = createSmartAccountService({ rpc: scoped, manifests: [manifest], registry: new MemorySmartAccountRegistry(),
          audience: context.enrollment.intent.origin, now, moduleInspectors: [createSafe7579Inspector({ rpc: scoped, utility,
            inspectSessions: createInstalledSessionVerifier({ rpc: scoped }).inspectAllAt,
            creationLogs, maxLogRangeBlocks: 500, timeoutMs: limits.totalTimeoutMs })] });
        const state = await accounts.inspect({ manifestId: manifest.id, address: context.enrollment.creation!.address }, signal, head);
        const inspected = assertPasskeyOnboardingState(state), details = state.modules!.details;
        if (!same(state.address, context.enrollment.creation!.address) || state.manifestId !== manifest.id ||
          state.manifestRevision !== manifest.revision || stable(state.evidence) !== stable(head) ||
          inspected.initializerHash !== context.enrollment.creation!.initializerHash || !object(details) || !object(details.provenance) ||
          !word(details.provenance.creationTransaction) || details.provenance.method !== "canonical-factory-creation-and-complete-authority-ingress-traces" ||
          details.provenance.throughBlock !== head.blockNumber || !word(details.provenance.throughBlockHash) ||
          !same(details.provenance.throughBlockHash, head.blockHash) || !object(details.sessionAdministration)) invalid();
        output.identity = createWalletAuthorityIdentity(context, { stateHash: state.stateHash,
          sessionAdministration: { epoch: details.sessionAdministration.epoch as string, hash: details.sessionAdministration.hash as Hex },
          creationTransaction: details.provenance.creationTransaction.toLowerCase() as Hex });
        const enrolled = context.enrollment;
        output.eligibility = same(inspected.profile.signer.address, context.credential.recovery?.signerAddress ?? enrolled.creation!.bootstrap.signerAddress) &&
          same(inspected.profile.signer.x, context.credential.publicKey.x) && same(inspected.profile.signer.y, context.credential.publicKey.y) &&
          same(inspected.profile.recoveryOwner.address, enrolled.intent.recoveryOwner) && state.stateHash === context.binding.state.stateHash ? "matched" : "changed";
        output.reason = output.eligibility === "matched" ? null : "enrolled-authority-or-binding-changed";
        if (output.eligibility === "matched") output.validUntilMs = Number(BigInt(observedAtMs + walletAuthorityMaximumAgeMs) <
          BigInt(head.timestamp) * 1000n + BigInt(walletAuthorityMaximumHeadAgeMs) ? BigInt(observedAtMs + walletAuthorityMaximumAgeMs) :
          BigInt(head.timestamp) * 1000n + BigInt(walletAuthorityMaximumHeadAgeMs));
        await canonical(head); return finish();
      } catch {
        // Partial reads cannot refresh readiness or turn an unavailable prior-anchor check into
        // canonical replacement. The durable store retains prior proofs and any existing fence.
        return validateWalletAuthorityObservation(empty, context);
      } finally { rpc.close(); }
    },
  };
}
