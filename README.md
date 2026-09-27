# cli-authenticator

A TOTP authenticator for the terminal. Your secrets live in an encrypted vault and are only ever decrypted in memory.

```
npm install -g cli-authenticator
auth
```

## Usage

Run `auth`, enter your master password, and your codes show up right away. The first run creates the vault.

| Key | Action |
|---|---|
| `↑` `↓` / `j` `k` | select (PgUp/PgDn, Home/End to jump) |
| `enter` | copy the selected code |
| `a` | add from the clipboard (screenshot of a QR code, or an `otpauth://` link) |
| `c` | scan a QR code with the camera |
| `i` | import a file (QR image or legacy `accounts.js`) |
| `d` | delete the selected account |
| `esc` / `q` | quit |

Google Authenticator export QR codes (`otpauth-migration://`) are supported everywhere. When an export spans several QR codes, the camera keeps scanning until it has them all.

After an import from the clipboard, the clipboard is cleared.

### Commands

```
auth                      show live codes
auth add <uri>            add from an otpauth:// or Google Authenticator export link
auth import <file>        import a QR code image (PNG, JPEG, ...) or a legacy accounts.js file
auth passwd               change the master password
```

## Security

- The vault is a single file encrypted with AES-256-GCM. The key is derived from your master password with scrypt and is never stored.
  - Windows: `%APPDATA%\cli-authenticator\vault.json`
  - macOS: `~/Library/Application Support/cli-authenticator/vault.json`
  - Linux: `$XDG_CONFIG_HOME/cli-authenticator/vault.json`
  - Override with the `AUTH_VAULT` environment variable.
- Codes are drawn on the terminal's alternate screen, so they don't stay in the scrollback after you quit.
- QR decoding runs locally (ZXing compiled to WebAssembly); nothing is fetched from the network.
- Clipboard *history* (Windows `Win+V`, clipboard managers) keeps its own copies. Clear those yourself after importing from a screenshot.

## Camera tips

If the camera doesn't detect a code shown on a phone, turn the phone's brightness down. A bright screen overexposes webcams and washes out the code. Also avoid glare and hold the phone 20–30 cm away.

The camera is accessed through ffmpeg (bundled via `ffmpeg-static`): DirectShow on Windows, AVFoundation on macOS, and `/dev/video*` on Linux.

## Requirements

Node.js 20.12 or newer. On Linux, clipboard support needs `wl-clipboard` (Wayland) or `xclip` (X11).
