# Wallet delivery evidence, 2026-09-15 UTC

This compact public bundle supports the [delivery report](../../CENTER-WALLET-DELIVERY.md)
at application revision `ac6e48d52fb43d5c90205e9892fff4ccaa011484`.
It contains no private key, recovery phrase, provider credential or compiler binary.
The [SHA256 inventory](inventory.json) covers every other file in this bundle.

| Record | Scope |
| --- | --- |
| [release.json](release.json) | Original clean release summary with derived suite totals and verified GitHub CI result added; 4,583 passed, zero failed/skipped |
| [base-live-fees.json](base-live-fees.json) | Actual new observer run through Center's Dwellir archive, exact source hashes, two historical receipts, 28 physical requests |
| [base-runtime-observations.json](base-runtime-observations.json) | Public fee proxy/implementation bytes extracted from the original Dwellir observations, with inclusion anchors |
| [base-runtime-rebuild.json](base-runtime-rebuild.json) | Original successful local compilation result, full-runtime equality, source/input/output hashes and settings adjustments |
| [compiler-provenance.json](compiler-provenance.json) | Official Solidity 0.8.15 compiler URL, catalog and binary hashes; binary is not included |
| [source-provenance.json](source-provenance.json) | Pinned Base configuration sources and exact Sourcify record URLs/hashes |
| [fable-base-receipt-fees.md](fable-base-receipt-fees.md) | Initial model-assisted review of the pure verifier and intended callers |
| [fable-base-observer-closure.md](fable-base-observer-closure.md) | Observer/correction review; identifies the full-block limit mismatch fixed afterward |

The reviews are retained verbatim. Their suggested changes describe the source
at review time. The block-node-bound correction and mid-flight cancellation case
were completed afterward and passed the full gate. These documents do not claim
that Fable reviewed those final changes or the later runtime reconstruction.

## Reconstructed runtimes

| Contract | Observed address | Complete runtime size |
| --- | --- | ---: |
| L1Block implementation | `0x3ba4007f5c922fbb33c454b41ea7a1f11e83df2c` | 1,813 bytes |
| GasPriceOracle implementation | `0x4f1db3c6abd250ba86e0928471a8f7db3afd88f1` | 7,848 bytes |
| Proxy | `0x420000000000000000000000000000000000000f` | 2,055 bytes |

The proxy code also matched the L1Block predeploy at
`0x4200000000000000000000000000000000000015`. All three compiled runtimes matched
the retained provider observations byte for byte, including metadata.

The exact compiler was `0.8.15+commit.e14f2714`, macOS binary SHA256
`00656dc73224e4c0702940df10310bdc024b60f4a7598e774d305bc3b94f7d79`.
Implementation settings came from the verification records, with audit output
selection supplied. The flattened proxy record defaulted to IPFS metadata;
changing **compiler setting `metadata.bytecodeHash` to `none`** reproduced the
observed full runtime. No runtime bytes were patched and no metadata was stripped.

Base source pin `9469da27403d6836634639b4899a6e4a0964720f` records Base chain
8453, L1 chain 1, genesis
`0xf712aa9241cc24369b143cf6dce85f0902a9731e70d66818a3a5845b296c73dd`,
Jovian timestamp `1764691201`, Base Azul `1779991200` and Beryl `1782410400`.
Later unknown upgrades must not be assumed compatible. Selector matching and
historical runtime reconstruction alone do not establish current pricing rules.

## Full durable archive and reproduction

On the development Mac, the complete source reconstruction is preserved at:

```text
/Users/jango/.juicebox-center/wallet-dependencies/reviews/
  ac6e48d52fb43d5c90205e9892fff4ccaa011484/base-runtime-source-rebuild/
```

It contains the original three Sourcify verification records, compiler inputs
and outputs, Base `config.rs`/`lib.rs`, original Dwellir observations, historical
rebuild script, provenance and a SHA256 inventory. The source copies preserve
their upstream license notices. The 38 MB compiler is deliberately excluded.

To reproduce offline, verify the archive inventory and the compiler's published
SHA256, run the exact `*-compiler-input.json` through that binary's
`--standard-json`, and select `evm.deployedBytecode.object` using each
`fullyQualifiedName` in the rebuild result. Compare the **entire** runtime with
the retained Dwellir bytes. Write fresh outputs elsewhere; keep the original
archive immutable. The historical script contains its original temporary paths
and needs path adaptation before reuse.

The separate sibling `base-fee-observation-release/` archive contains the exact
application source, complete release logs, behavioral red/green evidence and
reviews. Original raw compilation outputs are omitted from this repository
bundle to avoid duplicating megabytes of generated content.

All chain evidence here comes from one configured Dwellir provider. It is not
independent consensus proof. These records qualify historical consistency and
source reconstruction; they do not authorize production dispatch, establish
future total fee caps or qualify hosted signup/recovery capacity.
