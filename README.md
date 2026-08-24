# JB Center

JB Center is the small shared offchain service beside Bendystraw. It stores signed, undeployed
Juicebox project intents and provides the ecosystem's redundant IPFS pinning, public read gateway,
and credential-hiding read-only Ethereum RPC. Webclients can render an intent as a project page and include it beside deployed
Bendystraw projects in search. When a deployment is recorded, the intent leaves default search.

There are no server-side drafts. A stored intent is immutable; changing a project means publishing a
new intent.

## Run it

Requires Node 22 and PostgreSQL 14 or newer.

```sh
cp .env.example .env
npm install
npm run dev
```

Browser requests are accepted only from the origins hardcoded for the active Railway environment.
Production accepts `https://juicebox.money` and `https://revnet.money`. `dev` accepts only
`https://dev.juicebox.money`, `https://dev.revnet.money`, `http://localhost:3001`, and
`http://localhost:3002`. `GET /healthz` is public for infrastructure health checks, and
`/ipfs/*` is a public read gateway.

## Pin and read IPFS content

JB Center sends each upload to Filebase first to produce and retain a canonical CIDv0, then
asks Pinata to pin that exact CID. A successful response means Filebase has accepted the bytes and
Pinata has queued the redundant pin:

```http
POST /v1/pins/json   Content-Type: application/json       # 2 MiB
POST /v1/pins/file   Content-Type: multipart/form-data     # image, 25 MiB
POST /v1/pins/media  Content-Type: multipart/form-data     # media/video, 500 MiB
```

Multipart requests use a field named `file`. Media uploads stream into Filebase's bucket-scoped IPFS RPC API
instead of being retained in server memory. Railway has no fixed request-body limit, but its public
edge requires the request body to finish within five minutes; the caller's uplink can therefore be
the practical limit before the 500 MiB application ceiling.

```json
{
  "cid": "Qm...",
  "status": "queued",
  "uri": "ipfs://Qm...",
  "gatewayUrl": "/ipfs/Qm..."
}
```

Reads are deliberately public and require neither auth nor an IP allowlist:

```http
GET /ipfs/:cid[/safe/path]
```

The read gateway validates the CID and path, falls back across independent public gateways, caps
responses at 500 MiB, and forwards HTTP byte ranges so browsers can seek through video and audio.
It emits cross-origin and immutable-cache headers and forces executable or navigable content to
download. Pin writes use a PostgreSQL-backed ten-per-caller and 200-per-site budget per ten minutes.
An Origin header is a browser boundary, not identity; production should put a WAF in front if
provider spend becomes meaningful.

## Read Ethereum RPC

Trusted browsers can use Center as a provider-neutral, credential-hiding
JSON-RPC endpoint:

```http
POST /v1/rpc/:chainId
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x...","data":"0x..."},"latest"]}
```

The endpoint accepts one JSON-RPC request at a time and permits only an explicit set of read
methods used by ordinary viem public clients. Transaction submission, signing, wallet, debug,
trace, admin, and txpool methods are rejected. Log queries require a block hash, `latest`-only
poll, or a concrete range of at most 50,000 blocks. Requests are capped at 256 KiB, responses at
5 MiB, and upstream calls at 12 seconds. Center fails over across up to three configured upstreams
without returning their credential-bearing URLs to clients.

Browser callers use the ordinary trusted `Origin` boundary plus per-caller and shared site budgets.
An `Origin` header is not identity, so upstream provider quotas remain the final spend boundary.
Wallets must continue submitting transactions through their own wallet transport; Center is only a
public-client read transport.

## Publish an intent

First ask JB Center for the deterministic message to sign:

```sh
curl -X POST http://localhost:3000/v1/intents/message \
  -H 'origin: https://juicebox.money' \
  -H 'content-type: application/json' \
  --data '{
    "format":"juicebox.money/v1",
    "deploymentVersion":"6",
    "chainIds":[1],
    "deploymentCalls":[{
      "chainId":1,
      "to":"0x3333333333333333333333333333333333333333",
      "data":"0x12345678..."
    }],
    "jb":{"v":1,"name":"Example","chains":[1],"stages":[{}]}
  }'
```

Sign the returned `message` with the publishing wallet using ordinary Ethereum `signMessage`, then
submit the same fields plus `publisher` and `signature` to `POST /v1/intents`. Repeating the same
publisher and content is idempotent.

```ts
const prepared = await central("/v1/intents/message", envelope)
const signature = await walletClient.signMessage({
  account,
  message: prepared.message,
})
const intent = await central("/v1/intents", {
  ...envelope,
  publisher: account.address,
  signature,
})
```

JB Center accepts any JSON object as `jb`, caps signed envelopes at 16.8 MB, and indexes common
Juicebox Money and Revnet Money metadata fields. `chainIds` must match `chains` or `data.chainIds`
when the `.jb` declares them. `deploymentCalls` must contain exactly one ABI-encoded call per
chain. The call target and complete calldata are part of the signed content, making the frozen
deployment directly executable and independently verifiable without re-deriving time-sensitive
arguments.

## Read and search

```http
GET /v1/intents/:id
GET /v1/search?q=climate&limit=20&cursor=20
```

Search returns a merge-friendly page:

```json
{
  "items": [{
    "source": "jbcenter",
    "status": "undeployed",
    "intentId": "...",
    "chainIds": [1],
    "name": "Example"
  }],
  "totalCount": 1,
  "nextCursor": null
}
```

Query this endpoint and Bendystraw concurrently. JB Center ranks textual searches with
PostgreSQL full-text search and lists recent intents when `q` is empty.

## Record deployment

Any trusted webclient can associate an onchain project with its signed intent:

```http
POST /v1/intents/:id/deployments
Content-Type: application/json

{
  "chainId": 1,
  "projectId": "123",
  "transactionHash": "0x..."
}
```

Before writing, JB Center fetches the receipt and call trace from the configured chain RPC. It
requires a successful transaction with the configured confirmation count, exactly one matching
`JBProjects.Create(projectId, owner, caller)` event from canonical `JBProjects`, and a successful
direct or nested `CALL` whose target and calldata exactly match the signed per-chain commitment.
Nested matching supports Safe and Relayr execution. Deployment records are write-once per intent
and chain. Recording the first deployment removes the intent from search while preserving the
`.jb`, signature, exact launch call, and deployment provenance at its direct URL.

## Authentication boundaries

Client access uses the two reviewed browser origins; signed intents provide publisher authenticity.
Deployment recording needs no bearer credential: the publisher's signed call commitment and the
onchain trace provide the intent-to-project binding. Center's server-side trace method is not
exposed through the public browser RPC gateway.

## Production configuration

Canonical V6 `JBProjects` metadata and reviewed Dwellir hosts are code constants. Configure only
`DWELLIR_API_KEY`; Center constructs the eight supported RPC URLs and reuses the four mainnet
upstreams for fail-closed deployment verification.

The remaining controls are environment variables:

- `RATE_LIMIT_PER_MINUTE` — shared PostgreSQL-backed limit per named API client; default `600`.
- `RPC_REQUEST_LIMIT_PER_MINUTE` — per browser/IP or named-client RPC requests; default `600`.
- `RPC_SITE_LIMIT_PER_MINUTE` — shared RPC requests across all clients; default `20000`.
- `MAX_INTENTS_PER_CLIENT` — lifetime intent count per client; default `10000`.
- `MAX_STORAGE_BYTES_PER_CLIENT` — lifetime stored envelope bytes per client; default 1 GiB.
- `METRICS_TOKEN` — required 32-character bearer token for `GET /metrics`.
- `FILEBASE_RPC_TOKEN` — bucket-scoped bearer token for Filebase's IPFS RPC API; never expose it to
  a browser.
- `PINATA_JWT` — scoped Pinata token with `org:files:write`; never expose it to a browser.
- `DATABASE_URL` — PostgreSQL connection string; require TLS in the production provider settings.

`GET /healthz` is process liveness. `GET /readyz` checks PostgreSQL. `GET /metrics` returns protected
Prometheus metrics. Requests are logged as one-line JSON with request ID, caller,
status, and duration; secrets and request bodies are never logged.

The included `Dockerfile` runs as the unprivileged Node user, and `railway.json` uses `/readyz` for
deployment health checks. Set `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30`, configure continuous uptime
monitoring separately, and enable automated PostgreSQL backups and retention with the database
provider.

The CI workflow runs the complete suite against PostgreSQL 16 and builds the production container on
every pull request. Keep JB Center as the workflow's repository root (or move the workflow to the
monorepo root and set its working directory).

## Verification

```sh
npm test
npm run typecheck
npm run build
TEST_DATABASE_URL=postgresql://... npm test
```

The PostgreSQL suite exercises concurrent migrations, duplicate publications, shared rate limits,
storage quotas, search, and deployment retirement. A dependency-free load probe is also included:

```sh
LOAD_TEST_URL=https://juicebox.center \
LOAD_TEST_REQUESTS=1000 \
LOAD_TEST_CONCURRENCY=25 \
npm run load:test
```

Raise `RATE_LIMIT_PER_MINUTE` above the load-test request count for the test caller. Client/Para UI
integration is intentionally deferred until the service contract is final.
