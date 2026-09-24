/** Containment only: the wallet still enforces its exact Host, Origin and RP ID. */
export function createWalletHostMatcher(origins: readonly string[] = []) {
  const configured = origins.map(origin => {
    const url = new URL(origin);
    if (url.origin !== origin || !["http:", "https:"].includes(url.protocol))
      throw new Error("Wallet origins must be exact HTTP origins");
    return url;
  });
  return (host: string | undefined): boolean => {
    // Preserve the original rollout reservation, including requests on another port.
    if (host?.toLowerCase().split(":", 1)[0] === "wallet.juicebox.center") return true;
    if (!host || /[\s/@\\?#]/u.test(host)) return false;
    return configured.some(origin => {
      try {
        // The configured scheme determines its default port; explicit ports stay distinct.
        return new URL(`${origin.protocol}//${host}`).host === origin.host;
      } catch { return false; }
    });
  };
}
