#!/usr/bin/env node

import { addAll } from './accounts.js';
import { promptHidden } from './prompt.js';
import { otpsFromFile, otpsFromString } from './qr.js';
import { runUi } from './ui.js';
import { changePassword, createVault, openVault, saveVault, vaultExists, vaultPath } from './vault.js';

const USAGE = `Usage:
  auth                      show live codes
  auth add <uri>            add from an otpauth:// or Google Authenticator export link
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
  const { added, message } = addAll(vault, parsed);
  if (added) saveVault(vault);
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
    case 'add':
      if (!args[0]) fail(USAGE);
      // `add --image` is kept as an alias for `import`.
      await addAndSave(args[0] === '--image' ? await otpsFromFile(args[1] ?? fail(USAGE)) : otpsFromString(args[0]));
      break;
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
