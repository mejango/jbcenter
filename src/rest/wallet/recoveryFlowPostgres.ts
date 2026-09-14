import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getAddress, hashTypedData, recoverAddress, type Hex } from 'viem';
import { RestError } from '../core.js';
import { stable } from '../smartAccounts/service.js';
import { canonicalEoaSignature } from '../smartAccounts/accountExecution.js';
import { validatePasskeyOnboardingInput } from '../smartAccounts/passkeyOnboarding.js';
import { enrollmentDigest } from './enrollment.js';
import { loadWalletAuthorityContextInTransaction } from './authorityPostgres.js';
import type { WalletAuthorityContext } from './authority.js';
import { assertWalletAuthorityCredential } from './credentialRecovery.js';
import { copyWalletSignupAssertion, type WalletSignupSetup } from './signupPostgres.js';
import { assertWalletRecoveryCandidate } from './recovery.js';
import type { WalletRecoveryRecord } from './recoveryPostgres.js';
import { lockWalletCeremonyAdmission, PostgresWalletCeremonyStore, walletCeremonyDatabaseNow } from './ceremoniesPostgres.js';
import { walletCeremonyRetentionMs, type WalletCeremonyDraft } from './ceremonies.js';
import { verifyWalletAssertion, type WalletAssertion } from './webauthn.js';

export interface WalletRecoveryFlow {
  id: string; passkeyName: string; expiresAtMs: number; revision: number; setup: WalletSignupSetup | null;
}
interface FlowRow {
  id: string; token_hash: string; passkey_name: string; expires_at_ms: string; revision: string; setup_document: WalletSignupSetup | null;
}
interface RecoveryRow extends WalletRecoveryRecord { id: string; token_hash: string }
interface ResumeDraft {
  version: 'center-wallet-recovery-resume-v1'; id: string; recoveryId: string; accountId: string; rpId: string; origin: string;
  issuedAtMs: number; expiresAtMs: number; nextTokenHash: string; resumeTokenHash: string; nonce: Hex;
  intentDigest: string; candidateDigest: string; acceptedProofDigest: string; flowRevision: number; flowTokenHash: string;
  ceremony: WalletCeremonyDraft;
}
interface ResumeRow {
  id: string; recovery_id: string; draft: ResumeDraft; resume_token_hash: string; next_token_hash: string;
  expires_at_ms: string; completed_at_ms: string | null; proof_digest: string | null;
}
const sqlNow = 'floor(extract(epoch FROM clock_timestamp())*1000)::bigint';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const validToken = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
  && Buffer.from(value, 'base64url').toString('base64url') === value;
function invalid(): never { throw new RestError(400, 'WALLET_RECOVERY_FLOW_INVALID', 'Recovery continuation fields or storage bounds are invalid.'); }
function unauthorized(): never { throw new RestError(403, 'WALLET_RECOVERY_UNAUTHORIZED', 'Recovery requires a matching continuation or fresh replacement-passkey and recovery-owner proofs.'); }
function conflict(): never { throw new RestError(409, 'WALLET_RECOVERY_CONFLICT', 'Recovery or its continuation changed. Start a fresh resume challenge.'); }
function expired(): never { throw new RestError(410, 'WALLET_RECOVERY_EXPIRED', 'This recovery challenge or continuation expired.'); }
export const hashRecoveryFlowToken = (value: string) => createHash('sha256').update('center-wallet-recovery-flow-v1:' + value).digest('hex');
const resumeTokenHash = (value: string) => createHash('sha256').update('center-wallet-recovery-resume-v1:' + value).digest('hex');
const nextToken = (value: string) => createHmac('sha256', Buffer.from(value, 'base64url')).update('center-wallet-recovery-continuation-v1').digest('base64url');
const flowOf = (row: FlowRow): WalletRecoveryFlow => ({ id: row.id, passkeyName: row.passkey_name, expiresAtMs: Number(row.expires_at_ms),
  revision: Number(row.revision), setup: row.setup_document });
function fields(value: unknown, keys: string[]) {
  enrollmentDigest(value);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
}
/** Caller already holds the recovery row lock. Once a browser flow exists, its current
 * unexpired hash exclusively replaces the original immutable proof-store continuation. */
export async function assertRecoveryContinuationInTransaction(client: PoolClient, recovery: { id: string; token_hash: string }, flowToken: string): Promise<void> {
  if (!validToken(flowToken)) unauthorized();
  const row = (await client.query<FlowRow>('SELECT * FROM rest_wallet_recovery_flows WHERE id=$1 FOR UPDATE', [recovery.id])).rows[0];
  if (row ? row.token_hash !== hashRecoveryFlowToken(flowToken) || Number(row.expires_at_ms) <= await walletCeremonyDatabaseNow(client)
    : recovery.token_hash !== hashRecoveryFlowToken(flowToken)) unauthorized();
}
const types = { WalletRecoveryResume: [
  { name: 'purpose', type: 'string' }, { name: 'resumeId', type: 'string' }, { name: 'recoveryId', type: 'string' },
  { name: 'accountId', type: 'string' }, { name: 'rpId', type: 'string' }, { name: 'origin', type: 'string' },
  { name: 'contextDigest', type: 'bytes32' }, { name: 'issuedAtMs', type: 'string' }, { name: 'expiresAtMs', type: 'string' },
] } as const;
function resumeDocument(draft: Omit<ResumeDraft, 'ceremony'>) {
  return { domain: { name: 'Juicebox Center Recovery Continuation', version: '1', chainId: 8453,
    verifyingContract: getAddress(draft.accountId.slice(12)) }, types, primaryType: 'WalletRecoveryResume' as const,
    message: { purpose: 'resume-recovery-continuation', resumeId: draft.id, recoveryId: draft.recoveryId,
      accountId: draft.accountId, rpId: draft.rpId, origin: draft.origin, contextDigest: `0x${enrollmentDigest(draft)}` as Hex,
      issuedAtMs: String(draft.issuedAtMs), expiresAtMs: String(draft.expiresAtMs) } };
}
function withoutCeremony(draft: ResumeDraft) { const { ceremony: _ceremony, ...base } = draft; return base; }
function challengeOf(draft: ResumeDraft, recovery: RecoveryRow) {
  const document = resumeDocument(withoutCeremony(draft));
  return { id: draft.id, recoveryId: draft.recoveryId, accountId: draft.accountId, rpId: draft.rpId, origin: draft.origin,
    credentialId: recovery.candidate!.credential.credentialId, userHandle: recovery.intent.userHandle,
    recoveryOwner: recovery.intent.recoveryOwner, initializerHash: recovery.intent.initializerHash,
    expiresAtMs: draft.expiresAtMs, challenge: hashTypedData(document), document };
}
function recoveryIdentity(row: RecoveryRow) { return stable({ intent: row.intent, candidate: row.candidate, proof: row.proof }); }
function currentIdentity(context: WalletAuthorityContext) { return stable({ enrollment: context.enrollment, credential: context.credential }); }
function assertCurrent(record: RecoveryRow, context: WalletAuthorityContext) {
  assertWalletRecoveryCandidate(record.candidate!); assertWalletAuthorityCredential(context.credential, context.enrollment);
  if (enrollmentDigest(context.enrollment) !== record.intent.enrollmentDigest || context.accountId !== record.intent.accountId
    || (record.activation ? stable(context.credential.recovery) !== stable(record.activation)
      : enrollmentDigest(context.credential) !== record.intent.priorCredentialDigest)) conflict();
}

/** Durable continuation only. The HTTP layer owns cookies, same-origin admission and CSRF.
 * Resume proves both exact replacement key and independent owner, then rotates a browser
 * capability; it never issues grants, sessions or transactions. */
export class PostgresWalletRecoveryFlowStore {
  private readonly policy: { maxFlows: number; maxResumes: number; maxRecoveryResumes: number; flowLifetimeMs: number; resumeLifetimeMs: number };
  private readonly ceremonies: PostgresWalletCeremonyStore;
  constructor(private readonly pool: Pool, options: Partial<PostgresWalletRecoveryFlowStore['policy']> = {}) {
    enrollmentDigest(options);
    if (Object.keys(options).some(key => !['maxFlows', 'maxResumes', 'maxRecoveryResumes', 'flowLifetimeMs', 'resumeLifetimeMs'].includes(key))) invalid();
    this.policy = { maxFlows: 100000, maxResumes: 100000, maxRecoveryResumes: 32, flowLifetimeMs: 86400000, resumeLifetimeMs: 180000, ...options };
    for (const [value, maximum] of [[this.policy.maxFlows, 1000000], [this.policy.maxResumes, 1000000], [this.policy.maxRecoveryResumes, 1000],
      [this.policy.flowLifetimeMs, 86400000], [this.policy.resumeLifetimeMs, 300000]] as const)
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) invalid();
    this.ceremonies = new PostgresWalletCeremonyStore(pool);
  }
  async initialize(input: { recoveryId: string; flowToken: string; passkeyName: string }): Promise<WalletRecoveryFlow> {
    fields(input, ['recoveryId', 'flowToken', 'passkeyName']);
    const { recoveryId, flowToken, passkeyName } = input;
    if (!uuid.test(recoveryId) || !validToken(flowToken) || typeof passkeyName !== 'string' || passkeyName !== passkeyName.trim()
      || !passkeyName.length || Buffer.byteLength(passkeyName) > 120 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(passkeyName)) invalid();
    return this.transaction(async client => {
      await this.admissionLock(client, 'flows');
      const recovery = await this.lockRecovery(client, recoveryId);
      await assertRecoveryContinuationInTransaction(client, recovery, flowToken);
      const prior = (await client.query<FlowRow>('SELECT * FROM rest_wallet_recovery_flows WHERE id=$1 FOR UPDATE', [recoveryId])).rows[0];
      if (prior) { if (prior.passkey_name !== passkeyName) conflict(); return flowOf(prior); }
      if (Number((await client.query('SELECT count(*)::text AS count FROM rest_wallet_recovery_flows')).rows[0].count) >= this.policy.maxFlows) this.limit();
      const now = await walletCeremonyDatabaseNow(client); this.proofLive(recovery, now);
      const row = (await client.query<FlowRow>(`INSERT INTO rest_wallet_recovery_flows(id,token_hash,passkey_name,created_at_ms,expires_at_ms)
        VALUES($1,$2,$3,$4,$5) RETURNING *`, [recoveryId, hashRecoveryFlowToken(flowToken), passkeyName, now, now + this.policy.flowLifetimeMs])).rows[0]!;
      this.proofLive(recovery, await walletCeremonyDatabaseNow(client));
      if (Number(row.expires_at_ms) <= await walletCeremonyDatabaseNow(client)) expired();
      return flowOf(row);
    });
  }
  async authenticate(flowToken: string): Promise<WalletRecoveryFlow | null> {
    if (!validToken(flowToken)) return null;
    const row = (await this.pool.query<FlowRow>(`SELECT * FROM rest_wallet_recovery_flows WHERE token_hash=$1 AND expires_at_ms>${sqlNow}`,
      [hashRecoveryFlowToken(flowToken)])).rows[0];
    return row ? flowOf(row) : null;
  }
  async associateSetup(flowToken: string, expectedRevision: number, input: WalletSignupSetup): Promise<WalletRecoveryFlow> {
    fields(input, ['id', 'input', 'stateHash', 'manifestRevision', 'initializerHash']);
    const setup = structuredClone(input);
    if (!validToken(flowToken) || !uuid.test(setup.id) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1
      || [setup.stateHash, setup.manifestRevision, setup.initializerHash].some(value => !/^0x[0-9a-f]{64}$/.test(value))) invalid();
    const located = await this.authenticate(flowToken); if (!located) unauthorized();
    return this.transaction(async client => {
      const recovery = await this.lockRecovery(client, located.id), row = await this.lockFlow(client, located.id);
      const now = await walletCeremonyDatabaseNow(client); this.authorizedFlow(row, flowToken, now);
      if (row.setup_document && stable(row.setup_document) === stable(setup)) return flowOf(row);
      validatePasskeyOnboardingInput(setup.input, Math.floor(now / 1000));
      if (!recovery.proof || setup.input.address.toLowerCase() !== recovery.intent.accountId.slice(12)
        || setup.input.manifestId !== recovery.intent.manifest.id || setup.manifestRevision !== recovery.intent.manifest.revision
        || setup.initializerHash !== recovery.intent.initializerHash || Number(row.revision) !== expectedRevision
        || (row.setup_document && row.setup_document.input.expiresAt * 1000 > now)) conflict();
      const updated = (await client.query<FlowRow>('UPDATE rest_wallet_recovery_flows SET setup_document=$2,revision=revision+1 WHERE id=$1 RETURNING *',
        [row.id, setup])).rows[0]!;
      const after = await walletCeremonyDatabaseNow(client);
      if (Number(updated.expires_at_ms) <= after || setup.input.expiresAt * 1000 <= after) expired();
      return flowOf(updated);
    });
  }
  async beginResume(recoveryId: string) {
    if (typeof recoveryId !== 'string' || !uuid.test(recoveryId)) unauthorized();
    const captured = await this.capture(recoveryId); assertCurrent(captured.recovery, captured.context);
    const expectedRecovery = recoveryIdentity(captured.recovery), expectedCurrent = currentIdentity(captured.context);
    return this.transaction(async client => {
      await this.admissionLock(client, 'resumes'); await lockWalletCeremonyAdmission(client);
      await client.query(`DELETE FROM rest_wallet_recovery_resumes WHERE id IN
        (SELECT id FROM rest_wallet_recovery_resumes WHERE retain_until_ms<=${sqlNow} ORDER BY retain_until_ms,id LIMIT 100 FOR UPDATE SKIP LOCKED)`);
      const counts = (await client.query<{ total: number; recovery: number }>('SELECT count(*)::int AS total,count(*) FILTER (WHERE recovery_id=$1)::int AS recovery FROM rest_wallet_recovery_resumes', [recoveryId])).rows[0]!;
      if (counts.total >= this.policy.maxResumes || counts.recovery >= this.policy.maxRecoveryResumes) this.limit();
      const current = await loadWalletAuthorityContextInTransaction(client, captured.recovery.intent.accountId);
      const recovery = await this.lockRecovery(client, recoveryId), flow = await this.lockFlow(client, recoveryId);
      if (currentIdentity(current) !== expectedCurrent || recoveryIdentity(recovery) !== expectedRecovery
        || stable(recovery.activation) !== stable(captured.recovery.activation)) conflict();
      const now = await walletCeremonyDatabaseNow(client); this.proofLive(recovery, now);
      const resumeToken = randomBytes(32).toString('base64url');
      const base = { version: 'center-wallet-recovery-resume-v1' as const, id: randomUUID(), recoveryId, accountId: recovery.intent.accountId,
        rpId: recovery.intent.rpId, origin: recovery.intent.origin, issuedAtMs: now, expiresAtMs: now + this.policy.resumeLifetimeMs,
        nextTokenHash: hashRecoveryFlowToken(nextToken(resumeToken)), resumeTokenHash: resumeTokenHash(resumeToken),
        nonce: `0x${randomBytes(32).toString('hex')}` as Hex, intentDigest: enrollmentDigest(recovery.intent),
        candidateDigest: enrollmentDigest(recovery.candidate), acceptedProofDigest: enrollmentDigest(recovery.proof),
        flowRevision: Number(flow.revision), flowTokenHash: flow.token_hash };
      const draft: ResumeDraft = { ...base, ceremony: { id: base.id, accountId: 'wallet-recovery-resume:' + recoveryId, purpose: 'rotate',
        contextDigest: enrollmentDigest(base), challenge: Buffer.from(hashTypedData(resumeDocument(base)).slice(2), 'hex').toString('base64url'), expiresAt: base.expiresAtMs } };
      await this.ceremonies.issueInTransaction(client, draft.ceremony, null);
      await client.query(`INSERT INTO rest_wallet_recovery_resumes(id,recovery_id,draft,resume_token_hash,next_token_hash,expires_at_ms,retain_until_ms)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [draft.id, recoveryId, draft, draft.resumeTokenHash, draft.nextTokenHash, draft.expiresAtMs, draft.expiresAtMs + walletCeremonyRetentionMs]);
      const after = await walletCeremonyDatabaseNow(client); this.proofLive(recovery, after); if (draft.expiresAtMs <= after) expired();
      return { challenge: challengeOf(draft, recovery), resumeToken };
    });
  }
  async completeResume(input: { resumeId: string; resumeToken: string; assertion: WalletAssertion; backupSignature: Hex }) {
    if (!input || Reflect.ownKeys(input).length !== 4 || ['resumeId', 'resumeToken', 'assertion', 'backupSignature'].some(key =>
      !Object.hasOwn(input, key) || !('value' in Object.getOwnPropertyDescriptor(input, key)!))) unauthorized();
    const { resumeId, resumeToken } = input;
    if (typeof resumeId !== 'string' || !uuid.test(resumeId) || !validToken(resumeToken)) unauthorized();
    const assertion = copyWalletSignupAssertion(input.assertion), signature = canonicalEoaSignature(input.backupSignature);
    const prior = (await this.pool.query<ResumeRow>(`SELECT * FROM rest_wallet_recovery_resumes WHERE id=$1 AND resume_token_hash=$2 AND retain_until_ms>${sqlNow}`,
      [resumeId, resumeTokenHash(resumeToken)])).rows[0];
    if (!prior || hashRecoveryFlowToken(nextToken(resumeToken)) !== prior.next_token_hash) unauthorized();
    const captured = await this.capture(prior.recovery_id), recovery = captured.recovery; assertCurrent(recovery, captured.context);
    const draft = prior.draft, candidate = recovery.candidate!;
    if (enrollmentDigest(recovery.intent) !== draft.intentDigest || enrollmentDigest(candidate) !== draft.candidateDigest
      || enrollmentDigest(recovery.proof) !== draft.acceptedProofDigest) conflict();
    const challenge = hashTypedData(resumeDocument(withoutCeremony(draft)));
    try {
      verifyWalletAssertion(assertion, { purpose: 'rotate', challenge, rpId: draft.rpId, origin: draft.origin, requireUserHandle: true,
        credential: { id: candidate.credential.credentialId, userHandle: candidate.credential.userHandle,
          publicKey: candidate.credential.publicKey, backupEligible: candidate.credential.backupEligible } });
      if ((await recoverAddress({ hash: challenge, signature })).toLowerCase() !== recovery.intent.recoveryOwner) unauthorized();
    } catch { unauthorized(); }
    const proofDigest = enrollmentDigest(['center-wallet-recovery-resume-proof-v1', draft, candidate.credential, recovery.intent.recoveryOwner]);
    const expectedRecovery = recoveryIdentity(recovery), expectedCurrent = currentIdentity(captured.context);
    return this.transaction(async client => {
      const current = await loadWalletAuthorityContextInTransaction(client, recovery.intent.accountId);
      const liveRecovery = await this.lockRecovery(client, recovery.id), flow = await this.lockFlow(client, recovery.id);
      const row = (await client.query<ResumeRow>('SELECT * FROM rest_wallet_recovery_resumes WHERE id=$1 FOR UPDATE', [resumeId])).rows[0];
      if (currentIdentity(current) !== expectedCurrent || recoveryIdentity(liveRecovery) !== expectedRecovery
        || stable(liveRecovery.activation) !== stable(recovery.activation) || !row || stable(row.draft) !== stable(draft)) conflict();
      const now = await walletCeremonyDatabaseNow(client); this.proofLive(liveRecovery, now);
      if (row.completed_at_ms !== null) {
        if (row.proof_digest !== proofDigest || flow.token_hash !== row.next_token_hash) conflict();
        if (Number(flow.expires_at_ms) <= now) expired();
        return { flow: flowOf(flow), flowToken: nextToken(resumeToken), replayed: true };
      }
      if (Number(flow.revision) !== draft.flowRevision || flow.token_hash !== draft.flowTokenHash) conflict();
      if (draft.expiresAtMs <= now) expired();
      await this.ceremonies.consumeInTransaction(client, { ...draft.ceremony, proofDigest, resultId: recovery.id });
      const updated = (await client.query<FlowRow>('UPDATE rest_wallet_recovery_flows SET token_hash=$2,expires_at_ms=$3,revision=revision+1 WHERE id=$1 RETURNING *',
        [recovery.id, row.next_token_hash, now + this.policy.flowLifetimeMs])).rows[0]!;
      await client.query('UPDATE rest_wallet_recovery_resumes SET completed_at_ms=$2,proof_digest=$3 WHERE id=$1', [resumeId, now, proofDigest]);
      const after = await walletCeremonyDatabaseNow(client); this.proofLive(liveRecovery, after);
      if (draft.expiresAtMs <= after || Number(updated.expires_at_ms) <= after) expired();
      return { flow: flowOf(updated), flowToken: nextToken(resumeToken), replayed: false };
    });
  }
  private async capture(id: string) {
    const hint = (await this.pool.query<RecoveryRow>('SELECT * FROM rest_wallet_recoveries WHERE id=$1', [id])).rows[0];
    if (!hint?.candidate) unauthorized();
    return this.transaction(async client => {
      const context = await loadWalletAuthorityContextInTransaction(client, hint.intent.accountId), recovery = await this.lockRecovery(client, id);
      await this.lockFlow(client, id); if (!recovery.candidate) unauthorized();
      return { context, recovery };
    });
  }
  private async lockRecovery(client: PoolClient, id: string) {
    const row = (await client.query<RecoveryRow>('SELECT * FROM rest_wallet_recoveries WHERE id=$1 FOR UPDATE', [id])).rows[0];
    return row ?? unauthorized();
  }
  private async lockFlow(client: PoolClient, id: string) {
    const row = (await client.query<FlowRow>('SELECT * FROM rest_wallet_recovery_flows WHERE id=$1 FOR UPDATE', [id])).rows[0];
    return row ?? unauthorized();
  }
  private authorizedFlow(row: FlowRow, flowToken: string, now: number) {
    if (row.token_hash !== hashRecoveryFlowToken(flowToken) || Number(row.expires_at_ms) <= now) unauthorized();
  }
  private proofLive(record: RecoveryRow, now: number) { if (!record.proof && record.intent.expiresAtMs <= now) expired(); }
  private limit(): never { throw new RestError(429, 'WALLET_RECOVERY_FLOW_LIMIT', 'Recovery continuation storage admission limit reached.'); }
  private async admissionLock(client: PoolClient, table: 'flows' | 'resumes') {
    // ponytail: bounded counts serialize admission; use measured sharded counters if contention requires them.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('wallet-recovery-${table}:' || 'rest_wallet_recovery_${table}'::regclass::oid::text,0))`);
  }
  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN'); await client.query("SET LOCAL lock_timeout='5000ms'");
      await client.query("SET LOCAL statement_timeout='10000ms'"); await client.query("SET LOCAL idle_in_transaction_session_timeout='15000ms'");
      const result = await run(client); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
}
