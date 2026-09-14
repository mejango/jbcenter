import { walletCss } from './walletPage.js';
export function walletSignupPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Create your wallet | Juicebox</title>
<link rel="stylesheet" href="/wallet/assets/wallet-signup.css"><script type="module" src="/wallet/assets/wallet-signup.js"></script></head>
<body><main><a class="brand" id="wallet-back" href="/wallet">JUICEBOX CENTER</a>
<h1>Create your Juicebox wallet</h1>
<p>Choose a name for your passkey and connect an independent recovery wallet.</p>
<p class="note">Local pilot. This creates a test wallet on a private Base-compatible chain. Do not send real funds to this address.</p>
<p id="wallet-status" role="status" aria-live="polite" aria-atomic="true">Checking your signup…</p>
<form id="signup-form" hidden><label>Passkey name<input id="passkey-name" value="Juicebox wallet" maxlength="120" autocomplete="off" required></label>
<p>Your recovery wallet can control this wallet independently of your passkey. Keep access to it.</p>
<button type="submit" id="signup-begin">Connect recovery wallet</button></form>
<section id="signup-details" hidden aria-label="Wallet details"><dl><dt>Passkey name</dt><dd id="signup-name"></dd>
<dt>Recovery wallet</dt><dd id="signup-recovery"></dd><dt>Wallet address</dt><dd id="signup-address"></dd></dl></section>
<div class="actions"><button type="button" id="signup-next" hidden></button>
<button type="button" id="signup-resume" class="secondary" hidden>Resume with a passkey</button>
<button type="button" id="signup-check" class="secondary" hidden>Check signup</button>
<button type="button" id="signup-cancel" class="secondary" hidden>Cancel prompt</button></div>
<a id="signup-signin" href="/wallet" hidden>Sign in with your passkey</a>
<noscript><p>Enable JavaScript to create or resume your wallet.</p></noscript></main></body></html>`;
}
export function walletSignupCss() { return walletCss() + '\nlabel{display:grid;gap:.6rem;margin:1rem 0}input{font:inherit;min-height:3rem;width:100%;border:1px solid #172019;border-radius:0;background:white;color:inherit;padding:.75rem}#signup-signin{display:inline-block;margin-top:1.5rem;color:inherit}'; }
