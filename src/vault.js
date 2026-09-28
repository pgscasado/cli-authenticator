import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

const mtime = () => statSync(vaultPath).mtimeMs;

// Short exclusive lock around read-modify-write, so two running copies can't overwrite each other.
function withLock(fn) {
  const lock = `${vaultPath}.lock`;
  mkdirSync(dirname(vaultPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        // A lock older than 10s was left behind by a crashed process.
        if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { force: true });
      } catch {}
      if (Date.now() > deadline) throw new Error('The vault is busy (locked by another auth process).');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

function readFile() {
  const file = JSON.parse(readFileSync(vaultPath, 'utf8'));
  if (file.v !== 1) throw new Error(`Unsupported vault version: ${file.v}`);
  return file;
}

function decrypt(file, key) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'));
  decipher.setAAD(aad(file.kdf));
  decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
  let plain;
  try {
    plain = Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]);
  } catch {
    throw new Error('Wrong password (or the vault file is corrupted).');
  }
  return JSON.parse(plain.toString('utf8')).map(parseUri);
}

function write(vault) {
  const { kdf, key, entries } = vault;
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
  vault.mtimeMs = mtime();
}

// Loads what's on disk into `vault` (another process may have changed it).
function reload(vault) {
  const file = readFile();
  if (file.kdf.salt !== vault.kdf.salt) {
    throw new Error('The master password was changed in another session. Restart auth.');
  }
  vault.entries = decrypt(file, vault.key);
  vault.mtimeMs = mtime();
}

export function createVault(password) {
  const kdf = newKdf();
  const vault = { kdf, key: deriveKey(password, kdf), entries: [] };
  withLock(() => {
    if (vaultExists()) throw new Error('A vault was just created by another process. Run auth again.');
    write(vault);
  });
  return vault;
}

export function openVault(password) {
  const file = readFile();
  const key = deriveKey(password, file.kdf);
  return { kdf: file.kdf, key, entries: decrypt(file, key), mtimeMs: mtime() };
}

// Applies `mutate(vault)` to the latest vault on disk and saves it. Returns mutate's result.
export function updateVault(vault, mutate) {
  return withLock(() => {
    if (vaultExists()) reload(vault);
    const result = mutate(vault);
    write(vault);
    return result;
  });
}

// Picks up changes saved by another process. Returns true if the entries changed.
export function refreshVault(vault) {
  try {
    if (!vaultExists() || mtime() === vault.mtimeMs) return false;
    reload(vault);
    return true;
  } catch {
    return false;
  }
}

export function changePassword(vault, password) {
  withLock(() => {
    reload(vault);
    vault.kdf = newKdf();
    vault.key = deriveKey(password, vault.kdf);
    write(vault);
  });
}
