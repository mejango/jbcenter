# Continue the Center wallet delivery

Snapshot: 2026-09-15 UTC, updated after the hosted Base creation slice. Read this first, then the
[delivery report](CENTER-WALLET-DELIVERY.md). Open deeper references only for the
slice you are implementing. Older documents contain historical plans as well as
completed checkpoints; source and the latest evidence decide current status.

## Objective and authorization

Deliver production passkey signup **for people without an existing wallet**,
same-wallet recovery, and the shared Center connection on **Homerun and Beep**.
Use TDD, review and an observable test loop. Finish the hosted journey rather
than repeating already-passed localhost passkey probes.

- The user explicitly approved **Center remote-main pushes**, as well as Beep
  and Homerun main merges/pushes and the production pilot. Do not ask again for
  that permission. Review and run appropriate release checks before shipping.
- **Do not modify Juicebox Money or Revnet Money.** Center retains Para alongside
  passkeys. Preserve external-wallet support in the pilot clients.
- Use the shared Center origin allowlist. Bind each app request/callback
  cryptographically; do not introduce an extra per-site consent workflow.
- Use **Center's Dwellir APIs** for chain RPC. No public RPC fallback.
- Passkeys first; recovery kit for new users, existing recovery wallet optional.
  WhatsApp is deferred. Fresh exact owner approval is required for spending.
- The user authorized continued reviews with the real **Claude Fable 5.1** CLI.
  Label these model-assisted reviews, not independent audit certification.
- Tell the user when a concrete gas funding request or a working hosted device
  test is ready. Do not request funds before the address, budget and reviewed
  dispatch behavior exist. Do not turn flags on to expose an incomplete route.

## Current state: start here

Application source on Center main is
`ac6e48d52fb43d5c90205e9892fff4ccaa011484`; the handoff is a later documentation
commit. That application revision passed 4,583 checks with zero failures/skips,
and [remote CI succeeded](https://github.com/mejango/jbcenter/actions/runs/34921022953).

**Hosted Base creation is implemented but not yet configured; hosted recovery is
not.** [src/index.ts](../../src/index.ts) mounts the wallet site when `WALLET_ORIGIN`
is set and hosted creation only when every `WALLET_CREATION_*` setting is present
(see [WALLET_SIGNUP.md](../../WALLET_SIGNUP.md), "Composition and observation").
Center's Railway environment has none of these yet; no treasury key or funding
exists. The creation host ([baseHost.ts](../../src/rest/wallet/baseHost.ts)) composes
[deploymentBase.ts](../../src/rest/wallet/deploymentBase.ts) over the generic
[deploymentTransport.ts](../../src/rest/wallet/deploymentTransport.ts) and
[deploymentSettlementObserver.ts](../../src/rest/wallet/deploymentSettlementObserver.ts);
migration 034 admits the `base-mainnet` environment, the reserved Base admission,
complete `base-fjord-jovian-receipt-v1` fees and the `allocation-exceeded` fence.
Recovery still has only the local Anvil relay
([recoveryLocalAnvil.ts](../../src/rest/wallet/recoveryLocalAnvil.ts)).

Local signup, recovery and app handoff are implemented and tested against
PostgreSQL, Chromium and unforked Anvil. Shared dependency deployment is complete
on eight chains. The new Base receipt verifier/observer is on main, but no
production creation/recovery adapter consumes it yet. DNS and TLS for
`wallet.juicebox.center` were verified; its last observed `/wallet` response was
503 setup-unavailable. Recheck deployment identity before changing hosting.

## Repository map and local changes to preserve

| Repository/worktree | Snapshot | Instruction |
| --- | --- | --- |
| `/Users/jango/Documents/jb/v6/evm/extensions/jbcenter` | Center canonical main | Fetch/check current HEAD; handoff docs are pushed here |
| `/private/tmp/center-wallet-base-adapters` | `feat/wallet-base-adapters`, same application base plus these docs | Current documentation worktree; reuse or create an isolated next worktree |
| `/Users/jango/Documents/jb/v6/evm/extensions/homerun` | main/origin `6bb9f9c9b8583a366f9683aa1db9b625f3084d96` | Preserve modified `README.md`, `src/components/CreateFlow.tsx`, `test/create-browser.mjs`; these are unrelated user work |
| `/Users/jango/Documents/cocopay/beep` | main/origin `c672751c41428312dde45037ec6b6f5d5ffe28d0` | Preserve modified `ARCHITECTURE.md`, `README.md`, and untracked `CENTER-WALLET-PLAN.md`, `CENTER-WALLET-SPEC.md` |

Read each repository's `AGENTS.md`. Center requires the pinned Ponytail workflow.
Keep edits isolated; never stage another worktree's dirt. The client SDK tarball
and SHA256 are recorded in the delivery report. Both clients have the latest
app-bound launch integration, with passkey activation off.

Other work worth preserving, without merging blindly:

- `/private/tmp/center-wallet-admission`, branch `feat/wallet-admission`, base
  `c11d471`: untracked `src/db/lanes.ts`, `src/db/admissionPool.ts`, and
  `test/database-admission-postgres.integration.test.ts`. Four real PostgreSQL
  tests passed. It is not wired into runtime or release-qualified. Review before
  reuse; this prototype is not a prerequisite for understanding signup.
- `/private/tmp/center-wallet-publication-review`, revision
  `94d89f6209cd755d7f9020e5bc778f8a21fc122d`: preserve this exact audited operator
  checkout and its dependency journal. Do not modify/reinstall or rerun funding.

## Completed slice: hosted Base creation (revision 516d163)

Evidence: `~/.juicebox-center/wallet-dependencies/reviews/516d163/base-creation-adapter/`
(release check `2026-09-15T03-25-19.016Z-49f2e259`, 181 files / 4,139 service tests,
all steps passed on clean source; Fable review prompt and output). Tests:
`rest-wallet-deployment-base-boundaries`, `-base-postgres.integration`, `-base-anvil`,
`rest-wallet-signup-base-postgres.integration` (two users through reserved admission,
one send each, complete-fee settlement, next-user admission) and
`rest-wallet-base-host-postgres.integration` (runtime host initializes accounting once
with the explicit first nonce and refuses a mismatching one). The Base-shaped fixture
(`test/fixtures/wallet-base-anvil.ts`) runs the unforked Safe stack behind a proxy that
presents the public fee predeploys, a Jovian attributes deposit at index zero of every
block and receipt L1 fees priced from those attributes. It is not a Base provider.

Design decisions to keep: the Base environment identity is the chain (genesis); the
pinned L1Block/GasPriceOracle implementation runtimes are checked on every observation
and at the inclusion block, failing closed on a later upgrade. A reservation is
execution maximum plus twice the current L1/operator estimate and is not a cap; an
actual finalized debit above the allocation is recorded and fences the pool. The
chain nonce versus accounting `nextNonce` is the restore fence. The shared
funding-evidence lifetime bound is 60 s (local producers keep 5 s). Single lane held
to finality remains the pilot throughput limit.

## Completed slice: hosted Base recovery

The shared relay ([recoveryRelay.ts](../../src/rest/wallet/recoveryRelay.ts)) now takes
the same chain adapter as creation; [recoveryBase.ts](../../src/rest/wallet/recoveryBase.ts)
and `createBaseWalletRecoveryHost` compose it, and migration 035 admits the
`base-mainnet-recovery-v1` lane with a monotonic actual spend and the
`allocation-exceeded` fence. The joined Base test recovers a Base-created wallet through
the relay with a lost accepted reply, a process kill before activation, old-credential
rejection, finality-gated lane settlement with complete fees, and a chain rollback that
fails closed. `WALLET_RECOVERY_*` settings mount it; the relay key must differ from the
creation treasury.

## Next: production configuration and the pilot

Prepare two Base keys (creation treasury, recovery relay) and budgets, then the user's
funding decision. Measure Dwellir admission latency against the 5 s admission lifetime.
Begin by reading
[WALLET_SIGNUP.md](../../WALLET_SIGNUP.md), the
[deployment strategy](WALLET-DEPLOYMENT-STRATEGY.md),
[Base fee notes](../../src/rest/wallet/stack/baseFees/README.md), and the following
source. Avoid restarting the cryptography or SDK design.

| Source under `src/rest/wallet/` | Boundary to preserve or extend |
| --- | --- |
| `signup.ts`, `recoveryLocalAnvil.ts` | Resumable composition, separate fresh proofs, exact recovery signer-creation/owner-swap order; local-only settlement assumptions |
| `deploymentPostgres.ts`, `deploymentDispatch.ts` | Permanent sender/nonce, immutable winning signed bytes before send, durable attempt before physical send, leases and unknown-outcome retention |
| `deploymentObservation.ts`, `deploymentChain.ts` | Latest canonical readiness separate from retained historical evidence and treasury finality |
| `deploymentSettlement.ts`, `deploymentSettlementLocalAnvil.ts` | Current local-only accounting types; extend deliberately for complete Base costs instead of casting local evidence as Base |
| `baseReceiptFees.ts`, `baseFeeObservation.ts`, `operationRpc.ts` | Exact signed-envelope fees, inclusion/attributes binding, shared bounded reads and final recheck |

Add behavioral failing cases at the real boundary, then implement the smallest
shared change. The first acceptance case should demonstrate actual production
composition reaching a durable, exactly identified creation operation and its
complete settlement evidence under controlled RPC fixtures. Join real Base
provider observations and a funded canary only after review and funding policy.
Recovery must then demonstrate replacement login to the same Safe and rejection
of the previous credential across uncertain replies and restart.

Known design constraints:

1. Current deployment migrations 016/026/034 select one exclusive pool and one
   unsettled operation. The lane stays held until finality. Signup now opens
   after latest canonical creation, but the next user can still wait for that
   lane. Choose a bounded, reviewed nonce pipeline or another explicit design;
   never silently discard liabilities to increase throughput.
2. Type-2 maximum execution fees do **not** cap future Base L1/operator fees.
   Estimate plus margin is a reservation, not an enforceable chain cost ceiling.
   Migration 034 now records `spent > allocation` behind the `allocation-exceeded`
   fence. A sender's balance is not immutable, and one nonce does not mean one
   sender transaction per block.
3. A database cannot prove it has not been restored to an earlier snapshot. The
   sender's chain nonce is the external fence: claim, admission and settlement all
   require it to equal accounting `nextNonce`, and initialization requires the
   explicit `WALLET_CREATION_INITIAL_NONCE`. A restore therefore stalls closed; an
   operator must inspect and re-pin before any new claim.
4. Local recovery has a separate treasury sender, fixture-only budget and locks
   across bounded RPC work. Reassess those assumptions for hosted DB pressure.
5. The Base settlement producer binds finality, the pinned runtimes at the inclusion
   block and the durable operation before consuming fee output. Admission on Dwellir
   must complete within the 5 s admission lifetime; measure this on the real provider
   before the pilot and widen only with review.
6. Read the actual Base chain configuration, not a generic OP schedule. The
   preserved source pin includes Jovian and later Base-specific upgrades.

The new [source evidence bundle](evidence/wallet-delivery-2026-09-15/README.md)
preserves exact compiler/source hashes, observed runtimes and the successful
three-contract full-byte rebuild. The complete compiler inputs/outputs are in
the durable archive specified there. This work is done; do not repeat the source
search or download a compiler unless needed to reproduce it. The runtime
reconstruction itself still needs review and integration.

## Other launch blockers to retain

- **Application Relayr quote binding:** `src/rest/sponsorship/provider.ts`
  `parseQuoteBinding` maps returned UUIDs by array position. Actual Relayr POST
  UUID order differs from request order. `sponsorship/service.ts` durably settles
  that quote before exact echo checks. Reuse the independent operator's GET
  echo/bijection approach before payment activation; do not reinterpret existing
  immutable commitments. Keep sponsorship disabled until resolved.
- Complete the joined Homerun/Beep payment journey with actual provider
  acceptance. Contract math and local EVM tests alone do not qualify it.
- Public intake and authenticated control work still compete for capacity.
  Public IP headers or cookie presence are not proof for a privileged lane.
  Current refresh limits are 32 queued accounts, two concurrent observations and
  30 starts/minute. Cold wallet inspection was measured at 92 RPC calls; authority
  inspection at 86/87. Provider quota and active-user capacity need measurement.
- The current pressure diagnostic uses two initialized wallets and synthetic
  chain observations, with an optional 10,000-row inventory. It is not evidence
  for 10,000 active wallets or the sustained/burst/two-hour-soak targets.
- Homerun `src/providers/ExternalWalletDialog.tsx` still says “Connect your wallet”
  and “Choose your wallet.” Once signup works, improve first-time copy and enable
  the build-time configuration in `wallet-config.ts`. Missing/malformed manifest,
  issuer/audience or fee settings currently disable the integration.
- Device probes proved local passkeys on Mac Safari/Chrome and iPhone Safari.
  Production RP, iPad, sync, actual recovery and Beep native handoff remain. Ask
  for device interaction when the hosted flow is observable and ready.

## Funding and operational records

Shared dependencies are **already deployed**. See the
[rollout](WALLET-DEPENDENCY-ROLLOUT.md); do not redeploy or repeat its payments.
The Base manifest is `center-passkey-base-v1`, revision
`0xb7e29918ff85d6eb8b925a81bcc3259f2d1d83f22c92ea17bd912d65a3d64008`.
All 13 contracts matched; `dispatchEnabled` remained false.

The dedicated dependency payer is
`0x097334063a5c2505d8df1C660B996699c27E6Fd3`. Its unspent funds are not a newly
authorized runtime allocation. Do not reuse Beep deployment keys, invent a new
funding purpose or sweep leftovers. Prepare separate production creation/recovery
funding addresses and budgets when that implementation is ready.

Preserve the original unknown, unpaid mixed Relayr request
`0x2f8bfba5e4b707ddcd8891fcd59715d2f6575b6db146e63b94e75f1846fbdd05`.
Never delete its claim, pay it, or retry the POST blindly. Mainnet and testnet
finalized bundles are recorded separately in the rollout evidence.

Railway project `4a070739-bf7b-41f2-bdc1-fe6a77f98545`, environment
`f0adf022-61c8-4c3d-b60b-602f5328eb34`, Center service
`0236bff9-1d8f-494c-9445-b7549ae3d043`. Existing local CLI authentication is at
`/Users/jango/.railway/config.json`. Read credentials only in memory. Never dump
environment values, include provider keys in command arguments/logs, or commit
funding keys. Dwellir credentials already exist in Center's Railway environment.

## Checks, review and observation loop

Use Node 22 and Foundry. On this machine:

```sh
export PATH=/Users/jango/.nvm/versions/node/v22.23.1/bin:/Users/jango/.foundry/bin:$PATH
export TEST_DATABASE_URL=postgresql://center_wallet_test:center_wallet_local_test@127.0.0.1:55440/center_wallet_test
npm run check
```

The database above is the disposable local PostgreSQL 16 test container,
`center-shared-wallet-pg`. Confirm it is available. New worktrees need the root
and MCP dependencies installed. Run the complete release gate alone; simultaneous
heavy browser/Next/Forge builds caused avoidable fixture contention. Focused
checks come first; the required clean release report qualifies the code shipped.

Claude CLI: `/Users/jango/.local/bin/claude`, model `claude-fable-5-1`. Supply an
exact bounded review scope with files visible in its workdir. The last reviewer
could not read a prior report outside that workdir. Do not claim review of files
it did not see. Codex subagents had exhausted their usage allowance at handoff;
do not busy-retry that failure.

Record operation ID, phase/revision, public transaction hash, nonce reservation,
attempt outcome, canonical/finality status, fee completeness, RPC calls/deadlines
and queue/DB latency. Retain red/green failure evidence and reviewed source hashes.
Never log phrases, private keys, assertions, cookies or recovery/launch secrets.

Durable evidence lives under
`/Users/jango/.juicebox-center/wallet-dependencies/reviews/`, especially:

- `ac6e48d52fb43d5c90205e9892fff4ccaa011484/base-fee-observation-release/`:
  exact tested source, red/green/full-gate logs, two Fable reviews and live results.
- `ac6e48d52fb43d5c90205e9892fff4ccaa011484/base-runtime-source-rebuild/`:
  full public source inputs/outputs, verification records, Dwellir observations
  and inventory; compiler binary deliberately omitted.
- `55bd93be5be46fcd291e12f3019405e5d9756c7a/signup-inclusion-release/`:
  canonical signup-before-finality test and review evidence.

Keep the user informed about concrete completed milestones and what the next
test will resolve. A green test count, a deployed contract and an enabled
consumer journey are different claims. The finish line is a person starting
without a wallet, signing up on Homerun, reconnecting, recovering to the same
wallet and using the authorized Beep/payment paths with observed production
behavior and the agreed release gates satisfied.
