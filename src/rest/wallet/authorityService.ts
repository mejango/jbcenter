import { RestError } from "../core.js";
import { walletAppAccount } from "./appGrants.js";
import { validateWalletAuthorityContext, validateWalletAuthorityObservation,
  type WalletAuthorityContext, type WalletAuthorityObservation, type WalletAuthoritySnapshot } from "./authority.js";

export interface WalletAuthorityServiceDependencies {
  store: {
    loadContext(accountId: string): Promise<WalletAuthorityContext>;
    reconcile(context: WalletAuthorityContext, observation: WalletAuthorityObservation): Promise<{
      snapshot: WalletAuthoritySnapshot; replayed: boolean;
    }>;
  };
  chain: { observe(context: WalletAuthorityContext, signal?: AbortSignal): Promise<WalletAuthorityObservation> };
}

/** Internal configured composition. This is neither a login nor a public grant issuer. */
export function createWalletAuthorityService(options: WalletAuthorityServiceDependencies) {
  const loadContext = options.store.loadContext.bind(options.store);
  const reconcile = options.store.reconcile.bind(options.store);
  const observe = options.chain.observe.bind(options.chain);
  const cancelled = (signal?: AbortSignal) => {
    if (signal?.aborted) throw new RestError(499, "WALLET_AUTHORITY_CANCELLED", "Authority refresh was cancelled.");
  };
  const invalidAccount = (): never => {
    throw new RestError(400, "WALLET_AUTHORITY_ACCOUNT_INVALID", "A canonical Base wallet account is required.");
  };
  return {
    async refreshAuthority(accountId: string, signal?: AbortSignal): Promise<{ snapshot: WalletAuthoritySnapshot; replayed: boolean }> {
      if (!walletAppAccount(accountId)) invalidAccount();
      cancelled(signal);
      // Validation produces a bounded private copy before any configured provider work.
      const context = validateWalletAuthorityContext(await loadContext(accountId));
      if (context.accountId !== accountId) invalidAccount();
      cancelled(signal);
      const observation = validateWalletAuthorityObservation(
        await observe(validateWalletAuthorityContext(context), signal), context,
      );
      // A completed observation can prove revoked authority. Persist that fact even if
      // its requester cancelled meanwhile; the store still checks revision and DB time.
      // Never reload/retry here: that could replace the captured logout/authority epochs.
      return reconcile(context, observation);
    },
  };
}
