# Center protocol-only cleanup

Shared resources: /Users/jango/Documents/jb/v6/evm/AGENTS.md, /Users/jango/Documents/jb/v6/evm/workflow/ponytail/SKILL.md and README.md, /Users/jango/Documents/jb/v6/evm/docs/PLAN_REFINEMENT.md, root tasks/lessons.md. Local AGENTS.md and mcp/AGENTS.md apply.

## Plan refinement
- **Objective:** Remove all Center account runtime, routes, workers and build dependencies, retaining protocol reads/preparation, intents, IPFS, RPC, MCP and independently authorized intent sponsorship. No account-history migration.
- **System fit:** Center prepares unsigned drafts and canonical evidence; Signa owns account approval/execution/recovery. Apps already use Signa except separate planned jbm/revnet/juicescan transitions. No live configuration, deployment, database deletion or merge.
- **Reuse and simplicity:** Reuse existing operation registry, catalog, read/indexer/omnichain services and quotas. Replace inherited MCP outcome checking with existing SDK ownership, delete account-only source rather than disable it.
- **Evidence and unknowns:** Current origin/main a49ab0a constructs accounts inside rest/runtime.ts. New handoff POST /api/v1/plans accepts operation,input,optional canonical at and returns data:RestPlanDraft. GET /catalog/operations returns data:operations metadata. Production availability unverified.
- **Verification:** Protocol route/API bounds, canonical evidence, safe preparation and removed account endpoints; typecheck/build, retained protocol/intent/sponsor/MCP tests and PostgreSQL integration. Remove fresh account migrations without dropping any existing live tables.
- **Resource budget:** Delegate independent API, build/docs, and SDK-verifier work with disjoint ownership. Keep main integration/pruning work bounded and retain meaningful existing coverage; replan on dependency incompatibility.

- [x] Separate protocol REST runtime and public API from account services.
- [ ] Remove account source/build/migrations/tests/docs and use shared SDK evidence verifier.
- [ ] Verify retained protocol, intent sponsor, MCP, PostgreSQL and production build.
- [ ] Review exact diff and document results.

## Progress review
- Protocol-only runtime/public routes, build/docs, account code and fresh account migrations removed. Existing inert account migration records are tolerated without dropping live tables.
- Shared REST budget is PostgreSQL-backed 10,000 requests/minute; no proxy-peer or forwarded-header identity assumption. Independent intent sponsorship and its source/Anvil checks remain.
- Focused independent verification: 35 tests passed (release check harness, protocol RPC rejection, production monitor, Relayr source equivalence). New public API checks passed before SDK extraction; full service/MCP/build check awaits packed SDK and disposable PostgreSQL16.
- SDK verifier replacement must be validated against the current Center baseline, including its newer omnichain/ERC20/metadata operation outcomes, not only older Signa behavior.
