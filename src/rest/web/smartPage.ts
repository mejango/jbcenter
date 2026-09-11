export function smartWalletSections(): string {
  return `<section aria-labelledby="smart-heading"><h2 id="smart-heading">04 / Smart wallet</h2>
<p>A smart wallet uses a contract to check its owners’ approvals. Create or connect a supported Safe wallet, then review and sign each V6 transaction. Each chain has its own wallet.</p>
<p class="service-links"><a href="/api">API guide</a><a href="/api/v1/capabilities">Supported features</a><a href="/api/docs/smart-accounts">Smart wallet guide</a></p>
<p id="smart-readiness">Load your account to check supported chains automatically.</p>
<details><summary>Service settings</summary><button id="smart-discover" type="button">Refresh supported chains</button><pre id="smart-capabilities" tabindex="0" aria-label="Hosted capability details" hidden></pre></details>
<fieldset id="smart-fields" disabled>
<label>Network and wallet version<select id="smart-manifest"><option value="">Load your account first</option></select></label>
<button id="smart-switch" type="button">Switch wallet to this chain</button>
<details><summary>Create a smart wallet</summary>
<p>Your connected wallet is the default owner and pays the network cost to create it. Review the address and owners before approving creation. Creating a wallet does not grant a bot permission to use it.</p>
<details><summary>Multiple owners</summary><label>Owner addresses, one per line<textarea id="smart-owners" rows="3" spellcheck="false"></textarea></label>
<label>Required owner signatures<input id="smart-threshold" type="number" min="1" max="16" value="1"></label></details>
<div class="row"><button id="smart-create-prepare" type="button">Prepare creation</button><button id="smart-create-send" type="button" disabled>Review in wallet and create</button><button id="smart-create-status" type="button" disabled>Check creation receipt</button></div>
<pre id="smart-creation" tabindex="0" aria-label="Wallet creation review" hidden></pre></details>
<p>Link the wallet to your Center account after proving ownership. This link is called a <a href="/api#glossary-binding">binding</a>.</p>
<label>Smart wallet address<input id="smart-address" spellcheck="false" autocomplete="off" placeholder="0x…"></label>
<div class="row"><button id="smart-bind-prepare" type="button">Inspect wallet and prepare binding</button><button id="smart-bind-sign" type="button" disabled>Sign binding as owner</button></div>
<pre id="smart-binding-review" tabindex="0" aria-label="Owner binding review" hidden></pre>
<details id="smart-binding-multisig" hidden><summary>Additional owner signatures</summary><label>Signatures, JSON array<textarea id="smart-binding-signatures" rows="2" spellcheck="false" placeholder='["0x…"]'></textarea></label>
<p>If more than one signature is required, share the exact public signing document with the other owners and collect their typed wallet signatures (EIP-712). Keep this page open while they sign.</p></details>
<button id="smart-bind-submit" type="button" disabled>Verify threshold and bind wallet</button>
<details><summary>Use a saved wallet binding</summary><div class="row"><label>Binding ID<input id="smart-binding-id" spellcheck="false" autocomplete="off"></label><button id="smart-bind-load" type="button">Load binding</button><button id="smart-bind-list" type="button">List bindings</button></div>
</details><pre id="smart-bindings" tabindex="0" aria-label="Verified wallet bindings" hidden></pre>
</fieldset></section>
<section aria-labelledby="operation-heading"><h2 id="operation-heading">05 / Review and send</h2>
<p>Prepare a V6 action and test it without sending funds (a simulation). Review it, sign, and submit. Check its status to confirm it completed.</p>
<fieldset id="operation-fields" disabled>
<label id="operation-authority-label" hidden>Who approves<select id="operation-authority" disabled><option value="owner">Fresh owner approval</option><option value="session">Approved bot key</option></select></label>
<div id="session-key-fields" hidden><label>Local bot key file<input id="session-key-file" type="file" accept="application/json,.json"></label><p id="session-key-status">Load the bot key downloaded during registration. The key stays in this page's memory and is never sent to the service.</p><button id="session-key-clear" type="button">Clear local key</button></div>
<p>Choose an <a href="/api#write">operation from the API guide</a> and enter its input. The resulting calls are shown before signing.</p>
<details id="operation-session-template" hidden><summary>Fill from bot permissions</summary>
<label>New address for project details<input id="operation-uri" placeholder="ipfs://…" spellcheck="false"></label>
<label>Payment or transfer amount, smallest token units<input id="operation-amount" inputmode="numeric"></label>
<label>Verified token contract ID for an ERC20 transfer<input id="operation-token-contract" spellcheck="false" placeholder="From the host's contract catalog"></label>
<button id="operation-template" type="button">Fill current session action</button>
<p>For ERC-20 payments, the owner must separately approve how many tokens the payment contract (terminal) may spend. This limit is an allowance.</p></details>
<label>Operation name<input id="operation-name" value="contract_calls" spellcheck="false"></label><label>Operation input JSON<textarea id="operation-input" rows="7" spellcheck="false" autocomplete="off" placeholder='{"account":"0x…","calls":[…]}'></textarea></label><button id="operation-plan" type="button">Prepare smart-wallet plan</button>
<p>Use one plan step at a time to verify payment or cash-out amounts. Several calls sent together can confirm without proving each financial result.</p>
<details><summary>Choose specific plan steps</summary><p>All planned calls are selected by default.</p><label>Steps to send: 0 for the first, 0,1 for the first two<input id="operation-steps" value="0" inputmode="numeric"></label></details>
<pre id="operation-plan-review" tabindex="0" aria-label="Planned calls review" hidden></pre>
<div class="row"><button id="operation-prepare" type="button" disabled>Prepare and simulate operation</button><button id="operation-sign" type="button" disabled>Sign reviewed operation</button></div>
<pre id="operation-review" tabindex="0" aria-label="Prepared operation and signing document" hidden></pre>
<details id="operation-owner-signatures-label" hidden><summary>Additional owner signatures</summary><label>Owner approval signatures (SafeOp), JSON array<textarea id="operation-owner-signatures" rows="2" spellcheck="false" placeholder='["0x…"]'></textarea></label></details>
<div class="row"><button id="operation-submit" type="button" disabled>Verify signatures and submit</button><button id="operation-status" type="button" disabled>Refresh operation status</button></div>
<p id="operation-result" role="status"></p>
</fieldset></section>
<section id="session-section" aria-labelledby="session-heading" hidden><h2 id="session-heading">06 / Optional bot permissions</h2>
<p>Allow a registered bot to repeat one action for 7 or 30 days. This permission is called a session. Moving funds still needs fresh owner approval unless you approve the exact payment budget below. <a href="/api/docs/sessions">Bot permission guide</a>.</p>
<fieldset id="session-fields" disabled>
<label>Bot grant ID<input id="session-grant" spellcheck="false" autocomplete="off"></label>
<p>The bot’s API access must include relay and remain valid for the whole session.</p>
<div class="row"><label>Duration<select id="session-days"><option value="7">7 days</option><option value="30">30 days</option></select></label><label>Maximum calls<input id="session-calls" inputmode="numeric" value="7"></label></div>
<label>Allowed action<select id="session-action"><option value="v6-project-uri">Update the address for project details</option><option value="v6-pay">Repeat payment to one V6 project</option><option value="erc20-transfer">Repeat ERC20 transfer to one recipient</option></select></label>
<div class="row"><label>V6 controller or terminal<input id="session-target" spellcheck="false" placeholder="0x…"></label><label>V6 project ID<input id="session-project" inputmode="numeric" value="1"></label></div>
<div id="session-payment" hidden>
<label>Asset address<input id="session-asset" spellcheck="false" placeholder="0x…"></label>
<label>Exact token recipient<input id="session-beneficiary" spellcheck="false" placeholder="0x…"></label>
<div class="row"><label>Maximum per call, smallest token units<input id="session-per-call" inputmode="numeric"></label><label>Total budget in this separate wallet, smallest token units<input id="session-total" inputmode="numeric"></label></div>
<label>Exact minimum project tokens returned per V6 payment<input id="session-min-return" inputmode="numeric" value="0"></label>
<label><input id="session-budget-consent" type="checkbox"> I authorize repeat payments within this exact recipient, chain, asset, time and amount budget.</label>
</div>
<details><summary>Required limits on sponsored network costs</summary><p>Use the sponsor contract (<a href="/api#glossary-paymaster">paymaster</a>) reviewed by this service. Enter exact integers in gas units and wei, as required by each field. These limits cover the whole session; the wallet cannot pay its own session network costs.</p>
<label>Gas budget JSON<textarea id="session-gas" rows="10" spellcheck="false" autocomplete="off">{
  "paymaster": "",
  "maxGasPerOperation": "1000000",
  "maxFeePerGas": "1000000000",
  "maxPriorityFeePerGas": "100000000",
  "totalGasLimit": "7000000",
  "totalSponsoredCostLimit": "7000000000000000",
  "maxPaymasterDataLength": 1024
}</textarea></label></details>
<button id="session-prepare" type="button">Prepare exact bot permissions</button>
<pre id="session-review" tabindex="0" aria-label="Exact session policy review" hidden></pre>
<div class="row"><button id="session-activate" type="button" disabled>Prepare owner activation</button><button id="session-revoke" type="button" disabled>Prepare owner revocation</button></div>
<div class="row"><label>Session ID<input id="session-id" spellcheck="false" autocomplete="off"></label><button id="session-refresh" type="button">Check session and remaining limits</button></div>
<pre id="session-quota" tabindex="0" aria-label="Observed session quota" hidden></pre>
</fieldset></section>
`;
}
