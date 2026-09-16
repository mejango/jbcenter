import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PostgresWalletRecoveryStore } from '../src/rest/wallet/recoveryPostgres.js';
import { PostgresWalletAuthorityStore } from '../src/rest/wallet/authorityPostgres.js';
import { enrollmentDigest } from '../src/rest/wallet/enrollment.js';
import { walletRecoveryDocument } from '../src/rest/wallet/recovery.js';
import { createWalletAuthorityIdentity, walletAuthorityContextDigest, walletAuthorityExpectedAnchor,
  type WalletAuthorityContext, type WalletAuthorityObservation } from '../src/rest/wallet/authority.js';
import { passkeyOnboardingDocument, passkeyOnboardingSigningPayload } from '../src/rest/smartAccounts/passkeyOnboarding.js';
import { bindSmartAccountInTransaction } from '../src/rest/smartAccounts/postgres.js';
import { createWalletAuthorityContextFixture } from './fixtures/wallet-authority-context.js';
import { createRegistration, signBackupProof, signGet } from './fixtures/wallet-enrollment-crypto.js';

const connectionString = process.env.TEST_DATABASE_URL, suite = connectionString ? describe : describe.skip;
const policy = { rpId: 'juicebox.center', origin: 'https://juicebox.center' };
suite('durable replacement-passkey proof intake (canonical state explicitly modeled)', () => {
  const schema = `wallet_passkey_recovery_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool, pool: Pool, store: PostgresWalletRecoveryStore;
  const now = async () => Number((await pool.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now')).rows[0].now);
  beforeAll(async () => {
    admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 8 });
    for (const name of ['004_rest_accounts.sql', '007_rest_smart_accounts.sql', '012_rest_smart_account_onboarding.sql',
      '013_rest_wallet_ceremonies.sql', '014_rest_passkey_onboarding.sql', '042_wallet_binding_consent.sql', '015_rest_wallet_enrollment.sql', '046_wallet_signup_window.sql', '041_wallet_passkey_name.sql', '043_wallet_networks.sql', '044_wallet_devices.sql',
      '017_rest_wallet_policy.sql', '019_rest_wallet_app_grants.sql', '020_rest_wallet_authority.sql', '039_wallet_authority_window.sql', '028_wallet_recovery.sql', '029_wallet_recovery_mapping.sql', '033_wallet_unproved_recovery_expiry.sql', '030_wallet_recovery_flow.sql'])
      await pool.query(await readFile(new URL(`../src/db/migrations/${name}`, import.meta.url), 'utf8'));
    store = new PostgresWalletRecoveryStore(pool, policy);
  });
  beforeEach(async () => { await pool.query('TRUNCATE rest_accounts,rest_wallet_enrollments,rest_wallet_ceremonies CASCADE'); });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } });
  async function existing() {
    // Genuine enrollment crypto, with deliberately modeled old deployment/setup state.
    // This test seeds trusted metadata; it does not claim canonical chain observation.
    const context = await createWalletAuthorityContextFixture(await now()), e = context.enrollment, c = context.credential;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO rest_accounts(id,owner_address,authority_chain_id,display_name,bio,created_at,updated_at)
        VALUES($1,$2,8453,'','',$3,$3)`, [context.accountId, context.accountId.slice(12), Math.floor(e.createdAt / 1000)]);
      await client.query(`INSERT INTO rest_wallet_enrollments(id,user_handle,state,intent_digest,created_at,expires_at,retain_until,
        intent,candidate,candidate_digest,creation,possession,safe_address,account_id,verified_at,receipt)
        VALUES($1,$2,'verified',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [e.intent.id, e.intent.userHandle, enrollmentDigest(e.intent), e.createdAt, e.intent.expiresAt, e.intent.expiresAt + 86400000,
        e.intent, e.candidate, e.candidateDigest, e.creation, e.possession, e.creation!.address.toLowerCase(), context.accountId, c.verifiedAtMs, e.receipt]);
      await client.query(`INSERT INTO rest_wallet_credentials(rp_id,credential_id,enrollment_id,account_id,user_handle,public_key_x,public_key_y,backup_eligible,verified_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [c.rpId, c.credentialId, c.enrollmentId, c.accountId, c.userHandle, c.publicKey.x, c.publicKey.y, c.backupEligible, c.verifiedAtMs]);
      await bindSmartAccountInTransaction(client, context.binding, context.binding.authorization.setup!.issuedAt);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    return context;
  }
  async function registered(selected = store, suppliedContext?: Awaited<ReturnType<typeof existing>>) {
    const context = suppliedContext ?? await existing(), begun = await selected.begin(context.accountId), intent = begun.record.intent;
    const key = createRegistration({ rpId: intent.rpId, origin: intent.origin, userHandle: intent.userHandle,
      challenge: `0x${Buffer.from(intent.registration.challenge, 'base64url').toString('hex')}` });
    const record = await selected.register(intent.id, begun.flowToken, key.response);
    const document = walletRecoveryDocument(record.candidate!);
    const proof = { assertion: signGet({ ...key, rpId: intent.rpId, origin: intent.origin, challenge: hashTypedData(document) }),
      backupSignature: await signBackupProof(document) };
    return { context, begun, key, record, proof };
  }
  async function observe(context: WalletAuthorityContext, lifetime = 30000): Promise<WalletAuthorityObservation> {
    const observedAtMs = await now(), expected = walletAuthorityExpectedAnchor(context);
    const blockNumber = String(BigInt(context.prior?.highestObservedBlock ?? '100') + 1n);
    return { version: 'center-wallet-authority-observation-v1', accountId: context.accountId, contextDigest: walletAuthorityContextDigest(context),
      observedAtMs, validUntilMs: observedAtMs + lifetime,
      head: blockNumber === context.binding.state.evidence.blockNumber ? structuredClone(context.binding.state.evidence)
        : { chainId: 8453, blockNumber, blockHash: `0x${'88'.repeat(32)}`, timestamp: String(Math.floor(observedAtMs / 1000)), source: 'onchain' },
      priorAnchor: { status: expected ? 'same' : 'none', expected, observed: expected },
      identity: createWalletAuthorityIdentity(context, { stateHash: context.binding.state.stateHash,
        sessionAdministration: { epoch: '0', hash: `0x${'77'.repeat(32)}` }, creationTransaction: `0x${'66'.repeat(32)}` }),
      eligibility: 'matched', reason: null };
  }
  async function replacementSetup(value: Awaited<ReturnType<typeof registered>>) {
    const id = value.record.intent.id;
    await store.prove(id, value.begun.flowToken, value.proof);
    const authority = new PostgresWalletAuthorityStore(pool), prior = await authority.loadContext(value.context.accountId);
    await authority.reconcile(prior, await observe(prior));
    const captured = await authority.loadContext(value.context.accountId), observed = await observe(captured);
    const binding = structuredClone(value.context.binding), setup = binding.authorization.setup!, candidate = value.record.candidate!;
    const current = Math.floor(await now() / 1000), browser = privateKeyToAccount(`0x${'33'.repeat(32)}`), oldGrantId = randomUUID();
    binding.state.owners = [candidate.signerAddress, candidate.intent.recoveryOwner]; binding.state.stateHash = `0x${randomUUID().replaceAll('-', '').repeat(2)}`;
    binding.state.evidence = { chainId: 8453, blockNumber: String(BigInt(captured.prior!.highestObservedBlock!) + 1n),
      blockHash: `0x${randomUUID().replaceAll('-', '').repeat(2)}`, timestamp: String(current), source: 'onchain' };
    Object.assign(binding.state.ownerProfile!.signer, { address: candidate.signerAddress, ...candidate.credential.publicKey });
    binding.authorization.nonce = `0x${randomUUID().replaceAll('-', '').repeat(2)}`; binding.authorization.expiresAt = current + 300;
    Object.assign(setup, { issuedAt: current, grantId: randomUUID(), botAddress: browser.address, grantExpiresAt: current + 3600 });
    const document = passkeyOnboardingDocument(candidate.intent.origin, { profile: 'center-passkey-v1', address: binding.wallet.address,
      manifestId: binding.manifestId, nonce: binding.authorization.nonce, issuedAt: setup.issuedAt, expiresAt: binding.authorization.expiresAt,
      grant: { id: setup.grantId, botAddress: setup.botAddress, scopes: setup.scopes, expiresAt: setup.grantExpiresAt, label: setup.label } }, binding.state);
    binding.authorization.digest = hashTypedData(document);
    // Trusted setup-store seam with modeled chain state. Actual canonical setup is covered by EVM suites.
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SELECT id FROM rest_accounts WHERE id=$1 FOR UPDATE', [value.context.accountId]);
      await bindSmartAccountInTransaction(client, binding, current);
      for (const grantId of [oldGrantId, setup.grantId]) await client.query(`INSERT INTO rest_bot_grants(id,account_id,bot_address,scopes,label,created_at,expires_at)
        VALUES($1,$2,$3,ARRAY['read','plan','relay'],'Recovery fixture',$4,$5)`, [grantId, value.context.accountId, browser.address.toLowerCase(), current, current + 3600]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    const assertion = signGet({ ...value.key, rpId: policy.rpId, origin: policy.origin, challenge: passkeyOnboardingSigningPayload(document).digest });
    return { assertion, captured, observed, oldGrantId, grantId: setup.grantId };
  }
  it('stores only a continuation hash and keeps original enrollment/current authority unchanged', async () => {
    const value = await registered(), id = value.record.intent.id;
    expect(await store.get(id, id)).toBeNull();
    expect(await store.get(id, value.begun.flowToken)).toEqual(value.record);
    expect((await pool.query('SELECT to_jsonb(r)::text AS row FROM rest_wallet_recoveries r')).rows[0].row).not.toContain(value.begun.flowToken);
    const before = await new PostgresWalletAuthorityStore(pool).loadContext(value.context.accountId);
    const accepted = await store.prove(id, value.begun.flowToken, value.proof);
    expect(accepted.replayed).toBe(false); expect(accepted.record.proof!.accountId).toBe(value.context.accountId);
    expect(await new PostgresWalletAuthorityStore(pool).loadContext(value.context.accountId)).toEqual(before);
    expect((await pool.query('SELECT count(*)::int AS count FROM rest_bot_grants')).rows[0].count).toBe(0);
  });
  it('returns the first exact registration and proof across concurrent replicas and lost responses', async () => {
    const value = await registered(), replica = new PostgresWalletRecoveryStore(pool, policy), id = value.record.intent.id;
    expect(await replica.register(id, value.begun.flowToken, value.key.response)).toEqual(value.record);
    const results = await Promise.all([store.prove(id, value.begun.flowToken, value.proof), replica.prove(id, value.begun.flowToken, value.proof)]);
    expect(results.map(r => r.replayed).sort()).toEqual([false, true]); expect(results[0].record).toEqual(results[1].record);
    expect(await replica.prove(id, value.begun.flowToken, value.proof)).toEqual({ record: results[0].record, replayed: true });
    expect((await pool.query('SELECT count(*)::int AS count FROM rest_wallet_ceremonies WHERE consumed_at IS NOT NULL')).rows[0].count).toBe(1);
  });
  it('rejects swapped credentials, locator-only requests, stale mappings and wrong recovery proofs', async () => {
    const value = await registered(), other = await registered(), id = value.record.intent.id;
    await expect(store.register(id, value.begun.flowToken, other.key.response)).rejects.toThrow();
    await expect(store.prove(id, id, value.proof)).rejects.toMatchObject({ status: 403 });
    await expect(store.prove(id, value.begun.flowToken, other.proof)).rejects.toMatchObject({ status: 403 });
    expect((await store.get(id, value.begun.flowToken))!.proof).toBeNull();
    await pool.query('UPDATE rest_wallet_credentials SET superseded_at=verified_at WHERE account_id=$1', [value.context.accountId]);
    await expect(store.prove(id, value.begun.flowToken, value.proof)).rejects.toThrow();
    expect((await store.get(id, value.begun.flowToken))!.proof).toBeNull();
  });
  it('expires unaccepted proofs and preserves the exact accepted receipt after its deadline', async () => {
    const short = new PostgresWalletRecoveryStore(pool, { ...policy, lifetimeMs: 1200 });
    const accepted = await registered(short), receipt = await short.prove(accepted.record.intent.id, accepted.begun.flowToken, accepted.proof);
    const pending = await registered(short);
    await pool.query('SELECT pg_sleep(GREATEST(0,($1-extract(epoch FROM clock_timestamp())*1000)/1000)+0.02)', [pending.record.intent.expiresAtMs]);
    await expect(short.prove(pending.record.intent.id, pending.begun.flowToken, pending.proof)).rejects.toMatchObject({ status: 410 });
    expect(await short.prove(accepted.record.intent.id, accepted.begun.flowToken, accepted.proof)).toEqual({ ...receipt, replayed: true });
    await expect(pool.query('DELETE FROM rest_wallet_recoveries WHERE id=$1', [accepted.record.intent.id])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query("UPDATE rest_wallet_recoveries SET proof=jsonb_set(proof,'{verificationDigest}',to_jsonb($2::text)) WHERE id=$1",
      [accepted.record.intent.id, '11'.repeat(32)])).rejects.toMatchObject({ code: '23514' });
  });
  it('bounds anonymous recovery globally without charging unproved requests to the victim account', async () => {
    const context = await existing(), options = { ...policy, maxRecords: 3, maxAccountRecords: 2 };
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => new PostgresWalletRecoveryStore(pool, options).begin(context.accountId)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(3);
    const second = await existing();
    await expect(new PostgresWalletRecoveryStore(pool, options).begin(second.accountId)).rejects.toMatchObject({ status: 429 });
    expect((await pool.query('SELECT count(*)::int AS count FROM rest_wallet_recoveries')).rows[0].count).toBe(3);
  });
  it('atomically replaces the current mapping, retains genesis and fences old grants/observations across replicas', async () => {
    const value = await registered(), next = await replacementSetup(value), id = value.record.intent.id;
    const first = new PostgresWalletRecoveryStore(pool, policy, { audience: policy.origin, observe }), second = new PostgresWalletRecoveryStore(pool, policy, { audience: policy.origin, observe });
    const results = await Promise.all([first.activate(id, value.begun.flowToken, next.assertion), second.activate(id, value.begun.flowToken, next.assertion)]);
    expect(results.map(r => r.replayed).sort()).toEqual([false, true]); expect(results[0].receipt).toEqual(results[1].receipt);
    expect(await first.activate(id, value.begun.flowToken, next.assertion)).toEqual({ receipt: results[0].receipt, replayed: true });
    const authority = new PostgresWalletAuthorityStore(pool), current = await authority.loadContext(value.context.accountId);
    expect(current.enrollment).toEqual(value.context.enrollment); expect(current.credential.credentialId).toBe(value.key.credentialId);
    expect(current.credential.recovery).toEqual(results[0].receipt);
    expect(current.prior).toMatchObject({ authorityEpoch: '2', sessionEpoch: '2', readiness: 'unknown' });
    const grants = (await pool.query('SELECT id,revoked_at FROM rest_bot_grants ORDER BY id')).rows;
    expect(grants.find(g => g.id === next.oldGrantId).revoked_at).not.toBeNull();
    expect(grants.find(g => g.id === next.grantId).revoked_at).toBeNull();
    await expect(authority.reconcile(next.captured, next.observed)).rejects.toThrow();
    expect((await authority.reconcile(current, await observe(current))).snapshot.readiness).toBe('verified');
    await expect(pool.query('UPDATE rest_wallet_credentials SET superseded_at=NULL WHERE credential_id=$1', [value.context.credential.credentialId])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query('DELETE FROM rest_wallet_credentials WHERE credential_id=$1', [value.context.credential.credentialId])).rejects.toMatchObject({ code: '23514' });
  });
  it('requires a configured canonical observer and fresh replacement-passkey setup proof before switching', async () => {
    const value = await registered(), next = await replacementSetup(value), id = value.record.intent.id;
    await expect(store.activate(id, value.begun.flowToken, next.assertion)).rejects.toMatchObject({ status: 503 });
    const guarded = new PostgresWalletRecoveryStore(pool, policy, { audience: policy.origin, observe });
    await expect(guarded.activate(id, value.begun.flowToken, value.proof.assertion)).rejects.toThrow();
    const unavailable = new PostgresWalletRecoveryStore(pool, policy, { audience: policy.origin, observe: async context => ({ ...await observe(context),
      head: null, identity: null, eligibility: null, validUntilMs: null, reason: 'unavailable',
      priorAnchor: { status: 'unavailable', expected: walletAuthorityExpectedAnchor(context), observed: null } }) });
    await expect(unavailable.activate(id, value.begun.flowToken, next.assertion)).rejects.toThrow();
    expect((await pool.query('SELECT credential_id FROM rest_wallet_credentials WHERE superseded_at IS NULL')).rows[0].credential_id).toBe(value.context.credential.credentialId);
    expect((await pool.query('SELECT count(*)::int AS count FROM rest_bot_grants WHERE revoked_at IS NOT NULL')).rows[0].count).toBe(0);
  });
  it('retains both replacement generations and rejects the first receipt after a later recovery', async () => {
    const initial = await registered(), setup = await replacementSetup(initial);
    const active = new PostgresWalletRecoveryStore(pool, policy, { audience: policy.origin, observe });
    await active.activate(initial.record.intent.id, initial.begun.flowToken, setup.assertion);
    const authority = new PostgresWalletAuthorityStore(pool), firstContext = await authority.loadContext(initial.context.accountId);
    await authority.reconcile(firstContext, await observe(firstContext));
    const context = await authority.loadContext(initial.context.accountId), begun = await active.begin(context.accountId), intent = begun.record.intent;
    const key = createRegistration({ rpId: intent.rpId, origin: intent.origin, userHandle: intent.userHandle,
      challenge: `0x${Buffer.from(intent.registration.challenge, 'base64url').toString('hex')}` });
    const record = await active.register(intent.id, begun.flowToken, key.response), document = walletRecoveryDocument(record.candidate!);
    const proof = { assertion: signGet({ ...key, rpId: policy.rpId, origin: policy.origin, challenge: hashTypedData(document) }),
      backupSignature: await signBackupProof(document) };
    const laterSetup = await replacementSetup({ context, begun, key, record, proof });
    const latest = await active.activate(intent.id, begun.flowToken, laterSetup.assertion);
    expect(latest.receipt.priorCredentialDigest).toBe(enrollmentDigest(context.credential));
    await expect(active.activate(initial.record.intent.id, initial.begun.flowToken, setup.assertion)).rejects.toMatchObject({ status: 409 });
    const current = await authority.loadContext(context.accountId);
    expect(current.enrollment).toEqual(initial.context.enrollment); expect(current.credential.credentialId).toBe(key.credentialId);
    expect(BigInt(current.prior!.authorityEpoch)).toBeGreaterThan(BigInt(context.prior!.authorityEpoch));
    const rows = (await pool.query('SELECT credential_id,superseded_at FROM rest_wallet_credentials WHERE account_id=$1', [context.accountId])).rows;
    expect(rows).toHaveLength(3); expect(rows.filter(row => row.superseded_at === null)).toEqual([{ credential_id: key.credentialId, superseded_at: null }]);
    expect((await pool.query('SELECT id FROM rest_bot_grants WHERE account_id=$1 AND revoked_at IS NULL', [context.accountId])).rows).toEqual([{ id: laterSetup.grantId }]);
  });
  it('rolls every mapping, grant and epoch write back when observation expires during the transaction', async () => {
    const value = await registered(), next = await replacementSetup(value), id = value.record.intent.id;
    await pool.query(`CREATE FUNCTION delay_recovery_mapping() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.activation IS NOT NULL THEN PERFORM pg_sleep(1.1); END IF; RETURN NEW; END $$;
      CREATE TRIGGER delay_recovery_mapping AFTER UPDATE ON rest_wallet_recoveries FOR EACH ROW EXECUTE FUNCTION delay_recovery_mapping()`);
    try {
      const short = new PostgresWalletRecoveryStore(pool, policy, { audience: policy.origin, observe: context => observe(context, 1000) });
      await expect(short.activate(id, value.begun.flowToken, next.assertion)).rejects.toMatchObject({ status: 410 });
      expect((await pool.query('SELECT credential_id,superseded_at FROM rest_wallet_credentials')).rows).toEqual([
        { credential_id: value.context.credential.credentialId, superseded_at: null }]);
      expect((await pool.query('SELECT authority_epoch,session_epoch FROM rest_wallet_authority')).rows[0]).toEqual({ authority_epoch: '1', session_epoch: '1' });
      expect((await pool.query('SELECT count(*)::int AS count FROM rest_bot_grants WHERE revoked_at IS NOT NULL')).rows[0].count).toBe(0);
      expect((await store.get(id, value.begun.flowToken))!.activation).toBeNull();
    } finally { await pool.query('DROP TRIGGER delay_recovery_mapping ON rest_wallet_recoveries; DROP FUNCTION delay_recovery_mapping()'); }
  });
  it('reserves account recovery capacity only after valid backup-wallet and replacement-passkey proofs', async () => {
    const context = await existing(), options = { ...policy, maxRecords: 10, maxAccountRecords: 1 };
    const a = new PostgresWalletRecoveryStore(pool, options), b = new PostgresWalletRecoveryStore(pool, options);
    await a.begin(context.accountId); await b.begin(context.accountId);
    const first = await registered(a, context), second = await registered(b, context);
    const wrong = { ...first.proof, backupSignature: '0x' + '00'.repeat(65) } as typeof first.proof;
    await expect(a.prove(first.record.intent.id, first.begun.flowToken, wrong)).rejects.toThrow();
    const results = await Promise.allSettled([a.prove(first.record.intent.id, first.begun.flowToken, first.proof),
      b.prove(second.record.intent.id, second.begun.flowToken, second.proof)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'WALLET_RECOVERY_LIMIT' } });
    const winner = results[0]!.status === 'fulfilled' ? first : second;
    expect((await b.prove(winner.record.intent.id, winner.begun.flowToken, winner.proof)).replayed).toBe(true);
    expect((await pool.query('SELECT count(*)::int AS count FROM rest_wallet_recoveries WHERE proof IS NOT NULL')).rows[0].count).toBe(1);
  });
  it('waits for the account before reclaiming recovery rows, avoiding a cycle with an owner operation', async () => {
    const context = await existing(), short = new PostgresWalletRecoveryStore(pool, { ...policy, lifetimeMs: 1000 });
    const expired = await short.begin(context.accountId);
    await pool.query('SELECT pg_sleep(GREATEST(0,($1-extract(epoch FROM clock_timestamp())*1000)/1000)+0.02)', [expired.record.intent.expiresAtMs]);
    const application = `recovery_order_${randomUUID()}`;
    const beginPool = new Pool({ connectionString, options: `-c search_path=${schema}`, application_name: application });
    const selected = new PostgresWalletRecoveryStore(beginPool, policy), locker = await pool.connect();
    const original = PostgresWalletAuthorityStore.prototype.loadContext;
    // A real account lock after the initial snapshot forces begin's transaction to wait.
    const snapshot = vi.spyOn(PostgresWalletAuthorityStore.prototype, 'loadContext').mockImplementationOnce(async function (this: PostgresWalletAuthorityStore, id) {
      const result = await original.call(this, id);
      await locker.query('BEGIN');
      await locker.query('SELECT id FROM rest_accounts WHERE id=$1 FOR UPDATE', [id]);
      return result;
    });
    const pending = selected.begin(context.accountId).then(value => ({ value }), error => ({ error }));
    try {
      const until = Date.now() + 5000;
      let waiting = false;
      while (!waiting && Date.now() < until) {
        waiting = (await pool.query("SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [application])).rowCount! > 0;
        if (!waiting) await pool.query('SELECT pg_sleep(0.005)');
      }
      expect(waiting).toBe(true);
      // The old cleanup-first implementation holds this row while waiting for our
      // account lock: an owner operation taking it next would form a deadlock.
      await expect(pool.query('SELECT id FROM rest_wallet_recoveries WHERE id=$1 FOR UPDATE NOWAIT', [expired.record.intent.id]))
        .resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await locker.query('ROLLBACK'); locker.release(); snapshot.mockRestore();
      const result = await pending;
      await beginPool.end();
      expect(result).not.toHaveProperty('error');
    }
    expect(await store.get(expired.record.intent.id, expired.flowToken)).toBeNull();
  }, 15000);
  it('reclaims expired unproved recoveries while preserving accepted proofs and their immutable history', async () => {
    const short = new PostgresWalletRecoveryStore(pool, { ...policy, lifetimeMs: 1200 });
    const accepted = await registered(short), receipt = await short.prove(accepted.record.intent.id, accepted.begun.flowToken, accepted.proof);
    const abandoned = await registered(short);
    await pool.query('SELECT pg_sleep(GREATEST(0,($1-extract(epoch FROM clock_timestamp())*1000)/1000)+0.02)', [abandoned.record.intent.expiresAtMs]);
    await short.begin(abandoned.context.accountId);
    expect(await short.get(abandoned.record.intent.id, abandoned.begun.flowToken)).toBeNull();
    expect(await short.prove(accepted.record.intent.id, accepted.begun.flowToken, accepted.proof)).toEqual({ ...receipt, replayed: true });
    await expect(pool.query('DELETE FROM rest_wallet_recoveries WHERE id=$1', [accepted.record.intent.id])).rejects.toMatchObject({ code: '23514' });
  });

});
