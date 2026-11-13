# Project intents

A project intent is a signed, frozen Juicebox V6 project launch: the contract calls for
each chain plus the publishing client's own form document, stored by Center. Publishing
costs one wallet signature and no transaction. The project exists from the moment it is
published: it has an id, a page, and a row in search. It becomes an onchain project when
someone deploys it, either at Center's expense on the sponsored rollups or by paying for
the transaction themselves.

Say "project" in user-facing copy, with a "Deploys on first use" label. The word "intent"
belongs in API documentation, not in product copy: it suggests something still negotiable,
and a published intent cannot be edited, replaced or withdrawn.

## What an intent is

| Property | Value |
|---|---|
| Content | `format`, `deploymentVersion`, `chainIds`, 1 to 4 `deploymentCalls` per chain, and a `jb` document |
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

1. **Ask for an origin.** The first-party list lives in
   [`src/firstParty.ts`](https://github.com/mejango/jbcenter/blob/main/src/firstParty.ts), with
   production, dev and localhost entries per app. Open a pull request adding yours, or ask the
   maintainers.
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
| `format` | string | `<host>/<label>`: exactly one slash. Host part matches `[a-z0-9.-]{1,80}`, label matches `[a-zA-Z0-9._-]{1,32}`. Identifies the publishing client |
| `deploymentVersion` | string | `"6"`. 1 to 64 characters |
| `chainIds` | number[] | 1 to 16 unique positive integers. Center sorts them ascending before hashing |
| `deploymentCalls` | array | 1 to 4 calls, each `{chainId, to, data}`, for each member of `chainIds`, between 4 bytes and 4 MiB each. The last call for a chain is its launch call; see "Setup calls". `to` is checksummed; `data` is stored lowercased and matched case-insensitively when a self-paid deployment is verified. Center sorts by `chainId` before hashing and keeps each chain's calls in the order they were signed |
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

## Setup calls

A chain may carry more than one call. **The last call for a chain is the launch call;
every call before it is a setup call.**

A setup call creates a Safe. Center pays for it, so it is the only thing a setup call may
do:

| Part | Required value |
|---|---|
| `to` | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67`, the Safe 1.4.1 proxy factory. Its runtime code is checked on the chain before the sponsor pays |
| `data` | `createProxyWithNonce(singleton, initializer, saltNonce)`, encoded exactly |
| `singleton` | `0x41675C099F32341bf84BFc5382aF534df5C7461a` |
| `initializer` | `setup(owners, threshold, address(0), 0x, 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99, address(0), 0, address(0))` |
| `owners` | 1 to 20 unique nonzero addresses |
| `threshold` | 1 to `owners.length` |

Anything else is refused with `400` and a message naming the call index, for example
`deploymentCalls[0].to must be the canonical Safe proxy factory`. A chain accepts at most
four calls, so at most three Safes. Two byte-identical setup calls on one chain are refused
with `deploymentCalls[1] repeats a setup call on its chain`, because the second one would
create nothing and the sponsor would pay for its revert.

A Safe 1.4.1 address depends only on the factory, the singleton, the initializer and the
salt nonce. It never depends on the sender or the time. So the Safe creation and the
launch are independent: the project can be transferred to the Safe address before the
Safe exists, and the Safe accepts the project whenever it is created. A Safe that already
exists at the predicted address costs nothing: Center drops that call from the bundle. A
Safe creation that reverts does not fail the chain; the project is owned by the predicted
address either way and anyone can create the Safe later.

Each chain's row is `sent` on its launch transaction hash and `confirmed` when that transaction
succeeds and carries the `JBProjects.Create` event. `transactionHash` on the row and on the
recorded deployment is always the launch transaction.

### `jb.safes`

Center stores `jb` as it is given. The convention for rendering a Safe is:

```json
"safes": [
  {
    "role": "owner",
    "address": "0x...",
    "owners": ["0x...", "0x..."],
    "threshold": 2,
    "saltNonce": "0x..."
  }
]
```

### A Homerun fund that creates its own 2-of-2 owner Safe

```ts
import {
  buildSafeDeploymentCalls,
  predictSafeAddress,
  SAFE_PROXY_CREATION_CODE,
} from "@bananapus/nana-sdk-core/safe";

const policy = {
  owners: [alice, bob],
  threshold: 2,
  saltNonce,
  proxyCreationCode: SAFE_PROXY_CREATION_CODE,
};
// A plan carries the address it predicts; the SDK re-derives it and refuses a mismatch.
const owner = { ...policy, address: predictSafeAddress(policy) };

const deploymentCalls = chainIds.flatMap((chainId) => [
  ...buildSafeDeploymentCalls([owner]).map((call) => ({
    chainId,
    to: call.target,
    data: call.callData,
  })),
  {
    chainId,
    to: homerunDeployer[chainId],
    data: encodeFunctionData({
      abi: homerunAbi,
      functionName: "launchFundFor",
      args: [owner.address, /* the rest of the fund */],
    }),
  },
]);

const envelope = {
  format: "homerun.money/fund.v1",
  deploymentVersion: "6",
  chainIds,
  deploymentCalls,
  jb: {
    ...formValues,
    owner: owner.address,
    safes: [
      {
        role: "owner",
        address: owner.address,
        owners: owner.owners,
        threshold: owner.threshold,
        saltNonce: owner.saltNonce,
      },
    ],
  },
};
```

`jb.owner` is the Safe address, so the intent appears under `GET /v1/search?owner=`. A page
that lists "my projects" also filters by `publisher`, because the publishing wallet is an
owner of the Safe, not the project's owner.

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

Take it from `POST /v1/intents/message`. Build it yourself only to compare, in
[step 2](#step-2-apply-the-guard-then-sign).

## One sender per intent

Sucker, ERC-20 and 721-hook salts hash `_msgSender()` on every chain, so every chain of one intent
must be deployed by the same sender. Chains deployed by different senders land as unrelated
same-named projects on separate chains, and nothing can repair that.

An intent has exactly two valid senders, never mixed:

- **Center's sponsor.** It signs each chain's launch as an ERC-2771 forward request, so
  `_msgSender()` is the sponsor whether Center pays ([sponsored deploy](#sponsored-deploy)) or the
  visitor pays ([relay](#relay-a-chain-the-payer-sends)).
- **One wallet.** It sends every chain itself and
  [records each one](#self-paid-deploy-and-recording-it).

Center records which sender made each chain as `forwarded` on the deployment: true when the
committed call came through the canonical `ERC2771Forwarder` with Center's sponsor as the appended
sender, false otherwise. Once one deployment is not forwarded, the deploy and relay routes refuse
the whole intent with `409` `mixed_sender`, and every sponsored row still queued without a bundle
fails with `mixed sender`. A row whose bundle was already paid is left to finish. Both routes also
refuse a chain that already has a deployment.

So when Center deploys any chain of an intent, deploy a chain it does not sponsor, such as
Ethereum, with a relay request, never from your own wallet.

The deployment calls carry no value. The project creation fee is read from
`JBProjects.creationFee()` at deploy time and attached to the forwarded request. A fee above
`100000000000000` wei (0.0001 ETH) fails that chain's sponsored deploy.

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

Before signing, check two things. This is what stops a wrong response from getting a signature
over calldata the user never saw.

1. The returned `envelope` equals the one you built. Compare canonically: sort object keys,
   lowercase every hex string, and compare the serialized result.
2. The returned `message` equals, character for character, the
   [signing message](#content-hash-and-signing-message) for your envelope's content hash.

If either fails, do not sign, and show the mismatch. Sign the `message` Center returned, never one
you built.

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

Production can set these limits higher than the defaults. All MCP publishers also share one hourly
bucket, and their intents count against the MCP's own storage caps (`MCP_MAX_INTENTS`, default
100000, and `MCP_MAX_STORAGE_BYTES`, default 10 GiB).

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

`deployments` holds recorded onchain results, write-once per chain:

| Field | Meaning |
|---|---|
| `chainId` | The chain the project was created on |
| `projectId` | The project id the canonical `JBProjects.Create` event carried |
| `transactionHash` | The transaction Center verified |
| `forwarded` | True when the launch was sent through Center's forwarder with Center's sponsor as the appended sender, which is what lets Center sponsor or relay the remaining chains; false for a deployment any other sender made |
| `createdAt` | When Center recorded it |

`deploys` holds sponsored-deploy rows and is always present, empty until a
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
deployment calls (the launch is the same logical configuration on every chain) plus the pinned
metadata. No chain reads are needed or possible: nothing is onchain yet.

`decodeDeploymentCall` returns a typed shell per launch flavor:

| Flavor | Typed fields |
|---|---|
| `project` | `owner`, `projectUri`, `rulesetConfigurations`, `terminalConfigurations`, `memo` |
| `project-721` | `owner`, `projectUri`, `rulesetConfigurations`, `terminalConfigurations`, `memo`, `salt` |
| `omnichain` | `owner`, `projectUri`, `rulesetConfigurations`, `terminalConfigurations`, `memo`, `has721` |
| `revnet` | `operator`, `projectUri`, `stages`, `description`, `accountingContexts` |
| `homerun-fund` | `owner`, `projectUri`, `tokenName`, `ticker`, `mustStartAtOrAfter`, `salt`, `peerSuckerDeployers` |
| `unknown` | none. Render generically, never guess a shape |

Keep intents out of Trending and Top: those rankings are volume-based and an intent has no
volume.

## Sponsored deploy

```http
POST /v1/intents/:id/deploy
Content-Type: application/json

{ "chainIds": [8453] }
```

Center sends the intent's own signed calls and pays for them. The body is optional.

- Without `chainIds`, Center queues every chain of the intent that it sponsors and that has no
  deployment. A failed row stays as it is.
- With `chainIds`, each id must be in the intent, sponsored and not yet deployed. A chain whose row
  failed with no paid bundle is queued again as a fresh attempt, reserved and rated like a first
  request. A failed row that still carries a bundle, and any other existing row, comes back
  unchanged.
- The chains queued by one request must be from one [family](#sponsored-chains).

A chain Center does not sponsor, such as Ethereum, is left out. Deploy it with a
[relay request](#relay-a-chain-the-payer-sends).

| Status | Body | Meaning |
|---|---|---|
| `202` | `{"deploys":[...]}` | At least one chain was queued. One row per requested chain |
| `200` | `{"deploys":[...]}` | Every requested chain already has a row. The same rows come back |
| `400` | `bad_request` | The id is not a UUID, a named chain is not in the intent, is not sponsored or is already deployed, nothing sponsored is left to deploy, or the selected chains span both families |
| `404` | `not_found` | No such intent |
| `409` | `mixed_sender` | A wallet already deployed a chain of this intent. Deploy the rest from that wallet |
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

Ethereum mainnet (`1`) is never sponsored.

### Cost and quotas

| Setting | Default |
|---|---|
| Deploys per requester per day (`SPONSOR_DEPLOYS_PER_REQUESTER_PER_DAY`) | 5 |
| Shared daily budget (`SPONSOR_DAILY_BUDGET_WEI`) | 50000000000000000 wei (0.05 ETH) |
| The MCP's slice of that day (`SPONSOR_MCP_DAILY_BUDGET_WEI`) | a fifth of the shared daily budget |
| Reservation per chain | `maxGas * maxFeePerGas + creationFeeCeiling` = 8000000 * 1000000000 + 100000000000000 = 8100000000000000 wei (0.0081 ETH) |
| Confirmations before a chain counts as confirmed | 2 |

A request reserves the full amount for every chain up front. The reservation is released when the
chain confirms, or when it fails before a bundle was paid. A failed row that did pay a bundle
keeps its reservation for the rest of the 24-hour window. The budget is charged what the sponsor
spent once the Relayr prepayment settles.

For browser callers the requester is the calling origin and IP. All MCP callers share one
requester, and their deploys are checked against the MCP's slice before the shared budget.

### Polling

Poll `GET /v1/intents/:id` on an interval and read `deploys`. The route shares the
600-requests-per-minute per-caller limit (`429` `rate_limit`, `Retry-After: 60`).

| `status` | Meaning | Do |
|---|---|---|
| `queued` | Waiting to be sent | Keep polling |
| `sent` | The launch transaction has a hash | Keep polling |
| `confirmed` | The launch succeeded and its `deployments` entry is written | Done |
| `failed` | A definitive outcome | Recover as below |

A `queued` or `sent` row can carry an `error` while Center keeps retrying it. These are waiting
states, not outcomes:

| `error` | Meaning |
|---|---|
| `SPONSOR_UNFUNDED` | The sponsor key cannot cover that chain's creation fee yet |
| `SPONSORSHIP_RPC_UNAVAILABLE` | A chain could not be read or simulated |
| `RELAYR_INVALID_STATUS` | The execution service answered with a status Center would not bind |
| `RELAYR_TIMEOUT` | The execution service has not executed the bundle yet |

`failed` is set on a reverted or unverifiable deployment, a refused quote, exhausted attempts, a
wallet deployment recorded before the row had a bundle (`mixed sender`), or 24 hours of waiting:
`bundle unresolved` when the execution service never resolved the bundle, `retries exhausted` when
the row never got that far.

Center does not retry a `failed` row by itself. `POST /v1/intents/:id/deploy` naming the chain
queues it again only when the row has no `bundleUuid`. A row that carries one may yet execute, so
it comes back as it is; an operator reconciles it by recording its deployment through
`POST /v1/intents/:id/deployments` once the execution service shows the hash. Otherwise publish a
new intent. Never patch a partly sponsored intent from your own wallet.

The SDK wraps this as `ensureDeployed({ client, intent, onStep, pollMs, timeoutMs, signal })`,
which requests the sponsored deploy, polls on a 4-second default interval until every chain is
`confirmed`, and returns `Record<chainId, projectId>`. It throws `EnsureDeployedError` carrying
the `chainId` of the row that failed.

## Relay a chain the payer sends

```http
POST /v1/intents/:id/relay
Content-Type: application/json

{ "chainId": 1 }
```

Center signs that chain's launch and hands the signed request back. Nothing is stored, nothing is
queued and no ETH leaves Center. The payer sends one transaction to the forwarder and the project
is created with Center's sponsor as its sender, so the chain pairs with every chain Center deploys
itself.

```json
{
  "chainId": 1,
  "to": "0x3bA60b60933916a7C87D0860DcEE62a0CE34E3e2",
  "data": "0x47153f82...",
  "value": "100000000000000",
  "gas": "404761",
  "deadline": 1700001800,
  "setup": []
}
```

| Field | Meaning |
|---|---|
| `to` | The canonical `ERC2771Forwarder` on that chain |
| `data` | `execute(request)` carrying the signed forward request |
| `value` | `JBProjects.creationFee()` in wei, as a decimal string. The transaction must send exactly this |
| `gas` | The gas the outer transaction needs: the signed inner gas, the 1/64 the EVM keeps back, and the forwarder's overhead |
| `deadline` | Unix seconds. The signature is valid for 30 minutes |
| `setup` | The chain's Safe creations as `{to, data, value}`, in order, minus any Safe that already exists. Send these first, from any address |

Send the `setup` calls from any address: a Safe's address does not depend on its sender (see
[setup calls](#setup-calls)). The launch must stay the forwarded request, per
[one sender per intent](#one-sender-per-intent).

| Status | Code | Meaning |
|---|---|---|
| `200` | none | The signed request |
| `400` | `bad_request` | The id is not a UUID, `chainId` is missing or not in the intent, or that chain already has a deployment |
| `400` | `sponsored_chain` | Center deploys that chain itself. Use `POST /v1/intents/:id/deploy` |
| `404` | `not_found` | No such intent |
| `409` | `mixed_sender` | A wallet already deployed a chain of this intent. Deploy the rest from that wallet |
| `429` | `relay_limit` | 30 relay requests per requester per hour. `Retry-After: 3600` |
| `503` | `unavailable` | No sponsor is configured, or sponsorship is paused |
| `503` | `relay_unavailable` | Center could not read, simulate or sign for that chain |

Sponsored chains are refused so that a visitor and the sponsor lane never hold
the same forwarder nonce at once. Two visitors can: both get the nonce the forwarder holds now,
the first transaction to land consumes it and the second reverts. Fetch the request again and
send it. A request is valid only until its `deadline`.

Center's sponsor key must hold at least `JBProjects.creationFee()` on a relayed chain, because
both simulations send that value from the sponsor. The fee is never spent there; on Ethereum it is
`100000000000000` wei (0.0001 ETH).

When the transaction confirms, record it with `POST /v1/intents/:id/deployments` as for any chain
the payer sends. The verifier accepts the forwarded call: the trace carries the committed calldata
plus the appended sender, and the recorded deployment reads `forwarded: true`.

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
| `201` | none | Recorded. The body carries `forwarded`: true for a call the canonical forwarder made with Center's sponsor as the appended sender, false for one any other sender made |
| `400` | `bad_request` | Bad id, bad hash, bad `projectId`, or a `chainId` outside the intent |
| `404` | `not_found` | No such intent |
| `409` | `conflict` | A different deployment is already recorded for that chain |
| `422` | `deployment_unverified` | The trace or the event did not match the signed commitment |
| `503` | `unavailable` | Deployment verification is not configured |

Recording a chain your own wallet sent closes the deploy and relay routes for the whole intent.
Deploy the rest from the same wallet. See [one sender per intent](#one-sender-per-intent).

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

## Start times

Set `mustStartAtOrAfter` to an absolute timestamp: the moment the intent is made, or a chosen
future time. Zero means "start now", and "now" is deploy time, not the time the signer saw, so
every later stage boundary shifts with it. Stage timestamps are honored exactly as signed; a late
deploy does not move them.
