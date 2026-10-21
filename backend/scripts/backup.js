'use strict';

const fs = require('fs');
const path = require('path');
const maint = require('./maintenance-common');

function usage() {
  console.log('Usage:');
  console.log('  node backend/scripts/backup.js self-check');
  console.log('  node backend/scripts/backup.js create <backup-path-outside-app>');
  console.log('  node backend/scripts/backup.js verify <backup-path-outside-app>');
  console.log('  node backend/scripts/backup.js restore <backup-path-outside-app>');
}

async function restore(source) {
  maint.checkServerStopped();
  const payload = maint.readBackup(source);
  const preRestore = process.env.SYSTEM_PRE_RESTORE_BACKUP_PATH || '';
  if (!preRestore) throw new Error('Set SYSTEM_PRE_RESTORE_BACKUP_PATH to an encrypted outside-app backup before restoring.');
  const saved = maint.writeBackup(preRestore);
  const restoredDb = JSON.parse(Buffer.from(payload.database, 'base64').toString('utf8'));
  const dbDir = path.dirname(maint.DB_FILE);
  const dbStage = path.join(dbDir, `.restore-${process.pid}-${Date.now()}.json`);
  const uploadsStage = maint.UPLOADS_DIR + `.restore-${process.pid}-${Date.now()}`;
  const privateStage = maint.PRIVATE_AGREEMENTS_DIR + `.restore-${process.pid}-${Date.now()}`;
  const dbOld = maint.DB_FILE + `.before-restore-${process.pid}`;
  const uploadsOld = maint.UPLOADS_DIR + `.before-restore-${process.pid}`;
  const privateOld = maint.PRIVATE_AGREEMENTS_DIR + `.before-restore-${process.pid}`;
  const stagedData = [];
  const savedData = [];
  let dbMoved = false, uploadsMoved = false, privateMoved = false, dbInstalled = false, uploadsInstalled = false, privateInstalled = false, committed = false;
  try {
    fs.writeFileSync(dbStage, maint.encryptedDatabaseBytes(restoredDb), { mode: 0o600, flag: 'wx' });
    fs.mkdirSync(uploadsStage, { mode: 0o700 });
    fs.mkdirSync(privateStage, { recursive: true, mode: 0o700 });
    for (const [name, record] of Object.entries(payload.files)) fs.writeFileSync(path.join(uploadsStage, name), Buffer.from(record.data, 'base64'), { mode: 0o600, flag: 'wx' });
    for (const [name, record] of Object.entries(payload.privateAgreements || {})) fs.writeFileSync(path.join(privateStage, name), Buffer.from(record.data, 'base64'), { mode: 0o600, flag: 'wx' });
    for (const [name, record] of Object.entries(payload.auxiliary)) {
      const target = path.join(dbDir, name);
      const stage = target + `.restore-${process.pid}`;
      const old = target + `.before-restore-${process.pid}`;
      fs.writeFileSync(stage, Buffer.from(record.data, 'base64'), { mode: 0o600, flag: 'wx' });
      stagedData.push({ target, stage, old, moved: false, installed: false });
    }
    if (fs.existsSync(maint.DB_FILE)) { fs.renameSync(maint.DB_FILE, dbOld); dbMoved = true; }
    if (fs.existsSync(maint.UPLOADS_DIR)) { fs.renameSync(maint.UPLOADS_DIR, uploadsOld); uploadsMoved = true; }
    if (fs.existsSync(maint.PRIVATE_AGREEMENTS_DIR)) { fs.renameSync(maint.PRIVATE_AGREEMENTS_DIR, privateOld); privateMoved = true; }
    for (const entry of stagedData) {
      if (fs.existsSync(entry.target)) { fs.renameSync(entry.target, entry.old); entry.moved = true; savedData.push(entry); }
      fs.renameSync(entry.stage, entry.target); entry.installed = true;
    }
    fs.renameSync(dbStage, maint.DB_FILE); dbInstalled = true;
    fs.renameSync(uploadsStage, maint.UPLOADS_DIR); uploadsInstalled = true;
    fs.renameSync(privateStage, maint.PRIVATE_AGREEMENTS_DIR); privateInstalled = true;
    fs.chmodSync(maint.DB_FILE, 0o600);
    fs.chmodSync(maint.UPLOADS_DIR, 0o700);
    fs.chmodSync(maint.PRIVATE_AGREEMENTS_DIR, 0o700);
    committed = true;
    try { fs.rmSync(dbOld, { force: true }); } catch {}
    try { fs.rmSync(uploadsOld, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(privateOld, { recursive: true, force: true }); } catch {}
    for (const entry of savedData) { try { fs.rmSync(entry.old, { force: true }); } catch {} }
    console.log(`Restore completed. Pre-restore encrypted backup: ${saved}`);
  } catch (error) {
    if (committed) throw new Error('Restore completed, but cleanup of superseded temporary files was incomplete.');
    try { if (uploadsInstalled) fs.rmSync(maint.UPLOADS_DIR, { recursive: true, force: true }); } catch {}
    try { if (privateInstalled) fs.rmSync(maint.PRIVATE_AGREEMENTS_DIR, { recursive: true, force: true }); } catch {}
    try { if (dbInstalled) fs.rmSync(maint.DB_FILE, { force: true }); } catch {}
    for (const entry of stagedData.slice().reverse()) {
      try { if (entry.installed) fs.rmSync(entry.target, { force: true }); } catch {}
      try { if (entry.moved && fs.existsSync(entry.old)) fs.renameSync(entry.old, entry.target); } catch {}
    }
    try { if (uploadsMoved && fs.existsSync(uploadsOld)) fs.renameSync(uploadsOld, maint.UPLOADS_DIR); } catch {}
    try { if (privateMoved && fs.existsSync(privateOld)) fs.renameSync(privateOld, maint.PRIVATE_AGREEMENTS_DIR); } catch {}
    try { if (dbMoved && fs.existsSync(dbOld)) fs.renameSync(dbOld, maint.DB_FILE); } catch {}
    throw error;
  } finally {
    try { fs.rmSync(dbStage, { force: true }); } catch {}
    try { fs.rmSync(uploadsStage, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(privateStage, { recursive: true, force: true }); } catch {}
    for (const entry of stagedData) { try { fs.rmSync(entry.stage, { force: true }); } catch {} }
  }
}

async function main() {
  const [command, file] = process.argv.slice(2);
  if (command === 'self-check') {
    maint.selfCheck();
    console.log('Backup encryption, decryption, checksum, and tamper rejection self-check passed.');
    return;
  }
  if (command === 'create' && file) {
    const target = maint.writeBackup(file);
    console.log(`Encrypted backup created: ${target}`);
    return;
  }
  if (command === 'verify' && file) {
    const payload = maint.readBackup(file);
    const db = JSON.parse(Buffer.from(payload.database, 'base64').toString('utf8'));
    console.log(`Backup verified. Created at ${payload.createdAt}; accounts=${db.users.length}; files=${Object.keys(payload.files).length}.`);
    return;
  }
  if (command === 'restore' && file) {
    if (!process.stdin.isTTY) throw new Error('Restore requires an interactive terminal.');
    await maint.askConfirmation('RESTORE BACKUP');
    await restore(file);
    return;
  }
  usage();
  process.exitCode = 2;
}

main().catch(error => { console.error('[backup]', error.message); process.exitCode = 1; });
