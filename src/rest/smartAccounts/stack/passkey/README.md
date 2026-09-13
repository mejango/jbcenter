# Passkey compatibility experiment

This package proves the first shared-wallet cryptographic gate against the pinned Center Safe7579 stack. It remains an experimental, undeployed profile. No production signer or factory address is selected by these artifacts.

Run from the repository root:

```sh
node src/rest/smartAccounts/stack/passkey/verify.mjs
```

The existing execution gate installs Solidity 0.8.26 through its current Pimlico compiler project. `CENTER_PASSKEY_SOLC` can select an already installed binary; verification requires an exact official macOS/Linux checksum. `FORGE_BINARY` selects the pinned Foundry v1.7.0 executable. `CENTER_PASSKEY_REPORT` optionally selects an atomic JSON observation file.

The verifier checks the vendored source closure, audit comparison record, existing stack artifact hashes and exact compiler binary. It freshly rebuilds the upstream contracts, compares complete ABI/bytecode/compiler metadata to the reviewed artifacts, then requires every Foundry test to pass with at least 256 real P256 fuzz cases. It never regenerates reviewed artifacts during verification. To deliberately rebuild artifacts for review:

```sh
node src/rest/smartAccounts/stack/passkey/compiler.mjs --update-reviewed-artifacts
```

## Source and compiler

The immutable per-credential signer factory/proxy/singleton and FCL verifier are unmodified from Safe's `passkey/v0.2.1-1`, commit `dfd3b05966e727dbb7a2fdeef52e4b230f63304e`. All twelve Solidity source files are byte-for-byte identical to Certora's final audit commit `c3a4d0671099c5e17fda7287b764b93f6b9801df`; [the comparison record](evidence/audit-source-comparison.json) includes both hashes. The audit covers the upstream contracts; the Center integration requires its own review. FCL's upstream pin is `76f3f135b7b27d2aa519f265b56bfc49a2573ab5`.

Compilation matches the upstream settings: Solidity `0.8.26+commit.8a97fa7a`, Paris target, optimizer enabled with 10,000,000 runs, via IR. The FCL verifier has the upstream `viaIR: false` override. [The manifest](manifest.json) records source and official compiler hashes. The vendored LGPL-3.0 license and incorporated GPL-3.0 terms accompany the source. Artifacts with immutables contain runtime templates, not deployed runtime hashes; deployed code must be inspected with its actual immutable configuration.

## Evidence

The 24 Foundry tests execute real FCL verification, real immutable passkey signers, SafeL2 1.4.1, the pinned Safe7579 adapter/launchpad, the dormant SmartSession validator installed by Center creation, and EntryPoint 0.7. The authenticator is simulated with public fixture keys. No verifier is mocked.

Coverage includes:

- Both signer ERC-1271 selectors; separate SafeMessage and SafeOp preimages; exact TypeScript WebAuthn verifier output accepted by Solidity.
- Canonical EntryPoint receipt identity, native-value payment effect, expiry, replay, changed amount/validity, wrong key, missing UV, cross-chain and cross-Safe substitution.
- Invalid dynamic owner offsets, excessive inner-assertion padding, duplicate setup owners and duplicate signatures against a two-owner threshold.
- Real FCL fallback when the precompile is unavailable, maximum supported assertion size, and 256 real P256 challenge-substitution cases.
- Backup EOA withdrawal of the Safe's native balance with EntryPoint, adapter, signer and verifier code unavailable; direct owner rotation preserving the Safe address and invalidating the removed signer.

The [latest local observation](evidence/local-compatibility.json) contains actual measured gas and calldata. The representative assertion produces a 429-byte SafeOp signature and 437-byte SafeMessage signature. The maximum supported 2,048-byte client JSON produces a 2,240-byte signer body and 2,349-byte SafeOp signature. The maximum fixture completes within the locally tested 800,000-gas bound. These measurements use a prefunded Safe and EntryPoint deposit, native value, no paymaster and the Cancun local EVM. They establish no V6/USDC payment, production gas price, live Base deployment, precompile availability, bundler/provider acceptance or physical-device behavior.

The [first cryptographic red run](evidence/red-first.json) exposed a real serialization mismatch: Foundry's base64url helper retained `=` padding, while the upstream WebAuthn library reconstructs an unpadded challenge. Correcting the simulated authenticator's exact signed JSON made the positive cases pass without modifying upstream code.

## Admission and recovery boundaries

Tests deliberately demonstrate that upstream Safe accepts unused trailing owner-signature bytes, and the signer accepts a valid UV-only assertion without UP, arbitrary signed origin fields, and both P256 `s` representatives. Center's strict codecs and trusted WebAuthn policy enforce canonical envelopes, UP, expected RP/origin, challenge binding and bounded bytes. The server must still atomically consume unexpired, purpose-bound challenges. Chain signature validity alone grants no login session and supplies no offchain replay policy.

The tested recovery configuration is one passkey plus one independent EOA, threshold one. Either credential has complete authority. The withdrawal experiment recovers the Safe's native balance; it does not recover the separate EntryPoint deposit while EntryPoint code is absent. It proves neither consumer possession of an independent backup nor physical-device recovery. Public funding remains gated on the selected consumer recovery path and production observations in the shared-wallet plan.
