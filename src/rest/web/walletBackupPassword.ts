import { scrypt } from '@noble/hashes/scrypt';
import { getAddress, type Address } from 'viem';
import { recoveryAccountFromPhrase, type WalletRecoverySecret } from './walletRecoveryKit.js';

/** The backup words sealed under a password the user chose. Only the ciphertext leaves the browser;
 * Center stores it (wrapped again server-side) and hands it back for recovery by wallet address.
 * The password itself is never sent and cannot be reset: without it the words are unrecoverable. */
export interface WalletBackupEnvelope {
  version: 'center-wallet-backup-v1';
  kdf: { name: 'scrypt'; n: number; r: number; p: number };
  /** base64url */
  salt: string;
  /** base64url */
  iv: string;
  /** base64url; AES-256-GCM over the mnemonic, tag included */
  ciphertext: string;
}
// ponytail: 64 MiB scrypt, about a second on a phone; raise n when devices allow.
export const walletBackupKdf = Object.freeze({ name: 'scrypt', n: 65536, r: 8, p: 1 } as const);
const version = 'center-wallet-backup-v1';
const common = new Set(['password', 'password1', 'password12', 'password123', 'passw0rd', 'p@ssw0rd', 'qwerty123', 'qwerty1234', 'abc12345',
  'abcd1234', 'letmein1', 'welcome1', 'iloveyou1', 'admin123', 'monkey123', 'dragon123', 'football1', 'baseball1', 'sunshine1', 'princess1',
  'trustno1', '1q2w3e4r', '1qaz2wsx', 'zaq12wsx', 'qwertyuiop1', 'asdfghjkl1', 'juicebox1', 'juicebox123', 'wallet123', 'password2026', 'password2025']);

/** Plain rules, no meter: length, letters and numbers, not a well-known password, not the passkey name. */
export function checkWalletBackupPassword(password: string, context: { passkeyName?: string }): string | null {
  if (typeof password !== 'string' || password.length < 8) return 'Use at least 8 characters.';
  if (password.length > 128) return 'Use at most 128 characters.';
  if (!/\p{L}/u.test(password)) return 'Include at least one letter.';
  if (!/\p{N}/u.test(password)) return 'Include at least one number.';
  const folded = password.toLowerCase();
  if (common.has(folded) || common.has(folded.replace(/[^a-z0-9]/g, ''))) return 'That password is too common.';
  const name = context.passkeyName?.trim().toLowerCase();
  if (name && name.length >= 4 && (folded.includes(name) || name.includes(folded))) return 'Do not reuse your passkey name.';
  return null;
}

const encoder = new TextEncoder(), decoder = new TextDecoder();
function encode(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
function decode(value: string, length?: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(value)) throw new Error('Invalid backup envelope.');
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
  if (encode(bytes) !== value || (length !== undefined && bytes.length !== length)) throw new Error('Invalid backup envelope.');
  return bytes;
}
function assertEnvelope(value: WalletBackupEnvelope) {
  if (!value || typeof value !== 'object' || value.version !== version || !value.kdf || value.kdf.name !== 'scrypt'
    || value.kdf.n !== walletBackupKdf.n || value.kdf.r !== walletBackupKdf.r || value.kdf.p !== walletBackupKdf.p) throw new Error('Invalid backup envelope.');
}
async function key(password: string, salt: Uint8Array<ArrayBuffer>) {
  const raw = scrypt(encoder.encode(password.normalize('NFKC')), salt, { N: walletBackupKdf.n, r: walletBackupKdf.r, p: walletBackupKdf.p, dkLen: 32 });
  return crypto.subtle.importKey('raw', new Uint8Array(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
const additional = (recoveryOwner: string) => encoder.encode(`${version}:${getAddress(recoveryOwner).toLowerCase()}`);

export async function sealWalletBackup(password: string, secret: WalletRecoverySecret): Promise<WalletBackupEnvelope> {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: additional(secret.recoveryOwner) },
    await key(password, salt), encoder.encode(secret.mnemonic));
  return { version, kdf: { ...walletBackupKdf }, salt: encode(salt), iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) };
}

/** Opens the envelope and re-derives the recovery owner from the words, so a wrong password, a
 * tampered envelope or an envelope for another wallet all fail the same way. */
export async function openWalletBackup(password: string, envelope: WalletBackupEnvelope, expected: { recoveryOwner: string }): Promise<WalletRecoverySecret> {
  assertEnvelope(envelope);
  const salt = decode(envelope.salt, 16), iv = decode(envelope.iv, 12), ciphertext = decode(envelope.ciphertext);
  if (ciphertext.length < 16 || ciphertext.length > 1024) throw new Error('Invalid backup envelope.');
  let mnemonic: string;
  try {
    mnemonic = decoder.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: additional(expected.recoveryOwner) }, await key(password, salt), ciphertext));
  } catch { throw new Error('That password does not open this wallet\'s backup.'); }
  const account = recoveryAccountFromPhrase(mnemonic, getAddress(expected.recoveryOwner) as Address);
  return { mnemonic, recoveryOwner: account.address };
}
