'use strict';

const crypto = require('crypto');
const fs = require('fs');
const maint = require('./maintenance-common');
const dbCrypto = require('../src/db-crypto');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.length === 1 && args[0] === '--dry-run';
  if (args.length && !dryRun) throw new Error('Usage: node scripts/clear-notifications.js [--dry-run]');
  maint.checkServerStopped();
  const db = maint.readDatabase();
  if (!Array.isArray(db.notifications)) throw new Error('Notification collection is missing; no changes made.');
  const original = Buffer.from(JSON.stringify(db));
  const count = db.notifications.length;
  console.log(JSON.stringify({ notifications: count, action: dryRun ? 'would clear notifications' : 'clear notifications' }, null, 2));
  if (dryRun || count === 0) return;

  if (process.env.ENABLE_DESTRUCTIVE_MAINTENANCE !== '1') throw new Error('Set ENABLE_DESTRUCTIVE_MAINTENANCE=1 for this explicit maintenance run.');
  if (!process.env.SYSTEM_BACKUP_PATH) throw new Error('Set SYSTEM_BACKUP_PATH to a new encrypted backup path outside the application.');

  const backupPath = maint.writeBackup(process.env.SYSTEM_BACKUP_PATH);
  const backupPayload = maint.readBackup(backupPath);
  const backupDb = JSON.parse(Buffer.from(backupPayload.database, 'base64').toString('utf8'));
  if (maint.sha256(Buffer.from(JSON.stringify(backupDb))) !== maint.sha256(original)) {
    throw new Error('Encrypted backup verification failed; no changes made.');
  }
  await maint.askConfirmation(`CLEAR ALL NOTIFICATIONS ${count}`);

  const live = maint.readDatabase();
  if (maint.sha256(Buffer.from(JSON.stringify(live))) !== maint.sha256(original)) {
    throw new Error('Database changed after preview; no changes were committed.');
  }
  live.notifications = [];
  maint.appendAudit(live, 'maintenance.notifications.cleared', `removed=${count}`);
  const staged = maint.DB_FILE + `.notifications-${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
  const rollback = maint.DB_FILE + '.notifications-rollback';
  if (fs.existsSync(rollback)) throw new Error('A previous notification rollback file exists; inspect it before retrying.');
  let installed = false;
  try {
    fs.writeFileSync(staged, maint.encryptedDatabaseBytes(live), { mode: 0o600, flag: 'wx' });
    fs.renameSync(maint.DB_FILE, rollback);
    try { fs.renameSync(staged, maint.DB_FILE); installed = true; }
    catch (error) { fs.renameSync(rollback, maint.DB_FILE); throw error; }
    fs.chmodSync(maint.DB_FILE, 0o600);
    const verified = JSON.parse(dbCrypto.decryptDatabase(fs.readFileSync(maint.DB_FILE)).toString('utf8'));
    if (!Array.isArray(verified.notifications) || verified.notifications.length !== 0) throw new Error('Post-write verification failed.');
    fs.rmSync(rollback, { force: true });
    console.log(`Cleared ${count} notifications. Encrypted backup: ${backupPath}`);
  } catch (error) {
    if (installed) {
      try { fs.rmSync(maint.DB_FILE, { force: true }); } catch {}
      try { fs.renameSync(rollback, maint.DB_FILE); } catch {}
    }
    throw error;
  } finally { try { fs.rmSync(staged, { force: true }); } catch {} }
}

main().catch(error => { console.error('[clear notifications]', error.message); process.exitCode = 1; });
