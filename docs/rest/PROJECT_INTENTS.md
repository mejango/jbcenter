# Project intents

A project intent is a signed, frozen Juicebox V6 project launch: one contract call
per chain plus the publishing client's own form document, stored by Center. Publishing
costs one wallet signature and no transaction. The project exists from the moment it is
published: it has an id, a page, and a row in search. It becomes an on-chain project when
someone deploys it, either at Center's expense on the sponsored rollups or by paying for
the transaction themselves.

This guide is the canonical description of the flow. It covers who may call, the exact
envelope, publishing, reading, sponsored deploys, self-paid deploys, and the mistakes that
cost people a working omnichain project.

Say "project" in user-facing copy, with a "Deploys on first use" label. The word "intent"
belongs in API documentation, not in product copy: it suggests something still negotiable,
and a published intent cannot be edited, replaced or withdrawn.

## What an intent is

| Property | Value |
|---|---|
| Content | `format`, `deploymentVersion`, `chainIds`, one `deploymentCall` per chain, and a `jb` document |
| Identity | A UUID assigned by Center, plus a `contentHash` over the canonical envelope |
| Authenticity | A publisher signature over a message that quotes the content hash |
| Mutability | None. There is no edit, replace or withdraw route. Publish a new intent instead |
| Status | `undeployed` until a deployment is recorded for any chain, then `deployed` |

The per-chain `to` address and the complete calldata are part of the signed content, so the
launch is directly executable and independently verifiable by anyone: nobody has to re-derive
time-sensitive arguments later. Center never edits the calldata and never invents a call.

A signature on an intent authorizes Center to store and publish frozen calldata. It is not
transaction approval and it moves no funds. Deployment is a separate, funded transaction.

## Who may call

The intent routes (`/v1/intents*` and `/v1/search`) are gated by browser `Origin`. A request
whose `Origin` header is not on Center's first-party list is refused with `403` and
`{"error":{"code":"forbidden_origin"}}`. There is no bearer token for these routes and no
public fallback. This is tighter than `/v1/rpc`, which admits any origin, including none, as a
public caller under its own budget.

Two ways in for a new integrator:

1. **Ask for an origin.** Center's first-party list lives in `src/firstParty.ts` in the
   `mejango/jbcenter` repository: one production entry per app, and several localhost and dev
   entries per app in the development list. Open a pull request adding your origin, or ask the
   maintainers. Production entries today are `https://juicebox.money`, `https://revnet.money`,
   `https://eth.shop`, `https://succulent.money`, `https://homerun.money` and `https://beep.biz`.
2. **Use the MCP tools.** Connect any Streamable HTTP MCP client to
   `https://juicebox.center/mcp`. `jb_prepare_intent`, `jb_publish_intent`, `jb_get_intent`
   and `jb_deploy_intent` run server-side inside Center, so they need no origin, no REST
   account and no bot grant. The MCP never holds a key and never signs: you bring the
   signature.

Server-to-server callers that are not the MCP still need an allow-listed origin, and must
send it as a real `Origin` header.

## The envelope

```json
{
  "format": "juicebox.money/v1",
  "deploymentVersion": "6",
  "chainIds": [8453, 42161],
  "deploymentCalls": [
    { "chainId": 8453, "to": "0x...", "data": "0x..." },
    { "chainId": 42161, "to": "0x...", "data": "0x..." }
  ],
  "jb": { "v": 1, "name": "Public goods garden", "owner": "0x...", "chainIds": [8453, 42161] }
}
```

| Field | Type | Rules |
|---|---|---|
| `format` | string | `<host>/<label>`: exactly one slash. Host part matches `[a-z0-9.-]{1,80}`, label matches `[a-zA-Z0-9._-]{1,32}` — the label may not contain a slash. Identifies the publishing client |
| `deploymentVersion` | string | `"6"`. 1 to 64 characters |
| `chainIds` | number[] | 1 to 16 unique positive integers. Center sorts them ascending before hashing |
| `deploymentCalls` | array | Exactly one `{chainId, to, data}` per member of `chainIds`, between 4 bytes and 4 MiB each. `to` is checksummed; `data` is stored lowercased and matched case-insensitively when a self-paid deployment is verified. Center sorts by `chainId` before hashing |
| `jb` | object | The publishing client's own document. Any JSON object, nesting at most 64 levels |

Existing publishers use `juicebox.money/v1` and `revnet.money/v1`. An app that publishes more
than one kind of deployment distinguishes them in the label, for example `homerun.money/fund.v1`
or `beep.biz/terminal.v1`. A second slash is rejected with `400` and
`format must look like juicebox.money/v1`.

### Launch entry points

Each `deploymentCall.to` is one of a small set of canonical V6 launch entry points. Look up
their per-chain addresses at `GET /api/v1/catalog/contracts` or in [`./CONTRACTS.md`](./CONTRACTS.md);
Center does not invent a call or a target.

- `JBController.launchProjectFor`
- `JB721TiersHookProjectDeployer.launchProjectFor`
- `JBOmnichainDeployer.launchProjectFor`
- `REVDeployer.deployFor`, with `revnetId` `0` for a first-time launch
- `HomerunDeployer.launchFundFor`

### `jb` conventions

Center treats `jb` as opaque, but indexes a few conventional fields so that search and lists
work without the client re-reading every envelope. Fields are read from the root of `jb`, or
from `jb.data` when `jb.app` is `"revnet.money"`.

| `jb` field | Indexed as | Notes |
|---|---|---|
| `name` | `name` | Trimmed to 100 characters. Missing means the stored name is `Untitled project` |
| `description` | `description` | Trimmed to 10000 characters |
| `tagline` or `projectTagline` | `tagline` | Trimmed to 200 characters |
| `tags` | `tags` | At most 10 strings of at most 30 characters |
| `logoUri`, `logo` or `links.logoUri` | `logoUri` | Use an `ipfs://` URI: the first-party webclients do not render HTTPS logos |
| `owner` | `owner` | Indexed, stored checksummed, when it is an address string; otherwise not indexed. This is what `GET /v1/search?owner=` matches |
| `chainIds` or `chains` | not indexed | When present it must equal the envelope's `chainIds`, or the publish is refused |

Also set `app` (your client's short name) and, when your client has more than one product,
`kind`. Everything else is yours.

### Content hash and signing message

The content hash is `keccak256` over the canonical JSON of the normalized envelope: object keys
sorted lexicographically at every level, no whitespace, chain ids and calls already sorted.

The message to sign is exactly:

```
Juice Central project intent
Version: 1
Content hash: 0x<64 hex characters>
```

Never build that string yourself. Ask `POST /v1/intents/message` for it, so a change in Center's
normalization can never leave you signing something Center will not store.

## One sender per intent

Sucker, ERC-20 and 721-hook salts hash `_msgSender()` on every chain. Every chain of one intent
must be deployed by the same sender, or the deployments do not link into one omnichain project:
they land as unrelated same-named projects on separate chains, and nothing can repair that.

There are exactly two valid senders for a whole intent, never mixed:

- Center's sponsor key deploys every chain (the sponsored path).
- One wallet deploys every chain (the self-paid path).

Center enforces the boundary from its side: `POST /v1/intents/:id/deploy` is refused for an
intent that already has a recorded deployment, so sponsorship can never be layered on top of a
partial self-paid deployment. The mirror rule is yours to keep: once a sponsored deploy is
requested, do not deploy the remaining chains yourself.

On the sponsored path Center's sponsor key signs an ERC-2771 forward request per chain against
the canonical `ERC2771Forwarder` from the V6 manifest, after checking that the call's target
trusts that forwarder. The deployment calls themselves carry no value: the project creation fee
is read live from `JBProjects.creationFee()` at deploy time and attached to the forwarded
request, funded by the Relayr prepayment. A fee above Center's ceiling of `100000000000000` wei
(0.0001 ETH) fails the lane instead of spending more than the reservation.

## Publish end to end

### Step 1: ask for the message

```sh
curl -X POST https://juicebox.center/v1/intents/message \
  -H 'origin: https://juicebox.money' \
  -H 'content-type: application/json' \
  --data '{
    "format":"juicebox.money/v1",
    "deploymentVersion":"6",
    "chainIds":[8453],
    "deploymentCalls":[{
      "chainId":8453,
      "to":"0x3333333333333333333333333333333333333333",
      "data":"0x12345678"
    }],
    "jb":{"v":1,"name":"Public goods garden","owner":"0x1111111111111111111111111111111111111111","chains":[8453]}
  }'
```

```json
{
  "contentHash": "0x9a...",
  "message": "Juice Central project intent\nVersion: 1\nContent hash: 0x9a...",
  "envelope": { "format": "juicebox.money/v1", "deploymentVersion": "6", "chainIds": [8453], "deploymentCalls": [{ "chainId": 8453, "to": "0x3333333333333333333333333333333333333333", "data": "0x12345678" }], "jb": { "v": 1, "name": "Public goods garden", "owner": "0x1111111111111111111111111111111111111111", "chains": [8453] } }
}
```

### Step 2: apply the guard, then sign

Before you sign, check two things. Every publisher applies this guard; it is the only thing
standing between a compromised or confused response and a signature over calldata the user
never saw.

1. The returned `envelope` equals the envelope you built. Compare canonically: sort object keys,
   lowercase every hex string, and compare the serialized result. Do not compare with `===` on
   objects and do not trust field order.
2. The returned `message` equals, character for character, the message for the envelope you built:

   ```
   Juice Central project intent
   Version: 1
   Content hash: <hash>
   ```

   where `<hash>` is the keccak256 of the canonical JSON of that envelope. Never build this string
   yourself to sign; build it only to compare, and sign the `message` Center returned once the two
   match.

If either check fails, refuse to sign and surface the mismatch. Do not retry silently.

Sign with `personal_sign` from an externally owned account. Center recovers the signer from the
signature and compares it to `publisher`: contract signatures are not verified today, so an
ERC-1271 smart account and an ERC-6492 wrapped signature from an undeployed account are both
refused with `400`. A client whose connector cannot sign messages, such as a passkey wallet,
needs an external wallet for this step.

### Step 3: publish

```sh
curl -X POST https://juicebox.center/v1/intents \
  -H 'origin: https://juicebox.money' \
  -H 'content-type: application/json' \
  --data '{
    "format":"juicebox.money/v1",
    "deploymentVersion":"6",
    "chainIds":[8453],
    "deploymentCalls":[{"chainId":8453,"to":"0x3333333333333333333333333333333333333333","data":"0x12345678"}],
    "jb":{"v":1,"name":"Public goods garden","owner":"0x1111111111111111111111111111111111111111","chains":[8453]},
    "publisher":"0x1111111111111111111111111111111111111111",
    "signature":"0x..."
  }'
```

`201` with the stored intent the first time. `200` with the same intent when the same publisher
re-sends the same content: publishing is idempotent per `(publisher, contentHash)`.

### The same flow with the SDK

`JBCenterClientOptions` has no `origin` option: a bare `createJBCenterClient()` only works from
an allow-listed browser origin, where the browser sets `Origin` itself. A server-side caller
supplies its own `fetch` that sets the header:

```ts
import {
  createJBCenterClient,
  createJBCenterDeploymentCall,
  publishSignedIntent,
} from "@bananapus/nana-sdk-core/jbcenter";

const client = createJBCenterClient({
  fetch: (input, init) =>
    fetch(input, {
      ...init,
      headers: { ...init?.headers, origin: "https://your-app.example" },
    }),
});

const deploymentCalls = chainIds.map((chainId) =>
  createJBCenterDeploymentCall({
    chainId,
    address, // the launch entry point on this chain; see "Launch entry points" above
    abi,
    functionName,
    args,
  }),
);
const envelope = {
  format: "juicebox.money/v1",
  deploymentVersion: "6",
  chainIds,
  deploymentCalls,
  jb: formValues,
};

const intent = await publishSignedIntent(
  client,
  envelope,
  (message) => walletClient.signMessage({ account, message }),
  { publisher: account.address },
);
```

`publishSignedIntent` is the guard from step 2 as one call: it prepares the intent, checks that
Center's prepared `envelope` matches the one built here and that the prepared `message` equals,
character for character, the whole signing message it builds for that envelope's own content
hash, and only then calls `sign` and publishes. Either check failing throws
`JBCenterIntentMismatchError` instead of reaching a wallet.

`publishSignedIntent`, `describeCenterRefusal`, the `homerun-fund` decode flavor and the `owner`
and `publisher` search filters need `@bananapus/nana-sdk-core` 2.8.0 or newer.

### Publish limits and refusals

| Status | Code | Meaning |
|---|---|---|
| `400` | `bad_request` | The envelope failed normalization, or the signature does not match `publisher` and the content |
| `403` | `forbidden_origin` | The `Origin` header is absent or not first-party |
| `413` | `body_too_large` | The request body exceeded 16800000 bytes |
| `429` | `publish_limit` | `PUBLISH_PER_PUBLISHER_PER_DAY` publishes per publisher per day (default 20), or `PUBLISH_PER_IP_PER_HOUR` per IP per hour (default 60). `Retry-After` is `86400` or `3600` |
| `429` | `storage_limit` | The calling client exceeded its stored intent count or byte budget |

As of 2026-09-21, production runs `PUBLISH_PER_PUBLISHER_PER_DAY` at 500 and
`PUBLISH_PER_IP_PER_HOUR` at 500.

An MCP caller spends the hourly limit twice: once under its own publisher key, and once in a
bucket every MCP publisher shares. A publisher key is free to mint, so the shared bucket is what
bounds the assistant as a whole. Its stored intents and bytes count against the assistant's own
lifetime caps — `MCP_MAX_INTENTS`, default 100000, and `MCP_MAX_STORAGE_BYTES`, default 10 GiB —
rather than against a browser client's, and its sponsored deploys draw on the assistant's own
daily slice of the sponsorship budget, below.

## Read and list

### One intent

```http
GET /v1/intents/:id
```

`200` with the intent, `400` for an id that is not a UUID, `404` with `not_found` otherwise.

```json
{
  "id": "a7396c7e-b13f-4ca8-9f06-96f36ab22c3a",
  "status": "undeployed",
  "contentHash": "0x9a...",
  "envelope": { "format": "juicebox.money/v1", "deploymentVersion": "6", "chainIds": [8453], "deploymentCalls": [{ "chainId": 8453, "to": "0x...", "data": "0x..." }], "jb": {} },
  "publisher": "0x1111111111111111111111111111111111111111",
  "signature": "0x...",
  "name": "Public goods garden",
  "description": null,
  "tagline": null,
  "tags": [],
  "logoUri": null,
  "owner": "0x1111111111111111111111111111111111111111",
  "createdAt": "2026-09-21T00:00:00.000Z",
  "deployments": [],
  "deploys": []
}
```

`deployments` holds recorded on-chain results: `{chainId, projectId, transactionHash, createdAt}`,
write-once per chain. `deploys` holds sponsored-deploy rows and is always present, empty until a
sponsored deploy is requested: `{chainId, status, transactionHash, bundleUuid, error, createdAt,
updatedAt}` with `status` one of `queued`, `sent`, `confirmed`, `failed`. `error` is always a
coded, authored message capped at 300 characters with secrets scrubbed before it is stored, and
it is set on a waiting row as well as a failed one.

### Search

```http
GET /v1/search?q=climate&owner=0x1111...&publisher=0x2222...&limit=20&cursor=20
```

| Parameter | Rules |
|---|---|
| `q` | At most 200 characters. Empty or absent lists recent intents newest first |
| `owner` | An address. Matches the indexed `jb.owner`, case-insensitively |
| `publisher` | An address. Matches the signing publisher, case-insensitively |
| `limit` | 1 to 100, default 20 |
| `cursor` | The `nextCursor` from the previous page: a non-negative integer offset |

All four filters combine. An `owner` or `publisher` that is not an address is refused with `400`.

```json
{
  "items": [
    {
      "source": "jbcenter",
      "status": "undeployed",
      "intentId": "a7396c7e-b13f-4ca8-9f06-96f36ab22c3a",
      "contentHash": "0x9a...",
      "format": "juicebox.money/v1",
      "deploymentVersion": "6",
      "chainIds": [8453],
      "publisher": "0x2222222222222222222222222222222222222222",
      "name": "Public goods garden",
      "description": null,
      "tagline": null,
      "tags": [],
      "logoUri": null,
      "owner": "0x1111111111111111111111111111111111111111",
      "createdAt": "2026-09-21T00:00:00.000Z"
    }
  ],
  "totalCount": 1,
  "nextCursor": null
}
```

Search returns undeployed intents only. Recording the first deployment removes an intent from
search while keeping its `jb`, signature, exact launch calls and deployment provenance at
`GET /v1/intents/:id`. That is the contract clients rely on: query Center and Bendystraw
concurrently and concatenate, and nothing is listed twice.

`owner` is what an account page needs: `searchIntents({ owner })` beside
`getProjectsOwnedBy(owner)` from Bendystraw is the account's complete project list.
`publisher` is what an integrator's own operations dashboard needs: every intent a server key
signed, whoever owns the resulting projects.

### Rendering a list and a page

The SDK's `mergeSearch(bendystrawRows, intentItems)` merges both sources newest first, building
each intent row with `intentRow(item)` and flagging it `undeployed: true`. `intentPath(id)` is
`/intent/<id>`. Render that page from `decodeDeploymentCall(call)` on any one of the intent's
deployment calls — the launch is the same logical configuration on every chain — plus the pinned
metadata. No chain reads are needed or possible: there is nothing on chain yet.

`decodeDeploymentCall` returns a typed shell per launch flavor:

| Flavor | Typed fields |
|---|---|
| `project` | `owner`, `projectUri`, `rulesetConfigurations`, `terminalConfigurations`, `memo` |
| `project-721` | `owner`, `projectUri`, `rulesetConfigurations`, `terminalConfigurations`, `memo`, `salt` |
| `omnichain` | `owner`, `projectUri`, `rulesetConfigurations`, `terminalConfigurations`, `memo`, `has721` |
| `revnet` | `operator`, `projectUri`, `stages`, `description`, `accountingContexts` |
| `homerun-fund` | `owner`, `projectUri`, `tokenName`, `ticker`, `mustStartAtOrAfter`, `salt`, `peerSuckerDeployers` |
| `unknown` | none — render generically, never guess a shape |

Keep intents out of Trending and Top: those rankings are volume-based and an intent has no
volume.

## Sponsored deploy

```http
POST /v1/intents/:id/deploy
```

No request body. Center executes the intent's own signed calls at its own expense.

| Status | Body | Meaning |
|---|---|---|
| `202` | `{"deploys":[...]}` | Queued for the first time, one row per chain, all `queued` |
| `200` | `{"deploys":[...]}` | Rows already exist. The same rows come back; the request is idempotent per intent, not per call |
| `400` | `bad_request` | The id is not a UUID, the intent is already `deployed`, or its chains are not sponsorable |
| `404` | `not_found` | No such intent |
| `429` | `sponsor_budget` | The daily sponsorship budget is spent: the shared one, or an MCP caller's own slice of it. `Retry-After: 86400` |
| `429` | `sponsor_quota` | The requester's daily quota is spent. `Retry-After: 86400` |
| `503` | `unavailable` | No sponsor is configured, or sponsorship is paused |

The budget is checked before the quota, so a budget refusal costs the requester nothing. The
SDK's `describeCenterRefusal(error)` turns `sponsor_budget`, `sponsor_quota` and `unavailable`
into one authored sentence each, plus a generic sentence for any other `429`; it returns `null`
for a refusal it does not recognize, such as `bad_request` or `not_found`.

### Sponsored chains

| Family | Chain ids |
|---|---|
| Mainnet | `10` Optimism, `8453` Base, `42161` Arbitrum |
| Testnet | `11155111` Sepolia, `11155420` Optimism Sepolia, `84532` Base Sepolia, `421614` Arbitrum Sepolia |

Every chain of an intent must come from one family. A mix of families, or any chain outside both
lists, is not sponsorable. Ethereum mainnet (`1`) is never sponsored: an intent that includes it
is self-paid only.

### Cost and quotas

| Setting | Default |
|---|---|
| Deploys per requester per day (`SPONSOR_DEPLOYS_PER_REQUESTER_PER_DAY`) | 5 |
| Shared daily budget (`SPONSOR_DAILY_BUDGET_WEI`) | 50000000000000000 wei (0.05 ETH) |
| The MCP's slice of that day (`SPONSOR_MCP_DAILY_BUDGET_WEI`) | a fifth of the shared daily budget |
| Reservation per chain | `maxGas * maxFeePerGas + creationFeeCeiling` = 8000000 * 1000000000 + 100000000000000 = 8100000000000000 wei (0.0081 ETH) |
| Confirmations before a chain counts as confirmed | 2 |

As of 2026-09-21, production raises `SPONSOR_DEPLOYS_PER_REQUESTER_PER_DAY` to 100 deploys per
requester per day; the shared daily budget runs at its default.

A request reserves the full amount for every chain up front. A reservation is released when the
chain confirms, and when a chain fails without a bundle having been paid for it; a failed row that
did pay a bundle keeps its reservation for the rest of the 24-hour window, because that money may
have left. The budget is charged what the sponsor actually spent once the Relayr prepayment
settles.

For browser callers the requester is the calling origin and IP; for the MCP tools it is one shared
Center-side bucket, so the MCP's daily sponsored deploys draw down one shared
`SPONSOR_DEPLOYS_PER_REQUESTER_PER_DAY` allowance across every MCP caller. Those deploys are also
checked against `SPONSOR_MCP_DAILY_BUDGET_WEI` before the shared budget, so a busy assistant
refuses at its own slice rather than spending the day out from under first-party apps.

### Polling

Poll `GET /v1/intents/:id` and read `deploys`. This is a `/v1` route like any other, subject to
the same 600-requests-per-minute per-caller limit (`429` `rate_limit`, `Retry-After: 60`), so
poll on an interval, not in a tight loop. A row moves `queued` to `sent` to `confirmed`, or to
`failed`. A confirmed chain also writes its `deployments` entry, so `deployments` and `deploys`
converge. A `queued` or `sent` row may carry an `error` while Center keeps retrying it:
`SPONSOR_UNFUNDED` (the sponsor key cannot cover that chain's creation fee yet),
`SPONSORSHIP_RPC_UNAVAILABLE` (a chain could not be read or simulated),
`RELAYR_INVALID_STATUS` (the execution service answered with a status Center would not bind)
and `RELAYR_TIMEOUT` (the execution service has not executed the bundle yet) are all waiting
states, not outcomes. Keep polling while `status` is not `failed`.

`failed` is set only on a definitive outcome — a reverted or unverifiable deployment, a refused
quote, an exhausted set of attempts — or after 24 hours of waiting: `bundle unresolved` for a row
whose bundle the execution service never resolved, `retries exhausted` for one that never got that
far. An operator reconciles an unresolved bundle by recording its deployment through
`POST /v1/intents/:id/deployments` once the execution service shows the hash. A `failed`
row is terminal for that intent: Center will not retry it and a second
`POST /v1/intents/:id/deploy` returns the same rows, including the failed one. Recovery is a new
intent, or the self-paid path for a fresh intent — never a partial self-paid patch over the same
one.

The SDK wraps this as `ensureDeployed({ client, intent, onStep, pollMs, timeoutMs, signal })`,
which requests the sponsored deploy, polls on a 4-second default interval until every chain is
`confirmed`, and returns `Record<chainId, projectId>`. It throws `EnsureDeployedError` carrying
the `chainId` of the row that failed.

## Self-paid deploy and recording it

Send the intent's exact per-chain calls from one wallet, with `JBProjects.creationFee()` as the
value, then tell Center about each result:

```http
POST /v1/intents/:id/deployments
Content-Type: application/json

{ "chainId": 8453, "projectId": "123", "transactionHash": "0x..." }
```

Before writing, Center fetches the receipt and the call trace from its own RPC and requires all
of the following: a successful transaction with the configured confirmation count; exactly one
`JBProjects.Create(projectId, owner, caller)` event from the canonical `JBProjects`, and it must
be for the claimed `projectId` specifically, not merely present; and a successful direct or
nested `CALL` whose target matches the signed per-chain commitment and whose calldata is either
that commitment verbatim, or that commitment plus exactly one appended 20-byte address when the
calling frame's caller is the canonical `ERC2771Forwarder` (the forwarder appends the signer's
address to a forwarded call). Nested matching covers Safe and Relayr execution.

| Status | Code | Meaning |
|---|---|---|
| `201` | — | Recorded |
| `400` | `bad_request` | Bad id, bad hash, bad `projectId`, or a `chainId` outside the intent |
| `404` | `not_found` | No such intent |
| `409` | `conflict` | A different deployment is already recorded for that chain |
| `422` | `deployment_unverified` | The trace or the event did not match the signed commitment |
| `503` | `unavailable` | Deployment verification is not configured |

Never mix senders. If a sponsored deploy was requested, do not also send the calls yourself. If
you sent some chains yourself, Center will refuse to sponsor the rest — and even if it did not,
the salts would no longer match and the chains would never link.

## Worked examples

### Beep: a server key publishes, the merchant owns

Beep creates a terminal for a merchant who has no wallet in hand. Beep's server key is the
`publisher`; the merchant's address is `jb.owner` and the owner inside the launch calldata. The
project is listed and has a page immediately. The first charge runs `ensureDeployed` at Beep's
single write chokepoint, before anything in the review-simulate-send pipeline, because there is
no `projectId` to write against until it resolves.

- `format`: `beep.biz/terminal.v1`
- `publisher`: Beep's server key, the only signer, on every intent
- `jb.owner`: the merchant
- Lists: `searchIntents({ publisher })` for Beep's own dashboard, `searchIntents({ owner })` for
  the merchant's projects
- Deploy: sponsored, triggered by the first charge

### Homerun: the owner publishes, chains linked by one salt

Homerun creates a FUND across sponsored rollups. The merchant's own external wallet signs, so the
merchant is both `publisher` and `jb.owner`. The client fixes one random salt and one absolute
start before building the per-chain calls, so every chain carries identical arguments and the
suckers link.

- `format`: `homerun.money/fund.v1`
- `jb`: `{ app: "homerun", kind: "fund", name, owner, chainIds, tokenName, ticker, salt, mustStartAtOrAfter, projectUri }`
- Chains: sponsored rollups only. A FUND that includes Ethereum mainnet is self-paid
- Deploy: one Deploy action on the project page, sponsored, no self-paid fallback

## Common mistakes

- **Stage 1 with `mustStartAtOrAfter: 0`.** Zero means "start now", and "now" is deploy time, not
  the time the signer saw. Every later stage boundary shifts with it. Set an absolute timestamp:
  the moment the intent is made, or an explicitly chosen future time. Stage timestamps are
  honored exactly as signed; a late deploy does not move them.
- **Deploying some chains yourself and asking Center to sponsor the rest.** The salts stop
  matching and the chains never link into one omnichain project. There is no repair.
- **Hand-building the signing message.** Always take it from `POST /v1/intents/message`, and
  always run the two guard checks before signing.
- **Signing without comparing the prepared envelope to the local one.** The signature is over
  whatever Center normalized, not over what you meant.
- **Showing intents in Trending or Top.** Those are volume-based; an intent has none.
- **Calling them "intents" in user-facing copy.** It invites edit and withdraw requests that do
  not exist. Say "project", with a "Deploys on first use" label.
- **Treating the publish signature as transaction approval.** It authorizes storage and
  publication of frozen calldata. Deployment is a separate funded transaction.
- **Publishing from a smart account.** Center recovers the signer from the signature; a contract
  signature is refused. Publish from an externally owned account.
- **Expecting a failed sponsored row to retry.** It is terminal for that intent. A row that is
  still `queued` or `sent` with an `error` is the opposite case: Center is retrying it.
- **An HTTPS `logoUri`.** The first-party webclients render `ipfs://` only.

## Related

- [Agent integration guide](./AI_GUIDE.md): transaction review and recovery across Center's APIs.
- [Journey map](./USER_JOURNEYS.md): the directory, REST, sponsored execution and shared services.
- [MCP connection guide](https://github.com/mejango/jbcenter/blob/main/mcp/README.md): connect a
  client to `https://juicebox.center/mcp`.
