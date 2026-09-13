# Signed Base fee reference

This directory supports local differential tests for compression and fee arithmetic. It contains no production runtime pin, provider configuration, key, broadcast path or claim about future inclusion costs.

`LibZip.sol` is an unchanged MIT-licensed copy of Solady at commit `5315d937d79b335c668896d7533ac603adac5315`. The pinned Base FastLZ implementation names that Solady revision as its reference. `provenance-solady.json` records the exact download paths and SHA256 hashes; `LICENSE-Solady.txt` preserves the upstream license.

`BaseFastLz.rs`, `BaseL1FeeParams.rs` and `BaseL1Block.rs` are unchanged MIT-licensed source snapshots from [base/base at 9469da27403d6836634639b4899a6e4a0964720f](https://github.com/base/base/tree/9469da27403d6836634639b4899a6e4a0964720f). `provenance-base.json` records hashes, upstream paths, source lines and extraction details. `Base-LICENSE.txt` preserves the upstream license. These files provide reviewable source provenance; the test does not run Rust.

`base-vectors.json` preserves two full signed type-2 envelopes and independently published expected fees from the pinned Base source. The first compresses to 202 bytes and costs 2148 wei under its fixture parameters. The second preserves the legacy compatibility result 24681034813 wei (`0x05bf1ab43d`). Both contain chain ID 10 and are arithmetic compatibility vectors, not evidence of a current Base transaction or fee configuration.

`BaseSignedFeeReference.sol` is a small Center test wrapper, not an upstream GasPriceOracle artifact. It executes the unchanged Solady compressor and implements the pinned Fjord fee equation and explicitly selected Isthmus/Jovian operator equation using checked Solidity arithmetic. It accepts the **full signed envelope**, including the type byte and actual signature. It does **not** add the 68-byte padding used by the unsigned-transaction GasPriceOracle estimation path. Its gas-limit operator calculation represents maximum operator consumption at the supplied parameters; unused operator gas and final charged fees require separate execution-client evidence.

The integration test `test/rest-wallet-deployment-fees-anvil.test.ts` checks source and fixture hashes, compiles the wrapper and LibZip in a disposable directory, and installs the resulting runtime only on a private loopback Anvil. Compilation uses installed solc 0.8.26, Cancun, optimizer 200 runs, disabled metadata and offline mode. No compiler or dependency is downloaded by the test. It compares published expected outputs and real EVM results against the TypeScript calculator over exact signed Safe creation bytes, other payloads, alternative signatures, both operator profiles, integer boundaries, and compression inputs through 131072 bytes.

Run from the Center root:

```sh
npx vitest run test/rest-wallet-deployment-fees-anvil.test.ts
```

The test follows existing Anvil availability handling. Release qualification must require its execution with zero skips, installed Foundry and the pinned compiler. Anvil executes the reference contract; it does not establish OP execution-client deductions, actual deployed fork semantics, RPC reliability or a guaranteed fee ceiling at a future block.
