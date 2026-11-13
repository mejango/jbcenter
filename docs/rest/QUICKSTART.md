# Quickstart

Juicebox Center's REST API needs no account, API key or signed request.

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

`operation` and `input` are the catalog operation and its input. The result is an unsigned `RestPlanDraft`. Center does not save it and submits nothing.

Review the sender, chain, destination, calldata, value and dependencies, then approve and send with [Signa](https://signa.center) or your wallet.

## Failure handling

Rate limits and unavailable upstreams fail explicitly. Honor `Retry-After`. Preparing again can return new blocks or a different quote, so review the new draft. Once a transaction is sent, recover through the service that sent it. Do not prepare and send a replacement.

Next: [transactions](TRANSACTIONS.md), [contract reads](CONTRACTS.md), [indexed reads](INDEXER.md), [project intents](PROJECT_INTENTS.md) or the [agent guide](AI_GUIDE.md).
