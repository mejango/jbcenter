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
- [x] Verify retained protocol, intent sponsor, MCP, PostgreSQL and production build.
- [x] Review exact diff and document results.

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

## Final review
- Full release gate passed at clean revision `08d7323194f0fadbeb4746af3a4dc9d42d5822ee`, using Node 22.23.4, PostgreSQL 16 and two Vitest workers. All 559 MCP tests and 928 service tests passed with no skips; formatting, both typechecks, catalog checks and production build passed.
- Evidence: `.generated/checks/2026-11-11T18-26-23.252Z-27acd7ca/summary.json`. Start/end source fingerprint matched `d31c6eb8e3bacd219a3b6aa574cc43a98851330f5109b2e37146f118084493ff`; the source remained clean and unchanged throughout. The final clean-build fixture completed in 52.79 seconds.
- Independent reviews confirmed public request bounds/shared quotas, removal of account startup/routes, retained sponsor source/Anvil verification, safe SDK error mapping and source snapshot provenance. `git diff --check` passed. This final journal update changes no executable code.
- The review branch depends on https://github.com/Bananapus/juice-sdk-v4/pull/302. The final registry version and dependency locks must be updated after that SDK release; a clean install of the current manifest cannot resolve the new verifier export. Local packed-artifact proof does not claim registry-install or deployment readiness.
- No deployment, publication, merge or live database change was performed. The branch/PR workflow only tests and builds; the separate production workflow performs scheduled/manual health checks.

## Independent Node 26 compatibility evaluation
- Evaluated unchanged source `f07e44ca42e47f016c59ab018565ee400e4b2702` with the verified official Darwin arm64 Node 26.13.1 binary and bundled npm 11.20.0, the same reviewed SDK candidate/dependency tree, disposable PostgreSQL 16 and normal configured worker bounds. This was independent compatibility evidence, not a new SDK publication gate. No runtime pin, default, test or deadline changed.
- The complete run passed MCP formatting/types/catalog/build and all 559 MCP tests, plus the host typecheck and 927 of 928 service tests. The exhaustive synchronous indexer-filter test completed in 34.345 seconds and exceeded its existing 30-second limit; the run failed and did not reach its final standalone build stage. The clean-build fixture passed in 81.9 seconds. Preserve this failed aggregate result: `.generated/checks/2026-11-11T21-06-28.940Z-e5b40ec3/summary.json`.
- A focused rerun of that exact filter test passed in 11.25 seconds under its original 30-second limit (288 unrelated tests intentionally unselected). The existing production build then passed in 18.109 seconds using the release runner's unchanged 600-second bound. Focused log: `/private/tmp/center-node26-indexer-focused.log`; build evidence: `/private/tmp/center-node26-build-evidence/summary.json`.
- Full-run and standalone-build source snapshots were clean and unchanged, fingerprint `5fe1fe28cfc1034a2f3901c475f863edae640939f141ad67fb54aad562bd4404`. These results do not constitute a fully green single Node 26 run or Linux-container proof. Runtime pinning, production-container verification, and the actual published SDK registry pin/clean-install gate remain separate prerequisites.


## Published SDK dependency completion (2026-11-12)
## Plan refinement
- **Objective:** Make Center installable against the verified public core6.4.0 release, preserving protocol-only cleanup and leaving service deployment/main merge outside scope.
- **System fit:** SDK release commit7fce09a6c765c516ff3a67369e2c567bbb3b09aa and registry provenance establish the portable verifier owner. Exact manifest/registry locks and source references connect Center to that release; clean installation and the existing full gate verify the actual artifact before updating draftPR97. Signa identity/execution and existing app references are unaffected.
- **Reuse and simplicity:** Update only MCP's exact core pin, both npm-generated lockfiles, and the28SDK references using existing bounded source-snapshot/bundle functions. Preserve all72app references and feature data byte-for-byte. Reuse required service/MCP checks and production audits; no new package, runtime pin, test scaffolding or authority change.
- **Evidence and unknowns:** Fresh official npm metadata confirms6.4.0, gitHead7fce09a,1931entries and integrity sha512-iGx7zPPm9Y1I55R4Ef/FzvO1nC9XCIDwPt6s6FNKygq5AXax+yLXnV9tw0azGXfjCs4b58vykIHjqdUOq4Ybww==. Clean releasecheckout is /Users/jango/Documents/jb/v6/evm/.worktrees/signa-only-sdk-release. Current Center885cf6d is clean; both locks still3.5.2, nested installed SDK is the reviewed candidate. Host load7.13/7.96/10.28 permits one bounded gate; PostgreSQL16 is already running under the root-owned fixture, so do not reinitialize it.
- **Verification:** Inspect minimal generated lock diffs against official metadata, refresh SDK provenance only, perform clean root/MCP npmci with Node22.23.4/npm10.9.9, verify installed SDK bytes/integrity, commit and freeze source, run npm run check with disposable PostgreSQL16/Anvil and bounded workers, then both production audits. Require all1487existing cases and unchanged source fingerprints; preserve failures and original deadlines. Docker verification remains unavailable locally and must not be claimed.
- **Resource budget:** Root grants Center the exclusive install/full-check slot before Signa. One clean-install/full-gate sequence, targeted diagnosis only if a real failure appears. No unrelated process changes, broad consumer reruns or optional Node26 work. Update only Center's journal and draft branch after evidence is complete.
- [x] Update exact registry pin/locks and SDK-only source references.
- [x] Clean install and verify the published artifact.
- [ ] Complete full required gate and both production audits on frozen source.
- [ ] Record evidence, review and update draftPR97.

### Published dependency and source verification
- Both npm-generated locks resolve exact core6.4.0 with the independently verified official integrity. npm10.9.9 dropped libc metadata for10unchanged packages perlock; their exact existing metadata was retained, and every non-SDK package entry remains identical. No unrelated version or graph changes.
- Root clean npmci installed209packages and MCP clean npmci installed166packages, both with ignore-scripts and Node22.23.4/npm10.9.9. Both installed SDK directories match all1931regular files of the verified published tarball, without extra files. Evidence: /private/tmp/center-published-sdk-install-verification.json.
- Refreshed28SDK references to clean publication commit7fce09a; all72app references and feature data are unchanged. Bundle5682767371e95ee0443dce848971b0ed29ea21655b253e6a3a691f52cbce1bb4. Independent read-only review found no actionable issues and git diff --check passed.

- Both production audits passed the required high-severity threshold. MCP reports0vulnerabilities; root reports one moderate @hono/node-server serveStatic advisory (GHSA-rmxm-3fg6-px4f) in the unchanged dependency. Center imports getRequestListener, with no serveStatic use in src/scripts. No claim of an advisory-free entire graph or unrelated major-version upgrade.
