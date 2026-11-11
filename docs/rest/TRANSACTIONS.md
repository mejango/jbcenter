# Unsigned transaction preparation

Center prepares Juicebox protocol actions. Signa or an external wallet approves, submits and recovers their execution. A Center draft is evidence to review, never permission to spend.

## Prepare

Discover operations through `GET /api/v1/catalog/operations`. A descriptor with `transaction: true` supplies the exact input JSON schema. Send either:

```http
POST /api/v1/plans
Content-Type: application/json

{"operation":"<catalog-operation>","input":{}}
```

or send the operation's input directly to `POST /api/v1/operations/:id/plans`. Replace the placeholder and empty object with the selected operation and valid input. `contract_calls` prepares verified generic ABI calls described in [Contracts](CONTRACTS.md).

Both return `{data: RestPlanDraft}` without storing an account-owned plan. Calls identify exact chains, destinations, calldata, native values and earlier-call dependencies. The draft includes the intended sender, decoded review data, warnings and canonical block evidence. Read errors, unsupported destinations and ambiguous evidence fail explicitly.

For `prepare_pay` only, an optional `at` in `/plans` supplies the exact chain/block evidence to validate and use. Other operations, including `contract_calls`, reject it. It is not an arbitrary timestamp override. Omitting it allows the operation to select current canonical snapshots.

## Review and execute

1. Check the intended action against the draft's sender, project identity, chain, destination, native value, token units and decoded calldata.
2. Pass the exact calls and evidence to Signa or the selected wallet. The receiving service validates them and owns its own review and execution records.
3. Obtain the required wallet approval or use an already installed session that explicitly authorizes those calls within its limits.
4. Follow the submitting service's transaction or operation identifier through confirmation and recovery.

A new quote, changed bytes or changed commitment requires renewed review. A Center response, reference ID or MCP review token does not establish a Signa grant or approval. No endpoint moves a Center account or imports old Center account history.

## Confirmation and recovery

Center REST does not provide saved-plan polling or generic transaction submission. Once a transaction is sent, preserve its original submission identifier and exact bytes with the executing service. A timeout is not evidence that nothing was submitted. Reconcile that operation before considering a replacement.

Transaction inclusion, semantic outcome and cross-chain settlement are separate observations. A successful outer receipt does not prove all expected project effects or remote delivery. SDK/MCP evidence checks and Signa's canonical receipt checks must retain the intended project, event emitter and exact call identity.

The existing [project-intent sponsor](PROJECT_INTENTS.md#request-a-sponsored-deploy) remains a separate bounded deployment flow owned by Center. Its stored deployment queue and sponsored transactions are not general account execution.
