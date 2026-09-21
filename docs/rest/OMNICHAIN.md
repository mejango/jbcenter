# Omnichain project views

A project can connect its funds across networks; this is called **omnichain**. Start with an exact V6 `(chainId, projectId)` and choose the data source. Center returns the linked projects, each chain's accounting, and evidence of their connection. It does not add incompatible assets together or hide failed reads. See the [glossary](https://juicebox.center/api#glossary).

The HTTP host mounts `GET /projects/:chainId/:projectId/omnichain?source=onchain` or `source=bendystraw` beneath its REST prefix. `maxMembers` is bounded to 1–8. The caller does not supply an upstream URL, peer address, alternate source or GraphQL document.

```ts
const group = await omnichain.getProjectGroup(
  { chainId: 8453, projectId: "1", version: 6 },
  { source: "onchain", maxMembers: 8 },
  requestSignal,
);
```

The host injects `operations.execute('get_project' | 'get_bridges', { project }, { source: 'onchain', signal })` and the bounded V6 indexer service. The operations adapter returns the direct project/bridge data shape. Its onchain operations must not fetch indexed metadata. Bendystraw requests use the indexer dependency exclusively; neither source silently substitutes for the other.

## Onchain membership and accounting

Traversal uses the existing bridge reader's registered sucker list. A peer is followed only when its local project identity, peer address, peer chain, remote project ID and reciprocal registry membership are known and agree. Remote project IDs are read on their own chains rather than copied from the root ID. Registry membership and reciprocity establish linkage; they do not attest equivalent peer bytecode.

Breadth-first traversal processes each identity once. Cycles are ordinary membership relationships and do not trigger repeated reads. There are at most eight member reads and 32 registered bridges per member. A different project ID proposed for an already assigned chain is an explicit linkage conflict. Unsupported or contradictory network-class identities are rejected.

Unknown peers remain visible as unverified links and are not expanded. Unavailable member reads retain an unknown status. An explicit member cap stops expansion and marks coverage incomplete; it does not imply that the omitted peers are absent. There is no indexer fallback.

Each member retains its own owner/controller observations, token/supply state, terminal accounting contexts and read evidence. Token addresses, decimals, accounting currencies, balances and unknown values remain attached to their chain and terminal. The view does not construct a combined token supply, combined spendable balance or cross-chain asset valuation. Bridge accounting gossip remains last-received remote accounting and is never added to local treasury balances.

Project reads and bridge reads may use different blocks. Remote chains have their own evidence. The response preserves those distinctions and never claims a simultaneous snapshot across chains.

## Bendystraw group discovery

The service reads the scoped V6 project and its `suckerGroup` relation, verifies that both agree on group ID and version, then lists a bounded page of V6 projects in that group. Every returned member must match the group and network, and same-chain project conflicts are rejected.

This is indexed group discovery, with `linkageVerified: false`; it does not establish reciprocal contract linkage. A missing root/group or unavailable discovery source fails explicitly. Movement-page outages can remain unknown within an otherwise known group. Page truncation marks membership coverage incomplete and preserves the indexer's continuation cursor.

Each chain's indexed project balance, USD estimate, decimals and currency are preserved separately. The issued project token is displayed separately from treasury accounting: its address is not presumed to identify the asset counted by the indexed aggregate. Missing decimals or currency remain unknown. Cost basis and historical or aggregate indexed values are not spendable balances.

## Bridge movement lifecycle

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

## Operational limits

The whole group operation has a 60-second deadline, propagates cancellation to every dependency, and caps output at 2 MiB. Initial source failures are sanitized and never expose private endpoint URLs or provider exception text. Each selected source also retains its own response, query and RPC budgets. The machine-readable `completeScope: "membership-discovery"` and `movementHistoryComplete: false` flags distinguish membership coverage from bridge history. A group result with complete membership does not imply successful claims, complete asset coverage or synchronized balances.
