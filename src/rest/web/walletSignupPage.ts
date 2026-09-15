import { walletCss } from './walletPage.js';
export function walletSignupPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Your Juicebox wallet</title>
<link rel="stylesheet" href="/wallet/assets/wallet-signup.css"><script type="module" src="/wallet/assets/wallet-signup.js"></script></head>
<body><main><a class="brand" id="wallet-back" href="/wallet">JUICEBOX CENTER</a>
<h1>Your Juicebox wallet</h1>
<p id="signup-intro" hidden>Sign up with a passkey, or <a href="#" id="signup-resume">log in</a> with one you've got.</p>
<p id="wallet-status" role="status" aria-live="polite" aria-atomic="true">Checking your signup…</p>
<form id="signup-form" hidden><label>Passkey name<input id="passkey-name" maxlength="120" autocomplete="off" required></label>
<fieldset id="recovery-method"><legend>If you lose this passkey, get back in with</legend>
<label class="choice"><input type="radio" name="recovery-method" value="kit" checked>A recovery kit we give you</label>
<label class="choice"><input type="radio" name="recovery-method" value="wallet">A wallet you already have</label></fieldset>
<p class="hint">You'll use your passkey twice: to create it, and to approve creating your wallet.</p>
<button type="submit" id="signup-begin">Sign up</button></form>
<section id="signup-details" hidden aria-label="Wallet details"><dl><dt>Passkey name</dt><dd id="signup-name"></dd>
<dt id="signup-recovery-label">Recovery</dt><dd><span id="signup-recovery"></span>
<div class="secret" id="recovery-secret" hidden><input id="recovery-phrase" type="password" readonly aria-label="Backup password" autocomplete="off">
<button type="button" id="recovery-show" class="quiet">Show</button><button type="button" id="recovery-copy" class="quiet">Copy</button></div></dd>
<dt>Wallet address</dt><dd id="signup-address"></dd></dl></section>
<section id="recovery-kit" hidden aria-label="Backup password">
<p>Anyone with this backup password can control your wallet. A lost backup password can't be recovered.</p>
<p id="recovery-kit-note">The backup file holds this password and your wallet address. Save it somewhere private you'll remember, or share it with someone you trust with your money.</p>
<div class="actions"><button type="button" id="recovery-download">Save backup file</button><button type="button" id="recovery-share" class="secondary" hidden>Share</button></div>
<div id="recovery-restore-box" hidden><p id="recovery-hint"></p><label>Backup password<textarea id="recovery-words" rows="3" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea></label>
<button type="button" id="recovery-restore" class="secondary">Restore backup password</button></div></section>
<div class="actions"><button type="button" id="signup-next" hidden></button>
<button type="button" id="signup-check" class="secondary" hidden>Check signup</button>
<button type="button" id="signup-cancel" class="secondary" hidden>Cancel prompt</button></div>
<button type="button" id="signup-restart" class="quiet" hidden>Start over</button>
<dialog id="signup-explain"><form method="dialog"><h2 id="explain-title"></h2><p id="explain-text"></p>
<div class="actions"><button value="continue" id="explain-continue">Continue</button><button value="cancel" class="quiet">Cancel</button></div></form></dialog>
<noscript><p>Enable JavaScript to create or resume your wallet.</p></noscript></main></body></html>`;
}
export function walletSignupCss() { return walletCss() + '\nlabel{display:grid;gap:.6rem;margin:1rem 0}input,textarea{box-sizing:border-box;font:inherit;min-height:3rem;width:100%;border:1px solid #172019;border-radius:0;background:white;color:inherit;padding:.75rem}fieldset{margin:1.5rem 0;padding:1rem;border:1px solid #172019;min-width:0}.choice{display:flex;align-items:center}.choice input{width:1.25rem;min-height:1.25rem;margin:0}.secret{display:flex;align-items:center;gap:1rem;margin:.25rem 0 0}.secret input{flex:1;min-width:0;letter-spacing:.05em;min-height:2.5rem;padding:.4rem .6rem}.secret .quiet{margin:0;flex:none}#recovery-kit{margin:1.5rem 0 2rem}details{margin:1.25rem 0}summary{cursor:pointer;color:#53614f}#signup-details{margin-top:2rem}#wallet-status{margin:1.25rem 0 .25rem}#wallet-status:empty{display:none;margin:0}#signup-intro{margin:0 0 2rem}#signup-intro a{color:inherit}#signup-form>label{margin-top:0}#recovery-method{border:0;padding:0;margin:.5rem 0 1.5rem}#recovery-method legend{padding:0;margin-bottom:.75rem}#recovery-method .choice{margin:.5rem 0}#signup-form label{margin-top:.5rem}dialog{border:1px solid #172019;background:#f5f4ee;color:inherit;padding:1.5rem;max-width:26rem;margin:auto;font:inherit}dialog::backdrop{background:rgba(23,32,25,.45)}dialog h2{margin:0 0 .75rem;font-size:1.1rem}dialog p{margin:0 0 1.25rem}dialog .actions{margin:0;display:flex;align-items:center;gap:1.25rem}dialog .quiet{margin:0}.quiet{background:none;border:0;padding:0;margin-top:2.5rem;font:inherit;font-size:.85rem;color:#53614f;text-decoration:underline;cursor:pointer}.quiet:hover:not(:disabled){background:none;color:#172019}.quiet:disabled{opacity:.5}#recovery-hint,.hint{color:#53614f}.hint{margin:0 0 1.25rem}#recovery-hint:empty{display:none}input[type=file]{overflow:hidden}'; }
