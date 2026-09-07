# Wallet accounts and bots

Open `/accounts` on the Center service. Connect an EIP-1193 browser wallet, choose its account and authority chain, and select **Enroll account**. Enrollment signs an API request with an empty JSON body; it does not send an onchain transaction. Existing owners can select **Load account**.

The account identity is `eip155:<authority-chain-id>:<lowercase-owner-address>`. The authority chain is part of the account identity, so switching wallet chains selects another account. The page clears its connection when the wallet account or chain changes. Use the profile form to update the display name, bio, and optional HTTPS/IPFS avatar URI.

Every account read or change asks the wallet to sign a typed request. The browser keeps no private key in localStorage or sessionStorage. It renders user-supplied profile and bot text as text, and does not fetch avatar URLs.

## Create a bot in the browser

1. Choose a label, expiration, and permission profile under **Bots**: **Read**, **Read + plan**, or **Read + plan + relay**. Planning includes reads so the bot can retrieve and review its plans. Relay includes reads and planning because a bot can relay only plans created by that same bot. Wallet transaction signatures remain separate.
2. Select **Generate and download key**. The private key is created locally and downloaded once as a JSON file. The page retains only the public registration proof.
3. Save the file, then select **Register downloaded bot** and approve the owner signature. Save the returned grant ID; it is public and identifies the bot's authorization.
4. Use **Refresh bots** to list grants and **Revoke bot** to withdraw authorization.

The server receives the bot address, scope list, expiration, label, and a signed possession proof. It never receives the bot private key. A bot grant gives API permissions; it does not give access to the owner's funds. Direct relay requires the wallet's transaction signature. Bot dispatch also requires a fresh typed approval from the account owner, because a transaction signature has no signing timestamp. Each transaction signer needs the funds required by that chain.

Browser downloads commonly have mode `0644`. Before using a downloaded key with the CLI, move it to a private directory and set mode `0600`:

```sh
chmod 600 /path/to/juicebox-bot-key.json
```

If registration does not complete, keep the downloaded key. Create a fresh public proof request and use the CLI workflow below. Registration proofs are bound to one owner request nonce, so the page does not automatically reuse a possibly consumed nonce.

## Bring an existing bot key

Build the CLI's shared client once in `extensions/jbcenter` with Node 22 or newer:

```sh
npm run build
node scripts/rest/center.mjs --help
```

Generate a new local key if needed. The destination must not exist; key creation uses exclusive mode `0600` and prints only the public address:

```sh
node scripts/rest/center.mjs keygen --out /private/path/bot-key.json
```

The keyfile format is `juicebox-center-bot-key-v1`, with `botAddress` and `privateKey` fields. If you already manage a bot EOA, create this file locally using your existing secret-management process. Do not paste the private key into the account page or put it on a command line. The CLI accepts owned regular keyfiles with mode `0600` or `0400`, rejects symlinks and multiple hard links, and checks that the public address matches the key.

On `/accounts`, expand **Bring your own bot key**, select the bot label/permissions/expiration, and download the public proof request. Sign it locally:

```sh
node scripts/rest/center.mjs proof \
  --key /private/path/bot-key.json \
  --request /path/to/juicebox-bot-proof-request.json \
  --out /path/to/registration.json
```

Paste only `registration.json` into the page. Select **Review registration**, check the bot address and permissions, then **Sign and register this bot**. The bot proof binds the service audience, account, bot address, scopes, expiration, label, and the owner's next request nonce. Scope arrays must be exactly `["read"]`, `["read","plan"]`, or `["read","plan","relay"]` in that order. The client, CLI, and server reject missing dependencies and reordered arrays without expanding them. The owner's API signature then binds the exact registration body, including that proof.

## Make signed requests

Use the same service origin as the authentication audience. It must be HTTPS, or HTTP on localhost. The account ID uses a lowercase address. Set the public account and grant values returned during registration:

```sh
CENTER_ACCOUNT='eip155:1:0x0000000000000000000000000000000000000000'
CENTER_GRANT='00000000-0000-4000-8000-000000000000'
```

Replace those placeholders before running a request. This example reads the bot's owner account through its `read` grant:

```sh
node scripts/rest/center.mjs send \
  --key /private/path/bot-key.json \
  --audience https://juicebox.center \
  --account "$CENTER_ACCOUNT" \
  --grant "$CENTER_GRANT" \
  --target '/api/v1/accounts/me'
```

For an API mutation, write the exact JSON document to a local file and supply `--method POST --body /path/to/body.json --content-type application/json`. Amounts and other large integers belong in decimal strings. Use the API catalog for the endpoint's required schema and bot scope. Owner API requests omit `--grant`; owner wallet keys should stay in the wallet instead of being exported for this CLI.

`sign` writes one signed request to an exclusive `0600` file without transmitting it:

```sh
node scripts/rest/center.mjs sign \
  --key /private/path/bot-key.json \
  --audience https://juicebox.center \
  --account "$CENTER_ACCOUNT" \
  --grant "$CENTER_GRANT" \
  --target '/api/v1/accounts/me' \
  --out /private/path/signed-request.json
```

That file includes `url`, `method`, `headers`, and `bodyBase64`. A custom transport must decode `bodyBase64` and send those exact bytes without changing the URL, query order, escape casing, method, content type, or signed headers. Treat the file as a short-lived credential until consumed or expired. The CLI never prints its signature headers or private key.

## Approve bot relay with the owner wallet

The bot creates and reviews its own plan. After the transaction wallet signs the exact transaction, the account owner signs a separate `CenterTransactionApproval`. Bind the approval to the account, bot principal, immutable plan commitment, step index, and hash of the exact serialized signed transaction. Use a fresh random approval nonce and a validity window no longer than five minutes:

```ts
import { keccak256 } from "viem";
import {
  buildTransactionApprovalTypedData,
  buildSponsorshipApprovalTypedData,
  sponsorshipSubmissionHash,
  newRequestNonce,
} from "./src/rest/client/index.js";

const issuedAt = Math.floor(Date.now() / 1000);
const claims = {
  accountId,
  principalId: `bot:${grantId}`,
  planId: plan.id,
  commitment: plan.commitment,
  stepIndex,
  transactionHash: keccak256(rawSignedTransaction),
  issuedAt,
  expiresAt: issuedAt + 300,
  nonce: newRequestNonce(),
};
const ownerApproval = {
  ...claims,
  signature: await ownerWallet.signTypedData(
    buildTransactionApprovalTypedData(audience, claims),
  ),
};
await botClient.request({
  method: "POST",
  requestTarget: `/api/v1/plans/${plan.id}/steps/${stepIndex}/submissions`,
  json: { rawSignedTransaction, ownerApproval },
  idempotencyKey: submissionKey,
});
```

`ownerWallet` is the connected account-owner wallet; it is separate from the bot's API signer and may also be separate from the transaction wallet. `plan`, `rawSignedTransaction`, and `stepIndex` must be the exact values the owner reviewed. Each bot-submitted step needs its own approval. The approval does not replace the wallet's transaction signature or the bot's per-request API signature. Expired approvals cannot authorize new dispatch; review the current state and obtain another approval when needed.

For sponsorship publication, use the prepared sponsorship record and the ordered wallet signatures for its forward requests. Sign this document with the account owner's wallet:

```ts
const sponsorIssuedAt = Math.floor(Date.now() / 1000);
const sponsorshipClaims = {
  accountId,
  principalId: `bot:${grantId}`,
  sponsorshipId: preparedSponsorship.id,
  commitment: preparedSponsorship.commitment,
  submissionHash: sponsorshipSubmissionHash(
    preparedSponsorship.commitment, forwardSignatures,
  ),
  issuedAt: sponsorIssuedAt,
  expiresAt: sponsorIssuedAt + 300,
  nonce: newRequestNonce(),
};
const sponsorshipOwnerApproval = {
  ...sponsorshipClaims,
  signature: await ownerWallet.signTypedData(
    buildSponsorshipApprovalTypedData(audience, sponsorshipClaims),
  ),
};
await botClient.request({
  method: "POST",
  requestTarget: `/api/v1/sponsorships/${preparedSponsorship.id}/submissions`,
  json: { signatures: forwardSignatures, ownerApproval: sponsorshipOwnerApproval },
  idempotencyKey: publicationKey,
});
```

Use the exported hash helper without reordering signatures or changing the preparation commitment. Direct transaction approvals and sponsorship approvals are distinct typed documents and cannot substitute for each other. The exact plan or sponsorship remains owned by its creating principal; another bot's grant cannot take it over.

## Request fidelity and retries

The TypeScript client exports `SignedRestClient`, `prepareSignedRequest`, `createBotRegistration`, `parseBotRegistration`, the two approval builders, and `sponsorshipSubmissionHash` from `src/rest/client/index.ts`. It uses the same browser-safe typed-data builders as the server. JSON is encoded once, raw bodies are copied before signing, and request targets that Fetch would normalize are rejected before signing. Redirects and ambient browser credentials are disabled.

Requests have a five-minute signature window and a default 15-second network timeout. Responses are bounded to 2 MiB by default. `send --timeout-ms` can choose 1–60,000 milliseconds. `--retries 1` or `2` is optional: each attempt gets a fresh nonce and signature while retaining the original bytes and idempotency key. Mutation retries require `--idempotency`; use retries only on operations whose documented server behavior supports idempotency. A timeout can leave the result unknown, so query the operation status before making a new mutation with a different idempotency key.

See [authentication details](./AUTHENTICATION.md), [transaction preparation and relay](./TRANSACTIONS.md), and [indexed reads](./INDEXER.md) for the complete boundaries.
