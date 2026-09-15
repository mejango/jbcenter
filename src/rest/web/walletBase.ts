/** Where the wallet pages are mounted on this host: '' on the dedicated host, '/wallet' otherwise. */
export const base = document.querySelector('meta[name="wallet-base"]')?.getAttribute('content') ?? '/wallet';
