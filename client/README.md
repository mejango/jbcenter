# Juicebox Center client

Create API access at https://juicebox.center/accounts and download the connection file.
Keep it in your secret store. The file contains a private signing key.

```sh
npm install https://juicebox.center/api/client/juicebox-center-client-0.1.0.tgz
chmod 600 juicebox-connection.json
npx center account --connection juicebox-connection.json
```

```js
import { connect } from '@juicebox/center-client/node';
const center = await connect('./juicebox-connection.json');
console.log(await center.account());
```

Browser apps can import `CenterClient` and use their existing wallet or local bot
signer. The client handles exact request signing, nonces and authentication expiry.
API access alone does not authorize wallet spending. For unattended payments,
activate separate wallet permissions with an action, recipient, budget and expiry.
Then use `center.smartAccounts()` and `center.signSessionOperation(...)` with the
same downloaded connection. The bot operates within those permissions without
further owner prompts. Activation requires support on each execution network.

Guide: https://juicebox.center/api/docs/quickstart
Client workflows: https://juicebox.center/api/docs/client

The experimental `createCenterWalletClient` export connects an app to an explicitly
configured Center passkey service. It requires fixed `issuer`, `audience` and exact
`callbackUri` values plus an activated Center allowlist entry. Nothing is activated
by importing it. Runtime integration alone does not enable a public deployment.

Call `prepareConnection()` and navigate to its `authorizationUrl`. On the registered
callback page, call `completeConnection()`; it removes callback parameters before
any exchange and validates the issuer, state and locally retained request key.
`retryConnection()` recovers the same pending exchange after an uncertain response.
`restoreConnection()` returns a locally stored connection candidate; every API
request still checks current server authority. The default storage is the current
tab's `sessionStorage`, which contains an API request key and must be treated as
sensitive. `disconnect()` clears it and invalidates the helper's existing clients.

The returned connection exposes the Base wallet address and an ordinary
`CenterClient` with read/plan/relay access. The request key cannot sign payments or
activate spending sessions. Fresh owner-approved payment review remains separate.
