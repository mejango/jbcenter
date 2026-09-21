# Browser continuity for wallet handoff

A public intent URL identifies a connection request. It does not authorize a browser to complete that request with whichever Center account is signed in. Without this boundary, someone holding a copied intent URL could issue a code from their own account and cause the original app tab to connect to that account.

The app signs a separate `WalletHandoffLaunch` EIP712 document with its locally retained request key. The message binds the exact intent ID and the typed-data digest of the complete original request. Request and exchange signatures cannot substitute for this proof.

`prepareConnection()` returns `launch()`. Calling it in the original app tab submits `intentId` and the launch signature in a hidden top-level form POST to the fixed issuer's `/wallet/launch`. No key, PKCE verifier or signature enters the URL. The public `authorizationUrl` remains a locator, and direct navigation cannot establish the launch claim.

The wallet checks its configured host, exact originating app, active callback policy, live prepared intent, separate signature and document navigation headers. The form body is bounded to 512 bytes and five seconds, with exactly one of each expected field. It then sets a Secure, HttpOnly, SameSite=Lax `__Host-center-wallet-launch` cookie for at most 330 seconds and redirects to the public intent URL. Database time still governs intent and code admission; the cookie cannot extend either deadline.

The central issue endpoint requires a claim for that exact intent and verifies it before looking up the session or requesting authority refresh. The durable store verifies the same proof outside account locks and compares its immutable request digest under the handoff lock. Successful issuance clears the browser claim. The original atomic code/session/grant and expiry checks remain in place.

One launch is active per browser cookie jar. A newer launch replaces the older claim. The older tab receives an explicit instruction to return to its app and reconnect; it cannot issue the newer tab's intent. A lost launch response can retry the same launch. A lost issue response still requires a fresh handoff instead of issuing another code for the consumed intent.

## Client integration

Use `const prepared = await wallet.prepareConnection(); prepared.launch();`. Preserve any existing cancellation and local-journal checks before calling `launch()`.

Pages that start or resume connections, including callbacks, need `Referrer-Policy: strict-origin`. This sends the app origin without its path or query. Browsers send `Origin: null` on cross-origin form POSTs under `no-referrer` and `same-origin`; those origins remain rejected. If the app has CSP `form-action`, include the fixed wallet issuer. The wallet origin retains its own self-only policy.

This changes no spending authority and adds no per-site consent prompt. Center's trusted-app allowlist remains the policy source. Pilot client flags stay disabled until production adapters and acceptance checks qualify them.

## Evidence

The regression first reproduced an unclaimed issue returning HTTP 200, then required HTTP 403 before any session or account work. Pure tests cover signature purpose, key, request and intent substitutions. PostgreSQL tests prove rejected claims leave the original intent prepared with no code or session binding.

Real Chromium and PostgreSQL tests use two independently enrolled wallets in separate browser contexts to reject the copied-URL attack and then complete the original app's connection. They also cover competing tabs, normal sign-in, signed app access, logout and a truncated committed login response. Chain readiness in these browser fixtures is explicitly synthetic; they do not qualify physical devices or funded consumer payments. Claude Fable 5.1 reviewed the implementation with no blocking findings; that is a model-assisted review, not a third-party audit certification. The complete repository release gate is separate from these focused checks.
