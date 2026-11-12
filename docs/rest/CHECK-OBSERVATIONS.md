# Check observations

Run `npm run check:preflight` with the pinned Node.js 26.13.1 runtime and `TEST_DATABASE_URL` set to a disposable PostgreSQL 16 database. Preflight verifies connectivity, server version and schema permissions without printing the connection string. Focused `npm test -- test/<file>.test.ts` remains usable without PostgreSQL; skipped integration suites do not establish release readiness.

`npm run check` verifies the retained Center protocol service, MCP, publication, sponsor and database behavior, then builds the application. Account, passkey and generic wallet execution suites belong to Signa and are no longer Center release requirements.

Retained Relayr payment checks execute bytecode on local Anvil and reproduce its executable bytes with the pinned cached Solidity compiler. Documentation browser tests require Playwright Chromium. See the CI workflow for exact tool installation; account removal does not remove these protocol checks.

The release runner records its source revision, source attribution, step results and test observations. A completed successful report is required for a release claim. A successful preflight establishes prerequisites only; a running or interrupted report is incomplete. Source changes during a check require a rerun against the final source.

Use focused failures to guide repairs, then run the full retained release gate. Local deterministic checks do not establish provider availability, production deployment success or completed sponsored transactions. See [production operations](PRODUCTION_OPERATIONS.md).
