/** Dedicated credential surface. All behavior and styles are served as same-origin assets. */
export function walletPage(signup = false, recovery = false, base = '/wallet'): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="wallet-base" content="${base}"><link rel="icon" type="image/svg+xml" href="${base}/assets/favicon.svg"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Your account | Juicebox</title>
<link rel="stylesheet" href="${base}/assets/wallet.css"><script type="module" src="${base}/assets/wallet.js"></script></head>
<body><main><a class="brand" href="${base || '/'}">JUICEBOX CENTER</a>
<h1>Your account</h1>
<p id="wallet-destination" hidden></p>
<p id="wallet-status" role="status" aria-live="polite" aria-atomic="true" data-state="loading">Checking your wallet…</p>
<section id="wallet-account" aria-label="Connected account" hidden><dl><dt>Account address</dt><dd id="wallet-address"></dd><dt id="wallet-passkey-label">Passkey</dt><dd id="wallet-passkey"></dd><dt>Networks</dt><dd><span id="wallet-networks">Base</span> <button id="wallet-networks-add" class="link" type="button" hidden>Add more</button></dd></dl>
<form id="wallet-networks-form" hidden><fieldset id="wallet-networks-family"><legend>Add your account to</legend>
<label class="choice"><input type="radio" name="family" value="mainnet" checked>Mainnets</label><label class="choice"><input type="radio" name="family" value="testnet">Testnets</label></fieldset>
<fieldset id="wallet-networks-choices"></fieldset>
<div class="actions"><button id="wallet-networks-deploy" type="submit">Deploy</button><button id="wallet-networks-cancel" class="link" type="button">Cancel</button></div></form>
<p id="wallet-devices-row"><button id="wallet-device-add" class="link" type="button">Add a device</button></p>
<section id="wallet-device" hidden aria-label="Add a device"><h2>Add a device</h2>
<p id="wallet-device-hint">Open this link on the other device. It creates its own passkey for this account; you approve it here.</p>
<div id="wallet-device-code" class="qr"></div><p><a id="wallet-device-link" target="_blank" rel="noopener"></a></p>
<div class="actions"><button id="wallet-device-approve" type="button" hidden>Approve this device</button><button id="wallet-device-cancel" class="link" type="button">Close</button></div></section></section>
<div class="actions"><button id="wallet-signin" type="button" hidden>Sign in</button>
<button id="wallet-retry" type="button" hidden>Retry</button>
<button id="wallet-cancel" type="button" class="link" hidden>Cancel</button>
<button id="wallet-logout" type="button" class="secondary" hidden>Sign out</button></div>
<div id="wallet-links">${signup ? `<a id="wallet-create" href="${base}/create" hidden>Sign up</a>` : ''}
${recovery ? `<a id="wallet-recover" href="${base}/recover" hidden>Lost your account?</a>` : ''}</div>
<noscript><p>Enable JavaScript to sign in with your passkey.</p></noscript>
</main></body></html>`;
}

export function walletCss(): string {
  return `:root{color-scheme:light;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:#172019;background:#f5f4ee}
*{box-sizing:border-box}body{margin:0}main{width:min(100%,38rem);margin:clamp(1rem,10vh,6rem) auto;padding:1.5rem}
[hidden]{display:none!important}.brand{color:inherit;font-size:.8rem;letter-spacing:.06em}h1{font-size:clamp(1.6rem,6vw,2.2rem);line-height:1.15;margin:2.5rem 0 1rem}
p{line-height:1.6;overflow-wrap:anywhere}#wallet-status{color:#172019;font-weight:700;min-height:3rem;margin:1.75rem 0;font-size:.95rem;position:relative}#wallet-status::before{content:"⚡\\FE0E";position:absolute;left:-1.05em;top:0;font-size:1.4em;line-height:1.143em;text-align:center;-webkit-text-stroke:.045em currentColor}#wallet-status[data-state=error]::before,#wallet-status[data-state=retry]::before{content:"!"}#wallet-status:empty::before{content:none}
#wallet-status[data-state=error],#wallet-status[data-state=retry]{color:#9c3028}#wallet-status a{color:inherit}fieldset{border:0;padding:0;margin:0 0 1.25rem}legend{color:#4b5a4e;font-size:.9rem;margin-bottom:.5rem}label.choice{display:flex;gap:.6rem;align-items:center;margin:.4rem 0}#wallet-networks-family{display:flex;gap:1.5rem;flex-wrap:wrap}#wallet-networks-family legend{width:100%}#wallet-networks{line-height:1.6}button.link{all:unset;cursor:pointer;text-decoration:underline;color:#4b5a4e;margin-left:.75rem;font-size:.9rem}.actions button.link{margin:0;padding:0;width:auto}button.link:hover:not(:disabled){color:#172019;background:none}#wallet-networks-form{margin:1.5rem 0 2rem}#wallet-networks-form .actions{margin-top:1.5rem}@keyframes spin{to{transform:rotate(360deg)}}#wallet-status[data-state=busy]::before,#wallet-status[data-state=loading]::before,#wallet-status[data-state=checking]::before,#wallet-status[data-state=returning]::before{content:"⚡\\FE0E";display:inline-block;animation:spin 1s steps(8) infinite}dl{margin:0 0 1.5rem}dt{font-size:.8rem;color:#53614f}dd{margin:.5rem 0 1.2rem;overflow-wrap:anywhere}
.actions{display:flex;flex-wrap:wrap;gap:1rem;align-items:baseline}button{min-height:3rem;padding:.75rem 1rem;font:inherit;border:1px solid #172019;border-radius:0;background:#172019;color:#fff;cursor:pointer;max-width:100%}
button.secondary{background:transparent;color:inherit}button:disabled{cursor:wait}button.link:disabled,button.secondary:disabled{opacity:.55}button:disabled:not(.link):not(.secondary){opacity:.55}@media(prefers-reduced-motion:reduce){button:disabled:not(.link):not(.secondary){animation:none}}button:hover:not(:disabled){background:#364532;color:white}button.secondary:hover:not(:disabled){background:#e8ece4;color:inherit}
:focus-visible{outline:3px solid #5275d1;outline-offset:4px}.note{font-size:.8rem;color:#53614f;margin-top:2rem}#wallet-links{display:flex;flex-wrap:wrap;gap:.75rem 1.5rem;margin-top:1.75rem}#wallet-links a{color:#4b5a4e;font-size:.9rem;text-underline-offset:.15em}#wallet-links a:hover{color:#172019}
.qr{width:min(100%,16rem);margin:1rem 0}.qr svg{width:100%;height:auto;display:block}#wallet-device h2{font-size:1.1rem;margin:1.5rem 0 .5rem}@media(max-width:40rem){main{padding-left:2.9rem;padding-right:2.9rem}#wallet-status::before{left:-1.25em}}@media(max-width:400px){main{padding:1.1rem 2.7rem}.actions{flex-direction:column;align-items:stretch}.actions button{width:100%}.actions button.link{width:auto;align-self:flex-start}}`;
}
