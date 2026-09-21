# Current Pimlico V7 guard package

This package adds `CenterSessionGuardV2` for Pimlico's reviewed current V7 deployment at
`0x777777777777AeC03fd955926DbF81597e66834C`, with runtime hash
`0x337b6e1b6c2167c0528c5240c028ead407c673595b2820029b69741b76d98fbc`.
The original stack contract, artifacts and manifest retain their existing identities.
The V2 guard artifact is undeployed; local build and test evidence does not establish a live
guard installation or authorize a new session.

The guard accepts exactly 130 bytes of `paymasterAndData`: the EntryPoint v0.7 52-byte header,
one flags byte, two six-byte validity fields and a 65-byte sponsor signature. In the reviewed
current source, `mode = flags >> 1`. Flags `0x00` and `0x01` select gas-only mode zero; the low
bit controls whether the paymaster permits any bundler. Every flag from `0x02` through `0xff`
is rejected. The exact address and runtime are mandatory both when configuring the guard
and when validating operations. See [PAYMASTER-SOURCE.md](PAYMASTER-SOURCE.md) for deployed
source reproduction and [paymaster-manifest.json](paymaster-manifest.json) for its separate pins.

`Config` retains the original nine-word, 288-byte ABI. The `_states` mapping stays at slot
zero with keys `id`, `multiplexer`, then `account`. Config occupies relative slots 0–7;
`maximumCalls` and `maxPaymasterDataLength` share slot 7. Gas, cost and call counters occupy
relative slots 8, 9 and 10. [guard-storage.json](evidence/guard-storage.json) contains the
compiler-produced layout and its checked interpretation. Counter charging includes both
account gas limits, pre-verification gas and both paymaster gas limits, multiplied by raw
`maxFeePerGas` for conservative maximum prefund. Existing time, action and value policies
remain required parts of an owner-authorized session.

Run from the repository root:

```sh
node src/rest/smartAccounts/stack/current-pimlico/verify-guard.mjs
forge test --root src/rest/smartAccounts/stack/current-pimlico
forge test --root src/rest/smartAccounts/stack
```

The guard verifier independently compiles in a temporary directory using Solidity
`0.8.28+commit.7893614a`, Cancun, optimizer 200 and no bytecode metadata hash. It verifies
the committed creation/runtime bytecode, source hash, compiler output identity, ABI,
compiler storage layout and independent guard manifest. It compares shared wire methods
with the original guard artifact. `--write` deliberately regenerates only the new guard
artifact, storage proof and guard manifest; reviewed host pins require a separate update
after any intentional change.

All 35 tests pass: 20 unit tests (including four fuzz tests with 256 runs each) and 15
full-stack tests. The original stack's 18 tests also pass without changes.

The unit suite uses the reproduced current paymaster runtime and tests both gas-only flags,
all other flags through fuzzing, exact lengths, address and runtime changes, canonical
execution, fee/gas limits, cumulative budgets, namespaces and actual storage slots. The
full-stack suite uses the committed EntryPoint, Safe, Safe7579, SmartSession, validator and
policy bytecode together with the reproduced current paymaster creation code. It installs
the session through a local owner signature and signs sponsorship with a local test key.
The paymaster is etched at its required address; one local AccessControl admin slot is
bootstrapped because etching does not run its constructor, then its real methods configure
the local signer and bundler. The terminal is a V6 `pay` ABI fixture that observes payer and
value. Local owner-installed sessions use no attester requirement, so these fixtures do not
establish a production module attestation. These tests execute locally and perform no network
transactions.

Successful operations charge the sponsor deposit and preserve the Safe's gas deposit at
zero. Reverted actions retain validation counters and sponsor gas charges, while reverted
`handleOps` transactions roll counters back. The pinned SmartSession propagates guard
failure as `PolicyViolation`, which Safe7579 wraps and EntryPoint reports as `AA23 reverted`;
the negative integration tests check this account-validation failure before sponsor validation.
