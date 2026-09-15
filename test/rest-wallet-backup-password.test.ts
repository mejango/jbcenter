import { describe, expect, it } from "vitest";
import { checkWalletBackupPassword, openWalletBackup, sealWalletBackup, walletBackupKdf } from "../src/rest/web/walletBackupPassword.js";
import { createWalletRecoverySecret } from "../src/rest/web/walletRecoveryKit.js";

describe("chosen backup password", () => {
  it("accepts a reasonable password and names the problem with a weak one", () => {
    expect(checkWalletBackupPassword("orange-tree-42", { passkeyName: "juicebox.center 4:32 PM" })).toBeNull();
    expect(checkWalletBackupPassword("short1A", {})).toMatch(/8/);
    expect(checkWalletBackupPassword("abcdefghij", {})).toMatch(/number/i);
    expect(checkWalletBackupPassword("1234567890", {})).toMatch(/letter/i);
    expect(checkWalletBackupPassword("password1", {})).toMatch(/common/i);
    expect(checkWalletBackupPassword("Juicebox.center 2026", { passkeyName: "juicebox.center 2026" })).toMatch(/passkey name/i);
    expect(checkWalletBackupPassword("a".repeat(129) + "1", {})).toMatch(/128/);
  });
  it("seals the backup words so only the same password opens them", async () => {
    const secret = createWalletRecoverySecret();
    const envelope = await sealWalletBackup("orange-tree-42", secret);
    expect(envelope).toMatchObject({ version: "center-wallet-backup-v1", kdf: walletBackupKdf });
    expect(JSON.stringify(envelope)).not.toContain(secret.mnemonic.split(" ")[0]);
    expect(envelope.salt).not.toBe((await sealWalletBackup("orange-tree-42", secret)).salt);
    expect(await openWalletBackup("orange-tree-42", envelope, { recoveryOwner: secret.recoveryOwner })).toEqual(secret);
    await expect(openWalletBackup("orange-tree-43", envelope, { recoveryOwner: secret.recoveryOwner })).rejects.toThrow(/password/i);
    const tampered = { ...envelope, ciphertext: envelope.ciphertext.slice(0, -2) + (envelope.ciphertext.endsWith("AA") ? "AB" : "AA") };
    await expect(openWalletBackup("orange-tree-42", tampered, { recoveryOwner: secret.recoveryOwner })).rejects.toThrow();
    await expect(openWalletBackup("orange-tree-42", envelope, { recoveryOwner: `0x${"11".repeat(20)}` })).rejects.toThrow();
  });
});
