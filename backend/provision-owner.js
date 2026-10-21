'use strict';

process.umask(0o077);
const dbm = require('./src/db');
const sec = require('./src/security');

function ask(label, hidden = false) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY || typeof input.setRawMode !== 'function') {
      reject(new Error('Run this command directly in an interactive terminal.'));
      return;
    }
    let value = '';
    process.stdout.write(label);
    input.setRawMode(true);
    input.resume();
    const finish = (error) => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onData = chunk => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') return finish(new Error('Cancelled.'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
          if (!hidden) process.stdout.write('\b \b');
          continue;
        }
        if (character >= ' ') {
          value += character;
          if (!hidden) process.stdout.write(character);
        }
      }
    };
    input.on('data', onData);
  });
}

async function main() {
  dbm.load();
  if (dbm.db.users.length) throw new Error('Owner provisioning is allowed only when the users collection is empty.');

  const firstName = (await ask('Owner first name: ')).trim();
  const lastName = (await ask('Owner last name: ')).trim();
  const email = (await ask('Owner email: ')).trim().toLowerCase();
  const phone = (await ask('Owner phone: ')).trim();
  const password = await ask('Owner password (input hidden): ', true);
  const confirmation = await ask('Confirm password (input hidden): ', true);

  const issues = sec.passwordIssues(password);
  if (!sec.isName(firstName) || !sec.isName(lastName)) throw new Error('Valid first and last names are required.');
  if (!sec.isEmail(email)) throw new Error('A valid email address is required.');
  if (!sec.isPhone(phone)) throw new Error('A valid phone number is required.');
  if (issues.length) throw new Error('Password does not meet the policy: ' + issues.join(', ') + '.');
  if (password !== confirmation) throw new Error('Passwords do not match.');

  const createdAt = new Date().toISOString();
  dbm.db.users.push({
    id: dbm.next('user'), firstName, lastName, email, phone,
    role: 'v_super_admin', groupId: null,
    passHash: sec.hashPassword(password), pic: null, ecdhPub: null,
    failed: 0, locked: false, disabled: false, deleted: false,
    createdAt, updatedAt: createdAt
  });
  dbm.save();
  dbm.audit(null, 'owner.bootstrap.created', email, null);
  console.log('Owner account created. Start the system with: node server.js');
}

main().catch(error => {
  console.error('[owner provisioning]', error.message);
  process.exitCode = 1;
});