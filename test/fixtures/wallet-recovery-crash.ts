import { fork } from 'node:child_process';
import type { Pool } from 'pg';
import type { Address, Hex } from 'viem';
import { expect } from 'vitest';
import { createRecoveryCrashRuntime, type RecoveryCrashConfiguration } from './wallet-recovery-crash-runtime.js';
import { signGet, signBackupProof, type createRegistration } from './wallet-enrollment-crypto.js';

/** No activation rows or accepted proofs are fabricated. Kill the real service after
 * its onboarding COMMIT, lose its continuation, and resume with fresh service instances. */
export async function exerciseRecoverySetupCrash(input: {
  pool: Pool; config: RecoveryCrashConfiguration; recoveryId: string; flowToken: string; accountId: string;
  replacement: ReturnType<typeof createRegistration>; priorCredentialId: string; initializerHash: Hex; replacementSigner: Address;
  relayAddress: Address; rpc: <T = unknown>(method: string, params?: readonly unknown[]) => Promise<T>;
}) {
  const { pool, config, accountId, recoveryId } = input;
  const original = createRecoveryCrashRuntime(pool, config);
  expect((await original.service.status(input.flowToken)).phase).toBe('awaiting_activation');
  const queryRows = async (table: string) => (await pool.query(`SELECT * FROM ${table} WHERE account_id=$1 ORDER BY 1,2`, [accountId])).rows;
  const binding = async () => (await queryRows('rest_smart_account_bindings'))[0];
  const before = await binding();
  const authorityBefore = await queryRows('rest_wallet_authority');
  const beforeGrantCount = (await queryRows('rest_bot_grants')).length;
  const beforeNonceCount = (await queryRows('rest_smart_account_binding_nonces')).length;
  const transactions = async () => (await pool.query('SELECT * FROM rest_wallet_recovery_transactions WHERE recovery_id=$1 ORDER BY step', [recoveryId])).rows;
  const dispatchHistory = await transactions();
  const relayNonce = await input.rpc<Hex>('eth_getTransactionCount', [input.relayAddress, 'pending']);
  await original.service.stop();
  const schema = String((await pool.query('SELECT current_schema() AS schema')).rows[0].schema);
  const child = fork(new URL('./wallet-recovery-crash-process.ts', import.meta.url), [], {
    execArgv: ['--import', 'tsx'], serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { PATH: process.env.PATH, TEST_DATABASE_URL: process.env.TEST_DATABASE_URL, WALLET_RECOVERY_CRASH_SCHEMA: schema },
  });
  let timedOut = false, diagnostic = '';
  child.stderr?.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(0, 512); });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 25_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    let ipcFailed = false;
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (ipcFailed) reject(new Error('Recovery fixture IPC failed')); else resolve({ code, signal });
    });
    child.once('message', message => {
      if (!message || typeof message !== 'object' || !('kind' in message) || message.kind !== 'ready') {
        ipcFailed = true; child.kill('SIGKILL'); return;
      }
      child.send({ config, flowToken: input.flowToken }, error => {
        if (error) { ipcFailed = true; child.kill('SIGKILL'); }
      });
    });
  });
  expect(timedOut).toBe(false);
  expect(result, diagnostic).toEqual({ code: null, signal: 'SIGKILL' });
  expect(await queryRows('rest_wallet_authority')).toEqual(authorityBefore);
  const halfBinding = await binding();
  expect(halfBinding.id).toBe(before.id);
  // The replacement binding's consent is the recovery proof itself; no grant was created.
  const proofDigest = `0x${(await original.recoveries.get(recoveryId, input.flowToken))!.proof!.verificationDigest}`;
  expect(halfBinding.authorization_digest).toBe(proofDigest);
  expect(halfBinding.authorization_digest).not.toBe(before.authorization_digest);
  const grants = await queryRows('rest_bot_grants'), nonces = await queryRows('rest_smart_account_binding_nonces');
  expect(grants).toHaveLength(beforeGrantCount);
  expect(nonces).toHaveLength(beforeNonceCount + 1);
  const credentials = (await pool.query('SELECT credential_id,superseded_at FROM rest_wallet_credentials WHERE account_id=$1', [accountId])).rows;
  // Mid-recovery the primary is still live and unsuperseded; device passkeys, if any, stay live beside it.
  expect(credentials.filter(row => row.credential_id === input.priorCredentialId)).toEqual([{ credential_id: input.priorCredentialId, superseded_at: null }]);
  expect(credentials.every(row => row.superseded_at === null)).toBe(true);
  const events: string[] = [];
  const fresh = createRecoveryCrashRuntime(pool, config, event => events.push(`${event.stage}:${event.outcome}`));
  try {
    expect((await fresh.recoveries.get(recoveryId, input.flowToken))!.activation).toBeNull();
    expect((await fresh.service.status(input.flowToken)).phase).toBe('awaiting_activation');
    const resume = await fresh.service.beginResume(recoveryId);
    const resumed = await fresh.service.completeResume({ resumeId: resume.challenge.id, resumeToken: resume.resumeToken,
      assertion: signGet({ ...input.replacement, rpId: config.rpId, origin: config.origin, challenge: resume.challenge.challenge }),
      backupSignature: await signBackupProof(resume.challenge.document) });
    expect(resumed.replayed).toBe(false);
    expect(resumed.flowToken).not.toBe(input.flowToken);
    await expect(fresh.service.status(input.flowToken)).rejects.toThrow();
    expect((await fresh.service.activate(resumed.flowToken)).phase).toBe('preparing_sign_in');
    expect(await binding()).toEqual(halfBinding);
    expect(await queryRows('rest_bot_grants')).toHaveLength(beforeGrantCount);
    expect(events).toEqual(['setup:committed', 'activation:committed']);
    expect(await queryRows('rest_smart_account_binding_nonces')).toEqual(nonces);
    expect(await transactions()).toEqual(dispatchHistory);
    expect(await input.rpc('eth_getTransactionCount', [input.relayAddress, 'pending'])).toBe(relayNonce);
    const activated = await fresh.recoveries.activate(recoveryId, resumed.flowToken, null);
    expect(activated.replayed).toBe(true);
    expect((await fresh.service.activate(resumed.flowToken)).phase).toBe('preparing_sign_in');
    expect(events).toEqual(['setup:committed', 'activation:committed', 'activation:committed']);
    expect(await transactions()).toEqual(dispatchHistory);
    expect(await input.rpc('eth_getTransactionCount', [input.relayAddress, 'pending'])).toBe(relayNonce);
    return { activated, flowToken: resumed.flowToken, crashObservation: {
      childExit: result, timedOut, events,
      grants: { before: beforeGrantCount, afterCommit: grants.length, afterResume: (await queryRows('rest_bot_grants')).length },
      bindingNonces: { before: beforeNonceCount, afterCommit: nonces.length, afterResume: (await queryRows('rest_smart_account_binding_nonces')).length },
      relayNonce: { before: relayNonce, after: await input.rpc('eth_getTransactionCount', [input.relayAddress, 'pending']) },
      rotationTransactions: { before: dispatchHistory.map(row => row.hash), after: (await transactions()).map(row => row.hash) },
    } };
  } finally { await fresh.service.stop(); }
}
