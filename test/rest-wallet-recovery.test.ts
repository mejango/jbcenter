import { describe, expect, it, vi } from "vitest";
import { createWalletRecovery, type WalletRecoveryRecord } from "../src/rest/web/walletRecovery.js";

const accountId = `eip155:1:0x${"11".repeat(20)}`;
const otherAccountId = `eip155:10:0x${"22".repeat(20)}`;
const record: WalletRecoveryRecord = {
  accountId, chainId: 8453, walletAddress: `0x${"33".repeat(20)}`,
  kind: "creation", attemptId: "smart-creation-attempt",
};
const transactionHash = `0x${"44".repeat(32)}` as const;
const operation: WalletRecoveryRecord = {
  ...record, kind: "user-operation", attemptId: "smart-operation-attempt",
  operationId: `0x${"55".repeat(32)}`, idempotencyKey: "smart-submission-once",
};
function storage() {
  const values = new Map<string, string>();
  return { values, getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { values.set(key, value); }) };
}

describe("public wallet transaction recovery", () => {
  it("saves an attempt before submission and restores only references for the active API account", () => {
    const local = storage(), journal = createWalletRecovery(local);
    expect(journal.record(record)).toBe(true);
    expect(journal.record({ ...operation, accountId: otherAccountId })).toBe(true);
    const restored = createWalletRecovery(local);
    expect(restored.list(accountId)).toEqual([record]);
    expect(restored.list(otherAccountId)).toEqual([{ ...operation, accountId: otherAccountId }]);
    expect(restored.warning()).toBeUndefined();
  });

  it("keeps the returned hash and operation identifiers across reload without restoring authority", () => {
    const local = storage(), journal = createWalletRecovery(local);
    journal.record(operation);
    journal.record({ ...operation, transactionHash }, { requireDurable: false });
    // An older event cannot erase the later broadcast reference.
    journal.record(operation, { requireDurable: false });
    const restored = createWalletRecovery(local).list(accountId);
    expect(restored).toEqual([{ ...operation, transactionHash }]);
    expect(Object.keys(restored[0]!)).toEqual(expect.arrayContaining(["accountId", "chainId", "walletAddress", "kind", "attemptId", "idempotencyKey", "operationId", "transactionHash"]));
    expect(Object.keys(restored[0]!)).toHaveLength(8);
    restored[0]!.attemptId = "edited-copy";
    expect(journal.list(accountId)[0]!.attemptId).toBe(operation.attemptId);
  });

  it("blocks a new submission if browser storage cannot retain its attempt marker", () => {
    const local = storage(), journal = createWalletRecovery(local), submit = vi.fn();
    local.setItem.mockImplementation(() => { throw new Error("quota"); });
    expect(() => { journal.record(operation); submit(); }).toThrow("transaction was not started");
    expect(submit).not.toHaveBeenCalled();
    expect(journal.warning()).toContain("Download the public recovery file");
  });

  it("detects storage silently discarding writes before starting a submission", () => {
    const local = storage(), journal = createWalletRecovery(local);
    local.setItem.mockImplementation(() => {});
    expect(() => journal.record(record)).toThrow("transaction was not started");
    expect(journal.warning()).toContain("could not save");
  });

  it("retains a known broadcast hash for export if storage fails after sending", () => {
    const local = storage(), journal = createWalletRecovery(local);
    journal.record(record);
    local.setItem.mockImplementation(() => { throw new Error("storage disabled mid-request"); });
    expect(journal.record({ ...record, transactionHash }, { requireDurable: false })).toBe(false);
    expect(journal.list(accountId)).toEqual([{ ...record, transactionHash }]);
    expect(journal.warning()).toContain("before closing or reloading");
    // Reload can only recover the earlier persisted attempt, so the UI must offer export.
    expect(createWalletRecovery(local).list(accountId)).toEqual([record]);
    local.setItem.mockImplementation((key, value) => { local.values.set(key, value); });
    expect(journal.record(record)).toBe(true);
    expect(createWalletRecovery(local).list(accountId)).toEqual([{ ...record, transactionHash }]);
    expect(journal.warning()).toBeUndefined();
  });

  it.each(["privateKey", "signature", "ownerSignatures", "sessionKey", "transactionData", "authority", "provider"])("rejects %s instead of persisting secret material or restored authority", (field) => {
    const local = storage(), journal = createWalletRecovery(local);
    expect(() => journal.record({ ...record, [field]: `0x${"ab".repeat(32)}` } as WalletRecoveryRecord)).toThrow("reference is invalid");
    expect(local.setItem).not.toHaveBeenCalled();
    expect(journal.list(accountId)).toEqual([]);
  });

  it.each([
    { accountId: "account-one" }, { chainId: 0 }, { chainId: Number.MAX_SAFE_INTEGER + 1 }, { walletAddress: "0xdead" },
    { kind: "signed-transaction" }, { attemptId: "../another-attempt" }, { attemptId: "a".repeat(129) },
    { idempotencyKey: "key\nheader" }, { operationId: "../operation" }, { transactionHash: "0xabc" },
    { operationId: "operation-on-creation" },
  ])("rejects malformed references %j", (patch) => {
    const local = storage(), journal = createWalletRecovery(local);
    expect(() => journal.record({ ...record, ...patch } as WalletRecoveryRecord)).toThrow("reference is invalid");
    expect(local.setItem).not.toHaveBeenCalled();
  });

  it("does not overwrite corrupted or unexpected stored documents", () => {
    for (const stored of ["not-json", JSON.stringify({ version: 2, records: [] }), JSON.stringify({ version: 1, records: [{ ...record, privateKey: "must-not-import" }] }), JSON.stringify({ version: 1, records: [record, record] }), "x".repeat(65_537)]) {
      const local = storage(), journal = createWalletRecovery(local);
      local.getItem.mockReturnValue(stored);
      expect(journal.list(accountId)).toEqual([]);
      expect(journal.warning()).toContain("could not read");
      expect(() => journal.record(operation)).toThrow("transaction was not started");
      expect(local.setItem).not.toHaveBeenCalled();
    }
  });

  it("preserves action identity and rejects replacement hashes or operation IDs", () => {
    const local = storage(), journal = createWalletRecovery(local);
    journal.record({ ...operation, transactionHash });
    for (const patch of [{ chainId: 10 }, { walletAddress: `0x${"66".repeat(20)}` }, { operationId: "replacement" }, { idempotencyKey: "replacement" }, { transactionHash: `0x${"77".repeat(32)}` }]) {
      expect(() => journal.record({ ...operation, transactionHash, ...patch } as WalletRecoveryRecord)).toThrow("another wallet action");
    }
    expect(journal.list(accountId)).toEqual([{ ...operation, transactionHash }]);
  });

  it("bounds unresolved records without evicting earlier transactions", () => {
    const local = storage(), journal = createWalletRecovery(local);
    for (let index = 0; index < 64; index++) journal.record({ ...record, attemptId: `attempt-${index}` });
    expect(() => journal.record({ ...record, attemptId: "one-too-many" })).toThrow("too many unresolved transactions");
    journal.record({ ...record, attemptId: "attempt-0", transactionHash });
    expect(journal.list(accountId)).toHaveLength(64);
    expect(journal.list(accountId)[0]!.transactionHash).toBe(transactionHash);
    journal.remove(accountId, "attempt-1");
    journal.record({ ...record, attemptId: "another-after-check" });
    expect(journal.list(accountId)).toHaveLength(64);
  });

  it("removes only the checked account/attempt and keeps references when removal cannot persist", () => {
    const local = storage(), journal = createWalletRecovery(local);
    journal.record(record); journal.record({ ...record, accountId: otherAccountId });
    local.setItem.mockImplementation(() => { throw new Error("unavailable"); });
    expect(() => journal.remove(accountId, record.attemptId)).toThrow("remain visible");
    expect(journal.list(accountId)).toEqual([record]);
    local.setItem.mockImplementation((key, value) => { local.values.set(key, value); });
    journal.remove(accountId, record.attemptId);
    expect(journal.list(accountId)).toEqual([]);
    expect(journal.list(otherAccountId)).toEqual([{ ...record, accountId: otherAccountId }]);
  });

  it("handles denied storage access without reading any wallet or signing provider", () => {
    const journal = createWalletRecovery(() => { throw new Error("access denied"); });
    expect(journal.list(accountId)).toEqual([]);
    expect(journal.warning()).toContain("could not read");
    expect(() => journal.record(record)).toThrow("transaction was not started");
    expect(journal.record({ ...record, transactionHash }, { requireDurable: false })).toBe(false);
    expect(journal.list(accountId)).toEqual([{ ...record, transactionHash }]);
  });
});
