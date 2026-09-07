# Smart accounts, sessions and explicit payment budgets

Center's selected architecture is an owner-controlled Safe smart account with Safe7579 and verified Smart Sessions policies. The implementation candidate is the legacy ERC-4337 SmartSession validator with independently verified current policies and Safe7579 contracts, using explicit low-level encodings. The owner's existing wallet controls the smart account; a client-held session key can perform only owner-approved actions for an explicit week or month. This work installs no modules and does not assert that a particular user's account is ready.

All fund movement requires fresh owner approval unless it spends an explicitly set-aside, onchain-bounded payment allocation. Session keys cannot install modules, change ownership or permissions, change allowances, issue permits, or redirect funds. The existing [API bot grants](AUTHENTICATION.md) and [transaction transport](TRANSACTIONS.md) remain separate authorities.

## The Derive model and Center's boundaries

Derive's [interface onboarding](https://docs.derive.xyz/reference/ux-create-or-deposit-to-subaccount) creates a smart-contract wallet controlled by the original signer; protocol transfers appear under that wallet's address. Its [subaccounts](https://docs.derive.xyz/reference/multiple-subaccounts) organize separate balances under the same controlling wallet. Center adopts the owner-to-smart-account-to-session relationship, with separately identified per-chain accounts and payment allocations.

Derive [session keys](https://docs.derive.xyz/reference/session-keys) can authenticate API requests and, with broad admin authority, sign financial actions. Its [scoped registration](https://docs.derive.xyz/reference/private-register_scoped_session_key) distinguishes API-only registration from transaction-backed admin registration. Center deliberately grants less authority: no bot-admin scope, no session-created sessions, and no financial session authority outside an explicit payment budget. A weekly API grant alone never authorizes an onchain operation.

| Identity or authority | Meaning                                                                                  | Owner approval                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| API owner             | Existing `eip155:<authorityChainId>:<ownerAddress>` identity                             | Owns the Center account and registers bot keys                                    |
| Smart account         | A distinct `(chainId, smartAccountAddress)` with verified owner and module configuration | Exact factory/setup or existing-account registration; no EOA-address substitution |
| API bot grant         | Signed requests within independent `read`, `plan`, `relay` scopes                        | Explicit grant and expiry; no wallet authority                                    |
| Onchain session       | Exact key, account, module, policy configuration and validity                            | Exact installation or enable authorization                                        |
| Payment allocation    | Actual set-aside funds plus approved limits and route                                    | Funding, finite allowance if needed, and bounded recurring-payment policy         |

Private keys stay with the owner/client; Center stores public account, grant, policy and execution records. The smart account owns any deposited assets. Gas sponsorship is a separate budget, not custody of those assets.

## Select and verify one complete stack

[Safe7579](https://docs.safe.global/advanced/erc-7579/7579-safe) acts as both a Safe module and fallback handler; its launchpad initializes account modules and related configuration. Its version, validator selection, registry, guards, fallback handling and execution mode must be verified together. Do not combine a current SDK with addresses and ABIs copied from an older tutorial.

The inspected official SDK source is [`rhinestonewtf/sdk@91f8f1e`](https://github.com/rhinestonewtf/sdk/tree/91f8f1edc80aa38e698033b5287b6aa7537bb641), whose [`src/package.json`](https://github.com/rhinestonewtf/sdk/blob/91f8f1edc80aa38e698033b5287b6aa7537bb641/src/package.json) reports `2.8.0`. This is a source revision, not a verified installed package or production deployment. Pin the actual package version, lockfile integrity and matching contract artifacts before using it. No active local Rhinestone SDK installation was found during this research.

The [official address book](https://docs.rhinestone.dev/home/resources/address-book) and pinned SDK publish these candidate identities. An address constant is not chain-specific runtime or account-installation proof:

| Component                      | Published current candidate address          |
| ------------------------------ | -------------------------------------------- |
| SafeL2 v1.4.1 singleton        | `0x29fcb43b46531bca003ddc8fcb67ffe91900c762` |
| Safe proxy factory             | `0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67` |
| Safe7579 adapter               | `0x7579f2ad53b01c3d8779fe17928e0d48885b0003` |
| Safe7579 launchpad             | `0x75798463024bda64d83c94a64bc7d7eab41300ef` |
| Smart Session Emissary         | `0xad568b3f825a8d5ffc06dd3253526b64d810ae89` |
| Session compatibility fallback | `0x000000000052e9685932845660777df43c2dc496` |
| Universal Action policy        | `0x0000000000714cf48fcf88a0bfba70d313415032` |
| Time-Frame policy              | `0x0000000000d30f611fa3bf652ac6879428586930` |
| Value Limit policy             | `0x000000000021dc45451291bcdfc9f0b46d6f0278` |
| Usage Limit policy             | `0x00000000001d4479fa2a947026204d0283cede4b` |

The legacy adapter is `0x7579ee8307284f293b1927136486880611f20002`, with launchpad `0x7579011ab74c46090561ea277ba79d510c6c00ff` and Smart Sessions Validator `0x00000000002b0ecfbd0496ee71e01257da0e37de`. They are different components, not aliases. The old TimeFrame `0x8177451511de0577b911c254e9551d981c26dc72` and ValueLimit `0x730da93267e7e513e932301b47f2ac7d062abc83` constants had no Ethereum bytecode at block `25923286`; copying a legacy address bundle is insufficient.

The current SDK selects the Emissary, so it is not the selected legacy-validator encoder. Source inspection of [PolicyLibV2](https://github.com/rhinestonewtf/smart-sessions-v2/blob/bcf7ce653921a9dab5a79e30e4a85e403cdf24fe/src/lib/PolicyLibV2.sol#L125) found that its action path discards returned validity data, raising an expiry-enforcement question. The deployed Emissary runtime did not match that HEAD artifact after declared immutable masking; this is an unresolved source/deployment issue, not a demonstrated deployed exploit. Emissary execution remains unavailable.

### Verified components and compatibility work

Read-only RPC observations on 2026-09-07 matched the legacy validator's runtime to [SmartSession artifact `f24dddf`](https://github.com/rhinestonewtf/smartsessions/blob/f24dddfcbf7269e10dcd4da90dae0a6ae6ccf188/artifacts/SmartSession/SmartSession.json). Its [validation path](https://github.com/erc7579/smartsessions/blob/f24dddfcbf7269e10dcd4da90dae0a6ae6ccf188/contracts/SmartSession.sol#L224) intersects action validity and returns it through `validateUserOp`; this permits an ERC-4337 EntryPoint to enforce timeframe bounds. It rejects delegatecall modes and requires an action policy for each execution. Complete account/EntryPoint behavior still needs integration verification.

The current [TimeFrame](https://github.com/rhinestonewtf/smartsessions/blob/75279a6c80ad50ea623d06954e9d71ab753e8a52/artifacts/TimeFramePolicy/verify.json), [UniAction](https://github.com/rhinestonewtf/smartsessions/blob/75279a6c80ad50ea623d06954e9d71ab753e8a52/artifacts/UniActionPolicy/verify.json) and [ValueLimit](https://github.com/rhinestonewtf/smartsessions/blob/75279a6c80ad50ea623d06954e9d71ab753e8a52/artifacts/ValueLimitPolicy/verify.json) compiled sources are independently bound to exact deployed artifacts at commit `75279a6c80ad50ea623d06954e9d71ab753e8a52`. The four runtime hashes below matched on all eight listed chains:

| Component                     | Exact runtime Keccak-256                                             |
| ----------------------------- | -------------------------------------------------------------------- |
| Legacy SmartSession validator | `0xf2817b8943b9fc813ad3602de2f0b973dc6b7e190f1b77dc9eb02b8d3022ab0c` |
| Current TimeFrame policy      | `0xa8c18f7a974673552d03d7325bbc33a102a5aaab5bc5a3c11ecae1648ca4e026` |
| Current UniAction policy      | `0xc58f13d259c69d0db90f611347535e2d5642f3352740b7d58fbf6e6b939670dd` |
| Current ValueLimit policy     | `0x086e8421c6c9daab4a93e63366c83e8f20cc3f736b7be5a97e0e81633581e4ed` |

Cross-version composition requires explicit proof. The legacy validator calls `initializeWithMultiplexer(address,bytes32,bytes)` (`0x989c9e46`) and `checkAction(bytes32,address,address,uint256,bytes)` (`0x05c00895`); those signatures and the current policies' ERC-165 declarations match. Both use the supplied `bytes32` config ID and isolate policy storage by config ID, multiplexer address and smart-account address. The current TimeFrame initializer is exactly packed `uint48 validUntil,uint48 validAfter` (12 bytes); older mock sources use different encoding and must not be substituted. ValueLimit takes one `uint256`, accumulates actual value, and resets usage on initialization. UniAction takes its exact 16-slot tuple and accumulates configured calldata words. These source checks establish a compatible interface, not a completed account-level execution test.

The current [Safe7579 adapter](https://github.com/rhinestonewtf/safe7579/blob/f22a194148ff087f0c16125e530512e59794e188/artifacts/Safe7579/Safe7579.json) and [launchpad](https://github.com/rhinestonewtf/safe7579/blob/f22a194148ff087f0c16125e530512e59794e188/artifacts/Safe7579Launchpad/Safe7579Launchpad.json) matched official artifacts after declared immutable substitution on Ethereum and Sepolia. The adapter's [validation method](https://github.com/rhinestonewtf/safe7579/blob/f22a194148ff087f0c16125e530512e59794e188/src/Safe7579.sol#L253) preserves the installed validator's returned validity data. The singleton is SafeL2 v1.4.1, with factory/runtime evidence matching [official Safe deployment manifests](https://github.com/safe-global/safe-deployments/tree/1c3aad8cf686157272d7e5de05dae8cf5594e0bc/src/assets/v1.4.1) for all eight chains. EntryPoint source, SafeProxy runtime, session-key validator and delegated utility bindings remain incomplete; full owner/module/prevalidation-hook inspection and account integration are mandatory.

## Verified smart-account registry

Register a `SmartAccountRef` under the existing API owner; never replace that owner's API identity with the smart-account address. A registry entry binds chain, account address, owner set and threshold, supported owner-verification method, factory/setup hash if relevant, implementation/runtime hashes, adapter, validators, session module, policy contracts, guards, fallbacks, registry/attesters, execution mode, and verification block hash.

Registration requires an owner-signed exact account claim plus independent onchain verification. An API EIP-1271 check on the authority chain does not establish ownership of a contract on another chain. Initially accept only owner configurations for which the adapter can prove the API owner controls the required threshold; a body-supplied owner address or mere Safe membership is insufficient. Broader multisig ownership needs explicit threshold-owner authorization and a supported registry model.

Predicted accounts remain `counterfactual` until the exact factory/initializer has executed and the final singleton, ownership and modules are verified. Recompute the address from pinned factory data; reject extra setup calls, unknown modules and substituted salt/init code. The owner retains a normal owner-authorized recovery path independent of the session module or Center.

Reverify account configuration before plans and admission. Owner rotation, threshold changes, module/fallback changes and unknown code invalidate Center's cached verification. They do not necessarily revoke an already installed onchain session: the wallet owner must disable it onchain. The current [Juicebox Money Safe safety path](https://github.com/mejango/juicebox-money/blob/c262a2fa7365af963ffb928b17deb45758235b57/src/lib/safe.ts#L416) rejects enabled modules; add a separate verified adapter, rather than weakening that existing check.

## Compile a closed session policy

[Rhinestone's current session documentation](https://docs.rhinestone.dev/smart-wallet/smart-sessions/overview) requires `restrictToActions: true` to remove unmatched-call Orchestrator fallback. Set `signing: { mode: 'disabled' }` explicitly. Empty permissions or absent policies can confer broad authority. Reject `sudo`, wildcard actions, crosschain permits and claim policies. The documented restriction flag requires SDK `2.6.0` or later; this minimum alone does not prove the chosen package safe.

Decode and inspect the compiled configuration, not just the input object. Require exact target/selector/arguments, value bounds, timeframe and usage policies on every allowed path. A caller cannot provide arbitrary policy addresses, SDK environment, RPC URLs, validators, raw account calls or opaque signing payloads. Internal raw-action compilation is permitted only for reviewed V6 operation definitions.

The [pinned resolver](https://github.com/rhinestonewtf/sdk/blob/91f8f1edc80aa38e698033b5287b6aa7537bb641/src/modules/validators/smart-sessions/resolve.ts) distinguishes execution-checked sessions from a pure ERC-1271 mode. Verify the actual signature/execution path reaches the action policies. Disabling generic ERC-1271 signing must not disable the verified execution proof or silently switch to a broader signing mode.

Bind API account ID, immutable bot grant ID, registered smart account, client key, chain, full policy digest, module version, generation, explicit validity, execution nonces and any budget allocation. Resolve the key and expiry from authenticated records; request-body identifiers do not grant authority. The session cannot outlast its bound bot grant's approved expiry. Display the exact UTC interval before owner signing. Test the deployed timeframe policy's inclusive/exclusive boundaries and encode the requested interval accordingly. Renewal requires fresh owner approval; a 30-day preset must be labeled explicitly rather than implying every calendar month has 30 days.

Encode project IDs and amounts from exact decimal strings into checked Solidity integers. Registry permission grants require project IDs that fit `uint64`; payment amounts and policy counters use exact base units without floating-point conversion.

The [SDK permission ID](https://github.com/rhinestonewtf/sdk/blob/91f8f1edc80aa38e698033b5287b6aa7537bb641/src/modules/validators/smart-sessions/digest.ts) hashes validator, validator configuration and salt, excluding actions, limits and expiry. The inspected resolver supplies zero salt. A permission ID therefore cannot stand in for a full policy digest or generation. Reusing the same key may overwrite policy configuration or reset counters. Use verified distinct salts through a supported encoding path, or new client-generated session keys; reject collisions and verify the installed full configuration after every change.

A generation label in Center's database is not onchain replay protection. The selected legacy validator exposes `removeSession(bytes32)` and a separate [`revokeEnableSignature(bytes32)`](https://github.com/erc7579/smartsessions/blob/f24dddfcbf7269e10dcd4da90dae0a6ae6ccf188/contracts/core/NonceManager.sol#L28). Removal alone does not increment the enable nonce. Owner revocation plans must perform both, verify the new nonce and disabled permission, and reject reuse of old owner authorizations. Encode `enableSessions` from the matched ABI with a fresh explicit salt and full reviewed policy; no high-level SDK default may choose that salt.

### Action coverage and V6 caller semantics

The action catalog can grow through verified module policy definitions without deploying a new Center executor. Every operation has one of three authority modes: session-safe, fresh-owner, or explicit-budget. Reads, simulations, transaction preparation and metadata preparation do not acquire financial authority merely because they occur in a session.

| Operation                                                    | V6 method and authority                                                                           | Policy requirement                                                                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Project presentation                                         | `setUriOf(uint256,string)`, `0x702a3977`, permission `7`                                          | Fixed current canonical controller/project, zero value; owner explicitly permits the metadata change.                                          |
| NFT presentation                                             | `setMetadata(string,string,string,string,address,uint256,bytes32)`, `0x2c6bdd55`, permission `25` | Candidate: exact canonical hook/project, resolver equal to hook sentinel, tier ID zero and encoded URI zero; verify every required constraint. |
| Token presentation                                           | `setTokenMetadataOf(uint256,string,string)`, `0xfac3a6a2`, permission `22`                        | Candidate: canonical controller and canonical `JBERC20` clone/implementation/binding; reject custom tokens.                                    |
| Pay/add balance/cash-out/loans/distributions/bridges         | Their existing V6 plans                                                                           | Fresh owner approval; only a verified explicit payment allocation permits repeat pay.                                                          |
| Fixed-recipient ERC-20 payment                               | `transfer(address,uint256)`                                                                       | Only a dedicated, explicitly funded allocation with exact asset/beneficiary and proven cumulative limits; otherwise fresh owner approval.      |
| Rulesets/splits/controllers/terminals/permissions/ownership  | Their existing V6 plans                                                                           | Fresh owner approval, even if the call has zero native value.                                                                                  |
| Approvals/permits/module installation/recovery configuration | Wallet or token authority changes                                                                 | Fresh owner approval; never a bot-session action.                                                                                              |

The [controller](https://github.com/Bananapus/nana-core-v6/blob/898f08b96194391d545df31a62f9d89ef6759f9a/src/JBController.sol#L766), [721 hook](https://github.com/Bananapus/nana-721-hook-v6/blob/1ec28e68a550cc0c09428416fb9d7698959591f8/src/JB721TiersHook.sol#L467), and [JBERC20](https://github.com/Bananapus/nana-core-v6/blob/898f08b96194391d545df31a62f9d89ef6759f9a/src/JBERC20.sol#L122) establish the constrained presentation paths. The first compiler should enable only the paths whose complete policies it proves; unsupported paths retain fresh-owner planning.

The smart account calls V6 directly, so protocol `_msgSender()` is the smart-account address, not the API owner or bot. If the original wallet owns the project, it may freshly grant that smart account exact project-specific JBPermissions. Do not grant ROOT/wildcard permissions or grant the bot EOA directly. [JBPermissions](https://github.com/Bananapus/nana-core-v6/blob/898f08b96194391d545df31a62f9d89ef6759f9a/src/JBPermissions.sol#L41) itself has no expiry or target scope; the smart-account module enforces the session restrictions. Transferring the project NFT into the account is a separate fresh-approved ownership change.

Check current project owner, `DIRECTORY.controllerOf(projectId)`, hook ownership where applicable and canonical code/bindings. Static calldata policies do not automatically perform those state checks onchain. Any required invariant that depends on mutable external state needs an existing verified policy capable of enforcing it, or the action remains fresh-owner-only. Live checks cannot prove unseen transfer history: V6 has no ownership epoch, and transfer away/back may restore old grants. Metadata remains untrusted presentation, not proof of identity or safe external links.

## Explicit set-aside payment accounts

Use a separate registered owner-controlled smart account for a recurring-payment allocation. Fund only the approved asset/principal and install only its reviewed payment policy. This reuses the selected account/module stack; no new Center vault or executor contract is proposed. The owner's other wallets and spending accounts remain outside this session's authority.

The owner approves the exact chain/account, asset in integer base units, deposit, project ID, terminal, beneficiary, memo/metadata policy, per-call cap, lifetime cap, per-period allocation, minimum output, expiry and recovery path. Funding and every allowance increase require fresh approval. The payment session cannot pull from the owner's other wallet, top itself up, change a spender, transfer to the bot or pay its own sponsor fees from the payment allocation.

Direct `JBMultiTerminal.pay(uint256,address,uint256,address,uint256,string,bytes)` records the smart account as payer. Its [funding implementation](https://github.com/Bananapus/nana-core-v6/blob/898f08b96194391d545df31a62f9d89ef6759f9a/src/JBMultiTerminal.sol#L1053) uses actual `msg.value` for native payments and pulls ERC-20 from that account. A finite, owner-approved smart-account-to-terminal allowance can support ERC-20 repeats; permit metadata and session-created approval changes remain forbidden.

| Budget property | Required proof before recurring execution                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Isolated funds  | Dedicated verified account, explicit funded allocation, no other bot spend paths, independently usable owner withdrawal/revocation.                                   |
| Fixed route     | For V6 pay, exact canonical terminal/project/asset/beneficiary; for a direct payment, exact token and beneficiary. No session authority over routing/admin functions. |
| Fixed payload   | Start with empty memo and metadata. Prove their dynamic ABI offsets and zero lengths onchain; SDK input validation alone is insufficient.                             |
| Native cap      | Accumulate actual call value, not the ignored `amount` argument. A per-use maximum alone is not a lifetime cap.                                                       |
| ERC-20 cap      | Verify the policy accounts for the actual allowed terminal-payment amount and cannot be bypassed through token behavior, other selectors or existing allowances.      |
| All sessions    | Sum independently spendable limits across keys, permission IDs and actions; avoid duplicate counters granting the same allocation twice.                              |
| Periods         | Explicit nonoverlapping windows with disjoint approved allocations, or a verified onchain periodic policy; no database-only reset or automatic top-up.                |
| Terms/output    | Enforce approved minimum returned tokens and any required mutable economic constraints through verified onchain policy; otherwise require fresh approval.             |

The [Call policy](https://docs.rhinestone.dev/smart-wallet/smart-sessions/policies/call) documents static ABI argument constraints, cumulative argument usage and per-use value limits. The [Spending Limit policy](https://docs.rhinestone.dev/smart-wallet/smart-sessions/policies/spending-limit) documents cumulative ERC-20 transfer limits. Neither description alone proves terminal `transferFrom` accounting, dynamic metadata restrictions, or periodic reset semantics.

The verified UniAction source reads a 32-byte word at `data[4 + offset:4 + offset + 32]`, so offsets exclude the selector. For canonical empty `pay` tails, constrain memo offset `160` to `224`, metadata offset `192` to `256`, and lengths at offsets `224` and `256` to zero, alongside fixed project/token/beneficiary/output rules and amount caps. Malformed offsets, truncation and alternate encodings need contract tests. The ERC-20 SpendingLimit policy handles token transfer/approve selectors, not terminal `pay`; use verified UniAction amount accumulation for that route. Native `pay` instead needs actual-value accumulation. The [SDK encoder](https://github.com/rhinestonewtf/sdk/blob/91f8f1edc80aa38e698033b5287b6aa7537bb641/src/modules/validators/smart-sessions/policies/encode.ts) is useful reference material but is not the authoritative legacy-session encoding.

Reject unsupported fee-on-transfer, rebasing, callback or upgradeable tokens until exact behavior is proven. Native payment caps must cover actual value; output floors must not be weakened by the bot. Full derived ruleset identity includes cycle/start/weight/metadata: [`JBRuleset.id` survives auto-cycles](https://github.com/Bananapus/nana-core-v6/blob/898f08b96194391d545df31a62f9d89ef6759f9a/src/structs/JBRuleset.sol#L10). A policy that only compares calldata cannot pin changing ruleset state. Do not claim that an offchain preflight enforces this against direct session submission.

Smart-session counters may be updated during validation before execution. Verify failure behavior; a reverted UserOperation can still consume gas or policy allowance. Never refund/reset a budget counter in Center based on a failed receipt without matching canonical onchain state. Donations and later deposits must not silently increase the approved spend cap; replenishment is fresh-approved funding, and an account balance is not an authorization ledger.

Buyback hooks, 721 hooks, router terminals and revnets keep full read and fresh-owner plan support. Their recurring payment profiles require separate proof of closed calldata, all dependencies, refunds, asset/output accounting and allowed economic changes. A smart-account SDK does not automatically make every V6 operation session-safe.

### Omnichain allocations

Represent each `(chainId, smartAccountAddress, projectId, asset)` allocation separately. At most eight members per group; never sum incompatible assets or promise a shared atomic remaining balance across chains. An owner-signed manifest binds every local account, policy digest, generation, allocation and exact-unit cap; compatible-asset allocations must sum to the approved total.

Each chain enforces only its own verified policy. The compiler and owner review must reject duplicate allocations and overlapping independently spendable sessions. A module without crosschain accounting cannot enforce a global manifest merely because Center records it. Reusing a retired allocation requires fresh approval, confirmed revocation and reconciliation of old spending. A pending revocation or source bridge receipt never establishes freed capacity or destination credit.

## Interfaces and lifecycle

The smart-account integration should expose typed capability discovery, account verification/registration, policy compilation, installation planning, execution planning, revocation planning and receipt verification. Keep providers and private URLs injectable through server configuration. The policy compiler emits a reviewable intermediate representation, exact module configuration and typed signing payload; it never accepts arbitrary call targets or user-selected transports.

| Proposed resource under `/api/v1`                 | Authority and result                                                                            |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /smart-accounts/capabilities`                | Chain-specific verified stack, policy features, transport mode and explicit unavailable reasons |
| `POST /smart-accounts/plans`                      | Owner-reviewed exact factory/setup plan for a distinct account address                          |
| `POST /smart-accounts`, `GET /smart-accounts/:id` | Owner claim plus verified registry record, never body-derived authority                         |
| `POST /sessions/plans`, `GET /sessions/:id`       | Full policy/installation plan and canonical observed session status                             |
| `POST /sessions/:id/action-plans`                 | Only a compiled V6 operation under the registered account and exact active policy               |
| `POST /sessions/:id/revocation-plans`             | Fresh owner authorization and independent API/onchain revocation state                          |
| `POST /budgets/plans`, `GET /budgets/:id`         | Dedicated account funding/allocation proposal and observed funds/counters                       |
| `POST /budgets/:id/payment-plans`                 | Exact payment only when all required deployed policy features are verified                      |
| `POST /budgets/:id/recovery-plans`                | Owner withdrawal, session disable and allowance cleanup through normal account authority        |

These resource names describe the intended interface, not a claim that every endpoint is already mounted. [Authentication](AUTHENTICATION.md) continues to sign exact HTTP requests. Normal API owner signatures and smart-account owner authorization are verified separately; neither substitutes for the other.

Account lifecycle: `proposed -> counterfactual | verifying -> verified`, then `stale | unsupported` when bindings cannot be reverified. Session lifecycle: `draft -> awaiting-owner -> submitted -> active -> expired | revoked`; pending disable is `revoking`. Installation requires canonical module/configuration evidence. Budget funding, allowance setup, payment and withdrawal each have independent pending/confirmed records; expiry does not imply withdrawal.

API grant revocation stops future Center admissions but cannot prevent direct use of an otherwise active onchain session. Expose the separate owner-signed module disable operation and outstanding enable-authorization invalidation. Chain ordering determines whether an already submitted operation executes before revocation. Reorganizations invalidate affected observations until canonical state is established again.

Receipt proof starts with the exact registered account, execution mode, installed validator/session ID, full policy digest, generation and nonce. For ERC-4337, verify the exact EntryPoint UserOperation and account execution result; for another module execution path, require its distinct verified proof. Then verify inner V6 effects with the smart account as caller/payer. Never label the bot or original owner as the inner protocol caller. Provider success or transaction inclusion alone is not a verified payment result.

## Execution and gas

Choose a transport only after verifying that the chosen account/module stack supports it. ERC-4337 requires a pinned EntryPoint version, correct UserOperation encoding/nonce namespace, compatible bundler, paymaster rules and receipt proof. A module's alternative execution or intent route is a separate adapter; no unmatched-call fallback may broaden the owner-approved actions.

The stock V6 [ERC-2771 forwarder](https://github.com/Bananapus/nana-core-v6/blob/898f08b96194391d545df31a62f9d89ef6759f9a/script/Deploy.s.sol#L63) authenticates one ECDSA request; it is not a general Safe/Smart Sessions execution adapter. Existing Relayr forwarding must not be relabeled as smart-account session support. Keep current EOA/Safe transaction transport available while the new adapter is verified.

Relayr gas funding, ERC-4337 paymaster credit and project-payment allocations are distinct. The existing [Relayr client](https://github.com/mejango/juicebox-money/blob/c262a2fa7365af963ffb928b17deb45758235b57/src/lib/relayr.ts#L42) pins its own payment code and four mainnets; that proves neither account-abstraction compatibility nor user spending balance. Owner-funded gas needs explicit approval; a sponsor may fund its own quota. Safe7579 can pay `missingAccountFunds` from the Safe during validation, outside action value limits. Native payment allocations therefore require proven onchain gas/prefund restrictions or a mandatory verified sponsorship path; an offchain sponsor preference cannot prevent direct session submission from draining gas from that balance.

## Chain verification and implementation gates

The source-bound legacy validator and three current policies above matched across all eight chains at these blocks; their block hashes were rechecked after the reads. This proves observed deployed code, not account installation, independent-node consensus or usable execution. The factory/singleton/adapter, EntryPoint, complete module inspector and durable UserOperation transport must still form one verified integration. Keep session execution unavailable until those gates pass:

| Chain                       | Observed block | Current release gate                                 |
| --------------------------- | -------------- | ---------------------------------------------------- |
| Ethereum `1`                | `25923286`     | Account/EntryPoint/inspector/transport integration   |
| Optimism `10`               | `156579447`    | Account/EntryPoint/inspector/transport integration   |
| Base `8453`                 | `50984162`     | Account/EntryPoint/inspector/transport integration   |
| Arbitrum `42161`            | `502573441`    | Account/EntryPoint/inspector/transport integration   |
| Ethereum Sepolia `11155111` | `11652036`     | First complete account/EntryPoint integration target |
| Optimism Sepolia `11155420` | `48477566`     | Independent account/EntryPoint/transport proof       |
| Base Sepolia `84532`        | `46494692`     | Independent account/EntryPoint/transport proof       |
| Arbitrum Sepolia `421614`   | `306272332`    | Independent account/EntryPoint/transport proof       |

Implement in this order:

1. Pin one SDK/contract stack and its reviewed source/artifact hashes. Add a deployment manifest with per-chain code, deployment and transport evidence; missing facts remain explicit, never copied across chains.
2. Build the owner-bound verified account registry and read-only capability reporting. Keep execution disabled for unverified accounts, unknown configurations and unavailable policy features.
3. Build a closed policy compiler and independently decode its output. Prove target/selector/value/argument/timeframe restrictions, policy identity, revocation and signature routing with source-matched fixtures and contract tests.
4. Add exact owner setup/enable/disable plans, typed client signatures, immutable plan records and durable nonce/idempotency admission. No server-held session or owner keys.
5. Add a verified execution/receipt adapter on supported testnets, then verify the same pinned stack independently on each mainnet. Gas support and policy support are separate capability fields.
6. Enable recurring payments only after actual value/token counters, dynamic metadata constraints, period allocation and recovery are proven. Features lacking an existing verified policy stay fresh-owner operations; this work does not create custom Solidity to fill gaps.

Required tests include direct submissions bypassing Center; same-key permission-ID collisions; old enable signatures after revocation; wrong chain/account/validator nonce; empty/wildcard/sudo policies; signature mode bypass; unknown modules/fallbacks; delegatecall or nested batch escapes; owner/threshold rotation; mutable V6 bindings; metadata-offset tricks and Permit2 payloads; native `amount` versus `msg.value`; concurrent and failed executions; overlapping period/key allocations; sponsor depletion; allowance abuse; owner recovery without Center; reorgs; and inner caller/financial proof mismatches.

A custom narrow executor/vault remains an architectural tradeoff if existing modules cannot express a required invariant, but it adds contract implementation, audit and deployment work. The selected path is verified smart-account integration. API grants, account discovery and safe planning can ship independently; onchain sessions and payments become active only when the corresponding contract and execution evidence exists.
