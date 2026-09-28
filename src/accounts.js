import * as OTPAuth from 'otpauth';

// Names come from QR codes and links, so strip anything a terminal could interpret:
// control characters (escape sequences) and bidi overrides (which can disguise text).
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

export function cleanText(text) {
  return String(text).replace(UNSAFE, '');
}

function cleanNames(otp) {
  otp.issuer = cleanText(otp.issuer).trim();
  otp.label = cleanText(otp.label).trim();
  return otp;
}

export function parseUri(uri) {
  const otp = OTPAuth.URI.parse(uri.trim());
  if (!(otp instanceof OTPAuth.TOTP)) throw new Error('Only TOTP (time-based) codes are supported.');
  return cleanNames(otp);
}

export function newTotp(options) {
  return cleanNames(new OTPAuth.TOTP(options));
}

// Matches `key: "value"` with ", ' or ` quotes and backslash escapes.
function stringField(body, key) {
  const match = body.match(new RegExp(String.raw`\b${key}\s*:\s*(["'` + '`' + String.raw`])((?:\\.|(?!\1)[^\\])*)\1`));
  return match?.[2].replace(/\\(.)/g, '$1');
}

// Reads a legacy accounts.js as plain text, without running it:
// every { name: "...", totpSecret: "..." } object literal becomes an entry.
export function parseLegacySource(source) {
  const entries = [];
  for (const [, body] of source.matchAll(/\{([^{}]*)\}/g)) {
    const name = stringField(body, 'name');
    const totpSecret = stringField(body, 'totpSecret');
    if (name !== undefined && totpSecret) entries.push({ name, totpSecret });
  }
  return entries;
}

// Legacy accounts.js entries: { name: "Service:email", totpSecret: "BASE32" }
export function fromLegacy({ name, totpSecret }) {
  const parts = name.split(':').map((s) => s.trim());
  const issuer = parts.length > 1 ? parts.shift() : '';
  return newTotp({
    issuer,
    label: parts.join(':'),
    secret: OTPAuth.Secret.fromBase32(totpSecret.replace(/[\s-]/g, '').toUpperCase()),
  });
}

export function displayName(otp) {
  return otp.issuer ? `${otp.issuer} (${otp.label})` : otp.label;
}

// Returns false if an account with the same secret is already stored.
export function addEntry(vault, otp) {
  if (vault.entries.some((e) => e.secret.base32 === otp.secret.base32)) return false;
  vault.entries.push(otp);
  return true;
}

// Adds every parsed account and returns a one-line summary.
export function addAll(vault, { otps, skipped, batch }) {
  const added = otps.filter((otp) => addEntry(vault, otp)).length;
  const dupes = otps.length - added;
  let message;
  if (otps.length === 1 && !skipped) {
    message = added ? `Added ${displayName(otps[0])}.` : `${displayName(otps[0])} is already in the list.`;
  } else {
    message = `Added ${added} account(s)`;
    if (dupes) message += `, ${dupes} already in the list`;
    if (skipped) message += `, ${skipped} unsupported (HOTP) skipped`;
    message += '.';
  }
  if (batch.size > 1) message += ` Export QR ${batch.index + 1} of ${batch.size}.`;
  return { added, message };
}
