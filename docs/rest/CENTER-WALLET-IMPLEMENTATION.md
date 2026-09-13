# Shared wallet implementation record

Implementation started from Center main `d5ec4af1877cca8d1dda806cdd217aa18b16b3b6` in the isolated `feat/shared-passkey-wallet` worktree. An inventory of local branches and worktrees confirmed that existing Center source work was already represented on main, including squashed deployment and sponsorship changes. Historical dev ancestry does not need merging. No remote push or production activation accompanies this checkpoint.

This is an experimental Base account profile and its verification foundation. It is not yet a usable shared wallet. The [strategy](CENTER-WALLET-PLAN.md) and [specification](CENTER-WALLET-SPEC.md) remain the delivery contract.

## Implemented boundaries

| Area | Working behavior | Remaining boundary |
| --- | --- | --- |
| Required observations (W0) | Node 22.16+, writable PostgreSQL 16, pinned Foundry and nonempty required suites with no skips. Atomic reports, redacted bounded logs, child deadlines and source fingerprints. | A successful focused test or preflight is not the complete gate. Read the report for the tested commit. |
| Cryptographic experiment (W1) | Actual upstream P256/FCL signer, Safe 1.4.1, Safe7579, EntryPoint 0.7, separate SafeMessage/SafeOp preimages, bounded dynamic owner signatures and negative vectors. | Local Cancun/native-value execution does not prove Base provider admission, V6/USDC payments or device compatibility. |
| Account authority (part of W2) | Explicit `center-passkey-v1`, one immutable passkey signer plus one EOA, threshold one, Base Safe as stable API principal. Canonical runtime/configuration evidence, deployed-wallet setup and rotation reject stale authority. | Backup ownership and operational independence need enrollment proof; a code-free address alone proves neither. No production manifest selects this profile. |
| Atomic creation (part of W2/W4) | Explicit `center-passkey-bootstrap-v1` predicts the immutable signer and Safe, then creates both through exactly two initializer operations. Canonical inspection verifies the unique direct factory transaction, historical/current code and complete creation trace. Profile-specific checkpoints preserve original creation evidence through rotation. | The sponsored deployment relay, its durable nonce/budget reservations and enrollment admission remain to be connected. Generic MultiSend and EntryPoint-nested factory provenance remain unsupported by this profile. |
| Operation preparation/submission (part of W2) | Bounded maximum assertion for estimation, distinct signing view, exact contract-owner verification and unchanged approved operation fields. An estimate of the actual signed bytes must fit approved gas before the durable claim; its margin is not applied twice. Legacy EOA/session paths keep their existing meaning. | Browser policy and durable ceremony consumption must be connected before this is a browser wallet. Provider estimates are point-in-time observations, and actual provider acceptance remains its own gate. |
| Registration and assertion verification (part of W3) | Bounded none/ES256 registration parsing with directly pinned CBOR decoding, plus genuine P256 assertion verification with exact signed JSON, expected RP/origin/challenge, UP/UV, credential/user handle, backup flags and byte limits. Synced counters are observed without requiring monotonic nonzero values. | Registration produces an unproven candidate. A fresh possession assertion, durable credential/enrollment mapping and atomic ceremony consumption remain necessary. Neither pure function creates a session or account. |
| Ceremony persistence (part of W3) | PostgreSQL transactions, exact replay/conflict decisions, database-clock expiry, bounded retained receipts and two real process crash/race tests. | A consumed challenge is a receipt, not a payment dispatch or session. Enrollment and operation services must connect their own durable transitions. Capacity and recovery admission need application-level controls and pressure qualification. |
| Deployed-wallet setup (part of W2/W4) | Versioned SafeMessage approval and separate browser-key proof reuse atomic account/binding/grant storage. Real EVM setup and backup-owner rotation preserve the same Safe identity. | No public setup endpoint, registration or sponsored first deployment is enabled. |

The pilot recovery configuration grants either owner full authority. Direct Safe withdrawal of its native balance works in the local experiment with Center unavailable and EntryPoint, adapter, signer and verifier code unavailable. It does not recover an EntryPoint deposit while EntryPoint is absent and does not establish consumer backup possession or usability.

These rotation proofs reject removed onchain owners and old setup approvals. Revocation of existing browser grants and Center sessions on rotation belongs to W5/W6 integration; the stable Safe principal does not implement that revocation by itself.

## Gate A status

| Question | Status and evidence |
| --- | --- |
| Exact signature paths | Local cryptographic proof passes. TypeScript assertion/codec output executes against pinned contracts on Anvil; Foundry adds 256 real P256 challenge-substitution cases and atomic creation tests. See [stack evidence](../../src/rest/smartAccounts/stack/passkey/README.md). |
| Complete account model | Local atomic creation, canonical inspection, stable identity, deployed-account setup and rotation pass. The [bootstrap experiment](../../src/rest/smartAccounts/stack/passkey/bootstrap/README.md) selects a direct factory transaction for the next relay integration; the initial EntryPoint route exceeds the tested 500,000 verification-gas bound and has canonical mempool restrictions. Durable sponsored first deployment remains W4 work. |
| Sponsorship fit | Payload bounds, real FCL execution and local EntryPoint behavior are measured. Live Base bundler/paymaster acceptance and fee behavior are pending. |
| Device and origin fit | The required Chromium virtual-authenticator suite passes actual creation, parsed-candidate possession, discoverable user-handle matching and negative assertions. Physical compatibility remains pending. `wallet.juicebox.center` is still proposed; the paired iPhone was unreachable, no physical Safari/Android/native observation was obtained, and Beep's native associations still target Para. |
| Independent exit | Local native-balance withdrawal and same-address owner replacement pass. Consumer recovery selection, independent possession and physical-device loss/restore remain pending. |

Gate A is not fully accepted. No durable production passkey, real deposit, migrated Para account or native compatibility claim follows from these tests.

## Observability loop

Run [the required gate](CHECK-OBSERVATIONS.md) with Node 22, pinned Foundry and a disposable PostgreSQL 16 database:

```sh
npm run check:preflight
npm run check
```

The command prints `.generated/checks/<run-id>/summary.json`. Inspect its result, revision, dirty state, source attribution, individual step results and required-suite counts. The source must remain frozen during a full run. Logs and reports are ignored local artifacts; no secret environment values belong in committed fixtures. Read the failed step, reproduce the failure in its focused suite, fix it, then rerun the affected checks and the integration gate.

The observation runner now hashes actual file contents and modes against committed blobs, so Git clean filters and hidden index flags cannot conceal changes. Browser reports and screenshots are under `.generated/wallet-observations/browser-required/`; their tier explicitly excludes physical-device claims.

Behavioral failure evidence includes the legacy EOA envelope rejecting contract signatures, incorrect base64url padding rejected by the actual upstream signer, legacy onboarding-method substitution rejected by the new profile, the old PostgreSQL authorization constraint rejecting the new explicit method, quota contention and process death. The signature ordering guard was removed in an isolated mutation copy; two tests then failed. These establish specific assertions, not complete test-suite mutation coverage. Initial missing-import failures are not counted as behavioral proof.

Two actual child processes exercise transaction rollback before commit and recovery after commit when the response is lost. Actual invalid EntryPoint submission is checked for no payment, deposit debit or nonce consumption. A local simulation alone is not recorded as a submitted transaction.

The long-history test exposed an unpinned Anvil hardfork: its 32,000-block fixture spent roughly 115 seconds mining and 75 milliseconds inspecting. Selecting the same explicit Cancun target as the pinned contract proofs reduced mining to a few seconds. The 32,000 actual blocks, retained history, concurrency assertions and three-second inspector deadline are unchanged. This is a fixture correction, not a service throughput measurement.

## Next dependency

Connect the credential/enrollment registry, passkey and backup ownership proofs, and ceremony records to one fixed deployment identity before exposing enrollment. Candidate activation and one-use challenge consumption need the same PostgreSQL transaction. Then adapt Beep's prepaid direct-deployment relay behavior to Center's shared PostgreSQL nonce and budget locks, preserving signed bytes before dispatch and reconciliation after unknown outcomes. The local EntryPoint bootstrap experiment is not a hosted-bundler admission claim.

Shared Center login, trusted allowlist activation, PKCE app handoff, exact review UI, the shared connector, Beep/Money payments and native integration remain subsequent work. The strategy's sustained/burst/soak targets have not been run; concurrent correctness tests establish no throughput or production capacity claim. Keep legacy Para and external-wallet behavior available while these gates are completed.
