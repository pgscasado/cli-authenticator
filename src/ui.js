import { homedir } from 'node:os';
import { emitKeypressEvents } from 'node:readline';
import { styleText } from 'node:util';
import { addAll, cleanText, displayName } from './accounts.js';
import { decodeFrame, openCamera, renderPreview } from './camera.js';
import { clearClipboard, readClipboard, writeClipboard } from './clipboard.js';
import { otpsFromClipboard, otpsFromFile, otpsFromString } from './qr.js';
import { refreshVault, updateVault } from './vault.js';

const CSI = '\x1b[';
const CLIPBOARD_CLEAR_MS = 30_000;
const SELECTED = `${CSI}48;5;237;97;1m`; // dark gray background, bold white text
// Camera state colors, as exact RGB so terminal themes can't remap them.
const BANNER = {
  scanning: [90, 90, 90],
  hint: [250, 204, 21],
  ready: [34, 197, 94],
  error: [239, 68, 68],
};
const rgbBg = ([r, g, b]) => `${CSI}48;2;${r};${g};${b}m`;
const rgbText = ([r, g, b]) => `${CSI}38;2;${r};${g};${b};1m`;
const HELP = ' ↑↓ select · enter copy · a paste · c camera · i import · d del · esc exit';
const CAMERA_HELP = ' Hold the QR code up to the camera · esc close';

// Terminals paste dragged files as "C:\path\x.png", 'path', or path\ with\ spaces.
function cleanPath(raw) {
  let path = raw.trim().replace(/^&\s*/, '');
  if (/^(["']).*\1$/.test(path)) path = path.slice(1, -1);
  else if (process.platform !== 'win32') path = path.replace(/\\(.)/g, '$1');
  return path.replace(/^~(?=$|[\\/])/, homedir());
}

export function runUi(vault) {
  const { stdin, stdout } = process;
  let selected = 0;
  let offset = 0; // first visible row of the list
  let status = null;
  let statusTimer;
  let confirmDelete = false;
  let busy = false;
  let input = null; // file path being typed after [i]
  let camera = null; // { frame, stop, lastUri, seen } while scanning

  function setStatus(message, color = 'yellow', sticky = false) {
    status = { message: cleanText(message), color };
    clearTimeout(statusTimer);
    if (!sticky) statusTimer = setTimeout(() => ((status = null), render()), 4000);
    render();
  }

  function formatCode(code) {
    const half = Math.ceil(code.length / 2);
    return `${code.slice(0, half)} ${code.slice(half)}`;
  }

  // Cuts plain text to the terminal width so lines never wrap and shift the layout.
  function fit(text, width) {
    if (width <= 0) return '';
    return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
  }

  // Layout: header, list (scrolls), blank, hotkeys, status/input — pinned to the terminal size.
  function render() {
    const cols = stdout.columns || 80;
    const rows = stdout.rows || 24;
    const listHeight = Math.max(1, rows - 5);
    const entries = vault.entries;

    if (selected < offset) offset = selected;
    if (selected >= offset + listHeight) offset = selected - listHeight + 1;
    offset = Math.max(0, Math.min(offset, entries.length - listHeight));

    const now = Date.now();
    const remaining = 30 - (Math.floor(now / 1000) % 30);
    const color = remaining > 10 ? 'green' : remaining > 5 ? 'yellow' : 'red';
    const issuerWidth = Math.max(0, ...entries.map((otp) => otp.issuer.length));
    const codeWidth = Math.max(0, ...entries.map((otp) => otp.digits + 1));

    const bar = '▓'.repeat(remaining) + '░'.repeat(30 - remaining);
    const title = ' cli-authenticator';
    const header = cols >= title.length + bar.length + 7
      ? `${styleText('bold', title)}   ${styleText(color, bar)} ${String(remaining).padStart(2)}s`
      : `${styleText('bold', fit(title, cols - 5))} ${styleText(color, `${String(remaining).padStart(2)}s`)}`;
    const above = offset;
    const below = Math.max(0, entries.length - offset - listHeight);
    if (camera) {
      // A colored band crosses behind the preview so the scanner state is obvious at a glance;
      // the text sits below on the plain background, where it stays readable.
      const banner = camera.banner ?? camera.idle;
      const color = BANNER[banner.style];
      const previewRows = Math.max(1, listHeight - 2);
      const lines = [header, ''];
      if (camera.frame) {
        lines.push(...renderPreview(camera.frame, cols - 1, previewRows, {
          margin: 4,
          backdrop: (y, outH) => {
            const band = Math.max(3, Math.round(outH / 4));
            const top = Math.floor((outH - band) / 2);
            return y >= top && y < top + band ? rgbBg(color) : '';
          },
        }));
      }
      while (lines.length < 2 + previewRows) lines.push('');
      const text = fit(cleanText(banner.text), cols - 3);
      const pad = ' '.repeat(Math.max(0, Math.floor((cols - 1 - text.length) / 2)));
      lines.push('', `${pad}${banner.style === 'scanning' ? `${CSI}1m` : rgbText(color)}${text}${CSI}0m`);
      const footer = status ? styleText(status.color, fit(` ${status.message}`, cols - 1)) : '';
      lines.push('', styleText('yellow', fit(CAMERA_HELP, cols - 1)), footer);
      return draw(lines, rows);
    }

    const lines = [header, above ? styleText('yellow', `  ↑ ${above} more`) : ''];

    const visible = entries.slice(offset, offset + listHeight);
    if (!entries.length) lines.push(styleText('yellow', fit('  No accounts yet. Press [c] to scan a QR code, or screenshot one and press [a].', cols - 1)));
    visible.forEach((otp, n) => {
      const i = offset + n;
      const code = formatCode(otp.generate({ timestamp: now })).padEnd(codeWidth);
      const prefix = `  ${code}   ${otp.issuer.padEnd(issuerWidth)}  `;
      const label = fit(otp.label, cols - 1 - prefix.length);
      if (i === selected) {
        // Dark gray bar across the full width with white text.
        lines.push(`${SELECTED}${fit(`› ${prefix.slice(2)}${label}`, cols - 1)}${CSI}K${CSI}0m`);
      } else {
        lines.push(`  ${styleText(color, code)}   ${otp.issuer.padEnd(issuerWidth)}  ${styleText('yellow', label)}`);
      }
    });
    while (lines.length < 2 + listHeight) lines.push('');

    const footer = input !== null
      ? fit(` Import file (QR image or accounts.js): ${input}█`, cols - 1)
      : status ? styleText(status.color, fit(` ${status.message}`, cols - 1)) : '';
    lines.push(below ? styleText('yellow', `  ↓ ${below} more`) : '', styleText('yellow', fit(HELP, cols - 1)), footer);

    draw(lines, rows);
  }

  // No trailing newline: writing past the last row would scroll the screen.
  function draw(lines, rows) {
    stdout.write(`${CSI}H${lines.slice(0, rows).map((l) => `${l}${CSI}K`).join('\n')}`);
  }

  let copied = null; // { code, timer } for the last code put on the clipboard

  // Clears the clipboard if it still holds the copied code (the user may have copied something else since).
  async function clearCopied() {
    if (!copied) return;
    const { code, timer } = copied;
    copied = null;
    clearTimeout(timer);
    try {
      if ((await readClipboard()).text === code) await clearClipboard();
    } catch {}
  }

  async function quit() {
    stdout.write(`${CSI}?25h${CSI}?1049l`);
    await clearCopied();
    process.exit(0);
  }

  // `cleanup` runs once the source held valid accounts (even if all were already stored).
  async function addFrom(label, load, cleanup) {
    busy = true;
    setStatus(label, 'yellow', true);
    try {
      const parsed = await load();
      let { added, message } = updateVault(vault, (v) => addAll(v, parsed));
      if (added) selected = vault.entries.length - 1;
      if (cleanup && parsed.otps.length) {
        try {
          await cleanup();
        } catch {
          message += ' (Could not clear the clipboard.)';
        }
      }
      setStatus(message, added ? 'green' : 'yellow');
    } catch (err) {
      setStatus(err.message, 'red');
    } finally {
      busy = false;
    }
  }

  async function startCamera() {
    const cam = { frame: null, stop: null, lastUri: null, seen: new Set(), hintTimer: null, bannerTimer: null,
      banner: { style: 'scanning', text: 'Starting camera…' }, // temporary message, shown over `idle`
      idle: { style: 'scanning', text: 'Looking for a QR code…' }, // resting state
    };
    camera = cam;
    status = null;
    render();
    try {
      cam.stop = await openCamera({
        onFrame(frame) {
          if (camera !== cam) return;
          if (!cam.frame) cam.banner = null;
          cam.frame = frame;
          // Bright phone screens overexpose webcams and wash out the code.
          cam.hintTimer ??= setTimeout(() => {
            if (camera === cam && !cam.lastUri) {
              cam.idle = { style: 'hint', text: "Not detecting? Turn your phone's brightness down and avoid glare" };
            }
          }, 6000);
          render();
          // Skip frames that arrive while the previous one is still being scanned.
          if (cam.decoding) return;
          cam.decoding = true;
          decodeFrame(frame).then((uri) => {
            cam.decoding = false;
            if (camera === cam && uri && uri !== cam.lastUri) onScan(cam, uri);
          });
        },
        onError(err) {
          if (camera !== cam) return;
          stopCamera();
          setStatus(err.message, 'red');
        },
      });
      if (camera !== cam) cam.stop(); // closed while it was starting
    } catch (err) {
      if (camera === cam) camera = null;
      setStatus(err.message, 'red');
    }
  }

  // Shows a banner briefly, then falls back to the resting state so it's clear scanning continues.
  function flashBanner(cam, banner, ms) {
    cam.banner = banner;
    clearTimeout(cam.bannerTimer);
    cam.bannerTimer = setTimeout(() => {
      if (camera !== cam) return;
      cam.banner = null;
      render();
    }, ms);
    render();
  }

  function stopCamera() {
    clearTimeout(camera?.hintTimer);
    clearTimeout(camera?.bannerTimer);
    camera?.stop?.();
    camera = null;
    stdout.write(`${CSI}2J`);
    render();
  }

  function onScan(cam, uri) {
    cam.lastUri = uri;
    let parsed;
    try {
      parsed = otpsFromString(uri);
    } catch (err) {
      return flashBanner(cam, { style: 'error', text: `✗ ${err.message}` }, 3000);
    }
    let added, message;
    try {
      ({ added, message } = updateVault(vault, (v) => addAll(v, parsed)));
    } catch (err) {
      return flashBanner(cam, { style: 'error', text: `✗ ${err.message}` }, 3000);
    }
    if (added) selected = vault.entries.length - 1;
    // Google Authenticator splits big exports across several QR codes: keep scanning until all are seen.
    const { index, size } = parsed.batch;
    cam.seen.add(index);
    if (cam.seen.size < size) {
      const missing = [...Array(size).keys()].filter((i) => !cam.seen.has(i)).map((i) => i + 1);
      setStatus(message, 'green', true);
      cam.idle = { style: 'scanning', text: `Looking for QR ${missing.join(', ')} of ${size}…` };
      return flashBanner(cam, { style: 'ready', text: `✓ QR ${index + 1} of ${size} added · show QR ${missing.join(', ')}` }, 2000);
    }
    stopCamera();
    setStatus(message, added ? 'green' : 'yellow');
  }

  async function copySelected() {
    const otp = vault.entries[selected];
    if (!otp) return;
    try {
      const code = otp.generate();
      await writeClipboard(code, { sensitive: true });
      clearTimeout(copied?.timer);
      copied = { code, timer: setTimeout(clearCopied, CLIPBOARD_CLEAR_MS) };
      setStatus(`Copied code for ${displayName(otp)}. Clipboard clears in 30s.`, 'green');
    } catch (err) {
      setStatus(`Could not copy: ${err.message}`, 'red');
    }
  }

  function onInputKey(str, key) {
    if (key.name === 'return') {
      const path = cleanPath(input);
      input = null;
      if (!path) return render();
      return addFrom(`Importing ${path}…`, () => otpsFromFile(path));
    }
    if (key.name === 'backspace') input = input.slice(0, -1);
    else if (str && !key.ctrl && !key.meta && str >= ' ') input += str;
    render();
  }

  // Handled on raw input so Esc acts instantly instead of after readline's escape-sequence delay.
  function onEscape() {
    if (busy) return;
    if (camera) return stopCamera(), setStatus('Camera closed.');
    if (input !== null) return (input = null), render();
    if (confirmDelete) return (confirmDelete = false), setStatus('Delete cancelled.');
    quit();
  }

  function onKey(str, key = {}) {
    if (key.ctrl && key.name === 'c') return quit();
    if (busy || camera || key.name === 'escape') return;
    if (input !== null) return onInputKey(str, key);

    if (confirmDelete) {
      confirmDelete = false;
      if (key.name !== 'y') return setStatus('Delete cancelled.');
      const otp = vault.entries[selected];
      try {
        // Matched by secret: the list may have been reloaded with other changes in between.
        updateVault(vault, (v) => (v.entries = v.entries.filter((e) => e.secret.base32 !== otp.secret.base32)));
      } catch (err) {
        return setStatus(err.message, 'red');
      }
      selected = Math.max(0, Math.min(selected, vault.entries.length - 1));
      return setStatus(`Deleted ${displayName(otp)}.`, 'yellow');
    }

    switch (key.name) {
      case 'q':
        return quit();
      case 'up':
      case 'k':
        selected = Math.max(0, selected - 1);
        return render();
      case 'down':
      case 'j':
        selected = Math.max(0, Math.min(vault.entries.length - 1, selected + 1));
        return render();
      case 'pageup':
      case 'pagedown': {
        const page = Math.max(1, (stdout.rows || 24) - 6);
        selected = Math.max(0, Math.min(vault.entries.length - 1, selected + (key.name === 'pageup' ? -page : page)));
        return render();
      }
      case 'home':
        selected = 0;
        return render();
      case 'end':
        selected = Math.max(0, vault.entries.length - 1);
        return render();
      case 'return':
        return copySelected();
      case 'a':
        return addFrom('Reading clipboard…', otpsFromClipboard, clearClipboard);
      case 'c':
        return startCamera();
      case 'i':
        input = '';
        return render();
      case 'd':
        if (!vault.entries[selected]) return;
        confirmDelete = true;
        return setStatus(`Delete ${displayName(vault.entries[selected])}? [y/N]`, 'yellow', true);
    }
  }

  // Alternate screen: codes disappear from scrollback when the CLI exits.
  stdout.write(`${CSI}?1049h${CSI}?25l`);
  process.on('exit', () => stdout.write(`${CSI}?25h${CSI}?1049l`));
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on('keypress', onKey);
  stdin.on('data', (chunk) => String(chunk) === '\x1b' && onEscape());
  stdout.on('resize', () => (stdout.write(`${CSI}2J`), render()));

  const tick = () => {
    // Picks up accounts added or removed by another running copy.
    if (!camera && refreshVault(vault)) selected = Math.max(0, Math.min(selected, vault.entries.length - 1));
    render();
    setTimeout(tick, 1000 - (Date.now() % 1000));
  };
  tick();
}
