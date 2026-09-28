#!/usr/bin/env node

import { addAll } from './accounts.js';
import { promptHidden } from './prompt.js';
import { otpsFromFile, otpsFromString } from './qr.js';
import { runUi } from './ui.js';
import { changePassword, createVault, openVault, updateVault, vaultExists, vaultPath } from './vault.js';

const USAGE = `Usage:
  auth                      show live codes
  auth add                  paste an otpauth:// or Google Authenticator export link (hidden)
  auth import <file>        import a QR code image (PNG, JPEG, ...) or a legacy accounts.js file
  auth passwd               change the master password`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function newPassword(label) {
  const password = await promptHidden(`${label}: `);
  if (password.length < 8) fail('Use at least 8 characters.');
  if ((await promptHidden('Confirm password: ')) !== password) fail("Passwords don't match.");
  return password;
}

async function unlock() {
  if (vaultExists()) return openVault(await promptHidden('Master password: '));
  console.log(`No vault yet. Creating one at ${vaultPath}`);
  return createVault(await newPassword('New master password'));
}

async function addAndSave(parsed) {
  const vault = await unlock();
  const { message } = updateVault(vault, (v) => addAll(v, parsed));
  console.log(message);
}

const [cmd, ...args] = process.argv.slice(2);

try {
  switch (cmd) {
    case undefined: {
      if (!process.stdin.isTTY) fail('The live view needs an interactive terminal.');
      runUi(await unlock());
      break;
    }
    case 'add': {
      // `add --image` is kept as an alias for `import`.
      if (args[0] === '--image') {
        await addAndSave(await otpsFromFile(args[1] ?? fail(USAGE)));
        break;
      }
      if (args[0]) {
        console.error('Warning: the link is now in your shell history. Run `auth add` without arguments to paste it instead.');
      }
      // Prompted with hidden input so the secret never lands in shell history or the process list.
      const uri = args[0] ?? (await promptHidden('otpauth link: ')).trim();
      await addAndSave(otpsFromString(uri));
      break;
    }
    case 'import':
      if (!args[0]) fail(USAGE);
      await addAndSave(await otpsFromFile(args[0]));
      break;
    case 'passwd': {
      const vault = await unlock();
      changePassword(vault, await newPassword('New master password'));
      console.log('Password changed.');
      break;
    }
    case 'help':
    case '-h':
    case '--help':
      console.log(USAGE);
      break;
    default:
      fail(USAGE);
  }
} catch (err) {
  fail(err.message);
}
