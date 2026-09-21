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

## Actual Base receipt verification

`../../baseReceiptFees.ts` checks the original signed Base type-2 envelope against its receipt and full inclusion-block transaction list. It accepts the explicit 178-byte Jovian L1-attributes deposit at index zero and derives every L1/operator parameter from that deposit. The supported calldata layout is documented in the [OP Jovian L1-attributes specification](https://specs.optimism.io/protocol/jovian/l1-attributes.html). Unknown selectors or lengths fail closed.

L1 cost must match the receipt's required `l1Fee`. Optional receipt parameters must agree when present; missing operator fields do not imply zero. Operator cost uses the gas actually charged after refunds, following `BaseL1Block.rs:238` and `BaseL1FeeParams.rs:188`. The [OP Jovian execution specification](https://specs.optimism.io/protocol/jovian/exec-engine.html) describes the scalar multiplication. Reverted transactions still incur execution, L1 and operator fees.

The returned total contains fees only. It does not claim a net sender balance delta: a successful call can transfer value back to the sender, and a receipt does not describe every internal transfer. Treasury balance accounting must observe balances separately.

`test/fixtures/base-fee-receipts.json` retains two public Center dependency transactions observed through Center's Dwellir Base archive, with their full signed bytes, receipt fee fields, inclusion headers, transaction hash lists and first L1-attributes deposits:

| Transaction | Execution fee (wei) | L1 fee (wei) | Operator fee (wei) |
| --- | ---: | ---: | ---: |
| `0x49058bea9e67003a40542a19d1adb734d27a68cfb4b64915fb08c381d6468374` | 8661130800000 | 16289011957 | 0 |
| `0xd11408ca1fb871a80f143ca0d7437461eaafa49e856bbd689242df518e67fe3e` | 10779560400000 | 13179076760 | 0 |

Both receipts omit operator fields, while their block attributes explicitly contain zero scalar and constant. Synthetic cases separately check nonzero operators, refunds, reverts, missing and contradictory evidence, canonical envelope limits, integer boundaries and malformed inputs. These two historical receipts do not establish that every future block has zero operator fees.

`../../baseFeeObservation.ts` performs the read-only RPC step inside the caller's existing `operationRpc` budget. It binds the caller's retained inclusion height/hash/timestamp, reads the receipt and system deposit, then rechecks the chain, canonical block and receipt. Reorgs, changed receipts, outages, cancellation and exhausted budgets return no fee result. The caller remains responsible for finality, qualified production chain/fork configuration, stored-operation authority and treasury settlement. Neither module is a production dispatch capability or a future fee guarantee.

The pure verifier accepts at most 4096 transaction hashes. For hash-only block reads, the RPC layer allows 8192 structural nodes to accommodate both those hashes and the block header. Other reads keep their 4096-node bound; byte, depth, call and time budgets are unchanged. Exceeding any bound leaves fee evidence unavailable. A production adapter must surface unavailable/unsupported-profile observations and alert on persistent failures, rather than interpreting them as zero cost or a completed settlement.
