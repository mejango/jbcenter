import { smartWalletSections } from "./smartPage.js";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
export function accountsPage(options: { scriptPath?: string; stylePath?: string; audience?: string } = {}): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer">
<title>Accounts | Juicebox Center</title><link rel="stylesheet" href="${escapeHtml(options.stylePath ?? "/assets/accounts.css")}"><script type="module" src="${escapeHtml(options.scriptPath ?? "/assets/accounts.js")}"></script></head>
<body data-audience="${escapeHtml(options.audience ?? "")}"><main>
<header><a href="/">JUICEBOX CENTER</a><span>V6 / ACCOUNTS</span></header>
<h1>Your account.<br>Your bots.</h1>
<p class="lede">Connect your wallet to manage app access or approve V6 transactions. Add a bot to read data and prepare transactions for your review.</p>
<nav class="section-nav" aria-label="Account sections"><a href="#wallet-heading">Wallet</a><a href="#profile-heading">Profile</a><a href="#bots-heading">Bots</a><a href="#smart-heading">Smart wallet</a><a href="#operation-heading">Send a transaction</a><a id="session-nav" href="#session-heading" hidden>Bot permissions</a><a href="/api#glossary">Glossary</a></nav>
<p id="status" role="status" aria-live="polite">Ready.</p>
<section aria-labelledby="wallet-heading"><h2 id="wallet-heading">01 / Wallet</h2>
<div class="row"><label>Wallet<select id="wallets"><option value="">Looking for wallets…</option></select></label><button id="connect" type="button">Connect wallet</button><button id="disconnect" type="button" hidden>Disconnect</button></div>
<p id="identity">Connect a wallet to enroll or manage your account.</p>
<div class="row"><button id="enroll" type="button" disabled>Enroll account</button><button id="refresh" type="button" disabled>Load account</button></div>
</section>
<section aria-labelledby="profile-heading"><h2 id="profile-heading">02 / Profile (optional)</h2>
<details><summary>Edit your profile</summary>
<form id="profile-form"><fieldset id="profile-fields" disabled>
<label>Display name<input id="display-name" name="displayName" maxlength="120" autocomplete="nickname"></label>
<label>Bio<textarea id="bio" name="bio" maxlength="2000" rows="3"></textarea></label>
<label>Profile image address<input id="avatar-uri" name="avatarUri" maxlength="2048" placeholder="https:// or ipfs://"></label>
<button type="submit">Save profile</button></fieldset></form></details></section>
<section aria-labelledby="bots-heading"><h2 id="bots-heading">03 / Bots</h2>
<p>A bot is a program with its own key. Choose what it can do: read data, prepare plans, or send already signed transactions (relay). Each level includes the earlier ones. Relay needs fresh owner approval; API access does not let a bot spend the owner’s funds.</p>
<fieldset id="bot-fields" disabled><div class="row">
<label>Bot label<input id="bot-label" maxlength="120" value="My bot"></label>
<label>Expires in days<input id="bot-days" type="number" min="1" max="365" value="31"></label></div>
<label>API permissions<select id="bot-permissions"><option value="read">Read</option><option value="plan">Read + plan</option><option value="relay">Read + plan + relay</option></select></label>
<p>A new key is created in this browser and downloaded once. Keep the file private. The server receives the address and signed proof.</p>
<div class="row"><button id="generate-bot" type="button">Generate and download key</button><button id="register-generated" type="button" disabled>Register downloaded bot</button></div>
<p id="pending-bot"></p>
<details><summary>Bring your own bot key</summary><p>Download a public proof request. Use the command-line tool (CLI) with your local key, then paste the registration JSON it creates. Keep the private key file on your machine.</p>
<button id="proof-request" type="button">Download proof request</button>
<label>Public registration JSON<textarea id="registration-json" rows="7" spellcheck="false" autocomplete="off" placeholder='{"format":"juicebox-center-bot-registration-v1",…}'></textarea></label>
<button id="review-proof" type="button">Review registration</button><pre id="proof-preview" hidden></pre><button id="register-proof" type="button" hidden>Sign and register this bot</button></details>
</fieldset>
<div class="row"><h3>Registered bots</h3><button id="refresh-bots" type="button" disabled>Refresh bots</button></div><ul id="bot-list" class="bot-list"><li>Load your account to view bots.</li></ul>
</section>
${smartWalletSections()}
<footer>Private keys stay in your wallet or this page. Signatures approve exact API requests and reviewed blockchain actions.</footer>
</main></body></html>`;
}
export function accountsCss(): string {
  return `:root{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;color:#172119;background:#f4f4ed;font-size:15px;line-height:1.55;color-scheme:light}*{box-sizing:border-box;border-radius:0!important}body{margin:0}main{max-width:960px;margin:auto;padding:30px 24px 60px}header{display:flex;justify-content:space-between;gap:16px;border-bottom:2px solid;padding-bottom:20px;font-size:12px;letter-spacing:.06em}a{color:inherit}.section-nav,.service-links{display:flex;flex-wrap:wrap;gap:4px 18px;font-size:13px}.section-nav{margin:20px 0}.section-nav a,.service-links a{display:inline-flex;align-items:center;min-height:44px}h2{scroll-margin-top:20px}h1{font-size:clamp(42px,8vw,76px);font-weight:500;line-height:1.06;letter-spacing:-.05em;margin:50px 0 24px}.lede{max-width:630px;font-size:18px;margin-bottom:48px}section{border-top:1px solid #929a8f;padding:25px 0}h2{font-size:14px;letter-spacing:.06em;margin:0 0 22px}h3{font-size:14px;margin:0}p{max-width:760px}label{display:block;margin:0 0 16px;flex:1;min-width:160px}input:not([type=checkbox]),select,textarea{display:block;width:100%;font:inherit;padding:11px;border:1px solid #929a8f;background:#fff;color:inherit;margin-top:6px}textarea{resize:vertical}button{font:inherit;padding:11px 15px;border:1px solid #172119;background:#172119;color:#fff;cursor:pointer;min-height:46px}button:hover:not(:disabled){background:#334c37}button:disabled{opacity:.45;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible,pre:focus-visible{outline:3px solid #82a5ff;outline-offset:3px}fieldset{border:0;padding:0;margin:0;min-width:0}.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:12px 0}.row label{margin-bottom:0}.scopes{display:flex;flex-wrap:wrap;gap:20px;margin:20px 0}.scopes label{min-width:0;flex:0 1 auto;margin:0}.scopes input{accent-color:#172119;width:17px;height:17px;vertical-align:middle}details{border:1px solid #929a8f;margin:24px 0;padding:18px}summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#e9ece2;padding:16px;font:inherit;font-size:13px;max-height:32rem;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}#identity,#pending-bot{overflow-wrap:anywhere;font-size:13px}.bot-list{list-style:none;padding:0}.bot-list li{padding:16px 0;border-bottom:1px solid #b7bdb2;overflow-wrap:anywhere}.bot-list p{margin:4px 0;font-size:13px}.bot-list button{margin-top:10px}#status{border:1px solid;background:#e6eedb;padding:14px;max-width:none;overflow-wrap:anywhere}#status[data-error=true]{background:#ffe5db}footer{font-size:12px;margin-top:28px;color:#54624f}[hidden]{display:none!important}@media(max-width:560px){main{padding:20px 16px 40px}header{font-size:10px}h1{margin-top:36px}.row{align-items:stretch}.row>button{flex:1 1 160px}.row>label{flex-basis:100%}details{padding:13px}.lede{font-size:16px}}`;
}
