#!/usr/bin/env node

import Spinnies from 'terminal-multi-spinners';
import { accounts } from '../accounts.js';
import totp from 'totp-generator';

const sleep = (ms = 1000) => new Promise((r) => setTimeout(r, ms));
const frames = '⠇⠋⠙⠸⠴⠦'.split('');
const spinnies = new Spinnies({ frames });

async function showCodes() {
  const expiresIn = (30 - Math.round(new Date().getTime() / 1000) % 30);
  let spinnerColor = 'green';
  if (expiresIn <= 20) {
    spinnerColor = 'yellow';
  }
  if (expiresIn <= 10) {
    spinnerColor = 'red';
  }
  
  
  accounts.forEach((acc, idx) => {
    if (acc.name.split(':')[1]){
      acc.name = acc.name.split(':')[1];
    }
    if (spinnies.pick(`${idx}`)) {
      spinnies.update(`${idx}`, { text: `${totp(acc.totpSecret)}: ${acc.name}`, spinnerColor })
    } else {
      spinnies.add(`${idx}`, { text: `${totp(acc.totpSecret)}: ${acc.name}`, spinnerColor })
    }
  });
  if (spinnies.pick('counter')) {
    spinnies.update('counter', {
      text: `Expirando em ${(30 - Math.round(new Date().getTime() / 1000) % 30)}`,
      status: 'non-spinnable',
      color: spinnerColor
    })
  } else {
    spinnies.add('counter', {
      text: `Expirando em ${(30 - Math.round(new Date().getTime() / 1000) % 30)}`,
      status: 'non-spinnable',
      color: spinnerColor
    })
  }
  await sleep();
  showCodes();
}
console.clear();
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', function() {
  console.clear();
  process.exit(process, 0);
});
showCodes();
