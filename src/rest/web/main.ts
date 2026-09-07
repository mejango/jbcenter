import { getAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyBotProof } from "../auth/signatures.js";
import type { Account, BotGrant, BotScope } from "../auth/store.js";
import {
  SignedRestClient, accountIdFor, createBotRegistration, newRequestNonce, parseBotRegistration,
  type BotRegistration, type RestSigner, type TypedDocument,
} from "../client/index.js";

type Provider = {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
};
type Wallet = { id: string; name: string; provider: Provider };
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const button = (id: string) => element<HTMLButtonElement>(id);
const input = (id: string) => element<HTMLInputElement>(id);
const wallets: Wallet[] = [];
const audience = document.body.dataset.audience || window.location.origin;
let current: { provider: Provider; owner: Address; chainId: number; accountId: string; client: SignedRestClient } | undefined;
let pending: BotRegistration | undefined;
let reviewed: BotRegistration | undefined;
let busy = false;

function status(message: string, error = false) {
  const node = element("status"); node.textContent = message; node.dataset.error = String(error);
  if (error) node.scrollIntoView({ block: "nearest" });
}
function active() { if (!current) throw new Error("Connect the owner wallet first."); return current; }
function accountReady(ready: boolean) {
  element<HTMLFieldSetElement>("profile-fields").disabled = !ready;
  element<HTMLFieldSetElement>("bot-fields").disabled = !ready;
  button("refresh-bots").disabled = !ready;
}
function reset() {
  if (current) {
    current.provider.removeListener?.("accountsChanged", reset);
    current.provider.removeListener?.("chainChanged", reset);
    current.provider.removeListener?.("disconnect", reset);
  }
  current = undefined; pending = undefined; reviewed = undefined; accountReady(false);
  button("enroll").disabled = true; button("refresh").disabled = true;
  button("disconnect").hidden = true; button("register-generated").disabled = true;
  button("register-proof").hidden = true; element("proof-preview").hidden = true;
  element("pending-bot").textContent = ""; element("identity").textContent = "Connect a wallet to enroll or manage your account.";
  element<HTMLTextAreaElement>("registration-json").value = "";
  input("display-name").value = ""; element<HTMLTextAreaElement>("bio").value = ""; input("avatar-uri").value = "";
  element("bot-list").replaceChildren(); status("Wallet connection cleared. Connect again to continue.");
}
async function run(operation: () => Promise<void>) {
  if (busy) return;
  busy = true; document.body.setAttribute("aria-busy", "true");
  try { await operation(); }
  catch (error) { status(error instanceof Error && error.name === "RestClientError" ? error.message : "The action did not complete. Check your wallet and connection, then try again.", true); }
  finally { busy = false; document.body.removeAttribute("aria-busy"); }
}
function discover(wallet: Wallet) {
  if (wallets.some((entry) => entry.provider === wallet.provider || entry.id === wallet.id)) return;
  wallets.push(wallet);
  const select = element<HTMLSelectElement>("wallets"); select.replaceChildren();
  for (const entry of wallets) { const option = document.createElement("option"); option.value = entry.id; option.textContent = entry.name; select.append(option); }
}
window.addEventListener("eip6963:announceProvider", ((event: CustomEvent<{ info: { uuid: string; name: string }; provider: Provider }>) => {
  const detail = event.detail;
  if (detail?.provider && typeof detail.provider.request === "function" && typeof detail.info?.uuid === "string" && typeof detail.info.name === "string" && wallets.length < 30) {
    discover({ id: detail.info.uuid.slice(0, 100), name: detail.info.name.slice(0, 100), provider: detail.provider });
  }
}) as EventListener);
window.dispatchEvent(new Event("eip6963:requestProvider"));
const legacy = (window as unknown as { ethereum?: Provider }).ethereum;
if (legacy && typeof legacy.request === "function") discover({ id: "injected", name: "Browser wallet", provider: legacy });
if (!wallets.length) element<HTMLSelectElement>("wallets").options[0]!.textContent = "Install or unlock a wallet";

async function walletTypedSignature(provider: Provider, owner: Address, chainId: number, typedData: TypedDocument): Promise<Hex> {
  const accounts = await provider.request({ method: "eth_accounts" });
  const chain = await provider.request({ method: "eth_chainId" });
  if (!Array.isArray(accounts) || !accounts.some((address) => typeof address === "string" && address.toLowerCase() === owner.toLowerCase()) || Number(chain) !== chainId) {
    reset(); throw new Error("Wallet account or chain changed.");
  }
  const domainTypes = [
    { name: "name", type: "string" }, { name: "version", type: "string" },
    { name: "chainId", type: "uint256" }, { name: "salt", type: "bytes32" },
  ];
  const wireDocument = { ...typedData, types: { EIP712Domain: domainTypes, ...typedData.types } };
  const signature = await provider.request({ method: "eth_signTypedData_v4", params: [owner, JSON.stringify(wireDocument, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)] });
  if (typeof signature !== "string" || !/^0x(?:[0-9a-fA-F]{2}){1,8192}$/.test(signature)) throw new Error("Wallet returned an invalid signature.");
  // Never use an in-flight signature after a wallet identity change.
  if (current?.provider !== provider || current.owner !== owner || current.chainId !== chainId) throw new Error("Wallet connection changed.");
  return signature as Hex;
}
button("connect").addEventListener("click", () => void run(async () => {
  const wallet = wallets.find((item) => item.id === element<HTMLSelectElement>("wallets").value);
  if (!wallet) throw new Error("No wallet found.");
  const accounts = await wallet.provider.request({ method: "eth_requestAccounts" });
  const chain = await wallet.provider.request({ method: "eth_chainId" });
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string" || typeof chain !== "string" || !/^0x[0-9a-fA-F]+$/.test(chain)) throw new Error("Invalid wallet identity.");
  const owner = getAddress(accounts[0]); const chainId = Number(chain); const accountId = accountIdFor(owner, chainId);
  reset();
  const signer: RestSigner = { address: owner, signTypedData: (data) => walletTypedSignature(wallet.provider, owner, chainId, data) };
  current = { provider: wallet.provider, owner, chainId, accountId, client: new SignedRestClient({ audience, accountId, signer }) };
  for (const event of ["accountsChanged", "chainChanged", "disconnect"]) wallet.provider.on?.(event, reset);
  element("identity").textContent = accountId; button("enroll").disabled = false; button("refresh").disabled = false; button("disconnect").hidden = false;
  status("Wallet connected. Enroll a new account or load your existing account.");
}));
button("disconnect").addEventListener("click", reset);
function showAccount(account: Account) {
  if (account.id !== active().accountId) throw new Error("Unexpected account identity.");
  input("display-name").value = account.profile.displayName; element<HTMLTextAreaElement>("bio").value = account.profile.bio; input("avatar-uri").value = account.profile.avatarUri ?? "";
  accountReady(true); status("Account loaded. Each change requires a wallet signature.");
}
button("enroll").addEventListener("click", () => void run(async () => {
  status("Approve account enrollment in your wallet.");
  const result = await active().client.request<{ account: Account }>({ method: "POST", requestTarget: "/api/v1/accounts/enroll", json: {} }); showAccount(result.account);
}));
button("refresh").addEventListener("click", () => void run(async () => {
  status("Approve the account read in your wallet.");
  const result = await active().client.request<{ account: Account }>({ requestTarget: "/api/v1/accounts/me" }); showAccount(result.account);
}));
element<HTMLFormElement>("profile-form").addEventListener("submit", (event) => {
  event.preventDefault(); void run(async () => {
    const profile = { displayName: input("display-name").value, bio: element<HTMLTextAreaElement>("bio").value, avatarUri: input("avatar-uri").value || null };
    status("Approve the profile change in your wallet.");
    const result = await active().client.request<{ account: Account }>({ method: "PATCH", requestTarget: "/api/v1/accounts/me", json: profile }); showAccount(result.account); status("Profile saved.");
  });
});
function botSettings() {
  const days = Number(input("bot-days").value);
  const profiles: Record<string, BotScope[]> = { read: ["read"], plan: ["read", "plan"], relay: ["read", "plan", "relay"] };
  const scopes = profiles[element<HTMLSelectElement>("bot-permissions").value];
  if (!Number.isSafeInteger(days) || days < 1 || days > 365 || !scopes) throw new Error("Choose a valid expiration and permission profile.");
  return { scopes, label: input("bot-label").value, expiresAt: Math.floor(Date.now() / 1000) + days * 86400, ownerRequestNonce: newRequestNonce(), accountId: active().accountId };
}
function download(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
button("generate-bot").addEventListener("click", () => void run(async () => {
  if (pending) { status("Register the downloaded bot before generating another key.", true); return; }
  const settings = botSettings();
  // Private key exists only inside this action. It is never put in DOM, storage, or a request.
  const privateKey = generatePrivateKey(); const signer = privateKeyToAccount(privateKey);
  const registration = await createBotRegistration(audience, { ...settings, botAddress: signer.address }, signer);
  download(`juicebox-bot-${signer.address.toLowerCase()}.json`, { format: "juicebox-center-bot-key-v1", botAddress: signer.address, privateKey });
  pending = registration; button("register-generated").disabled = false;
  element("pending-bot").textContent = `Downloaded key for ${signer.address}. Permissions: ${settings.scopes.join(", ")}. Expires ${new Date(settings.expiresAt * 1000).toISOString()}.`;
  status("Save the downloaded private key, then register this bot. The key cannot be downloaded again here.");
}));
async function register(document: BotRegistration) {
  const connection = active();
  if (document.audience !== audience || document.accountId !== connection.accountId) throw new Error("Registration belongs to another account or service.");
  await verifyBotProof(audience, { accountId: document.accountId, ownerRequestNonce: document.ownerRequestNonce, ...document.registration }, document.registration.proofSignature);
  status("Review the bot details and approve registration in your wallet.");
  const { bot } = await connection.client.request<{ bot: BotGrant }>({
    method: "POST", requestTarget: "/api/v1/accounts/me/bots", json: document.registration, nonce: document.ownerRequestNonce,
  });
  renderBots([bot]); status(`Bot registered. Grant ID: ${bot.id}. Save this public ID for CLI requests.`);
}
button("register-generated").addEventListener("click", () => void run(async () => {
  if (!pending) return; const proof = pending;
  // A consumed nonce cannot be retried. The downloaded key can make a fresh proof via CLI.
  pending = undefined; button("register-generated").disabled = true;
  await register(proof); element("pending-bot").textContent = "Registered. Keep the downloaded key private.";
}));
button("proof-request").addEventListener("click", () => void run(async () => {
  const settings = botSettings();
  download("juicebox-bot-proof-request.json", { format: "juicebox-center-bot-proof-request-v1", audience, ...settings });
  status("Public proof request downloaded. Run center.mjs proof with your private key file, then paste only the registration JSON.");
}));
button("review-proof").addEventListener("click", () => void run(async () => {
  reviewed = undefined; button("register-proof").hidden = true;
  const raw = element<HTMLTextAreaElement>("registration-json").value;
  if (raw.length > 16 * 1024) throw new Error("Registration document is too large.");
  const parsed = parseBotRegistration(JSON.parse(raw));
  if (parsed.accountId !== active().accountId || parsed.audience !== audience) throw new Error("Registration account or service does not match.");
  await verifyBotProof(audience, { accountId: parsed.accountId, ownerRequestNonce: parsed.ownerRequestNonce, ...parsed.registration }, parsed.registration.proofSignature);
  const { botAddress, scopes, expiresAt, label } = parsed.registration;
  if (expiresAt <= Math.floor(Date.now() / 1000)) throw new Error("Bot proof is expired.");
  element("proof-preview").textContent = JSON.stringify({ accountId: parsed.accountId, botAddress, scopes, label, expires: new Date(expiresAt * 1000).toISOString() }, null, 2);
  element("proof-preview").hidden = false; button("register-proof").hidden = false; reviewed = parsed;
  status("Proof verified. Review the address, permissions, label, and expiration before registering.");
}));
element("registration-json").addEventListener("input", () => { reviewed = undefined; button("register-proof").hidden = true; element("proof-preview").hidden = true; });
button("register-proof").addEventListener("click", () => void run(async () => {
  if (!reviewed) return; const proof = reviewed; reviewed = undefined; button("register-proof").hidden = true;
  await register(proof); element<HTMLTextAreaElement>("registration-json").value = "";
}));
function renderBots(bots: BotGrant[]) {
  const list = element("bot-list"); list.replaceChildren();
  if (!bots.length) { const empty = document.createElement("li"); empty.textContent = "No bots registered."; list.append(empty); }
  for (const bot of bots) {
    if (bot.accountId !== active().accountId) throw new Error("Unexpected bot account.");
    const row = document.createElement("li");
    for (const value of [bot.label || "Unnamed bot", `Address: ${bot.botAddress}`, `Grant ID: ${bot.id}`, `Permissions: ${bot.scopes.join(", ")}`, `Expires: ${new Date(bot.expiresAt * 1000).toISOString()}${bot.revokedAt ? " / REVOKED" : ""}`]) {
      const line = document.createElement("p"); line.textContent = value; row.append(line);
    }
    if (!bot.revokedAt && bot.expiresAt > Math.floor(Date.now() / 1000)) {
      const revoke = document.createElement("button"); revoke.type = "button"; revoke.textContent = "Revoke bot";
      revoke.addEventListener("click", () => void run(async () => {
        await active().client.request({ method: "DELETE", requestTarget: `/api/v1/accounts/me/bots/${encodeURIComponent(bot.id)}` });
        revoke.disabled = true; revoke.textContent = "Revoked"; status(`Bot grant ${bot.id} revoked.`);
      })); row.append(revoke);
    }
    list.append(row);
  }
}
button("refresh-bots").addEventListener("click", () => void run(async () => {
  const { bots } = await active().client.request<{ bots: BotGrant[] }>({ requestTarget: "/api/v1/accounts/me/bots" }); renderBots(bots); status("Bot list refreshed.");
}));
