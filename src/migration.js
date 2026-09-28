import * as OTPAuth from 'otpauth';
import { newTotp } from './accounts.js';

// Decodes Google Authenticator export links: otpauth-migration://offline?data=<base64 protobuf>
// Schema: MigrationPayload { repeated OtpParameters otp_parameters = 1; int32 batch_size = 3; int32 batch_index = 4; }
//         OtpParameters { bytes secret = 1; string name = 2; string issuer = 3;
//                         Algorithm algorithm = 4; DigitCount digits = 5; OtpType type = 6; }

const ALGORITHMS = { 0: 'SHA1', 1: 'SHA1', 2: 'SHA256', 3: 'SHA512' };
const DIGITS = { 0: 6, 1: 6, 2: 8 };
const TYPE_HOTP = 1;

function readVarint(buf, pos) {
  let value = 0n;
  let shift = 0n;
  for (;;) {
    if (pos >= buf.length) throw new Error('Corrupted export QR code.');
    const byte = buf[pos++];
    value |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [value, pos];
    shift += 7n;
  }
}

function* fields(buf) {
  let pos = 0;
  while (pos < buf.length) {
    let tag, value;
    [tag, pos] = readVarint(buf, pos);
    const wireType = Number(tag & 7n);
    if (wireType === 0) {
      [value, pos] = readVarint(buf, pos);
      yield [Number(tag >> 3n), Number(value)];
    } else if (wireType === 2) {
      [value, pos] = readVarint(buf, pos);
      const end = pos + Number(value);
      if (end > buf.length) throw new Error('Corrupted export QR code.');
      yield [Number(tag >> 3n), buf.subarray(pos, end)];
      pos = end;
    } else {
      throw new Error('Corrupted export QR code.');
    }
  }
}

function parseOtp(buf) {
  const p = { secret: null, name: '', issuer: '', algorithm: 0, digits: 0, type: 0 };
  for (const [field, value] of fields(buf)) {
    if (field === 1) p.secret = value;
    else if (field === 2) p.name = value.toString('utf8');
    else if (field === 3) p.issuer = value.toString('utf8');
    else if (field === 4) p.algorithm = value;
    else if (field === 5) p.digits = value;
    else if (field === 6) p.type = value;
  }
  return p;
}

// Returns { otps, skipped, batch: { index, size } }
export function parseMigrationUri(uri) {
  const data = uri.match(/[?&]data=([^&]+)/)?.[1];
  if (!data) throw new Error('Export QR code has no data.');
  const payload = Buffer.from(decodeURIComponent(data).replace(/ /g, '+'), 'base64');

  const otps = [];
  let skipped = 0;
  const batch = { index: 0, size: 1 };
  for (const [field, value] of fields(payload)) {
    if (field === 3) batch.size = value;
    else if (field === 4) batch.index = value;
    if (field !== 1) continue;

    const p = parseOtp(value);
    if (!p.secret || p.type === TYPE_HOTP || !(p.algorithm in ALGORITHMS)) {
      skipped++;
      continue;
    }
    // Names are usually "Issuer:account"; keep just the account part as the label.
    const label = p.issuer && p.name.startsWith(`${p.issuer}:`) ? p.name.slice(p.issuer.length + 1) : p.name;
    otps.push(newTotp({
      issuer: p.issuer,
      label: label.trim(),
      algorithm: ALGORITHMS[p.algorithm],
      digits: DIGITS[p.digits] ?? 6,
      secret: new OTPAuth.Secret({ buffer: Uint8Array.from(p.secret).buffer }),
    }));
  }
  return { otps, skipped, batch };
}
