import type { Pool, PoolClient } from 'pg';
import type { Address, Hex } from 'viem';
import type { SmartAccountBinding } from '../../src/rest/smartAccounts/types.js';
import { fingerprint } from '../../src/rest/smartAccounts/service.js';
import { enrollmentDigest } from '../../src/rest/wallet/enrollment.js';
import { validateWalletAuthoritySnapshot, type WalletAuthorityIdentity, type WalletAuthoritySnapshot } from '../../src/rest/wallet/authority.js';

/** Trusted synthetic readiness for isolated grant/auth/claim tests. This helper does not establish
 * enrollment, signatures, deployment, canonical chain observation or production readiness. */
export interface TrustedWalletAuthorityFixture {
  binding: SmartAccountBinding;
  snapshot: WalletAuthoritySnapshot;
}
type Database = Pick<Pool | PoolClient, 'query'>;
const signer = '0x9000000000000000000000000000000000000001' as Address;
const recovery = '0x9000000000000000000000000000000000000002' as Address;
const word = (name: string): Hex => fingerprint(`trusted-wallet-authority-fixture:${name}`);
export async function trustedAuthorityNow(database: Database): Promise<number> {
  return Number((await database.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now')).rows[0].now);
}
export function trustedWalletAuthorityFixture(accountId: string, nowMs: number,
  epochs: { authorityEpoch?: string; sessionEpoch?: string } = {}): TrustedWalletAuthorityFixture {
  const wallet = accountId.split(':').at(-1)! as Address, seconds = Math.floor(nowMs / 1000);
  const id = fingerprint({ ownerAccountId: accountId, wallet, chainId: 8453 });
  const binding: SmartAccountBinding = {
    id, ownerAccountId: accountId, ownerAddress: wallet, wallet: { chainId: 8453, address: wallet }, manifestId: 'trusted-fixture-manifest',
    authorization: { digest: word(`binding:${accountId}`), nonce: word(`nonce:${accountId}`), expiresAt: seconds + 300,
      method: 'safe-passkey-owner-threshold-and-api-grant', setup: { manifestRevision: word('manifest-revision'),
        initializerHash: word(`initializer:${accountId}`), issuedAt: seconds, grantId: '11111111-1111-4111-8111-111111111111',
        botAddress: signer, scopes: ['read', 'plan', 'relay'], grantExpiresAt: seconds + 3600, label: 'Trusted synthetic fixture' } },
    state: { chainId: 8453, address: wallet, manifestId: 'trusted-fixture-manifest', manifestRevision: word('manifest-revision'),
      owners: [signer, recovery], threshold: 1, safeNonce: '0', stateHash: word(`state:${accountId}`),
      evidence: { chainId: 8453, blockNumber: '100', blockHash: word('block:100'), timestamp: String(seconds), source: 'onchain' },
      codeHashes: [], executionVerified: false, moduleConfigurationVerified: true,
      modules: { stateHash: word('modules'), complete: true, arbitrarySigningDisabled: true, wildcardExecutionDisabled: true,
        details: { sessions: { permissionIds: [] }, provenance: { initializerHash: word(`initializer:${accountId}`) },
          sessionAdministration: { epoch: '0', hash: word('administration') } } },
      ownerProfile: { version: 'center-passkey-v1', signer: { address: signer, kind: 'contract',
        x: '0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296',
        y: '0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5',
        verifiers: `0x${'11'.repeat(22)}`, runtimeCodeHash: word('signer-runtime') }, recoveryOwner: { address: recovery, kind: 'ecdsa' } } },
  };
  const identity: WalletAuthorityIdentity = { version: 'center-wallet-authority-identity-v1', accountId,
    manifestCommitment: word('manifest-commitment'), manifestRevision: binding.state.manifestRevision,
    enrollmentCommitment: word(`enrollment:${accountId}`), credentialCommitment: word(`credential:${accountId}`),
    bindingId: binding.id, bindingAuthorizationDigest: binding.authorization.digest,
    creationCommitment: word(`creation:${accountId}`), initializerHash: binding.authorization.setup!.initializerHash,
    creationTransaction: word(`creation-transaction:${accountId}`), stateHash: binding.state.stateHash,
    sessionAdministration: { epoch: '0', hash: word('administration') } };
  const snapshot: WalletAuthoritySnapshot = { version: 'center-wallet-authority-snapshot-v1', accountId,
    revision: '1', authorityEpoch: epochs.authorityEpoch ?? '1', sessionEpoch: epochs.sessionEpoch ?? '1',
    bootstrapRequired: false, readiness: 'verified', identity, historicalVerifiedIdentity: structuredClone(identity),
    acceptedAnchor: structuredClone(binding.state.evidence), highestObservedBlock: '100', activeFence: null, lastClosedFence: null,
    latestObservation: { version: 'center-wallet-authority-observation-v1', accountId, contextDigest: word(`context:${accountId}`),
      observedAtMs: nowMs, validUntilMs: nowMs + 30_000, head: structuredClone(binding.state.evidence),
      priorAnchor: { status: 'none', expected: null, observed: null }, identity: structuredClone(identity), eligibility: 'matched', reason: null },
    validUntilMs: nowMs + 30_000, updatedAtMs: nowMs };
  return { binding, snapshot };
}

/** Direct fixture write only; callers must label this trusted synthetic authority, never producer proof. */
export async function writeTrustedWalletAuthoritySnapshot(database: Database, snapshot: WalletAuthoritySnapshot): Promise<void> {
  snapshot = structuredClone(snapshot);
  const prior = (await database.query('SELECT revision,updated_at,snapshot FROM rest_wallet_authority WHERE account_id=$1', [snapshot.accountId])).rows[0];
  if (prior) {
    snapshot.revision = (BigInt(prior.revision) + 1n).toString();
    snapshot.updatedAtMs = Math.max(snapshot.updatedAtMs, Number(prior.updated_at) * 1000, prior.snapshot?.updatedAtMs ?? 0);
  }
  validateWalletAuthoritySnapshot(snapshot);
  await database.query(`INSERT INTO rest_wallet_authority(account_id,authority_epoch,session_epoch,updated_at,revision,snapshot,
    observation_digest,ready_until_ms,binding_id,binding_authorization_digest) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)
    ON CONFLICT(account_id) DO UPDATE SET authority_epoch=EXCLUDED.authority_epoch,session_epoch=EXCLUDED.session_epoch,
    updated_at=EXCLUDED.updated_at,revision=EXCLUDED.revision,snapshot=EXCLUDED.snapshot,observation_digest=EXCLUDED.observation_digest,
    ready_until_ms=EXCLUDED.ready_until_ms,binding_id=EXCLUDED.binding_id,binding_authorization_digest=EXCLUDED.binding_authorization_digest`,
  [snapshot.accountId, snapshot.authorityEpoch, snapshot.sessionEpoch, Math.floor(snapshot.updatedAtMs / 1000), snapshot.revision,
    JSON.stringify(snapshot), snapshot.latestObservation ? enrollmentDigest(snapshot.latestObservation) : null,
    snapshot.validUntilMs, snapshot.identity?.bindingId ?? null, snapshot.identity?.bindingAuthorizationDigest ?? null]);
}
/** Coherent synthetic negative readiness without epoch changes, isolating the readiness guard. */
export function unreadyTrustedWalletAuthority(snapshot: WalletAuthoritySnapshot, readiness: 'unknown' | 'changed' | 'fenced', nowMs: number): WalletAuthoritySnapshot {
  const value = structuredClone(snapshot), anchor = value.acceptedAnchor!;
  value.readiness = readiness; value.validUntilMs = null; value.updatedAtMs = Math.max(value.updatedAtMs, nowMs);
  const latest = value.latestObservation!;
  latest.observedAtMs = nowMs; latest.validUntilMs = null;
  latest.contextDigest = word(`negative-context:${snapshot.accountId}:${readiness}:${nowMs}`);
  if (readiness === 'unknown') {
    latest.head = null; latest.identity = null; latest.eligibility = null; latest.reason = 'canonical-unavailable';
    latest.priorAnchor = { status: 'unavailable', expected: anchor, observed: null };
  } else if (readiness === 'changed') {
    latest.head = { ...anchor, blockNumber: (BigInt(anchor.blockNumber) + 1n).toString(), blockHash: word('changed-head'), timestamp: String(Math.floor(nowMs / 1000)) };
    latest.identity = { ...value.identity!, stateHash: word('changed-state') }; latest.eligibility = 'changed'; latest.reason = 'authority-changed';
    latest.priorAnchor = { status: 'same', expected: anchor, observed: anchor };
    value.identity = structuredClone(latest.identity); value.acceptedAnchor = latest.head; value.highestObservedBlock = latest.head.blockNumber;
  } else {
    const replacement = { ...anchor, blockHash: word('replacement-head') };
    latest.head = replacement; latest.identity = null; latest.eligibility = null; latest.reason = 'canonical-anchor-replaced';
    latest.priorAnchor = { status: 'replaced', expected: anchor, observed: replacement };
    value.activeFence = { triggerDigest: word('fence-trigger'), authorityEpoch: value.authorityEpoch, sessionEpoch: value.sessionEpoch,
      observedAtMs: nowMs, abandonedAnchor: anchor, replacementAnchor: replacement, recoveryAnchor: null };
  }
  return validateWalletAuthoritySnapshot(value);
}
export async function seedTrustedWalletAuthority(database: Database, accountId: string,
  epochs: { authorityEpoch?: string; sessionEpoch?: string } = {}): Promise<TrustedWalletAuthorityFixture> {
  const fixture = trustedWalletAuthorityFixture(accountId, await trustedAuthorityNow(database), epochs), binding = fixture.binding;
  await database.query(`INSERT INTO rest_smart_account_bindings(account_id,id,chain_id,wallet_address,authorization_digest,
    created_at,updated_at,document) VALUES($1,$2,8453,$3,$4,$5,$5,$6::jsonb)`,
  [accountId, binding.id, binding.wallet.address, binding.authorization.digest, Math.floor(fixture.snapshot.updatedAtMs / 1000), JSON.stringify(binding)]);
  await writeTrustedWalletAuthoritySnapshot(database, fixture.snapshot);
  return fixture;
}
/** Explicitly advances only this trusted fixture's observation window; never extends an old deadline
 * or recreates/revives a live binding. Long tests call this when testing another boundary. */
export async function refreshTrustedWalletAuthority(database: Database, accountId: string): Promise<TrustedWalletAuthorityFixture> {
  const row = (await database.query(`SELECT a.authority_epoch,a.session_epoch,a.revision,b.document FROM rest_wallet_authority a
    JOIN rest_smart_account_bindings b ON b.account_id=a.account_id AND b.id=a.binding_id AND b.revoked_at IS NULL
    WHERE a.account_id=$1`, [accountId])).rows[0];
  if (!row) throw new Error('Trusted readiness fixture has no live binding to refresh');
  const fixture = trustedWalletAuthorityFixture(accountId, await trustedAuthorityNow(database),
    { authorityEpoch: row.authority_epoch, sessionEpoch: row.session_epoch });
  fixture.binding = row.document;
  fixture.snapshot.revision = (BigInt(row.revision) + 1n).toString();
  fixture.snapshot.latestObservation!.contextDigest = word(`refresh-context:${accountId}:${fixture.snapshot.revision}`);
  await writeTrustedWalletAuthoritySnapshot(database, fixture.snapshot);
  return fixture;
}
