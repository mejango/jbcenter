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
- [x] Remove account source/build/migrations/tests/docs and use shared SDK evidence verifier.
- [ ] Verify retained protocol, intent sponsor, MCP, PostgreSQL and production build.
- [ ] Review exact diff and document results.

## Progress review
- Protocol-only runtime/public routes, build/docs, account code and fresh account migrations removed. Existing inert account migration records are tolerated without dropping live tables.
- Shared REST budget is PostgreSQL-backed 10,000 requests/minute; no proxy-peer or forwarded-header identity assumption. Independent intent sponsorship and its source/Anvil checks remain.
- Focused independent verification: 35 tests passed (release check harness, protocol RPC rejection, production monitor, Relayr source equivalence). New public API checks passed before SDK extraction; full service/MCP/build check awaits packed SDK and disposable PostgreSQL 16.
- SDK verifier replacement must be validated against the current Center baseline, including its newer omnichain/ERC20/metadata operation outcomes, not only older Signa behavior.

## SDK compatibility refinement
- The packed SDK advances Center from 3.5.2 to reviewed candidate 6.3.1: active buyback quote failures now refuse preparation. Preserve that safety behavior, update stale fixtures to provide successful quote data, and test explicit failures without relaxing economic minima.
- Refresh SDK development source references using the existing bounded snapshot owner; preserve all app snapshots and their provenance. The final released SDK version and dependency lock pin remain a release prerequisite.
- Restore exact locked dependencies after staging install drift, then overlay only the reviewed SDK artifact. Repeat full pinned Node 22, PostgreSQL 16 release check after these changes.

- Full gate at 64e0933: MCP 559/559, host typecheck, and 927/928 service tests passed; sole failure was the fresh-build subprocess reaching its existing 75 second timeout. Investigate measured build duration/diagnostics, retain a finite timeout, then repeat the gate. Independent review confirmed safe SDK error mapping and exact snapshot provenance; correcting one stale payment journey sentence before the next gate.

- Build investigation: real production build passed in 79.89 seconds, confirming the 75 second fixture deadline was too short under concurrent consumer checks. The fixture now reuses bounded release subprocess logging/cleanup with 180 second child and 210 second test limits; focused fixture passed in 67.05 seconds. Waiting for an exclusive service-check slot before repeating the full gate.
- Candidate validation uses exact locked dependencies with only the reviewed SDK package overlaid. SDK artifact SHA256: 5adece602aa42704a11b1be1883853f05609be5e7e6d7a63c7a1caa03e1ce8b0. Manifests still pin 3.5.2; publishing and pinning the intended SDK release is a prerequisite for clean deployment installation, not claimed by these local artifact checks.
