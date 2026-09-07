# Browser smart wallets

The account page at `/accounts` uses `SmartAccountClient` for the authenticated
HTTP boundary and the pure helpers in `smartAccounts.ts` for local review and
signing. The same helpers can be used by another browser client. All protocol
call templates use V6.

Read `/api/v1/capabilities` using `readPublicRestJson` before presenting execution
as available. Each configured smart-account deployment publishes its reviewed
manifest. A public manifest is configuration supplied by this host; it is not
independent proof of current deployment. The server verifies current runtime and
account authority before accepting the dependent action. Provider configuration,
the deployed session guard, account inspection and sponsorship remain execution
prerequisites.

The page follows this sequence:

1. Select a hosted chain, connect its owner wallet and load the API account.
2. Prepare creation or enter an existing Safe. `verifyWalletCreation` reconstructs
   the exact factory call and predicted address from the published manifest,
   reviewed owners, threshold and salt. Creation uses an explicit wallet
   transaction. A transaction hash alone does not establish deployment.
3. Inspect the wallet and reconstruct the binding challenge with
   `smartBindingDocument`. Collect exactly the current EOA owner threshold with
   `packOwnerSignatures`; each owner signs the same document. Additional owners
   can sign the displayed public typed-data document externally.
4. Prepare a seven- or thirty-day policy for an active bot grant with relay scope.
   Its grant expiry must outlast the policy period. The UI starts a policy five
   minutes ahead and defaults new grants to 31 days. Only an explicitly selected
   isolated repeat-payment budget permits recurring fund movement.
5. Review the compiled policy and prepare its activation plan. Each new generation
   uses a fresh random nonce and distinct generation. Preparing a policy or plan
   does not activate it.
6. Prepare and review the operation. `assertReviewedOperation` compares its calls,
   values, order, chain, wallet and operation hash with the displayed plan.
   `ownerOperationSigning` reconstructs SafeOp using the manifest's adapter and
   EntryPoint and the preparation's exact validity window. Collect EIP712 owner
   signatures, then use `ownerOperationSignature` to create the threshold envelope.
7. For session execution, authenticate with a separate `SignedRestClient` using
   the registered bot signer and `grantId`. `signSessionUserOperation` checks the
   active session identity and signs the raw 32-byte operation hash using EIP191.
   It wraps that signature in the legacy SmartSession USE envelope. Signing the
   unprefixed digest or the printable hex text is incompatible with this validator.
8. Submit once and refresh operation, session and quota observations. Unknown
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
