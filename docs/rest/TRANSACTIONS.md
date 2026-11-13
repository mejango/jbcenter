# Transactions

Center prepares unsigned transactions. [Signa](https://signa.center) or your wallet approves, sends and recovers them. A draft approves nothing.

## Prepare

List operations with `GET /api/v1/catalog/operations`. Each one marked `transaction: true` carries its input JSON schema. Send either:

```http
POST /api/v1/plans
Content-Type: application/json

{"operation":"<catalog-operation>","input":{}}
```

or the input alone to `POST /api/v1/operations/:id/plans`. `contract_calls` prepares calls to any cataloged contract, described in [contract reads](CONTRACTS.md).

Both return `{data: RestPlanDraft}`, which Center does not save. Each call names its chain, destination, calldata, native value and the earlier calls it depends on. The draft also carries the intended sender, decoded review data, warnings and the blocks it was read at. A failed read or unsupported destination fails the request.

`prepare_pay` accepts an optional `at` in `/plans` to pin the chain and block to read at. Other operations reject it. Without it, Center reads the current block.

## Review and send

1. Check the draft's sender, project, chain, destination, native value, token units and decoded calldata against what you meant to do.
2. Pass the calls unchanged to Signa or your wallet, and approve there.
3. Follow the transaction or operation identifier it returns through confirmation.

A new quote or any changed bytes needs a new review.

## Confirmation and recovery

Center does not send transactions or track them. Once one is sent, keep its identifier and exact bytes with the service that sent it. A timeout does not mean nothing was sent: reconcile the original before sending a replacement, or you can pay twice.

Inclusion, the expected project effect and cross-chain delivery are three separate checks. A successful receipt proves only the first. Confirm the effect from the expected contract's events for your project, and delivery on the receiving chain.

The one exception is [sponsored project deploys](PROJECT_INTENTS.md#sponsored-deploy), which Center sends itself.
