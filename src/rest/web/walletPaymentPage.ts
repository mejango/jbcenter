/** Dedicated owner approval surface. Values are populated with textContent, never HTML. */
export function walletPaymentPage(base = '/wallet'): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="wallet-base" content="${base}"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Review payment | Juicebox</title>
<link rel="stylesheet" href="${base}/assets/wallet.css"><link rel="stylesheet" href="${base}/assets/wallet-payment.css">
<script type="module" src="${base}/assets/wallet-payment.js"></script></head>
<body><main><a class="brand" href="${base || '/'}">JUICEBOX CENTER</a><h1>Review payment</h1>
<p id="payment-status" role="status" aria-live="polite" aria-atomic="true" data-state="loading">Checking this payment…</p>
<section id="payment-review" aria-label="Payment details" hidden>
<p id="payment-amount" class="amount"></p><dl>
<dt>Juicebox project</dt><dd id="payment-project"></dd><dt>Network</dt><dd>Base</dd>
<dt>Requested by</dt><dd id="payment-app"></dd><dt>From your wallet</dt><dd id="payment-account"></dd>
<dt>Beneficiary</dt><dd id="payment-beneficiary"></dd><dt>Minimum project tokens (base units)</dt><dd id="payment-minimum"></dd>
<dt>Memo</dt><dd id="payment-memo" class="exact-text"></dd><dt>Execution fee ceiling</dt><dd id="payment-fee"></dd></dl>
<p class="note">Base data fees are not included in this ceiling.</p>
<details><summary>Payment details</summary><dl>
<dt>USDC contract</dt><dd id="payment-token"></dd><dt>Juicebox terminal</dt><dd id="payment-terminal"></dd>
<dt>Metadata</dt><dd id="payment-metadata"></dd><dt>Operation</dt><dd id="payment-operation"></dd>
<dt>Approval expires</dt><dd id="payment-expiry"></dd></dl></details></section>
<div class="actions"><button id="payment-approve" type="button" hidden>Approve payment</button>
<button id="payment-cancel" type="button" class="secondary" hidden>Decline payment</button>
<button id="payment-prompt-cancel" type="button" class="secondary" hidden>Cancel passkey prompt</button>
<button id="payment-retry" type="button" class="secondary" hidden>Check payment again</button>
<a id="payment-signin" class="action-link" hidden>Sign in with your passkey</a>
<a id="payment-return" class="action-link" hidden>Return to app</a></div>
<p class="note">Your passkey approves only this payment. The app submits it and checks the result.</p>
<noscript><p>Enable JavaScript to review and approve this payment.</p></noscript></main></body></html>`;
}

export function walletPaymentCss(): string {
  return `#payment-status{min-height:3rem;margin:1.75rem 0;color:#53614f}
#payment-status[data-state=error],#payment-status[data-state=unknown],#payment-status[data-state=expired]{color:#9c3028}
.amount{font-size:clamp(1.8rem,7vw,2.5rem);font-weight:700;margin:1.5rem 0}.exact-text{white-space:pre-wrap}
details{margin:1.5rem 0}summary{cursor:pointer;text-decoration:underline;line-height:1.5}details dl{margin-top:1rem}
.action-link{display:inline-flex;align-items:center;min-height:3rem;padding:.75rem 1rem;border:1px solid #172019;color:inherit;max-width:100%;overflow-wrap:anywhere}
@media(max-width:400px){.action-link{justify-content:center;width:100%}}`;
}
