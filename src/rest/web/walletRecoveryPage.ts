import { walletSignupCss } from './walletSignupPage.js';

export function walletRecoveryPage(options: { passwordBackups?: boolean; base?: string } = {}) {
  const base = options.base ?? '/wallet';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="wallet-base" content="${base}"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Recover your wallet | Juicebox</title>
<link rel="stylesheet" href="${base}/assets/wallet-recovery.css"><script type="module" src="${base}/assets/wallet-recovery.js"></script></head>
<body><main><a class="brand" id="wallet-back" href="${base || '/'}">JUICEBOX CENTER</a>
<h1>Recover your Juicebox wallet</h1>
<p>Use your backup file or original recovery wallet to replace a lost passkey. Your wallet address stays the same.</p>
<p id="wallet-status" role="status" aria-live="polite" aria-atomic="true">Checking your recovery…</p>
<fieldset id="recovery-method" hidden><legend>Recover with</legend>
<label class="choice"><input type="radio" name="recovery-method" value="kit" checked>My backup file</label>${options.passwordBackups ? `
<label class="choice"><input type="radio" name="recovery-method" value="password">My password</label>` : ''}
<label class="choice"><input type="radio" name="recovery-method" value="wallet">My existing recovery wallet</label></fieldset>
<section id="recovery-kit" hidden aria-label="Backup file"><label>Open your backup file<input id="recovery-file" type="file" accept="application/json,.json"></label>
<p id="recovery-kit-status">The file and backup password stay in this tab. Keep your saved copy.</p>
<details><summary>Use my backup password instead</summary><label>Backup password<textarea id="recovery-words" rows="4" maxlength="512" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea></label>
<button type="button" id="recovery-restore">Use backup password</button><p>You also need the wallet address from your saved backup file.</p></details></section>
<form id="recovery-form" hidden><label>Wallet address<input id="recovery-wallet" placeholder="0x…" maxlength="42" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>
<label id="recovery-password-label" hidden>Your password<input id="recovery-password" type="password" maxlength="128" autocomplete="current-password"></label>
<label>New passkey name<input id="passkey-name" value="Juicebox wallet" maxlength="120" autocomplete="off" required></label>
<button type="submit" id="recovery-begin">Start recovery</button></form>
<section id="recovery-details" hidden aria-label="Recovery details"><dl><dt>New passkey name</dt><dd id="recovery-name"></dd>
<dt>Wallet address</dt><dd id="recovery-address"></dd><dt>Recovery owner</dt><dd id="recovery-owner"></dd>
</dl><details><summary>Passkey details</summary><dl><dt>Previous passkey signer</dt><dd id="recovery-prior"></dd>
<dt>Replacement passkey signer</dt><dd id="recovery-replacement"></dd></dl></details></section>
<section id="recovery-review" hidden aria-label="Replacement review"><h2>Replace the lost passkey</h2>
<p>Approve these two actions on the private test chain:</p><ol><li>Create the replacement passkey signer.</li><li>Replace the previous passkey signer on your existing wallet.</li></ol>
<p>The new passkey will control this wallet. The recovery owner stays the same.</p>
<dl><dt>Safe transaction nonce</dt><dd id="recovery-nonce"></dd><dt>Signer factory</dt><dd id="recovery-factory"></dd></dl>
<details><summary>Exact approved calls</summary><pre id="recovery-calls"></pre></details></section>
<section id="recovery-transactions" hidden aria-label="Recovery transactions"><h2>Recovery transactions</h2><p>These references track the original recovery attempt.</p><ul id="recovery-hashes"></ul></section>
<div class="actions"><button type="button" id="recovery-next" hidden></button>
<button type="button" id="recovery-check" class="secondary" hidden>Check recovery</button>
<button type="button" id="recovery-restart" class="secondary" hidden>Start again</button>
<button type="button" id="recovery-cancel" class="secondary" hidden>Cancel prompt</button></div>
<section id="recovery-resume-section" hidden><details><summary>Resume an existing recovery</summary>
<p>Use the replacement passkey and original recovery owner. Your recovery reference is public and cannot approve recovery.</p>
<label>Recovery reference<input id="recovery-id" maxlength="36" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
<button type="button" id="recovery-resume">Resume recovery</button></details></section>
<a id="recovery-signin" href="${base || '/'}" hidden>Sign in with your new passkey</a>
<noscript><p>Enable JavaScript to recover your wallet.</p></noscript></main></body></html>`;
}

export function walletRecoveryCss() {
  return walletSignupCss() + '\npre{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font:inherit;font-size:.8rem}ol,ul{padding-left:1.5rem}li{overflow-wrap:anywhere;line-height:1.6;margin:.75rem 0}#recovery-review,#recovery-resume-section{margin:2rem 0}#recovery-signin{display:inline-block;margin-top:1.5rem;color:inherit}';
}
