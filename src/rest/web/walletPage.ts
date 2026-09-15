/** Dedicated credential surface. All behavior and styles are served as same-origin assets. */
export function walletPage(signup = false, recovery = false, base = '/wallet'): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="wallet-base" content="${base}"><link rel="icon" type="image/svg+xml" href="${base}/assets/favicon.svg"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Your wallet | Juicebox</title>
<link rel="stylesheet" href="${base}/assets/wallet.css"><script type="module" src="${base}/assets/wallet.js"></script></head>
<body><main><a class="brand" href="${base || '/'}">JUICEBOX CENTER</a>
<h1>Your Juicebox</h1><p>One wallet for Juicebox apps.</p>
<p id="wallet-destination" hidden></p>
<p id="wallet-status" role="status" aria-live="polite" aria-atomic="true" data-state="loading">Checking your wallet…</p>
<section id="wallet-account" aria-label="Connected wallet" hidden><dl><dt>Wallet address</dt><dd id="wallet-address"></dd><dt>Network</dt><dd>Base</dd></dl></section>
<div class="actions"><button id="wallet-signin" type="button" hidden>Sign in with a passkey</button>
<button id="wallet-retry" type="button" hidden>Retry</button>
<button id="wallet-cancel" type="button" class="secondary" hidden>Cancel</button>
<button id="wallet-logout" type="button" class="secondary" hidden>Sign out</button></div>
<p class="note">Use a passkey already linked to your Center wallet. Payments still require your approval.</p>
${signup ? '<p><a id="wallet-create" href="${base}/create" hidden>Create or resume a wallet</a></p>' : ''}
${recovery ? '<p><a id="wallet-recover" href="${base}/recover" hidden>Recover a lost passkey</a></p>' : ''}
<noscript><p>Enable JavaScript to sign in with your passkey.</p></noscript>
</main></body></html>`;
}

export function walletCss(): string {
  return `:root{color-scheme:light;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:#172019;background:#f5f4ee}
*{box-sizing:border-box}body{margin:0}main{width:min(100%,38rem);margin:clamp(1rem,10vh,6rem) auto;padding:1.5rem}
[hidden]{display:none!important}.brand{color:inherit;font-size:.8rem;letter-spacing:.06em}h1{font-size:clamp(1.6rem,6vw,2.2rem);line-height:1.15;margin:2.5rem 0 1rem}
p{line-height:1.6;overflow-wrap:anywhere}#wallet-status{color:#172019;font-weight:700;min-height:3rem;margin:1.75rem 0;font-size:.95rem;position:relative}#wallet-status::before{content:"⚡";position:absolute;left:-1.4em;top:0}#wallet-status[data-state=error]::before,#wallet-status[data-state=retry]::before{content:"!"}#wallet-status:empty::before{content:none}
#wallet-status[data-state=error],#wallet-status[data-state=retry]{color:#9c3028}#wallet-status a{color:inherit}@keyframes loading-ticks{0%{content:"-"}25%{content:"\\\\"}50%{content:"|"}75%{content:"/"}}#wallet-status[data-state=busy]::before,#wallet-status[data-state=loading]::before,#wallet-status[data-state=checking]::before,#wallet-status[data-state=returning]::before{content:"-";animation:loading-ticks .4s steps(1,end) infinite}dl{margin:0 0 1.5rem}dt{font-size:.8rem;color:#53614f}dd{margin:.5rem 0 1.2rem;overflow-wrap:anywhere}
.actions{display:flex;flex-wrap:wrap;gap:.75rem}button{min-height:3rem;padding:.75rem 1rem;font:inherit;border:1px solid #172019;border-radius:0;background:#172019;color:#fff;cursor:pointer;max-width:100%}
button.secondary{background:transparent;color:inherit}button:disabled{cursor:wait;opacity:.55}button:hover:not(:disabled){background:#364532;color:white}
:focus-visible{outline:3px solid #5275d1;outline-offset:4px}.note{font-size:.8rem;color:#53614f;margin-top:2rem}
@media(max-width:400px){main{padding:1.1rem}.actions{flex-direction:column}.actions button{width:100%}}`;
}
