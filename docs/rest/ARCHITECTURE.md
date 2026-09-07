# Signed REST access to Juicebox V6

Implementation architecture. The generated OpenAPI specification describes the mounted routes;
capability discovery reports which execution transports and deployment adapters are configured.

## Confirmed scope

- Operate within the existing jbcenter service at juicebox.center.
- Include the official repositories in Bananapus/version-6, including the 721 and buyback hooks,
  router terminal, revnets, suckers, and other official packages. Exclude experimental extensions
  such as Sticky, JBChat, JBProcessor, and Plugin.
- GET requests read the protocol or Bendystraw. Where both can supply the requested information,
  clients can select the source. Responses identify the source and its actual freshness guarantees.
- POST requests prepare transactions or journeys and relay transaction bytes signed by an external
  wallet. Center never receives or stores a wallet or bot private key.
- Wallet owners manage accounts, profiles, and revocable bot grants. Bot keys are generated locally
  in the browser or CLI. Every protected request is signed; there are no static API keys or bearer
  tokens in this access model.

## Boundaries

The HTTP adapter owns parsing, request authentication, authorization, response envelopes, and
OpenAPI descriptions. Shared application operations own protocol semantics and validated inputs.
Contract catalogs are generated from pinned official artifacts; indexer catalogs are generated
from the pinned Bendystraw schema. Network adapters accept configured upstreams only.

REST does not invoke MCP tools by name. The two transports share application services and retain
their own principal, audience, quotas, and response contracts. Existing public RPC/IPFS endpoints,
MCP access, and internal metrics authorization keep their documented behavior.

Account grants authorize access to Center. They do not grant Juicebox permissions, move funds,
or allow a bot to sign from its owner's wallet. The actual transaction signer is committed in each
plan and recovered independently from submitted transaction bytes.

## Request authentication

An owner-signed operation registers a public bot key, its exact scopes, expiry, and account.
Registration includes proof that the client possesses the bot key. Revocation is durable and
checked on every request. Bot credentials cannot create or elevate other bot grants.

Request signatures bind the configured service audience, account, signer, HTTP method, exact
request target including query, content type, exact transmitted body digest, issue/expiry times,
nonce, and idempotency identifier. Signing is distinct from transaction signing. Replay prevention
uses shared durable state and atomic authorization checks, including concurrent revocation.

Retries use a fresh request signature and nonce with the same idempotency identifier. A conflicting
body for an existing identifier is rejected. A lost response must not create another journey or
broadcast a different transaction.

## Reads and provenance

Onchain reads are tied to a canonical block hash. Supported addresses come from pinned official
deployment manifests or explicit proofs for project/factory instances; a caller-provided ABI or
URL is not a provenance check. The catalog distinguishes address provenance from an exact
compiler-to-runtime match and identifies missing runtime proof. ABI overloads use full signatures.
Exact integers cross JSON boundaries as decimal strings, including nested tuples and arrays.

Bendystraw is an indexed observation, not a canonical-block simulation source. V6, chain, project,
and entity identity are checked in filters and returned data. Global aggregates that cannot be
scoped to V6 are reported as unsupported. Historical accounting balances are not labeled as live
spendable balances. No silent source substitution is permitted.

## Transactions and journeys

Plans commit to sender, chain, destination, calldata, value, dependencies, and expiry. Preparation
and simulation precede signing. Signed submissions must match the reviewed call exactly; gas and
nonce fields receive explicit validation. The server never signs or substitutes transaction bytes.

A wallet transaction signature does not establish when the owner approved sending it. Dispatch
therefore also requires a fresh owner-signed HTTP request or a separate owner approval bound to
the submitting principal, plan, commitment, step, and exact signed transaction hash. The database
rechecks the approval window after acquiring the admission locks. The same rule applies to the
publication of usable signed forwarding requests. Observing an already admitted submission does
not require another wallet approval and cannot silently trigger another dispatch.

Journeys are durable ordered steps, not a promise of atomic execution. Each step has independent
submission, confirmation, and outcome evidence. A reverted or unresolved dependency prevents its
dependents from advancing. State changes require fresh simulation. Partial completion, reorgs,
ambiguous upstream failures, and receipt polling remain explicit and resumable.

Cross-chain receipt confirmation does not establish bridge delivery. Operations requiring a
future project ID, bridge proof, or new wallet signature remain pending until that evidence or
signature is supplied. No automatic rollback or invented placeholder transaction is permitted.

## Sponsorship and delegated accounts

The Relayr adapter prepares and publishes exact owner-signed ERC-2771 requests. Its provider
response is bound to permanent plan-step and forwarding-nonce reservations before payment
calldata is exposed. A separate wallet funds gas. Canonical outer and inner execution evidence
feeds back into the original plan; provider status alone cannot unlock a dependency. An uncertain
provider POST is not repeated. See [sponsorship](SPONSORSHIP.md) for execution deadlines and recovery.

Broader delegation uses a distinct smart-account boundary: owner wallet, verified account on each
chain, scoped bot session, and explicitly allocated spending limits. API access, wallet ownership,
installed onchain authority, and paymaster eligibility are separate checks. The binding registry
verifies the current Safe owner threshold and deployment state; a policy review commits to its
generation, expiry, exact actions, and budget allocations. Neither operation installs a session.

Weekly/monthly execution and prepaid spending are unavailable until a coherent deployment stack,
policy compiler, installed-policy verifier, and UserOperation transport are implemented and
configured. Runtime capability responses expose those requirements. Removing an API grant or
unlinking an account cannot revoke signatures or permissions already accepted by an onchain
module. Contract-enforced revocation is a separate owner action. See [sessions](SESSIONS.md).

## Documentation and verification

Ship a versioned OpenAPI document, searchable human documentation, machine-readable capability
and coverage catalogs, exact signing test vectors, and small TypeScript/CLI examples. Document
source semantics, pagination, limits, idempotency, error codes, timeouts, finality, and recovery.
Unknown reads and unavailable deployments remain explicit errors or unavailable capabilities.

Tests cover request tampering/replay/revocation, account isolation, concurrent idempotency,
schema/deployment coverage, V6-only indexer boundaries, exact transaction matching, interrupted
journeys, upstream ambiguity, and restart/reorg recovery. Changes affecting signing, authority,
or financial outcomes receive an independent review before release.

## Primary references

- [Derive session keys](https://docs.derive.xyz/reference/session-keys)
- [Derive authentication](https://docs.derive.xyz/reference/authentication)
- [Derive action signatures](https://docs.derive.xyz/reference/submit-order)
- [OpenAPI specification](https://spec.openapis.org/oas/)
- [HTTP message signature considerations](https://www.rfc-editor.org/rfc/rfc9421.html)
- [HTTP problem details](https://www.rfc-editor.org/rfc/rfc9457.html)

Derive supplies useful account/delegation concepts. Its documented timestamp authentication is
not copied: Center signatures must also bind request content and replay-prevention fields.
