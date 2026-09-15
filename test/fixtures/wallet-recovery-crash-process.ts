import { Pool } from 'pg';
import { createRecoveryCrashRuntime, type RecoveryCrashConfiguration } from './wallet-recovery-crash-runtime.js';

type Setup = Parameters<ReturnType<typeof createRecoveryCrashRuntime>['service']['completeSetup']>[1];
async function main() {
  const schema = process.env.WALLET_RECOVERY_CRASH_SCHEMA, connectionString = process.env.TEST_DATABASE_URL;
  if (!schema || !/^rest_wallet_signup_[a-f0-9]{32}$/.test(schema) || !connectionString || !process.connected)
    throw new Error('FIXTURE_DISPOSABLE_SCHEMA_REQUIRED');
  const database = new URL(connectionString);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname)) throw new Error('FIXTURE_LOCAL_DATABASE_REQUIRED');
  const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000, query_timeout: 10000,
    options: `-c search_path=${schema} -c statement_timeout=10000 -c idle_in_transaction_session_timeout=10000` });
  const timeout = setTimeout(() => process.exit(2), 20_000);
  const disconnected = () => process.exit(2);
  process.once('disconnect', disconnected);
  const input = await new Promise<{ config: RecoveryCrashConfiguration; flowToken: string; setup: Setup }>(resolve => {
    process.once('message', resolve);
    process.send?.({ kind: 'ready' });
  });
  const runtime = createRecoveryCrashRuntime(pool, input.config, event => {
    // Synchronous termination is essential: yielding here could let activation commit.
    if (event.stage === 'setup' && event.outcome === 'committed') process.kill(process.pid, 'SIGKILL');
  });
  try {
    await runtime.service.completeSetup(input.flowToken, input.setup);
  } finally {
    await runtime.service.stop(); await pool.end(); clearTimeout(timeout);
    process.off('disconnect', disconnected);
    if (process.connected) process.disconnect();
  }
}
void main().catch(error => {
  // Error messages can contain connection strings, tokens or provider responses.
  // Report only bounded codes or the two static local-guard diagnostics.
  const guard = error instanceof Error && ['FIXTURE_DISPOSABLE_SCHEMA_REQUIRED', 'FIXTURE_LOCAL_DATABASE_REQUIRED'].includes(error.message)
    ? error.message : null;
  const code = error && typeof error.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : guard ?? 'FIXTURE_ERROR';
  process.stderr.write(`Recovery crash fixture failed: ${code}.\n`); process.exit(1);
});
