# Browser smart wallets

The account page at `/accounts` uses `SmartAccountClient` for the authenticated
HTTP boundary and the pure helpers in `smartAccounts.ts` for local review and
signing. The same helpers can be used by another browser client. All protocol
call templates use V6.

Read `/api/v1/capabilities` using `readPublicRestJson` before presenting execution
as available. Each configured smart-account deployment publishes its reviewed
manifest. A public manifest is configuration supplied by this host; it is not
independent proof of current deployment. The server verifies current runtime and
account authority before accepting the dependent action. Owner execution requires
a configured provider and supported account inspection. Sponsored gas requires a
configured paymaster. Neither requires a bot grant or a deployed session guard.

The page follows this sequence:

1. Connect the owner wallet and load the API account. The page automatically reads
   public capabilities and selects a deployment on the connected chain. This
   discovery does not request a signature. Hosted configuration can be refreshed
   explicitly if it fails or the operator changes it.
2. Prepare creation or enter an existing Safe. `verifyWalletCreation` reconstructs
   the exact factory call and predicted address from the published manifest,
   reviewed owners, threshold and salt. Creation uses an explicit wallet
   transaction. A transaction hash alone does not establish deployment.
3. Inspect the wallet and reconstruct the binding challenge with
   `smartBindingDocument`. Collect exactly the current EOA owner threshold with
   `packOwnerSignatures`; each owner signs the same document. Additional owners
   can sign the displayed public typed-data document externally.
4. Prepare a V6 action and review the operation. `assertReviewedOperation` compares its calls,
   values, order, chain, wallet and operation hash with the displayed plan.
   `ownerOperationSigning` reconstructs SafeOp using the manifest's adapter and
   EntryPoint and the preparation's exact validity window. Collect EIP712 owner
   signatures, then use `ownerOperationSignature` to create the threshold envelope.
5. Submit once and refresh operation observations. Unknown submission outcomes
   are not automatically retried. If a client deliberately retries, retain the
   original idempotency key and exact signature.

Fresh owner approval is the default. The page keeps multisig fields, hosted
configuration and step selection in native disclosure controls. It selects all
plan calls by default. Review, signing and submission remain explicit actions.
For modeled payments and cash outs, choose one plan step at a time to verify its
financial outcome. A multi-call batch can confirm invocation while leaving those
outcomes unverified. Keep the complete reviewed lifecycle plan selected for
activation and revocation.
Creating a wallet still costs owner-paid gas; sponsored execution is a separate
step after the wallet is deployed and bound.

Optional bot wallet permissions appear only when `sessions.activationReady` is
true and `sessions.configuredChainIds` contains the connected chain. Missing or
unavailable capability information hides the session setup, action templates and
signing-authority selector and keeps fresh owner approval selected. If capability
refresh withdraws delegation, the page clears the local bot key and pending
operation signatures. API bot authentication alone does not authorize spending.

When delegation is available:

1. Prepare a seven- or thirty-day policy for an active bot grant with relay scope.
   Its grant expiry must outlast the policy period. The UI starts a policy five
   minutes ahead. Only an explicitly selected isolated repeat-payment budget
   permits recurring fund movement. The current policy implementation supports
   exactly these two durations; they are optional delegation choices, not API
   account or owner-execution requirements.
2. Review the compiled policy and prepare its activation plan. Each new generation
   uses a fresh random nonce and distinct generation. Preparing a policy or plan
   does not activate it. Review, sign and submit activation as an owner operation,
   then refresh the session to verify onchain activation.
3. Authenticate with a separate `SignedRestClient` using
   the registered bot signer and `grantId`. `signSessionUserOperation` checks the
   active session identity and signs the raw 32-byte operation hash using EIP191.
   It wraps that signature in the legacy SmartSession USE envelope. Signing the
   unprefixed digest or the printable hex text is incompatible with this validator.
4. Submit once and refresh operation, session and quota observations. Unknown
   submission outcomes are not automatically retried. If a client deliberately
   retries, retain the original idempotency key and exact signature. Revocation
   requires another fresh owner plan and confirmation, including after expiry.

`sessionActionPlanInput` creates a concrete metadata, V6 payment or ERC20 transfer
input from one reviewed action. ERC20 transfers need a matching verified contract
catalog ID. ERC20 payments need a separately owner-approved finite terminal
allowance. API verification and current limits still apply to every template.

The UI loads bot-key files into a closure only. It sends public fields and
signatures to the API, never the key. It does not persist imported keys in browser
storage or put them in the DOM. Disconnecting, clearing the key, changing signing
authority or switching sessions invalidates pending operation signatures.

Validation lives in `test/rest-smart-client.test.ts` and
`test/rest-smart-web.test.ts`: real cryptographic signatures, signed HTTP mocks,
the actual browser controller with a small DOM event harness, and a browser
bundle build. These checks do not constitute live bundler, paymaster or deployed
guard verification.
