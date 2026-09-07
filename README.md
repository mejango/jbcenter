# JB Center

JB Center is the small shared offchain service beside Bendystraw. It stores signed, undeployed
Juicebox project intents and provides the ecosystem's redundant IPFS pinning, public read gateway,
credential-hiding read-only Ethereum RPC, the Juicebox V6 MCP at
`https://juicebox.center/mcp`, and authenticated REST at `https://juicebox.center/api/v1`.
Webclients can render an intent as a project page and include it beside deployed
Bendystraw projects in search. When a deployment is recorded, the intent leaves default search.

Stored project intents are immutable; changing one means publishing a new intent. REST transaction
plans are separate immutable records with durable execution progress.

## V6 REST API

Start at [the API directory](https://juicebox.center/api), [OpenAPI](https://juicebox.center/api/v1/openapi.json),
or the [signed-request quickstart](docs/rest/QUICKSTART.md). Wallet owners enroll at
[Accounts](https://juicebox.center/accounts), then register client-generated bot keys with explicit
read, plan, and relay scopes. Every live API request carries a short-lived EIP-712 signature binding
its audience, account, signer, method, exact path/query, raw body, nonce, and idempotency key.
Private keys stay with the client. API grants never substitute for onchain signing authority.

GET endpoints cover canonical contract reads and the V6-compatible Bendystraw schema. Project reads
require an explicit `source=onchain` or `source=bendystraw`; an unavailable source never silently falls
back to the other. The pinned catalog includes official core, buyback, 721, router, revnet, sucker,
and other V6 repositories, with exact deployed ABI variants and per-chain availability. Experimental
apps/extensions remain outside this protocol surface.

POST endpoints prepare transaction plans and relay externally signed transactions. Plans bind the
wallet, chains, destinations, calldata, values, dependencies, evidence, and expiry. Durable nonce,
idempotency, and transport reservations prevent conflicting submissions. A receipt confirms one
transaction; operation effects and cross-chain settlement have separate evidence.
Fund movement requires fresh owner consent unless an installed smart-account session already
authorizes that exact action within an explicit spending allocation. Direct EOA and Relayr dispatch
require a fresh signed owner request or an additional owner approval attached to the bot submission.
An old wallet transaction signature is insufficient.

Read [authentication](docs/rest/AUTHENTICATION.md), [contracts](docs/rest/CONTRACTS.md),
[indexed reads](docs/rest/INDEXER.md), [transactions](docs/rest/TRANSACTIONS.md),
[omnichain projects](docs/rest/OMNICHAIN.md), [sponsorship](docs/rest/SPONSORSHIP.md), and
[AI integration](docs/rest/AI_GUIDE.md). Relayr supports externally funded gas for eligible exact
owner-signed calls, with independent destination verification. Hosted ERC-4337 execution supports
reviewed Safe accounts, exact owner-signed bundles, and seven- or thirty-day bot sessions with
onchain spending and gas limits. The browser facilitates account creation, binding, activation,
local signing, quotas and revocation. Read the [session lifecycle](docs/rest/SESSIONS.md) and
[execution runbook](docs/rest/EXECUTION_OPERATIONS.md) before enabling it: providers require operator
configuration, and the checked session guard still requires a verified deployment on each enabled
chain. Live capabilities report configured availability. Gas sponsorship is separate from permission
to spend funds.

## Ecosystem directory

`https://juicebox.center/` is a public V6 directory. Eight connected question maps lead to apps,
owner workflows, development tools, APIs, agent setup, audits, repositories, and WIP extensions.
Routes share destinations and include labeled return paths: revisit launch settings, revise an
integration after transaction review, or publish replacement metadata after retrieving a CID.
Crossovers connect related tasks. The maps use three columns on desktop and stack on phones.
A small browser script draws decorative connectors, highlights the chosen route, and supports
direct links (`#api/rpc`, for example), keyboard navigation, and browser history. It renders a
finite set of nodes and edges; cycles never recursively expand the page.
All content is server-rendered. The complete directory stays available as a collapsible reference
and opens by default without JavaScript. Directory navigation
does not query storage or upstream services. The API branch includes public RPC and IPFS reads,
supported networks, and upload examples with their approved-origin requirements.
The WIP branch holds extensions with unfinished production functionality, with a specific status
note for each. A deployed frontend alone does not imply its contracts or payment flow are ready.

Edit shared questions, transitions, and map placements in [`src/journeyGraph.ts`](src/journeyGraph.ts).
Each node's title is also the label of every option pointing to it. Keep that title concise;
use its separate prompt for the question inside the card. Edges only identify destinations,
so option labels and destination headings stay in sync.
Maintain the complete directory and repository links in [`src/directory.ts`](src/directory.ts).
Every sequence of questions must reach a resource with an external link or a usable reference.
Graph validation rejects question-only cycles (even with an escape route), dead ends, empty
resources, and broken destinations or placements. Optional returns remain available after a
resource has been reached, under “Optional next steps.” Shared nodes have an explicit home view
for crossovers, so a destination does not change sections when map declarations are reordered.
Tests verify these rules, reachable routes, and shared destinations.
Layout and styling live in [`src/homepage.ts`](src/homepage.ts), with browser behavior in
[`src/directoryClient.ts`](src/directoryClient.ts). Keep monospace type, square corners, and minimal
copy. Do not use middot separators. Verify public destinations, protocol versions, and feature
availability before adding or changing a link. Distinguish source repositories from live apps.
`/`, `/directory.css`, and `/directory.js` are public and cached for five minutes. These exact routes do not
change the API, IPFS, or MCP access rules.
Stylesheet and script URLs include content hashes so updates bypass older cached assets.
Juicescan links to its published CID on `eth.sucks`, with a separate source link. Update the CID
from successful publisher or pin-provider records, not an unverified local build hash.

## Run it

Requires Node 22 and PostgreSQL 14 or newer.

```sh
cp .env.example .env
npm install
npm --prefix mcp ci --ignore-scripts
npm run dev
```

Pinning and intent API requests require an origin hardcoded for the active Railway environment.
Production accepts `https://juicebox.money`, `https://revnet.money`, `https://eth.shop`, and
`https://succulent.money`. `dev` accepts their `dev.` subdomains and `http://localhost:3001`
through `http://localhost:3004`. The homepage, `/ipfs/*` read gateway, and `/v1/rpc/:chainId`
RPC are public; RPC accepts any or no Origin. `GET /healthz` is public for infrastructure checks.

## Connect an assistant through MCP

The `mcp/` package provides **56 V6-only tools across ten capability families**: project and
account intelligence, payments and cash-outs, launches and ruleset changes, buyback hooks, router
terminals, 721 shops, revnets and loans, omnichain operations, source and webclient development,
and reviewed project metadata publication. Read the [26 user journeys](mcp/docs/USER_JOURNEYS.md)
and [tool catalog](mcp/docs/TOOLS.md) for exact coverage and limitations.

Point a Streamable HTTP MCP client at:

```json
{
  "mcpServers": {
    "juicebox": { "url": "https://juicebox.center/mcp" }
  }
}
```

The server routes `/mcp` directly to the MCP transport before Center's browser API middleware.
MCP uses Center's store, read-only RPC gateway, and pinning service through bounded internal
callbacks. It does not send HTTP requests back to itself or impersonate an approved browser Origin.
Its Host and browser Origin checks remain active; non-browser clients do not need to invent an Origin.
Search removes non-V6 intent listings while preserving the upstream cursor; a mixed-version source
count is not reported as a V6 total. Direct intent reads also reject other deployment versions.

An assistant can prepare new project metadata using `jb_prepare_project_metadata`, show the exact
JSON and public visibility and potential permanence, then call `jb_pin_project_metadata` only after the user
explicitly approves that document. The expiring review token commits to the exact UTF-8 bytes.
Pinning returns a CID and `ipfs://` URI for a separately reviewed V6 launch. It does not upload a
logo, merge existing metadata, update an existing project, sign, or broadcast a transaction. A logo
must already have a real HTTPS URL or IPFS CID and can be omitted until available.

`/mcp/healthz` reports MCP liveness and `/mcp/readyz` reports local MCP readiness with upstream
health explicitly unchecked. Center's `/readyz` continues checking PostgreSQL. The integrated
service uses PostgreSQL-backed shared backend quotas: 600 Center reads per minute; 5,000 MCP RPC
requests per minute, also subject to `RPC_SITE_LIMIT_PER_MINUTE`; and ten MCP pins per ten minutes,
also subject to the existing 200-per-site pin budget. These are service-wide budgets across
replicas, in addition to MCP transport limits. See [MCP deployment](mcp/docs/DEPLOYMENT.md).

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

Any browser can use Center as a provider-neutral, credential-hiding
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
5 MiB, and each upstream attempt at four seconds. Production tries Dwellir then PublicNode
without returning credential-bearing URLs to clients.

Trusted origins get the site's per-caller and shared budgets. Every other caller — sites served
from IPFS such as juicescan have no stable origin to allowlist — is served keyless with `*` CORS
under a tighter per-IP budget and a separate shared public budget, so public traffic can never
starve the trusted sites. An `Origin` header is not identity, so upstream provider quotas remain
the final spend boundary.
This public RPC route remains a read transport. Externally wallet-signed transaction submission
uses the separately authenticated REST plan/submission API.

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
const prepared = await central("/v1/intents/message", envelope);
const signature = await walletClient.signMessage({
  account,
  message: prepared.message,
});
const intent = await central("/v1/intents", {
  ...envelope,
  publisher: account.address,
  signature,
});
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
  "items": [
    {
      "source": "jbcenter",
      "status": "undeployed",
      "intentId": "...",
      "chainIds": [1],
      "name": "Example"
    }
  ],
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
- `RPC_PUBLIC_REQUEST_LIMIT_PER_MINUTE` — keyless RPC requests per IP from untrusted origins; default `120`.
- `RPC_PUBLIC_SITE_LIMIT_PER_MINUTE` — shared keyless RPC budget across untrusted origins; default `5000`.
- `MAX_INTENTS_PER_CLIENT` — lifetime intent count per client; default `10000`.
- `MAX_STORAGE_BYTES_PER_CLIENT` — lifetime stored envelope bytes per client; default 1 GiB.
- `METRICS_TOKEN` — required 32-character bearer token for `GET /metrics`.
- `FILEBASE_RPC_TOKEN` — bucket-scoped bearer token for Filebase's IPFS RPC API; never expose it to
  a browser.
- `PINATA_JWT` — scoped Pinata token with `org:files:write`; never expose it to a browser.
- `DATABASE_URL` — PostgreSQL connection string; require TLS in the production provider settings.
- `MCP_PLAN_SECRET` — required in production; a cryptographically random secret with at least
  32 bytes, stable across replicas. It authenticates unsigned transaction plans and separately
  scoped metadata review tokens; it is never a wallet key.
- `MCP_PUBLIC_ORIGIN` — default `https://juicebox.center`, without `/mcp` or another path.
- `MCP_BENDYSTRAW_MAINNET_URL`, `MCP_BENDYSTRAW_TESTNET_URL` — independently configured complete
  GraphQL endpoints. An absent network reports `NOT_CONFIGURED` and cannot fall back to another.
- `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS` — optional comma-separated additions to the MCP
  transport allowlists. Center's active environment browser origins are included automatically.
- `MCP_PLAN_TTL_SECONDS` — transaction-plan lifetime; default `300`, range `30`–`1800` seconds.
- `MCP_MAX_CONCURRENT_REQUESTS` — MCP HTTP operations per process; default `16`, range `1`–`128`.
- `MCP_KNOWLEDGE_PATH` — optional reviewed source-bundle override; packaged references are the default.

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
npm run check
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
