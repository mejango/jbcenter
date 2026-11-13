# API guide

Base URL: `https://juicebox.center/api/v1`. [OpenAPI](/api/v1/openapi.json) is the endpoint reference, generated from the routes. No account, key or request signature is needed.

## Routes

| Method | Path below `/api/v1` | Purpose |
| --- | --- | --- |
| GET | `/` | Service entry points |
| GET | `/capabilities` | Protocol sources, supported chains and limits |
| GET | `/openapi.json` | Machine-readable API contract |
| GET | `/catalog/contracts` | Paginated contract inventory |
| GET | `/catalog/contract?id=...` | Exact contract ABI variants and deployments |
| GET | `/catalog/method?contractId=...&signature=...` | Method input/output schemas; optional exact ABI hash |
| GET | `/catalog/indexer` | Supported indexed entities, filters and fields |
| GET | `/catalog/operations` | Read and preparation operations with input schemas |
| GET | `/catalog/operations/:id` | One operation descriptor |
| GET | `/protocol/resolve` | Resolve and verify a protocol target |
| GET | `/protocol/read` | Read a cataloged view or pure function |
| GET | `/indexer/status` | Indexing progress for the selected network |
| GET | `/indexer/:entity` | Bounded indexed collection |
| GET | `/indexer/:entity/record` | Exact indexed record |
| GET | `/projects/:chainId/:projectId` | Project view from explicit `source` |
| GET | `/projects/:chainId/:projectId/omnichain` | Bounded linked-project view |
| GET | `/operations/:id` | Cataloged read/local preparation |
| POST | `/operations/:id/plans` | Unsigned draft from an operation's input |
| POST | `/plans` | Unsigned draft from `{operation,input,at?}` |

There are no Center account, bot, wallet, session, user-operation, saved-plan or account transaction-submission routes. Use [Signa's API](https://api.signa.center/api) for account operations.

The operation list returns `{data:{operations}}`; its detail route and other read routes return their direct documented JSON shapes. Preparation returns the draft envelope described below.

## Preparation

`POST /plans` accepts a semantic operation from the catalog, or `contract_calls` for verified ABI calls:

```json
{
  "operation": "contract_calls",
  "input": {
    "account": "0x1111111111111111111111111111111111111111",
    "calls": [{
      "chainId": 1,
      "contractId": "@bananapus/core-v6:src/JBController.sol:JBController",
      "function": "setUriOf(uint256,string)",
      "args": ["7", "ipfs://example"]
    }]
  }
}
```

The address, project and URI are illustrative. Select a real verified target and exact ABI signature from the catalog before execution. See [contract preparation](CONTRACTS.md) for argument rules and provenance limits.

The result is `{ "data": RestPlanDraft }`. A draft contains `operation`, `account`, optional `project`, `calls`, `evidence`, `summary` and `warnings`. It has no persisted ID, execution status or spending authority. Each call carries `chainId`, `to`, `data`, `value`, `label`, `dependsOn` and decoded review data.

Only `prepare_pay` accepts the optional `at` field, which binds preparation to supplied block evidence. Other operations, including `contract_calls`, reject it. Its chain, block number, hash and timestamp must match canonical chain evidence; it cannot override chain state. Use the generated schema for its exact shape. Never assume the same input produces the same quote at a later block.

## Reads and limits

Project views require `source=onchain` or `source=bendystraw`. Input objects in GET requests are serialized once into JSON query values, then URL-encoded. Unsupported, repeated or malformed query fields fail. GET bodies are not supported.

Requests are limited in size, rate, duration and concurrency. `/capabilities` lists the current limits. Reads accept only configured chains, cataloged contracts and bounded indexer queries, not caller-supplied endpoints or arbitrary GraphQL.

Errors carry a machine-readable code. Keep `X-Request-Id` for diagnosis, honor `Retry-After`, and treat an unavailable read as unknown.

Project intents, IPFS pinning and the read-only RPC gateway live under `/v1`, with their own access rules. See [project intents](PROJECT_INTENTS.md).
