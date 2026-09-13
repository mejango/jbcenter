import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashTypedData, keccak256, toHex, type Hex } from "viem";
import type { RestBlockEvidence, RestRpc } from "../src/rest/core.js";
import type { SmartAccountState, SmartAccountManifest, ContractPin } from "../src/rest/smartAccounts/types.js";
import { fingerprint } from "../src/rest/smartAccounts/service.js";
import { passkeyOnboardingDocument } from "../src/rest/smartAccounts/passkeyOnboarding.js";
import { createWalletAuthorityChain, type WalletAuthorityChainOptions } from "../src/rest/wallet/authorityChain.js";
import { createWalletAuthorityIdentity, walletAuthorityContextDigest, type WalletAuthorityContext, type WalletAuthoritySnapshot } from "../src/rest/wallet/authority.js";
import { createWalletEnrollmentIntent, enrollmentDigest, prepareWalletEnrollmentCandidate, verifyWalletEnrollmentProof,
  walletEnrollmentDocument, type WalletEnrollment } from "../src/rest/wallet/enrollment.js";
import { createRegistration, enrollmentBackupAccount, enrollmentManifest, signBackupProof, signGet } from "./fixtures/wallet-enrollment-crypto.js";

// Unit boundary only: the independent Anvil suite exercises the actual inspector and pinned EVM.
const mocked = vi.hoisted(() => ({ inspect: vi.fn(), service: vi.fn(), inspector: vi.fn(), sessions: vi.fn() }));
vi.mock("../src/rest/smartAccounts/service.js", async original => ({ ...await original<object>(),
  createSmartAccountService: (options: unknown) => { mocked.service(options); return { inspect: mocked.inspect }; } }));
vi.mock("../src/rest/smartAccounts/inspector.js", async original => ({ ...await original<object>(),
  createSafe7579Inspector: (options: unknown) => { mocked.inspector(options); return { id: "safe7579-f22a194-trace-v1", inspect: vi.fn() }; } }));
vi.mock("../src/rest/smartAccounts/installed.js", async original => ({ ...await original<object>(),
  createInstalledSessionVerifier: (options: unknown) => { mocked.sessions(options); return { inspectAllAt: vi.fn() }; } }));

const now = 1_800_000_000_000, hash = (n: number) => toHex(BigInt(n), { size: 32 });
const block = (n = 100, blockHash = hash(n)): RestBlockEvidence => ({ chainId: 8453, blockNumber: String(n), blockHash,
  timestamp: String(now / 1000), source: "onchain" });
const artifact = (name: string) => JSON.parse(readFileSync(new URL(`../src/rest/smartAccounts/stack/artifacts/${name}.json`, import.meta.url), "utf8"));
const pin = (name: string): ContractPin => { const a = artifact(name); return { address: a.address, runtimeCodeHash: a.runtimeCodeHash,
  source: { repository: a.source.repo, commit: a.source.commit, artifactSha256: a.source.artifactSha256 } }; };
const manifest: SmartAccountManifest = { ...structuredClone(enrollmentManifest), moduleInspectorId: "safe7579-f22a194-trace-v1",
  entryPoint: { ...pin("EntryPoint"), version: "0.7" } };
const utility = pin("Safe7579DCUtil");
let context: WalletAuthorityContext, state: SmartAccountState;

beforeAll(async () => {
  const intent = createWalletEnrollmentIntent({ manifest, rpId: "juicebox.center", origin: "https://juicebox.center",
    recoveryOwner: enrollmentBackupAccount.address, expiresAt: now + 60_000 });
  const empty: WalletEnrollment = { intent, createdAt: now, state: "awaiting_registration", candidate: null,
    candidateDigest: null, creation: null, possession: null, receipt: null };
  const credential = createRegistration({ challenge: `0x${Buffer.from(intent.registration.challenge, "base64url").toString("hex")}`,
    rpId: intent.rpId, origin: intent.origin, userHandle: intent.userHandle });
  const pending: WalletEnrollment = { ...empty, ...prepareWalletEnrollmentCandidate(empty, credential.response), state: "awaiting_possession" };
  const document = walletEnrollmentDocument(pending), proof = await verifyWalletEnrollmentProof(pending, {
    assertion: signGet({ ...credential, challenge: hashTypedData(document), rpId: intent.rpId, origin: intent.origin }),
    backupSignature: await signBackupProof(document) });
  const enrollment: WalletEnrollment = { ...pending, state: "verified", receipt: { id: intent.id, enrollmentId: intent.id,
    accountId: `eip155:8453:${pending.creation!.address.toLowerCase()}`, credentialId: credential.credentialId,
    initializerHash: pending.creation!.initializerHash, manifestCommitment: `0x${enrollmentDigest(intent.manifest)}`,
    manifestRevision: intent.manifest.revision, creationCommitment: `0x${enrollmentDigest(pending.creation)}`,
    verificationDigest: proof.verificationDigest, verifiedAt: now + 1 } };
  state = { chainId: 8453, address: enrollment.creation!.address, manifestId: manifest.id, manifestRevision: manifest.revision,
    owners: [enrollment.creation!.bootstrap.signerAddress, intent.recoveryOwner], threshold: 1, safeNonce: "0", stateHash: hash(1001),
    evidence: block(), codeHashes: [], executionVerified: false, moduleConfigurationVerified: true,
    ownerProfile: { version: "center-passkey-v1", signer: { address: enrollment.creation!.bootstrap.signerAddress, kind: "contract",
      ...credential.publicKey, verifiers: toHex(BigInt(manifest.ownerProfile!.p256Verifier.address), { size: 22 }), runtimeCodeHash: hash(1002) },
      recoveryOwner: { address: intent.recoveryOwner, kind: "ecdsa" } },
    modules: { complete: true, arbitrarySigningDisabled: true, wildcardExecutionDisabled: true, stateHash: hash(1003),
      details: { sessionAdministration: { epoch: "0", hash: hash(1004) }, sessions: { permissionIds: [] },
        provenance: { initializerHash: enrollment.creation!.initializerHash, creationTransaction: hash(1005), creationBlock: "90",
          throughBlock: "100", throughBlockHash: block().blockHash, method: "canonical-factory-creation-and-complete-authority-ingress-traces" } } } };
  const setup = { profile: "center-passkey-v1" as const, address: state.address, manifestId: manifest.id, nonce: hash(1006),
    issuedAt: now / 1000, expiresAt: now / 1000 + 120, grant: { id: randomUUID(), botAddress: enrollmentBackupAccount.address,
      scopes: ["read", "plan", "relay"] as ["read", "plan", "relay"], expiresAt: now / 1000 + 3600, label: "unit fixture" } };
  setup.grant.botAddress = "0x4444444444444444444444444444444444444444";
  const typed = passkeyOnboardingDocument(intent.origin, setup, state), accountId = enrollment.receipt!.accountId;
  context = { version: "center-wallet-authority-context-v1", accountId, enrollment,
    credential: { accountId, enrollmentId: intent.id, rpId: intent.rpId, credentialId: credential.credentialId, userHandle: intent.userHandle,
      publicKey: credential.publicKey, backupEligible: enrollment.candidate!.backupEligible, verifiedAtMs: now + 1, supersededAtMs: null },
    binding: { id: fingerprint({ ownerAccountId: accountId, wallet: state.address, chainId: 8453 }), ownerAccountId: accountId,
      ownerAddress: state.address, wallet: { chainId: 8453, address: state.address }, manifestId: manifest.id,
      authorization: { digest: hashTypedData(typed), nonce: setup.nonce, expiresAt: setup.expiresAt,
        method: "safe-passkey-owner-threshold-and-api-grant", setup: { manifestRevision: manifest.revision,
          initializerHash: enrollment.creation!.initializerHash, issuedAt: setup.issuedAt, grantId: setup.grant.id,
          botAddress: setup.grant.botAddress, scopes: [...setup.grant.scopes], grantExpiresAt: setup.grant.expiresAt, label: setup.grant.label } }, state }, prior: null };
});
beforeEach(() => { vi.clearAllMocks(); mocked.inspect.mockImplementation(async (_input, _signal, at) => ({ ...structuredClone(state), evidence: at })); });

type Override = (method: string, params: readonly unknown[], result: unknown, signal?: AbortSignal) => unknown | Promise<unknown>;
function fixture(override?: Override, options: Partial<Omit<WalletAuthorityChainOptions, "rpc">> = {}) {
  const calls: { method: string; params: readonly unknown[]; signal?: AbortSignal }[] = [], input = structuredClone(context);
  const rpc: RestRpc = { request: async (chainId, method, params, signal) => {
    expect(chainId).toBe(8453); calls.push({ method, params: structuredClone(params), ...(signal ? { signal } : {}) });
    let result: unknown;
    if (method === "eth_chainId") result = "0x2105";
    else if (method === "eth_getBlockByNumber") { const n = params[0] === "latest" ? 100 : Number(BigInt(String(params[0])));
      result = { number: toHex(n), hash: hash(n), timestamp: toHex(now / 1000) }; }
    else throw new Error(`Unexpected authority RPC: ${method}`);
    return override ? override(method, params, result, signal) : result;
  } };
  const configured = { rpc, manifest, utility, now: () => now + 3, ...options };
  return { calls, input, configured, chain: createWalletAuthorityChain(configured) };
}
function prior(input: WalletAuthorityContext, accepted = block(95)): WalletAuthoritySnapshot {
  const identity = createWalletAuthorityIdentity(input, { stateHash: state.stateHash,
    sessionAdministration: { epoch: "0", hash: hash(1004) }, creationTransaction: hash(1005) });
  return { version: "center-wallet-authority-snapshot-v1", accountId: input.accountId, revision: "1", authorityEpoch: "1", sessionEpoch: "1",
    bootstrapRequired: false, readiness: "verified", identity, historicalVerifiedIdentity: identity, acceptedAnchor: accepted,
    highestObservedBlock: accepted.blockNumber, activeFence: null, lastClosedFence: null,
    latestObservation: { version: "center-wallet-authority-observation-v1", accountId: input.accountId, contextDigest: walletAuthorityContextDigest(input),
      observedAtMs: now + 1, validUntilMs: now + 30_001, head: accepted, priorAnchor: { status: "none", expected: null, observed: null },
      identity, eligibility: "matched", reason: null }, validUntilMs: now + 30_001, updatedAtMs: now + 2 };
}
function fenced(input: WalletAuthorityContext, recoveryAnchor: RestBlockEvidence | null): WalletAuthoritySnapshot {
  const result = prior(input, block(95, hash(9995)));
  return { ...result, authorityEpoch: "2", sessionEpoch: "2", readiness: "fenced", highestObservedBlock: "100", validUntilMs: null,
    activeFence: { triggerDigest: hash(2001), authorityEpoch: "2", sessionEpoch: "2", observedAtMs: now + 2,
      abandonedAnchor: result.acceptedAnchor!, replacementAnchor: block(95), recoveryAnchor } };
}

describe("configured canonical authority producer", () => {
  it("uses disposable complete inspection and binds the new session-administration identity", async () => {
    const f = fixture(), result = await f.chain.observe(f.input);
    expect(result).toMatchObject({ accountId: f.input.accountId, observedAtMs: now + 3, validUntilMs: now + 30_003,
      eligibility: "matched", head: block(), identity: { stateHash: state.stateHash, sessionAdministration: { epoch: "0", hash: hash(1004) } },
      priorAnchor: { status: "none", expected: null, observed: null } });
    expect(mocked.inspector).toHaveBeenCalledOnce();
    const options = mocked.inspector.mock.calls[0]![0]; expect(options).not.toHaveProperty("checkpointStore"); expect(options).not.toHaveProperty("creationLogs");
    expect(mocked.inspect).toHaveBeenCalledWith({ manifestId: manifest.id, address: state.address }, undefined, block());
    expect(f.calls.every(c => !/send|sign|estimate|anvil/i.test(c.method))).toBe(true);
  });
  it("proves a replaced prior anchor even when the new head is higher, before expensive inspection", async () => {
    const f = fixture(); f.input.prior = prior(f.input, block(95, hash(9995)));
    const result = await f.chain.observe(f.input);
    expect(result).toMatchObject({ head: block(), priorAnchor: { status: "replaced", expected: block(95, hash(9995)), observed: block(95) },
      identity: null, eligibility: null, validUntilMs: null, reason: "canonical-anchor-replaced" });
    expect(mocked.inspect).not.toHaveBeenCalled();
    expect(f.calls.filter(c => c.method === "eth_getBlockByNumber" && c.params[0] === "0x5f")).toHaveLength(2);
  });
  it("rechecks the same prior anchor before publishing new complete evidence", async () => {
    const f = fixture(); f.input.prior = prior(f.input);
    expect(await f.chain.observe(f.input)).toMatchObject({ eligibility: "matched", priorAnchor: { status: "same", expected: block(95), observed: block(95) } });
  });
  it("continues complete inspection to establish a recovery candidate for an already fenced replacement", async () => {
    const f = fixture(); f.input.prior = fenced(f.input, null);
    expect(await f.chain.observe(f.input)).toMatchObject({ eligibility: "matched", priorAnchor: { status: "replaced" }, identity: { stateHash: state.stateHash } });
    expect(mocked.inspect).toHaveBeenCalledOnce();
  });
  it("rechecks the recovery candidate ahead of the abandoned accepted anchor", async () => {
    const f = fixture(); f.input.prior = fenced(f.input, block(98));
    expect(await f.chain.observe(f.input)).toMatchObject({ eligibility: "matched", priorAnchor: { status: "same", expected: block(98), observed: block(98) } });
    expect(f.calls.some(call => call.params[0] === "0x5f")).toBe(false);
  });
  it("reports another replacement of the recovery candidate without silently recovering", async () => {
    const f = fixture(); f.input.prior = fenced(f.input, block(98, hash(9998)));
    expect(await f.chain.observe(f.input)).toMatchObject({ identity: null, validUntilMs: null,
      priorAnchor: { status: "replaced", expected: block(98, hash(9998)), observed: block(98) }, reason: "canonical-anchor-replaced" });
    expect(mocked.inspect).not.toHaveBeenCalled();
  });
  it.each(["unavailable", "lagging", "changed during recheck"])("does not call %s prior-anchor evidence a canonical conflict", async mode => {
    let reads = 0;
    const f = fixture((method, params, result) => {
      if (method === "eth_getBlockByNumber" && params[0] === "0x5f") {
        if (mode === "unavailable") return null;
        if (mode === "changed during recheck" && ++reads > 1) return { ...result as object, hash: hash(7777) };
      }
      return result;
    });
    f.input.prior = prior(f.input, mode === "lagging" ? block(105) : block(95));
    expect(await f.chain.observe(f.input)).toMatchObject({ head: null, identity: null, validUntilMs: null, priorAnchor: { status: "unavailable" } });
  });
  it.each(["chain", "stale head", "future head", "wrong requested height"])("leaves %s provider evidence unknown", async mode => {
    const f = fixture((method, params, result) => {
      if (mode === "chain" && method === "eth_chainId") return "0x1";
      if (method === "eth_getBlockByNumber") return { ...result as object,
        ...(mode === "stale head" ? { timestamp: toHex(now / 1000 - 301) } : mode === "future head" ? { timestamp: toHex(now / 1000 + 31) } :
          mode === "wrong requested height" && params[0] !== "latest" ? { number: "0x65" } : {}) };
      return result;
    });
    expect(await f.chain.observe(f.input)).toMatchObject({ head: null, identity: null, validUntilMs: null });
  });
  it.each(["module proof", "session admin", "genesis", "different snapshot"])("rejects incomplete %s from the inspected state", async mode => {
    mocked.inspect.mockImplementation(async (_input, _signal, at) => {
      const changed = structuredClone(state); changed.evidence = at;
      if (mode === "module proof") changed.moduleConfigurationVerified = false;
      if (mode === "session admin") delete (changed.modules!.details as Record<string, unknown>).sessionAdministration;
      if (mode === "genesis") (changed.modules!.details as { provenance: { initializerHash: Hex } }).provenance.initializerHash = hash(8888);
      if (mode === "different snapshot") changed.evidence = block(101);
      return changed;
    });
    const f = fixture(); expect(await f.chain.observe(f.input)).toMatchObject({ head: null, identity: null, validUntilMs: null });
  });
  it("records a fully inspected changed owner as changed eligibility, never the old enrolled owner", async () => {
    mocked.inspect.mockImplementation(async (_input, _signal, at) => {
      const changed = structuredClone(state); changed.evidence = at; changed.stateHash = hash(7777);
      changed.ownerProfile!.signer.x = hash(8888); return changed;
    });
    const f = fixture(); expect(await f.chain.observe(f.input)).toMatchObject({ eligibility: "changed", identity: { stateHash: hash(7777) }, validUntilMs: null });
  });
  it("retains original observation time and refuses expiry during inspection", async () => {
    let clock = now + 3;
    const f = fixture(undefined, { now: () => clock });
    mocked.inspect.mockImplementation(async (_input, _signal, at) => { clock += 30_001; return { ...structuredClone(state), evidence: at }; });
    expect(await f.chain.observe(f.input)).toMatchObject({ observedAtMs: now + 3, head: null, identity: null, validUntilMs: null });
  });
  it("bounds a provider that ignores its deadline signal", async () => {
    const f = fixture(() => new Promise(() => undefined), { limits: { rpcTimeoutMs: 20 } });
    const before = performance.now(); expect(await f.chain.observe(f.input)).toMatchObject({ head: null, identity: null });
    expect(performance.now() - before).toBeLessThan(1000);
    expect(f.calls.every(call => call.signal?.aborted)).toBe(true);
  });
  it("performs no provider work after cancellation", async () => {
    const f = fixture(), abort = new AbortController(); abort.abort();
    expect(await f.chain.observe(f.input, abort.signal)).toMatchObject({ head: null, identity: null }); expect(f.calls).toHaveLength(0);
  });
  it("retains the configured transport when its original options object is reassigned", async () => {
    const f = fixture(), replacement = vi.fn(() => Promise.reject(new Error("replacement transport")));
    f.configured.rpc = { request: replacement };
    expect(await f.chain.observe(f.input)).toMatchObject({ eligibility: "matched" });
    expect(replacement).not.toHaveBeenCalled(); expect(f.calls.length).toBeGreaterThan(0);
  });
  it.each([{ rpcCalls: 1 }, { responseBytes: 64 }])("preserves the finite shared RPC caps %j", async limits => {
    const f = fixture(undefined, { limits });
    expect(await f.chain.observe(f.input)).toMatchObject({ head: null, identity: null, validUntilMs: null });
    expect(mocked.inspect).not.toHaveBeenCalled();
  });
});
