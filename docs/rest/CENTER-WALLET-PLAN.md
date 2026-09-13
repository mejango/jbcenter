# Center shared wallet: TDD delivery plan

Planning only, 2026-09-13. Implements [the shared-wallet specification](CENTER-WALLET-SPEC.md), including automatic connection for trusted allowlisted Juicebox apps. No new wallet implementation, production migration, or contract deployment is authorized by completion of this document alone; implementation is paused at the user's request.

## Outcome

A customer creates one user-controlled wallet through Center, pays a Beep invoice, opens the same Base account in Juicebox Money without a per-site consent screen, and retains access across supported browsers and iOS. Every payment requires approval of its exact contents. Credential recovery and independent withdrawal work without Center controlling the user's funds.

Preserve today's Para and external-wallet integrations during delivery. Reuse Center's client, account execution, PostgreSQL, quotas, and receipt recovery. Do not introduce a second execution gateway or an MPC service.

First-release authentication is passkeys: creation, returning sign-in and payment approval must work without an email address, phone number or messaging-provider credentials. Add this complete journey to acceptance tests. Keep independent backup enrollment and recovery as deposit gates. WhatsApp is a possible later contact-verification/discovery/notification integration, with its purpose and provider to be decided later; email/SMS verification and messaging infrastructure are not part of these implementation slices. Contact verification never grants wallet recovery authority by itself.

## Baseline before implementation

1. Review and commit the current Center work separately from this plan. Preserve existing source changes and record the exact tested revision. The current-work commit is `215b132`; the plan commit is `a849e29`. Reconcile both with the recorded upstream `ca099d5` using an ordinary merge, never a reset or force push.
2. Reconcile the baseline with Beep's deployed Center integration. Upstream `ca099d5` includes the onboarding, sponsorship-route and receipt fixes from the Beep integration. Preserve these when reconciling the current-work commit and verify the resulting combined baseline before implementation. Sponsored deployment remains a capability to inventory rather than infer from sponsorship-route availability.
3. Run `npm run check`, then all PostgreSQL-dependent tests against a disposable database with zero database skips. Inventory browser/device and hosted-provider coverage separately.
4. Pin the account stack and candidate passkey/recovery dependencies. Record source revisions, licenses, compiler inputs and runtime hashes. Choose the stable Center wallet origin/RP ID before registering any durable credentials.

Exit: a reproducible, committed starting point and an explicit compatibility ledger. A passing current Para suite is not a passkey-wallet acceptance result.

Baseline verification on 2026-09-13: the combined current-work and upstream `ca099d5` tree passed `npm run check` with a disposable PostgreSQL database: 1,731 service tests, 397 MCP tests, and 53 pinned-stack Foundry tests; no database or execution skips. Type checks, client/web builds, artifact checks and catalog checks passed. The real-EVM 32,000-block history test completed in about 109 seconds. These results establish the existing baseline, not the proposed passkey wallet or the pressure targets below.

## Development rule

For each slice, write the observable failure first and run it against the previous implementation. Keep a red/green record with test command and result. Implement the smallest complete behavior, rerun the relevant suite, then refactor while green. Preserve a regression test for every discovered authorization, recovery, race or accounting bug.

Use real signatures, actual pinned contracts, real database transactions and HTTP routes at their respective boundaries. Mock third-party failures for deterministic fault tests; never count those mocks as proof of provider or device interoperability. Capture mutation checks for critical invariants: removing replay consumption, authority checks or budget locking must make the corresponding test fail.

## Ordered implementation slices

| Slice | Red test written first | Implementation | Exit gate |
| --- | --- | --- | --- |
| 1. Passkey execution compatibility | A real WebAuthn assertion cannot currently authorize a Center SafeOp because owner envelopes accept only EOA signatures | Extend shared owner encoding/verification for the reviewed contract signer; verify exact Safe7579/EntryPoint behavior and bounded verification | Real cryptographic signature executes the intended payment through pinned contracts; wrong challenge/key/chain/window, missing user verification and malformed envelopes fail |
| 2. Stable account bootstrap | Concurrent enrollment or a new credential creates duplicate or inconsistent wallet/account records | Durable wallet-to-chain-account mapping, credential proof bound to exact initialization, idempotent sponsored creation and canonical binding | One canonical account under retries/concurrency; process death around broadcast preserves recoverable state; no server-owned interim account |
| 3. User-controlled recovery | A second independent credential cannot regain the same account or safely remove lost authority | Owner-approved backup enrollment and rotation, exact state validation, authority invalidation and portable public account descriptor | Same address survives rotation; stale credentials fail; withdrawal through an alternate client works with Center API and domain offline |
| 4. Allowlisted shared access | Money cannot connect Beep's existing wallet; spoofed or removed origins are treated as trusted | Reuse the existing environment allowlist; authenticated Center session plus one-time PKCE handoff; app-bound short-lived API access | Beep and Money resolve the same selected account without per-site consent; code replay, origin spoofing and removed-app access fail |
| 5. Center payment review | The app can change a reviewed amount, account or call sequence, or a lost response starts another payment | Isolated Center review, exact signature binding, durable operation references and bounded relay/reconciliation | Each accepted signature matches displayed calls; retries recover the original operation; onchain success and product fulfillment remain distinct |
| 6. Beep and Money integration | The two apps disagree on account identity, balance destination, approval or receipt state | Shared connector/client methods; replace Para-specific coupling in the new path; keep existing wallets and legacy Para accounts working | Real Beep invoice paid, correct project tokens/credits delivered, Money sees the same account; no duplicate invoice fulfillment or silent new wallet |
| 7. Native and device continuity | Browser-to-native sign-in, app return, credential recovery or interrupted payment loses the account/operation | Native associated-domain and credential integration using the shared protocol; resumable invoice/operation links | Physical iPhone and Android browser matrix passes; native iOS and browser resolve the same account; no popup/cookie assumptions |
| 8. Pressure and rollout | Multi-process load violates nonce uniqueness, quotas, revocation, or recovery guarantees | Fix measured bottlenecks and missing admission bounds; per-app budgets, metrics and rollout controls | Pressure gates below, external review/remediation, limited funded acceptance, then controlled rollout |

Slice 1 is a decision gate. If the selected Safe stack cannot verify the reviewed signer with the necessary guarantees, document the exact failure and choose a versioned account-stack revision before building dependent flows. Do not relax validation to force compatibility.

Recovery is a deposit gate, not a post-launch enhancement. Baseline proposal is an independently controlled backup credential or external-wallet owner. Guardian recovery, if needed to meet the consumer experience, requires an explicit threshold/delay/cancellation design and its own reviewed implementation. Email support cannot silently become wallet ownership.

## Pressure test contract

Initial acceptance targets below are engineering targets to validate and adjust with evidence, not current capacity claims. Fix and record machine size, service replica count, PostgreSQL version/pool size, RPC limits and fixture size in every report. Begin with 10,000 wallet records and two service replicas sharing PostgreSQL; neither auth nor replay protection may depend on process-local state.

| Workload | Target and required result |
| --- | --- |
| Steady local API traffic | 100 authenticated reads/s plus 20 session/grant mutations/s for 30 minutes; p95 <= 500 ms and p99 <= 1 s for routes without upstream calls; <0.1% unexpected errors |
| Burst and admission | 10x offered traffic for 60 seconds; bounded queues, explicit 429/503 responses with retry guidance; no unauthorized successes, process crash, or unbounded database wait; return to steady target within 60 seconds |
| Replay and idempotency races | 100 concurrent copies of each enrollment/code exchange/signed request/payment attempt across both replicas; exactly one state transition per single-use authority and no duplicate broadcast caused by retries |
| Sponsorship contention | Concurrent requests competing for the last available budget unit across apps and replicas; zero overspend, no cross-app budget borrowing, and correct reservation release/settlement after crashes |
| Authority changes under load | Remove an app, revoke a session or rotate a credential while reads/plans/submissions are active; new unauthorized admissions fail after the committed authority change; distinguish already signed onchain operations |
| Process and database failure | Kill each replica after durable preparation, before/after broadcast and before response; simulate database timeouts and failover; recover the original operation without loss or duplicate payment |
| Provider degradation | RPC/bundler/paymaster latency, disconnects, malformed replies, 429s and divergent chain evidence; bounded deadlines/concurrency, no false success, and no retry storm |
| Soak | Two hours at steady workload with periodic failures; no monotonically growing queues, retained secrets or unbounded storage; after cleanup, memory settles within 20% of post-warmup baseline |

Execution capacity is measured separately from local session/read capacity. Start with five prepared operations/s against local pinned contracts and a deterministic provider harness; measure preparation, simulation, submission and confirmation separately. Real-provider pilot throughput is constrained by the actual plan/quotas and must be measured before publishing an end-to-end capacity claim. Human biometric time and chain confirmation time are reported separately from service processing latency.

Security invariants have zero tolerance even during overload. Expected admission rejections are reported separately from unexpected failures. A load generator must have its own CPU headroom; report offered, admitted and completed rates, not just a request count.

## Release evidence and stopping conditions

Each slice lands with its tests, protocol/client documentation, compatibility notes, and recovery behavior. Run the focused red/green loop on each change and the complete release suite at integration boundaries. Required PostgreSQL, cryptographic and execution tests cannot be silently skipped.

Before a limited production rollout, require reviewed contract/authority changes, remediated findings, real device acceptance, measured pressure results, verified recovery and migration, and a runbook for service/provider failure. Record versioned artifacts and exact commands/results in a checked-in report without credentials or user data.

Use unfunded/fork accounts until the recovery and signing gates pass. Before moving any existing customer wallet, verify its actual owners/modules and collect exact current-owner authorization. Keep the same Safe address where supported; otherwise expose an explicit migration including nontransferable positions. Do not infer authority from matching emails.

Rollout controls can disable new enrollment or app admission and stop sponsorship. They cannot undo an onchain ownership change or invalidate a previously valid signature. Maintain account discovery, receipt recovery and the independent exit path during rollback. A funded deployment/migration is a separate concrete operational step after this implementation plan.

## Deliverables and estimate

Deliverables: versioned Center wallet protocol and connector, passkey account manifest, durable enrollment and shared sessions, isolated review, recovery/exit tooling, Beep and Money integrations, native continuity, migration tooling, pressure harness/report, and operating runbook.

Planning estimate for 2–3 experienced engineers: 1–2 weeks for baseline and compatibility evidence; 6–10 weeks for the web wallet, recovery and two-app vertical slice; another 4–8 weeks for native completion, pressure hardening, migration and review remediation. Some work overlaps, and external review scheduling is additional. Re-estimate after slice 1; these are estimates, not a release promise. The deliverable is complete only when its acceptance evidence exists.
