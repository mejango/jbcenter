# Read services: maintainer notes

How the contract, indexer and omnichain read services work inside Center. API users start with
[contract reads](CONTRACTS.md), [indexed reads](INDEXER.md) and [omnichain projects](OMNICHAIN.md).

## Contract reads

```ts
import { createProtocolReadService } from "../../src/rest/protocol/index.js";

const protocol = createProtocolReadService({ rpc, catalog });
```

### Provenance levels

Every request first checks `eth_chainId` and observes a mined block. All code and contract reads use EIP-1898 `{blockHash, requireCanonical: true}`. Unsupported EIP-1898, archive gaps, RPC errors and reorganized blocks fail; the service never retries using unpinned latest state.

An official deployment is selected from the pinned chain-specific catalog. Its actual runtime code hash is always returned. When the compiler output matches exactly, provenance reports `exact-runtime-template`. When authoritative compiler immutable references are available, every other byte must match and the actual immutable bytes are reported under `compiler-template-with-observed-immutables`. The service does not guess masks, strip compiler metadata, or infer immutable slots from zero bytes.

Some historical official artifacts lack matching compiler immutable references. These official addresses remain available with **`runtimeVerified: false`**, mode `official-address-runtime-observed`, and an explicit `verificationGap`. This establishes published-address provenance and the observed runtime hash; it does **not** establish source-to-runtime equality. Known bytecode mismatches, missing code and unresolved linked-library bindings fail. Consumers requiring source/runtime equality must reject the weaker provenance level.

Dynamic addresses require an exact ERC-1167 or Solady LibClone runtime, an embedded implementation address equal to the official factory getter, and a canonical association, all at the same block. The implementation runtime is compared with its corresponding published/compiler templates. When historical published templates lack matching immutable references, the factory-selected implementation remains available with `runtimeVerified: false`, `verificationLevel: factory-address-provenance`, and an explicit `verificationGap`. The clone, implementation, factory and registry anchor hashes are returned. This proves address provenance and observed associations; it does not prove source/runtime equality. No arbitrary implementation is accepted from a loose bytecode resemblance. Known compiler mismatches fail. Source-only ABI variants require actual runtime equality; ambiguous published ABI variants fail. Arbitrary, upgradeable, nested, or unrecognized proxies are rejected.

| Dynamic family                         | Required canonical association                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| JBERC20                                | JBTokens implementation getter; `projectIdOf` and `tokenOf` agree; clone token authority is JBTokens                        |
| JB721TiersHook                         | Factory implementation and JBAddressRegistry deployer agree; clone reports an existing project                              |
| JBUniswapV4LPSplitHook                 | Factory implementation and JBAddressRegistry deployer agree; no unique represented project is inferred from `feeProjectId`    |
| JB721Checkpoints                       | Factory implementation; verified tiers hook identifies the module through `checkpoints()`                                   |
| DefifaHook                             | Defifa factory implementation and JBAddressRegistry deployer agree; hook reports an existing game project                   |
| Optimism, Base, Arbitrum, CCIP suckers | Factory singleton and `isSucker`; initialized deployer; canonical project sucker registration                               |
| JBProjectPayer                         | Factory implementation and immutable deployer; observable initialized owner/project; referenced project exists when nonzero |

Factory provenance does not claim a tiers/game hook is currently attached, nor that a project's owner endorsed a payer's configuration. Project context checks current controller and directory terminal associations where applicable. Revnet context checks the canonical deployer's registration, owner and selected loans contract. Multiple suckers or payer instances require explicit addresses; no instance is chosen arbitrarily.

### Explicit coverage limits

Reference-only interfaces, abstract contracts, libraries and scripts are not destinations. Missing chain deployments are reported as missing; addresses are never borrowed from another chain. Dynamic custom project tokens, controllers, terminals, unknown clone families, upgradeable proxies, unregistered clones and implementations without an unambiguous published or runtime-verified ABI are unsupported. All cataloged executable methods remain discoverable even when their destination cannot currently be proved.

The generic ABI layer covers configuration and management methods as well as ordinary user actions. It does not turn arbitrary hook metadata, nested calldata arguments, destination addresses inside ABI arguments, or allowance recipients into audited or endorsed operations. Review and simulation must interpret those semantics before external wallets sign.

### Modeled receipt outcomes

Execution owners first establish the exact transaction or authenticated forwarded execution, canonicality and confirmations. Preserve the original prepared project identity and account when interpreting protocol events. Center REST provides unsigned preparation; Signa owns durable execution and receipt reconciliation. MCP and SDK outcome checks do not confer wallet authority.

Modeled outcomes map to `verified` or `unknown`. Partial payout failures and failed buyback sell delivery remain unknown even when the outer transaction succeeds. Generic catalog calls are explicitly `unmodeled`. Missing, noncanonical, malformed or incomplete logs cannot establish an outcome. Each verifier must retain its documented receipt and response bounds; bounded or missing evidence must not be presented as a complete successful outcome.

## Indexed reads

### Host interface

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

The address above is an illustrative primary key, not a claim of an existing collection. The host supplies public bounded HTTP routing, quota enforcement and cancellation. Every request remains a closed read operation; callers cannot submit arbitrary GraphQL, fragments, directives, aliases, operation names, URLs or headers.

`network` is mandatory. Supported mainnet chains are Ethereum, Optimism, Base and Arbitrum; corresponding Sepolia chains use `testnet`. An absent configured network returns `INDEXER_NOT_CONFIGURED`. Explicit chain/network conflicts are rejected. An entity without a chain or project column cannot accept that scope: a cross-chain sucker-group aggregate is never relabeled as one chain's balance.

`projectId` is an exact nonnegative decimal string, including zero for protocol records such as wildcard permissions. The indexer's GraphQL `Int` values retain their signed 32-bit range. Integer primary keys represented by GraphQL `Float` must fit JavaScript's safe integer range. Values outside those ranges are rejected before a request, without rounding. BigInt values remain exact decimal strings; returned project IDs are also decimal strings. Other schema Int fields remain exact JSON numbers.

### Entity and field coverage

`catalog()` supplies every entity, its list field, complete primary-key arguments, all fields and supported filter keys, the fixed limits, source provenance and network configuration booleans. No endpoint or credential is exposed.

- Projects, groups, participants, payer records, permission holders, loans and their versioned snapshots are available directly.
- NFT collections, tiers and tokens retain their chain/project/version identities. NFT `hook` is an object relation, not an address scalar. The service selects and verifies its address and full V6 identity even when callers omit it from requested fields. Missing hook relations fail explicitly; a tier relation must agree with the NFT's tier and collection.
- Buyback pools, positions, ranges, swaps and liquidity events are available directly.
- Suckers, bridge transactions, roots and bridge/accounting events are available directly.
- Every event entity is independently accessible, including `buybackPoolLiquidityEvent` and `storeAutoIssuanceAmountEvent`, which do not appear in the activity wrapper. Activity wrappers are not claimed to represent the entire event schema.
- All scalar columns can be selected, including bounded JSON metadata and SVG. JSON/SVG are omitted from the default selection; requested content remains untrusted reference data and is never interpreted as instructions.
- Singular V6 entity relations support dotted scalar paths with at most two relation levels. Version and identity fields are added automatically at each selected relation. Nested collection pages are explicitly unsupported; list the related entity independently with its full scope and pagination. This keeps query cost predictable and gives every collection its own continuation cursor. Global wallet relations remain unsupported.

Single reads accept the primary keys declared in the catalog. `chainId` and `projectId` may be supplied at the top level, and version is fixed at 6. Supply a scalar `id` string when only one primary-key component remains; use an `id` object for composite keys. This covers keys such as pool/tick ranges, NFT hook/token pairs, historical block snapshots and sucker/token/index tuples. Versionless primary keys do not bypass isolation: every returned row and selected relation is checked for V6 and requested chain/project identity, and returned primary keys must match.

### Bounds, filtering and pagination

List pages accept 1 to 50 rows, defaulting to 20. `fields` accepts at most 48 unique paths; the final selection, including mandatory identities, has at most 96 nodes. Defaults select up to 32 ordinary scalar columns plus required identities. Each string response value is limited to 32 KiB, scalar arrays to 256 elements, and a whole response to 2 MiB. Oversized source content fails explicitly rather than being silently truncated.

Filters use only names and scalar types generated from the pinned entity filter schema. Logical `AND`/`OR` arrays have at most 20 children, depth at most three, and at most 40 filter nodes overall. User filters are placed inside an outer immutable conjunction that enforces V6, the selected network's chains and any requested chain/project. Version filter overrides are rejected. Ordering is limited to known non-JSON scalar columns and `asc`/`desc`.

Use the returned opaque `nextCursor` as the next request's `cursor`, retaining entity, network, filters and ordering. The maximum cursor is 4 KiB. Counts and page metadata come from the version-scoped indexer query; invalid counts, malformed page info, oversized pages and absent/nonadvancing continuation cursors are rejected. Pagination traverses mutable indexed state and does not promise a consistent database snapshot across calls.

Requests have a 15-second deadline and propagate host cancellation. The default transport bounds response bytes while streaming, rejects redirects, validates UTF-8 and JSON, and closes incomplete bodies. Even injected fetchers receive the fixed bounds and are raced against cancellation. Upstream exception messages, URLs, credentials, response bodies and GraphQL error text never become public errors. Any GraphQL error invalidates the whole response, including otherwise usable partial data. Unknown data is never converted into zero or an empty success.

### Source contract and updates

The generator reads the complete pinned fixture at `mcp/tests/adapters/fixtures/bendystraw-v6.graphql` and its adjacent provenance file. It checks the exact fixture SHA-256, exhaustively records object fields, filter inputs, enums and root arguments, and rejects unexpected new roots or loss of V6 scope. The source revision records a baseline commit plus the exact working-tree source digest; the digest, rather than a falsely clean commit claim, identifies the source used to generate the fixture.

```sh
node scripts/rest/generate-indexer.mjs --check
node scripts/rest/generate-indexer.mjs
```

Regenerate deliberately after reviewing an updated source schema and fixture provenance. Runtime imports the generated metadata and does not parse source files, traverse a workspace or introspect an upstream endpoint. Schema-only tests validate generated queries against the actual pinned GraphQL schema and exercise version isolation, relation identity, exact integers, filtering, error handling, pagination and transport limits.

Indexer progress is a separate `_meta.status` read. It reports per-chain indexed block numbers and timestamps as available, with `snapshotPinned: false`; it does not establish a block hash or retroactively pin another response.

## Omnichain views

The HTTP host mounts `GET /projects/:chainId/:projectId/omnichain?source=onchain` or `source=bendystraw` beneath its REST prefix. `maxMembers` is bounded to 1–8. The caller does not supply an upstream URL, peer address, alternate source or GraphQL document.

```ts
const group = await omnichain.getProjectGroup(
  { chainId: 8453, projectId: "1", version: 6 },
  { source: "onchain", maxMembers: 8 },
  requestSignal,
);
```

The host injects `operations.execute('get_project' | 'get_bridges', { project }, { source: 'onchain', signal })` and the bounded V6 indexer service. The operations adapter returns the direct project/bridge data shape. Its onchain operations must not fetch indexed metadata. Bendystraw requests use the indexer dependency exclusively; neither source silently substitutes for the other.

### Onchain membership and accounting

Traversal uses the existing bridge reader's registered sucker list. A peer is followed only when its local project identity, peer address, peer chain, remote project ID and reciprocal registry membership are known and agree. Remote project IDs are read on their own chains rather than copied from the root ID. Registry membership and reciprocity establish linkage; they do not attest equivalent peer bytecode.

Breadth-first traversal processes each identity once. Cycles are ordinary membership relationships and do not trigger repeated reads. There are at most eight member reads and 32 registered bridges per member. A different project ID proposed for an already assigned chain is an explicit linkage conflict. Unsupported or contradictory network-class identities are rejected.

Unknown peers remain visible as unverified links and are not expanded. Unavailable member reads retain an unknown status. An explicit member cap stops expansion and marks coverage incomplete; it does not imply that the omitted peers are absent. There is no indexer fallback.

Each member retains its own owner/controller observations, token/supply state, terminal accounting contexts and read evidence. Token addresses, decimals, accounting currencies, balances and unknown values remain attached to their chain and terminal. The view does not construct a combined token supply, combined spendable balance or cross-chain asset valuation. Bridge accounting gossip remains last-received remote accounting and is never added to local balances.

Project reads and bridge reads may use different blocks. Remote chains have their own evidence. The response preserves those distinctions and never claims a simultaneous snapshot across chains.

### Bendystraw group discovery

The service reads the scoped V6 project and its `suckerGroup` relation, verifies that both agree on group ID and version, then lists a bounded page of V6 projects in that group. Every returned member must match the group and network, and same-chain project conflicts are rejected.

This is indexed group discovery, with `linkageVerified: false`; it does not establish reciprocal contract linkage. A missing root/group or unavailable discovery source fails explicitly. Movement-page outages can remain unknown within an otherwise known group. Page truncation marks membership coverage incomplete and preserves the indexer's continuation cursor.

Each chain's indexed project balance, USD estimate, decimals and currency are preserved separately. The issued project token is displayed separately from balance accounting: its address is not presumed to identify the asset counted by the indexed aggregate. Missing decimals or currency remain unknown. Cost basis and historical or aggregate indexed values are not spendable balances.

### Bridge movement lifecycle

Bendystraw mode returns three independent pages, at most ten rows each per member: `suckerTransaction`, `bridgeToOutboxEvent`, and `bridgeClaimEvent`. Each page preserves its own continuation and unknown state. Source insertions are associated only through the source chain/project, sucker, token and index tuple. Conflicting insertion hashes fail explicitly. Missing matching events in a bounded page do not prove that no insertion or claim occurred.

The movement mapping keeps these stages separate:

| Stage                  | Evidence represented                                                   | What remains unproved                                           |
| ---------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| Source transaction     | Indexed source insertion hash, when a matching event exists            | Canonical source receipt and confirmations                      |
| Pending transport      | Indexer `pending` indication                                           | Root delivery and destination acceptance                        |
| Claimable              | Indexer `claimable` indication                                         | A valid current proof and successful onchain claim preflight    |
| Claim confirmation     | Indexer `claimed` indication and separate destination claim-event page | Canonical destination receipt and confirmations                 |
| Terminal credit        | Explicitly unknown in this wrapper                                     | Correct terminal credit, including deferred/manual credit paths |
| Cross-chain settlement | Explicitly unverified                                                  | Complete source-to-destination operation evidence               |

An indexed `claimed` value always has `canonicalReceiptVerified: false`. A successful source receipt is never promoted to destination delivery or cross-chain settlement. Destination claim events are not automatically joined across remote token mappings or interpreted as confirmation; they remain independent evidence for a subsequent exact chain/sucker/token/index/beneficiary and canonical-receipt check.

Onchain mode does not scan arbitrary bridge history. The existing bridge reader requires an explicit bounded block range for source outbox insertions; this group wrapper requests membership/accounting reads only. Its lifecycle fields therefore preserve unknown source-history, destination-proof, claim-receipt and terminal-credit status. Call the focused bridge and transaction-verification operations for those subsequent steps.

### Operational limits

The whole group operation has a 60-second deadline, propagates cancellation to every dependency, and caps output at 2 MiB. Initial source failures are sanitized and never expose private endpoint URLs or provider exception text. Each selected source also retains its own response, query and RPC budgets. The machine-readable `completeScope: "membership-discovery"` and `movementHistoryComplete: false` flags distinguish membership coverage from bridge history. A group result with complete membership does not imply successful claims, complete asset coverage or synchronized balances.
