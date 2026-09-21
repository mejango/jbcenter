/** The ceiling on any application's configured grant lifetime (90 days); the default is an hour.
 * Dependency-free: the browser wallet client validates grant documents against the same bound. */
export const walletAppGrantMaximumLifetimeSeconds = 7_776_000;
export const walletAppGrantDefaultLifetimeSeconds = 3600;
