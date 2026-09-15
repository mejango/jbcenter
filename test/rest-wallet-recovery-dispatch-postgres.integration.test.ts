import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashTypedData, keccak256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletAuthorityContextFixture } from './fixtures/wallet-authority-context.js';
import { createRegistration, signBackupProof, signGet } from './fixtures/wallet-enrollment-crypto.js';
import { enrollmentDigest } from '../src/rest/wallet/enrollment.js';
import { createWalletRecoveryIntent, prepareWalletRecoveryCandidate, verifyWalletRecoveryProof, walletRecoveryDocument } from '../src/rest/wallet/recovery.js';
import { prepareWalletRecoveryRotation } from '../src/rest/wallet/recoveryRotation.js';
import { createLocalAnvilWalletRecovery } from '../src/rest/wallet/recoveryLocalAnvil.js';

const connectionString = process.env.TEST_DATABASE_URL, suite = connectionString ? describe : describe.skip;
suite('recovery dispatch durable liabilities (database history, no canonical-chain claim)', () => {
  const schema = `recovery_dispatch_${randomUUID().replaceAll('-', '')}`;
  const sender = privateKeyToAccount(`0x${'33'.repeat(32)}`).address.toLowerCase(), hash = `0x${'55'.repeat(32)}`;
  const configuration = { version: 'unforked-anvil-recovery-v1', sender, maximumOperations: 2, maximumCostWei: '1000000000000000000' };
  const environment = { kind: 'unforked-anvil', genesisHash: hash, instanceId: hash };
  const anchor = { chainId: 8453, blockNumber: '100', blockHash: hash, timestamp: '1700000000', source: 'onchain' };
  let admin: Pool, pool: Pool;
  beforeAll(async () => {
    admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 5 });
    for (const name of ['004_rest_accounts.sql', '007_rest_smart_accounts.sql', '012_rest_smart_account_onboarding.sql',
      '013_rest_wallet_ceremonies.sql', '014_rest_passkey_onboarding.sql', '042_wallet_binding_consent.sql', '015_rest_wallet_enrollment.sql', '041_wallet_passkey_name.sql', '016_rest_wallet_deployments.sql', '036_wallet_deployment_approval_v2.sql',
      '017_rest_wallet_policy.sql', '019_rest_wallet_app_grants.sql', '020_rest_wallet_authority.sql', '039_wallet_authority_window.sql', '028_wallet_recovery.sql',
      '029_wallet_recovery_mapping.sql', '033_wallet_unproved_recovery_expiry.sql', '030_wallet_recovery_flow.sql', '031_wallet_recovery_dispatch.sql', '035_wallet_recovery_base.sql'])
      await pool.query(await readFile(new URL(`../src/db/migrations/${name}`, import.meta.url), 'utf8'));
  });
  beforeEach(async () => { await pool.query('TRUNCATE rest_accounts,rest_wallet_enrollments,rest_wallet_ceremonies,rest_wallet_recovery_lanes CASCADE'); });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } });
  async function accepted() {
    const now = Date.now(), context = await createWalletAuthorityContextFixture(now), e = context.enrollment, c = context.credential;
    await pool.query(`INSERT INTO rest_accounts(id,owner_address,authority_chain_id,display_name,bio,created_at,updated_at)
      VALUES($1,$2,8453,'','',$3,$3)`, [context.accountId, context.accountId.slice(12), Math.floor(e.createdAt / 1000)]);
    await pool.query(`INSERT INTO rest_wallet_enrollments(id,user_handle,state,intent_digest,created_at,expires_at,retain_until,
      intent,candidate,candidate_digest,creation,possession,safe_address,account_id,verified_at,receipt)
      VALUES($1,$2,'verified',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [e.intent.id, e.intent.userHandle, enrollmentDigest(e.intent), e.createdAt, e.intent.expiresAt, e.intent.expiresAt + 86400000,
      e.intent, e.candidate, e.candidateDigest, e.creation, e.possession, e.creation!.address.toLowerCase(), context.accountId, c.verifiedAtMs, e.receipt]);
    const intent = createWalletRecoveryIntent(context, { rpId: e.intent.rpId, origin: e.intent.origin, nowMs: now, expiresAtMs: now + 300000 });
    const key = createRegistration({ rpId: intent.rpId, origin: intent.origin, userHandle: intent.userHandle,
      challenge: `0x${Buffer.from(intent.registration.challenge, 'base64url').toString('hex')}` });
    const candidate = prepareWalletRecoveryCandidate(intent, key.response), document = walletRecoveryDocument(candidate);
    const proof = await verifyWalletRecoveryProof(candidate, { assertion: signGet({ ...key, rpId: intent.rpId, origin: intent.origin, challenge: hashTypedData(document) }),
      backupSignature: await signBackupProof(document) }, Date.now());
    await pool.query(`INSERT INTO rest_wallet_recoveries(id,account_id,enrollment_id,token_hash,created_at_ms,expires_at_ms,retain_until_ms,intent,candidate,proof)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [intent.id, intent.accountId, intent.enrollmentId, enrollmentDigest(intent), now, intent.expiresAtMs,
      intent.expiresAtMs + 86400000, intent, candidate, proof]);
    return { intent, candidate, review: prepareWalletRecoveryRotation(candidate, { owners: context.binding.state.owners,
      threshold: context.binding.state.threshold, safeNonce: context.binding.state.safeNonce }) };
  }
  async function retained() {
    const value = await accepted(), id = value.intent.id;
    await pool.query('INSERT INTO rest_wallet_recovery_lanes(sender,configuration,environment,next_nonce,anchor) VALUES($1,$2,$3,0,$4)', [sender, configuration, environment, anchor]);
    await pool.query('INSERT INTO rest_wallet_recovery_dispatch(recovery_id,sender,review,creation_transaction,created_at_ms) VALUES($1,$2,$3,$4,$5)',
      [id, sender, value.review, hash, Date.now()]);
    await pool.query('UPDATE rest_wallet_recovery_dispatch SET approval=$2,approved_at_ms=$3 WHERE recovery_id=$1', [id, { exactApprovalFixture: true }, Date.now()]);
    await pool.query('UPDATE rest_wallet_recovery_lanes SET next_nonce=2,operations=1,reserved_wei=120000000000000000,active_recovery=$2 WHERE sender=$1', [sender, id]);
    const raw = '0x02aabb' as Hex;
    await pool.query('INSERT INTO rest_wallet_recovery_transactions(recovery_id,step,sender,nonce,hash,raw_transaction) VALUES($1,0,$2,0,$3,$4)', [id, sender, keccak256(raw), raw]);
    return value;
  }
  it('retains the first approval, exact bytes, nonce and pre-network attempt across retries and crashes', async () => {
    const { intent } = await retained(), id = intent.id;
    const attempts = await Promise.all(Array.from({ length: 8 }, () => pool.query(`UPDATE rest_wallet_recovery_transactions SET attempted_at_ms=$2
      WHERE recovery_id=$1 AND step=0 AND attempted_at_ms IS NULL RETURNING hash`, [id, Date.now()])));
    expect(attempts.reduce((total, value) => total + value.rowCount!, 0)).toBe(1);
    const before = (await pool.query('SELECT * FROM rest_wallet_recovery_transactions')).rows;
    for (const sql of ["UPDATE rest_wallet_recovery_transactions SET attempted_at_ms=NULL", "UPDATE rest_wallet_recovery_transactions SET raw_transaction='0x02bbbb'",
      'UPDATE rest_wallet_recovery_transactions SET nonce=1', 'DELETE FROM rest_wallet_recovery_transactions', 'DELETE FROM rest_wallet_recovery_dispatch',
      "UPDATE rest_wallet_recovery_dispatch SET approval='{}'", "UPDATE rest_wallet_recovery_dispatch SET review=jsonb_set(review,'{safeNonce}','\"7\"')"])
      await expect(pool.query(sql)).rejects.toMatchObject({ code: '23514' });
    expect((await pool.query('SELECT * FROM rest_wallet_recovery_transactions')).rows).toEqual(before);
    await expect(pool.query('INSERT INTO rest_wallet_recovery_transactions(recovery_id,step,sender,nonce,hash,raw_transaction) VALUES($1,1,$2,0,$3,$4)',
      [id, sender, `0x${'66'.repeat(32)}`, '0x02bbbb'])).rejects.toMatchObject({ code: '23505' });
  });
  it('keeps fee reservations, environment fences and receipt anchors monotonic', async () => {
    await retained();
    await pool.query("UPDATE rest_wallet_recovery_transactions SET attempted_at_ms=1700000000000,receipt=$1", [{ block: anchor, status: 'success', executionWei: '100' }]);
    await pool.query("UPDATE rest_wallet_recovery_lanes SET fence='local-environment-changed'");
    for (const sql of ['UPDATE rest_wallet_recovery_lanes SET next_nonce=0', 'UPDATE rest_wallet_recovery_lanes SET reserved_wei=0',
      'UPDATE rest_wallet_recovery_lanes SET operations=0', 'UPDATE rest_wallet_recovery_lanes SET operations=3', 'UPDATE rest_wallet_recovery_lanes SET fence=NULL',
      "UPDATE rest_wallet_recovery_lanes SET environment='{}'", "UPDATE rest_wallet_recovery_lanes SET anchor=jsonb_set(anchor,'{blockNumber}','\"99\"')",
      'UPDATE rest_wallet_recovery_transactions SET receipt=NULL', 'DELETE FROM rest_wallet_recovery_lanes'])
      await expect(pool.query(sql)).rejects.toMatchObject({ code: '23514' });
    expect((await pool.query('SELECT next_nonce,operations,reserved_wei,fence FROM rest_wallet_recovery_lanes')).rows).toEqual([
      { next_nonce: '2', operations: 1, reserved_wei: '120000000000000000', fence: 'local-environment-changed' }]);
  });
  it('rejects an unaccepted review, preapproved insertion and a premarked broadcast attempt', async () => {
    const value = await accepted();
    await pool.query('INSERT INTO rest_wallet_recovery_lanes(sender,configuration,environment,next_nonce,anchor) VALUES($1,$2,$3,0,$4)', [sender, configuration, environment, anchor]);
    await expect(pool.query('INSERT INTO rest_wallet_recovery_dispatch(recovery_id,sender,review,creation_transaction,created_at_ms) VALUES($1,$2,$3,$4,$5)',
      [value.intent.id, sender, { ...value.review, candidateDigest: '11'.repeat(32) }, hash, Date.now()])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`INSERT INTO rest_wallet_recovery_dispatch(recovery_id,sender,review,creation_transaction,created_at_ms,approval,approved_at_ms)
      VALUES($1,$2,$3,$4,$5,'{}',$5)`, [value.intent.id, sender, value.review, hash, Date.now()])).rejects.toMatchObject({ code: '23514' });
    await pool.query('INSERT INTO rest_wallet_recovery_dispatch(recovery_id,sender,review,creation_transaction,created_at_ms) VALUES($1,$2,$3,$4,$5)',
      [value.intent.id, sender, value.review, hash, Date.now()]);
    await expect(pool.query('INSERT INTO rest_wallet_recovery_transactions(recovery_id,step,sender,nonce,hash,raw_transaction) VALUES($1,0,$2,0,$3,$4)',
      [value.intent.id, sender, hash, '0x02bbbb'])).rejects.toMatchObject({ code: '23514' });
  });
  it('rejects public/DNS endpoints before any database or provider access', async () => {
    const context = await createWalletAuthorityContextFixture(Date.now()), manifest = context.enrollment.intent.manifest;
    for (const endpoint of ['https://mainnet.base.org', 'http://localhost:8545', 'http://127.0.0.1.example.org:8545', 'http://2130706433:8545', 'http://127.0.0.1:8545/?x=1'])
      expect(() => createLocalAnvilWalletRecovery({ pool, endpoint, expectedGenesisHash: hash as Hex, signer: privateKeyToAccount(`0x${'33'.repeat(32)}`),
        manifest, utility: manifest.safe7579, maximumOperations: 1, maximumCostWei: '1000000000000000000' })).toThrow();
  });
});
