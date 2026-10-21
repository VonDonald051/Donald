'use strict';

const fs = require('fs');
const crypto = require('crypto');
const maint = require('./maintenance-common');
const migration = require('../migrations/001-system-agreements');

function atomicWrite(bytes) {
  const temporary = maint.DB_FILE + `.migration-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const previous = maint.DB_FILE + '.migration-rollback';
  let replaced = false;
  try {
    fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
    fs.renameSync(maint.DB_FILE, previous);
    try { fs.renameSync(temporary, maint.DB_FILE); replaced = true; }
    catch (error) { fs.renameSync(previous, maint.DB_FILE); throw error; }
    fs.chmodSync(maint.DB_FILE, 0o600);
    fs.rmSync(previous, { force: true });
  } catch (error) {
    if (replaced) {
      try { fs.rmSync(maint.DB_FILE, { force: true }); } catch {}
      try { fs.renameSync(previous, maint.DB_FILE); } catch {}
    }
    throw error;
  } finally { try { fs.rmSync(temporary, { force: true }); } catch {} }
}

function main() {
  const [direction, id] = process.argv.slice(2);
  if (!['up', 'down'].includes(direction) || id !== migration.ID || process.argv.length !== 4) {
    console.log(`Usage: node scripts/migrate.js <up|down> ${migration.ID}`);
    process.exitCode = 2; return;
  }
  maint.checkServerStopped();
  if (process.env.ENABLE_SCHEMA_MIGRATIONS !== '1') throw new Error('Set ENABLE_SCHEMA_MIGRATIONS=1 for an explicit migration run.');
  if (!process.env.SYSTEM_BACKUP_PATH) throw new Error('Set SYSTEM_BACKUP_PATH to a new encrypted backup path outside the application.');
  const backup = maint.writeBackup(process.env.SYSTEM_BACKUP_PATH);
  const db = maint.readDatabase();
  const changed = direction === 'up' ? migration.up(db) : migration.down(db);
  maint.appendAudit(changed, `migration.${direction}`, migration.ID);
  atomicWrite(maint.encryptedDatabaseBytes(changed));
  console.log(`Migration ${direction} complete: ${migration.ID}. Encrypted backup: ${backup}`);
}

try { main(); }
catch (error) { console.error('[migration]', error.message); process.exitCode = 1; }
