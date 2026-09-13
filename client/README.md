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
