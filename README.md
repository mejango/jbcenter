# Juicebox Center

Juicebox Center is the directory and shared service for Juicebox V6: a REST API, an MCP server for
agents, a read-only Ethereum RPC, IPFS pinning and reads, and signed project intents. It runs at
[juicebox.center](https://juicebox.center). Accounts and wallets live in [Signa](https://signa.center).

## Where to go

| I want to | Go to |
| --- | --- |
| Find an app, guide or repository | [juicebox.center](https://juicebox.center), or [`/llms.txt`](https://juicebox.center/llms.txt) as text |
| Make a first API request | [Quickstart](docs/rest/QUICKSTART.md) |
| See every route and schema | [API guide](docs/rest/API.md), [OpenAPI](https://juicebox.center/api/v1/openapi.json) |
| Prepare a transaction | [Transactions](docs/rest/TRANSACTIONS.md) |
| Read contracts or indexed history | [Contract reads](docs/rest/CONTRACTS.md), [indexed reads](docs/rest/INDEXER.md), [omnichain projects](docs/rest/OMNICHAIN.md) |
| Publish and deploy a project | [Project intents](docs/rest/PROJECT_INTENTS.md) |
| Connect an agent | [MCP](#connect-an-assistant-through-mcp), [agent guide](docs/rest/AI_GUIDE.md), [tool catalog](mcp/docs/TOOLS.md) |
| Read chain state from a browser | [RPC](#read-ethereum-rpc) |
| Pin or read IPFS content | [IPFS](#pin-and-read-ipfs-content) |
| Run or operate Center | [Run it](#run-it), [production operations](docs/rest/PRODUCTION_OPERATIONS.md) |

## Run it

Use the pinned Node 26.13.1 runtime (`nvm use`) with bundled npm 11.20.0.
PostgreSQL 14 or newer is supported; the complete release checks require a
disposable PostgreSQL 16 database.

```sh
nvm use
cp .env.example .env
npm ci --ignore-scripts
npm --prefix mcp ci --ignore-scripts
npm run dev
```

Pinning and intent writes accept only the origins listed in [`src/firstParty.ts`](src/firstParty.ts).
The home page, `/api`, `/mcp`, `/ipfs/*` and `/v1/rpc/:chainId` are public.

## Connect an assistant through MCP

Point a Streamable HTTP MCP client at:

```json
{
  "mcpServers": {
    "juicebox": { "url": "https://juicebox.center/mcp" }
  }
}
```

No API key is needed. The server has 66 V6 tools for reads, quotes, metadata pinning, project intents
and unsigned transaction plans. It signs nothing. See the [user journeys](mcp/docs/USER_JOURNEYS.md)
and the [tool catalog](mcp/docs/TOOLS.md).

## Pin and read IPFS content

Approved browser origins pin through these routes. Agents and scripts pin through MCP.

```http
POST /v1/pins/json   Content-Type: application/json       # 2 MiB
POST /v1/pins/file   Content-Type: multipart/form-data     # image, 25 MiB
POST /v1/pins/media  Content-Type: multipart/form-data     # media/video, 500 MiB
```

Multipart requests use a field named `file`. An upload must finish within five minutes.
Pinned content is public and can be permanent.

```json
{
  "cid": "Qm...",
  "status": "queued",
  "uri": "ipfs://Qm...",
  "gatewayUrl": "/ipfs/Qm..."
}
```

`queued` means Filebase holds the bytes and Pinata has queued a second pin of the same CID.

Reads are public:

```http
GET /ipfs/:cid[/safe/path]
HEAD /ipfs/:cid[/safe/path]
```

Responses are capped at 500 MiB, cached for a year and served cross-origin. Executable or navigable
content is forced to download. Pin writes are limited to ten per caller and 200 per site every ten
minutes.

## Read Ethereum RPC

Any browser can use Center as a provider-neutral, credential-hiding
JSON-RPC endpoint:

```http
POST /v1/rpc/:chainId
Content-Type: application/json
```

One request at a time, read methods only. Sending, signing, wallet, debug, trace, admin and txpool
methods are rejected. Log queries need a block hash, a `latest` poll or a range of at most 50,000
blocks. Requests are capped at 256 KiB and responses at 5 MiB.

First-party origins get 600 requests per minute. Every other caller is served without a key at 120
per minute per IP.

## Use Safe's transaction service

Trusted browser sites use `/v1/safe/:prefix/api/v1/...` for Safe queue reads, signed proposals,
confirmations, owner discovery and Safe creation records. Prefixes are `eth`, `oeth`, `base`,
`arb1`, `sep` and `basesep`. The server adds its `SAFE_API_KEY`; clients never receive it and
continue to sign and verify their own transactions. Other Safe API operations are not proxied.

This route uses the existing trusted-origin list, with separate per-caller and shared budgets.
It is unavailable until the server key is configured. Upstream quota errors and reset headers
are returned without retrying. See [configuration](docs/rest/PRODUCTION_OPERATIONS.md#configuration).

## Edit the directory

Every destination on the home page, `/llms.txt` and `/skill.md` lives in
[`src/directory.ts`](src/directory.ts). Layout lives in [`src/homepage.ts`](src/homepage.ts). Tests
cap row lengths, require secure destinations and keep unfinished tools in their own section. Check
that a destination is live and on V6 before adding it.

## Verify

```sh
npm test
npm run typecheck
npm run build
npm run check
TEST_DATABASE_URL=postgresql://... npm test
```

The full release checks need a disposable PostgreSQL 16 database. See
[production operations](docs/rest/PRODUCTION_OPERATIONS.md#release-checks).
