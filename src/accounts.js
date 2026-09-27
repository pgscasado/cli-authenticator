import * as OTPAuth from 'otpauth';

export function parseUri(uri) {
  const otp = OTPAuth.URI.parse(uri.trim());
  if (!(otp instanceof OTPAuth.TOTP)) throw new Error('Only TOTP (time-based) codes are supported.');
  return otp;
}

// Legacy accounts.js entries: { name: "Service:email", totpSecret: "BASE32" }
export function fromLegacy({ name, totpSecret }) {
  const parts = name.split(':').map((s) => s.trim());
  const issuer = parts.length > 1 ? parts.shift() : '';
  return new OTPAuth.TOTP({
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
