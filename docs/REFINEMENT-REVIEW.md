# Center refinement review

Review date: 2026-09-23. This review covers unused code, duplication,
unnecessary complexity, inefficiency, and reliability/security defects while
preserving supported journeys. It is a source review with executable regression
evidence, not certification of production providers or deployed contracts.

The initial review used a local working tree at
`4402042838e0ad8ef7954a0a60c9a1a162290973`, including its pre-existing edits.
The PR ports only the review changes onto current `main` at `3c739d19cc6f71effa372da6bf76228aeb812aa2`.
It preserves the newer framed signup/login, device and network support, sessionless
payment approval, deployment inclusion release, intent relay, and wallet package.
Fixes already present upstream are retained, and obsolete changes are omitted.
The original checkout and its staging remain unchanged.

## Coverage

| Surface | Review coverage |
| --- | --- |
| Public service and storage | All top-level application modules, intent publication/search, deployment verification, quotas, HTTP routing, observability, startup/shutdown, PostgreSQL stores and migrations. |
| Directory and documentation UI | Directory data, question graph, rendering, browser navigation, accessibility, text index and documentation browser code. |
| IPFS and public RPC | Upload providers, multipart handling, disk cache, ranges/validators, cancellation, response bounds, RPC policy, failover and credential boundaries. |
| REST authorization and composition | Auth, sessions, approvals, dispatcher authority, account-owner checks, app/runtime/context, private RPC and execution configuration. |
| Transactions and sponsorship | Immutable plans, direct/external execution, durable reservations, recovery, prepaid quotes/funding, receipts, and omnichain observations. |
| Smart accounts and user operations | Creation, binding, onboarding, policy/compiler, inspection/history, signature verification, estimation, sponsorship, submission and canonical execution evidence. |
| Wallet lifecycle | Enrollment, registration, ceremonies/WebAuthn, signup, deployment/funding/fees, authority refresh, login/handoff, app grants, payment reviews, recovery and operator journals. |
| Browser and SDK | Every REST browser module and client module, public exports, local secret handling, connection files, payment archives and interrupted-journey recovery. |
| MCP | All services, operation definitions, schemas/types, adapters, transport/host integration, bounded source references, metadata publication and generated tool catalog. |
| Build and operations | Build/package/deployment configuration, CI, handwritten scripts, generators, retained evidence verification, OpenAPI response schemas and relevant runbooks. |

Generated ABIs, GraphQL types, source bundles, retained factory history and
third-party contract artifacts were reviewed through their generators, hashes,
provenance checks and consumers. They were not treated as handwritten code or
independently re-audited line by line. Tests and fixtures were examined alongside
the journeys they exercise; complete release validation is recorded below.

## Confirmed findings and fixes

Priority labels describe this review's impact assessment, not CVSS scores.

| ID | Priority / category | Finding and resulting behavior |
| --- | --- | --- |
| R01 | P1 reliability | Signup could lose an undisplayed recovery secret on reload and continue deployment/setup. The backup kit is exposed as soon as the wallet identity is known; continuation requires a saved or re-imported matching kit, or the matching existing recovery wallet. Secrets are not silently persisted. |
| R02 | P1 reliability | The initial checkout lacked an idle-connection error handler. Current main already handles active and idle connection failures; the integrated change sanitizes both diagnostic paths while retaining its metrics and reconnect behavior. |
| R03 | P2 reliability | A confirmed transaction with an unknown modeled outcome stopped background reconciliation. Memory/PostgreSQL recovery and pending-age accounting now retain it until the outcome resolves; migration 060 updates the matching recovery index. Unsupported outcomes remain distinct from unknown modeled outcomes. |
| R04 | P2 reliability | Revocation of a prepared session without an activation record was never refreshed. The existing reconciliation path now runs for activation or revocation. Quota reads reuse its returned record. |
| R05 | P2 reliability | Ordinary chain/finality advancement could invalidate otherwise fresh deployment/funding/settlement observations. Current main already shares the exact funding/preflight head and rechecks canonical transport evidence. The integrated change strengthens equal-height and advancing-finalized-head checks in settlement. Reorg, freshness, nonce, balance and exact-byte checks remain. |
| R06 | P2 safety | Smart-account binding authorization could expire during database writes. Binding now checks database time again before committing and rolls back late writes. |
| R07 | P2 reliability | Relay unlock failure leaked a checked-out connection and potentially its advisory lock. Failed unlock now destroys the connection in the shared owner relay used by recovery and device addition. |
| R08 | P2 safety | Private RPC validated mutable parameters before asynchronous work, allowing transmitted parameters to differ. It now snapshots the parameters before validation. |
| R09 | P2 reliability | Single-operation browser responses could replace reviewed identity and erase an unrelated recovery reference. Submit/status now reuse the existing immutable-operation check before accepting results. |
| R10 | P2 reliability | Embedded Para wallets could not perform the exact block read needed to verify failed creation. The existing provider now permits only the required numeric block lookup with transactions disabled. |
| R11 | P2 compatibility | The session-key importer rejected the connection format produced by Accounts. It accepts that format through the existing parser and checks audience, account, grant, scope, expiry and key; legacy key files still work. |
| R12 | P2 reliability | Provider UUID ordering could permanently misbind prepaid transactions. Current main already supplies the shared exact-echo binding helper for intent families; ordinary prepaid quotes now use it with durable provisional binding before exposing a fundable commitment. Once bound, the quote is immutable. Old records without the new marker remain immutable even if runtime verification was incomplete. Provider submission is never repeated. |
| R13 | P2 reliability | Clearing the 64th payment receipt could become permanently stuck after a transient pending-record deletion failure. Current main already replaces that limit with bounded archive eviction and deduplication; its implementation is retained. |
| R14 | P2 reliability | Generic API, RPC and pin requests shared caller quota keys despite different budgets/windows. Caller buckets are isolated; pin retry hints use the pin window. |
| R15 | P2 safety | Message-prefix matching could expose internal failures as validation errors. Intent validation now has an explicit error type; unrelated internal errors stay sanitized. |
| R16 | P2 reliability | Upload cancellation was not propagated through HTTP pin routes, and invalid trailing multipart data could leave provider work running. Existing cancellation signals now reach the provider and parser cleanup. Oversize rejection aborts the upload immediately and destroys the parser after its event callback returns, avoiding a Busboy reentrancy failure. |
| R17 | P2 reliability | SDK response reads and several IPFS cleanup paths could hang on stalled streams/cancellation hooks. Readers observe their deadlines and cleanup no longer waits for an uncooperative cancel promise. |
| R18 | P2 reliability | Cold IPFS partial responses accepted the wrong interval or wrong body length when Content-Length was absent. Content-Range is matched to the requested range and supplies an enforced stream length. |
| R19 | P2 consistency | Cold and cached IPFS responses handled Center's ETag differently. Conditional and range behavior now use the same local validator semantics without forwarding a Center ETag as a provider validator. |
| R20 | P2 safety | Logo validation accepted namespace-qualified SVG scripts and escaped external CSS references. Local Chromium demonstrated script execution from accepted bytes. Validation now detects those encodings/namespaces and active animation while retaining passive SVG shapes/text/styles and exact approved bytes. Center's gateway CSP remains unchanged. |
| R21 | P2 compatibility | MCP documented 1 MiB logos but capped their encoded request at 256 KiB. Logo requests now fit the documented decoded limit plus bounded envelope overhead; ordinary HTTP MCP messages retain their 256 KiB cap. |
| R22 | P2 boundary | Logo publication was classified as an onchain read despite its mutation effect. Existing operation effects now classify both publication operations consistently, while preserving Center intent publication/deployment as Center writes. Explicit publication confirmation is still required. |
| R23 | P2 reliability | MCP's shared upstream reader replaced malformed UTF-8 rather than rejecting it. It now decodes strictly, preserving valid multibyte characters across chunk boundaries. |
| R24 | P2 feature completeness | Valid free/credit-only NFT payments were blocked by ordinary positive-payment validation. The verified NFT path permits zero funding only with the authenticated tier hook and non-noop preview; general payments still require positive amounts. |
| R25 | P2 feature completeness / efficiency | Repeated price-context reads could exhaust the request budget for valid NFT launch configurations. Identical pinned reads are reused; tier and loan reads avoid unnecessary repeated or serialized work. |
| R26 | P2 reliability | Fresh documented development startup omitted its required SDK archive. Development now executes the existing complete build before starting the watcher. |
| R27 | P2 reliability | Repeated builds retained removed JavaScript, SQL migrations and client artifacts. Build now recreates only derived runtime/browser/client outputs and preserves release observations. |
| R28 | P2 provenance | Contract generation silently skipped missing explicitly pinned source repositories. It now refuses incomplete input rather than emitting a partial catalog. |
| R29 | P2 provenance | Factory-history sealing accepted an unfinalized anchor despite promising a finalized prefix. Sealing checks the finalized head before publication. |
| R30 | P2 compatibility | Closed OpenAPI response schemas omitted existing passkey profiles/authorization and local source provenance. Schemas and discovery metadata now describe the existing responses accurately. |
| R31 | P2 usability | Native directory fragments were redirected to the graph start. Native targets open their containing details, preserve the active graph and receive the intended focus/scroll. |
| R32 | P2 lifecycle | Shutdown stopped cleanup after the first rejection. Ordered finally blocks now attempt REST-worker and database cleanup even if server shutdown fails. |
| R33 | Efficiency | Factory-history lookup scanned 2,450,336 sorted entries per uncached wallet. It now uses binary search, validates sorting once and retains duplicate/history-bound checks without allocating another large index. |
| R34 | Efficiency | Intent search loaded full signed documents/calldata for metadata-only responses. Its SQL projection now retrieves only response fields. |
| R35 | Efficiency | External transaction updates repeated the same transport-binding query per step. Checks are batched by transport, at most two queries per update batch. |
| R36 | Duplication / efficiency | The initial checkout repeated identical session authority checks on approved retries. Current main intentionally authorizes payment reviews without login sessions and already performs one current-authority check. The obsolete session-based optimization and regression cases are omitted. |
| R37 | Duplication / efficiency | Configuration conversion repeated within each split group and routing repeated immutable hook reads per token. Conversion is hoisted; routing shares a request-local promise while preserving per-token unknown results. |
| R38 | Duplication / reliability | Operator journal readers duplicated capped read loops, and publication retry used an unbounded read. Existing bounded journal reading is reused, retaining the stricter funding limit. |
| R39 | Efficiency | Blob uploads unnecessarily created another full buffer before an already streaming provider. They now use the Blob stream. |
| R40 | Build simplicity / size | Production compilation included tests/diagnostic scripts, and eight browser entries repeated build configuration. Runtime compilation is source-only and browser entries share one build. Type checking still includes tests. |
| R41 | Unused code / duplication | Removed the unused transaction transport adapter, legacy MCP tool factories, unused private wallet helper/recovery lookup/provider method, unused imports/markup. Reused existing permission hashing, paymaster pin and observation types. Public client exports and deliberate trust-boundary validation remain. Current main uses the RPC error cause, so that bookkeeping is retained. |
| R42 | Tool reliability | Compiler discovery assumed a legacy cache directory. Verification reuses the existing platform-aware resolver while preserving explicit overrides and exact compiler hashes. |
| R43 | Test reliability | Anvil history pruning evicted transaction trace prestate across repeated fixtures. A bounded retained history and inclusion-before-finality synchronization preserve the evidence the tests require. |
| R44 | Dependency safety | The approved service advisory check identified Hono advisories affecting 4.13.3. The existing dependency was updated within major version 4 to 4.13.8; no dependency was added. |
| R45 | Diagnostic reliability | The load tool counted an HTTP error twice when its response body also failed. Each request now contributes at most one failure; a four-request offline check covers success, HTTP error, body failure and network failure. |
| R46 | Test reliability | Authorization fixtures consumed short readiness windows during unrelated setup, leaked unfinished refresh work between cases, or raced deadline queries against expiry. Fixtures now synchronize at the relevant database boundaries, drain background work, respect persisted ceremony creation times, and assert database-time bounds. Settlement workers open their database connection before timed evidence is issued. Real lock waits, expiry rollback, replay retention and stale lease rejection remain exercised; production deadlines are unchanged. |

## Measurements and limits

- The old factory-history scan took roughly 70–123 ms in local measurements.
  The replacement uses logarithmic search plus matching entries; this is not an
  end-to-end hosted latency claim.
- A local configuration-conversion microbenchmark measured 182 ms versus 4 ms
  for 200 iterations with 32 groups of 16 splits. This measures that CPU fragment,
  not the complete endpoint.
- Eight routing token pools previously repeated 14 avoidable immutable RPC reads.
  Regression tests verify the new request count and unchanged unknown outcomes.
- The prior build emitted about 7.3 MiB of tests and 132 KiB of diagnostic scripts
  into runtime output. The actual isolated build regression verifies neither
  directory is emitted and that all eight browser entries, the SDK archive and the wallet package load.
- No claimed live throughput, provider latency, gas saving, physical-device
  qualification or production-readiness result follows from these local checks.

## Validation

The table records completed review observations. Use the [PR checks](https://github.com/mejango/jbcenter/pull/56/checks)
for the complete gate result on the latest revision. The original review's green
result validates only that older snapshot, not the integrated PR.

| Tree / run | Result | Evidence |
| --- | --- | --- |
| Original baseline | Failed: 4,132 service passes and 11 failures; execution/artifact, passkey, MCP (401 tests) and typecheck passed. Build was not reached. | `.generated/checks/2026-09-23T17-04-21.653Z-3886470e/summary.json` |
| Original review snapshot | Passed all eight release steps: 4,225 service + 424 MCP + 92 execution/compatibility = 4,741 checks/tests, zero failures or skips. | `.generated/checks/2026-09-23T19-35-25.402Z-b241345e/summary.json` |
| Integrated local `4c8a607` | Failed: 4,525 of 4,527 service tests passed; all 435 MCP and 92 execution/passkey checks passed. Total: 5,052 passes, two failures, zero skips. | `.generated/checks/2026-09-23T20-35-20.428Z-b7765c0c/summary.json` |
| Integrated local `41ae60e` | Incomplete: source, execution, passkey, MCP and typecheck passed; service timeouts/expiry failures occurred before the run was interrupted. | `.generated/checks/2026-09-23T20-50-22.727Z-25410e74/summary.json` |
| Integrated CI `35919788663` | Failed: all 4,527 service + 435 MCP + 92 execution/passkey = 5,054 checks/tests passed, but an unhandled Busboy multipart rejection failed the gate. The follow-up fix defers parser destruction until its callback returns; the latest PR checks validate it. | [GitHub CI run](https://github.com/mejango/jbcenter/actions/runs/35919788663) |

Earlier local failures exposed fixture setup/retention timing and joined-journey
runner limits. Some coincided with host contention; that does not establish an
environmental cause for every failure. Failed and incomplete runs remain evidence
of unsuccessful validation, and their logs are retained.

Focused integrated checks passed across core, account/execution, transactions,
sponsorship, deployment, auth/session, wallet, build/generator and OpenAPI code.
The latest focused MCP check passed 434 tests after removing a redundant SDK-only
test; earlier runs' 435 counts above are unchanged. These focused groups overlap
and are not an aggregate coverage count. They exercise current-main intent relay,
sessionless payments, device/network support, inclusion release, creation-consent
bindings, added-device schemas and joined signup/recovery. TypeScript also passed
with both unused-declaration checks enabled.

Regression evidence includes genuine PostgreSQL locking, expiry and recovery;
local Anvil canonical history; browser reload/backup re-import; stream cancellation;
exact quote binding; malformed wire data; and an isolated clean build. Fixtures
synchronize at the relevant database/browser stage before asserting outcomes.
Dedicated expiry cases still cross real persisted deadlines and witness the intended
blocked statement or completed write. Original evidence expiry, replay retention,
stale lease, concurrency and exact-byte checks remain. Production authorization,
lease, SQL, browser and RPC deadlines were not relaxed to obtain passing tests.

The production Docker build and offline runtime smoke passed for source snapshot
`cce2180`, before the parser fix: all eight browser bundles, documentation,
the client archive and wallet package loaded; all 59 MCP tools initialized; test
and diagnostic output was absent. These results do not validate later source edits.
Integrated dependency audits found zero high/critical, 14 moderate and eight low
service findings including transitive effects, and zero MCP advisories. The remaining
Para upgrade requires separate validation; the proposed forced fix changes its major.

Local evidence, failed-run logs, audit results, review notes and the isolated review
patch are retained in `/private/tmp/jbcenter-review-20260923-i59_snal/`; integrated
local summaries use the `pr-` prefix, and the original green summary is copied as
`final-release-summary.json`. The original green source fingerprint was
`b1432671943bbe826b6a4b1f8fd7994a1ed68942c0d93c840d17bafab5334e1f`;
both integrated local attempts also retained unchanged source fingerprints.
The original checkout and its pre-existing staging remain unchanged. Review the
complete gate result for the final PR revision before merging.

## Deliberate retention and follow-up

- Keep trust-boundary validation, fresh owner approval, exact transaction bytes,
  replay protection, canonical evidence, recovery records and accessibility.
  Similar-looking validators sometimes protect different boundaries.
- Keep browser-safe ABI helpers separate where importing a server catalog would
  pull filesystem/crypto code into browser builds. The real build test caught
  that attempted consolidation and it was reverted.
- Keep transitive Para/Farcaster/browser dependencies unless bundler evidence
  proves they are unused; direct-import searches alone do not prove that.
- Keep the sequential/prefix simulation checks until a measured alternative
  preserves their state and nonce guarantees.
- The permanent per-account UserOperation history limit needs a deliberate
  retention/archive policy before scaling beyond it. Deleting execution evidence
  to reclaim quota was not introduced.
- Legacy prepaid bundles with an already exposed incorrect UUID commitment may
  remain unresolved. Correcting one requires an explicit migration/review design;
  this change cannot silently rewrite an existing funding commitment.
- Recovery can authenticate a prepaid UUID binding and verify one selected
  funding option without proving every payment option. Such a quote keeps its
  existing `requires_verification` public state and empty public payment list;
  validating one option does not promote the global runtime-verification flag.
- Historical SQL JSON-shape concerns and differing browser body readers were
  recorded as candidates, not asserted vulnerabilities without a reachable
  reproducer. Local tests do not replace a deployed-provider or hardware pilot.
