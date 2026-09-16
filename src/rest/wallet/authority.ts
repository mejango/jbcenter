import { isProxy } from "node:util/types";
import type { Hex } from "viem";
import { RestError, type RestBlockEvidence } from "../core.js";
import type { SmartAccountBinding } from "../smartAccounts/types.js";
import { fingerprint } from "../smartAccounts/service.js";
import { assertPasskeyOnboardingState, validatePasskeyOnboardingInput } from "../smartAccounts/passkeyOnboarding.js";
import { enrollmentDigest, type WalletEnrollment } from "./enrollment.js";
import { assertWalletAuthorityCredential, type WalletCredentialRecovery } from "./credentialRecovery.js";
import { assertWalletAuthorityDevice, type WalletAuthorityDevice } from "./devices.js";
import { maximumPasskeySigners } from "../smartAccounts/passkeyProfile.js";

// A hosted-provider observation takes ~25 s from its observedAt; the window must outlast it by
// enough for the person to log in and for the worker to refresh ahead of expiry.
export const walletAuthorityMaximumAgeMs = 120_000;
export const walletAuthorityMaximumHeadAgeMs = 300_000;
export const walletAuthorityMaximumFutureHeadMs = 30_000;
export const walletAuthorityMaximumEpoch = 9223372036854775807n;

/** Loaded from the unique current W3 mapping. Shape is not credential provenance. */
export interface WalletAuthorityCredential {
  accountId: string;
  enrollmentId: string;
  rpId: string;
  credentialId: string;
  userHandle: string;
  publicKey: { x: Hex; y: Hex };
  backupEligible: boolean;
  verifiedAtMs: number;
  supersededAtMs: null;
  recovery?: WalletCredentialRecovery;
}
/** Trusted database bundle. The loader must prove the binding is currently live. */
export interface WalletAuthorityContext {
  version: "center-wallet-authority-context-v1";
  accountId: string;
  enrollment: WalletEnrollment;
  /** The primary passkey. */
  credential: WalletAuthorityCredential;
  /** Further passkeys added as devices, each with its own on-chain signer. Absent when none, so a
   * context without devices keeps its exact prior shape and digest. */
  devices?: WalletAuthorityDevice[];
  binding: SmartAccountBinding;
  prior: WalletAuthoritySnapshot | null;
}
export interface WalletAuthorityIdentity {
  version: "center-wallet-authority-identity-v1";
  accountId: string;
  manifestCommitment: Hex;
  manifestRevision: Hex;
  enrollmentCommitment: Hex;
  credentialCommitment: Hex;
  bindingId: Hex;
  bindingAuthorizationDigest: Hex;
  creationCommitment: Hex;
  initializerHash: Hex;
  creationTransaction: Hex;
  stateHash: Hex;
  sessionAdministration: { epoch: string; hash: Hex };
}
export interface WalletAuthorityPriorAnchor {
  status: "none" | "same" | "replaced" | "unavailable";
  expected: RestBlockEvidence | null;
  observed: RestBlockEvidence | null;
}
/** A configured producer supplies provenance. This format itself is not authorization. */
export interface WalletAuthorityObservation {
  version: "center-wallet-authority-observation-v1";
  accountId: string;
  contextDigest: Hex;
  observedAtMs: number;
  validUntilMs: number | null;
  head: RestBlockEvidence | null;
  priorAnchor: WalletAuthorityPriorAnchor;
  identity: WalletAuthorityIdentity | null;
  eligibility: "matched" | "changed" | null;
  reason: string | null;
}
export interface WalletAuthorityFence {
  triggerDigest: Hex;
  authorityEpoch: string;
  sessionEpoch: string;
  observedAtMs: number;
  abandonedAnchor: RestBlockEvidence;
  replacementAnchor: RestBlockEvidence;
  /** Null until a complete new-branch identity has been observed. */
  recoveryAnchor: RestBlockEvidence | null;
}
export interface WalletAuthoritySnapshot {
  version: "center-wallet-authority-snapshot-v1";
  accountId: string;
  revision: string;
  authorityEpoch: string;
  sessionEpoch: string;
  bootstrapRequired: boolean;
  readiness: "verified" | "changed" | "unknown" | "fenced";
  identity: WalletAuthorityIdentity | null;
  historicalVerifiedIdentity: WalletAuthorityIdentity | null;
  acceptedAnchor: RestBlockEvidence | null;
  highestObservedBlock: string | null;
  activeFence: WalletAuthorityFence | null;
  lastClosedFence: WalletAuthorityFence | null;
  latestObservation: WalletAuthorityObservation | null;
  validUntilMs: number | null;
  updatedAtMs: number;
}

const maxQuantity = (1n << 256n) - 1n;
function invalid(): never { throw new RestError(400, "WALLET_AUTHORITY_INVALID", "Wallet authority fields or commitments are inconsistent."); }
function conflict(): never { throw new RestError(409, "WALLET_AUTHORITY_CONFLICT", "Wallet authority context or generations require fresh reconciliation."); }
function expired(): never { throw new RestError(410, "WALLET_AUTHORITY_EXPIRED", "Wallet authority observation expired before admission."); }
const digest = (value: unknown): Hex => `0x${enrollmentDigest(value)}`;
const equal = (a: unknown, b: unknown) => enrollmentDigest(a) === enrollmentDigest(b);
function fields(value: any, names: string[], optional: string[] = []): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || names.some(key => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(key => !names.includes(key) && !optional.includes(key))) invalid();
}
/** Bound plain JSON before shared canonicalization, rejecting proxies before any traps. */
function copy<T>(input: T): T {
  const budget = { nodes: 0, bytes: 0 };
  function walk(value: any, depth: number): any {
    if (++budget.nodes > 8192 || depth > 24) invalid();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") { if (!Number.isSafeInteger(value) || Object.is(value, -0)) invalid(); return value; }
    if (typeof value === "string") {
      budget.bytes += Buffer.byteLength(value);
      if (value.length > 65536 || budget.bytes > 262144) invalid();
      return value;
    }
    if (!value || typeof value !== "object" || isProxy(value)) invalid();
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 256 || Reflect.ownKeys(value).length !== value.length + 1) invalid();
      const result = [];
      for (let i = 0; i < value.length; i++) {
        const d = Object.getOwnPropertyDescriptor(value, String(i));
        if (!d || !("value" in d) || !d.enumerable) invalid();
        result.push(walk(d.value, depth + 1));
      }
      return result;
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
    const keys = Reflect.ownKeys(value);
    if (keys.length > 64) invalid();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string" || key.length > 128 || key === "__proto__") invalid();
      const d = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in d) || !d.enumerable) invalid();
      result[key] = walk(d.value, depth + 1);
    }
    return result;
  }
  return walk(input, 0);
}
function word(v: unknown): asserts v is Hex { if (typeof v !== "string" || !/^0x[0-9a-f]{64}$/.test(v) || BigInt(v) === 0n) invalid(); }
function quantity(v: unknown, maximum = maxQuantity, minimum = 0n): asserts v is string {
  if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(v) || BigInt(v) > maximum || BigInt(v) < minimum) invalid();
}
function clock(v: unknown): asserts v is number { if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) invalid(); }
function account(v: unknown): asserts v is string {
  if (typeof v !== "string" || !/^eip155:8453:0x[0-9a-f]{40}$/.test(v) || BigInt(v.slice(12)) <= 1n) invalid();
}
function block(v: RestBlockEvidence): void {
  fields(v, ["chainId", "blockNumber", "blockHash", "timestamp", "source"]);
  if (v.chainId !== 8453 || v.source !== "onchain") invalid();
  word(v.blockHash); quantity(v.blockNumber); quantity(v.timestamp);
}
function identityShape(v: WalletAuthorityIdentity): void {
  fields(v, ["version", "accountId", "manifestCommitment", "manifestRevision", "enrollmentCommitment", "credentialCommitment",
    "bindingId", "bindingAuthorizationDigest", "creationCommitment", "initializerHash", "creationTransaction", "stateHash", "sessionAdministration"]);
  if (v.version !== "center-wallet-authority-identity-v1") invalid();
  account(v.accountId);
  for (const field of [v.manifestCommitment, v.manifestRevision, v.enrollmentCommitment, v.credentialCommitment, v.bindingId,
    v.bindingAuthorizationDigest, v.creationCommitment, v.initializerHash, v.creationTransaction, v.stateHash]) word(field);
  fields(v.sessionAdministration, ["epoch", "hash"]); quantity(v.sessionAdministration.epoch); word(v.sessionAdministration.hash);
}
function fenceShape(v: WalletAuthorityFence): void {
  fields(v, ["triggerDigest", "authorityEpoch", "sessionEpoch", "observedAtMs", "abandonedAnchor", "replacementAnchor", "recoveryAnchor"]);
  word(v.triggerDigest); quantity(v.authorityEpoch, walletAuthorityMaximumEpoch, 1n); quantity(v.sessionEpoch, walletAuthorityMaximumEpoch, 1n);
  clock(v.observedAtMs); block(v.abandonedAnchor); block(v.replacementAnchor);
  if (v.abandonedAnchor.blockNumber !== v.replacementAnchor.blockNumber || v.abandonedAnchor.blockHash === v.replacementAnchor.blockHash) invalid();
  if (v.recoveryAnchor !== null) { block(v.recoveryAnchor); if (BigInt(v.recoveryAnchor.blockNumber) < BigInt(v.replacementAnchor.blockNumber)) invalid(); }
}
function observationShape(v: WalletAuthorityObservation): void {
  fields(v, ["version", "accountId", "contextDigest", "observedAtMs", "validUntilMs", "head", "priorAnchor", "identity", "eligibility", "reason"]);
  if (v.version !== "center-wallet-authority-observation-v1") invalid();
  account(v.accountId); word(v.contextDigest); clock(v.observedAtMs);
  if (v.observedAtMs > Number.MAX_SAFE_INTEGER - walletAuthorityMaximumAgeMs) invalid();
  if (v.reason !== null && (typeof v.reason !== "string" || v.reason.length > 128 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(v.reason))) invalid();
  const p = v.priorAnchor;
  fields(p, ["status", "expected", "observed"]);
  if (!["none", "same", "replaced", "unavailable"].includes(p.status)) invalid();
  if (p.expected !== null) block(p.expected);
  if (p.observed !== null) block(p.observed);
  if (p.status === "none") { if (p.expected !== null || p.observed !== null) invalid(); }
  else if (p.status === "unavailable") { if (!p.expected || p.observed !== null) invalid(); }
  else {
    if (!p.expected || !p.observed || p.expected.blockNumber !== p.observed.blockNumber ||
      ((p.status === "same") !== (p.expected.blockHash === p.observed.blockHash)) ||
      (p.status === "same" && !equal(p.expected, p.observed))) invalid();
  }
  if (v.head === null) {
    if (v.identity !== null || v.eligibility !== null || v.validUntilMs !== null || !v.reason || !["none", "unavailable"].includes(p.status)) invalid();
    return;
  }
  block(v.head);
  if (p.status === "unavailable" || (p.observed && BigInt(p.observed.blockNumber) > BigInt(v.head.blockNumber))) invalid();
  if (p.observed?.blockNumber === v.head.blockNumber && !equal(p.observed, v.head)) invalid();
  const headMs = BigInt(v.head.timestamp) * 1000n;
  if (headMs > BigInt(v.observedAtMs + walletAuthorityMaximumFutureHeadMs) ||
    headMs + BigInt(walletAuthorityMaximumHeadAgeMs) <= BigInt(v.observedAtMs)) invalid();
  if (v.identity === null) {
    if (v.eligibility !== null || v.validUntilMs !== null || p.status !== "replaced" || v.reason !== "canonical-anchor-replaced") invalid();
    return;
  }
  identityShape(v.identity);
  if (v.identity.accountId !== v.accountId || !["matched", "changed"].includes(v.eligibility!) ||
    (v.eligibility === "matched" ? v.reason !== null : !v.reason)) invalid();
  if (v.eligibility === "changed") { if (v.validUntilMs !== null) invalid(); }
  else {
    clock(v.validUntilMs);
    if (v.validUntilMs <= v.observedAtMs || v.validUntilMs > v.observedAtMs + walletAuthorityMaximumAgeMs ||
      BigInt(v.validUntilMs) > headMs + BigInt(walletAuthorityMaximumHeadAgeMs)) invalid();
  }
}
function snapshotShape(v: WalletAuthoritySnapshot): void {
  fields(v, ["version", "accountId", "revision", "authorityEpoch", "sessionEpoch", "bootstrapRequired", "readiness", "identity",
    "historicalVerifiedIdentity", "acceptedAnchor", "highestObservedBlock", "activeFence", "lastClosedFence", "latestObservation", "validUntilMs", "updatedAtMs"]);
  if (v.version !== "center-wallet-authority-snapshot-v1" || typeof v.bootstrapRequired !== "boolean" ||
    !["verified", "changed", "unknown", "fenced"].includes(v.readiness)) invalid();
  account(v.accountId); quantity(v.revision, walletAuthorityMaximumEpoch); quantity(v.authorityEpoch, walletAuthorityMaximumEpoch, 1n);
  quantity(v.sessionEpoch, walletAuthorityMaximumEpoch, 1n); clock(v.updatedAtMs);
  for (const i of [v.identity, v.historicalVerifiedIdentity]) if (i !== null) { identityShape(i); if (i.accountId !== v.accountId) invalid(); }
  if (v.highestObservedBlock !== null) quantity(v.highestObservedBlock);
  if (v.acceptedAnchor !== null) block(v.acceptedAnchor);
  for (const f of [v.activeFence, v.lastClosedFence]) if (f !== null) {
    fenceShape(f);
    if (BigInt(f.authorityEpoch) > BigInt(v.authorityEpoch) || BigInt(f.sessionEpoch) > BigInt(v.sessionEpoch) || f.observedAtMs > v.updatedAtMs) invalid();
  }
  for (const b of [v.acceptedAnchor, v.activeFence?.recoveryAnchor, v.lastClosedFence?.recoveryAnchor]) if (b) {
    if (v.highestObservedBlock === null || BigInt(b.blockNumber) > BigInt(v.highestObservedBlock)) invalid();
  }
  if (v.latestObservation !== null) {
    observationShape(v.latestObservation);
    if (v.latestObservation.accountId !== v.accountId || v.latestObservation.observedAtMs > v.updatedAtMs) invalid();
    if (v.latestObservation.head && (v.highestObservedBlock === null ||
      BigInt(v.latestObservation.head.blockNumber) > BigInt(v.highestObservedBlock))) invalid();
  }
  if (v.validUntilMs !== null) clock(v.validUntilMs);
  if (v.readiness === "verified") {
    if (v.bootstrapRequired || !v.identity || !v.historicalVerifiedIdentity || !equal(v.identity, v.historicalVerifiedIdentity) ||
      !v.acceptedAnchor || v.activeFence || !v.latestObservation?.identity || v.latestObservation.eligibility !== "matched" ||
      !equal(v.identity, v.latestObservation.identity) || !equal(v.acceptedAnchor, v.latestObservation.head) ||
      v.validUntilMs === null || v.validUntilMs !== v.latestObservation.validUntilMs) invalid();
  } else if (v.validUntilMs !== null) invalid();
  if (v.readiness === "fenced" && !v.activeFence) invalid();
  if (v.readiness === "changed" && (!v.identity || v.activeFence)) invalid();
  if (v.bootstrapRequired && (v.readiness !== "unknown" || v.identity || v.historicalVerifiedIdentity || v.acceptedAnchor ||
    v.highestObservedBlock !== null || v.activeFence || v.lastClosedFence)) invalid();
}
function contextShape(v: WalletAuthorityContext): void {
  fields(v, ["version", "accountId", "enrollment", "credential", "binding", "prior"], ["devices"]);
  if (v.version !== "center-wallet-authority-context-v1") invalid();
  account(v.accountId);
  const e = v.enrollment, c = v.credential, b = v.binding, receipt = e.receipt!;
  assertWalletAuthorityCredential(c, e);
  const devices = v.devices ?? [];
  if (Object.hasOwn(v, "devices") && (!Array.isArray(v.devices) || !v.devices.length || v.devices.length > maximumPasskeySigners - 1)) invalid();
  for (const device of devices) { assertWalletAuthorityDevice(device, e); if (device.accountId !== v.accountId || device.credentialId === c.credentialId) invalid(); }
  if (new Set(devices.map(device => device.credentialId)).size !== devices.length) invalid();
  if (receipt.accountId !== v.accountId || c.accountId !== v.accountId) invalid();
  fields(b, ["id", "ownerAccountId", "ownerAddress", "wallet", "manifestId", "authorization", "state"]);
  fields(b.wallet, ["chainId", "address"]);
  const a = b.authorization, consent = a.method === "center-wallet-passkey-creation-v1";
  fields(a, consent ? ["digest", "nonce", "expiresAt", "method"] : ["digest", "nonce", "expiresAt", "method", "setup"]);
  word(b.id); word(a.digest); word(a.nonce);
  if (b.ownerAccountId !== v.accountId || typeof b.ownerAddress !== "string" || typeof b.wallet.address !== "string" ||
    b.ownerAddress.toLowerCase() !== e.creation!.address.toLowerCase() || b.wallet.address.toLowerCase() !== e.creation!.address.toLowerCase() ||
    b.wallet.chainId !== 8453 || b.id !== fingerprint({ ownerAccountId: v.accountId, wallet: b.wallet.address, chainId: 8453 }) ||
    b.manifestId !== e.intent.manifest.id || b.state.manifestId !== b.manifestId || b.state.address !== b.wallet.address ||
    b.state.manifestRevision !== e.intent.manifest.revision || (!consent && a.method !== "safe-passkey-owner-threshold-and-api-grant")) invalid();
  // A consent binding's digest is the passkey proof already on record for this credential: the
  // enrollment possession proof, or the recovery proof for a replacement passkey.
  // With devices, the binding was renewed by the latest device addition and carries its consent digest.
  const latestDevice = devices.reduce<WalletAuthorityDevice | null>((latest, device) => !latest || device.device.acceptedAtMs > latest.device.acceptedAtMs ? device : latest, null);
  const consentDigest = latestDevice ? latestDevice.device.bindingDigest.toLowerCase() : c.recovery ? c.recovery.bindingDigest.toLowerCase() : `0x${receipt.verificationDigest}`;
  if (consent && (!Number.isSafeInteger(a.expiresAt) || a.expiresAt <= 0 || a.digest.toLowerCase() !== consentDigest)) invalid();
  if (latestDevice && !consent) invalid();
  const setup = consent ? null : a.setup!;
  if (setup) {
    fields(setup, ["manifestRevision", "initializerHash", "issuedAt", "grantId", "botAddress", "scopes", "grantExpiresAt", "label"]);
    if (setup.manifestRevision !== e.intent.manifest.revision || setup.initializerHash !== e.creation!.initializerHash) invalid();
  }
  const observed = assertPasskeyOnboardingState(b.state);
  if (observed.initializerHash !== e.creation!.initializerHash || !equal({ x: observed.profile.signer.x, y: observed.profile.signer.y }, c.publicKey) ||
    observed.profile.signer.address.toLowerCase() !== (c.recovery?.signerAddress ?? e.creation!.bootstrap.signerAddress).toLowerCase() ||
    observed.profile.recoveryOwner.address.toLowerCase() !== e.intent.recoveryOwner.toLowerCase()) invalid();
  // Every device on record is an owner, and every device owner is on record: the two sets agree exactly.
  const onchain = (observed.profile.devices ?? []).map(entry => `${entry.address.toLowerCase()}:${entry.x}:${entry.y}`).sort();
  const recorded = devices.map(device => `${device.device.signerAddress.toLowerCase()}:${device.publicKey.x}:${device.publicKey.y}`).sort();
  if (onchain.length !== recorded.length || onchain.some((entry, index) => entry !== recorded[index])) invalid();
  if (setup) validatePasskeyOnboardingInput({ profile: "center-passkey-v1", address: b.wallet.address, manifestId: b.manifestId,
    nonce: a.nonce, issuedAt: setup.issuedAt, expiresAt: a.expiresAt,
    grant: { id: setup.grantId, botAddress: setup.botAddress, scopes: setup.scopes, expiresAt: setup.grantExpiresAt, label: setup.label } }, setup.issuedAt);
  if (Buffer.byteLength(JSON.stringify(b)) > 60000) invalid();
  if (v.prior !== null) { snapshotShape(v.prior); if (v.prior.accountId !== v.accountId) invalid(); }
}
function checked<T>(value: T, validate: (copy: T) => void): T {
  try { const result = copy(value); validate(result); return result; } catch { return invalid(); }
}
export function validateWalletAuthorityContext(value: unknown): WalletAuthorityContext { return checked(value as WalletAuthorityContext, contextShape); }
export function validateWalletAuthoritySnapshot(value: unknown): WalletAuthoritySnapshot { return checked(value as WalletAuthoritySnapshot, snapshotShape); }
export function walletAuthorityContextDigest(context: WalletAuthorityContext): Hex { return digest(validateWalletAuthorityContext(context)); }
/** Excludes observation time, block, ordinary nonces and USE counters from authority identity. */
export function createWalletAuthorityIdentity(context: WalletAuthorityContext, state: {
  stateHash: Hex; sessionAdministration: { epoch: string; hash: Hex }; creationTransaction: Hex;
}): WalletAuthorityIdentity {
  const c = validateWalletAuthorityContext(context), s = copy(state);
  fields(s, ["stateHash", "sessionAdministration", "creationTransaction"]);
  const result: WalletAuthorityIdentity = { version: "center-wallet-authority-identity-v1", accountId: c.accountId,
    manifestCommitment: digest(c.enrollment.intent.manifest), manifestRevision: c.enrollment.intent.manifest.revision,
    enrollmentCommitment: digest(c.enrollment), credentialCommitment: digest(c.devices ? { credential: c.credential, devices: c.devices } : c.credential), bindingId: c.binding.id,
    bindingAuthorizationDigest: c.binding.authorization.digest, creationCommitment: digest(c.enrollment.creation),
    initializerHash: c.enrollment.creation!.initializerHash, ...s };
  identityShape(result); return result;
}
export function walletAuthorityIdentityDigest(identity: WalletAuthorityIdentity): Hex { return digest(checked(identity, identityShape)); }
export function walletAuthorityExpectedAnchor(context: WalletAuthorityContext): RestBlockEvidence | null {
  const c = validateWalletAuthorityContext(context);
  return c.prior?.activeFence?.recoveryAnchor ?? c.prior?.acceptedAnchor ?? null;
}
export function validateWalletAuthorityObservation(value: unknown, context: WalletAuthorityContext): WalletAuthorityObservation {
  const c = validateWalletAuthorityContext(context), result = checked(value as WalletAuthorityObservation, observationShape);
  if (result.accountId !== c.accountId || result.contextDigest !== digest(c) ||
    !equal(result.priorAnchor.expected, c.prior?.activeFence?.recoveryAnchor ?? c.prior?.acceptedAnchor ?? null)) conflict();
  if (result.identity && !equal(result.identity, createWalletAuthorityIdentity(c, { stateHash: result.identity.stateHash,
    sessionAdministration: result.identity.sessionAdministration, creationTransaction: result.identity.creationTransaction }))) conflict();
  return result;
}
/** Pure candidate only. The store must compare captured context/revision/epochs and DB time under locks. */
export function reconcileWalletAuthority(context: WalletAuthorityContext, observation: WalletAuthorityObservation, nowMs: number): WalletAuthoritySnapshot {
  const c = validateWalletAuthorityContext(context), o = validateWalletAuthorityObservation(observation, c), prior = c.prior;
  clock(nowMs);
  if (nowMs < o.observedAtMs || (prior && (nowMs < prior.updatedAtMs || o.observedAtMs < (prior.latestObservation?.observedAtMs ?? 0)))) conflict();
  if (o.head && (nowMs >= (o.validUntilMs ?? o.observedAtMs + walletAuthorityMaximumAgeMs) ||
    BigInt(nowMs) >= BigInt(o.head.timestamp) * 1000n + BigInt(walletAuthorityMaximumHeadAgeMs))) expired();
  const advance = (value: string): string => { const result = BigInt(value) + 1n; if (result > walletAuthorityMaximumEpoch) conflict(); return String(result); };
  if (!prior || prior.bootstrapRequired) {
    if (!o.identity || o.eligibility !== "matched" || o.priorAnchor.status !== "none") conflict();
    return validateWalletAuthoritySnapshot({ version: "center-wallet-authority-snapshot-v1", accountId: c.accountId,
      revision: advance(prior?.revision ?? "0"), authorityEpoch: prior ? advance(prior.authorityEpoch) : "1",
      sessionEpoch: prior ? advance(prior.sessionEpoch) : "1", bootstrapRequired: false, readiness: "verified",
      identity: o.identity, historicalVerifiedIdentity: o.identity, acceptedAnchor: o.head!, highestObservedBlock: o.head!.blockNumber,
      activeFence: null, lastClosedFence: null, latestObservation: o, validUntilMs: o.validUntilMs, updatedAtMs: nowMs });
  }
  const next = copy(prior);
  next.revision = advance(prior.revision); next.latestObservation = o; next.updatedAtMs = nowMs; next.validUntilMs = null;
  if (!o.head) { next.readiness = next.activeFence ? "fenced" : "unknown"; return validateWalletAuthoritySnapshot(next); }
  if (prior.highestObservedBlock !== null && BigInt(o.head.blockNumber) < BigInt(prior.highestObservedBlock)) conflict();
  next.highestObservedBlock = o.head.blockNumber;
  const newFence = o.priorAnchor.status === "replaced" && !prior.activeFence;
  const changedIdentity = o.identity !== null && !equal(prior.identity, o.identity);
  // One observation may prove both changes; one monotonic advance invalidates every prior grant.
  if (newFence || changedIdentity) { next.authorityEpoch = advance(prior.authorityEpoch); next.sessionEpoch = advance(prior.sessionEpoch); }
  if (o.identity) next.identity = o.identity;
  if (newFence) next.activeFence = { triggerDigest: digest(o), authorityEpoch: next.authorityEpoch, sessionEpoch: next.sessionEpoch,
    observedAtMs: o.observedAtMs, abandonedAnchor: o.priorAnchor.expected!, replacementAnchor: o.priorAnchor.observed!,
    recoveryAnchor: o.identity ? o.head : null };
  if (next.activeFence) {
    const recovering = !newFence && prior.activeFence?.recoveryAnchor !== null && prior.activeFence?.recoveryAnchor !== undefined &&
      o.priorAnchor.status === "same" && o.identity !== null && o.eligibility === "matched" && !changedIdentity;
    if (recovering) { next.lastClosedFence = next.activeFence; next.activeFence = null; }
    else {
      if (!newFence && o.priorAnchor.status === "replaced") next.activeFence.recoveryAnchor = o.identity ? o.head : null;
      else if (o.identity) next.activeFence.recoveryAnchor = o.head;
      next.readiness = "fenced"; return validateWalletAuthoritySnapshot(next);
    }
  }
  if (!o.identity) conflict();
  next.acceptedAnchor = o.head;
  next.readiness = o.eligibility === "matched" ? "verified" : "changed";
  if (next.readiness === "verified") { next.validUntilMs = o.validUntilMs; next.historicalVerifiedIdentity = o.identity; }
  return validateWalletAuthoritySnapshot(next);
}
