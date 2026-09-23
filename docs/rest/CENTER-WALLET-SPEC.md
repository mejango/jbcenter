# Shared Juicebox wallet infrastructure

Specification revision, 2026-09-13, reviewed against Center `109cb0e`. Center is the selected shared home; the passkey account design below is proposed and requires the compatibility gates in this document. The [implementation strategy](CENTER-WALLET-PLAN.md) defines dependencies, TDD evidence and pressure qualification. This is not an implementation or deployment claim.

## Decision and scope

Juicebox Center supplies a user-controlled wallet shared across its allowlisted, trusted first-party applications. Users sign in to the Juicebox ecosystem; allowlisted apps receive the standard wallet connection without a separate per-site consent screen. Beep is the first payment client; Juicebox Money is the second integration required to prove sharing. Account creation, credential management, recovery, app connections, signing review, and execution belong in Center. Each application retains its product data and transaction intent.

Start with Base, the existing V6 payment path, and the existing Safe execution infrastructure. Reuse Center's client package and authorization machinery. Add an isolated Center wallet UI and a browser connector before considering another SDK package. Native iOS must use the same account and credential authority. Other chains follow explicit compatibility validation; shared identity does not promise identical addresses or pooled balances across chains.

The first release does not build an MPC service, replace fiat onramps, introduce default delegated spending, or require every existing-wallet customer to create a Center wallet. Center retires Para while preserving passkeys, external-wallet support and existing account records. This retirement does not change Money or Revnet. Beep removes its Para integration and uses Center for its built-in wallet under its separate integration plan.

Authentication decision: new Center wallets use passkeys for creation, sign-in and exact payment approval. No email address, phone number or messaging verification is required for this first-release journey. Recovery still requires the independently enrolled authority described below. WhatsApp is a possible later integration for verified contact details, account discovery or notifications; it is not a launch dependency or a selected provider. Email and SMS verification are outside the first-release scope. Any future contact channel must not become unilateral wallet recovery authority.

## Responsibilities

| Capability | Center | Application |
| --- | --- | --- |
| Account identity | Stable wallet record, verified chain accounts, credential and authority changes | Store the shared account reference |
| Authentication | Passkey registration and sign-in; contact verification deferred | Initiate a connection and resume its own journey |
| Authorization | Allowlist-based connection, app-bound API sessions, isolated transaction review, fresh spending signatures | Use standard connection capabilities and show the intended action |
| Execution | Account deployment, binding, simulation, relay, canonical operation status | Construct product intent and independently verify fulfillment |
| Sponsorship | Shared admission machinery, separate app budgets and quotas | Own its budget and attest product eligibility |
| Funding and exit | Verified receive destination, provider adapters, send/withdraw and recovery | Offer Add money when needed |
| Product state | Wallet connection and operation identifiers | Beep invoices/devices/receipts; other apps' own workflows |

Center hosts infrastructure, not customer spending keys. Its servers and app credentials must not independently authorize spending, replace owners, or recover accounts. Contract upgrade and recovery powers are part of this requirement, not exceptions to it.

## Identity and authority

Separate four concepts: a wallet record, its onchain accounts, its current credentials/owners, and each app's grants. A passkey or email address is not the permanent wallet identifier. Credential rotation must preserve the existing account address. Do not derive a replacement spending account from each new credential or application ID.

Preserve current signed REST account identifiers and their meaning. Introduce a wallet registry only for the necessary stable mapping; version any new wire schema rather than silently reinterpreting existing owner-derived IDs. Linking legacy identities requires proof of each relevant authority. Matching email addresses is not proof that two wallets should merge.

For new wallets, the working choice is the Base Safe itself as the canonical API principal, `eip155:8453:<safe-address>`, subject to proving its real ERC-1271 authentication path in Gate A. Use an explicit new account profile. Existing onboarding requires a distinct sole EOA owner; do not remove those checks from legacy profiles. Fix the deployment salt and exact initializer for an enrollment attempt so concurrent retries resolve the same account. Rotation preserves wallet identity, address, receipts and operation recovery while invalidating stale authority and renewing canonical binding.

Allowlisted apps share the selected wallet identity and account addresses under the ecosystem sign-in. Explain this once in onboarding; do not require pairwise identities or a per-site permissions dashboard for the first release. App-specific private product data remains outside the standard wallet connection. Reusing the same public onchain address is inherently linkable and must not be presented as private.

## Passkeys and account compatibility

Preferred candidate: a Safe owned through an established WebAuthn/P-256 contract signer, with a user-controlled backup authority. Reuse pinned, reviewed implementations. Safe's general passkey support does not prove compatibility with Center's exact Safe7579/EntryPoint stack.

Let the user choose a memorable display name before passkey creation, such as "Personal Juicebox". Send the account display metadata through WebAuthn `user.name` and `user.displayName`; the passkey provider controls its presentation and may truncate it. Keep any Center credential nickname separately editable presentation metadata. Names never determine the opaque user handle, wallet address, credential lookup or authority, and equal names never merge accounts. Changing a Center nickname does not promise to rename an existing credential in every provider. The local device probe exercises naming first; durable enrollment and management UI must implement these semantics before claiming production support. See [WebAuthn user account parameters](https://www.w3.org/TR/webauthn-3/#dictdef-publickeycredentialuserentity).

Center's REST signature verifier already has an optional ERC-1271 contract-owner path. Extend and test the entire journey: bootstrap, creation, owner verification, binding, setup grants, SafeOp signatures, simulation, relay, rotation, and revocation. Beep's current client locally recovers EOA typed-data signatures and must move to the shared verifier/connector. Do not make a passkey pretend to be a secp256k1 EOA.

The inspected smart-account service still rejects contract owners; binding and execution expect packed EOA signatures, and estimation assumes 65 bytes per owner. Prove the contract-signature envelope, dynamic offsets, supported selectors, bounded calldata and verification gas through actual inspection, estimation, approval, preflight and execution. In the pinned Safe7579 owner path, ERC-1271 uses a zero-validator prefix and SafeMessage; UserOperation approval uses a separate SafeOp digest and validity envelope. Their signatures are not interchangeable. Never change reviewed gas fields after signing.

Publish a versioned account manifest covering the factory, initializer, Safe/adapter, passkey verifier, signature encoding, chain capabilities, and recovery configuration. Account inspection must validate current authority as well as original deployment. Bound contract verification gas/time and fail closed on unavailable evidence. Check exact challenge binding, user verification, RP/origin enforcement, signature malleability, replay protection, and onchain/offchain verifier agreement. A generic WebAuthn library's name is not evidence that every field is enforced.

Center derives challenges from trusted operation context and durably consumes ceremony state. Separate registration, login, deployment, session setup, payment and owner-administration purposes; bind the expected account, action, origin/RP, expiry and nonce as applicable. A login assertion cannot authorize payment, backup enrollment or rotation. Do not expose an app-controlled arbitrary challenge signer. Require user verification, bounded parsing and explicit server-owned verifier expectations, including correct synced-passkey counter handling.

Bootstrap must prove possession of the intended credential and bind the exact initial account configuration before spending deployment gas. Undeployed accounts cannot rely solely on an ERC-1271 call to nonexistent code. No temporary Center-owned wallet or unfunded EOA is substituted for the intended spending account.

## Shared connection and approval journey

The proposed dedicated origin is `https://wallet.juicebox.center`, with exact RP ID `wallet.juicebox.center`. Confirm hosting isolation and native association support in Gate A before issuing durable production credentials. Keep development credentials on a distinct test origin/RP. Use discoverable credentials and stable opaque user handles. Passkeys are scoped to their relying party; independent Juicebox application domains do not simply inherit them. Probe physical iPhone Safari, Android Chrome and native iOS handoff before freezing the account/RP design.

Reuse Center's existing environment-specific origin allowlist as the source of trusted web apps. The inspected `src/app.ts` list currently gates `/v1/*`; it is not itself wallet authentication or authorization for `/api/v1/*`. Wire this same trust configuration into wallet connection and return-origin validation. Retain Beep's exact deployment origin, `https://beep.biz`, which is included in the reconciled baseline. Reject nonallowlisted wallet connections in the first release. Register native application identities and verified callbacks explicitly against the same first-party policy.

Current allowlist configuration is captured at process startup. To make removal enforceable across replicas, activate the wallet-policy snapshot from that same configuration atomically in PostgreSQL with a revision. Check shared active eligibility at grant issuance and use; a stale process restart cannot restore an older policy. Extend the same configuration with exact callbacks. This is shared policy activation, not another app-consent registry.

1. Beep opens Center with its app identifier, exact return location, and a short-lived connection request for standard wallet access.
2. Center validates the allowlisted app and return location, authenticates the user if needed, and resolves or creates the intended wallet. No per-site connection approval appears.
3. A one-time authorization code bound to the requesting client, selected wallet, browser request-signing key and PKCE S256 challenge returns to the application. Validate state, issuer, expiry, exact registered callback, single use and audience. Each app creates its browser key locally; no private key crosses the handoff. Do not put reusable credentials in URLs.
4. The app receives a short-lived, app-bound connection grant automatically under the first-party policy. Connecting Juicebox Money later resolves the same chosen Base account without another connection consent; a Center handoff may still be needed to establish its session.
5. The app requests a concrete operation. Center independently reconstructs the allowed calls and displays the app, chain, account, asset, amount, recipient/project, and relevant output constraints on its isolated origin.
6. The user approves the exact operation with their credential. Center verifies and relays it; the app resumes using a durable operation reference.

Use established authorization protocol components rather than inventing a new token format. Cross-window messages require exact origin and request checks. Native clients require verified return links and supported associated-domain configuration. Do not depend on third-party cookies or silent cross-origin iframes. Test same-device browser/app transitions before promising prompt counts.

Keep the Center session in a host-only Secure/HttpOnly cookie with bounded expiry and CSRF protection. Use short-lived app grants and reauthentication for the initial release; a refresh-token service is not required. Session authentication permits standard API access, not spending or enrollment of additional authority.

Center's wallet origin must be isolated from third-party scripts and ordinary app deployments. App-supplied text is untrusted presentation data. The passkey prompt establishes user verification; Center's review must make the actual transaction understandable and bind it to the signature.

## Permissions and sponsorship

The allowlist establishes which apps Center trusts for automatic connection; the authenticated user session establishes whose wallet is being connected. An app identifier or a caller-supplied Origin header alone is never proof of user authentication. Default grants permit standard wallet reads, planning, and relay of an already authorized operation. They cannot change ownership, add credentials, manage recovery, mint another app's session, or produce spending signatures.

Reuse Center's existing API grants where they fit, adding enforced app/audience binding without a user-facing grant ceremony for standard first-party connections. Restrict wallet and chain scope, expiry, and request replay. Allowlist removal must block new connections and invalidate existing app access without deleting the wallet or affecting other apps. Check current app eligibility on authorized requests or enforce equivalent revocation. Global sign-out and credential compromise/recovery invalidate affected sessions and pending approvals. Revoking an API grant alone cannot cancel an already valid onchain signature; respect operation validity and nonce semantics.

Existing bot registration requires owner-signed approval. Add a separately typed first-party session-grant admission path for automatic allowlisted connections; reuse request verification and storage where appropriate. Do not fabricate an owner principal from a cookie, broaden existing bot grants, or let an app grant enroll another signer.

Fresh owner approval remains the default for every transaction. Any later delegated authority requires a separate user-approved, onchain-enforceable policy; no app receives it because it is a Juicebox app. Project administration and general arbitrary calls are not implicitly granted by a payment connection.

Maintain per-app, per-account, and global sponsorship limits with atomic reservations, expiry, idempotency, and canonical settlement. A compromised or popular app must not consume another app's budget. Move reusable sponsored creation orchestration into Center; Beep retains invoice eligibility checks and signs only narrowly bound eligibility attestations. A gas sponsor never becomes an owner.

Persist the original operation and signed commitment before dispatch. Ambiguous provider acceptance remains unknown until reconciled; an HTTP timeout or reservation TTL is not evidence that gas was never spent. Do not release potentially spent budget or create another payment on that basis. Require at most one business effect and explicitly define any byte-identical transport rebroadcast policy.

## Recovery and independent exit

Gate A's technical pilot candidate uses a primary passkey contract owner plus an independently controlled external EOA, with threshold 1-of-2. Either owner has full spending authority; show this clearly and require possession proof and explicit approval to enroll it. Prove a direct Safe withdrawal using the backup and independently funded gas with Center's domain, API, bundler and paymaster unavailable. Another passkey at the same RP can help device redundancy but cannot independently solve loss of that domain. Two credentials synced through the same provider are not an independent recovery guarantee.

This external-wallet pilot does not settle recovery for a person with no existing wallet. Before public funding, choose and test an accessible user-controlled recovery experience, including independent exit, possession proof and explicit consequences of total factor loss. A separately stored recovery credential/package is a candidate, not a selected implementation. Do not silently require an existing wallet or describe support recovery as the solution. This decision does not delay the bounded compatibility experiment.

Email, SMS, WhatsApp, support staff, app administrators, and Center database edits cannot unilaterally replace wallet authority. Social recovery or delayed guardian recovery requires a separately specified threshold, delay, cancellation path, implementation review, and tests before launch; it is not implied by a contact-verification screen.

Passkeys generally do not provide private-key export. Portability therefore means reconstructing the account and changing/using its owners through a tested compatible client. Before real deposits, provide a user-held account descriptor and a tested alternate-client withdrawal path using independent recovery authority. The test must work with Center's API and wallet domain unavailable, including a way to pay gas without Center sponsorship. Merely open-sourcing a UI is insufficient because the original passkey remains RP-scoped.

Show recovery readiness and its consequences before funding. Never advertise recovery from total credential loss unless an enrolled mechanism actually provides it. Canonically confirm authority changes and revalidate binding before removing the previous working access method.

## Existing wallet migration

Current scope: Center's Para retirement does not automatically convert existing Para accounts to passkey accounts. No migration is included; the guidance below is retained for separately authorized migration work.

Inventory actual Para-controlled Safes and their owners/modules before selecting migration transactions. Prefer an explicit current-owner-approved change of authority that preserves the existing Safe address and assets, if the verified stack supports it. Check outstanding grants, signatures, allowances, and sessions when authority changes. Keep the old path usable until the new authority and recovery path are verified; expose any temporary overlapping authority to the user.

If preserving an account is unsupported, show an explicit new-account and asset-transfer migration. Project credits, nontransferable positions, and administrative permissions may not move with ERC-20 balances. Do not silently generate a new address or declare migration complete after copying an email identity.

Center's Para signer is retired. Funding remains available through transfers from external wallets; this change adds no replacement onramp. Wallet sharing with Juicebox Money is proven by integration, not assumed from using the same provider or login identifier.

## Acceptance and delivery

| Stage | Required evidence |
| --- | --- |
| 1. Compatibility spike | Real assertions through distinct SafeMessage/ERC-1271 and SafeOp paths; stable Safe principal, inspection/binding, gas estimation and sponsored Base V6 execution on a pinned fork; negative signature/authority tests, early physical-device/native probe and independent backup exit |
| 2. Center wallet | Create, restore, fund, pay, receive project tokens/credits, add backup, rotate authority, withdraw; browser and real iOS device evidence |
| 3. Shared integration | Beep and allowlisted Juicebox Money connect the same address and each complete a supported V6 payment without another connection consent screen; nonallowlisted apps rejected, app-bound sessions, shared allowlist-removal revocation, separate sponsorship budgets |
| 4. Recovery and migration readiness | Device/provider-loss scenarios and Center-domain/API outage withdrawal before new-wallet funding; legacy-path regressions and migration design; signed migration rehearsal with unchanged address where supported before moving existing users |
| 5. Limited rollout | External review of new contracts and authorization boundaries, remediations, consumer recovery decision and tests, bounded gas/deposit exposure, measured wallet pressure/failure results, monitoring and incident runbook; live canonical payment receipts |

Mandatory adversarial cases: unauthenticated caller spoofing an allowlisted Origin/app identifier, removed app retaining access, cross-app token reuse, redirect/code replay, changed transaction after review, credential added without owner consent, account substitution, stale authority after recovery, double submission, lost response after broadcast, sponsorship exhaustion, provider outage, and chain reorg. Unknown remains unknown and never triggers a new payment automatically.

Beep acceptance stays concrete: fixed invoice, exact Base USDC payment, Safe beneficiary, verified project-token/credit delivery, one receipt and one device beep. Center operation success alone does not establish invoice fulfillment.

Use TDD at each authority and durable-state boundary, with pinned contracts, real PostgreSQL and two actual service processes for races/crashes. Require database/execution suites with no missing coverage or silent skips. The existing public-search load script does not establish wallet capacity. The strategy specifies successful authenticated throughput, latency, overload fairness, ambiguous-operation recovery, retention and restore gates; report local, physical-device and real-provider evidence separately.

First implementation milestone is the compatibility spike and Center browser wallet used by two apps. Set firm delivery estimates after measuring stack compatibility and reviewing the chosen recovery design. Do not expand to every chain or ship an MPC service to satisfy this milestone.

## Evidence and open decisions

Reviewed local sources: Center `src/rest/auth/signatures.ts`, `contractOwner.ts`, `smartAccounts/{service,onboarding,accountExecution}.ts`, `userOperations/service.ts`, `src/app.ts`, client/recovery code and PostgreSQL tests; Beep `src/embedded-wallet.ts`, `src/center.ts`, `src/client/para.tsx`, `src/payment-account.ts`, and `SPONSORSHIP.md`; Money's wallet hook and Para/Safe connectors. Center paths after the first REST path are relative to `src/rest/` unless explicitly qualified. Source inspection is not proof of hosted feature availability.

Primary references: [Safe passkey architecture](https://docs.safe.global/advanced/passkeys/passkeys-safe), [pinned Safe7579 signature paths](https://raw.githubusercontent.com/rhinestonewtf/safe7579/f22a194148ff087f0c16125e530512e59794e188/src/Safe7579.sol), [WebAuthn specification](https://www.w3.org/TR/webauthn-3/), [OAuth security BCP](https://www.rfc-editor.org/rfc/rfc9700). The selected principal, recovery candidate and deployment topology are design judgments subject to these compatibility gates.

Resolve during the spike: exact signer/recovery contract revisions and stack compatibility; stable-principal proof; proposed origin/RP and native associations; independent pilot recovery. Resolve before public funding: consumer recovery experience, supported funding path including whether an onramp adapter is needed, production budget and operational ownership. Legacy migration requires a separate authority/asset inventory. These are implementation decisions under the selected Center direction, not reasons to delay the compatibility work.
