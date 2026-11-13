# Production operations

Center owns protocol reads/preparation, project intents, publication, shared quotas and the intent sponsor. Signa owns account and wallet execution. No Center account migration or compatibility service is required.

## Monitoring

`/healthz` reports process liveness and `/readyz` checks PostgreSQL. `/mcp/readyz` reports local MCP readiness, not upstream availability. `/api/v1/capabilities` describes the protocol API. Protected `/metrics` requires the operator's metrics token.

The [production workflow](https://github.com/mejango/jbcenter/blob/main/.github/workflows/production.yml) runs [the read-only production check](https://github.com/mejango/jbcenter/blob/main/scripts/check-production.mjs). Verify the deployed workflow and actual response contract after rollout. GitHub schedules are best effort, and notification delivery depends on operator settings.

For a failure, inspect the request ID, structured logs, database connectivity and configured RPC/indexer/pinning providers. Missing upstream evidence must stay unavailable. Account recovery alerts belong to Signa.

## Sponsored intent recovery

The intent sponsor retains its deployment rows, bundle identities, nonces and funding reservations. Pause new sponsorship with `SPONSOR_PAUSED=1` when investigating. An unknown Relayr submission must be reconciled with its original bundle and canonical destination receipts before replacement. A failure after funding is not an unused reservation.

Center runs one replica while intent sponsorship is enabled. Stop the HTTP listener and sponsor worker cleanly before closing PostgreSQL. See [the intent guide](PROJECT_INTENTS.md) for limits and retry semantics.

### Sponsor internals

On the sponsored path Center's sponsor key signs an ERC-2771 forward request per chain against the canonical `ERC2771Forwarder` from the V6 manifest, after checking that the call's target trusts that forwarder. The deployment calls themselves carry no value: the project creation fee is read live from `JBProjects.creationFee()` at deploy time and attached to the forwarded request, funded by the Relayr prepayment. A fee above Center's ceiling of `100000000000000` wei (0.0001 ETH) fails the lane instead of spending more than the reservation.

Recording a deployment that is not forwarded also retires, in the same database transaction, every queued sponsored row of the intent on every chain that has no bundle yet (`failed`, `mixed sender`), so a sponsor that becomes funded later can never launch a second project; the worker's claim refuses such rows too, and a lane already running on one cannot attach its bundle. A row that already has a bundle is left alone, because its prepayment may have left the sponsor key: the worker resumes it.

The sponsored deploy sends one bundle for all chains. Center numbers a chain's entries in that bundle, so the execution service sends the chain's Safe creations before its launch. Nothing depends on that order; the numbering is what the service requires to send them. The service answers with one identifier per call, in an order of its own, so Center reads the bundle back and binds each identifier to the one submitted call whose chain, contract, calldata, value and number all match it.

An MCP caller spends the hourly limit twice: once under its own publisher key, and once in a bucket every MCP publisher shares. A publisher key is free to mint, so the shared bucket is what bounds the assistant as a whole. Its stored intents and bytes count against the assistant's own lifetime caps (`MCP_MAX_INTENTS`, default 100000, and `MCP_MAX_STORAGE_BYTES`, default 10 GiB) rather than against a browser client's, and its sponsored deploys draw on the assistant's own daily slice of the sponsorship budget, below.

For browser callers the requester is the calling origin and IP; for the MCP tools it is one shared Center-side bucket, so the MCP's daily sponsored deploys draw down one shared `SPONSOR_DEPLOYS_PER_REQUESTER_PER_DAY` allowance across every MCP caller. Those deploys are also checked against `SPONSOR_MCP_DAILY_BUDGET_WEI` before the shared budget, so a busy assistant refuses at its own slice rather than spending the day out from under first-party apps.

## Database and storage

Keep backups for intents, signed envelopes, deployment associations, sponsor queues and quota state. Removing account runtime code does not authorize dropping production tables. New installs use only the retained Center schema; existing historical account rows may remain inert until an independently reviewed storage cleanup.

Verify current backup settings and recovery points with the hosting provider. Historical checks do not establish current recoverability. A restore must preserve the current volume, identify its recovery point and reconcile sponsored submissions that may have occurred after that point before resuming writes. Never assume an older queue proves that a transaction was not sent.

A full-data restore drill needs an isolated destination with no sponsor workers or production credentials capable of spending. Record what was restored, which checks passed and what remains untested. The IPFS disk cache is regenerable and must not be treated as the only copy of pinned content.

## Release checks

Run `npm run check` against a disposable PostgreSQL 16 database and build the production container. The retained sponsor checks also require Anvil, the pinned Solidity 0.8.26 compiler in the Foundry cache, and Playwright Chromium. The [CI workflow](https://github.com/mejango/jbcenter/blob/main/.github/workflows/ci.yml) owns their installation commands and tool pins. The gate includes retained protocol, publication, sponsor and MCP behavior. Review that account routes and bundles are absent and that existing project-intent consumers still work. Local checks establish the source build, not deployment readiness or successful production transactions.

## Configuration

Canonical V6 `JBProjects` metadata and reviewed Dwellir hosts are code constants. Configure only
`DWELLIR_API_KEY`; Center constructs the eight supported RPC URLs and reuses the four mainnet
upstreams for fail-closed deployment verification.

- `RATE_LIMIT_PER_MINUTE`: shared PostgreSQL-backed limit per named API client; default `600`.
- `RPC_REQUEST_LIMIT_PER_MINUTE`: per browser/IP or named-client RPC requests; default `600`.
- `RPC_SITE_LIMIT_PER_MINUTE`: shared RPC requests across all clients; default `20000`.
- `RPC_PUBLIC_REQUEST_LIMIT_PER_MINUTE`: keyless RPC requests per IP from untrusted origins; default `120`.
- `RPC_PUBLIC_SITE_LIMIT_PER_MINUTE`: shared keyless RPC budget across untrusted origins; default `5000`.
- `MAX_INTENTS_PER_CLIENT`: lifetime intent count per client; default `10000`.
- `MAX_STORAGE_BYTES_PER_CLIENT`: lifetime stored envelope bytes per client; default 1 GiB.
- `MCP_MAX_INTENTS`: lifetime intent count for the co-hosted MCP's single storage identity; default `100000`.
- `MCP_MAX_STORAGE_BYTES`: lifetime stored envelope bytes for that identity; default 10 GiB. Both
  replace the per-client pair for an in-process publish, and Center logs `storage_near_limit` once
  either identity passes four fifths of its cap.
- `SPONSOR_SIGNER_KEY`: optional private key that turns on `POST /v1/intents/:id/deploy`. It only
  needs ETH on the one rollup it pays the Relayr prepayment from; that prepayment carries the
  destination chains' creation fees and Relayr's executor supplies them there. Keep it a dedicated
  key, distinct from every other configured signer.
- `SPONSOR_PAUSED`: set to `1` to pause sponsored deploys without unsetting the signer key.
- `SPONSOR_DEPLOYS_PER_REQUESTER_PER_DAY`: deploy requests one requester may queue per day; default `5`.
- `PUBLISH_PER_PUBLISHER_PER_DAY`: publish requests one publisher key may sign per rolling day; default `20`.
- `PUBLISH_PER_IP_PER_HOUR`: publish requests one IP may make per rolling hour; default `60`. A
  platform whose server publishes on behalf of its users (one signing key, one outbound IP) needs
  both of these and `SPONSOR_DEPLOYS_PER_REQUESTER_PER_DAY` raised past their per-caller defaults.
- `SPONSOR_DAILY_BUDGET_WEI`: total wei reserved for sponsored deploys per rolling day, across every requester; default `50000000000000000`.
- `SPONSOR_MCP_DAILY_BUDGET_WEI`: the slice of that day the co-hosted MCP may spend, checked
  before the shared budget; default a fifth of `SPONSOR_DAILY_BUDGET_WEI`.
- `SPONSOR_MAX_GAS`: gas ceiling per forwarded deployment call; default `8000000`.
- `SPONSOR_MAX_FEE_PER_GAS`: max fee per gas the sponsor signs when paying for the Relayr bundle; default `1000000000`.
- `SPONSOR_CONFIRMATIONS`: confirmations awaited on each destination chain before a sponsored deploy is recorded; default `2`, and a lower value is raised to `2`, which the deployment verifier requires.
- `METRICS_TOKEN`: required 32-character bearer token for `GET /metrics`.
- `FILEBASE_RPC_TOKEN`: bucket-scoped bearer token for Filebase's IPFS RPC API; never expose it to
  a browser.
- `PINATA_JWT`: scoped Pinata token with `org:files:write`; never expose it to a browser.
- `IPFS_CACHE_DIR`: optional dedicated persistent directory for public IPFS reads; unset disables disk caching.
- `IPFS_CACHE_MAX_BYTES`: retained and in-progress content-byte budget, default `4294967296` (4 GiB). Allow extra volume capacity for filesystem metadata.
- `DATABASE_URL`: PostgreSQL connection string; require TLS in the production provider settings.
- `MCP_PLAN_SECRET`: required in production; a cryptographically random secret with at least
  32 bytes, stable across replicas. It authenticates unsigned transaction plans and separately
  scoped metadata review tokens; it is never a wallet key.
- `MCP_PUBLIC_ORIGIN`: default `https://juicebox.center`, without `/mcp` or another path.
- `MCP_BENDYSTRAW_MAINNET_URL`, `MCP_BENDYSTRAW_TESTNET_URL`: independently configured complete
  GraphQL endpoints. An absent network reports `NOT_CONFIGURED` and cannot fall back to another.
- `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS`: optional comma-separated additions to the MCP
  transport allowlists. Center's active environment browser origins are included automatically.
- `MCP_PLAN_TTL_SECONDS`: transaction-plan lifetime; default `300`, range `30` to `1800` seconds.
- `MCP_MAX_CONCURRENT_REQUESTS`: MCP HTTP operations per process; default `16`, range `1` to `128`.
- `MCP_KNOWLEDGE_PATH`: optional reviewed source-bundle override; packaged references are the default.

`GET /healthz` is process liveness. `GET /readyz` checks PostgreSQL. `GET /metrics` returns protected
Prometheus metrics. Requests are logged as one-line JSON with request ID, caller,
status, and duration; secrets and request bodies are never logged.

The included `Dockerfile` runs as the unprivileged Node user, and `railway.json` uses `/readyz` for
deployment health checks. Set `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30`, configure continuous uptime
monitoring separately, and enable automated PostgreSQL backups and retention with the database
provider.

For persistent IPFS reads on Railway, attach a volume at `/data`. Through Railway's maintenance
shell, initialize only `/data/ipfs` once with ownership `1000:1000` and permissions `0700`.
Then set `IPFS_CACHE_DIR=/data/ipfs` and keep the byte budget below the available volume capacity.
Keep Docker's default unprivileged Node user; no root startup setting is needed.
One process must own the cache directory. Railway volumes prevent replicas and add a brief stop
between deployments. Startup removes abandoned fills and reloads complete entries from the volume.
Railway's optional CDN can serve immutable IPFS responses at the edge; API, health and
metrics responses use `no-store`. `X-Cache` describes the CDN, while `X-IPFS-Cache` describes the
origin response that the CDN retained.

## Origins and access

Pinning and intent API requests require an origin hardcoded for the active Railway environment.
Production accepts `https://juicebox.money`, `https://revnet.money`, `https://eth.shop`,
`https://succulent.money`, `https://homerun.money`, `https://sticky.center`, `https://beep.biz`,
`https://market.chancedb.com`, `https://metalog.money`, `https://fairlun.ch`, and `https://api.signa.center`.
`dev` accepts the first four sites' `dev.` subdomains, `http://localhost:3001` through
`http://localhost:3004`, Homerun's `http://localhost:3010` and `http://localhost:3014`, Signa's `http://127.0.0.1:8787`, and
Sticky's `http://127.0.0.1:8788`, `https://sticky-dev.up.railway.app` and
`https://dev.sticky.center`. The homepage, `/ipfs/*` read gateway, and `/v1/rpc/:chainId`
RPC are public; RPC accepts any or no Origin. `GET /healthz` is public for infrastructure checks.

Intent writes use the reviewed browser origins; signed intents provide publisher authenticity.
Public protocol REST reads and preparation share a PostgreSQL-backed 10,000-request-per-minute budget across replicas, a per-process concurrency limit, and bounded upstream RPC work. No account enrollment or forwarded-header identity is required.
Deployment recording needs no bearer credential: the publisher's signed call commitment and the
onchain trace provide the intent-to-project binding. Center's server-side trace method is not
exposed through the public browser RPC gateway.

`/`, `/api` and its guides are public and cached for five minutes. Pages link scripts, stylesheets and icons by content hash (`name.<hash>.ext`, see `src/rest/web/assets.ts`); the current hash is cached for a year, and any other name for the file gets the current bytes uncached, so pages from either side of a deploy still load.

Juicescan links to its published CID on `inbrowser.link`, which verifies the content in the browser. Center gives that origin the explorer's RPC allowance. Update the CID from successful publisher or pin-provider records, not an unverified local build hash.

## MCP hosting

The server routes `/mcp` directly to the MCP transport before Center's browser API middleware.
MCP uses Center's store, read-only RPC gateway, and pinning service through bounded internal
callbacks. Publishing an intent and requesting a sponsored deploy are the two exceptions: MCP hands
the Hono app an in-process `Request` marked internal, so both reuse Center's own signature
verification, publish limits and sponsor policy instead of a second implementation. The marker
travels in Hono's environment and never in a header, so no network caller can claim it and no
browser Origin is impersonated. A publisher key is free to mint, so an in-process publish
spends both a per-publisher hourly key and a shared `mcp` hourly bucket, and is stored under the
single `mcp` identity whose lifetime intent and byte caps bound the whole MCP surface; a sponsored
deploy spends the shared `mcp` requester. Host and browser Origin checks remain active for every
network caller; non-browser clients do not need to invent an Origin.
Search removes non-V6 intent listings while preserving the upstream cursor; a mixed-version source
count is not reported as a V6 total. Direct intent reads also reject other deployment versions.

`/mcp/healthz` reports MCP liveness and `/mcp/readyz` reports local MCP readiness with upstream
health explicitly unchecked. Center's `/readyz` continues checking PostgreSQL. The integrated
service uses PostgreSQL-backed shared backend quotas: 600 Center reads per minute; 5,000 MCP RPC
requests per minute, also subject to `RPC_SITE_LIMIT_PER_MINUTE`; and ten MCP pins per ten minutes,
also subject to the existing 200-per-site pin budget. These are service-wide budgets across
replicas, in addition to MCP transport limits. See [MCP deployment](../../mcp/docs/DEPLOYMENT.md).

## IPFS pinning and read cache

JB Center sends each upload to Filebase first to produce and retain a canonical CIDv0, then
asks Pinata to pin that exact CID. A successful response means Filebase has accepted the bytes and
Pinata has queued the redundant pin:

Multipart requests use a field named `file`. Media uploads stream into Filebase's bucket-scoped IPFS RPC API
instead of being retained in server memory. Railway has no fixed request-body limit, but its public
edge requires the request body to finish within five minutes; the caller's uplink can therefore be
the practical limit before the 500 MiB application ceiling.

The read gateway validates the CID and path and serves retained content directly from disk when
`IPFS_CACHE_DIR` is configured. On a miss it tries Filebase before Pinata, dweb.link and ipfs.io,
streams the response to the caller while writing to disk, and publishes the cache entry only after
the full body succeeds. Concurrent requests for the same CID/path share that fill. Failed,
truncated and partial responses are never retained. Header waits are capped at ten seconds per
gateway, full streams at five minutes, and responses at 500 MiB.

The cache survives restarts and removes the least recently used copies to stay within its byte
budget. It also caps entries at 10,000 and concurrent fills at 16; filesystem metadata overhead is
additional. Eviction never unpins content from Filebase or Pinata. Cached content supports HEAD,
conditional requests and single HTTP byte ranges for seeking; cold HEAD/range requests go straight
to an upstream gateway without filling the cache. `X-IPFS-Cache: HIT`, `MISS` or `BYPASS` identifies
the origin's disk-cache behavior.

Successful reads emit cross-origin and one-year immutable browser/CDN cache headers. Errors use
`no-store`. Executable or navigable content is forced to download. Pin writes use a
PostgreSQL-backed ten-per-caller and 200-per-site budget per ten minutes.
An Origin header is a browser boundary, not identity; production should put a WAF in front if
provider spend becomes meaningful.

## RPC gateway

{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x...","data":"0x..."},"latest"]}
```

The endpoint accepts one JSON-RPC request at a time and permits only an explicit set of read
methods used by ordinary viem public clients. Transaction submission, signing, wallet, debug,
trace, admin, and txpool methods are rejected. Log queries require a block hash, `latest`-only
poll, or a concrete range of at most 50,000 blocks. Requests are capped at 256 KiB, responses at
5 MiB, and each upstream attempt at four seconds. Production tries Dwellir then PublicNode
without returning credential-bearing URLs to clients.

## Load test

The PostgreSQL suite exercises concurrent migrations, duplicate publications, shared rate limits,
storage quotas, search, and deployment retirement. A dependency-free load probe is also included:

```sh
LOAD_TEST_URL=https://juicebox.center \
LOAD_TEST_REQUESTS=1000 \
LOAD_TEST_CONCURRENCY=25 \
npm run load:test
```

Raise `RATE_LIMIT_PER_MINUTE` above the load-test request count for the test caller.

