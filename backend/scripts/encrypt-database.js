'use strict';

const crypto = require('crypto');
const fs = require('fs');
const maint = require('./maintenance-common');
const dbCrypto = require('../src/db-crypto');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.length === 1 && args[0] === '--dry-run';
  if (args.length && !dryRun) throw new Error('Usage: node scripts/encrypt-database.js [--dry-run]');
  maint.checkServerStopped();
  const raw = fs.readFileSync(maint.DB_FILE);
  if (dbCrypto.isEncrypted(raw)) {
    const db = JSON.parse(dbCrypto.decryptDatabase(raw).toString('utf8'));
    console.log(JSON.stringify({ encrypted: true, accounts: db.users.length, action: 'none' }, null, 2));
    return;
  }
  if (!dbCrypto.isPlaintextJson(raw)) throw new Error('Database is not valid plaintext JSON; no changes made.');
  const parsed = JSON.parse(raw.toString('utf8'));
  dbCrypto.encryptionKey();
  console.log(JSON.stringify({ encrypted: false, accounts: parsed.users.length, action: dryRun ? 'would encrypt database' : 'encrypt database' }, null, 2));
  if (dryRun) return;
  if (process.env.ENABLE_DATA_ENCRYPTION_MIGRATION !== '1') throw new Error('Set ENABLE_DATA_ENCRYPTION_MIGRATION=1 for this explicit migration.');
  if (!process.env.SYSTEM_BACKUP_PATH) throw new Error('Set SYSTEM_BACKUP_PATH to a new encrypted backup path outside the application.');
  const backup = maint.writeBackup(process.env.SYSTEM_BACKUP_PATH);
  await maint.askConfirmation('ENCRYPT DATABASE');
  const current = fs.readFileSync(maint.DB_FILE);
  if (!current.equals(raw)) throw new Error('Database changed after the preview; no encryption was committed.');
  maint.appendAudit(parsed, 'maintenance.database.encrypted', `accounts=${parsed.users.length}`);
  const encrypted = dbCrypto.encryptDatabase(Buffer.from(JSON.stringify(parsed)));
  const staged = maint.DB_FILE + `.encrypt-${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
  const previous = maint.DB_FILE + '.plaintext-rollback';
  let installed = false;
  try {
    fs.writeFileSync(staged, encrypted, { mode: 0o600, flag: 'wx' });
    fs.renameSync(maint.DB_FILE, previous);
    try { fs.renameSync(staged, maint.DB_FILE); installed = true; }
    catch (error) { fs.renameSync(previous, maint.DB_FILE); throw error; }
    fs.chmodSync(maint.DB_FILE, 0o600);
    const verified = dbCrypto.decryptDatabase(fs.readFileSync(maint.DB_FILE));
    const decoded = JSON.parse(verified.toString('utf8'));
    if (maint.sha256(Buffer.from(JSON.stringify(decoded))) !== maint.sha256(Buffer.from(JSON.stringify(parsed)))) throw new Error('Encrypted database verification failed.');
    fs.rmSync(previous, { force: true });
    console.log(`Database encryption completed. Encrypted backup: ${backup}`);
  } catch (error) {
    if (installed) {
      try { fs.rmSync(maint.DB_FILE, { force: true }); } catch {}
      try { fs.renameSync(previous, maint.DB_FILE); } catch {}
    }
    throw error;
  } finally { try { fs.rmSync(staged, { force: true }); } catch {} }
}

main().catch(error => { console.error('[database encryption]', error.message); process.exitCode = 1; });
