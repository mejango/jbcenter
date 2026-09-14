import { describe, expect, it } from 'vitest';
import { mnemonicToAccount } from 'viem/accounts';
import { createWalletRecoverySecret, readWalletRecoveryKit, recoveryAccountFromPhrase, serializeWalletRecoveryKit } from '../src/rest/web/walletRecoveryKit.js';

// Public BIP39 test entropy; never used for real funds.
const phrase = 'abandon '.repeat(23) + 'art';
const account = mnemonicToAccount(phrase, { path: "m/44'/60'/0'/0/0" });
const identity = { network: 'local-test' as const, chainId: 8453 as const, walletAddress: `0x${'11'.repeat(20)}` as const,
  initializerHash: `0x${'22'.repeat(32)}` as const, recoveryOwner: account.address };
describe('browser-owned portable recovery kit', () => {
  it('uses a standard 24-word recovery phrase and explicit Ethereum derivation path', () => {
    const secret = createWalletRecoverySecret(), other = createWalletRecoverySecret();
    expect(secret.mnemonic.split(' ')).toHaveLength(24); expect(secret.recoveryOwner).not.toBe(other.recoveryOwner);
    expect(recoveryAccountFromPhrase(secret.mnemonic, secret.recoveryOwner).address).toBe(secret.recoveryOwner);
    expect(recoveryAccountFromPhrase(phrase, account.address).address).toBe(account.address);
  });
  it('restores the independent owner and original Safe without Center or browser storage', async () => {
    const encoded = serializeWalletRecoveryKit({ mnemonic: phrase, recoveryOwner: account.address }, identity);
    const kit = readWalletRecoveryKit(encoded, identity), restored = recoveryAccountFromPhrase(kit.mnemonic, kit.recoveryOwner);
    expect(kit.walletAddress).toBe(identity.walletAddress); expect(kit.initializerHash).toBe(identity.initializerHash);
    expect(kit.derivationPath).toBe("m/44'/60'/0'/0/0");
    expect(await restored.signMessage({ message: 'Public recovery fixture' })).toBe(await account.signMessage({ message: 'Public recovery fixture' }));
  });
  it('refuses a valid kit for another wallet, key, chain, initializer or version', () => {
    const encoded = serializeWalletRecoveryKit({ mnemonic: phrase, recoveryOwner: account.address }, identity);
    for (const patch of [{ walletAddress: `0x${'33'.repeat(20)}` }, { initializerHash: `0x${'33'.repeat(32)}` },
      { recoveryOwner: `0x${'44'.repeat(20)}` }, { chainId: 1 }, { network: 'base' }, { version: 'later' },
      { derivationPath: "m/44'/60'/0'/0/1" }, { passphrase: 'extra authority' }]) {
      const changed = { ...JSON.parse(encoded), ...patch };
      expect(() => readWalletRecoveryKit(JSON.stringify(changed), identity)).toThrow();
    }
    expect(() => readWalletRecoveryKit(encoded.slice(0, -1) + ',"__proto__":{}}', identity)).toThrow();
  });
  it('checks checksum and bounds before deriving secrets and rejects unexpected owners', () => {
    for (const value of ['', 'abandon '.repeat(24), 'abandon '.repeat(11) + 'about', 'x'.repeat(4097)])
      expect(() => recoveryAccountFromPhrase(value)).toThrow();
    expect(() => recoveryAccountFromPhrase(phrase, identity.walletAddress)).toThrow();
    expect(() => readWalletRecoveryKit('x'.repeat(8193))).toThrow();
    expect(() => serializeWalletRecoveryKit({ mnemonic: phrase, recoveryOwner: identity.walletAddress }, identity)).toThrow();
  });
});
