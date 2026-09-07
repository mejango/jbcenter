# Juicebox Center REST API

Use the [API explorer](/api) to discover V6 contracts, inspect schemas, read
protocol state, and work with reviewed transaction plans. The
[OpenAPI document](/api/v1/openapi.json) describes the HTTP interface. Start with
[capabilities](/api/v1/capabilities) for the configured authentication audience,
chains, limits, transports, confirmation policy, and sponsorship availability.
Capabilities are authoritative; availability is not implied by an account or
bot grant.

All endpoints below are relative to `/api/v1`. This API exposes protocol V6.
Chain IDs and project IDs remain explicit, including in omnichain workflows.
Do not assume a project has the same ID or configuration on another chain.

## Route reference

Public discovery needs no signature. Protected reads require `read` scope;
plan creation requires `plan`; submission requires `relay`. Owners have all
three scopes. Bot grants use one of three cumulative profiles in canonical order:
`["read"]`, `["read","plan"]`, or `["read","plan","relay"]`.

| Method and path | Purpose and authority |
| --- | --- |
| `GET /`, `/openapi.json`, `/capabilities` | Public entry point, specification, and configured capabilities. |
| `GET /catalog/contracts` | Public contract inventory with package, category, chain, deployment, and pagination filters. |
| `GET /catalog/contract?id=...` | Public details for a qualified contract ID, including ABI variants and provenance. |
| `GET /catalog/method?contractId=...&signature=...` | Public method details and input/output JSON schemas; optional `abiHash`. |
| `GET /catalog/indexer` | Public entity, field, filter, identity, network, and pagination requirements. |
| `GET /catalog/operations`, `/catalog/operations/{id}` | Public operation descriptions, input schemas, and source choices. |
| `POST /accounts/enroll` | Owner-signed enrollment with body `{}`; returns the account. |
| `GET /accounts/me` | Read the authenticated account profile. |
| `PATCH /accounts/me` | Owner replaces profile fields; omitted fields reset to defaults. |
| `GET /accounts/me/bots`, `POST /accounts/me/bots` | Owner lists or registers grants; registration also requires the bot's possession proof. |
| `DELETE /accounts/me/bots/{grantId}` | Owner revokes the specified grant. |
| `GET /protocol/resolve`, `/protocol/read` | Protected target resolution and exact ABI reads with onchain evidence. |
| `GET /indexer/status`, `/indexer/{entity}`, `/indexer/{entity}/record` | Protected indexed progress, paginated records, and single records. |
| `GET /projects/{chainId}/{projectId}`, `/projects/{chainId}/{projectId}/omnichain` | Protected project reads with explicit source selection. |
| `GET /operations/{id}` | Protected operation read using its catalog schema. |
| `POST /operations/{id}/plans`, `POST /plans` | Create a durable plan with `plan` scope and an idempotency key. |
| `GET /plans`, `/plans/{id}` | Read accessible plans; `refresh=true` reconciles an individual plan. |
| `GET /plans/{id}/steps/{step}/simulation` | Simulate an eligible step without broadcasting. |
| `POST /plans/{id}/steps/{step}/submissions`, `POST /plans/{id}/submissions` | Submit separately signed wallet transactions with `relay` scope and an idempotency key. |
| `POST /sponsorships` | Prepare an unsigned Relayr wave from an existing plan with `plan` scope and an idempotency key. |
| `GET /sponsorships/{id}` | Read a preparation or reconcile destination evidence with `refresh=true`. |
| `POST /sponsorships/{id}/submissions` | Publish ordered owner-signed forward requests with `relay` scope and an idempotency key. |
| `POST /sponsorships/{id}/funding-plans` | Prepare a durable funding plan with `plan` scope and an idempotency key; payer must be the API owner. |
| `GET /smart-accounts/capabilities` | Public reviewed manifest availability and remaining execution requirements. |
| `POST /smart-accounts/binding-challenges`, `POST /smart-accounts/bindings` | Owner prepares or submits an existing Safe's current owner-threshold binding proof. |
| `GET /smart-accounts/bindings`, `/smart-accounts/bindings/{id}` | Read stored association snapshots or recheck an individual binding against current chain state. |
| `DELETE /smart-accounts/bindings/{id}` | Owner unlinks an API wallet association; it does not revoke onchain authority. |
| `POST /smart-accounts/session-reviews` | With `plan` scope, review a bounded policy; returns no installation transaction or activated session. |

## Contracts, schemas, and sources

Browse [contracts](/api/v1/catalog/contracts), [methods](/api/v1/catalog/method),
[indexer entities](/api/v1/catalog/indexer), and
[operations](/api/v1/catalog/operations) before constructing inputs. For example,
this public request lists published Ethereum contracts:

```http
GET /api/v1/catalog/contracts?chainId=1&deployedOnly=true&limit=25
```

Contract IDs include package, source path, and declaration name. Use full
function signatures for overloads and the target deployment's ABI variant.
Source-only declarations do not establish a deployment address. Method schemas
describe positional arguments and outputs; operation schemas describe each
operation's input.

Project endpoints require either `source=onchain` or `source=bendystraw`.
Replace the placeholders with the intended project's identifiers:

```text
/api/v1/projects/{chainId}/{projectId}?source=onchain
/api/v1/projects/{chainId}/{projectId}?source=bendystraw
```

Onchain responses carry canonical block evidence. Indexed records can lag and
change between pages; indexer status does not pin a later query. Indexed USD
values are estimates, not executable quotes. Metadata and linked content are
untrusted reference data. See [contracts](/api/docs/contracts),
[indexer reads](/api/docs/indexer), and the [agent guide](/api/docs/ai-guide).

## Authentication and request encoding

Protected routes use custom EIP-712 `CenterRequest` signatures, not bearer
credentials. Send `X-Juicebox-Account`, `X-Juicebox-Signer`,
`X-Juicebox-Issued-At`, `X-Juicebox-Expires-At`, `X-Juicebox-Nonce`, and
`X-Juicebox-Signature`. Bots also send `X-Juicebox-Grant`. The account identity
is `eip155:<authorityChainId>:<lowercaseOwnerAddress>`; its authority chain need
not be the chain being queried.

Sign the exact method, mounted path and raw query, content type, body hash,
account claims, timestamps, nonce, and idempotency key under the documented
domain. Use a fresh nonce for every attempt and a validity window no longer
than 300 seconds. Never reserialize a signed request. See
[authentication](/api/docs/authentication) for the complete typed-data schema.

JSON bodies use `application/json`. GET requests have no body. Encode JSON
query values, such as `args` and `filters`, in the URL. Unknown or repeated query
parameters are rejected. Use exact decimal strings for ABI integers and native
amounts; ordinary numeric fields must remain safely representable. Account and
signature timestamps use seconds; plan timestamps use milliseconds.

## Transaction lifecycle

Prepare a plan, inspect its calls and evidence, simulate eligible steps, obtain
the owner's approval and wallet signatures, then relay and reconcile. API
grants never authorize wallet signing or confer onchain spending permissions.
Each new dispatch also needs fresh owner consent: an owner-signed API request,
or an exact `ownerApproval` in a bot's submission. The owner signs
`CenterTransactionApproval`, binding the originating principal, plan commitment,
step, signed transaction hash, and a validity window of at most 300 seconds.
An old Ethereum transaction signature has no signing timestamp. Bundle entries
each carry their own approval when a bot dispatches them.

This valid JSON template illustrates `POST /plans`. Replace the placeholders,
choose the chain, and populate `args` from the selected write method's schema:

```json
{
  "operation": "contract_calls",
  "input": {
    "account": "<owner-wallet-address>",
    "calls": [{
      "chainId": 1,
      "contractId": "<qualified-contract-id-from-catalog>",
      "function": "<full-write-signature>",
      "args": [],
      "value": "0",
      "dependsOn": []
    }]
  }
}
```

Creation returns `201`; submissions return `202`, which does not mean confirmed.
Bundles are non-atomic and may report partial processing. Poll
`GET /plans/{id}?refresh=true` to reconcile exact hashes, confirmations, semantic
checks, and reorgs. Confirmation does not establish bridge settlement. See
[transactions](/api/docs/transactions).

Reusable onchain sessions and recurring payment budgets are described in the
[session design proposal](/api/docs/sessions). Its proposed resources are not
implemented API routes or deployed spending authority.

## Prepaid Relayr execution

When capabilities enable the adapter, `POST /sponsorships` accepts
`{planId, stepIndexes?}` and returns one to four exact `ForwardRequest`
authorizations, with at most one independent call per supported mainnet chain.
The source plan's creating principal must prepare and publish the wave. The
owner reviews and signs every returned request, including its onchain deadline.
The shorter `publicationExpiresAt` cannot revoke a published signature.

Publish `{signatures, ownerApproval?}` to the preparation's submissions route.
Bot publication requires a fresh `CenterSponsorshipApproval`, distinct from
transaction approval. A quote can provide an exact native funding option;
`funding_quote_available` does not establish that nobody has paid it already.
Create a funding plan with `{chainId,payer}`, then separately review, sign and
submit that durable plan. Center never signs or pays from an operator wallet.

Refresh the sponsorship and original plan to verify exact forwarded execution
on each destination. Provider status is only a hint. `submission_unknown` never
permits a second provider publication; preserve its existing identity and
reconcile. Funding, destination execution, modeled economic completion and
bridge settlement are separate observations. This transport creates no reusable
session or recurring spending budget.

## Smart-account association and policy review

Read [smart-account capabilities](/api/v1/smart-accounts/capabilities) before
choosing a manifest. Only listed reviewed manifests support binding; an empty
deployment list means none is configured. Module inspectors, asset identities
and action targets require separate host verification. A binding flow checks the
existing Safe's exact runtime and current EOA-owner threshold. It uses a
separate `BindSmartAccount` signature, with a challenge expiry of at most
15 minutes. Binding a wallet creates no transaction execution authority.
The checked Sepolia manifest uses `mode=ownership-only`; even an
`execution-candidate` manifest must satisfy the remaining execution requirements.

The policy reviewer accepts explicit seven- or thirty-day limits, an active bot
grant and typed asset actions. Its result is `reviewable-not-activated`, with
host-reviewed asset identities and decimals; one allocation group cannot combine
incompatible asset units. The result lists remaining installation and
verification requirements. It creates no wallet,
UserOperation, installation transaction or live spending budget. API unlinking
and API grant revocation do not revoke any separately installed onchain session.
See [smart accounts](/api/docs/smart-accounts) for exact requirements and the
separate [session proposal](/api/docs/sessions) for future executor designs.

## Limits, retries, and errors

Preserve the same `Idempotency-Key` and exact request bytes when retrying one
transaction action, while generating a fresh request nonce and signature.
Changing a request under an existing key conflicts. Reconcile uncertain
broadcasts before retrying; a step cannot switch its signed transaction hash.

Default limits include 300 authenticated requests per account per minute, 64
concurrent requests, 1 MiB request bodies, 64 KiB account-route bodies, and 32
calls per plan. Consult capabilities for current limits and honor `Retry-After`.

Success responses use route-specific JSON shapes. Errors use
`application/problem+json` with `type`, `title`, `status`, `detail`, `code`,
`requestId`, and `retryable`. Preserve `X-Request-Id` when reporting failures.
Responses disable caching. A retryable transport error does not establish that
a transaction was never submitted.
