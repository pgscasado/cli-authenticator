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
| `enter` | copy the selected code (cleared from the clipboard after 30s) |
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
auth add                  paste an otpauth:// or Google Authenticator export link (hidden input)
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
- Legacy `accounts.js` files are parsed as text, never executed.
- Account names are stripped of control characters, so a crafted QR code can't inject terminal escape sequences.
- Copied codes are cleared from the clipboard after 30 seconds (or when you quit) if they're still there. On Windows they're also kept out of clipboard history and cloud sync.
- `auth add` reads the link from a hidden prompt, so the secret doesn't land in your shell history.
- Screenshots of QR codes still go into clipboard *history* (Windows `Win+V`, clipboard managers). Clear those yourself after importing.
- Several `auth` processes can run at once: saves are locked and merged, and the list picks up changes from other sessions.

## Camera tips

If the camera doesn't detect a code shown on a phone, turn the phone's brightness down. A bright screen overexposes webcams and washes out the code. Also avoid glare and hold the phone 20–30 cm away.

The camera uses ffmpeg from your system (DirectShow on Windows, AVFoundation on macOS, `/dev/video*` on Linux). It isn't bundled, so installing this package never downloads binaries. Install ffmpeg with your package manager, or point `FFMPEG_PATH` at an ffmpeg binary:

```
winget install Gyan.FFmpeg     # Windows
brew install ffmpeg            # macOS
sudo apt install ffmpeg        # Debian/Ubuntu
```

## Requirements

Node.js 20.12 or newer. The camera needs ffmpeg (see above). On Linux, clipboard support needs `wl-clipboard` (Wayland) or `xclip` (X11).
