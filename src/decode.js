import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';

const require = createRequire(import.meta.url);

// Load the decoder from node_modules. By default zxing-wasm would fetch it from a CDN,
// and an authenticator shouldn't load code from the network.
prepareZXingModule({
  overrides: { wasmBinary: readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm')) },
});

const OPTIONS = { formats: ['QRCode'], tryHarder: true, maxNumberOfSymbols: 1 };

async function firstText(input) {
  return (await readBarcodes(input, OPTIONS)).find((r) => r.isValid)?.text ?? null;
}

// Image file bytes (PNG, JPEG, BMP, ...) -> QR text, or null if none found.
export function decodeImage(bytes) {
  return firstText(new Blob([bytes]));
}

// Raw RGBA pixels -> QR text, or null if none found.
export function decodePixels(data, width, height) {
  return firstText({ data, width, height, colorSpace: 'srgb' });
}
