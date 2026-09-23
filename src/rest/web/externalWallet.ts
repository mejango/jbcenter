import { getAddress, isAddress, toHex, type Address, type Hex } from "viem";

export type Provider = {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
};

export class CenterWalletError extends Error {
  transactionHash?: Hex;
  broadcastState?: "unknown";
  constructor(message: string, public readonly code = -32000) { super(message); this.name = "CenterWalletError"; }
}

const node = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const json = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item, 2);
const rejected = () => new CenterWalletError("Sign-in or approval was canceled.", 4001);
const unsupported = () => new CenterWalletError("This wallet request is not supported.", 4200);
const walletFallbackIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true" focusable="false"><rect x="2.75" y="5.75" width="18.5" height="12.5" rx="2.25" /><path d="M2.75 9.25h18.5" stroke-linecap="round" /><circle cx="17.25" cy="14" r="1.15" fill="currentColor" stroke="none" /></svg>`;

let activeProvider: Provider | undefined;
let signInPending: Promise<Provider> | undefined;
let cancelSignIn: (() => void) | undefined;
const signInStorageKey = "juicebox-center.sign-in";
type ProviderSource = { type: "external"; rdns: string } | { type: "legacy" };
type RememberedSignIn = ProviderSource & { version: 1; owner: Address; chainId: number; walletChainId?: number };
const providerSources = new WeakMap<Provider, ProviderSource>();
const restoredIdentities = new WeakMap<Provider, { owner: Address; chainId: number; authorityChainId: number }>();
let authGeneration = 0;
let restorationSuppressed = false;
let restoring: Promise<Provider | undefined> | undefined;

function storeSignIn(value: unknown): void {
  try { window.localStorage.setItem(signInStorageKey, JSON.stringify(value)); }
  catch { /* Storage can be disabled; live sign-in and sign-out must still work. */ }
}

/** Keep the final page identity check bound to the exact wallet selected during restoration. */
export function restoredIdentityMatches(provider: Provider, owner: Address, chainId: number): boolean {
  const expected = restoredIdentities.get(provider);
  return provider === activeProvider && !!expected && expected.owner === owner && expected.chainId === chainId;
}

/** API account identity remains on its original authority chain while execution moves networks. */
export function restoredAuthorityChainId(provider: Provider, owner: Address, walletChainId: number): number | undefined {
  return restoredIdentityMatches(provider, owner, walletChainId) ? restoredIdentities.get(provider)!.authorityChainId : undefined;
}

/** Public discovery hints only. Live wallet identity is always checked again on reload. */
export function rememberSignIn(provider: Provider, owner: Address, chainId: number, walletChainId = chainId): void {
  if (provider !== activeProvider || !isAddress(owner) || !Number.isSafeInteger(chainId) || chainId < 1 ||
    !Number.isSafeInteger(walletChainId) || walletChainId < 1) return;
  const source = providerSources.get(provider);
  if (!source) {
    // An extension without a stable discovery ID must not accidentally restore an older wallet.
    restorationSuppressed = true; storeSignIn({ version: 1, signedOut: true }); return;
  }
  restorationSuppressed = false;
  storeSignIn({ version: 1, ...source, owner: getAddress(owner), chainId,
    ...(walletChainId === chainId ? {} : { walletChainId }) } satisfies RememberedSignIn);
}

/** Sign-out remains effective on reload, even when the wallet stays connected. */
export function forgetSignIn(): void {
  authGeneration++; restorationSuppressed = true; activeProvider = undefined;
  storeSignIn({ version: 1, signedOut: true });
}

function providerRdns(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value) || !value.includes(".")) return;
  return value.toLowerCase();
}

function rememberedSignIn(): RememberedSignIn | "suppressed" | undefined {
  try {
    const value = window.localStorage.getItem(signInStorageKey);
    if (value === null) return;
    const saved = record(JSON.parse(value));
    if (saved.version !== 1 || saved.signedOut === true || typeof saved.owner !== "string" || !isAddress(saved.owner) ||
      !Number.isSafeInteger(saved.chainId) || Number(saved.chainId) < 1) return "suppressed";
    const owner = getAddress(saved.owner), chainId = Number(saved.chainId), walletChainId = saved.walletChainId ?? chainId;
    if (!Number.isSafeInteger(walletChainId) || Number(walletChainId) < 1) return "suppressed";
    const identity = { version: 1 as const, owner, chainId, ...(walletChainId === chainId ? {} : { walletChainId: Number(walletChainId) }) };
    if (saved.type === "legacy") return { ...identity, type: "legacy" };
    const rdns = providerRdns(saved.rdns);
    if (saved.type === "external" && rdns) return { ...identity, type: "external", rdns };
    return "suppressed";
  } catch { return "suppressed"; }
}

async function restoreExternal(saved: RememberedSignIn, stillCurrent: () => boolean): Promise<Provider | undefined> {
  const candidates = new Map<Provider, string | undefined>();
  const announce = (event: Event) => {
    const detail = (event as CustomEvent<{ info?: { rdns?: unknown }; provider?: Provider }>).detail;
    if (detail?.provider && typeof detail.provider.request === "function" && candidates.size < 30)
      candidates.set(detail.provider, providerRdns(detail.info?.rdns));
  };
  window.addEventListener("eip6963:announceProvider", announce);
  try {
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    // Give extensions a short, bounded window to announce without ever requesting access.
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (!stillCurrent()) return;
    const injected = (window as unknown as { ethereum?: Provider }).ethereum;
    const legacyAlternatives = (injected as (Provider & { providers?: unknown[] }) | undefined)?.providers;
    const providers = saved.type === "external"
      ? [...candidates].filter(([, rdns]) => rdns === saved.rdns).map(([provider]) => provider)
      : injected && typeof injected.request === "function" && (!Array.isArray(legacyAlternatives) || legacyAlternatives.length <= 1) &&
        [...candidates.keys()].every((provider) => provider === injected) ? [injected] : [];
    if (providers.length !== 1) return;
    const provider = providers[0]!;
    const [accounts, chain] = await Promise.all([
      provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" }),
    ]);
    if (!stillCurrent() || !Array.isArray(accounts) || typeof accounts[0] !== "string" || !isAddress(accounts[0]) ||
      getAddress(accounts[0]) !== saved.owner || quantity(chain) !== BigInt(saved.walletChainId ?? saved.chainId)) return;
    providerSources.set(provider, saved.type === "external" ? { type: "external", rdns: saved.rdns } : { type: "legacy" });
    restoredIdentities.set(provider, { owner: saved.owner, chainId: saved.walletChainId ?? saved.chainId, authorityChainId: saved.chainId });
    return provider;
  } finally { window.removeEventListener("eip6963:announceProvider", announce); }
}

/** Restore access to an already connected wallet without a signature, popup or API mutation. */
export function restoreSignIn(): Promise<Provider | undefined> {
  if (restoring) return restoring;
  if (signInPending || restorationSuppressed) return Promise.resolve(undefined);
  const saved = rememberedSignIn();
  if (!saved || saved === "suppressed") return Promise.resolve(undefined);
  const generation = ++authGeneration;
  let expired = false;
  const stillCurrent = () => !expired && generation === authGeneration && !restorationSuppressed;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve, reject) => { timer = setTimeout(() => {
    const current = stillCurrent(); expired = true;
    if (current) reject(new CenterWalletError("Your sign-in could not be restored. Sign in to reconnect.", 4900)); else resolve(undefined);
  }, 6000); });
  const restore = restoreExternal(saved, stillCurrent).then((provider) => {
    if (!provider || !stillCurrent()) return;
    activeProvider = provider;
    return provider;
  }).catch((error: unknown): Provider | undefined => {
    if (!stillCurrent()) return;
    throw error instanceof CenterWalletError ? error : new CenterWalletError("Your sign-in could not be restored. Sign in to reconnect.", 4900);
  });
  const pending = Promise.race([restore, timeout]).finally(() => {
    expired = true; clearTimeout(timer); restoring = undefined;
  });
  restoring = pending;
  return pending;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unsupported();
  return value as Record<string, unknown>;
}
function quantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) throw unsupported();
  return BigInt(value);
}
/** Coordinate API authority signatures and execution on different networks for one live owner. */
export function walletNetworkSession(input: {
  provider: Provider; owner: Address; chainId: number; stillCurrent: () => boolean;
  onChain?: (chainId: number) => void;
}) {
  const owner = getAddress(input.owner), source = input.provider;
  let observedChain: number | undefined = input.chainId, validatedChain = input.chainId;
  let revision = 0, signing = false, switching = false, disposed = false;
  const unavailable = () => new CenterWalletError("The wallet account changed. Sign in again to continue.", 4900);
  const changed = () => new CenterWalletError("The wallet network changed during approval. Review the action again.", 4901);
  const check = () => { if (disposed || !input.stillCurrent()) throw unavailable(); };
  const networkId = (value: unknown) => {
    const id = Number(quantity(value));
    if (!Number.isSafeInteger(id) || id < 1) throw unsupported();
    return id;
  };
  const onNetwork = (value: unknown) => {
    let id: number | undefined;
    try { id = networkId(value); } catch { /* A malformed event invalidates pending approval too. */ }
    if (id === undefined || id !== observedChain) { revision++; observedChain = id; }
  };
  const onIdentity = () => { disposed = true; revision++; };
  source.on?.("chainChanged", onNetwork);
  source.on?.("accountsChanged", onIdentity); source.on?.("disconnect", onIdentity);
  const refresh = async (): Promise<number> => {
    check(); const before = revision;
    const [accounts, chain] = await Promise.all([
      source.request({ method: "eth_accounts" }), source.request({ method: "eth_chainId" }),
    ]);
    check();
    if (!Array.isArray(accounts) || typeof accounts[0] !== "string" || !isAddress(accounts[0]) || getAddress(accounts[0]) !== owner) throw unavailable();
    if (revision !== before) throw changed();
    const id = networkId(chain);
    if (observedChain !== id) { observedChain = id; revision++; }
    if (validatedChain !== id) { validatedChain = id; input.onChain?.(id); }
    check();
    return id;
  };
  const execution = async (chainId: number): Promise<Provider> => {
    check();
    if (signing || switching) throw new CenterWalletError("Finish the current approval before changing networks.");
    if (!Number.isSafeInteger(chainId) || chainId < 1) throw unsupported();
    switching = true;
    try {
      if (await refresh() !== chainId) {
        await source.request({ method: "wallet_switchEthereumChain", params: [{ chainId: toHex(chainId) }] });
        if (await refresh() !== chainId) throw new CenterWalletError("Switch to the requested network to continue.", 4902);
      }
      check(); return view(chainId);
    } finally { switching = false; }
  };
  const view = (expectedChainId?: number): Provider => ({
    on: (event, listener) => source.on?.(event, listener),
    removeListener: (event, listener) => source.removeListener?.(event, listener),
    async request(request) {
      check();
      // Capture the reviewed request before any live identity read can yield to its caller.
      const method = request.method;
      const params = JSON.parse(json(request.params ?? [])) as unknown[];
      if (method === "wallet_switchEthereumChain") {
        const target = networkId(record(params[0]).chainId);
        if (expectedChainId !== undefined && target !== expectedChainId) throw changed();
        await execution(target); return null;
      }
      if (!["eth_signTypedData_v4", "eth_sendTransaction"].includes(method)) {
        if (expectedChainId === undefined) return source.request({ method, params });
        if (await refresh() !== expectedChainId) throw changed();
        const before = revision;
        const result = await source.request({ method, params });
        if (await refresh() !== expectedChainId || before !== revision) throw changed();
        return result;
      }
      if (signing || switching) throw new CenterWalletError("Finish the current approval before starting another.");
      signing = true;
      let response: unknown;
      try {
        const chainId = await refresh(), before = revision;
        if (expectedChainId !== undefined && chainId !== expectedChainId) throw changed();
        if (method === "eth_signTypedData_v4") {
          if (params.length !== 2 || typeof params[0] !== "string" || getAddress(params[0]) !== owner) throw unsupported();
          const data = record(typeof params[1] === "string" ? JSON.parse(params[1]) : params[1]);
          if (BigInt(String(record(data.domain).chainId)) !== BigInt(chainId)) throw changed();
        } else {
          if (params.length !== 1) throw unsupported();
          const transaction = record(params[0]);
          if (typeof transaction.from !== "string" || getAddress(transaction.from) !== owner ||
            (transaction.chainId !== undefined && networkId(transaction.chainId) !== chainId)) throw unsupported();
          transaction.chainId = toHex(chainId);
        }
        check();
        if (before !== revision) throw changed();
        response = await source.request({ method, params });
        if (await refresh() !== chainId || before !== revision) throw changed();
        return response;
      } catch (error) {
        if (method === "eth_sendTransaction" && typeof response === "string" && /^0x[0-9a-fA-F]{64}$/.test(response)) {
          const uncertain = new CenterWalletError("The wallet changed after sending. Check the transaction receipt before trying again.");
          uncertain.transactionHash = response as Hex; uncertain.broadcastState = "unknown"; throw uncertain;
        }
        throw error;
      } finally { signing = false; }
    },
  });
  const provider = view();
  return { provider, execution, refresh, dispose() {
    disposed = true; revision++;
    source.removeListener?.("chainChanged", onNetwork);
    source.removeListener?.("accountsChanged", onIdentity); source.removeListener?.("disconnect", onIdentity);
  } };
}

export function signIn(): Promise<Provider> {
  if (signInPending) return signInPending;
  const generation = ++authGeneration;
  signInPending = showSignIn(generation).finally(() => { signInPending = undefined; });
  return signInPending;
}

async function showSignIn(generation: number): Promise<Provider> {
  const dialog = node<HTMLDialogElement>("external-wallet-dialog");
  if (!dialog) throw new CenterWalletError("Sign-in could not open. Refresh the page and try again.");
  const events = new AbortController();
  const listen = (target: EventTarget, event: string, listener: EventListener) => target.addEventListener(event, listener, { signal: events.signal });
  let finished = false, completing = false;
  const wallets = new Set<Provider>();
  const status = (message: string, error = false) => {
    const target = node("external-wallet-status"); target.textContent = message;
    target.dataset.error = String(error); target.hidden = !message;
  };
  node("external-wallet-wallets").replaceChildren();
  status("Choose a wallet. If none appear, open this page in a browser with a wallet.");
  dialog.showModal(); node<HTMLButtonElement>("external-wallet-close").focus();

  return new Promise<Provider>((resolve, reject) => {
    const finish = (provider?: Provider) => {
      if (finished) return;
      finished = true; events.abort(); cancelSignIn = undefined; dialog.close();
      if (provider && generation === authGeneration) { activeProvider = provider; resolve(provider); } else reject(rejected());
    };
    cancelSignIn = () => finish();
    listen(node("external-wallet-close"), "click", () => finish());
    listen(dialog, "cancel", (event) => { event.preventDefault(); finish(); });
    const discover = (name: string, provider: Provider, icon?: string, rdns?: string) => {
      if (rdns) providerSources.set(provider, { type: "external", rdns });
      else if (!providerSources.has(provider) && (window as unknown as { ethereum?: Provider }).ethereum === provider)
        providerSources.set(provider, { type: "legacy" });
      if (finished || wallets.size >= 30 || wallets.has(provider)) return;
      wallets.add(provider); status("");
      const button = document.createElement("button"); button.type = "button"; button.className = "quiet sign-in-icon";
      button.setAttribute("aria-label", name.slice(0, 100)); button.title = name.slice(0, 100);
      button.innerHTML = walletFallbackIcon;
      // Announced SVGs are untrusted: load only local image data, never insert their markup.
      if (typeof icon === "string" && icon.length <= 65536 && /^data:image\/(?:png|jpeg|gif|webp|svg\+xml)[;,]/i.test(icon)) {
        const image = document.createElement("img"); image.alt = ""; image.src = icon;
        listen(image, "error", () => { button.innerHTML = walletFallbackIcon; });
        button.replaceChildren(image);
      }
      listen(button, "click", () => {
        if (completing) return;
        button.disabled = true; completing = true;
        void provider.request({ method: "eth_requestAccounts" }).then(async (accounts) => {
          if (!Array.isArray(accounts) || typeof accounts[0] !== "string" || !isAddress(accounts[0])) throw unsupported();
          const chain = await provider.request({ method: "eth_chainId" }); quantity(chain);
          if (!finished) finish(provider);
        }).catch(() => {
          if (finished) return;
          status("The wallet did not connect. Unlock it and try again.", true); button.disabled = false; completing = false;
        });
      });
      node("external-wallet-wallets").append(button);
    };
    listen(window, "eip6963:announceProvider", ((event: CustomEvent<{ info?: { name?: string; icon?: string; rdns?: string }; provider?: Provider }>) => {
      const { info, provider } = event.detail ?? {};
      if (typeof info?.name === "string" && provider && typeof provider.request === "function") discover(info.name, provider, info.icon, providerRdns(info.rdns));
    }) as EventListener);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    const injected = (window as unknown as { ethereum?: Provider }).ethereum;
    if (injected && typeof injected.request === "function") discover("Browser wallet", injected);
  });
}

export async function signOut(): Promise<void> {
  forgetSignIn();
  cancelSignIn?.();
}
