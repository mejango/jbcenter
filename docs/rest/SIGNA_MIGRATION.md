# Signa ownership and migration preparation

Signa is the intended home for the complete account and wallet product, moving the
current `my.juicebox.center` experience to `signa.center`. Center remains the
Juicebox protocol planning, reference, read and API integration layer. This is a
preparation contract; it does not authorize or establish a DNS change, credential
migration, separate deployment or database split.

## Ownership

| Signa | Center |
| --- | --- |
| Account identity and profiles; native passkeys and external-wallet account management | Protocol catalogs, source provenance, indexed and canonical reads |
| Bot API grants, app admission and consent, delegated sessions, revocation | Protocol-specific plan construction, simulation and semantic validation |
| Owner approval, account execution, submission recovery and durable operation status | RPC, IPFS, reference documentation, SDK/API and MCP integration glue |
| Enrollment, login, devices, wallet deployment, additional networks and credential recovery | Reusable protocol and chain-evidence adapters consumed by account operations |

Product ownership does not imply moving every implementation immediately. Account
execution consumes Center's protocol planning and evidence services. API access,
owner approval, delegated spending authority and sponsorship eligibility remain
separate checks.

The bounded preparation scope is one shared, configured credential-host boundary
and a reusable Accounts page/assets mount. Current deployments, logical API
audience, database authority and worker ownership remain unchanged. No new service
framework or remote authorization protocol is required for these mounting seams.

The remaining extraction point is `src/rest/runtime.ts`: it currently constructs
protocol services, account authority, execution, credential services, assets and
workers together. A later Signa entry point should own the existing account,
grant/session, execution and wallet factories as one composition, supplied with
the concrete database, protocol planning, RPC and evidence dependencies it needs.
Center can retain a thin compatibility adapter for current routes while that
ownership moves. Extract the composition and its start/stop lifecycle together;
copying the full runtime into another deployment would duplicate service and
worker ownership. Physical database separation is a later design decision.

## Boundaries that survive the move

- **Keep transactional authority shared during preparation.** Account, credential,
  binding, grant/session epochs, replay admission, approval consumption and dispatch
  are checked under the existing database transactions and lock order. A remote
  authorization preflight followed by a later write cannot replace those atomic
  checks. Recovery and revocation must still prevent concurrent unauthorized work.
- **Separate credential and general account-management origins.** The passkey and
  host-only cookie origin must not serve the legacy/admin Accounts UI, arbitrary
  Center content, MCP or a general API. Signa may own both products while preserving
  distinct trust origins. A reusable Accounts mount is not permission to mount it
  on the credential host. Active, retired and disabled credential hosts need the
  same routing boundary at the HTTP listener and application layers.
- **Preserve the logical API audience.** Wallet issuer, browser origin, API audience
  and callback URI are separate values. Keep the current signed API audience during
  preparation, even when account pages are mounted elsewhere; supply it explicitly
  to the page and narrowly admit it in the page's CSP. The API's CORS policy must
  also allow that frontend's requests; it does not replace signed request
  authentication. Credential pages retain their own same-origin policy.
- **Preserve exact protocol contracts.** Account IDs, signed historical proofs,
  EIP-712 names and salt derivation, version strings, callback fields, SDK exports,
  connector IDs and message/storage identifiers are not cosmetic branding. A new
  issuer produces a new handoff salt; historical signed values stay unchanged. Keep
  exact reviewed transaction bytes, original submission/idempotency keys and
  canonical outcome evidence. API grant revocation does not itself revoke installed
  onchain authority.

See [architecture](ARCHITECTURE.md), [authentication](AUTHENTICATION.md),
[sessions](SESSIONS.md) and [execution operations](EXECUTION_OPERATIONS.md).

## Existing credentials and in-flight work

Passkeys are scoped to an RP ID; a redirect to another hostname does not change
that scope. Related Origin Requests can permit another origin to use the **same**
RP ID through its HTTPS `/.well-known/webauthn` declaration. This does not convert a
credential to a new RP ID, and expected origin/RP validation remains required.
[WebAuthn related origins](https://www.w3.org/TR/webauthn-3/#sctn-related-origins),
[origin validation](https://www.w3.org/TR/webauthn-3/#sctn-validating-origin).

Current server, browser and SDK validators require the configured credential
hostname/RP relationship. Recovery and add-device records also bind their RP and
origin to the original enrollment. Ordinary recovery is therefore not an existing
cross-domain migration mechanism. Preserve immutable enrollment and recovery
proofs; do not rewrite their origins or weaken those validators.

For retained accounts, keep the old credential origin and its verification path
available during coexistence, or first design and verify an explicit owner-approved
credential transition. Related-origin support would be a separate implementation
with browser/provider compatibility checks, not a configuration-only shortcut.
[Implementation requirements](https://web.dev/articles/webauthn-related-origin-requests).

SDK connection and payment journals are keyed by issuer and callback. A new issuer
selects new slots without resolving old ones; Homerun's own payment journal also
rejects a changed configuration. Keep the original trusted configuration available
for unfinished handoffs, lost exchanges, approved payments and uncertain submissions.
Never use an arbitrary callback `iss` to choose a trusted endpoint, relabel a stored
request, erase pending work or submit a replacement because the new slot is empty.
Keep exact callbacks and `/wallet` API compatibility paths while installed clients
depend on them. Signed HTTP clients reject redirects.

Keep one explicitly owned worker lifecycle for each existing job family. Mounting
another host must not construct a second full runtime and duplicate deployment,
recovery, device, network, settlement or reconciliation workers. Any later worker
handover must preserve leases, reservations, nonces, treasury liabilities and
original operation identities, including work with an unknown external outcome.

## Rollout and rollback checkpoints

1. **Before changing deployment:** inventory retained RP IDs/accounts, live grants,
   unfinished ceremonies/handoffs and pending operations through an authorized
   operator process. Record the issuer, credential origin/RP, Accounts origin,
   unchanged API audience, exact app callbacks and worker owner. Decide coexistence
   requirements from actual retained state.
2. **Before enabling Signa traffic:** pass configured-host isolation checks,
   including MCP and disabled/retired hosts; Accounts mounting with explicit
   audience; wrong-origin/RP/audience rejection; native signup/login/device/recovery;
   external-wallet reconnect; frame/popup/full-page callbacks, cancellation and URL
   scrubbing. Exercise old and new issuer journals, exact lost-response retries,
   concurrent revocation/dispatch, and canonical payment reconciliation. Run the
   [release checks](EXECUTION_OPERATIONS.md#required-release-checks). Modeled browser
   responses alone do not prove genuine credential or execution compatibility.
3. **At a later cutover:** change reviewed hosting/client pins together, retain the
   original completion paths and one worker owner, and verify health plus actual
   recovery progress. Keep Center RPC/IPFS/reference routes and protocol audience
   stable. Remove an old path only after retained state no longer requires it.
4. **If reverting traffic or code:** preserve the current durable state and both
   required verification paths. Newly created Signa credentials cannot become
   old-origin credentials by rollback. Do not restore an older database, reset
   nonces/epochs, undo committed revocations or replay uncertain dispatches to make
   old code appear healthy. Reconcile original submissions before resuming work;
   follow [production recovery procedures](PRODUCTION_OPERATIONS.md).
