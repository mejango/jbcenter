# Shared Juicebox wallet infrastructure

Specification revision, 2026-09-13. Center is the selected shared home; the passkey account design below is proposed and requires the compatibility gates in this document. This is not an implementation or deployment claim.

## Decision and scope

Juicebox Center supplies a user-controlled wallet shared across its allowlisted, trusted first-party applications. Users sign in to the Juicebox ecosystem; allowlisted apps receive the standard wallet connection without a separate per-site consent screen. Beep is the first payment client; Juicebox Money is the second integration required to prove sharing. Account creation, credential management, recovery, app connections, signing review, and execution belong in Center. Each application retains its product data and transaction intent.

Start with Base, the existing V6 payment path, and the existing Safe execution infrastructure. Reuse Center's client package and authorization machinery. Add an isolated Center wallet UI and a browser connector before considering another SDK package. Native iOS must use the same account and credential authority. Other chains follow explicit compatibility validation; shared identity does not promise identical addresses or pooled balances across chains.

The first release does not build an MPC service, replace fiat onramps, introduce default delegated spending, or require every existing-wallet customer to create a Center wallet. Existing Para and external-wallet paths continue during migration.

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

Allowlisted apps share the selected wallet identity and account addresses under the ecosystem sign-in. Explain this once in onboarding; do not require pairwise identities or a per-site permissions dashboard for the first release. App-specific private product data remains outside the standard wallet connection. Reusing the same public onchain address is inherently linkable and must not be presented as private.

## Passkeys and account compatibility

Preferred candidate: a Safe owned through an established WebAuthn/P-256 contract signer, with a user-controlled backup authority. Reuse pinned, reviewed implementations. Safe's general passkey support does not prove compatibility with Center's exact Safe7579/EntryPoint stack.

Center's REST signature verifier already has an optional ERC-1271 contract-owner path. Extend and test the entire journey: bootstrap, creation, owner verification, binding, setup grants, SafeOp signatures, simulation, relay, rotation, and revocation. Beep's current client locally recovers EOA typed-data signatures and must move to the shared verifier/connector. Do not make a passkey pretend to be a secp256k1 EOA.

Publish a versioned account manifest covering the factory, initializer, Safe/adapter, passkey verifier, signature encoding, chain capabilities, and recovery configuration. Account inspection must validate current authority as well as original deployment. Bound contract verification gas/time and fail closed on unavailable evidence. Check exact challenge binding, user verification, RP/origin enforcement, signature malleability, replay protection, and onchain/offchain verifier agreement. A generic WebAuthn library's name is not evidence that every field is enforced.

Bootstrap must prove possession of the intended credential and bind the exact initial account configuration before spending deployment gas. Undeployed accounts cannot rely solely on an ERC-1271 call to nonexistent code. No temporary Center-owned wallet or unfunded EOA is substituted for the intended spending account.

## Shared connection and approval journey

Use one dedicated Center wallet origin and a deliberately chosen long-lived RP ID. The exact host is a deployment decision to settle before issuing credentials. Passkeys are scoped to their relying party; independent Juicebox application domains do not simply inherit them.

Reuse Center's existing environment-specific origin allowlist as the source of trusted web apps. The inspected `src/app.ts` list currently gates `/v1/*`; it is not itself wallet authentication or authorization for `/api/v1/*`. Wire this same trust configuration into wallet connection and return-origin validation. Retain Beep's exact deployment origin, `https://beep.biz`, which is included in the reconciled baseline. Reject nonallowlisted wallet connections in the first release. Register native application identities and verified callbacks explicitly against the same first-party policy.

1. Beep opens Center with its app identifier, exact return location, and a short-lived connection request for standard wallet access.
2. Center validates the allowlisted app and return location, authenticates the user if needed, and resolves or creates the intended wallet. No per-site connection approval appears.
3. A one-time authorization code bound to the requesting client and PKCE challenge returns to the application. Validate state, expiry, redirect registration, single use, and audience. Do not put reusable credentials in URLs.
4. The app receives a short-lived, app-bound connection grant automatically under the first-party policy. Connecting Juicebox Money later resolves the same chosen Base account without another connection consent; a Center handoff may still be needed to establish its session.
5. The app requests a concrete operation. Center independently reconstructs the allowed calls and displays the app, chain, account, asset, amount, recipient/project, and relevant output constraints on its isolated origin.
6. The user approves the exact operation with their credential. Center verifies and relays it; the app resumes using a durable operation reference.

Use established authorization protocol components rather than inventing a new token format. Cross-window messages require exact origin and request checks. Native clients require verified return links and supported associated-domain configuration. Do not depend on third-party cookies or silent cross-origin iframes. Test same-device browser/app transitions before promising prompt counts.

Center's wallet origin must be isolated from third-party scripts and ordinary app deployments. App-supplied text is untrusted presentation data. The passkey prompt establishes user verification; Center's review must make the actual transaction understandable and bind it to the signature.

## Permissions and sponsorship

The allowlist establishes which apps Center trusts for automatic connection; the authenticated user session establishes whose wallet is being connected. An app identifier or a caller-supplied Origin header alone is never proof of user authentication. Default grants permit standard wallet reads, planning, and relay of an already authorized operation. They cannot change ownership, add credentials, manage recovery, mint another app's session, or produce spending signatures.

Reuse Center's existing API grants where they fit, adding enforced app/audience binding without a user-facing grant ceremony for standard first-party connections. Restrict wallet and chain scope, expiry, and request replay. Allowlist removal must block new connections and invalidate existing app access without deleting the wallet or affecting other apps. Check current app eligibility on authorized requests or enforce equivalent revocation. Global sign-out and credential compromise/recovery invalidate affected sessions and pending approvals. Revoking an API grant alone cannot cancel an already valid onchain signature; respect operation validity and nonce semantics.

Fresh owner approval remains the default for every transaction. Any later delegated authority requires a separate user-approved, onchain-enforceable policy; no app receives it because it is a Juicebox app. Project administration and general arbitrary calls are not implicitly granted by a payment connection.

Maintain per-app, per-account, and global sponsorship limits with atomic reservations, expiry, idempotency, and canonical settlement. A compromised or popular app must not consume another app's budget. Move reusable sponsored creation orchestration into Center; Beep retains invoice eligibility checks and signs only narrowly bound eligibility attestations. A gas sponsor never becomes an owner.

## Recovery and independent exit

Initial recovery candidate: a second independently controlled credential or external-wallet owner, with explicit enrollment and owner approval. Two credentials synced through the same provider are not an independent recovery guarantee. State clearly what happens if all user-controlled recovery factors are lost.

Email, SMS, WhatsApp, support staff, app administrators, and Center database edits cannot unilaterally replace wallet authority. Social recovery or delayed guardian recovery requires a separately specified threshold, delay, cancellation path, implementation review, and tests before launch; it is not implied by a contact-verification screen.

Passkeys generally do not provide private-key export. Portability therefore means reconstructing the account and changing/using its owners through a tested compatible client. Before real deposits, provide a user-held account descriptor and a tested alternate-client withdrawal path using independent recovery authority. The test must work with Center's API and wallet domain unavailable, including a way to pay gas without Center sponsorship. Merely open-sourcing a UI is insufficient because the original passkey remains RP-scoped.

Show recovery readiness and its consequences before funding. Never advertise recovery from total credential loss unless an enrolled mechanism actually provides it. Canonically confirm authority changes and revalidate binding before removing the previous working access method.

## Existing wallet migration

Inventory actual Para-controlled Safes and their owners/modules before selecting migration transactions. Prefer an explicit current-owner-approved change of authority that preserves the existing Safe address and assets, if the verified stack supports it. Check outstanding grants, signatures, allowances, and sessions when authority changes. Keep the old path usable until the new authority and recovery path are verified; expose any temporary overlapping authority to the user.

If preserving an account is unsupported, show an explicit new-account and asset-transfer migration. Project credits, nontransferable positions, and administrative permissions may not move with ERC-20 balances. Do not silently generate a new address or declare migration complete after copying an email identity.

Para remains a legacy signer option while new Center wallets are introduced. Removing Para also requires replacing the current funding-provider integration. Wallet sharing with Juicebox Money is proven by integration, not assumed from using the same provider or login identifier.

## Acceptance and delivery

| Stage | Required evidence |
| --- | --- |
| 1. Compatibility spike | Real passkey assertion through exact Safe7579 stack; sponsored Base V6 payment on a pinned fork; negative signature and authority tests |
| 2. Center wallet | Create, restore, fund, pay, receive project tokens/credits, add backup, rotate authority, withdraw; browser and real iOS device evidence |
| 3. Shared integration | Beep creates/connects an account; allowlisted Juicebox Money connects the same address without another consent screen; nonallowlisted apps rejected, app-bound sessions, allowlist-removal revocation, separate sponsorship budgets |
| 4. Recovery and migration | Device/provider-loss scenarios, Center-domain/API outage withdrawal, existing Safe migration with unchanged address where supported |
| 5. Limited rollout | External review of new contracts and authorization boundaries, remediations, bounded gas/deposit exposure, monitoring and incident runbook; live canonical payment receipts |

Mandatory adversarial cases: unauthenticated caller spoofing an allowlisted Origin/app identifier, removed app retaining access, cross-app token reuse, redirect/code replay, changed transaction after review, credential added without owner consent, account substitution, stale authority after recovery, double submission, lost response after broadcast, sponsorship exhaustion, provider outage, and chain reorg. Unknown remains unknown and never triggers a new payment automatically.

Beep acceptance stays concrete: fixed invoice, exact Base USDC payment, Safe beneficiary, verified project-token/credit delivery, one receipt and one device beep. Center operation success alone does not establish invoice fulfillment.

First implementation milestone is the compatibility spike and Center browser wallet used by two apps. Set firm delivery estimates after measuring stack compatibility and reviewing the chosen recovery design. Do not expand to every chain or ship an MPC service to satisfy this milestone.

## Evidence and open decisions

Reviewed local sources: Center `src/rest/auth/signatures.ts` (existing ERC-1271 hook), `src/rest/client/SMART_WALLETS.md` (current EOA-owner smart-wallet journey); Beep `src/center.ts`, `src/client/para.tsx`, `src/payment-account.ts`, and `SPONSORSHIP.md`. Source inspection is not proof of hosted feature availability.

Primary references: [Safe passkey architecture](https://docs.safe.global/advanced/passkeys/passkeys-safe), [WebAuthn specification](https://www.w3.org/TR/webauthn-3/), [OAuth authorization code flow with PKCE](https://www.rfc-editor.org/rfc/rfc7636).

Resolve during the spike: exact signer/recovery contract revisions and stack compatibility; long-lived wallet origin/RP ID and native associations; legacy identity mapping; backup-owner UX; onramp replacement; production budget and operational owner. These are implementation decisions under the selected Center direction, not reasons to delay the compatibility work.
