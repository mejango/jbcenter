import {
  createPublicClient, createWalletClient, formatEther, getAddress, hashTypedData, http,
  isAddress, keccak256, stringToHex, toHex,
  type Address, type Chain, type Hex, type LocalAccount, type TypedDataDefinition,
} from "viem";
import { mainnet, optimism, base, arbitrum, sepolia, optimismSepolia, baseSepolia, arbitrumSepolia } from "viem/chains";
import type ParaWeb from "@getpara/web-sdk";
import type { StateSnapshot, TOAuthMethod } from "@getpara/web-sdk";
import { buildRequestTypedData, type RequestClaims } from "../auth/signatures.js";
import { socialIcon, walletFallbackIcon } from "./signInIcons.js";

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

const chains = [mainnet, optimism, base, arbitrum, sepolia, optimismSepolia, baseSepolia, arbitrumSepolia] as const;
// Keep this list explicit: wallet network changes must never select a caller-supplied RPC.
const rpcHosts: Record<number, string> = {
  1: "ethereum-rpc.publicnode.com", 10: "optimism-rpc.publicnode.com", 8453: "base-rpc.publicnode.com",
  42161: "arbitrum-one-rpc.publicnode.com", 11155111: "ethereum-sepolia-rpc.publicnode.com",
  11155420: "optimism-sepolia-rpc.publicnode.com", 84532: "base-sepolia-rpc.publicnode.com",
  421614: "arbitrum-sepolia-rpc.publicnode.com",
};
const node = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const json = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item, 2);
const rejected = () => new CenterWalletError("Sign-in or approval was canceled.", 4001);
const unsupported = () => new CenterWalletError("This wallet request is not supported.", 4200);
// Para's Web SDK declarations import a CJS default base class as if it were ESM.
// Name that base explicitly under NodeNext; runtime inheritance is unchanged.
type ParaClient = ParaWeb & InstanceType<typeof import("@getpara/core-sdk").default>;
let para: ParaClient | undefined;
let paraLoading: Promise<ParaClient> | undefined;
let activeProvider: Provider | undefined;
let disconnectEmbedded: (() => void) | undefined;
let signInPending: Promise<Provider> | undefined;
let cancelSignIn: (() => Promise<void>) | undefined;
let cancelApproval: (() => void) | undefined;
let embeddedNetwork: { owner: Address; chainId: number } | undefined;
let reviewedRequest: { hash: Hex; body: unknown } | undefined;
const signInStorageKey = "juicebox-center.sign-in";
type ProviderSource = { type: "para" } | { type: "external"; rdns: string } | { type: "legacy" };
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
  if (source.type === "para" && [chainId, walletChainId].some((id) => !chains.some((entry) => entry.id === id))) return;
  restorationSuppressed = false;
  storeSignIn({ version: 1, ...source, owner: getAddress(owner), chainId,
    ...(walletChainId === chainId ? {} : { walletChainId }) } satisfies RememberedSignIn);
}

/** A durable opt-out also prevents an old SDK session restoring after failed remote logout. */
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
    if (saved.type === "para" && [chainId, Number(walletChainId)].every((id) => chains.some((entry) => entry.id === id))) return { ...identity, type: "para" };
    if (saved.type === "legacy") return { ...identity, type: "legacy" };
    const rdns = providerRdns(saved.rdns);
    if (saved.type === "external" && rdns) return { ...identity, type: "external", rdns };
    return "suppressed";
  } catch { return "suppressed"; }
}

function hasStoredParaSession(): boolean {
  // Para 3.15 persists this public user ID before a Center reconnect hint existed.
  // It only gates loading the SDK; it never proves an active session or wallet ownership.
  try { return !!window.localStorage.getItem("@CAPSULE/userId"); }
  catch { return false; }
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

/** Restore access to an already authenticated wallet without a signature, popup or API mutation. */
export function restoreSignIn(): Promise<Provider | undefined> {
  if (restoring) return restoring;
  if (signInPending || restorationSuppressed) return Promise.resolve(undefined);
  const saved = rememberedSignIn();
  if (saved === "suppressed" || (!saved && !hasStoredParaSession())) return Promise.resolve(undefined);
  const generation = ++authGeneration;
  let expired = false;
  const stillCurrent = () => !expired && generation === authGeneration && !restorationSuppressed;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopReadiness: (() => void) | undefined;
  const timeout = new Promise<undefined>((resolve, reject) => { timer = setTimeout(() => {
    const current = stillCurrent(); expired = true;
    if (current) reject(new CenterWalletError("Your sign-in could not be restored. Sign in to reconnect.", 4900)); else resolve(undefined);
  }, 6000); });
  const restore = (async (): Promise<Provider | undefined> => {
    let provider: Provider | undefined;
    if (saved && saved.type !== "para") provider = await restoreExternal(saved, stillCurrent);
    else {
      const client = await getPara();
      if (!stillCurrent()) return;
      if (!client.isReady) {
        // setup() can finish before the SDK's eager session check. Its false result before
        // readiness means "not checked yet", not an expired session.
        let finishReady: (ready: boolean) => void = () => {};
        const readiness = new Promise<boolean>((resolve) => { finishReady = resolve; });
        const unsubscribe = client.onReadyStateChange((ready) => { if (ready) finishReady(true); });
        stopReadiness = () => { unsubscribe(); finishReady(false); };
        if (!await readiness || !stillCurrent()) return;
        unsubscribe(); stopReadiness = undefined;
      }
      if (!stillCurrent() || !await client.isFullyLoggedIn() || !stillCurrent()) return;
      provider = await embeddedProvider(client, stillCurrent, { enrollmentFromSignIn: false,
        ...(saved ? { owner: saved.owner, chainId: saved.walletChainId ?? saved.chainId, authorityChainId: saved.chainId } : {}) });
    }
    if (!provider || !stillCurrent()) return;
    activeProvider = provider;
    return provider;
  })().catch((error: unknown): Provider | undefined => {
    if (!stillCurrent()) return;
    throw error instanceof CenterWalletError ? error : new CenterWalletError("Your sign-in could not be restored. Sign in to reconnect.", 4900);
  });
  const pending = Promise.race([restore, timeout]).finally(() => {
    expired = true; clearTimeout(timer); stopReadiness?.(); restoring = undefined;
  });
  restoring = pending;
  return pending;
}

/** Bind the visible API-access review to the exact request body that will be signed. */
export function setReviewedRequestBody(body: unknown): void {
  const serialized = JSON.stringify(body);
  reviewedRequest = { hash: keccak256(stringToHex(serialized)), body: JSON.parse(serialized) as unknown };
}

function configuration() {
  const apiKey = document.body.dataset.paraApiKey?.trim();
  const environment = document.body.dataset.paraEnvironment || "BETA";
  if (!apiKey || !["BETA", "PROD"].includes(environment))
    throw new CenterWalletError("Account sign-in is unavailable. Please try again later, or use an existing wallet.", 4900);
  return { apiKey, environment: environment as "BETA" | "PROD" };
}

async function getPara() {
  if (para) return para;
  if (!paraLoading) paraLoading = (async () => {
    const config = configuration();
    const { default: Para, Environment } = await import("@getpara/web-sdk");
    const client = new Para(Environment[config.environment], config.apiKey) as ParaClient;
    await client.setup();
    para = client;
    return client;
  })().catch(() => {
    paraLoading = undefined;
    throw new CenterWalletError("Account sign-in could not load. Check your connection and try again, or use an existing wallet.", 4900);
  });
  return paraLoading;
}

/** Portal navigation carries session material, so accept only the SDK's known origins. */
export function trustedParaUrl(value: string, environment: "BETA" | "PROD"): string {
  const url = new URL(value);
  const subdomain = environment === "BETA" ? "app.beta" : "app";
  if (url.protocol !== "https:" || url.username || url.password ||
    ![`${subdomain}.getpara.com`, `${subdomain}.usecapsule.com`].includes(url.host))
    throw new CenterWalletError("The secure sign-in page could not be verified. Please start again.");
  return url.href;
}

const portalTheme = () => ({
  backgroundColor: getComputedStyle(document.body).backgroundColor,
  foregroundColor: getComputedStyle(document.body).color,
  accentColor: "#779071", mode: "light" as const, borderRadius: "none" as const,
  cssOverrides: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, "Courier New", monospace' },
});

type Review = { title: string; description: string; summary: [string, string][]; details: unknown; confirm?: string };
async function review(input: Review): Promise<void> {
  if (cancelApproval) throw new CenterWalletError("Finish the open approval before starting another.");
  const dialog = node<HTMLDialogElement>("para-approval");
  node("para-approval-title").textContent = input.title;
  node("para-approval-description").textContent = input.description;
  node("para-approval-details").textContent = json(input.details);
  const summary = node("para-approval-summary"); summary.replaceChildren();
  for (const [label, value] of input.summary) {
    const dt = document.createElement("dt"), dd = document.createElement("dd");
    dt.textContent = label; dd.textContent = value; summary.append(dt, dd);
  }
  const approve = node<HTMLButtonElement>("para-approval-confirm"), cancel = node<HTMLButtonElement>("para-approval-cancel");
  approve.textContent = input.confirm ?? "Approve";
  return new Promise<void>((resolve, reject) => {
    const finish = (accepted: boolean) => {
      cancelApproval = undefined;
      approve.removeEventListener("click", onApprove); cancel.removeEventListener("click", onCancel);
      dialog.removeEventListener("cancel", onCancel); dialog.close();
      accepted ? resolve() : reject(rejected());
    };
    const onApprove = () => finish(true);
    const onCancel = (event?: Event) => { event?.preventDefault(); finish(false); };
    cancelApproval = onCancel;
    approve.addEventListener("click", onApprove); cancel.addEventListener("click", onCancel);
    dialog.addEventListener("cancel", onCancel); dialog.showModal(); cancel.focus();
  });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unsupported();
  return value as Record<string, unknown>;
}
function quantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) throw unsupported();
  return BigInt(value);
}
function typedDocument(value: unknown, chain: Chain): TypedDataDefinition {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : JSON.parse(json(value));
  const data = record(parsed), domain = record(data.domain);
  if (typeof data.primaryType !== "string" || BigInt(String(domain.chainId)) !== BigInt(chain.id)) throw unsupported();
  record(data.types); record(data.message);
  // Validation includes the type graph, field values and domain before showing an approval.
  hashTypedData(data as unknown as TypedDataDefinition);
  return data as unknown as TypedDataDefinition;
}

function exactEnrollment(data: TypedDataDefinition, address: Address, chainId: number, audience: string): boolean {
  try {
    const m = record(data.message), now = Math.floor(Date.now() / 1000);
    if (data.primaryType !== "CenterRequest" || m.audience !== audience || m.accountId !== `eip155:${chainId}:${address.toLowerCase()}` ||
      typeof m.signer !== "string" || getAddress(m.signer) !== address || m.method !== "POST" || m.requestTarget !== "/api/v1/accounts/enroll" ||
      m.grantId !== "" || m.contentType !== "application/json" || m.bodyHash !== keccak256(stringToHex("{}")) || m.idempotencyKey !== "" ||
      typeof m.nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(m.nonce) || Number(m.issuedAt) < now - 60 ||
      Number(m.issuedAt) > now + 10 || Number(m.expiresAt) <= now || Number(m.expiresAt) > now + 600) return false;
    const { audience: _audience, ...claims } = m;
    return hashTypedData(data) === hashTypedData(buildRequestTypedData(audience, {
      ...claims, issuedAt: Number(m.issuedAt), expiresAt: Number(m.expiresAt),
    } as RequestClaims));
  } catch { return false; }
}

function typedReview(data: TypedDataDefinition, owner: Address, chain: Chain): Review {
  const message = record(data.message);
  const summary: [string, string][] = [["Account", owner], ["Network", chain.name]];
  let title = "Approve signature", description = "Review this exact request before signing with your account.";
  if (data.primaryType === "CenterBotProof") {
    title = "Create API connection";
    description = "Allow this API key to use the permissions below. Sending transactions still requires your approval unless you separately enable automation.";
    summary.push(["Name", String(message.label)], ["Permissions", Array.isArray(message.scopes) ? message.scopes.join(", ") : String(message.scopes)], ["API key address", String(message.botAddress)]);
  } else if (data.primaryType === "CenterRequest") {
    title = "Approve API request";
    description = "Authorize this one request to Juicebox Center.";
    summary.push(["Request", `${String(message.method)} ${String(message.requestTarget)}`]);
    const reviewed = reviewedRequest;
    if (message.method === "POST" && message.requestTarget === "/api/v1/accounts/me/bots" && reviewed && reviewed.hash === message.bodyHash) {
      const proof = record(reviewed.body);
      title = "Create API connection";
      description = "Allow this API key to use the permissions below. Transaction approval and optional automation are managed separately.";
      summary.push(["Name", String(proof.label)], ["Permissions", Array.isArray(proof.scopes) ? proof.scopes.join(", ") : String(proof.scopes)],
        ["API key address", String(proof.botAddress)], ["Expires", new Date(Number(proof.expiresAt) * 1000).toLocaleString()]);
      return { title, description, summary, details: { signing: data, requestBody: reviewed.body } };
    }
  } else {
    summary.push(["Action", data.primaryType], ["Application", String(data.domain?.name ?? "Juicebox Center")]);
    if (data.domain?.verifyingContract) summary.push(["Contract", data.domain.verifyingContract]);
  }
  if (message.expiresAt !== undefined) {
    const expiry = new Date(Number(message.expiresAt) * 1000);
    if (!Number.isNaN(expiry.getTime())) summary.push(["Expires", expiry.toLocaleString()]);
  }
  return { title, description, summary, details: data };
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

/** The bridge owns a single current account and keeps approval in front of embedded signing. */
export function createEmbeddedProvider(input: {
  account: LocalAccount; isLoggedIn: () => Promise<boolean>; audience: string;
  confirm?: (value: Review) => Promise<void>; enrollmentFromSignIn?: boolean;
  initialChainId?: number; onChainChange?: (chainId: number) => void;
}): Provider & { disconnect(): void } {
  const address = getAddress(input.account.address);
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  let chain: Chain = chains.find((entry) => entry.id === (input.initialChainId ?? mainnet.id)) ?? mainnet;
  let disconnected = false, signing = false;
  const enrollmentUntil = input.enrollmentFromSignIn ? Date.now() + 60_000 : 0;
  let enrollmentUsed = false;
  const emit = (event: string, ...args: unknown[]) => { for (const listener of listeners.get(event) ?? []) listener(...args); };
  const disconnect = () => {
    if (disconnected) return;
    disconnected = true; cancelApproval?.(); emit("accountsChanged", []); emit("disconnect", { code: 4900 });
  };
  const assertSession = async () => {
    if (disconnected) throw new CenterWalletError("Sign in again to continue.", 4900);
    if (!await input.isLoggedIn()) { disconnect(); throw new CenterWalletError("Your sign-in expired. Sign in again to continue.", 4900); }
    if (disconnected) throw new CenterWalletError("Sign in again to continue.", 4900);
  };
  const confirm = input.confirm ?? review;
  const provider: Provider & { disconnect(): void } = {
    disconnect,
    on(event, listener) { let entries = listeners.get(event); if (!entries) listeners.set(event, entries = new Set()); entries.add(listener); },
    removeListener(event, listener) { listeners.get(event)?.delete(listener); },
    async request({ method, params = [] }) {
      if (method === "eth_chainId") return toHex(chain.id);
      await assertSession();
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [address];
      if (method === "wallet_switchEthereumChain") {
        if (signing) throw new CenterWalletError("Finish the current approval before changing networks.");
        const id = Number(quantity(record(params[0]).chainId));
        const next = chains.find((entry) => entry.id === id);
        if (!next) throw new CenterWalletError("This network is not supported.", 4902);
        if (chain.id !== next.id) { chain = next; input.onChainChange?.(chain.id); emit("chainChanged", toHex(chain.id)); }
        return null;
      }
      const rpc = `https://${rpcHosts[chain.id]}`;
      if (method === "eth_getTransactionReceipt") {
        if (typeof params[0] !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(params[0])) throw unsupported();
        return createPublicClient({ chain, transport: http(rpc) }).request({ method, params: [params[0] as Hex] });
      }
      if (!["eth_signTypedData_v4", "eth_sendTransaction"].includes(method)) throw unsupported();
      if (signing) throw new CenterWalletError("Finish the current approval before starting another.");
      signing = true;
      try {
        const reviewedChain = chain;
        if (method === "eth_signTypedData_v4") {
          if (params.length !== 2 || typeof params[0] !== "string" || getAddress(params[0]) !== address) throw unsupported();
          const data = typedDocument(params[1], reviewedChain);
          const automatic = !enrollmentUsed && Date.now() <= enrollmentUntil && exactEnrollment(data, address, chain.id, input.audience);
          enrollmentUsed = true;
          const requestReview = typedReview(data, address, reviewedChain);
          reviewedRequest = undefined;
          if (!automatic) await confirm(requestReview);
          await assertSession();
          if (chain !== reviewedChain) throw rejected();
          const signature = await input.account.signTypedData(data);
          await assertSession();
          if (chain !== reviewedChain) throw rejected();
          return signature;
        }
        if (params.length !== 1) throw unsupported();
        const raw = record(JSON.parse(json(params[0])));
        if (Object.keys(raw).some((key) => !["from", "to", "data", "value", "gas", "gasPrice", "maxFeePerGas", "maxPriorityFeePerGas", "nonce", "chainId"].includes(key)) ||
          typeof raw.from !== "string" || getAddress(raw.from) !== address || typeof raw.to !== "string" || !isAddress(raw.to) ||
          (raw.data !== undefined && (typeof raw.data !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(raw.data))) ||
          (raw.chainId !== undefined && quantity(raw.chainId) !== BigInt(chain.id))) throw unsupported();
        const wallet = createWalletClient({ account: input.account, chain: reviewedChain, transport: http(rpc) });
        const requested = {
          to: getAddress(raw.to), data: (raw.data ?? "0x") as Hex, value: raw.value === undefined ? 0n : quantity(raw.value),
          ...(raw.gas === undefined ? {} : { gas: quantity(raw.gas) }),
          ...(raw.nonce === undefined ? {} : { nonce: Number(quantity(raw.nonce)) }),
        };
        if (raw.gasPrice !== undefined && (raw.maxFeePerGas !== undefined || raw.maxPriorityFeePerGas !== undefined)) throw unsupported();
        const fees = raw.gasPrice === undefined ? {
          type: "eip1559" as const,
          ...(raw.maxFeePerGas === undefined ? {} : { maxFeePerGas: quantity(raw.maxFeePerGas) }),
          ...(raw.maxPriorityFeePerGas === undefined ? {} : { maxPriorityFeePerGas: quantity(raw.maxPriorityFeePerGas) }),
        } : { type: "legacy" as const, gasPrice: quantity(raw.gasPrice) };
        if (requested.nonce !== undefined && !Number.isSafeInteger(requested.nonce)) throw unsupported();
        const prepared = await wallet.prepareTransactionRequest({ ...requested, ...fees });
        const maxFee = prepared.gas * (prepared.maxFeePerGas ?? prepared.gasPrice ?? 0n);
        if (!prepared.gas || (!prepared.maxFeePerGas && !prepared.gasPrice)) throw new CenterWalletError("The network fee could not be estimated. Please try again.");
        const reviewed = { ...prepared, account: address };
        await confirm({ title: "Send transaction", description: `This transaction will be sent from your account. Review the destination, value and execution fee cap.${[10, 8453, 42161, 11155420, 84532, 421614].includes(chain.id) ? " Additional network data fees apply on this network." : ""}`,
          summary: [["From", address], ["Network", chain.name], ["To", requested.to], ["Value", `${formatEther(requested.value)} ETH`], ["Execution fee cap", `${formatEther(maxFee)} ETH`]],
          details: reviewed, confirm: "Approve and send" });
        await assertSession();
        if (chain !== reviewedChain) throw rejected();
        // The exact prepared fees, nonce, destination and bytes shown above are signed once.
        const serialized = await wallet.signTransaction(prepared);
        await assertSession();
        if (chain !== reviewedChain) throw rejected();
        const expectedHash = keccak256(serialized);
        try {
          const hash = await createPublicClient({ chain: reviewedChain, transport: http(rpc) }).sendRawTransaction({ serializedTransaction: serialized });
          if (hash.toLowerCase() !== expectedHash.toLowerCase()) throw new Error("Transaction hash mismatch");
          return hash;
        } catch {
          const error = new CenterWalletError("Submission could not be confirmed. Check the transaction receipt before trying again.");
          error.transactionHash = expectedHash; error.broadcastState = "unknown";
          throw error;
        }
      } finally { signing = false; }
    },
  };
  return provider;
}

async function embeddedProvider(client: ParaClient, stillCurrent: () => boolean, options: {
  enrollmentFromSignIn?: boolean; owner?: Address; chainId?: number; authorityChainId?: number;
} = { enrollmentFromSignIn: true }): Promise<Provider & { disconnect(): void }> {
  if (!await client.isFullyLoggedIn()) throw new CenterWalletError("Sign-in did not finish. Please try again.");
  const userId = client.userId;
  const wallet = (client.currentWalletIds.EVM ?? []).map((id) => client.getWallets()[id])
    .find((entry) => entry && entry.userId === userId && userId && entry.type === "EVM" && entry.address && isAddress(entry.address) &&
      (!options.owner || getAddress(entry.address) === options.owner));
  if (!wallet?.address) throw new CenterWalletError("Your account wallet is not ready. Please try again.");
  const { createParaViemAccount } = await import("@getpara/viem-v2-integration");
  const owner = getAddress(wallet.address);
  const sameSession = async () => {
    if (!await client.isFullyLoggedIn()) return false;
    const currentWallet = client.getWallets()[wallet.id];
    return !!currentWallet && client.userId === userId && !!client.currentWalletIds.EVM?.includes(wallet.id) && currentWallet.userId === userId &&
      typeof currentWallet.address === "string" && getAddress(currentWallet.address) === owner;
  };
  if (!await sameSession() || !stillCurrent()) throw rejected();
  disconnectEmbedded?.();
  if (options.chainId !== undefined && !chains.some((entry) => entry.id === options.chainId)) throw unsupported();
  if (embeddedNetwork?.owner !== owner || options.chainId !== undefined) embeddedNetwork = { owner, chainId: options.chainId ?? mainnet.id };
  const provider = createEmbeddedProvider({
    account: createParaViemAccount({ para: client, address: owner }),
    isLoggedIn: sameSession, audience: document.body.dataset.audience || window.location.origin,
    enrollmentFromSignIn: options.enrollmentFromSignIn ?? false, initialChainId: embeddedNetwork.chainId,
    onChainChange: (chainId) => { embeddedNetwork = { owner, chainId }; },
  });
  providerSources.set(provider, { type: "para" });
  if (!options.enrollmentFromSignIn) restoredIdentities.set(provider, { owner, chainId: embeddedNetwork.chainId,
    authorityChainId: options.authorityChainId ?? embeddedNetwork.chainId });
  disconnectEmbedded = () => provider.disconnect();
  return provider;
}

export function signIn(): Promise<Provider> {
  if (signInPending) return signInPending;
  const generation = ++authGeneration;
  signInPending = showSignIn(generation).finally(() => { signInPending = undefined; });
  return signInPending;
}

async function showSignIn(generation: number): Promise<Provider> {
  const dialog = node<HTMLDialogElement>("para-dialog");
  if (!dialog) throw new CenterWalletError("Sign-in could not open. Refresh the page and try again.");
  const events = new AbortController();
  const listen = (target: EventTarget, event: string, listener: EventListener) => target.addEventListener(event, listener, { signal: events.signal });
  let client: ParaClient | undefined, unsubscribe: (() => void) | undefined, finished = false, completing = false;
  let popup: Window | null = null, credentialUrl: string | undefined, started = false, canceling = false;
  let attempt = 0, authBusy = false;
  const wallets: { name: string; provider: Provider }[] = [];
  const show = (id: string, visible: boolean) => { node(id).hidden = !visible; };
  const status = (message: string, error = false) => { node("para-status").textContent = message; node("para-status").dataset.error = String(error); show("para-status", !!message); };
  const identifierAuth = () => {
    const value = node<HTMLInputElement>("para-identifier").value.trim(), phone = value.replace(/[\s().-]/g, "");
    const config = client?.config.authConfig;
    if (!config?.disableEmailLogin && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) return { email: value };
    if (!config?.disablePhoneLogin && /^\+\d{6,15}$/.test(phone)) return { phone: phone as `+${number}` };
  };
  const updateContinue = () => { node<HTMLButtonElement>("para-continue").disabled = authBusy || !client || !identifierAuth(); };
  const entryView = () => {
    show("para-entry", true); show("para-verify", false); show("para-credential", false); show("para-back", false);
    node<HTMLIFrameElement>("para-verification-frame").removeAttribute("src");
    node<HTMLInputElement>("para-code").value = "";
    credentialUrl = undefined; popup?.close(); popup = null;
    updateContinue();
  };
  const busy = (value: boolean) => {
    authBusy = value; updateContinue();
    for (const button of node("para-social").querySelectorAll("button")) button.disabled = value;
    node<HTMLButtonElement>("para-verify-code").disabled = value;
  };
  const openCredential = (value: string) => {
    credentialUrl = trustedParaUrl(value, configuration().environment);
    show("para-entry", false); show("para-verify", false); show("para-credential", true); show("para-back", true);
    if (popup && !popup.closed) { popup.location.replace(credentialUrl); popup.focus(); }
    else popup = window.open(credentialUrl, "CenterSignIn", "popup,width=440,height=640");
    status("Continue in the secure sign-in window.");
  };
  const credentialOf = (info: { passkeyUrl?: string | null; passwordUrl?: string | null; pinUrl?: string | null }) => info.passkeyUrl || info.passwordUrl || info.pinUrl;
  entryView(); node("para-social").replaceChildren(); show("para-social-group", false); node("para-wallets").replaceChildren(); show("para-external", false);
  node<HTMLInputElement>("para-identifier").value = "";
  status("");
  dialog.showModal(); node<HTMLInputElement>("para-identifier").focus();

  return new Promise<Provider>((resolve, reject) => {
    const finish = (provider?: Provider, error?: unknown) => {
      if (finished) return;
      finished = true; attempt++; events.abort(); unsubscribe?.(); popup?.close(); cancelSignIn = undefined;
      node<HTMLIFrameElement>("para-verification-frame").removeAttribute("src"); dialog.close();
      if (provider && generation === authGeneration) { activeProvider = provider; resolve(provider); } else reject(error ?? rejected());
    };
    const cancel = async () => {
      if (canceling || finished) return;
      canceling = true; attempt++;
      try { if (client && started) await client.cancelAuthFlow(); }
      catch { /* The local dialog and all its callbacks still need to be canceled. */ }
      finally { finish(); }
    };
    cancelSignIn = cancel;
    listen(node("para-close"), "click", () => { void cancel(); });
    listen(dialog, "cancel", (event) => { event.preventDefault(); void cancel(); });
    listen(node("para-back"), "click", () => {
      if (!client || canceling) return;
      attempt++; canceling = true;
      void client.cancelAuthFlow().then(() => {
        if (finished) return; started = false; entryView(); busy(false); status("");
      }).catch(() => status("The previous sign-in could not be canceled. Close this window and try again.", true)).finally(() => { canceling = false; });
    });
    const complete = async () => {
      if (finished || completing || canceling || !client) return;
      completing = true;
      const thisAttempt = attempt;
      try {
        const provider = await embeddedProvider(client, () => !finished && !canceling && thisAttempt === attempt && generation === authGeneration);
        if (!finished && !canceling && thisAttempt === attempt && generation === authGeneration) finish(provider); else provider.disconnect();
      }
      catch { status("Your account could not finish signing in. Please try again.", true); }
      finally { completing = false; }
    };
    const watchState = (snapshot: StateSnapshot) => {
      if (finished || canceling || !started) return;
      if (snapshot.corePhase === "authenticated") { void complete(); return; }
      const info = snapshot.authStateInfo;
      try {
        if (info.verificationUrl) {
          const url = trustedParaUrl(info.verificationUrl, configuration().environment);
          const frame = node<HTMLIFrameElement>("para-verification-frame");
          if (frame.getAttribute("src") !== url) frame.src = url;
          show("para-entry", false); show("para-credential", false); show("para-verify", true); show("para-verification-frame", true); show("para-code-form", false); show("para-back", true);
          node("para-verify-label").textContent = `Enter the code sent to ${node<HTMLInputElement>("para-identifier").value.trim()}.`;
          status("Check your email or phone for the verification code."); popup?.close(); popup = null;
        } else if (credentialOf(info)) {
          if (credentialOf(info) !== credentialUrl) openCredential(credentialOf(info)!);
        } else if (snapshot.authPhase === "awaiting_account_verification") {
          show("para-entry", false); show("para-credential", false); show("para-verify", true); show("para-verification-frame", false); show("para-code-form", true); show("para-back", true);
          busy(false); status("Enter the verification code sent to your email or phone."); node<HTMLInputElement>("para-code").focus();
        } else if (snapshot.error) { status("Sign-in did not complete. Try again or choose another method.", true); busy(false); }
      } catch { status("The secure sign-in page could not be verified. Close this window and try again.", true); }
    };
    const authenticate = async (operation: () => Promise<unknown>) => {
      if (!client || started) return;
      started = true; const thisAttempt = ++attempt; busy(true); status("Starting secure sign-in…");
      try { await operation(); if (!finished && thisAttempt === attempt) await complete(); }
      catch { if (!finished && thisAttempt === attempt) { started = false; busy(false); status("Sign-in did not complete. Try again or choose another method.", true); } }
    };
    listen(node("para-identifier"), "input", updateContinue);
    listen(node("para-identifier-form"), "submit", (event) => {
      event.preventDefault();
      if (!client || started) return;
      const auth = identifierAuth();
      if (!auth) {
        status("Enter a complete email address or a phone number with its country code, like +1.", true); return;
      }
      void authenticate(() => client!.authenticateWithEmailOrPhone({ auth, portalTheme: portalTheme() }));
    });
    listen(node("para-code-form"), "submit", (event) => {
      event.preventDefault(); if (!client || canceling) return;
      const code = node<HTMLInputElement>("para-code").value.trim(); if (!/^\d{6}$/.test(code)) return;
      // The credential URL is asynchronous; reserve the window during the actual click.
      popup = window.open("", "CenterSignIn", "popup,width=440,height=640");
      busy(true); const thisAttempt = attempt;
      void client.verifyNewAccount({ verificationCode: code, portalTheme: portalTheme() }).then(async (result) => {
        if (finished || thisAttempt !== attempt) return;
        const url = credentialOf(result); if (url) openCredential(url); else { popup?.close(); popup = null; }
        await client!.waitForWalletCreation({});
        if (!finished && thisAttempt === attempt) await complete();
      }).catch(() => { if (!finished && thisAttempt === attempt) { popup?.close(); popup = null; busy(false); status("The code could not be verified. Check it and try again.", true); } });
    });
    listen(node("para-open-credential"), "click", () => { if (credentialUrl) openCredential(credentialUrl); });
    listen(node("para-resend"), "click", () => {
      if (!client || canceling) return;
      const button = node<HTMLButtonElement>("para-resend"); button.disabled = true;
      void client.resendVerificationCode({}).then(() => status("A new verification code was sent.")).catch(() => status("The code could not be resent yet. Wait a moment and try again.", true)).finally(() => { button.disabled = false; });
    });

    const discover = (name: string, provider: Provider, icon?: string, rdns?: string) => {
      if (rdns) providerSources.set(provider, { type: "external", rdns });
      else if (!providerSources.has(provider) && (window as unknown as { ethereum?: Provider }).ethereum === provider)
        providerSources.set(provider, { type: "legacy" });
      if (finished || wallets.length >= 30 || wallets.some((wallet) => wallet.provider === provider)) return;
      wallets.push({ name, provider }); show("para-external", true);
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
        if (started || completing) return;
        button.disabled = true; completing = true;
        void provider.request({ method: "eth_requestAccounts" }).then(async (accounts) => {
          if (!Array.isArray(accounts) || typeof accounts[0] !== "string" || !isAddress(accounts[0])) throw unsupported();
          const chain = await provider.request({ method: "eth_chainId" }); quantity(chain);
          if (!finished) finish(provider);
        }).catch(() => { status("The wallet did not connect. Unlock it and try again.", true); button.disabled = false; completing = false; });
      });
      node("para-wallets").append(button);
    };
    listen(window, "eip6963:announceProvider", ((event: CustomEvent<{ info?: { name?: string; icon?: string; rdns?: string }; provider?: Provider }>) => {
      const { info, provider } = event.detail ?? {};
      if (typeof info?.name === "string" && provider && typeof provider.request === "function") discover(info.name, provider, info.icon, providerRdns(info.rdns));
    }) as EventListener);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    const injected = (window as unknown as { ethereum?: Provider }).ethereum;
    if (injected && typeof injected.request === "function") discover("Browser wallet", injected);

    void getPara().then(async (ready) => {
      if (finished) return;
      client = ready;
      if (await client.isFullyLoggedIn()) { if (!finished) await complete(); return; }
      if (finished) return;
      unsubscribe = client.onStatePhaseChange(watchState);
      const auth = client.config.authConfig;
      const methods: [TOAuthMethod, string][] = [["GOOGLE", "Google"], ["TWITTER", "X"], ["APPLE", "Apple"], ["DISCORD", "Discord"], ["FARCASTER", "Farcaster"], ["TELEGRAM", "Telegram"], ["FACEBOOK", "Facebook"]];
      for (const [method, label] of methods) {
        if (auth?.oAuthMethods && !auth.oAuthMethods.includes(method)) continue;
        const button = document.createElement("button"); button.type = "button"; button.className = "quiet sign-in-icon";
        button.setAttribute("aria-label", label); button.title = label; button.innerHTML = socialIcon(method);
        listen(button, "click", () => {
          void authenticate(() => client!.authenticateWithOAuth({ method, portalTheme: portalTheme(), redirectCallbacks: { onOAuthPopup: (opened) => { popup = opened; } } }));
        });
        node("para-social").append(button);
      }
      show("para-social-group", !!node("para-social").childElementCount);
      show("para-identifier-form", !(auth?.disableEmailLogin && auth?.disablePhoneLogin));
      busy(false);
    }).catch((error: unknown) => {
      if (finished) return;
      status(error instanceof CenterWalletError ? error.message : "Account sign-in could not load. Try again later or use an existing wallet.", true);
    });
  });
}

export async function signOut(): Promise<void> {
  // A sign-out intent invalidates local authority immediately, even if the remote logout fails.
  forgetSignIn();
  disconnectEmbedded?.(); disconnectEmbedded = undefined; activeProvider = undefined; embeddedNetwork = undefined; reviewedRequest = undefined;
  await cancelSignIn?.();
  cancelApproval?.();
  if (para) {
    try { await para.logout(); }
    catch { throw new CenterWalletError("Sign-out did not finish. Check your connection and try again.", 4900); }
  }
}
