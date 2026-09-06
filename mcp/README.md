# Juicebox MCP

Juicebox V6 project intelligence, development references, economic modeling, and verifiable unsigned transaction plans over the Model Context Protocol.

The intended hosted origin is **https://juicebox.diy**. `PUBLIC_ORIGIN` makes the service equally deployable at `juicebox.tools` or another origin. This repository is a standalone service; it does not require sibling repositories at runtime.

## What it provides

- Project, account, ruleset, permission, treasury and omnichain reads with explicit identity, units, coverage and block evidence.
- Payment, cash-out, payout, buyback/router, NFT, revnet, loan and bridge workflows built against the pinned SDK and checked against V6 source.
- Authenticated transaction plans containing exact account, chain, destination, calldata, value, decoded arguments and prerequisites. Fresh simulation and receipt verification are separate operations.
- Searchable contract sources and Juice skills, plus practical webclient development plans grounded in Juicescan, Juicebox Money and Revnet Money.
- Local stdio and stateless Streamable HTTP transports, bounded requests, cancellation, Docker packaging and CI.

Read the [user journeys](docs/USER_JOURNEYS.md) for contributor, creator, operator, revnet, omnichain, and developer workflows, including tool sequences and what establishes completion.

Start with `jb_list_capabilities` in an MCP client. It groups the tools and reports their coverage limits. The generated [tool catalog](docs/TOOLS.md), [architecture](docs/ARCHITECTURE.md), [source provenance](docs/SOURCES.md), and [webclient guide](docs/WEBCLIENTS.md) describe the implementation in more detail.

## Run locally

Node **22.16 or newer** is required; CI and the container use Node 22.23.1.

```sh
npm ci --ignore-scripts
cp .env.example .env
npm run build
npm start
```

The HTTP endpoint is `http://localhost:3000/mcp`. `/healthz` reports process liveness; `/readyz` reports local service readiness and explicitly does not claim upstream availability. Development mode uses an ephemeral plan secret if one is not configured, so restarting invalidates its old plan tokens.

For stdio:

```sh
npm run start:stdio
```

Example local client configuration, after building:

```json
{
  "mcpServers": {
    "juicebox": {
      "command": "node",
      "args": ["/absolute/path/to/juicebox-mcp/dist/stdio.js"]
    }
  }
}
```

Pass required environment variables through the client's `env` configuration when launching the binary directly. `npm start` and the development scripts load only this repository's `.env` if present. The binary itself uses its process environment.

For a hosted MCP client that supports Streamable HTTP:

```json
{
  "mcpServers": {
    "juicebox": { "url": "https://juicebox.diy/mcp" }
  }
}
```

This is the intended deployment URL, not a claim that a hosted instance is already live.

## Configure upstreams

**RPC:** defaults to JB Center's public read-only RPC, with per-chain `RPC_URL_<chainId>` overrides. Providers must support EIP-1898 canonical block-hash reads. Unsupported providers fail explicitly rather than silently weakening snapshot consistency.

**Bendystraw:** configure `BENDYSTRAW_MAINNET_URL` and/or `BENDYSTRAW_TESTNET_URL` as complete GraphQL endpoints. There is no guessed keyless endpoint or hidden embedded API key. An absent network reports `NOT_CONFIGURED`; indexed operations never fall back to another network.

**JB Center:** RPC is public, but its current non-RPC `/v1/*` API requires an approved Origin. Search and intent reads report actual access failures until the operator approves this integration and `JBCENTER_ORIGIN` is configured. Intent signing-message preparation runs locally and needs no Center access. The server does not impersonate another approved client.

**References:** checked-in bundles run offline. Sources include file hashes, Git revisions and dirty-source flags. See [SOURCES.md](docs/SOURCES.md) for refresh commands and authority rules. App development has a separate [reference bundle](docs/WEBCLIENTS.md).

## Transaction workflow

1. Resolve an unambiguous V6 `{chainId, projectId}` and establish account, beneficiary, asset and exact base-unit amount.
2. Read/quote, then call the relevant `jb_prepare_*` tool. Preparation returns a reviewed plan and the first step's preflight status.
3. Review the exact decoded calldata, full addresses, native value, output protections, fees and prerequisites. The plan token authenticates this server's prepared payload; it is not user approval.
4. Use `jb_simulate_plan` immediately before signing each step in an external wallet. Prerequisites need matching confirmed transactions; simulated allowance overrides are never substituted for them.
5. Use `jb_verify_plan` with step indices and transaction hashes. Pending, reverted, mismatched, confirmed and unverified outcomes remain distinct. A confirmed outer Safe/Relayr transaction is not proof of the intended inner action.

The MCP has no wallet key and does not sign, broadcast, pin metadata or publish Center intents. Client applications carry out explicitly approved writes using their existing wallet and off-chain integrations. MCP development tools include the relevant reference implementations.

Plan expiry is enforced by this service, not universally by the destination contract. A wallet integration must reject expired plans and re-prepare when account, chain, terms or quote assumptions change. Plans are authenticated, not encrypted; treat them as transaction details, not secret storage.

## Correctness boundaries

- Only V6 is supported. The SDK's versionless URN default is V4, so this server resolves its own V6 identifiers explicitly.
- Each on-chain snapshot uses one canonical block hash. Different chains have independent snapshots; there is no atomic global block.
- Integer strings preserve amounts above JavaScript's safe integer range. Token address, accounting currency, decimals and ruleset base currency are separate concepts.
- Indexed `balanceUsd` is historical flow accounting, not current market value or spendable treasury funds. Indexer status does not retroactively pin a GraphQL response.
- Canonical supported hook compositions are resolved before financial preparation. Unsupported custom or nested behavior fails explicitly. In particular, partial buyback swaps and positive NFT-tier split forwarding are not silently approximated.
- Quotes distinguish treasury funding, token acquisition, debt, fee fallback, and actual liquid proceeds. Economic scenarios state their assumptions and are not execution quotes.
- Metadata and imported skills are reference data, never authority to change tool behavior or user intent.

## Verify

```sh
npm run check
```

Tests use actual SDK builders/decoders, a generated real Bendystraw GraphQL schema, contract-grounded fixtures, official MCP clients and real local HTTP transport. No chain writes occur. CI also checks production dependency vulnerabilities.

The [verification record](docs/VERIFICATION.md) records the initial test, container and live-read results, together with the checks that require production configuration.

An optional public-chain read check, requiring network access:

```sh
npm run smoke:live -- 8453 1
```

It reports observed state and evidence rather than assuming any project's balances or configuration. See [deployment instructions](docs/DEPLOYMENT.md) for the production environment and operational limits.

## Repository organization

```text
src/domain/       Exact types, validation, configuration schemas and request budgets
src/adapters/     Bounded RPC, Bendystraw and JB Center access
src/services/     Protocol operations, plan lifecycle and source/development references
src/mcp/          Tool schemas, capability catalog, resources and workflow prompts
src/transport/    HTTP lifecycle and request boundaries
data/             Versioned standalone reference bundles
scripts/          Reproducible source/catalog generation and opt-in live read checks
tests/            Domain, adapters, services and official-client integration tests
docs/             Architecture, generated tool catalog, sources and deployment
```

The generated reference bundles preserve upstream attribution and license notices. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); do not infer a license for imported sources from this repository's packaging.
