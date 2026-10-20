import { defineConfig } from 'vitest/config';

// This nested package owns its test suite independently of the Center host.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // ponytail: integration tests build the whole server (catalog, knowledge); under a full parallel
    // run that alone can pass vitest's 5 s default, so the limit covers startup on a loaded machine.
    testTimeout: 30_000,
    ...(process.env.CENTER_MCP_REPORT
      ? {
          reporters: ['default', 'json'],
          outputFile: { json: process.env.CENTER_MCP_REPORT },
        }
      : {}),
  },
});
