# Shared passkey dependency rollout

Status on 2026-09-14: **initial model reviews complete; remediation review pending; no contract deployment**. The user selected Claude Fable 5.1. The first reviews covered the exact source bytes subsequently committed as `e1dcdd3bcfcb6d476df8a92c1a77e8ea410e1ff5`. The deployment follow-up refreshes compatibility evidence with input hashes checked in the required suite, pins all three expected addresses, removes cross-chain ordering dependencies, and bounds all eight inspections under one deadline. Record the follow-up findings and reviewed source identity before publication. A model review is not a third-party audit certification. Existing upstream audit coverage does not establish Center integration safety.

The dedicated funding address is `0x097334063a5c2505d8df1C660B996699c27E6Fd3`. Its key and derived address are stored in Center's production Railway variables `CENTER_WALLET_DEPLOYMENT_FUNDING_PRIVATE_KEY` and `CENTER_WALLET_DEPLOYMENT_FUNDING_ADDRESS`. The key was generated in memory and is not stored in this repository. Do not generate a replacement or use any client treasury key. No funding chain or amount has been selected; obtain those from a validated fresh Relayr quote after review.

## Deployment scope

One prepaid Relayr bundle targets Ethereum (1), Optimism (10), Base (8453), Arbitrum One (42161), Ethereum Sepolia (11155111), Optimism Sepolia (11155420), Base Sepolia (84532), and Arbitrum Sepolia (421614).

Each missing dependency is deployed using the exact hash-checked compiler init code, zero salt and canonical Arachnid CREATE2 proxy at `0x4e59b44847b379578588920cA78FbF26c0B4956C`. Both calls carry zero native value. The signer factory constructor creates its singleton with CREATE nonce one; the factory's immutable runtime is checked against that predicted address.

| Contract | Expected address on every chain |
| --- | --- |
| FCLP256Verifier | `0xFbe0614fFB2226cd6d1D3F9A79BC73d7647b4C61` |
| SafeWebAuthnSignerFactory | `0x48c4F4B3d2684f39437F68faC4Ecc49f8F85163D` |
| SafeWebAuthnSignerSingleton (created by the factory constructor) | `0x6613cA05f68002B7091963D9D4AB0DB232ed0648` |

The unsigned recipe also contains the singleton address, all runtime hashes, init-code hashes, source revisions and artifact file hashes. Addresses alone are insufficient. Existing deployed code must match the recipe, including factory/singleton consistency. Never substitute a catalog factory solely because its name or address is familiar.

The dependency request uses `Disabled` ordering, an exact enum in [Relayr's published OpenAPI](https://api.relayr.ba5ed.com/openapi.json). Neither constructor depends on the other call, so all missing deployments are independent; [Relayr's documentation](https://relayr-docs-staging.up.railway.app/docs/concepts/bundle/) specifies that a failed call does not stop other calls in this mode. With all contracts absent the request has sixteen entries. The 2026-09-14 read-only observation found exact verifiers already present on Ethereum Sepolia and Base Sepolia, leaving fourteen calls. Refresh that evidence before publication. The bundle is not an atomic cross-chain transaction. Reconcile every receipt and runtime independently. If another caller deploys the exact code first, a reverted Relayr call can coexist with a ready dependency: record both facts, retain its fee outcome, and never retry a verified deployed dependency. Never recreate an unknown bundle or blindly repay it.

This rollout deploys shared dependencies. Center's current passkey wallet manifest, signup, recovery and payment qualification remain Base-specific. Eight-chain wallet activation requires separate chain profiles, provider/fee/finality qualification and acceptance evidence. This rollout does not enable client flags or authorize spending from any user wallet.

## Reproduce the unsigned evidence

```sh
npm run wallet:production-stack -- --output /absolute/new/path/base-stack.json
npm run wallet:dependency-bundle -- --output /absolute/new/path/eight-chain-bundle.json
```

Both commands are read-only. The second requires successful observations for all eight chains; any missing or stale observation prevents output. Each chain has a 15-second deadline, 3-second call deadline, bounded call/byte budget, at most four simultaneous code reads, exact provider chain ID, one canonical block anchor and a final anchor recheck. The CLI inspects all eight chains concurrently under one shared 15-second cancellation deadline using Center's fixed PublicNode provider catalog. This bounds the operation to eight inspections and at most 32 simultaneous code reads. Every observation must still be fresh when the bundle is assembled. Saved observations expire and must be refreshed after review. A quiet testnet whose newest block exceeds the 60-second freshness policy remains unverified; no chain-age exception is inferred from a timeout.

Missing contracts are simulated with their exact CREATE2 bytes at the observed block, with execution gas estimates capped at eight million per call. These estimates exclude additional chain charges and Relayr pricing; they are not funding amounts. The bundle reports `audit.status: pending`, `publicationEnabled: false`, and no wallet activation chains. No publication or signing path is exposed by these commands.

The full Base checker additionally verifies the configured SafeL2, proxy factory, adapter, launchpad, DC utility, EntryPoint, SenderCreator, SmartSession and MultiSend runtimes. The eight-chain checker only qualifies the shared passkey dependencies and CREATE2 proxy.

## Review scope and acceptance

Review the [source/compiler manifest](../../src/rest/smartAccounts/stack/passkey/manifest.json), [upstream audit comparison](../../src/rest/smartAccounts/stack/passkey/evidence/audit-source-comparison.json), vendored Solidity closure, rebuilt artifacts and [cryptographic compatibility evidence](../../src/rest/smartAccounts/stack/passkey/README.md). The new deployment recipe is in `src/rest/smartAccounts/passkeyProfile.ts`; read-only qualification and bundle construction are in `src/rest/wallet/productionStack.ts` and `dependencyBundle.ts`. Review the bounded RPC helper and Relayr request enum fix too.

Review Center's use of those contracts separately: WebAuthn RP/origin/challenge/UV/UP and canonical signature rules; atomic two-owner threshold-one Safe creation; enrollment versus fresh deployment approval; exact payment authorization; recovery kit handling and owner rotation; durable replay/nonce/dispatch/reconciliation behavior; central logout and app grants. Current local relayers explicitly restrict themselves to unforked Anvil. Review findings must distinguish a missing production adapter from a vulnerability reachable in the enabled runtime.

Required pre-publication evidence:

1. Exact source inventory, compiler/artifact reproducibility, complete repository release checks, reviewer output and resolved findings. Tests and static review do not prove absence of defects.
2. Fresh successful chain observations for all eight targets, exact occupied-code checks, CREATE2 simulations and complete source-to-runtime commitments.
3. A separately reviewed operator publication/funding path that durably binds the exact request to its returned bundle UUID and transaction UUIDs before payment; unknown POST outcomes must remain unknown.
4. Fresh quote validation of chain, native token, pinned payment target/runtime, calldata, bundle ID, deadline and total amount. Establish a funding chain and explicit maximum expenditure; persist exact signed payment bytes before sending and reconcile by hash if its response is lost.
5. After funding, track every expected call to a canonical receipt and exact deployed runtime, including the constructor-created singleton. Record partial failures and finality separately per chain. Do not mark all chains deployed from Relayr's aggregate status alone.

## Operator quote journal (review pending)

`wallet:dependency-quote` requires an explicit `--audited-fingerprint` matching `captureSourceSnapshot` for the exact reviewed checkout, on a clean checkout. It uses the fixed `.generated/wallet-dependency-publications/<body-hash>` journal directory; the CLI has no run-name or alternate-directory option. This flag is the operator's attestation of completed review; a source hash cannot itself prove an audit. The command rechecks source identity before and after fresh chain inspection, then exclusively claims the body-hash directory. It fsyncs the source revision and attested fingerprint alongside the request's exact transaction fields and canonical JSON hash before one fixed-origin POST with independent ordering. The JSON formatting is not a hash of HTTP wire bytes. It saves the bounded POST and status responses before parsing, durably binds returned bundle and transaction UUIDs, and verifies that the provider's stored request echoes every exact call before reporting a quote. A timeout, malformed response, write failure or existing journal prevents another automatic publication. If the first response write fails, it reports a validated recovery bundle UUID on stderr without printing provider text. It prints bounded error codes for other failures. No file state enables funding.

Install dependencies from the lockfile with `npm ci` and `npm --prefix mcp ci` before the final release check and quotation; installed dependency bytes are not part of the source fingerprint. Do not edit or reinstall between that check and quotation. Do not run the quote command until its review is complete. Do not change the directory to bypass an unknown attempt; inspect and reconcile its stored outcome. Payment signing, its separate durable journal, runtime/fee/deadline verification and final per-chain reconciliation remain to be implemented and reviewed. No production key has signed or submitted a transaction for this rollout. Before consumer testing, finish production signup/recovery transport and fee admission, TLS, durable restore reconciliation, joined client payment acceptance, physical-device checks, pressure/soak evidence and staged client activation.
