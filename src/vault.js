import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseUri } from './accounts.js';

function defaultDir() {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'cli-authenticator');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'cli-authenticator');
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'cli-authenticator');
}

export const vaultPath = process.env.AUTH_VAULT ?? join(defaultDir(), 'vault.json');

// scrypt cost: ~128 MiB of memory and a fraction of a second per unlock.
const SCRYPT = { N: 2 ** 17, r: 8, p: 1 };

const b64 = (buf) => buf.toString('base64');

function newKdf() {
  return { name: 'scrypt', ...SCRYPT, salt: b64(randomBytes(16)) };
}

function deriveKey(password, kdf) {
  return scryptSync(password.normalize('NFKC'), Buffer.from(kdf.salt, 'base64'), 32, {
    N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024,
  });
}

// Binds the KDF parameters to the ciphertext so they can't be tampered with.
const aad = (kdf) => Buffer.from(JSON.stringify({ v: 1, kdf }));

export function vaultExists() {
  return existsSync(vaultPath);
}

export function createVault(password) {
  const kdf = newKdf();
  const vault = { kdf, key: deriveKey(password, kdf), entries: [] };
  saveVault(vault);
  return vault;
}

export function openVault(password) {
  const file = JSON.parse(readFileSync(vaultPath, 'utf8'));
  if (file.v !== 1) throw new Error(`Unsupported vault version: ${file.v}`);

  const key = deriveKey(password, file.kdf);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'));
  decipher.setAAD(aad(file.kdf));
  decipher.setAuthTag(Buffer.from(file.tag, 'base64'));

  let plain;
  try {
    plain = Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]);
  } catch {
    throw new Error('Wrong password (or the vault file is corrupted).');
  }
  return { kdf: file.kdf, key, entries: JSON.parse(plain.toString('utf8')).map(parseUri) };
}

export function saveVault({ kdf, key, entries }) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(kdf));
  const plain = JSON.stringify(entries.map((otp) => otp.toString()));
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const file = { v: 1, kdf, iv: b64(iv), tag: b64(cipher.getAuthTag()), data: b64(data) };

  mkdirSync(dirname(vaultPath), { recursive: true, mode: 0o700 });
  const tmp = `${vaultPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  renameSync(tmp, vaultPath);
}

export function changePassword(vault, password) {
  vault.kdf = newKdf();
  vault.key = deriveKey(password, vault.kdf);
  saveVault(vault);
}
