# Relayr payment evidence

The wallet dependency operator uses the existing Relayr prepaid API at `https://api.relayr.ba5ed.com`. The source references supplied on 2026-09-14 were inspected directly and pinned:

- [TypeScript SDK, cbc4fad](https://github.com/xBA5ED/relayr-ts/tree/cbc4fadf6acabc69c1ed2daa6d91854377df145d): `src/client.ts`, `bundle.ts`, `types.ts`, `helpers.ts` and `utils.ts` confirm the prepaid POST, bundle GET, optional virtual nonce, hexadecimal values and payment response fields.
- [Legacy billing contract, ccaae59](https://github.com/xBA5ED/relayr-contracts-v1/blob/ccaae5922e69946039812031f8f3cb331d657da4/src/RelayrV1.sol): its `prepayment(bytes16,uint40)` selector matches, but its token-bearing event and organization accounting differ from the current quoted payment runtime. It is not verified source for that runtime.

SDK polling treats `Included` as a terminal provider state. The operator separately verifies exact signed transaction identity, a matching payment event and canonical L1 finality. The SDK's response types do not establish positional correspondence between submitted calls and returned transaction UUIDs; Center authenticates that mapping from the stored bundle GET response. Independent deployment calls omit `virtual_nonce` under `Disabled`.

## Executable identity

Current payment contract: `0x1c05f7841379d4393574c0ffa17908ec40ffd97d`.

Full runtime Keccak-256: `0x6006b5acadb4cd60aa5c00cb844c34563e182dff83d4f4ff4fde226f7df16fa6`.

The original source metadata remains unavailable. `src/rest/sponsorship/stack/relayr/RelayrPaymentReference.sol` is explicitly an independent reconstruction. Solidity `0.8.26+commit.8a97fa7a`, Cancun, viaIR and optimizer 200 reproduce all 244 executable bytes, including the unreachable INVALID separator. Only the 53-byte CBOR metadata trailer differs. The exact runtime is pinned in `manifest.json`; `verify.mjs` recompiles the reference and compares every executable byte. Official compiler release entries are preserved in `compiler-release-evidence.json` alongside their source URLs.

The deployed runtime:

- Accepts exactly the `prepayment(bytes16,uint40)` selector, canonical argument padding and deadlines at or after the current block timestamp. The deadline error selector is `0x3c06f61c`.
- Transfers all `msg.value` to `0x755ff2f75A0A586ecfa2B9A3c959CB662458a105` with the Solidity transfer stipend. Recipient rejection or excess gas consumption reverts the whole call.
- Emits `Prepayment(bytes16 indexed payment_uuid,uint256 amount,uint40 deadline)` after the transfer.
- Has no storage, replay protection or quote-amount enforcement. The operator binds the exact amount and prevents duplicate payments with permanent bundle and nonce claims.
- Rejects plain ETH transfers and short calldata, but accepts trailing calldata. Center's quote binding requires the exact canonical calldata length and bytes.

The receipt verifier must receive the exact transaction's successful receipt with its transaction and block identities checked. Its event check alone does not prove payment finality. Provider payment flags remain observations of Relayr's view.

## Validation and limits

Required tests rebuild the reference with the pinned compiler, execute the full deployed runtime on unforked local Anvil, check deadline equality and exact revert data, inspect the value transfer and event, exercise a reverting or gas-exhausting recipient, and reject malformed receipt logs. Tests use public fixture keys and synthetic ETH.

Claude Fable 5.1 independently disassembled the runtime and accepted executable equivalence as evidence for the deadline, recipient and receipt semantics. Its follow-up requests added exact error-data and adversarial-log checks and official compiler release evidence. This is model-assisted review, not third-party certification or verified original source provenance. Funding implementation review, live transaction finality, destination runtime verification and consumer activation are separate gates.
