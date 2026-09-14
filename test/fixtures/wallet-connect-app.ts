// Browser acceptance client only. Uses the production helper, native navigation and tab storage.
import { createCenterWalletClient, type CenterWalletConnection } from "../../src/rest/client/wallet.js";

const status = document.getElementById("app-status")!;
const connect = document.getElementById("app-connect") as HTMLButtonElement;
const retry = document.getElementById("app-retry") as HTMLButtonElement;
const read = document.getElementById("app-read") as HTMLButtonElement;
const issuer = document.querySelector<HTMLMetaElement>('meta[name="wallet-issuer"]')!.content;
const audience = document.querySelector<HTMLMetaElement>('meta[name="wallet-audience"]')!.content;
const helper = createCenterWalletClient({ issuer, audience, callbackUri: `${location.origin}/callback` });
let connection: CenterWalletConnection | null = null;
function state(value: string, message: string) { status.dataset.state = value; status.textContent = message; }
function connected(value: CenterWalletConnection) {
  connection = value; connect.hidden = true; retry.hidden = true; read.hidden = false;
  document.getElementById("app-account")!.textContent = value.accountId;
  state("connected", "Connected through the shared Center wallet.");
}
function failed() { retry.hidden = false; state("retry", "Connection interrupted. Retry the saved request."); }
connect.addEventListener("click", () => {
  connect.disabled = true;
  void helper.prepareConnection().then(value => location.assign(value.authorizationUrl)).catch(() => { connect.disabled = false; failed(); });
});
retry.addEventListener("click", () => {
  retry.disabled = true;
  void helper.retryConnection().then(connected).catch(failed).finally(() => { retry.disabled = false; });
});
read.addEventListener("click", () => {
  read.disabled = true;
  void connection!.client.account().then(value => {
    document.getElementById("app-account")!.textContent = value.account.id;
    state("verified", "Signed account read verified by Center.");
  }).catch(() => state("rejected", "Center rejected the signed account request."))
    .finally(() => { read.disabled = false; });
});
if (location.pathname === "/callback" && location.search) {
  connect.hidden = true; state("checking", "Completing the saved app connection…");
  void helper.completeConnection().then(connected).catch(failed);
} else {
  const restored = helper.restoreConnection();
  if (restored) connected(restored);
  else state("ready", "Local browser acceptance app. Ready to connect.");
}
