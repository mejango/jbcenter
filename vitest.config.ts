import { defineConfig } from "vitest/config";

// The nested MCP package owns its own pinned runner and test command.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
