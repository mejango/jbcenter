export function smartWalletSections(): string {
  return `<section aria-labelledby="smart-heading"><h2 id="smart-heading">04 / Smart wallet</h2>
<p>Create or bind a Safe for V6 actions. Each chain has its own wallet and limits. Hosted execution is available only when the reviewed contracts, inspector, bundler and paymaster are configured.</p>
<p class="service-links"><a href="/api">API guide</a><a href="/api/v1/capabilities">Hosted capabilities</a><a href="/api/docs/smart-accounts">Smart wallet guide</a><a href="/api/docs/sessions">Session guide</a></p>
<p id="smart-readiness">Check hosted chains to see whether execution is configured.</p>
<button id="smart-discover" type="button">Check hosted chains</button><pre id="smart-capabilities" tabindex="0" aria-label="Hosted capability details" hidden></pre>
<fieldset id="smart-fields" disabled>
<label>Reviewed deployment<select id="smart-manifest"><option value="">Check hosted chains first</option></select></label>
<button id="smart-switch" type="button">Switch wallet to this chain</button>
<details><summary>Create a smart wallet</summary>
<p>Creation installs an empty session module. The connected wallet pays the creation transaction fee. No session is enabled yet.</p>
<label>Owner addresses, one per line<textarea id="smart-owners" rows="3" spellcheck="false"></textarea></label>
<label>Required owner signatures<input id="smart-threshold" type="number" min="1" max="16" value="1"></label>
<div class="row"><button id="smart-create-prepare" type="button">Prepare creation</button><button id="smart-create-send" type="button" disabled>Review in wallet and create</button><button id="smart-create-status" type="button" disabled>Check creation receipt</button></div>
<pre id="smart-creation" tabindex="0" aria-label="Wallet creation review" hidden></pre></details>
<label>Smart wallet address<input id="smart-address" spellcheck="false" autocomplete="off" placeholder="0x…"></label>
<div class="row"><button id="smart-bind-prepare" type="button">Inspect wallet and prepare binding</button><button id="smart-bind-sign" type="button" disabled>Sign binding as owner</button></div>
<pre id="smart-binding-review" tabindex="0" aria-label="Owner binding review" hidden></pre>
<label>Additional owner signatures, JSON array<textarea id="smart-binding-signatures" rows="2" spellcheck="false" placeholder='["0x…"]'></textarea></label>
<p>For a threshold above one, share the exact public signing document with the other owners and collect their EIP712 signatures. Keep this page open while they sign.</p>
<button id="smart-bind-submit" type="button" disabled>Verify threshold and bind wallet</button>
<div class="row"><label>Existing binding ID<input id="smart-binding-id" spellcheck="false" autocomplete="off"></label><button id="smart-bind-load" type="button">Load binding</button><button id="smart-bind-list" type="button">List bindings</button></div>
<pre id="smart-bindings" tabindex="0" aria-label="Verified wallet bindings" hidden></pre>
</fieldset></section>
<section aria-labelledby="session-heading"><h2 id="session-heading">05 / Exact sessions</h2>
<p>Choose a seven- or thirty-day limit for a registered bot. Every fund movement requires fresh approval unless you explicitly authorize the isolated repeat-payment budget below. A new period needs a new policy and owner approval.</p>
<fieldset id="session-fields" disabled>
<label>Bot grant ID<input id="session-grant" spellcheck="false" autocomplete="off"></label>
<p>The bot grant must include relay permission and outlast the complete session period.</p>
<div class="row"><label>Duration<select id="session-days"><option value="7">7 days</option><option value="30">30 days</option></select></label><label>Maximum calls<input id="session-calls" inputmode="numeric" value="7"></label></div>
<label>Allowed action<select id="session-action"><option value="v6-project-uri">Update project metadata URI</option><option value="v6-pay">Repeat payment to one V6 project</option><option value="erc20-transfer">Repeat ERC20 transfer to one recipient</option></select></label>
<div class="row"><label>V6 controller or terminal<input id="session-target" spellcheck="false" placeholder="0x…"></label><label>V6 project ID<input id="session-project" inputmode="numeric" value="1"></label></div>
<div id="session-payment" hidden>
<label>Asset address<input id="session-asset" spellcheck="false" placeholder="0x…"></label>
<label>Exact beneficiary<input id="session-beneficiary" spellcheck="false" placeholder="0x…"></label>
<div class="row"><label>Maximum per call, raw token units<input id="session-per-call" inputmode="numeric"></label><label>Total isolated budget, raw token units<input id="session-total" inputmode="numeric"></label></div>
<label>Exact minimum returned project tokens for V6 payments<input id="session-min-return" inputmode="numeric" value="0"></label>
<label><input id="session-budget-consent" type="checkbox"> I authorize repeat payments within this exact recipient, chain, asset, time and amount budget.</label>
</div>
<details><summary>Required sponsored gas limits</summary><p>Use the paymaster reviewed by this host. Amounts and fees are decimal integers in gas units and wei. These limits apply for the entire session; the wallet cannot self-pay session gas.</p>
<label>Gas budget JSON<textarea id="session-gas" rows="10" spellcheck="false" autocomplete="off">{
  "paymaster": "",
  "maxGasPerOperation": "1000000",
  "maxFeePerGas": "1000000000",
  "maxPriorityFeePerGas": "100000000",
  "totalGasLimit": "7000000",
  "totalSponsoredCostLimit": "7000000000000000",
  "maxPaymasterDataLength": 1024
}</textarea></label></details>
<button id="session-prepare" type="button">Prepare exact session policy</button>
<pre id="session-review" tabindex="0" aria-label="Exact session policy review" hidden></pre>
<div class="row"><button id="session-activate" type="button" disabled>Prepare owner activation</button><button id="session-revoke" type="button" disabled>Prepare owner revocation</button></div>
<div class="row"><label>Session ID<input id="session-id" spellcheck="false" autocomplete="off"></label><button id="session-refresh" type="button">Refresh session and quota</button></div>
<pre id="session-quota" tabindex="0" aria-label="Observed session quota" hidden></pre>
</fieldset></section>
<section aria-labelledby="operation-heading"><h2 id="operation-heading">06 / Review and execute</h2>
<p>Activation and revocation plans appear here for owner approval. For a regular V6 action, prepare a smart-wallet plan below. Submission is separate from confirmation; refresh status after submitting.</p>
<fieldset id="operation-fields" disabled>
<label>Signing authority<select id="operation-authority"><option value="owner">Fresh owner approval</option><option value="session">Active session key</option></select></label>
<div id="session-key-fields" hidden><label>Local bot key file<input id="session-key-file" type="file" accept="application/json,.json"></label><p id="session-key-status">Load the bot key downloaded during registration. The key stays in this page's memory and is never sent to the service.</p><button id="session-key-clear" type="button">Clear local key</button></div>
<details><summary>Prepare a V6 action</summary><p>Fill a call from the first action in the current session, or enter another transaction operation from the API catalog. The resulting calls are shown before signing.</p>
<label>Metadata URI for a project URI update<input id="operation-uri" placeholder="ipfs://…" spellcheck="false"></label>
<label>Payment or transfer amount, raw token units<input id="operation-amount" inputmode="numeric"></label>
<label>Verified token contract ID for an ERC20 transfer<input id="operation-token-contract" spellcheck="false" placeholder="From the host's contract catalog"></label>
<button id="operation-template" type="button">Fill current session action</button>
<p>ERC20 payments require a finite terminal allowance approved separately by the owner.</p>
<label>Operation name<input id="operation-name" value="contract_calls" spellcheck="false"></label><label>Operation input JSON<textarea id="operation-input" rows="7" spellcheck="false" autocomplete="off" placeholder='{"account":"0x…","calls":[…]}'></textarea></label><button id="operation-plan" type="button">Prepare smart-wallet plan</button></details>
<label>Plan steps to execute, zero-based comma-separated indexes<input id="operation-steps" value="0" inputmode="numeric"></label>
<pre id="operation-plan-review" tabindex="0" aria-label="Planned calls review" hidden></pre>
<div class="row"><button id="operation-prepare" type="button" disabled>Prepare and simulate operation</button><button id="operation-sign" type="button" disabled>Sign reviewed operation</button></div>
<pre id="operation-review" tabindex="0" aria-label="Prepared operation and signing document" hidden></pre>
<label id="operation-owner-signatures-label">Additional owner SafeOp signatures, JSON array<textarea id="operation-owner-signatures" rows="2" spellcheck="false" placeholder='["0x…"]'></textarea></label>
<div class="row"><button id="operation-submit" type="button" disabled>Verify signatures and submit</button><button id="operation-status" type="button" disabled>Refresh operation status</button></div>
<p id="operation-result" role="status"></p>
</fieldset></section>`;
}
