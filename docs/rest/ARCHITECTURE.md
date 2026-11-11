# Center protocol service

Center serves Juicebox V6 protocol reads, contract and operation catalogs, unsigned transaction preparation, project intents, IPFS and read-only RPC. Signa owns account identity, passkeys, app and bot grants, approvals, wallet execution and recovery at [signa.center](https://signa.center) and [api.signa.center](https://api.signa.center/api).

## Owners and boundaries

| Owner | Responsibilities |
| --- | --- |
| SDK | Reusable protocol math, ABI encoding/decoding, transaction builders and supported evidence checks |
| Center | Hosted protocol data and preparation, catalogs, MCP, signed project intents and publication |
| Signa | Account authorization, durable reviewed plans, submission and recovery |
| Blockchain | Canonical state, transaction inclusion and contract-enforced permissions |

Center has no account enrollment, grants, sessions, wallet approval UI or account transaction relay. Existing Center account history is not migrated. The separation does not delete live databases or rewrite chain history.

## Runtime

The REST runtime constructs the pinned contract catalog, bounded RPC adapter, protocol reader, indexer, omnichain reader and shared protocol operation registry. REST and MCP use those operations through their own transports. Callers cannot supply arbitrary upstream URLs, GraphQL, ABIs or RPC write methods.

GET requests read catalog or protocol data. POST `/api/v1/plans` and `/api/v1/operations/:id/plans` prepare unsigned drafts without persistence, account authentication or signing authority. Service quotas, concurrency, deadlines and request/response bounds apply. See [API](API.md) for route contracts and [transactions](TRANSACTIONS.md) for handoff semantics.

The draft identifies sender, chains, destinations, exact calldata, native values, dependencies and block evidence. Signa validates the received calls and obtains its own authorization; a Center response or MCP review token is never a Signa approval. Center does not own Signa's execution journal.

## Evidence

Protocol reads are fixed to canonical block hashes. Bendystraw is an explicitly selected indexed source and may lag. Neither silently substitutes for the other. Catalog provenance distinguishes an observed official runtime from verified source/runtime equality. See [contract evidence](CONTRACTS.md), [indexer semantics](INDEXER.md) and [omnichain limits](OMNICHAIN.md).

## Retained writes

Project-intent publication remains a separate signed envelope flow, and IPFS publication retains its approved-origin or MCP review requirements. The intent sponsor can execute only the reviewed signed deployment-intent flow under its own funding policy. Removing account execution does not remove that sponsor or broaden its authority. Its original queue, reservations and reconciliation remain owned by Center. See [project intents](PROJECT_INTENTS.md).

PostgreSQL retains intents, deployment records, sponsor state and shared quotas. Center no longer creates new account tables. Previously applied account migrations need no compatibility runtime and no destructive migration is part of this change.
