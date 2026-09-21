The current Pimlico gas sponsorship profile binds `0x777777777777AeC03fd955926DbF81597e66834C` to runtime hash `0x337b6e1b6c2167c0528c5240c028ead407c673595b2820029b69741b76d98fbc` on Ethereum, Optimism, Base and Arbitrum. The runtime is 15,118 bytes. This separate manifest preserves the existing aggregate stack manifest and account bindings.

Sourcify reports exact creation and runtime matches on [Ethereum](https://sourcify.dev/server/v2/contract/1/0x777777777777AeC03fd955926DbF81597e66834C?fields=all), [Optimism](https://sourcify.dev/server/v2/contract/10/0x777777777777AeC03fd955926DbF81597e66834C?fields=all), [Base](https://sourcify.dev/server/v2/contract/8453/0x777777777777AeC03fd955926DbF81597e66834C?fields=all), and [Arbitrum](https://sourcify.dev/server/v2/contract/42161/0x777777777777AeC03fd955926DbF81597e66834C?fields=all). Independent Blockscout responses and block-identified RPC reads also match the locally reproduced runtime. The evidence records source URLs, response hashes, deployment transactions, and observed blocks.

All 28 source files match the official [Pimlico revision `2f710c1c`](https://github.com/pimlicolabs/singleton-paymaster/tree/2f710c1cee1ae2d5f5bbf3c41aade9ff8e4d4c05) and its pinned dependencies. Several published commits contain the same source; this establishes an exact published source revision, not a uniquely identifiable deployment checkout. Solidity `0.8.26+commit.8a97fa7a`, London, one million optimizer runs and Yul disabled reproduce the verified bytecode exactly. The checked-in standard JSON input contains the entire source closure. Nine duplicate import aliases from Sourcify are omitted to recover the verified AST IDs; the remaining 28 metadata source paths reproduce the bytecode, metadata and immutable references exactly.

Install the compiler through Foundry's isolated bootstrap project, then run the offline check from the repository root:

```sh
forge build --root src/rest/smartAccounts/stack/current-pimlico/paymaster-compiler
node src/rest/smartAccounts/stack/current-pimlico/verify-paymaster.mjs
```

The bootstrap builds only an empty contract pinned to Solidity 0.8.26. Its output is unused; Foundry installs the compiler if it is missing. CI must complete this step before the verifier.

The verifier finds Solidity 0.8.26 under `~/.svm` (or `SVM_HOME`), or accepts `--solc /path/to/solc-0.8.26` or `SOLC_0_8_26`. Before executing it, the verifier hashes the complete binary and requires an official Linux amd64 or macOS release hash. A missing compiler, substituted executable, or spoofed version fails; verification is never skipped. The official hashes and pinned release-manifest provenance are in `evidence/pimlico-compiler-binaries.json`.

It checks source SHA256, Keccak256, official Git blob IDs, complete compiler output, metadata, immutable bindings, artifact and manifest hashes, and the recorded chain observations. The verifier itself performs no network calls and makes no current sponsorship claim.

The admitted wire format is:

| `paymasterAndData` byte range | Field |
| --- | --- |
| 0–19 | Paymaster address |
| 20–35 | Paymaster verification gas, uint128 |
| 36–51 | Paymaster post-operation gas, uint128 |
| 52 | Combined mode and bundler flag, exactly `0x00` or `0x01` |
| 53–58 | `validUntil`, uint48 |
| 59–64 | `validAfter`, uint48 |
| 65–129 | ECDSA signature, exactly 65 bytes |

The contract computes `mode = flags >> 1` and `allowAllBundlers = (flags & 1) != 0`. Both admitted bytes select verifying mode zero. `0x00` requires `isBundlerAllowed[tx.origin]`; `0x01` permits any bundler. `0x02` and `0x03` select ERC20 mode and must be rejected. Every larger byte selects an invalid mode.

Verifying mode computes `getHash(0, userOp)`, applies the EIP-191 signed-message prefix, recovers an authorized signer, and returns empty context with packed validity. EntryPoint therefore skips the paymaster post-operation hook. The verifying branch performs no ERC20 transfer or sender prefund. The 52-byte header is included in the signed payload, as are the flag and both validity values. `getHash` accepts the unchanged v0.7 `PackedUserOperation` tuple and returns `bytes32`; its mode argument is zero even when the combined flag byte is `0x01`.

Although the config parser accepts 64 or 65 signature bytes, its OpenZeppelin `ECDSA.recover(bytes32, bytes)` overload rejects 64-byte signatures. The admitted profile therefore requires exactly 78 bytes of `paymasterData`, or 130 bytes including the EntryPoint header. Timestamp ranges and signer validity still require actual paymaster validation; a matching stub is insufficient. The observed post-operation gas limit of one remains part of the total bounded gas calculation even though the empty context suppresses the hook.

The contract uses OpenZeppelin AccessControl: `_roles` is storage slot zero, `signers` is slot one, and `isBundlerAllowed` is slot two. The immutable EntryPoint is `0x0000000071727De22E5E9d8BAf0edAc6f37da032`. Constructor owner and manager roles, signer membership and bundler allowlists are mutable state; a runtime match alone does not attest their present values.
