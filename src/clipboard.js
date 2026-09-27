import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const maxBuffer = 64 * 1024 * 1024;

async function tryExec(cmd, args, encoding = 'buffer') {
  try {
    const { stdout } = await exec(cmd, args, { encoding, maxBuffer });
    return stdout.length ? stdout : null;
  } catch {
    return null;
  }
}

function pipeTo(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, (err) => (err ? reject(err) : resolve()));
    child.stdin.end(input);
  });
}

// Resolves to { image: Buffer } (PNG) or { text: string }. Nothing touches the disk.
export async function readClipboard() {
  if (process.platform === 'win32') {
    const script = `
      Add-Type -AssemblyName System.Windows.Forms, System.Drawing
      $img = [System.Windows.Forms.Clipboard]::GetImage()
      if ($img) {
        $ms = New-Object System.IO.MemoryStream
        $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        'IMG:' + [Convert]::ToBase64String($ms.ToArray())
      } else { 'TXT:' + [System.Windows.Forms.Clipboard]::GetText() }`;
    const out = (await tryExec('powershell.exe', ['-NoProfile', '-STA', '-Command', script], 'utf8'))?.trim() ?? '';
    if (out.startsWith('IMG:')) return { image: Buffer.from(out.slice(4), 'base64') };
    return { text: out.replace(/^TXT:/, '') };
  }

  if (process.platform === 'darwin') {
    // Prints «data PNGf89504E47...» when the clipboard holds an image.
    const out = await tryExec('osascript', ['-e', 'the clipboard as «class PNGf»'], 'utf8');
    const hex = out?.match(/«data PNGf([0-9A-Fa-f]+)»/)?.[1];
    if (hex) return { image: Buffer.from(hex, 'hex') };
    return { text: (await tryExec('pbpaste', [], 'utf8')) ?? '' };
  }

  const image =
    (await tryExec('wl-paste', ['--no-newline', '--type', 'image/png'])) ??
    (await tryExec('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']));
  if (image) return { image };
  const text =
    (await tryExec('wl-paste', ['--no-newline'], 'utf8')) ??
    (await tryExec('xclip', ['-selection', 'clipboard', '-o'], 'utf8'));
  if (text === null && !process.env.WAYLAND_DISPLAY && !process.env.DISPLAY) {
    throw new Error('No clipboard available (no display).');
  }
  return { text: text ?? '' };
}

export async function writeClipboard(text) {
  if (process.platform === 'win32') return pipeTo('clip.exe', [], text);
  if (process.platform === 'darwin') return pipeTo('pbcopy', [], text);
  try {
    await pipeTo('wl-copy', [], text);
  } catch {
    await pipeTo('xclip', ['-selection', 'clipboard'], text);
  }
}

// Empties the clipboard so an imported QR code or link doesn't linger there.
export async function clearClipboard() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    try {
      return await pipeTo('wl-copy', ['--clear'], '');
    } catch {}
  }
  return writeClipboard('');
}
