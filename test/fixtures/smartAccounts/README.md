These fixtures contain ABI and runtime bytecode extracted from the reviewed
SmartSession and policy compiler artifacts. Each JSON retains its original
artifact digest and source provenance. The test also checks the expected runtime
hash independently before installing that runtime in a fresh local Anvil chain.

- SmartSession: `rhinestonewtf/smartsessions` commit
  `f24dddfcbf7269e10dcd4da90dae0a6ae6ccf188` (AGPL-3.0-only).
- TimeFramePolicy, UniActionPolicy and ValueLimitPolicy:
  `rhinestonewtf/smartsessions` commit
  `75279a6c80ad50ea623d06954e9d71ab753e8a52` (MIT).
- OwnableValidator: the independently reproduced legacy runtime from
  `rhinestonewtf/core-modules` main source commit
  `ff742c54eb6afead7e944352cc86973090462598` (AGPL-3.0-only), with the verified
  compiler input digest recorded in its fixture. This version validates session
  signatures using the Ethereum signed-message prefix.

The CenterSessionGuard test reads the repository's current built artifact from
`src/rest/smartAccounts/stack/artifacts/CenterSessionGuard.json` directly. It is
deployed only to the test EVM at a local fixture address.

Run `vitest run test/rest-smart-accounts-policy-evm.test.ts` with `anvil` on PATH,
or set `ANVIL_BINARY` to its executable. The suite skips when Anvil is unavailable.
It uses a temporary loopback port and has no remote RPC configuration or fork.

Evidence covers actual policy and validator EVM execution, compiler encoding,
private storage layouts, signature checking, counter updates, and removal plus
enable-nonce revocation. Account calls are locally impersonated at the validator
boundary. This suite does not establish Safe owner activation, target execution,
EntryPoint rejection after expiry, or successful gas sponsorship. The mandatory
sponsor test uses an existing policy's real code hash only as an identity fixture;
it does not treat that policy as an ERC-4337 paymaster.
