import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashTypedData } from 'viem';
import { PostgresWalletRecoveryStore } from '../src/rest/wallet/recoveryPostgres.js';
import { PostgresWalletAuthorityStore } from '../src/rest/wallet/authorityPostgres.js';
import { enrollmentDigest } from '../src/rest/wallet/enrollment.js';
import { walletRecoveryDocument } from '../src/rest/wallet/recovery.js';
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
      '013_rest_wallet_ceremonies.sql', '014_rest_passkey_onboarding.sql', '015_rest_wallet_enrollment.sql',
      '017_rest_wallet_policy.sql', '019_rest_wallet_app_grants.sql', '020_rest_wallet_authority.sql', '028_wallet_recovery.sql'])
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
  async function registered(selected = store) {
    const context = await existing(), begun = await selected.begin(context.accountId), intent = begun.record.intent;
    const key = createRegistration({ rpId: intent.rpId, origin: intent.origin, userHandle: intent.userHandle,
      challenge: `0x${Buffer.from(intent.registration.challenge, 'base64url').toString('hex')}` });
    const record = await selected.register(intent.id, begun.flowToken, key.response);
    const document = walletRecoveryDocument(record.candidate!);
    const proof = { assertion: signGet({ ...key, rpId: intent.rpId, origin: intent.origin, challenge: hashTypedData(document) }),
      backupSignature: await signBackupProof(document) };
    return { context, begun, key, record, proof };
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
  it('enforces account and global admission caps across replicas', async () => {
    const context = await existing(), options = { ...policy, maxRecords: 3, maxAccountRecords: 2 };
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => new PostgresWalletRecoveryStore(pool, options).begin(context.accountId)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2);
    const second = await existing(); await new PostgresWalletRecoveryStore(pool, options).begin(second.accountId);
    await expect(new PostgresWalletRecoveryStore(pool, options).begin(second.accountId)).rejects.toMatchObject({ status: 429 });
    expect((await pool.query('SELECT count(*)::int AS count FROM rest_wallet_recoveries')).rows[0].count).toBe(3);
  });
});
