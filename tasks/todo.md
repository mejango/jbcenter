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
- [x] Complete full required gate and both production audits on frozen source.
- [x] Record evidence and prepare the reviewed draftPR97 update.

### Published dependency and source verification
- Both npm-generated locks resolve exact core6.4.0 with the independently verified official integrity. npm10.9.9 dropped libc metadata for10unchanged packages perlock; their exact existing metadata was retained, and every non-SDK package entry remains identical. No unrelated version or graph changes.
- Root clean npmci installed209packages and MCP clean npmci installed166packages, both with ignore-scripts and Node22.23.4/npm10.9.9. Both installed SDK directories match all1931regular files of the verified published tarball, without extra files. Evidence: /private/tmp/center-published-sdk-install-verification.json.
- Refreshed28SDK references to clean publication commit7fce09a; all72app references and feature data are unchanged. Bundle5682767371e95ee0443dce848971b0ed29ea21655b253e6a3a691f52cbce1bb4. Independent read-only review found no actionable issues and git diff --check passed.

- Both production audits passed the required high-severity threshold. MCP reports0vulnerabilities; root reports one moderate @hono/node-server serveStatic advisory (GHSA-rmxm-3fg6-px4f) in the unchanged dependency. Center imports getRequestListener, with no serveStatic use in src/scripts. No claim of an advisory-free entire graph or unrelated major-version upgrade.

### Published SDK final review
- Full required gate passed on clean source f7ec3ae0156e7f16d285a5ca90f7045fc6bf3094 with Node22.23.4/npm10.9.9 and the actual registry-installed core6.4.0:559MCPtests plus928service tests,1487total, zero skips. Formatting, both typechecks, catalog verification, fresh-build fixture and final production build passed. The normal configured worker bounds and every existing test/operation deadline were unchanged.
- Observation .generated/checks/2026-11-12T04-05-03.118Z-66f15bdd/summary.json spans82.9seconds. Start/end source fingerprints are identical:6e7d98e312d5bea559d34fac4875adc52426a3d026bedcd483512afed3e26167; source remained clean. Full log /private/tmp/center-published-sdk-full-check.log.
- The published dependency prerequisite is now satisfied, including exact locks, clean installation, both1931-file installed artifact comparisons and28clean SDK source references. Both production audits passed their required high threshold; the one unchanged moderate root advisory remains disclosed above.
- Independent small-diff review found no actionable issues. Current remote main remains a49ab0a and draftPR97 is mergeable. This journal update changes no executable source. Updating the existing draft branch/description triggers its normal CI, including Linux Dockerbuild; local evidence does not claim that separate container check.
- Existing Node22.23.4 runtime pin remains unchanged. A patched runtime and its deployment verification remain prerequisites before production. No service main merge, deployment or live database change was performed.


## Upgrade Center to Node 26.13.1 (2026-11-12)
## Plan refinement
- **Objective:** Apply the user's requested Node 26.13.1 runtime upgrade to Center's integrated and standalone MCP build paths, CI, production health workflow and active setup guidance; prepare a verified PR without merging or changing hosting.
- **System fit:** Current main 3bc1908 contains the merged protocol-only cleanup and published SDK 6.4.0 dependency. The official security release and verified Docker index establish the runtime inputs; exact CI/build pins and service engine/preflight floors enforce them; clean installs and the existing complete gates verify compatibility before the coordinator handles merge and hosting. Account authority and protocol behavior remain unchanged.
- **Reuse and simplicity:** Add one root .nvmrc used by both root workflows, retain the existing standalone MCP workflow with its exact version, and reuse one pinned base stage within each Dockerfile. Raise only the owning private package engine metadata and existing release runtime guard to 26.13.1; preserve all dependency versions, integrity values, tests and deadlines. No independently pinned npm release or new npm assertion exists or is needed; use the runtime's bundled npm 11.20.0.
- **Evidence and unknowns:** Fresh main and an empty worktree are verified. Official Node release notes identify 26.13.1 as a security release. Docker registry SHA256 verification at 12:12 UTC confirms the multiarch bookworm-slim index 5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 with Linux amd64, arm64 and ppc64le. Temporary verified Node reports 26.13.1 and bundled npm 11.20.0. The previous optional Node 26 assessment was incomplete; this task requires fresh complete evidence.
- **Verification:** Review every active runtime pin and engine metadata change; extend the existing guard check to reject 26.13.0 and accept 26.13.1 without weakening coverage. Clean-install both unchanged dependency graphs, run the normal full service/MCP gate with PostgreSQL 16 and Anvil on frozen source, and run both production audits. Normal GitHub CI must pass including Linux Docker build; verify the standalone MCP image separately through the existing Docker build capability when available. Do not infer deployed runtime behavior from a successful build.
- **Resource budget:** Center has the first exclusive local heavy-check slot; coordinate fixture startup and completion with root, then release the slot to Signa. Start only the existing stopped owned PostgreSQL cluster, never initialize or alter unrelated services. Use existing tests and gates, one bounded full run, no unrelated lock regeneration or runtime-global changes. Only this repository's journal is writable by this agent.
- [x] Update active runtime pins, engine floor and setup guidance.
- [x] Verify clean Node 26.13.1 installs and full required checks on frozen source.
- [x] Review and open the concrete runtime PR; monitor required CI before merge.

### Runtime update prepared
- Both Docker build contexts use the freshly verified multiarch Node 26.13.1 bookworm-slim digest, with one reused base stage per Dockerfile. Root CI builds both images. Root workflows read .nvmrc; the standalone MCP workflow is explicitly pinned. No npm override/assertion was introduced.
- Clean installs under the official temporary Node 26.13.1 distribution and bundled npm 11.20.0 completed: 209 root packages and 166 MCP packages. Lock comparison proves only the owning engine metadata changed; all dependency versions and integrity entries are unchanged. Evidence: /private/tmp/center-node26131-lock-inventory.json.
- Existing runtime guard coverage now includes the security-patch boundary and preserves missing-database refusal. Active setup docs use the requested runtime; prior verification reports remain historical evidence. Independent read-only review found no actionable issues, and git diff --check passed.
- The existing owned PostgreSQL 16 cluster was started with its unchanged local configuration on port 56416 for the coordinator-granted exclusive Center check slot. No cluster initialization or unrelated service change occurred.

### Node 26.13.1 verification review
- Full local gate passed on clean source 6f7ca211ece1f566fd3cf45ef01cde1f6dc97850, Node 26.13.1 and bundled npm 11.20.0: 559 MCP tests plus 928 service tests, 1,487 total, zero skips. Formatting, both typechecks, catalog verification, the fresh-build fixture and final production build passed with all original deadlines and worker bounds.
- Observation .generated/checks/2026-11-12T12-18-08.691Z-e93154fa/summary.json records 168.2 seconds and identical clean source fingerprints: 2937d4489e08bd54bf0cb07e9605d5ff055c87f30a7ebb45d55b12084ad8f9c1. Log: /private/tmp/center-node26131-full-check.log. The host had high unrelated load, but the complete run passed; no timing failure or partial run is being counted as success.
- Draft runtime PR: https://github.com/mejango/jbcenter/pull/98. This final journal commit changes no executable source. Its required GitHub CI verifies clean Linux installs, the full gate, both production audits and both changed Docker build contexts. Record terminal CI evidence in the PR description without another journal-only push.
- The local heavy-check slot is released. The owned PostgreSQL fixture remains available for the coordinator's subsequent checks. No main merge, hosting change or deployment occurred in this task.

## Make the home page a flat router (2026-11-12)
## Plan refinement
- **Objective:** jango wants juicebox.center to be the first link for any user, developer or agent question: few words, little content of its own, fast routing. Success: every destination is visible as one "need, destination" row without clicking through question cards, at phone and desktop widths, and agents get the same index as text.
- **System fit:** `src/directory.ts` stays the one owner of destinations. `src/homepage.ts` renders it as HTML, `src/llms.ts` renders the same sections as `/llms.txt`, and `/` answers `Accept: text/markdown` with that index. The question maps (`journeyGraph.ts`, `directoryClient.ts`, on-demand map files, their tests and build minification) are removed. API, MCP, IPFS, RPC and `/inspect` behavior are unaffected.
- **Reuse and simplicity:** Reuse the existing verified URLs, palette, hashed asset serving and CSP. Native anchors, CSS columns and `<details>`; no script. Inline RPC, IPFS and pinning manuals leave the page because the README sections they link already hold them. Net deletion.
- **Evidence and unknowns:** Live page screenshots (2,399px desktop, 4,124px phone, three clicks through question cards to reach an app, directory collapsed at the bottom). Old `#view/node` fragments will land at the top of the page; two references exist elsewhere in the workspace. Whether jango wants the maps kept is a preference, so this stays a PR until approved.
- **Verification:** New directory test (unique ids, valid URLs, no middots, unfinished tools only in their section, llms lists every destination), updated app, page-weight, asset-cache and build tests, `npm run check`, a one-time HTTP check of every destination, and screenshots at 1280 and 390.
- **Resource budget:** One worktree, one PR, one full check run. Replan if the release gate needs services that are unavailable locally.
- [x] Reshape `directory.ts` into sections and render the flat page
- [x] Generate `/llms.txt` from the same sections; markdown on `/` by Accept
- [x] Remove the journey maps, client script and their build and test hooks
- [x] Tests, link check, screenshots, README section

### Review
- `/` is one script-free page: six sections of "need, destination" rows, unfinished tools, then repositories. Desktop height 2,399px to 1,994px with every link visible; first-view weight 14.5 KiB to 4.6 KiB gzip (ceiling lowered to 5 KiB).
- `/llms.txt` and `Accept: text/markdown` on `/` come from the same list. Net deletion of the question maps, their client script, on-demand files and tests.
- Checked locally: typecheck, directory, app, page-weight and asset-cache tests (Node 26.13.0, so the full release gate is left to CI on the PR). All 77 destinations requested once: 75 answer 200.
- Found, not caused by this change: the Juicescan address on eth.sucks returns a Cloudflare worker exception, so /inspect redirects land on an error, and eth.shop closes the TLS connection. Both are live today.
- Old view/node fragments now land at the top of the page. juicebox.money and revnet.money each link /#apps/juicescan from their llms.txt.

## Documentation copy rewrite, part A: REST guides and /api page (2026-11-12)
## Plan refinement
- **Objective:** Apply the audit decisions jango accepted ("all recommended") to the REST surface: one safety statement per document, agent guide and journeys cut to unique content, account-era glossary rows removed, one name per document (Quickstart, API guide, Endpoint reference). Success: each guide says each fact once and a reader can act from the first screen.
- **System fit:** Copy only. `docs/rest/*.md` stay the source the guide pages render, `src/rest/docs/page.ts` stays the `/api` template. Routes, schemas and responses are unchanged. README, intents, contracts/indexer/omnichain and MCP copy follow in their own PRs.
- **Reuse and simplicity:** No new files or structure. Rules come from the existing copy canon and the three audit reports. Net deletion.
- **Evidence and unknowns:** Audit reports counted the safety statement about twenty times across REST docs and found session, guard, relay, bundler and paymaster rows describing removed Center accounts. Each rewritten claim is checked against the route or the original sentence; nothing new is asserted.
- **Verification:** Typecheck, full vitest run (page-weight ceilings, docs browser test), anchor grep for renamed headings and removed glossary ids, rendered `/api` and guide screenshots.
- **Resource budget:** One PR, one CI run. Merge only on jango's word.
- [x] Agent guide and journeys rewritten
- [x] `/api` page hero, cards, glossary and nav
- [x] Quickstart, API guide and transactions tightened
- [x] Render check, PR

## Documentation copy rewrite, part B: README as the front page (2026-11-12)
## Plan refinement
- **Objective:** Accepted audit decision 2: the README answers "what is this and where do I go" on its first screen, keeps RPC and IPFS usage, and leaves configuration to the operations guide.
- **System fit:** Copy only. The home page links `#read-ethereum-rpc` and `#pin-and-read-ipfs-content`, and the MCP README links `#run-it`, so those headings stay. The intent sections go because the intents guide already documents every one of those routes.
- **Reuse and simplicity:** Configuration, origin lists, MCP hosting, IPFS cache and RPC internals move verbatim into `docs/rest/PRODUCTION_OPERATIONS.md`; nothing is rewritten in the move.
- **Evidence and unknowns:** Each intent route in the old README appears in the intents guide (checked by grep, 2 to 16 mentions each). The bundled MCP knowledge file still holds an older README and is refreshed separately.
- **Verification:** Full vitest run, anchor check for the three linked headings, link check on moved text.
- **Resource budget:** One PR, one CI run. Merge only on jango's word.
- [x] README rewritten around a "where to go" table
- [x] Configuration and internals moved to the operations guide
- [x] Tests and anchors checked
