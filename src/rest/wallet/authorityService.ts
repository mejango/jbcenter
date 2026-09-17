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
    get?(accountId: string): Promise<WalletAuthoritySnapshot | null>;
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
    /** The stored snapshot for readiness views. It never observes the chain; the worker does. */
    async currentAuthority(accountId: string): Promise<WalletAuthoritySnapshot | null> {
      if (!walletAppAccount(accountId)) invalidAccount();
      return options.store.get ? options.store.get(accountId) : null;
    },
    async refreshAuthority(accountId: string, signal?: AbortSignal): Promise<{ snapshot: WalletAuthoritySnapshot; replayed: boolean; catchingUp?: true }> {
      if (!walletAppAccount(accountId)) invalidAccount();
      cancelled(signal);
      // Validation produces a bounded private copy before any configured provider work.
      const context = validateWalletAuthorityContext(await loadContext(accountId));
      if (context.accountId !== accountId) invalidAccount();
      cancelled(signal);
      const observation = validateWalletAuthorityObservation(
        await observe(validateWalletAuthorityContext(context), signal), context,
      );
      // A staged history catch-up carries no head and proves nothing about the account: the verified
      // identity on record stays as it is (storing the stage would read as `unknown` and refuse
      // sign-in until the last stage). Before any verified observation the stage is stored as before.
      if (observation.reason === "authority-history-catching-up" && observation.head === null && context.prior?.readiness === "verified")
        return { snapshot: context.prior, replayed: true, catchingUp: true };
      // A completed observation can prove revoked authority. Persist that fact even if
      // its requester cancelled meanwhile; the store still checks revision and DB time.
      // Never reload/retry here: that could replace the captured logout/authority epochs.
      return reconcile(context, observation);
    },
  };
}
