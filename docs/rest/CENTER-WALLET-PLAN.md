# Center shared wallet: implementation strategy

Reviewed 2026-09-13 against Center `109cb0e`. This is the implementation strategy for [the shared-wallet specification](CENTER-WALLET-SPEC.md). Implementation began from reconciled main `d5ec4af`; [the implementation record](CENTER-WALLET-IMPLEMENTATION.md) distinguishes working foundations from the remaining gates. Production readiness is a later measured result.

## Decisions carried forward

- Center owns the shared wallet lifecycle and execution. Beep and Juicebox Money are its first two clients.
- New wallets use passkeys for creation, sign-in and exact payment approval. No email, phone or messaging-provider dependency. WhatsApp remains a possible later contact feature.
- The existing Center origin allowlist supplies first-party trust. No per-site connection consent. Authentication and fresh transaction approval still apply.
- Start with Base and the existing V6 payment path. Preserve legacy Para, external wallets, current account IDs and exact signed protocol meanings.
- Reuse the existing client package, PostgreSQL, account inspection, relay and recovery machinery. Do not build an MPC service or a second execution gateway.

## Review findings that change the sequence

| Finding | Evidence in current source | Strategy change |
| --- | --- | --- |
| Contract-owner support is incomplete | `auth/signatures.ts` and `contractOwner.ts` support REST ERC-1271; `smartAccounts/service.ts` rejects contract owners and an API principal equal to the Safe; `onboarding.ts` assumes one EOA | Prove one versioned account path across all boundaries before schema/UI work. Preserve the existing EOA path's checks. |
| Owner rotation changes today's API identity | `onboardingDocument` derives `accountId` from the signer; client `forOwner` does likewise | Prefer the Base Safe address as the new stable authority principal, subject to ERC-1271 proof. Keep legacy identities and explicit migration links. |
| Authentication signatures and payment signatures differ | Pinned Safe7579 uses a validator prefix and SafeMessage for ERC-1271, versus validity fields and SafeOp for owner execution | Use separate codecs/challenges and prove they cannot substitute for each other. A working signature verifier is insufficient. |
| Gas estimation assumes EOA signatures | `userOperations/service.ts` estimates using threshold times 65-byte dummy signatures | Include variable signature length and verification gas in the first estimate/sign/preflight experiment. Never alter reviewed gas fields after signing. |
| Recovery and native feasibility were too late | Previous plan deferred full device work to slice 7; a second same-RP passkey cannot independently solve domain loss | Test an independent recovery owner and a thin real-device/native journey before finalizing the account/RP design. |
| Automatic grants need an authority model | Existing bot registration needs owner consent and signed proof; an authenticated cookie is not a spending signature | Define a distinct first-party session grant path. Reuse request signing/storage where appropriate without giving it owner-only or onchain authority. |
| Allowlist updates have no shared activation point | `src/app.ts` captures environment origins at startup | Activate wallet eligibility as a shared versioned snapshot from that same allowlist; test stale replicas and removal. |
| Current load tests are unrelated | `scripts/load-test.mjs` sends concurrent public-search reads | Build wallet scenarios alongside features; measure successful authenticated throughput and actual process failures. |

These are implementation design gaps, not findings that existing supported EOA/Para flows are insecure. Source paths above are relative to `src/rest/` unless explicitly qualified.

## Baseline and reuse

The current work was committed as `215b132`, the original plan as `a849e29`, upstream Beep fixes reconciled at `59939bb`, and passkeys-first scope recorded in `109cb0e`. At review start Center was clean on local main, four commits ahead of `origin/main`; none had been pushed in this session. Preserve the merged onboarding, sponsorship-route, invoice-memo and history fixes.

The combined baseline passed `npm run check` with disposable PostgreSQL 14: 1,731 service tests, 397 MCP tests and 53 pinned-stack Foundry tests, with no database or execution skips. Types, builds, artifacts and catalog checks passed. The real-EVM 32,000-block history case took about 109 seconds. This is historical baseline evidence, not passkey or capacity evidence; no implementation tests were rerun for this documentation review. W0 must match CI's PostgreSQL 16 before using the new results as release evidence.

Existing CI uses Node 22, PostgreSQL 16 and pinned Foundry v1.7.0. Reuse it. Begin implementation in an isolated feature worktree from the current clean main; record its exact SHA. Do not recommit baseline work or replace legacy account manifests.

## Gate A: prove the architecture before extending the product

Budget the first iteration for evidence, with five explicit questions. Work may start on these immediately when implementation resumes; no UI framework, production database migration or funded account is needed first.

1. **Exact signature paths:** can a genuine P-256/WebAuthn assertion authorize the pinned Safe7579 SafeOp through EntryPoint, and can the same Safe verify a separately encoded REST approval through its ERC-1271 SafeMessage path? Check both relevant ERC-1271 selectors, dynamic Safe signature offsets, ordering, length bounds and canonical encoding against the actual contracts. Preserve EOA and multisig regression vectors.
2. **Complete account model:** can a new Safe act as the stable Base API principal while its owner credentials rotate? Prove bootstrap before deployment, canonical binding, owner-state changes and stale-authority rejection. Introduce a new explicit account/authorization profile; do not delete owner checks to make it pass.
3. **Sponsorship fit:** can the complete assertion fit estimation, current provider gas/signature limits and exact signed preflight? Use the pinned local provider/account stack and report estimation separately from a real-provider acceptance probe.
4. **Device and origin fit:** proposed wallet origin and exact RP ID are `wallet.juicebox.center`. Keep dev credentials on a distinct test origin/RP. Verify the corresponding hosting isolation and native association configuration before issuing durable production credentials. Use a discoverable credential, trusted `userVerification: required`, a stable opaque user handle, and server-owned expected origin/RP/challenge. Probe real iPhone Safari, Android Chrome and one iOS-to-Center handoff early. Full native UX follows later.
5. **Independent exit:** prove direct Safe execution with an independently controlled external EOA backup when Center's domain, API and sponsor are unavailable. This is the pilot recovery candidate: threshold 1 across the primary passkey signer and backup means either can spend. Disclose that authority; prove removal/replacement and unchanged address. A second passkey at the same RP can help device redundancy but cannot satisfy domain-loss exit by itself.

Gate A artifacts: source/compiler/runtime pins, positive and negative signature vectors, a runnable local execution test, a device observation record, and an explicit decision on account principal, recovery and RP. Existing `viem`/WebAuthn helpers are candidates for reuse; validate the boundary inputs ourselves and declare/pin any direct dependency we actually adopt.

**Pass condition:** record pass, pending or fail for each question and observation. Gate A is fully accepted only when all five questions have the required evidence. A bounded pending external-device/provider observation permits independent experimental progress, not full gate acceptance. Cryptographic/account compatibility must pass before dependent code lands; freeze the production origin/RP only after its device evidence passes. Durable production credentials, real deposits and claims of native compatibility remain blocked until their respective device/recovery/provider evidence exists. Record a failed candidate and choose a reviewed versioned alternative instead of weakening invariants.

**Consumer recovery decision:** the external-wallet backup proves technical feasibility for the pilot but does not complete onboarding for a person with no existing wallet. Before public funding, choose and test an accessible user-controlled recovery experience for that person, such as a separately stored recovery credential/package, including possession proof and loss consequences. Do not silently require an existing wallet or introduce email/WhatsApp takeover. This product choice need not delay Gate A.

## Minimal protocol decisions to freeze after Gate A

| Boundary | Working choice and required invariant |
| --- | --- |
| Canonical identity | New wallet principal is `eip155:8453:<safe-address>` if Gate A passes. Credential IDs are replaceable lookup keys, not identity. One explicit enrollment attempt fixes the deployment salt and initializer; concurrent retries reuse it. Never derive the next wallet from a new passkey or app. |
| Ceremony purposes | Separate registration, login, deployment, API-session setup, payment and rotation challenges. Bind expected origin/RP, account, action digest, expiry and one-use nonce from trusted context. No endpoint signs arbitrary challenges supplied by an app. A login assertion must fail as a payment or ownership change. |
| Registration proof | Parse a bounded supported credential format, verify creation context, then obtain possession proof bound to the intended initialization before sponsoring deployment. Authenticator sync/counter behavior follows the chosen standard implementation; do not assume every valid synced passkey increments a nonzero counter. |
| Center session | Dedicated wallet origin with a host-only Secure/HttpOnly session cookie, bounded expiry and CSRF protection. Cookie authentication permits approved API access, not spending or credential enrollment. Credential addition/removal requires fresh account authority. |
| App handoff | One-time code, PKCE S256, exact registered callbacks, state and issuer checks. Code binds app origin, wallet, requesting browser key and scopes. Browser keys are generated in their app context; no private key crosses the handoff. No reusable authority in URLs. |
| API grants | Standard read/plan/relay only, short-lived and bound to app origin and request signer. Add a distinct first-party grant admission path; do not relabel an unauthenticated object as an owner principal or broaden legacy bot grants. Default reauthentication instead of a refresh-token system for v1. |
| Allowlist activation | Keep `originsForEnvironment` as configuration source. Activate its wallet-policy snapshot atomically in PostgreSQL with a revision. Both replicas check that shared active eligibility when issuing/using wallet grants. Other allowed apps retain access when one is removed. No process may restore an older snapshot merely by restarting. Exact callback metadata extends this same config. |
| Payment handoff | Apps send an intent/plan reference to Center review; Center reconstructs exact calls. Return durable operation status/reference, not the user's signing key. Do not mistake UserOperation or Safe proposal IDs for transaction hashes. |
| Unknown outcomes | Persist prepared operation and signed commitment before dispatch. Reconcile the original identity after loss of response. Never release potentially spent budget or initiate another payment solely because a timeout/TTL passed. At most one business effect; byte-identical transport rebroadcast is a separate deliberate recovery policy. |

Reusing a legacy field with new authority semantics is not compatibility. New profiles, stored grant types and signed-document versions must be explicit; maintain old validators for old records.

## Reviewable change sequence

Each row is a dependency boundary, not a requirement to fit unrelated schema, crypto and UI changes into one PR. Split large rows while keeping a runnable vertical test. No feature is done on unit-test evidence alone.

| Change | Scope and first failing test | Dependencies and completion evidence |
| --- | --- | --- |
| W0. Required test gate | Fail when required DB/execution suites are skipped or missing; record the baseline and install paths | Reuse CI PostgreSQL/Foundry; no new test framework. Cold-start gate uses `TEST_DATABASE_URL`, reports required suites and builds the published client. |
| W1. Architecture experiment | Gate A tests fail for today's EOA-only envelope/profile | Requires W0. Positive pinned-contract proofs, adversarial vectors, estimate/preflight evidence and early device/recovery probe; freeze protocol choices. |
| W2. Contract-owner profile | Wire separate SafeOp/SafeMessage codecs into shared client, canonical inspector, binding and execution | W1. Altered digest, offsets, signature lengths, owners, threshold, runtime and module state fail. Legacy paths remain green. |
| W3. Registration and identity | Add minimal durable credential/enrollment mapping; prove concurrent identical and conflicting registration attempts | W1. Additive PostgreSQL migration; two real service processes, unique constraints, one-use challenge consumption and crash barriers. Never merge identities by email or passkey replacement. |
| W4. Deployment and binding | Sponsored creation binds credential proof to exact initialization and stable identity | W2+W3. Durable signed deployment, last-budget contention, crash before/after submission, canonical confirmation and reorg tests. Reuse Beep's existing behavior without retaining a second general deployment service. |
| W5. Recovery and rotation | Backup proves possession; rotate onchain while preserving address; invalidate stale API authority | W4. Direct independent withdrawal and rebind pass. Consumer recovery choice must be closed before public funding. |
| W6. Trusted shared sessions | Center login and automatic allowlist-based app grants through PKCE | W2+W3 for actual authority acceptance; development can begin against frozen W1 fixtures. Code replay, key substitution, cross-app reuse, CSRF, expiry, global logout and allowlist activation/removal fail safely across two processes. Can develop alongside W4/W5. |
| W7. Review and connector | Present and authorize exact operation, then resume after cancel/reload/account switch/unknown response | W2+W4+W6. Extend current client package; distinguish connection, signing and submission. No generic EOA emulation or new SDK family. |
| W8. Beep integration | Replace Para coupling only in the new wallet route; pay a fixed invoice from the actual Safe | W5+W7 for funded acceptance. Preserve independent invoice fulfillment and beneficiary checks, one receipt/device effect, external-wallet and Para regressions. |
| W9. Money integration | Connect the same Safe and exercise one actual supported V6 payment | W7, can develop alongside W8; W5 before funded acceptance. Test account/balance destination and operation tracking. Listing the address alone is insufficient; don't route Center operations through Money's unrelated Safe Transaction Service path. |
| W10. Native completion | Native iOS and browser share the same account and protocol; correct return links and cancellation | Early W1 probe + W6/W7. Physical iPhone and Android browser matrix, backup/restore observations and resumed invoice/operation. Browser fallback is not native completion. |
| W11. Pressure qualification | Sustained, burst, hot-wallet, backlog, recovery and failure scenarios | Harness begins in W3; W11 aggregates measured behavior after integrations. Fix observed failures and rerun affected scenarios. |
| W12. Release and migration readiness | New-wallet rollout, legacy compatibility, migration design, operating controls and rollback | W5+W8+W9+W10+W11. External review/remediation, backup restore reconciliation, bounded real-provider pilot and release evidence. Inventory and rehearse actual authority/asset migration before moving legacy users; that later migration does not block new-wallet-only rollout. |

Prefer new-wallet rollout first. Legacy Para users keep their working account until the reviewed migration is explicitly authorized. A migration must account for credits, project administration, allowances and nontransferable positions, not just ERC-20 balances.

## Work allocation and file boundaries

One integration owner owns the signed wire formats, principal model, manifest and migrations. Freeze these contracts before assigning dependent client work. Another reviewer checks trust-boundary and state-machine changes independently. Review does not replace tests.

After W1, persistence/shared sessions and deployment/contract execution can progress in parallel using fixed fixtures. After W7, Beep and Money adapters can progress separately against the same packaged client. Device probing and pressure tooling start early, while full acceptance waits for dependencies. Avoid concurrent edits to core signature/auth modules.

| Area | Existing starting points |
| --- | --- |
| Authority and identity | Center `src/rest/auth/{signatures,service,store,postgres}.ts`, `contractOwner.ts`, `smartAccounts/{service,onboarding,onboardingStore,onboardingPostgres}.ts` |
| Contracts and signatures | `smartAccounts/{accountExecution,creation,inspector,types}.ts`, `smartAccounts/stack/`, `userOperations/{service,provider,postgres}.ts` |
| Shared client and UI | `src/rest/client/{index,center,smartAccounts}.ts`, `web/{main,smartSessions,operationQueue,walletRecovery}.ts`, `site.ts`; isolate passkey UI from the existing Para-enabled page policy |
| Beep | `src/embedded-wallet.ts`, `center.ts`, `center-access.ts`, `payment-account.ts`, `client/{main,para}.tsx`, sponsored-payment and receipt code |
| Money | `src/providers/{Providers,lazy-para-connector,wallet-connectors}.ts*`, `hooks/useWallet.ts`, `lib/{wallet-core,safe,safe-connector,safe-batch-connector}.ts` |
| Native | Beep `ios/` currently proves Para enrollment and browser checkout only; native payments/funding/receipts/recovery still need implementation |

Money uses wagmi as its connection source of truth; implement a capability-aware Center connector. Beep exposes `ParaSigningSession` in its embedded-wallet type; replace that coupling only as the second implementation arrives, and reuse shared Center operation semantics rather than copying signed wire formats again. Unsupported operations/chains must report an explicit capability error.

## TDD and evidence workflow

For each change: reproduce an observable failure against the prior implementation, implement the minimum complete behavior, run focused tests, then refactor while green. Record the command, reason for failure, implementation revision and green result. A missing import alone is not evidence of the behavior being tested.

Use real signatures, pinned contracts and real PostgreSQL transactions at the relevant boundary. Introduce two actual service child processes when W3 lands; multiple store instances in one process do not prove process death or cache invalidation. Each durable transition gets conflict/replay and crash tests when introduced, not at the end. Mutation-check the critical assertions by removing replay/authority/budget enforcement and confirming the corresponding tests fail.

Keep the existing commands. From Center, install with `npm ci --ignore-scripts` and `npm --prefix mcp ci --ignore-scripts`. With the disposable PostgreSQL 16 URL in `TEST_DATABASE_URL` and pinned Forge/Anvil available, run `npm run check` at integration gates. W0 must make required missing suites/skips fail explicitly. Do not waste a full run knowingly skipping the database first.

Current focused suites include:

```sh
npm test -- test/rest-smart-client.test.ts test/rest-smart-web.test.ts test/rest-wallet-recovery.test.ts
npm test -- test/rest-smart-account-onboarding-store.integration.test.ts test/rest-user-operations-postgres.integration.test.ts test/rest-sponsorship-postgres.integration.test.ts
npm run check:execution
```

Add focused tests to these suites or adjacent files as behaviors land. Add an explicit wallet-pressure command when the first runnable scenario exists; today's `npm run load:test` does not qualify wallet capacity. Beep gates are `npm run check` plus its Chrome/WebKit browser suites. Money gates follow its own `AGENTS.md`, installed Next.js guides and `npm run check`; do not treat a mocked connector test as full app compatibility.

Evidence tiers: deterministic unit/controller checks; actual HTTP/database/process integration; actual pinned EVM; virtual-authenticator browser tests; physical-device tests; real-provider funded pilot. Report each separately. Virtual WebAuthn does not prove device sync, native association or user recovery.

## Pressure qualification

Keep the initial numerical targets as hypotheses to qualify on a declared deployment shape, not present capacity claims. Before the qualification run, record machine resources, replica count, Node/PostgreSQL versions, DB pool/deadlines, RPC quotas and generator resources. Lock the intended target for that run; changing hardware or target requires a new report.

Start with 10,000 wallets, two service processes and shared PostgreSQL. Test even traffic and a hot wallet separately. Use an open-loop offered-rate scheduler, with generator lag/headroom recorded. Report offered, admitted and successfully completed rates, rejects, p50/p95/p99/max and queue/DB waits per route and app. Never hide a failing app behind aggregate throughput.

| Scenario | Target and correctness gate |
| --- | --- |
| Steady local API | Offer 100 authenticated reads/s + 20 session/grant mutations/s for 30 minutes. At least 99% of valid offered work completes successfully: >=99 reads/s and >=19.8 mutations/s. Local-route p95 <=500 ms and p99 <=1 s; unexpected failures <0.1%. Rate-limit rejections count against steady success. Measure registration/cryptography and upstream-backed operations separately. |
| Overload | 10x offered traffic for 60 seconds. Explicit bounded 429/503 admission, no unauthorized successes or process crashes, bounded queues/pools; return to steady targets within 60 seconds. Keep a known-good stream from the other app and owner/recovery traffic to test fairness. |
| Replay/conflict races | 100 identical requests and 100 conflicting requests sharing one idempotency key across both replicas. One valid durable transition, explicit conflicts, at most one business effect. Exercise enrollment, code exchange, API nonce, payment and recovery. |
| Sponsorship | Compete for the last budget unit across apps/processes. No overspend/borrowing; retain uncertain reservations; settle failed execution/reorg cases from canonical evidence. Provider policy selection alone is not a complete Center budget ledger. |
| Revocation | Activate a new shared allowlist snapshot, rotate authority or sign out while requests are admitted. Test pre/post-commit ordering, stale replicas, restarts and queued dispatch rechecks. Already valid onchain signatures retain their own nonce/expiry semantics. |
| Crash/restart | Kill a replica before commit, after durable claim, before provider call, after provider acceptance and before response. Restart and reconcile the original operation. Recover safely when evidence returns; unavailable evidence remains unknown, with no blind new payment. |
| DB/provider faults | Lock waits, deadlocks, connection exhaustion, replica clock skew, DB outage, RPC/bundler/paymaster slow/429/malformed/divergent responses. Bounded deadlines and work, no retry storm or false success. Failover/restore rehearsals belong in staging. |
| Backlog and restore | Multiple recovery workers, large unknown history, pagination/fairness and duplicate sweeping. Restore a DB backup older than a submitted transaction and reconcile chain evidence before admitting conflicting work. A missing restored row is not proof of non-submission. |
| Soak | Two hours at steady traffic with periodic faults. Bound ephemeral challenge/session/replay retention by configured TTL+cleanup lag; measure durable history growth per accepted operation. After warmup and cleanup, RSS/heap settles within 20% of baseline without a continuing upward trend. Inspect secret exposure in logs/errors/exports separately. |

For execution, begin with five prepared operations/s against local pinned contracts and a deterministic provider harness. Report estimation, cryptographic validation, submission and confirmation separately. Real-provider pilot throughput follows its actual quotas and is measured independently; human interaction and chain finality are not local API latency.

## Release and immediate next action

New-wallet release requires source-reviewed crypto/authority changes, addressed review findings, required tests with no skips, two-app payment evidence, physical-device acceptance, consumer recovery, independent exit, legacy-path regressions, restore rehearsal, measured pressure results and an operating runbook. Moving legacy users additionally requires the signed migration rehearsal and asset/authority inventory. No single passing test count establishes this.

Rollout controls can stop enrollment, app admission and sponsorship. They cannot undo onchain ownership or already valid signatures. Preserve account discovery, unknown-operation reconciliation and exit while rolling back. No production credential creation, funded migration or contract deployment is implied by this planning update.

The first implementation checkpoint is W0/W1: an isolated feature worktree, required test observations, and contract-owner and cross-purpose signature vectors against the pinned stack. See the implementation record for evidence and the next unresolved dependency. No further product clarification is needed for bounded local experiments; production origin, recovery and provider acceptance retain their explicit gates above.

Planning estimate remains roughly 1–2 weeks for architecture evidence, 6–10 weeks for the web/recovery/two-app slice, and 4–8 weeks for native completion, pressure, migration and review remediation with 2–3 experienced engineers; external review scheduling is additional. Re-estimate after Gate A from demonstrated compatibility and the consumer recovery choice.

Primary standards: [Safe7579 pinned implementation](https://raw.githubusercontent.com/rhinestonewtf/safe7579/f22a194148ff087f0c16125e530512e59794e188/src/Safe7579.sol), [WebAuthn](https://www.w3.org/TR/webauthn-3/), [OAuth security BCP](https://www.rfc-editor.org/rfc/rfc9700), [Apple passkeys](https://developer.apple.com/documentation/authenticationservices/supporting-passkeys). Recommended architecture choices above are our design judgments; standard support does not prove compatibility with this deployment.
