# Smart accounts and bounded sessions

The REST service implements separate smart-wallet ownership bindings, deployment capability discovery, and typed session policy reviews. It does not activate sessions, create wallets, sign UserOperations, or relay them. Existing direct transaction and Relayr transports retain their own authority rules. A linked smart wallet is never silently replaced with its owner EOA.

`createSmartAccountService` and `createSessionPolicyReviewer` are exported from `src/rest/smartAccounts/index.ts`. Runtime configuration owns deployment manifests, module inspectors and reviewed payment/token targets. HTTP callers cannot supply those trust inputs. Empty configuration returns explicit missing dependencies while still showing the recorded deployment research.

## Owner identity and wallet binding

The API account remains `eip155:<authorityChainId>:<ownerEOA>`. Each wallet has its own `(executionChainId, Safe address)` binding. Binding requires the API owner to be a current Safe owner and enough current owners to satisfy the actual threshold. Merely controlling one signer of a multisig is insufficient.

Every inspection validates `eth_chainId`, pins one mined block, and uses EIP-1898 `{blockHash, requireCanonical:true}` for code, storage and calls. It checks the exact Safe proxy runtime, slot-zero singleton, version, owners, threshold, fallback handler, zero guard and complete Safe module list. Only the configured Safe7579 adapter may be enabled as a Safe module. All configured dependencies have expected runtime hashes and source/artifact identities. Missing code, changed code, unexpected modules or unsupported RPC block references fail.

The first implementation supports EOA owners and direct EIP-712 owner signatures. It rejects contract/delegated owners, preapproved-hash signature forms and session signatures. Signatures are packed in increasing owner-address order and must exactly meet the observed threshold. This deliberately proves current owner authority directly: an ERC-1271 response from an account's installed validator is not automatically proof that its owners approved a new binding. Contract-owner threshold support requires another reviewed signature adapter.

A binding challenge commits to service audience, execution chain, wallet, API account, owner, complete observed account state hash, random nonce and an expiry within fifteen minutes. Ownership or module-state changes require a fresh challenge. The authorization expiry limits admission of the link; it is not an onchain session expiry. Before using a stored binding, `current()` rechecks the live state. List responses explicitly identify their stored snapshot.

`PostgresSmartAccountRegistry` and migration `007_rest_smart_accounts.sql` persist links under the API account. Account row locks serialize nonce claims, renewals and unlinking. A revoked or superseded authorization cannot restore a link. The database checks its own clock, isolates accounts, bounds documents and limits each account to sixteen wallet records and 256 live binding nonces. The memory registry is for tests/development. API unlinking does not revoke any installed onchain session.

## HTTP interfaces

Routes are mounted under `/api/v1` and use the normal signed-request authentication and request bounds.

| Method and path                           | Input / result                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `GET /smart-accounts/capabilities`        | Configured manifests, observed deployment research, inspector/provider requirements and explicit execution status.  |
| `POST /smart-accounts/binding-challenges` | Owner-only `{manifestId,address,nonce,expiresAt}`; returns observed state, EIP-712 typed data and digest.           |
| `POST /smart-accounts/bindings`           | Owner-only challenge fields plus `{stateHash,signature}`; rechecks state and verifies the owner threshold.          |
| `GET /smart-accounts/bindings`            | Account-isolated stored binding summaries.                                                                          |
| `GET /smart-accounts/bindings/:id`        | Revalidated current binding; changed authority fails.                                                               |
| `DELETE /smart-accounts/bindings/:id`     | Owner-only API unlink; explicitly reports `onchainSessionRevoked:false`.                                            |
| `POST /smart-accounts/session-reviews`    | Typed policy review with `plan` scope; produces a policy hash and activation requirements, not installed authority. |

The session review input contains `bindingId`, `grantId`, positive decimal-string `generation`, nonzero random `nonce`, integer Unix-second `validAfter`, `durationDays:7|30`, decimal-string `maximumCalls`, allocation groups and typed actions. The service loads the active bot grant itself; callers cannot substitute a session key. A bot can review only its own grant. The whole validity interval must fit the grant's expiration, and the grant must have `plan` and `relay` scopes.

## Policy and budget constraints

Every review binds the API account, wallet, bot grant/key, execution chain, generation, nonce, validity window, distinct salt, full policy hash and deployment revision. It forces restricted actions, disables arbitrary signing and excludes wildcard, Orchestrator, claim and crosschain-permit fallback. Empty/general transaction permissions are not an accepted policy. These choices are required because the SDK's permissive defaults otherwise allow substantially broader execution. [Rhinestone session overview](https://docs.rhinestone.dev/smart-wallet/smart-sessions/overview).

Allocation groups state an explicit total and concrete `(allocationId,chainId,asset,limit)` entries. Amounts are exact base-unit decimal strings. Every entry must match server-reviewed asset identity and decimals on its chain; a group mixing identities or decimals fails. These values cannot come from caller symbols or decimal claims. Entries then sum within the owner-approved total; duplicate asset/chain allocations fail. An action uses the bound wallet's chain, and independent action caps sharing an allocation must also sum within that allocation. The service does not infer crosschain asset equivalence, reuse pending revoked allocations, or reset previously consumed limits.

The current review supports two closed action models:

- `erc20-transfer`: reviewed exact-transfer token, fixed beneficiary, per-call amount and cumulative amount. Native value, account self-calls and duplicate target/selector policies are excluded.
- `v6-pay`: reviewed core terminal, fixed project, asset, beneficiary and minimum project-token output, with fixed empty memo/metadata. Compilation must prove canonical empty dynamic tails, exclude Permit2 and enforce the actual native-value cap independently of the `amount` argument. ERC20 terminal allowances need their own fresh owner approval.

Neither model accepts arbitrary selectors, delegatecall, nested calls, permit, approvals, account administration or additional raw policy fields. Reviewed target configuration is separate from activation: the actual target and all policy enforcement must be checked again before owner approval and execution.

ABI sugar for Call policies only supports static parameters. A selector and amount limit do not constrain dynamic V6 payment metadata. The lower-level UniversalActionPolicy can express word constraints, but its deployed offset semantics and init format must match the compiler. [Call policy documentation](https://docs.rhinestone.dev/smart-wallet/smart-sessions/policies/call).

Permission IDs are not policy digests. The inspected SDK resolver uses a zero salt, while the permission identity excludes action rules, limits and expiry. Reusing that identity can overwrite policy state or reset counters. Reviews derive a distinct nonzero salt and bind the full policy hash; activation requires a compatible lower-level encoder or another proven way to avoid collisions. ERC4337 validation can consume limits even if execution later fails, so the service does not promise vault-style counter rollback.

## Deployment evidence and the execution path

`SMART_ACCOUNT_RESEARCH` records observed canonical block hashes and runtime hashes for eight chains: Ethereum, Optimism, Base, Arbitrum and their four listed Sepolia networks. Code observations are not an audit, installation proof, module-state proof, or provider configuration. Candidate addresses never become active manifests automatically.

`CHECKED_SMART_ACCOUNT_BINDING_MANIFESTS` supplies one reviewed Sepolia deployment in `ownership-only` mode: SafeL2 1.4.1 with the source-bound Safe7579 adapter. Its Safe proxy runtime is derived from the pinned SDK's explicit proxy bytecode, and its dependency pins retain the matching source and artifact identities. EntryPoint is omitted because its source binding remains incomplete and owner-threshold verification does not use it. Capability discovery reports `entryPointSourceVerified:false`; bundler readiness fails closed. This manifest enables ownership binding, without claiming session execution readiness. Runtime operators may configure additional manifests only with equivalent evidence.

The deployed legacy SmartSession runtime was matched to the artifact at commit `f24dddfcbf7269e10dcd4da90dae0a6ae6ccf188`. Its ERC4337 validation path propagates intersected policy validity to EntryPoint. The observed TimeFrame, UniversalAction and ValueLimit policy artifacts match commit `75279a6c80ad50ea623d06954e9d71ab753e8a52`; their initialization layouts must be taken from that exact revision. [Legacy validator artifact](https://github.com/rhinestonewtf/smartsessions/blob/f24dddfcbf7269e10dcd4da90dae0a6ae6ccf188/artifacts/SmartSession/SmartSession.json), [policy source revision](https://github.com/rhinestonewtf/smartsessions/tree/75279a6c80ad50ea623d06954e9d71ab753e8a52).

Current SDK and Emissary deployments are a different generation. Source review identified an unresolved expiry-enforcement concern in the current Emissary action path. This is not a claim that deployed accounts are exploitable: the applicable execution path and deployed artifact still need a complete proof. The service keeps execution disabled for both generations until their complete adapters are verified.

Safe7579 is both an enabled Safe module and its fallback handler. Complete inspection must also cover its internal validators, executors, hooks, selector fallbacks, registry and attesters; checking the top-level Safe module list is insufficient. A configured `SmartModuleInspector` supplies a bounded source-specific proof. `moduleConfigurationVerified:true` remains distinct from `executionVerified`, which stays false in this implementation. The existing wallet adapter that rejects enabled modules is not relaxed. [Safe7579 architecture](https://docs.safe.global/advanced/erc-7579/7579-safe).

## Concrete remaining integration requirements

1. Complete source/artifact bindings for the selected Safe7579 generation, account factory/launchpad, session-key validator and policy contracts; implement the corresponding exhaustive module-state reader.
2. Add the exact legacy policy compiler and installed-policy verifier, including a distinct salt, disabled ERC-7739 signing, expiry propagation, actual-value limits, counters and closed calldata constraints. An owner-approved installation must be verified onchain before enabling delegation.
3. Verify the account's EntryPoint nonce-key layout and session signature envelope, then construct and independently decode the exact UserOperation. Installation/removal and owner financial approvals remain separate actions. Durable revocation requires both session removal and invalidation of outstanding enable signatures for the verified legacy design.
4. Configure a bounded ERC4337 bundler transport for the selected chains, with its operator URL/API credentials and EntryPoint `0.7` support. `bundlerReadiness()` checks chain identity and supported EntryPoints; it does not claim simulation or execution readiness.
5. Prove an onchain gas/prefund bound, then fund the account's gas/EntryPoint deposit, or configure an independently enforced paymaster and sponsorship policy. Safe7579 can pay missingAccountFunds from the wallet outside action value policies; service-side gas caps alone do not bound a malicious session key's direct submissions. A paymaster is optional for self-funded operations. Relayr's existing ERC2771 transport does not supply an ERC4337 bundler or paymaster.
6. Integrate exact-operation simulation, gas bounds, idempotent publication, canonical UserOperation receipt verification and inner Juicebox semantic outcomes with durable transaction storage. No private key or signing endpoint belongs in the service.

These are operator/provider and implementation dependencies, not additional owner permission prompts for read-only preparation. No provider credentials, onchain writes or user keys were used to build the current adapter. All fund movement continues to require its existing fresh approval unless a separately verified onchain budget authorizes it.
