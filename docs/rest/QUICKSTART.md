# Get started

Start with what you want to do. An API lets your software use Center; REST is
the web request interface documented here. An assistant can use Center's tools
through MCP (Model Context Protocol). See the [glossary](https://juicebox.center/api#glossary)
for terms used below.

| Task | Start here |
| --- | --- |
| Find apps, guides, or developer tools | [Directory](https://juicebox.center) or [API explorer](https://juicebox.center/api). |
| Ask an assistant to inspect V6 projects or prepare a transaction | Connect it to `https://juicebox.center/mcp`. MCP tools need no Center account. Wallet approval is separate. |
| Automate data reads, transaction preparation, or submission | Create an API account and register a bot key below. The bot keeps its key and signs later API requests without wallet prompts. |
| Have a sponsor cover the network cost | Connect a supported smart wallet on `/accounts`, prepare an action, and sign it. A smart wallet is an account controlled by code and its owners. No bot or recurring permission is required. |

See the [journey map](./USER_JOURNEYS.md) for source choices, approvals, and
current execution limits. Smart-wallet creation currently requires an
owner-funded transaction; sponsored execution is a separate step.

## Enroll an API account

Open [Accounts](https://juicebox.center/accounts). Connect a compatible browser wallet. Choose its address and network, then select **Enroll account**. This signs an API request with an empty JSON body; it does not send a transaction. Existing owners can select **Load account**.

The selected network identifies your API account; it is called the **authority chain**. The account ID is `eip155:<authority-chain-id>:<lowercase-owner-address>`, so switching wallet networks selects another account. The page clears its connection when the wallet address or network changes. The profile form accepts a display name, bio, and optional avatar link using HTTPS or IPFS, a network for sharing files by their content.

The account page signs protected requests with the connected owner wallet, so its reads and changes can prompt the wallet. For ongoing automation, register a bot instead of repeatedly asking the owner to sign reads. The browser keeps no private key in localStorage or sessionStorage. It renders user-supplied profile and bot text as text, and does not fetch avatar URLs.

## Create a bot in the browser

You choose what a bot may do through the API. These permissions form its **grant**.
A **plan** stores the exact proposed transactions for review. **Relay** means
submitting transactions the wallet has already signed.

1. Choose a label, expiration, and permissions under **Bots**: **Read**, **Read + plan**, or **Read + plan + relay**. Planning includes reads so the bot can review its plans. Relay includes reads and planning because a bot can submit only its own plans. Wallet transaction signatures remain separate.
2. Select **Generate and download key**. The private key is created locally and downloaded once as a JSON file. The page retains only the public registration proof.
3. Save the file, then select **Register downloaded bot** and approve the owner signature. Save the returned grant ID; it is public and identifies the bot's authorization.
4. Use **Refresh bots** to list grants and **Revoke bot** to withdraw authorization.

The server receives the bot address, scope list, expiration, label, and a signed possession proof. It never receives the bot private key. A bot grant gives API permissions; it does not give access to the owner's funds. Direct relay requires the wallet's transaction signature. Bot dispatch also requires a fresh typed approval from the account owner, because a transaction signature has no signing timestamp. Each transaction signer needs the funds required by that chain.

Browser downloads commonly have mode `0644`. Before using a downloaded key with the CLI, move it to a private directory and set mode `0600`:

```sh
chmod 600 /path/to/juicebox-bot-key.json
```

If registration does not complete, keep the downloaded key. Create a fresh public proof request and use the command-line workflow below. Each owner request has a single-use random value, called a **nonce**. The page does not automatically reuse one because the server may already have consumed it.

## Bring an existing bot key

Build the command-line tool (CLI) once in `extensions/jbcenter` with Node 22 or newer:

```sh
npm run build
node scripts/rest/center.mjs --help
```

Generate a new local key if needed. The destination must not exist; key creation uses exclusive mode `0600` and prints only the public address:

```sh
node scripts/rest/center.mjs keygen --out /private/path/bot-key.json
```

The keyfile format is `juicebox-center-bot-key-v1`, with `botAddress` and `privateKey` fields. If you already manage a bot's signing key, create this file locally using your existing secret-management process. Do not paste the private key into the account page or put it on a command line. The CLI accepts owned regular keyfiles with mode `0600` or `0400`, rejects symlinks and multiple hard links, and checks that the public address matches the key.

On `/accounts`, expand **Bring your own bot key**, select the bot label/permissions/expiration, and download the public proof request. Sign it locally:

```sh
node scripts/rest/center.mjs proof \
  --key /private/path/bot-key.json \
  --request /path/to/juicebox-bot-proof-request.json \
  --out /path/to/registration.json
```

Paste only `registration.json` into the page. Select **Review registration**, check the bot address and permissions, then **Sign and register this bot**. The bot proof binds the service audience, account, bot address, scopes, expiration, label, and the owner's next request nonce. Scope arrays must be exactly `["read"]`, `["read","plan"]`, or `["read","plan","relay"]` in that order. The client, CLI, and server reject missing dependencies and reordered arrays without expanding them. The owner's API signature then binds the exact registration body, including that proof.

## Make signed requests

Sign requests for the service URL you will send them to. This URL is the authentication **audience**. It must use HTTPS, or HTTP on localhost. The account ID uses a lowercase address. Set the public account and grant values returned during registration:

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

For a request that changes state, write the exact JSON to a local file and supply `--method POST --body /path/to/body.json --content-type application/json`. Put amounts and other large integers in decimal strings. The API catalog gives each route's input format and required bot permission, called its **scope**. Owner API requests omit `--grant`; keep owner keys in the wallet.

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

This section is for wallets controlled directly by a signing key, called
**externally owned accounts (EOAs)**, and for prepaid Relayr publication.
For sponsored Safe execution, use the separate [smart-account
workflow](./API.md#smart-accounts-and-sponsored-owner-execution): the owner signs
the returned, time-limited `SafeOp`; no additional `CenterTransactionApproval`
is required. Keep the bot that created the plan as its API principal through
preparation and submission.

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

For a retry, an **idempotency key** identifies the same operation so the server
can return its existing result. It is separate from the nonce, which must be
new for each signed request.

The TypeScript client exports `SignedRestClient`, `prepareSignedRequest`, `createBotRegistration`, `parseBotRegistration`, the two approval builders, and `sponsorshipSubmissionHash` from `src/rest/client/index.ts`. It uses the same browser-safe typed-data builders as the server. JSON is encoded once, raw bodies are copied before signing, and request targets that Fetch would normalize are rejected before signing. Redirects and ambient browser credentials are disabled.

Requests have a five-minute signature window and a default 15-second network timeout. Responses are bounded to 2 MiB by default. `send --timeout-ms` can choose 1–60,000 milliseconds. `--retries 1` or `2` is optional: each attempt gets a fresh nonce and signature while retaining the original bytes and idempotency key. Mutation retries require `--idempotency`; use retries only on operations whose documented server behavior supports idempotency. A timeout can leave the result unknown, so query the operation status before making a new mutation with a different idempotency key.

See [authentication details](./AUTHENTICATION.md), [transaction preparation and relay](./TRANSACTIONS.md), and [indexed reads](./INDEXER.md) for the complete boundaries.
