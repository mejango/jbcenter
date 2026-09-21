# V6 indexed reads

An **indexer** organizes blockchain records for search and history. Center reads from Bendystraw's pinned V6 data format: 56 cataloged record types, 55 supported list/single-record pairs, and indexing progress through `_meta`. The unversioned `wallet` aggregate is unsupported. Its lifetime volume and history cannot be presented as V6 holdings; use versioned participants, NFTs, loans and permission holders instead. See the [glossary](https://juicebox.center/api#glossary).

Indexed data can lag. It does not quote a payment, calculate spendable balances, verify current ownership, fix a response to one chain block, or fetch descriptive project files (**metadata**). Cost basis, contributed volume, historical snapshots, group totals, token units and indexed USD fields retain their source meanings. Read current contracts before relying on balances, permissions, loan capacity, or preparing transactions.

## Host interface

```ts
import { createIndexerReadService } from "./src/rest/indexer/index.js";

const mainnetUrl = process.env.MCP_BENDYSTRAW_MAINNET_URL;
const testnetUrl = process.env.MCP_BENDYSTRAW_TESTNET_URL;
const indexer = createIndexerReadService({
  ...(mainnetUrl ? { mainnetUrl } : {}),
  ...(testnetUrl ? { testnetUrl } : {}),
  // Optional operator-owned `headers`, per-network `networkHeaders`, and
  // injectable bounded `fetchJson`. Request parameters cannot set any of these.
});

indexer.catalog();
await indexer.list(
  "project",
  {
    network: "mainnet",
    chainId: 8453,
    limit: 10,
    filters: { name_contains_nocase: "juice" },
    fields: ["name", "owner", "balance", "balanceUsd"],
    orderBy: { field: "createdAt", direction: "desc" },
  },
  signal,
);

await indexer.read(
  "project",
  {
    network: "mainnet",
    chainId: 8453,
    projectId: "1",
    fields: ["name", "tokenSupply", "reservedTokenSupply"],
  },
  signal,
);

await indexer.read(
  "nft",
  {
    network: "mainnet",
    chainId: 8453,
    id: { hook: "0x0000000000000000000000000000000000000001", tokenId: "2" },
    fields: ["owner", "tierId", "hook.address", "tier.price"],
  },
  signal,
);

await indexer.status({ network: "mainnet" }, signal);
```

The address above is an illustrative primary key, not a claim of an existing collection. The host supplies authenticated HTTP routing, quota enforcement and cancellation. Every request remains a closed read operation; callers cannot submit arbitrary GraphQL, fragments, directives, aliases, operation names, URLs or headers.

`network` is mandatory. Supported mainnet chains are Ethereum, Optimism, Base and Arbitrum; corresponding Sepolia chains use `testnet`. An absent configured network returns `INDEXER_NOT_CONFIGURED`. Explicit chain/network conflicts are rejected. An entity without a chain or project column cannot accept that scope: a cross-chain sucker-group aggregate is never relabeled as one chain's balance.

`projectId` is an exact nonnegative decimal string, including zero for protocol records such as wildcard permissions. The indexer's GraphQL `Int` values retain their signed 32-bit range. Integer primary keys represented by GraphQL `Float` must fit JavaScript's safe integer range. Values outside those ranges are rejected before a request, without rounding. BigInt values remain exact decimal strings; returned project IDs are also decimal strings. Other schema Int fields remain exact JSON numbers.

## Entity and field coverage

`catalog()` supplies every entity, its list field, complete primary-key arguments, all fields and supported filter keys, the fixed limits, source provenance and network configuration booleans. No endpoint or credential is exposed.

- Projects, groups, participants, payer records, permission holders, loans and their versioned snapshots are available directly.
- NFT collections, tiers and tokens retain their chain/project/version identities. NFT `hook` is an object relation, not an address scalar. The service selects and verifies its address and full V6 identity even when callers omit it from requested fields. Missing hook relations fail explicitly; a tier relation must agree with the NFT's tier and collection.
- Buyback pools, positions, ranges, swaps and liquidity events are available directly.
- Suckers, bridge transactions, roots and bridge/accounting events are available directly.
- Every event entity is independently accessible, including `buybackPoolLiquidityEvent` and `storeAutoIssuanceAmountEvent`, which do not appear in the activity wrapper. Activity wrappers are not claimed to represent the entire event schema.
- All scalar columns can be selected, including bounded JSON metadata and SVG. JSON/SVG are omitted from the default selection; requested content remains untrusted reference data and is never interpreted as instructions.
- Singular V6 entity relations support dotted scalar paths with at most two relation levels. Version and identity fields are added automatically at each selected relation. Nested collection pages are explicitly unsupported; list the related entity independently with its full scope and pagination. This keeps query cost predictable and gives every collection its own continuation cursor. Global wallet relations remain unsupported.

Single reads accept the primary keys declared in the catalog. `chainId` and `projectId` may be supplied at the top level, and version is fixed at 6. Supply a scalar `id` string when only one primary-key component remains; use an `id` object for composite keys. This covers keys such as pool/tick ranges, NFT hook/token pairs, historical block snapshots and sucker/token/index tuples. Versionless primary keys do not bypass isolation: every returned row and selected relation is checked for V6 and requested chain/project identity, and returned primary keys must match.

## Bounds, filtering and pagination

List pages accept 1–50 rows, defaulting to 20. `fields` accepts at most 48 unique paths; the final selection, including mandatory identities, has at most 96 nodes. Defaults select up to 32 ordinary scalar columns plus required identities. Each string response value is limited to 32 KiB, scalar arrays to 256 elements, and a whole response to 2 MiB. Oversized source content fails explicitly rather than being silently truncated.

Filters use only names and scalar types generated from the pinned entity filter schema. Logical `AND`/`OR` arrays have at most 20 children, depth at most three, and at most 40 filter nodes overall. User filters are placed inside an outer immutable conjunction that enforces V6, the selected network's chains and any requested chain/project. Version filter overrides are rejected. Ordering is limited to known non-JSON scalar columns and `asc`/`desc`.

Use the returned opaque `nextCursor` as the next request's `cursor`, retaining entity, network, filters and ordering. The maximum cursor is 4 KiB. Counts and page metadata come from the version-scoped indexer query; invalid counts, malformed page info, oversized pages and absent/nonadvancing continuation cursors are rejected. Pagination traverses mutable indexed state and does not promise a consistent database snapshot across calls.

Requests have a 15-second deadline and propagate host cancellation. The default transport bounds response bytes while streaming, rejects redirects, validates UTF-8 and JSON, and closes incomplete bodies. Even injected fetchers receive the fixed bounds and are raced against cancellation. Upstream exception messages, URLs, credentials, response bodies and GraphQL error text never become public errors. Any GraphQL error invalidates the whole response, including otherwise usable partial data. Unknown data is never converted into zero or an empty success.

## Source contract and updates

The generator reads the complete pinned fixture at `mcp/tests/adapters/fixtures/bendystraw-v6.graphql` and its adjacent provenance file. It checks the exact fixture SHA-256, exhaustively records object fields, filter inputs, enums and root arguments, and rejects unexpected new roots or loss of V6 scope. The source revision records a baseline commit plus the exact working-tree source digest; the digest, rather than a falsely clean commit claim, identifies the source used to generate the fixture.

```sh
node scripts/rest/generate-indexer.mjs --check
node scripts/rest/generate-indexer.mjs
```

Regenerate deliberately after reviewing an updated source schema and fixture provenance. Runtime imports the generated metadata and does not parse source files, traverse a workspace or introspect an upstream endpoint. Schema-only tests validate generated queries against the actual pinned GraphQL schema and exercise version isolation, relation identity, exact integers, filtering, error handling, pagination and transport limits.

Indexer progress is a separate `_meta.status` read. It reports per-chain indexed block numbers and timestamps as available, with `snapshotPinned: false`; it does not establish a block hash or retroactively pin another response.
