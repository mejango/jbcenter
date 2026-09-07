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

Start with the [quickstart](./QUICKSTART.md) or [journey map](./USER_JOURNEYS.md).
Public discovery needs no setup. A bot grant removes wallet prompts from
protected reads and planning. Fresh owner-approved execution is the default;
recurring bot permissions are optional and currently unavailable in production.

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
| `POST /smart-accounts/creation-plans` | Owner requests deterministic factory calldata and evidence; wallet deployment remains separate. |
| `POST /smart-accounts/bindings/{id}/plans` | Create a durable plan for the verified bound Safe with `plan` scope and an idempotency key. |
| `POST /smart-accounts/sessions` | Compile and persist a seven- or thirty-day policy with `plan` scope, an exact grant, gas budget and idempotency key. |
| `GET /smart-accounts/sessions` | List owner-visible or exact bound-bot sessions using `limit` and optional UUID `cursor`. |
| `GET /smart-accounts/sessions/{id}` | Refresh installed-policy evidence by default; `refresh=false` returns stored history. |
| `GET /smart-accounts/sessions/{id}/quota` | Read approved allocations and observed onchain counters. |
| `POST /smart-accounts/sessions/{id}/activation-plans`, `/revocation-plans` | Owner acknowledges `{compiledHash}` and creates an exact lifecycle plan; requires an idempotency key. |
| `POST /user-operations` | Prepare EntryPoint v0.7 bytes from `{planId,stepIndexes,sessionId?}` with `plan` scope and an idempotency key. |
| `POST /user-operations/{id}/submissions` | Submit `{signature}` for the exact prepared operation with `relay` scope and an idempotency key. |
| `GET /user-operations/{id}` | Read and reconcile a submitted operation using canonical execution evidence. |

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

For sponsored gas, use the smart-account owner workflow below. It does not
require a session guard or recurring bot permissions. Runtime capabilities
determine the available chains and transports.

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

## Smart accounts and sponsored owner execution

Discover `/smart-accounts/capabilities` and the top-level `userOperations` and
`sessions` capabilities before selecting a chain. Implemented routes and
historical deployment research do not establish activation readiness. Hosted
owner execution requires a reviewed manifest, complete account-history/module
verification, configured bundler/paymaster, provider billing and eligible sponsorship policy.
Recurring sessions additionally require the reviewed deployed guard matching the
selected paymaster profile; both legacy and current guard artifacts are undeployed. Owner
execution can be configured without that guard. See
[execution operations](/api/docs/execution-operations) for the live setup.

The owner can request `/smart-accounts/creation-plans` with
`{manifestId,owners,threshold,saltNonce}`. Its `{creation}` result contains the
predicted address, exact initializer and factory calldata; it is stateless and
has `deploymentConfirmed:false`. The wallet separately signs and funds deployment.
For an existing confirmed Safe, obtain a binding challenge and its current
EOA-owner threshold signatures over `BindSmartAccount`. Submit packed signatures
in ascending owner-address order. Binding a wallet creates no spending authority.

Create action plans through `/smart-accounts/bindings/{id}/plans` using the
ordinary `{operation,input}` shape with the Safe as the draft account. Then
prepare `/user-operations` from the returned plan. Without `sessionId`, the
response contains `eip712-safe7579-owner` signing data for the current Safe-owner
threshold. Sign the returned `SafeOp` exactly and encode the bounded owner
signature envelope using the client helper. Submit only `{signature}`; the API
request signature remains a separate proof. Up to sixteen selected ordered calls
can share one owner operation on one chain. No additional
`CenterTransactionApproval` is required for this validity-bound owner operation.

Use one operation per modeled journey step when the application needs a verified
economic outcome before continuing. For a multi-call operation the service can
verify atomic invocation, but currently reports modeled per-call economic
results as `unknown`; it cannot safely assign shared receipt events to every
step. Calls without modeled economic predicates can still use batching. Required
prerequisites outside the batch must already have confirmed and verified results.

Submit once, then poll the operation and source plan. `202` means accepted for
processing, and `submission_unknown` means reconcile the existing operation
without another provider publication. Canonical execution evidence and modeled
economic outcomes remain distinct. Cross-chain settlement is a separate result.

## Optional recurring bot permissions

Skip this section for fresh owner-approved transactions. Recurring authority
requires a verified deployed guard and explicit owner activation; it is not
enabled in the current production configuration. Seven and thirty days are the
implemented duration choices, not requirements for API access or sponsorship.

For recurring bot execution, first review `/smart-accounts/session-reviews` or
persist `/smart-accounts/sessions`. The latter requires an explicit seven- or
thirty-day policy, immutable generation/nonce, the exact bot grant, approved
allocation groups and a mandatory gas-only sponsorship budget. Typed actions
are ERC20 transfers, V6 payments, and V6 project URI updates. URI-only policies
may have no asset groups, but still need call and gas limits. Asset groups use
reviewed identities and equal decimal units; the smart account must itself hold
any project permission. Preparation returns `prepared`, without live authority.
Allocation records do not transfer or escrow assets, prove a token balance, or
create allowances. Explicitly fund the smart account and approve any finite
allowance through separate owner-authorized transactions. A dedicated account
can isolate the allocated funds. Deposits do not increase the installed lifetime
cap; seven/thirty-day policies have no automatic reset or replenishment.
It also records the verified administration epoch and hash. Enabled observations
must prove exactly one subsequent initialization containing only the compiled
permission. Complete canonical history detects removal and reinstallation even
if no intermediate reset was observed.

The API owner acknowledges the returned `compiledHash` at the activation-plan
route. Review the resulting durable plan, prepare its owner UserOperation,
collect the Safe-owner threshold signatures, submit, and refresh the session.
Only `active` with fresh canonical installed-policy and counter evidence permits
its exact bound bot to prepare an operation with `sessionId`. Session operations
contain one approved action and return `eip191-legacy-ownable-user-operation`
signing data. The client key signs the exact raw operation hash and encodes the
returned permission prefix. Center never receives private keys or signs for a
wallet. An API bot grant alone remains insufficient.
Broader financial or administrative actions retain fresh owner authorization
through direct transactions or SafeOp signing. They cannot inherit authority
from a session merely because the same account holds sufficient funds.

Only the currently admitted activation or revocation plan may execute. If that
plan expires before any transport reservation or execution attempt, the owner
can request a replacement with fresh consent and a new idempotency key. The
record preserves up to 32 superseded approvals; their plans cannot execute.
A replacement cannot reinitialize a generation already observed active.

One admitted session generation reserves the physical wallet across API-account
aliases, keys, grants, assets and time windows. Expiry and API unlink/revocation
stop applicable admission but do not release that reservation. The owner creates
and submits a revocation plan; release requires finalized disabled onchain state
with an advanced enable nonce. Counter resets, reorgs and configuration changes
make the old generation stale. Quota responses describe approved allocations
and observed onchain counters, never database balances or atomic cross-chain
funds. Validation can consume policy counters even when execution fails.
Safe owner rotation, API unlinking and grant revocation do not remove the
legacy onchain permission. New owners should explicitly remove old sessions
and revoke their enable signatures; the API path checks current ownership.

UserOperation submissions return `202`; poll the operation and source plan for
canonical confirmation and scoped inner-call evidence. `submission_unknown`
keeps nonce and transport reservations and never authorizes another provider
publication. Bridge settlement remains a separate observation. See
[smart accounts](/api/docs/smart-accounts) and [sessions](/api/docs/sessions).

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
