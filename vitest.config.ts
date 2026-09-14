import { defineConfig } from "vitest/config";

// Each integration file can start PostgreSQL, EVM and browser workers. Bound
// simultaneous fixtures; pressure suites retain their own explicit concurrency.
// Runner and UI-poll budgets cover multi-step integration work. Operation, RPC,
// SQL, lease and measured pressure deadlines remain independently enforced.
// The nested MCP package owns its own pinned runner and test command.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], maxWorkers: 4,
  testTimeout: 30_000, expect: { poll: { timeout: 8_000 } } } });
