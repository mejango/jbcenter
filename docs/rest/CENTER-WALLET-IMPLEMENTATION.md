# Shared wallet implementation record

Implementation started from Center main `d5ec4af1877cca8d1dda806cdd217aa18b16b3b6` in the isolated `feat/shared-passkey-wallet` worktree. An inventory of local branches and worktrees confirmed that existing Center source work was already represented on main, including squashed deployment and sponsorship changes. Historical dev ancestry does not need merging. No remote push or production activation accompanies this checkpoint.

This is an experimental Base account profile and its verification foundation. It is not yet a usable shared wallet. The [strategy](CENTER-WALLET-PLAN.md) and [specification](CENTER-WALLET-SPEC.md) remain the delivery contract.

## Implemented boundaries

| Area | Working behavior | Remaining boundary |
| --- | --- | --- |
| Required observations (W0) | Node 22.16+, writable PostgreSQL 16, pinned Foundry and nonempty required suites with no skips. Atomic reports, redacted bounded logs, child deadlines and source fingerprints. | A successful focused test or preflight is not the complete gate. Read the report for the tested commit. |
| Cryptographic experiment (W1) | Actual upstream P256/FCL signer, Safe 1.4.1, Safe7579, EntryPoint 0.7, separate SafeMessage/SafeOp preimages, bounded dynamic owner signatures and negative vectors. | Local Cancun/native-value execution does not prove Base provider admission, V6/USDC payments or device compatibility. |
| Account authority (part of W2) | Explicit `center-passkey-v1`, one immutable passkey signer plus one EOA, threshold one, Base Safe as stable API principal. Canonical runtime/configuration evidence, deployed-wallet setup and rotation reject stale authority. | Backup ownership and operational independence need enrollment proof; a code-free address alone proves neither. No production manifest selects this profile. |
| Operation preparation/submission (part of W2) | Bounded maximum assertion for estimation, distinct signing view, exact contract-owner verification and unchanged approved operation fields. Legacy EOA/session paths keep their existing meaning. | Browser policy and durable ceremony consumption must be connected before this is a browser wallet. Actual provider acceptance remains its own observation. |
| Assertion verification (part of W3) | Genuine P256 verification with exact raw signed JSON, expected RP/origin/challenge, UP/UV, credential/user handle, backup flags and byte limits. Synced counters are observed without requiring monotonic nonzero values. | No credential registration/attestation parser, identity registry, browser session or one-use challenge enforcement is implied by this pure function. |
| Ceremony persistence (part of W3) | PostgreSQL transactions, exact replay/conflict decisions, database-clock expiry, bounded retained receipts and two real process crash/race tests. | A consumed challenge is a receipt, not a payment dispatch or session. Enrollment and operation services must connect their own durable transitions. Capacity and recovery admission need application-level controls and pressure qualification. |
| Deployed-wallet setup (part of W2/W4) | Versioned SafeMessage approval and separate browser-key proof reuse atomic account/binding/grant storage. Real EVM setup and backup-owner rotation preserve the same Safe identity. | No public setup endpoint, registration or sponsored first deployment is enabled. |

The pilot recovery configuration grants either owner full authority. Direct Safe withdrawal of its native balance works in the local experiment with Center unavailable and EntryPoint, adapter, signer and verifier code unavailable. It does not recover an EntryPoint deposit while EntryPoint is absent and does not establish consumer backup possession or usability.

## Gate A status

| Question | Status and evidence |
| --- | --- |
| Exact signature paths | Local cryptographic proof passes. TypeScript assertion/codec output executes against pinned contracts on Anvil; Foundry adds 256 real P256 challenge-substitution cases. See [stack evidence](../../src/rest/smartAccounts/stack/passkey/README.md). |
| Complete account model | Deployed account identity, setup and rotation pass locally. First deployment remains pending: the tested signer exists before Safe validation. Counterfactual signer creation must be proven without assuming hosted bundler admission or weakening creation provenance checks. |
| Sponsorship fit | Payload bounds, real FCL execution and local EntryPoint behavior are measured. Live Base bundler/paymaster acceptance and fee behavior are pending. |
| Device and origin fit | Pending. `wallet.juicebox.center` remains a proposed production origin/RP. The available paired iPhone was not reachable; no physical Safari/Android/native observation was obtained. Existing Beep native associations still target Para. |
| Independent exit | Local native-balance withdrawal and same-address owner replacement pass. Consumer recovery selection, independent possession and physical-device loss/restore remain pending. |

Gate A is not fully accepted. No durable production passkey, real deposit, migrated Para account or native compatibility claim follows from these tests.

## Observability loop

Run [the required gate](CHECK-OBSERVATIONS.md) with Node 22, pinned Foundry and a disposable PostgreSQL 16 database:

```sh
npm run check:preflight
npm run check
```

The command prints `.generated/checks/<run-id>/summary.json`. Inspect its result, revision, dirty state, source attribution, individual step results and required-suite counts. The source must remain frozen during a full run. Logs and reports are ignored local artifacts; no secret environment values belong in committed fixtures. Read the failed step, reproduce the failure in its focused suite, fix it, then rerun the affected checks and the integration gate.

Behavioral failure evidence includes the legacy EOA envelope rejecting contract signatures, incorrect base64url padding rejected by the actual upstream signer, legacy onboarding-method substitution rejected by the new profile, the old PostgreSQL authorization constraint rejecting the new explicit method, quota contention and process death. The signature ordering guard was removed in an isolated mutation copy; two tests then failed. These establish specific assertions, not complete test-suite mutation coverage. Initial missing-import failures are not counted as behavioral proof.

Two actual child processes exercise transaction rollback before commit and recovery after commit when the response is lost. Actual invalid EntryPoint submission is checked for no payment, deposit debit or nonce consumption. A local simulation alone is not recorded as a submitted transaction.

## Next dependency

Resolve first deployment before exposing enrollment: reproduce the absent-signer failure, prove an atomic initializer with exact source/runtime pins, choose the existing relay or a demonstrably supported bundler route, and preserve canonical creation provenance. Then connect the credential/enrollment registry, ownership possession proof and ceremony records to the same durable deployment identity.

Shared Center login, trusted allowlist activation, PKCE app handoff, exact review UI, the shared connector, Beep/Money payments and native integration remain subsequent work. The strategy's sustained/burst/soak targets have not been run; concurrent correctness tests establish no throughput or production capacity claim. Keep legacy Para and external-wallet behavior available while these gates are completed.
