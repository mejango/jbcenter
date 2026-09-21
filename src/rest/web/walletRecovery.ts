import { getAddress, type Address, type Hex } from "viem";
import { parseAccountId } from "../auth/signatures.js";

export type WalletRecoveryRecord = {
  accountId: string;
  chainId: number;
  walletAddress: Address;
  kind: "creation" | "user-operation";
  attemptId: string;
  idempotencyKey?: string;
  transactionHash?: Hex;
  operationId?: string;
};

type RecoveryStorage = Pick<Storage, "getItem" | "setItem">;
type RecordOptions = { requireDurable?: boolean };
const storageKey = "juicebox-center.wallet-recovery.v1";
const maxRecords = 64;
const maxStorageBytes = 65_536;
const identifier = /^[A-Za-z0-9_-]{1,128}$/;
const fields = new Set(["accountId", "chainId", "walletAddress", "kind", "attemptId", "idempotencyKey", "transactionHash", "operationId"]);

export class WalletRecoveryError extends Error {
  constructor(message: string) { super(message); this.name = "WalletRecoveryError"; }
}
const invalid = (): never => { throw new WalletRecoveryError("The wallet recovery reference is invalid."); };
const key = (record: Pick<WalletRecoveryRecord, "accountId" | "attemptId">) => `${record.accountId}/${record.attemptId}`;

function checkedAccount(value: unknown): string {
  if (typeof value !== "string") return invalid();
  try { parseAccountId(value); } catch { return invalid(); }
  return value;
}
function checkedRecord(value: unknown): WalletRecoveryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((field) => !fields.has(field))) return invalid();
  const accountId = checkedAccount(input.accountId);
  if (!Number.isSafeInteger(input.chainId) || Number(input.chainId) < 1 || typeof input.walletAddress !== "string" ||
    !["creation", "user-operation"].includes(String(input.kind)) || typeof input.attemptId !== "string" || !identifier.test(input.attemptId)) return invalid();
  let walletAddress: Address;
  try { walletAddress = getAddress(input.walletAddress); } catch { return invalid(); }
  if (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== "string" || !identifier.test(input.idempotencyKey))) return invalid();
  if (input.operationId !== undefined && (typeof input.operationId !== "string" || !identifier.test(input.operationId))) return invalid();
  if (input.transactionHash !== undefined && (typeof input.transactionHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(input.transactionHash))) return invalid();
  if (input.kind === "creation" && input.operationId !== undefined) return invalid();
  return {
    accountId, chainId: Number(input.chainId), walletAddress,
    kind: input.kind as WalletRecoveryRecord["kind"], attemptId: input.attemptId,
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey as string }),
    ...(input.operationId === undefined ? {} : { operationId: input.operationId as string }),
    ...(input.transactionHash === undefined ? {} : { transactionHash: (input.transactionHash as string).toLowerCase() as Hex }),
  };
}
function checkedDocument(raw: string | null): WalletRecoveryRecord[] {
  if (raw === null) return [];
  if (raw.length > maxStorageBytes) return invalid();
  const data: unknown = JSON.parse(raw);
  if (!data || typeof data !== "object" || Array.isArray(data)) return invalid();
  const document = data as Record<string, unknown>;
  if (Object.keys(document).some((field) => field !== "version" && field !== "records") || document.version !== 1 ||
    !Array.isArray(document.records) || document.records.length > maxRecords) return invalid();
  const records = document.records.map(checkedRecord);
  if (new Set(records.map(key)).size !== records.length) return invalid();
  return records;
}

/** Public references only. Reading this journal grants no signing or submission authority. */
export function createWalletRecovery(source: RecoveryStorage | (() => RecoveryStorage)) {
  let cache: WalletRecoveryRecord[] = [];
  const unsaved = new Map<string, WalletRecoveryRecord>();
  let readWarning: string | undefined, writeWarning: string | undefined;
  const storage = () => typeof source === "function" ? source() : source;
  const snapshot = () => {
    try { cache = checkedDocument(storage().getItem(storageKey)); readWarning = undefined; }
    catch { readWarning = "This browser could not read its saved transaction references. New submissions are paused until recovery storage is available."; }
    const combined = new Map(cache.map((record) => [key(record), record]));
    for (const [id, record] of unsaved) combined.set(id, record);
    return [...combined.values()];
  };
  const save = (records: WalletRecoveryRecord[]) => {
    if (readWarning) return false;
    try {
      const encoded = JSON.stringify({ version: 1, records });
      if (encoded.length > maxStorageBytes) return invalid();
      const target = storage();
      target.setItem(storageKey, encoded);
      if (target.getItem(storageKey) !== encoded) throw new Error("Recovery storage did not retain the update.");
      cache = records; unsaved.clear(); writeWarning = undefined;
      return true;
    } catch {
      writeWarning = "This browser could not save transaction references. Download the public recovery file before closing or reloading this page. New submissions are paused until storage is available.";
      return false;
    }
  };
  return {
    record(value: WalletRecoveryRecord, options: RecordOptions = {}): boolean {
      const record = checkedRecord(value), records = snapshot(), index = records.findIndex((item) => key(item) === key(record));
      if (index !== -1) {
        const previous = records[index]!;
        if (previous.chainId !== record.chainId || previous.walletAddress !== record.walletAddress || previous.kind !== record.kind ||
          (["transactionHash", "operationId", "idempotencyKey"] as const).some((field) => previous[field] !== undefined && record[field] !== undefined && previous[field] !== record[field]))
          throw new WalletRecoveryError("This recovery attempt already belongs to another wallet action.");
        records[index] = { ...previous, ...record };
      } else {
        if (records.length >= maxRecords) throw new WalletRecoveryError("This browser has too many unresolved transactions. Check existing references before starting another.");
        records.push(record);
      }
      const latest = records[index === -1 ? records.length - 1 : index]!;
      // Keep a newly received hash even if storage becomes unavailable after sending.
      unsaved.set(key(latest), latest);
      const persisted = save(records);
      if (!persisted && options.requireDurable !== false)
        throw new WalletRecoveryError("The transaction was not started because this browser could not save its recovery reference. Enable browser storage and try again.");
      return persisted;
    },
    list(accountId: string): WalletRecoveryRecord[] {
      checkedAccount(accountId);
      return snapshot().filter((record) => record.accountId === accountId).map((record) => ({ ...record }));
    },
    remove(accountId: string, attemptId: string): void {
      checkedAccount(accountId);
      if (!identifier.test(attemptId)) return invalid();
      const records = snapshot(), id = key({ accountId, attemptId });
      if (!records.some((record) => key(record) === id)) return;
      if (!save(records.filter((record) => key(record) !== id)))
        throw new WalletRecoveryError("The checked reference could not be removed from browser storage. It will remain visible for another check.");
    },
    warning: () => readWarning ?? writeWarning,
  };
}

const journal = createWalletRecovery(() => window.localStorage);
export const recordWalletRecovery = (record: WalletRecoveryRecord, options?: RecordOptions) => journal.record(record, options);
export const walletRecoveries = (accountId: string) => journal.list(accountId);
export const removeWalletRecovery = (accountId: string, attemptId: string) => journal.remove(accountId, attemptId);
export const walletRecoveryWarning = () => journal.warning();

type RecoveryViewOptions = { onCheck(record: WalletRecoveryRecord): Promise<void>; isCurrent?: () => boolean };
const networkName = (chainId: number) => ({ 1: "Ethereum", 10: "OP Mainnet", 8453: "Base", 42161: "Arbitrum One", 11155111: "Sepolia", 11155420: "OP Sepolia", 84532: "Base Sepolia", 421614: "Arbitrum Sepolia" })[chainId] ?? `Network ${chainId}`;

/** Rechecking is an explicit user action; callers must fetch current canonical/API state. */
export function renderWalletRecovery(accountId: string, options: RecoveryViewOptions): void {
  const container = document.getElementById("smart-recovery");
  if (!container || options.isCurrent?.() === false) return;
  const records = walletRecoveries(accountId), warning = walletRecoveryWarning();
  container.replaceChildren(); container.hidden = !records.length && !warning;
  if (container.hidden) return;
  const heading = document.createElement("h3"); heading.textContent = "Transactions to check"; container.append(heading);
  const description = document.createElement("p");
  description.textContent = "These public references help recover interrupted wallet actions. Check each action’s current status before trying again. Nothing is sent automatically.";
  container.append(description);
  if (warning) { const notice = document.createElement("p"); notice.className = "recovery-notice"; notice.setAttribute("role", "status"); notice.textContent = warning; container.append(notice); }
  const list = document.createElement("ul"); list.className = "transaction-review-list";
  for (const record of records) {
    const row = document.createElement("li"); row.className = "network-progress-item";
    const title = document.createElement("h4"); title.textContent = `${networkName(record.chainId)} / ${record.kind === "creation" ? "Wallet creation" : "Transaction"}`; row.append(title);
    for (const text of [
      `Wallet: ${record.walletAddress}`,
      ...(record.transactionHash ? [`Transaction: ${record.transactionHash}`] : []),
      ...(record.operationId ? [`Operation: ${record.operationId}`] : []),
      ...(!record.transactionHash && !record.operationId ? ["An attempt was recorded without a returned transaction reference. Check your wallet’s activity before trying again."] : []),
    ]) { const line = document.createElement("p"); line.textContent = text; row.append(line); }
    const detail = document.createElement("details"), summary = document.createElement("summary"), pre = document.createElement("pre");
    summary.textContent = "Public recovery reference"; pre.textContent = JSON.stringify(record, null, 2); pre.tabIndex = 0; detail.append(summary, pre); row.append(detail);
    const check = document.createElement("button"); check.type = "button"; check.textContent = "Check current status";
    check.disabled = record.kind !== "creation" && !record.transactionHash && !record.operationId;
    const result = document.createElement("p"); result.setAttribute("role", "status");
    check.addEventListener("click", () => {
      if (options.isCurrent?.() === false) return;
      check.disabled = true; result.textContent = "Checking current status…";
      void options.onCheck({ ...record }).then(() => {
        if (options.isCurrent?.() !== false) renderWalletRecovery(accountId, options);
      }).catch(() => {
        if (options.isCurrent?.() === false) return;
        result.textContent = "The current status could not be checked. Keep this reference and try again."; check.disabled = false;
      });
    });
    row.append(check, result); list.append(row);
  }
  container.append(list);
  if (records.length) {
    const download = document.createElement("button"); download.type = "button"; download.textContent = "Download public recovery references";
    download.addEventListener("click", () => {
      if (options.isCurrent?.() === false) return;
      const content = JSON.stringify({ version: 1, records: walletRecoveries(accountId) }, null, 2) + "\n";
      const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = "juicebox-wallet-recovery.json";
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    container.append(download);
  }
}
