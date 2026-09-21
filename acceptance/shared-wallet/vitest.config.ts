import { defineConfig } from 'vitest/config';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// This explicit cross-repository acceptance run needs actual built clients. The
// normal Center release gate retains all its required service tests unchanged.
const beep = process.env.BEEP_PILOT_ROOT, origin = process.env.HOMERUN_PILOT_ORIGIN;
if (!beep || !isAbsolute(beep) || !origin || !process.env.TEST_DATABASE_URL)
  throw new Error('Set BEEP_PILOT_ROOT, HOMERUN_PILOT_ORIGIN and TEST_DATABASE_URL for the local client acceptance run.');
const parsed = new URL(origin);
if (parsed.origin !== origin || parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))
  throw new Error('Homerun acceptance requires an explicit loopback HTTP origin.');
export default defineConfig({
  resolve: { alias: { '@center': fileURLToPath(new URL('../../', import.meta.url)), '@beep': beep } },
  test: { include: ['acceptance/shared-wallet/clients.test.ts'], testTimeout: 90000, hookTimeout: 30000 },
});
