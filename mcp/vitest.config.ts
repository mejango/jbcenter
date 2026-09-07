import { defineConfig } from 'vitest/config';

// This nested package owns its test suite independently of the Center host.
export default defineConfig({ test: { include: ['tests/**/*.test.ts'] } });
