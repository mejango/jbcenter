# JB Center

JB Center is the small shared offchain service beside Bendystraw. It stores signed, undeployed
Juicebox project intents and provides the ecosystem's redundant IPFS pinning and public read
gateway. Webclients can render an intent as a project page and include it beside deployed
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

The server runs concurrency-safe migrations at startup. Intent endpoints require a trusted client
key:

```http
Authorization: Bearer replace-me
```

Keep keys on a webclient server or API proxy. Do not put them in browser JavaScript. `GET /healthz`
is public for infrastructure health checks.

Browser requests are accepted only from the two origins hardcoded in the service:
`https://juicebox.money` and `https://revnet.money`. Those origins may call the pinning endpoints
directly without exposing a shared API key. Authenticated server-to-server and CLI requests, which
do not carry an `Origin` header, remain available for trusted clients and local development.

## Pin and read IPFS content

JB Center sends each upload to Filebase first to produce and retain a canonical CIDv0, then
asks Pinata to pin that exact CID. A successful response means Filebase has accepted the bytes and
Pinata has queued the redundant pin:

```http
POST /v1/pins/json   Content-Type: application/json       # 2 MiB
POST /v1/pins/file   Content-Type: multipart/form-data     # image, 25 MiB
POST /v1/pins/media  Content-Type: multipart/form-data     # media/video, 500 MiB
```

Multipart requests use a field named `file`. Media uploads stream into Filebase's multipart S3 API
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

## Publish an intent

First ask JB Center for the deterministic message to sign:

```sh
curl -X POST http://localhost:3000/v1/intents/message \
  -H 'authorization: Bearer replace-me' \
  -H 'content-type: application/json' \
  --data '{
    "format":"juicebox.money/v1",
    "deploymentVersion":"6",
    "chainIds":[1],
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

JB Center accepts any JSON object as `jb`, caps bodies at roughly 2 MB, and indexes common
Juicebox Money and Revnet Money metadata fields. `chainIds` must match `chains` or `data.chainIds`
when the `.jb` declares them.

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

Only a dedicated reconciler key can associate an onchain project with an intent:

```http
POST /v1/intents/:id/deployments
Authorization: Bearer <reconciler-secret>
Content-Type: application/json

{
  "chainId": 1,
  "projectId": "123",
  "transactionHash": "0x..."
}
```

Before writing, JB Center fetches the receipt from the configured chain RPC, requires a
successful transaction with the configured confirmation count, and decodes a matching
`JBProjects.Create(projectId, owner, caller)` event from the configured canonical `JBProjects`
address. Deployment records are write-once per intent and chain. Recording the first deployment
removes the intent from search while preserving the `.jb`, signature, and deployment provenance at
its direct URL.

This proves that the transaction created the claimed Juicebox project. The trusted reconciler still
chooses which JB Center intent maps to it because the `.jb` content hash is not emitted onchain.

## API keys

Configure separate comma-delimited client and reconciler keys. Production startup rejects secrets
shorter than 32 characters and duplicate names or secrets.

```env
JBCENTER_API_KEYS=juicebox-money:at-least-32-random-characters-here,revnet-money:another-32-character-random-secret
JBCENTER_RECONCILER_KEYS=bendystraw:a-separate-32-character-random-secret
```

Client keys can prepare, publish, read, and search. Reconciler keys may also record verified
deployments. Opening reads later only requires moving the auth middleware from `/v1/*` to the write
routes.

## Production configuration

`JBCENTER_CHAINS` configures fail-closed RPC verification:

```json
{
  "1": {
    "rpcUrl": "https://...",
    "projectsAddress": "0x...",
    "confirmations": 2,
    "deploymentVersion": "6"
  }
}
```

Each supported intent chain must be present with its canonical V6 `JBProjects` address. RPC URLs may
contain provider credentials and must be stored as secrets.

The remaining controls are environment variables:

- `RATE_LIMIT_PER_MINUTE` — shared PostgreSQL-backed limit per named API client; default `600`.
- `MAX_INTENTS_PER_CLIENT` — lifetime intent count per client; default `10000`.
- `MAX_STORAGE_BYTES_PER_CLIENT` — lifetime stored envelope bytes per client; default 1 GiB.
- `METRICS_TOKEN` — required 32-character bearer token for `GET /metrics`.
- `FILEBASE_ACCESS_KEY_ID`, `FILEBASE_SECRET_ACCESS_KEY`, and `FILEBASE_BUCKET` — credentials and
  dedicated IPFS bucket for Filebase's S3-compatible API; never expose them to a browser.
- `PINATA_JWT` — scoped Pinata token with `org:files:write`; never expose it to a browser.
- `DATABASE_URL` — PostgreSQL connection string; require TLS in the production provider settings.

`GET /healthz` is process liveness. `GET /readyz` checks PostgreSQL. `GET /metrics` returns protected
Prometheus metrics. Requests are logged as one-line JSON with request ID, authenticated client,
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
LOAD_TEST_API_KEY=... \
LOAD_TEST_REQUESTS=1000 \
LOAD_TEST_CONCURRENCY=25 \
npm run load:test
```

Raise `RATE_LIMIT_PER_MINUTE` above the load-test request count for the test client. Client/Para UI
integration is intentionally deferred until the service contract is final.
