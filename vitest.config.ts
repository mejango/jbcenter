import { defineConfig } from "vitest/config";

// Each integration file can start PostgreSQL, EVM and browser workers. Bound
// simultaneous fixtures; pressure suites retain their own explicit concurrency.
// The nested MCP package owns its own pinned runner and test command.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], maxWorkers: 4 } });
