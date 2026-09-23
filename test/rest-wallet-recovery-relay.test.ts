import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createLocalAnvilWalletRecovery } from '../src/rest/wallet/recoveryLocalAnvil.js';
import { enrollmentBackupAccount, enrollmentManifest } from './fixtures/wallet-enrollment-crypto.js';

function fixture(unlockError?: Error) {
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (sql.startsWith('SET lock_timeout=') || sql === 'RESET lock_timeout') return { rows: [] };
      if (sql.includes('pg_advisory_lock')) return { rows: [{ pg_advisory_lock: null }] };
      if (sql.includes('pg_advisory_unlock')) {
        if (unlockError) throw unlockError;
        return { rows: [{ pg_advisory_unlock: true }] };
      }
      throw new Error('Unexpected database query');
    }),
    release: vi.fn(),
  };
  const relay = createLocalAnvilWalletRecovery({
    pool: { connect: async () => client } as unknown as Pool,
    endpoint: 'http://127.0.0.1:8545', expectedGenesisHash: `0x${'11'.repeat(32)}`,
    signer: enrollmentBackupAccount, manifest: enrollmentManifest, utility: enrollmentManifest.safe7579,
    maximumOperations: 1, maximumCostWei: '1000000000000000000',
  });
  return { relay, client };
}

describe('recovery relay connection cleanup', () => {
  it.each(['prepare', 'status'] as const)('unlocks and releases its connection when %s fails', async method => {
    const { relay, client } = fixture();
    await expect(relay[method]('invalid-id')).rejects.toMatchObject({ code: 'WALLET_RECOVERY_DISPATCH_CONFLICT' });
    expect(client.query).toHaveBeenCalledTimes(method === 'prepare' ? 4 : 2);
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
  });

  it.each(['prepare', 'status'] as const)('destroys the connection when advisory unlock fails after %s', async method => {
    const error = new Error('Unlock transport failed'), { relay, client } = fixture(error);
    await expect(relay[method]('invalid-id')).rejects.toBe(error);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });
});
