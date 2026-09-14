# Local wallet signup

Center can compose the existing passkey enrollment, deployment, canonical setup and
fresh sign-in services into one resumable browser journey at `/wallet/create`.
This checkpoint supports the unforked local pilot. It does not enable production
Base deployment or replace a lost passkey.

The browser lets the user name a discoverable P-256 passkey. An independent EOA
recovery wallet must separately sign the exact enrollment. The threshold-one Safe
has two full owners: the passkey signer and that EOA. Neither an email address nor
a browser API key substitutes for either owner.

## Sequence and recovery

1. The server selects the RP, origin and pinned creation manifest. An enrollment
   and hashed continuation token commit together. Registration expires in five
   minutes by default; the continuation lasts thirty minutes.
2. Native registration creates an unverified candidate. A fresh possession proof
   and the EOA's typed enrollment signature verify that exact candidate and Safe.
3. A separate passkey approval claims the exact deployment. The existing worker
   preserves signed bytes, sender nonce, accounting reservation and settlement
   evidence across retries. Polling never creates a replacement transaction.
4. Once canonical settlement proves the wallet exists, the user approves initial
   browser setup. Its separate key proves possession and receives only read,
   plan and relay access for one hour. It cannot approve spending.
5. A separate fresh W6 login establishes the central session. Enrollment, signup
   continuation and setup completion never act as login credentials.

The browser retries the same pending completion after an uncertain response.
Reloading reads durable state. Losing the signup cookie requires a fresh
`signup-resume` assertion: the opaque user handle locates the enrollment but the
matching P-256 signature authorizes rotation of its continuation token. Exact
retries return the original rotation; an older rotation cannot supersede a newer
one. Verified enrollment can resume after its original deadline. Expired,
unverified enrollment cannot be renewed; the explicit restart action only clears
that expired continuation and requires a new registration.

This is **signup continuation**, not lost-passkey recovery. Owner replacement
still requires immutable replacement lineage, a new-key possession proof,
independent recovery-owner approval, canonical Safe owner-rotation evidence and
invalidation of old credentials, sessions and grants. The original genesis must
remain unchanged.

## Composition and observation

`createRestRuntime.localWalletSignup` accepts an explicit host-side factory after
the smart-account service is constructed. It receives the shared pool, configured
RPC, wallet runtime and smart-account service. The host must supply a qualified
local signer, deployment transport, settlement observer and initialized local
allocation to `createLocalWalletSignup`. There is no environment flag or request
field that constructs treasury authority or enables production broadcast.

The runtime mounts signup only when that factory is provided, and starts/stops its
worker with maintenance. Normal Center startup and Para compatibility remain
available. Public wallet discovery preserves the installed SDK's exact schema.

Signup uses distinct `__Host-` HttpOnly, Secure, SameSite cookies. Central POSTs
require exact Host/Origin, the wallet request header and cookie-bound CSRF for
existing flows. Bodies, credentials, row admission, cleanup and worker passes are
bounded. Trusted-app CORS does not confer central cookie access. Public responses
contain explicit journey views, never storage rows or signed treasury bytes.

The worker's optional event hook reports stage, outcome, operation ID and elapsed
time. Observation errors cannot undo authority. Do not log assertions, cookie
tokens, browser private keys or raw request bodies.

## Evidence

Run `npm run check` with Node 22.23.1, PostgreSQL 16 via `TEST_DATABASE_URL`, the
pinned browser installation, and Foundry available. The required catalog includes
the signup PostgreSQL, HTTP-boundary and joined EVM/browser suites.

The joined suite uses three distinct users, real HTTP handlers, PostgreSQL,
unforked Anvil, a virtual browser authenticator and an independent test EOA. It
checks prompt cancellation, lost registration/setup responses, cookie loss,
continuation rotation, unchanged wallet identity, canonical deployment/setup,
fresh login, and a 320px viewport. Sanitized results and screenshots are written
to `.generated/wallet-observations/signup-browser/`; release evidence is written
to `.generated/checks/<run-id>/summary.json` with a source fingerprint.

Production testing still needs a qualified Base fee/settlement provider,
non-rollback accounting and restore evidence, deployment funding controls,
production RP/device observations, owner replacement and a joined Homerun
payment test against the configured service. Local test-chain success does not
establish those properties.
