# Atomic passkey bootstrap: historical experiment

This document preserves the original bootstrap experiment and its implementation
proposal. The versioned initializer, inspector and direct deployment relay are
now implemented. See the current [deployment strategy](../../../../../../docs/rest/WALLET-DEPLOYMENT-STRATEGY.md)
and [delivery report](../../../../../../docs/rest/CENTER-WALLET-DELIVERY.md)
for their behavior and remaining production gates. The measurements below remain
local experiment evidence.

A single Safe factory transaction can deploy the immutable passkey signer and initialize the Safe with that signer plus an independent recovery EOA. Use the existing direct deployment relay pattern with a newly versioned initializer. The tested EntryPoint initCode variant is onchain-feasible but is unsuitable for the current canonical bundler path without further architectural changes.

This experiment is required by the parent passkey compatibility gate and remains an inactive runtime profile. Run it from the repository root with `node src/rest/smartAccounts/stack/passkey/bootstrap/verify.mjs`. The runner verifies exact source/compiler/artifact hashes and requires all ten real Foundry tests. It installs Solidity 0.7.6 through pinned Foundry when the compiler cache is empty, independently checks the official macOS/Linux binary checksum, and rebuilds MultiSend on every run. `CENTER_MULTISEND_SOLC` can select an existing verified binary; `CENTER_BOOTSTRAP_REPORT` optionally selects an atomic JSON report. The parent gate aggregates this suite into `CENTER_PASSKEY_REPORT`.

## Exact candidate

Outer transaction: SafeProxyFactory.createProxyWithNonce(SafeL2Singleton, initializer, saltNonce), value zero.

Initializer: Safe.setup(owners, 1, MultiSend, multiSend(twoEntries), Safe7579, zeroAddress, 0, zeroAddress).

- Owners: predicted per-credential SafeWebAuthnSignerProxy and independent backup EOA.
- Entry one: operation 0 (CALL), target the pinned SafeWebAuthnSignerFactory, value zero, exact createSigner(x, y, FCL-only verifier) calldata.
- Entry two: operation 1 (DELEGATECALL), target the existing pinned Safe7579Launchpad, value zero, exact addSafe7579(adapter, [{module: SmartSession, initData: empty, moduleType: 1}], [], 0) calldata.
- Each entry is packed as uint8 operation, address target, uint256 value, uint256 dataLength, bytes data.
- No other entries, transfers, optional operations, arbitrary setup payloads, initializer suffixes, or hidden delegatecalls.
- MultiSendCallOnly cannot perform the launchpad delegatecall and is not a substitute.

MultiSend source is Safe1.4.1 commit bf943f80fec5ac647159d26161446ac5d716a294, contracts/libraries/MultiSend.sol. Its minimal source closure independently reproduces the official @safe-global/safe-contracts1.4.1 creation/runtime template byte-for-byte using Solidity0.7.6+commit.7338295f, Istanbul, optimizer disabled (runs200), metadata.useLiteralContent true. Official macOS/Linux compiler checksums are pinned.

Canonical deployment-catalog address: 0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526.
Runtime code hash after substituting its constructor immutable: 0x0e4f7fc66550a322d1e7688e181b75e217e662a4f3f4d6a29b22bc61217c4b77.
The catalog is pinned to safe-deployments commit7b1fb6d615ab2d2999550ec9166554b180e813e5 and lists Base. No live Base code observation was made here.

## What the ten tests establish

- Existing initializer with an undeployed passkey owner fails actual EntryPoint validation with AA24 signature error.
- MultiSend creates the real signer and Safe before first real P256/FCL validation; actual EntryPoint execution succeeds and advances the nonce.
- Wrong credential, missing UV, substituted backup owner, and a broken launch roll back both newly created contracts.
- Permissionless prior creation of the exact signer preserves idempotent behavior.
- Replaying the initial UserOperation fails.
- A failure during UserOperation execution leaves the already validated Safe and signer deployed, with the EntryPoint nonce consumed.
- A direct factory transaction creates both contracts with EntryPoint code absent.
- A 500,000 verification-gas limit rejects this atomic EntryPoint bootstrap.

The initial UserOperation uses an already prefunded EntryPoint deposit, not a production paymaster. The direct factory transaction uses the test caller's gas. No external provider, live chain, consumer device, or production sponsorship claim follows.

Latest local measurements in evidence/local-bootstrap.json:

- Initial UserOperation actualGasUsed: 897,029.
- initCode: 1,304 bytes; packed ABI UserOperation: 2,400 bytes.
- Direct factory execution: 481,707 EVM gas, excluding outer transaction intrinsic/calldata and L1 data fees.

## Why the direct transaction is the next candidate

At the time of this experiment, Beep implemented the relevant pattern in src/deployment-service.ts: a bounded prepaid deployment gas wallet, fresh exact initializer approval, durable raw EIP1559 transaction before dispatch, unresolved nonce protection, canonical receipt rechecks, and rebroadcast of identical bytes. Center had no equivalent direct relay. Its Relayr sponsorship module forwards ERC2771 requests and is not a drop-in factory deployment path.

Moving that deployment responsibility to Center requires shared PostgreSQL authorization, budget and nonce records. Beep's process-local busy flag and SQLite coordination do not protect multiple Center replicas. Keep the existing bounded pool and exact-byte recovery semantics while implementing those shared invariants. The operator gas key never becomes a Safe owner and receives no customer spending authority.

Before reserving gas, verify both:

1. A fresh passkey assertion over the complete creation authorization: chain, exact profile/pins, predicted Safe and signer addresses, initializer hash, key configuration, backup owner, threshold, expiry and nonce.
2. Independent backup EOA proof of possession over that same creation commitment.

The passkey approval explicitly grants the backup full threshold-one authority. Backup possession is not proved by merely parsing an address or by the factory transaction. A consumed enrollment challenge or login cookie is not itself creation approval. The initial passkey signer is verified directly against its registered public key because the Safe does not yet exist.

## Versioned creation and inspector changes

1. Add a distinct initializer/profile revision with the MultiSend pin and selected signer factory/verifier pins. Preserve legacy creation bytes and account addresses.
2. Add a pure builder and canonical verifier for exactly the two entries above. Reconstruct the whole factory calldata and require byte-for-byte equality; compute CREATE2 from that initializer. Reject extra entries, altered modes/targets/values, calldata aliases, padding, and omitted signer creation.
3. Preserve direct provenance requirements: successful transaction to the reviewed Safe factory, value zero, unique ProxyCreation, exact sender address and singleton, canonical receipt/block, and historical code pins.
4. At the creation transaction only, admit the exact MultiSend delegatecall matching the prepared two-entry bytes and the exact inner launchpad delegatecall. The launchpad input is no longer the outer Safe.setup data field. Retain rejection of other delegatecalls and all non-creation uses.
5. Check the new helper and signer dependencies at the creation block as well as the final credential/owner configuration. Preserve complete module history, empty initial sessions, threshold/owners, canonical recovery and existing authority checks.
6. The direct transaction receipt must prove both contracts and the exact Safe configuration before binding the new principal. A successful relayer response alone cannot establish enrollment or deployment.

The legacy inspector path deliberately rejects both the MultiSend initializer and a factory call nested inside an EntryPoint transaction. The direct relay needs the versioned initializer/provenance additions above; the EntryPoint route additionally needs a separately reviewed outer-transaction/trace model.

## Canonical bundler exclusions

ERC-7562 OP-031 permits one CREATE2 deploying the sender in an unstaked deployment frame. This bootstrap uses another CREATE2 in the separate signer factory. Initializing the adapter/SmartSession also touches external associated storage; STO-022 requires a staked factory for that initCode case. The current SafeProxyFactory exposes no stake-management path. The tested bootstrap also exceeds the canonical500,000 verification-gas bound. Staking exceptions are specific and do not automatically permit an extra utility-factory CREATE2. Local handleOps success proves none of these admission rules.

The existing Safe7579Launchpad preValidationSetup hook offers a different lifecycle, but its initial owner fallback recovers EOA signatures with recoverNSignatures. It does not supply the contract-passkey path already proved against the fully initialized Safe. Switching to that lifecycle would be a broader profile change.

## Journal semantics

Factory setup failure or initial validation rejection reverts both deployments. A later UserOperation execution failure can leave both deployed and its nonce consumed. Persist deployment observation independently of payment/action outcome, retain the original transaction or operation identity, and inspect canonical state before retrying. Never infer "wallet absent" from a failed execution receipt.

## Primary sources

- [Pinned Safe MultiSend source](https://github.com/safe-global/safe-contracts/blob/bf943f80fec5ac647159d26161446ac5d716a294/contracts/libraries/MultiSend.sol)
- [Official Safe1.4.1 compiler package](https://registry.npmjs.org/@safe-global/safe-contracts/-/safe-contracts-1.4.1.tgz)
- [Pinned deployment catalog](https://github.com/safe-global/safe-deployments/blob/7b1fb6d615ab2d2999550ec9166554b180e813e5/src/assets/v1.4.1/multi_send.json)
- [Pinned Safe7579 launchpad](https://github.com/rhinestonewtf/safe7579/blob/f22a194148ff087f0c16125e530512e59794e188/src/Safe7579Launchpad.sol)
- [ERC-7562 validation rules](https://eips.ethereum.org/EIPS/eip-7562)
