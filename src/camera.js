import { execFile, spawn } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { decodePixels } from './decode.js';

const CSI = '\x1b[';

// Uses the system's ffmpeg (or FFMPEG_PATH), installed through a package manager that verifies it,
// rather than a binary downloaded by npm at install time.
const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';

// lstat, not exists: Windows installs winget as an app execution alias, which can't be stat'ed.
function present(file) {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

function onPath(command) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD').split(';') : [''];
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && exts.some((ext) => present(join(dir, command + ext))));
}

// The install command for this OS, using the first package manager found.
const INSTALLERS = {
  win32: [['winget', 'winget install Gyan.FFmpeg'], ['choco', 'choco install ffmpeg'], ['scoop', 'scoop install ffmpeg']],
  darwin: [['brew', 'brew install ffmpeg'], ['port', 'sudo port install ffmpeg']],
  linux: [
    ['apt', 'sudo apt install ffmpeg'],
    ['dnf', 'sudo dnf install ffmpeg-free'],
    ['pacman', 'sudo pacman -S ffmpeg'],
    ['zypper', 'sudo zypper install ffmpeg'],
    ['apk', 'sudo apk add ffmpeg'],
  ],
};

export function ffmpegInstallCommand() {
  return (INSTALLERS[process.platform] ?? []).find(([manager]) => onPath(manager))?.[1] ?? null;
}

// ENOENT from spawning ffmpeg means it isn't installed; tag the error so the UI can guide the user.
function friendly(err) {
  if (err?.code !== 'ENOENT') return err;
  const missing = new Error('The camera needs ffmpeg, which is not installed.');
  missing.code = 'NO_FFMPEG';
  missing.installCommand = ffmpegInstallCommand();
  return missing;
}

// ffmpeg exits non-zero when only listing devices, so read stderr either way.
function listDevices(args) {
  return new Promise((resolve, reject) =>
    execFile(ffmpegPath, ['-hide_banner', ...args], (err, _out, stderr) =>
      err?.code === 'ENOENT' ? reject(friendly(err)) : resolve(stderr)));
}

async function cameraInput() {
  if (process.platform === 'win32') {
    const out = await listDevices(['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
    const name = out.match(/"([^"]+)" \(video\)/)?.[1];
    if (!name) throw new Error('No camera found.');
    return ['-f', 'dshow', '-i', `video=${name}`];
  }
  if (process.platform === 'darwin') {
    const out = await listDevices(['-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
    const videoSection = out.split(/AVFoundation audio devices/)[0];
    const index = [...videoSection.matchAll(/\] \[(\d+)\] (.+)/g)].find(([, , name]) => !/capture screen/i.test(name))?.[1];
    if (index === undefined) throw new Error('No camera found.');
    return ['-f', 'avfoundation', '-framerate', '30', '-i', index];
  }
  const device = ['/dev/video0', '/dev/video1', '/dev/video2'].find(existsSync);
  if (!device) throw new Error('No camera found.');
  return ['-f', 'v4l2', '-i', device];
}

// Streams grayscale frames ({ width, height, data }) from ffmpeg. Returns a stop function.
// Frames stay at the camera's native resolution (capped) so dense QR codes, like exports, stay readable.
export function startCapture(inputArgs, { fps = 8, maxWidth = 1920, onFrame, onError }) {
  const child = spawn(ffmpegPath, [
    '-hide_banner', '-nostats', ...inputArgs,
    '-vf', `fps=${fps},scale=w=min(${maxWidth}\\,iw):h=-2`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  let size = null;
  let pending = Buffer.alloc(0);
  let stopped = false;

  const stop = () => {
    stopped = true;
    child.kill();
  };
  process.on('exit', stop);

  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-8192);
    if (!size) {
      const match = stderr.match(/Output #0[\s\S]*?Video: rawvideo[^\n]*?, (\d+)x(\d+)/);
      if (match) size = { width: Number(match[1]), height: Number(match[2]) };
    }
  });

  child.stdout.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    if (!size) return;
    const frameBytes = size.width * size.height;
    if (pending.length < frameBytes) return;
    // Only the newest complete frame matters; drop any backlog.
    const frames = Math.floor(pending.length / frameBytes);
    const data = Buffer.from(pending.subarray((frames - 1) * frameBytes, frames * frameBytes));
    pending = pending.subarray(frames * frameBytes);
    onFrame({ ...size, data });
  });

  child.on('error', (err) => {
    if (stopped) return;
    stopped = true;
    onError(friendly(err));
  });
  child.on('exit', () => {
    process.off('exit', stop);
    if (stopped) return;
    const reason = stderr.trim().split('\n').filter((l) => !l.startsWith('  ')).pop() ?? 'unknown error';
    onError(new Error(`Camera stopped: ${reason.trim()}`));
  });

  return stop;
}

export async function openCamera(handlers) {
  return startCapture(await cameraInput(), handlers);
}

let rgba;

export function decodeFrame({ width, height, data }) {
  const bytes = width * height * 4;
  if (rgba?.length !== bytes) rgba = new Uint8ClampedArray(bytes);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    rgba[j] = rgba[j + 1] = rgba[j + 2] = data[i];
    rgba[j + 3] = 255;
  }
  return decodePixels(rgba, width, height);
}

// Draws a frame into `cols` x `rows` cells: each '▀' shows two pixels (fg = top, bg = bottom).
// Mirrored horizontally, like a selfie view, so it's easier to aim.
// `margin` keeps columns free on both sides; `backdrop(y, outH)` returns a background style for them.
export function renderPreview({ width, height, data }, cols, rows, { margin = 0, backdrop = () => '' } = {}) {
  const maxW = Math.max(1, cols - 2 * margin);
  const scale = Math.max(width / maxW, height / (rows * 2));
  const outW = Math.min(maxW, Math.floor(width / scale));
  const outH = Math.min(rows, Math.floor(height / scale / 2));
  const pad = ' '.repeat(Math.floor((cols - outW) / 2));
  const pixel = (x, y) => data[Math.min(height - 1, Math.floor(y * scale)) * width + Math.floor((outW - 1 - x) * scale)];

  const lines = [];
  for (let y = 0; y < outH; y++) {
    const bg = backdrop(y, outH);
    let line = bg + pad;
    let last = '';
    for (let x = 0; x < outW; x++) {
      const top = pixel(x, y * 2);
      const bottom = pixel(x, y * 2 + 1);
      const color = `${CSI}38;2;${top};${top};${top};48;2;${bottom};${bottom};${bottom}m`;
      line += (color === last ? '' : color) + '▀';
      last = color;
    }
    // With a backdrop, erase-to-end-of-line paints the right margin in the same color.
    lines.push(bg ? `${line}${CSI}0m${bg}${CSI}K${CSI}0m` : `${line}${CSI}0m`);
  }
  return lines;
}
