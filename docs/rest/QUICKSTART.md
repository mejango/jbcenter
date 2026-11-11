# Your first request

Center's protocol API is public and bounded. You do not need a Center account, API key or signed HTTP request.

## Discover the API

```sh
curl https://juicebox.center/api/v1/capabilities
curl https://juicebox.center/api/v1/catalog/operations
```

Read the [endpoint reference](/api) or [OpenAPI document](/api/v1/openapi.json) for exact operation input schemas and limits.

## Read a project

Choose the source explicitly:

```sh
curl 'https://juicebox.center/api/v1/projects/8453/1?source=onchain'
```

Use `source=bendystraw` for indexed history and discovery. An unavailable source is an error; Center does not silently fall back. IDs and amounts remain exact decimal strings.

## Prepare an action

Choose an operation from `/api/v1/catalog/operations` whose `transaction` field is true. Supply the exact schema advertised for that operation:

```js
const response = await fetch('https://juicebox.center/api/v1/plans', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ operation, input }),
});
const result = await response.json();
if (!response.ok) throw new Error(result.code ?? 'Preparation failed');
const draft = result.data;
```

`operation` and `input` above are your selected catalog operation and its validated input. The result is an unsigned `RestPlanDraft`, not a saved plan or a wallet approval. Preparation submits no transaction.

Review sender, chain, destination, calldata, value, dependencies and evidence. Use [Signa](https://signa.center) or your wallet for approval and execution. Signa owns its own reviewed plan and recovery state; there is no Center plan ID to import as authorization.

## Failure handling

Rate limits and unavailable upstreams are explicit failures. Respect `Retry-After` when present. Repeating a preparation can return new block evidence or a different quote; review the new draft. After execution begins, recover through the service that submitted it rather than preparing and sending a replacement automatically.

Continue with [transaction preparation](TRANSACTIONS.md), [contract reads](CONTRACTS.md), [indexed reads](INDEXER.md) or [agent integration](AI_GUIDE.md). Signed project publication is a separate [intent flow](PROJECT_INTENTS.md).
