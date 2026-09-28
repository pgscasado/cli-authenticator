import { readFileSync } from 'node:fs';
import { fromLegacy, parseLegacySource, parseUri } from './accounts.js';
import { readClipboard } from './clipboard.js';
import { decodeImage } from './decode.js';
import { parseMigrationUri } from './migration.js';

// Returns { otps, skipped, batch } for both single-account and Google Authenticator export links.
export function otpsFromString(uri) {
  if (uri.startsWith('otpauth-migration://')) return parseMigrationUri(uri);
  if (!uri.startsWith('otpauth://')) throw new Error('That is not an otpauth:// link.');
  return { otps: [parseUri(uri)], skipped: 0, batch: { index: 0, size: 1 } };
}

export async function otpsFromClipboard() {
  const clip = await readClipboard();
  if (clip.image) {
    const uri = await decodeImage(clip.image);
    if (!uri) throw new Error('No QR code found in the clipboard image.');
    return otpsFromString(uri);
  }
  if (!clip.text.trim()) throw new Error('Clipboard is empty. Screenshot a QR code first.');
  return otpsFromString(clip.text.trim());
}

// Accepts a QR code image (PNG, JPEG, ...) or a legacy accounts.js file.
export async function otpsFromFile(path) {
  if (/\.m?js$/i.test(path)) {
    // Parsed as text, never executed: an imported file must not be able to run code.
    const accounts = parseLegacySource(readFileSync(path, 'utf8'));
    if (!accounts.length) throw new Error('No { name, totpSecret } entries found in that file.');
    return { otps: accounts.map(fromLegacy), skipped: 0, batch: { index: 0, size: 1 } };
  }
  const uri = await decodeImage(readFileSync(path));
  if (!uri) throw new Error('No QR code found in that image.');
  return otpsFromString(uri);
}
