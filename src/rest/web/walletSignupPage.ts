import { walletCss } from './walletPage.js';
export function walletSignupPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Create your wallet | Juicebox</title>
<link rel="stylesheet" href="/wallet/assets/wallet-signup.css"><script type="module" src="/wallet/assets/wallet-signup.js"></script></head>
<body><main><a class="brand" id="wallet-back" href="/wallet">JUICEBOX CENTER</a>
<h1>Create your Juicebox wallet</h1>
<p>Create a named passkey and save a recovery kit. No existing wallet is needed.</p>
<p class="note">Local pilot. This creates a test wallet on a private Base-compatible chain. Do not send real funds to this address.</p>
<p id="wallet-status" role="status" aria-live="polite" aria-atomic="true">Checking your signup…</p>
<form id="signup-form" hidden><label>Passkey name<input id="passkey-name" value="Juicebox wallet" maxlength="120" autocomplete="off" required></label>
<button type="submit" id="signup-begin">Create passkey wallet</button></form>
<fieldset id="recovery-method" hidden><legend>Recovery</legend>
<label class="choice"><input type="radio" name="recovery-method" value="kit" checked>Create a recovery kit</label>
<label class="choice"><input type="radio" name="recovery-method" value="wallet">Use my existing wallet</label></fieldset>
<section id="recovery-kit" hidden aria-label="Recovery kit"><h2>Keep your recovery kit safe</h2>
<p>Anyone with these words can control your wallet. Save them somewhere private, separate from your passkey. Center cannot replace a lost kit.</p>
<p id="recovery-phrase" class="phrase"></p>
<p>The kit includes your recovery words and wallet address. Before creating the wallet, download it and reopen the saved file to verify it.</p>
<button type="button" id="recovery-download">Download recovery kit</button>
<label>Verify your saved recovery kit<input id="recovery-file" type="file" accept="application/json,.json"></label>
<details><summary>Restore from words instead</summary><label>Recovery words<textarea id="recovery-words" rows="4" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea></label>
<button type="button" id="recovery-restore">Restore recovery words</button></details></section>
<section id="signup-details" hidden aria-label="Wallet details"><dl><dt>Passkey name</dt><dd id="signup-name"></dd>
<dt>Recovery wallet</dt><dd id="signup-recovery"></dd><dt>Wallet address</dt><dd id="signup-address"></dd></dl></section>
<div class="actions"><button type="button" id="signup-next" hidden></button>
<button type="button" id="signup-resume" class="secondary" hidden>Resume with a passkey</button>
<button type="button" id="signup-check" class="secondary" hidden>Check signup</button>
<button type="button" id="signup-cancel" class="secondary" hidden>Cancel prompt</button></div>
<a id="signup-signin" href="/wallet" hidden>Sign in with your passkey</a>
<noscript><p>Enable JavaScript to create or resume your wallet.</p></noscript></main></body></html>`;
}
export function walletSignupCss() { return walletCss() + '\nlabel{display:grid;gap:.6rem;margin:1rem 0}input,textarea{box-sizing:border-box;font:inherit;min-height:3rem;width:100%;border:1px solid #172019;border-radius:0;background:white;color:inherit;padding:.75rem}fieldset{margin:1.5rem 0;padding:1rem;border:1px solid #172019;min-width:0}.choice{display:flex;align-items:center}.choice input{width:1.25rem;min-height:1.25rem;margin:0}.phrase{overflow-wrap:anywhere;line-height:1.8}input[type=file]{overflow:hidden}#signup-signin{display:inline-block;margin-top:1.5rem;color:inherit}'; }
