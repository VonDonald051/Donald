'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const maint = require('./maintenance-common');

function usage() { console.log('Usage: node scripts/reset-accounts.js [--dry-run]'); }
function readDb() {
  const db = maint.readDatabase();
  if (!Array.isArray(db.users) || !Array.isArray(db.audit)) throw new Error('Database structure is incomplete; no changes made.');
  return db;
}
function userReferences(row, removed) {
  if (!row || typeof row !== 'object') return false;
  const keys = ['userId', 'memberId', 'senderId', 'recipientId', 'createdBy', 'handledBy', 'verifiedBy', 'clearedBy', 'reportedBy', 'approvedBy', 'groupAdminSignedBy'];
  return keys.some(key => removed.has(Number(row[key])));
}
function dataChanges(db, owner, removed) {
  const ids = new Set(removed.map(user => user.id));
  const counts = {};
  db.users = db.users.filter(user => user.id === owner.id);
  if (!db.settings || typeof db.settings !== 'object') db.settings = {};
  delete db.settings.ownerMfaEnforced;
  owner.email = maint.OWNER_EMAIL;
  owner.passwordChangeRequired = true;
  owner.failed = 0; owner.locked = false; owner.disabled = false; owner.deleted = false;
  for (const field of ['mfaRequired', 'mfaSecretEnc', 'mfaEnabled', 'mfaType', 'mfaPhone', 'mfaLastStep']) delete owner[field];
  owner.updatedAt = new Date().toISOString();
  if (db.settings) { db.settings.ownerOtpEnabled = '0'; db.settings.ownerOtpCode = null; db.settings.ownerOtpExpires = null; }
  for (const key of Object.keys(db)) {
    if (!Array.isArray(db[key]) || key === 'audit' || key === 'users') continue;
    const before = db[key].length;
    if (key === 'agreements' || key === 'systemAgreements') db[key] = [];
    else if (key === 'memberProfiles') db[key] = db[key].filter(row => !ids.has(Number(row.userId)));
    else if (key === 'requests') db[key] = [];
    else db[key] = db[key].filter(row => !userReferences(row, ids));
    counts[key] = before - db[key].length;
  }
  maint.appendAudit(db, 'maintenance.accounts.reset', `removed=${removed.length}; records=${JSON.stringify(counts)}`);
  return counts;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (process.argv.slice(2).some(arg => arg !== '--dry-run')) { usage(); process.exitCode = 2; return; }
  maint.checkServerStopped();
  const db = readDb();
  const owner = db.users.find(user => user.role === 'v_super_admin' && user.email === maint.OWNER_EMAIL && !user.deleted)
    || db.users.find(user => user.role === 'v_super_admin' && !user.deleted);
  if (!owner) throw new Error('An active Owner account is required; provision the Owner before resetting other accounts.');
  const removed = db.users.filter(user => user.id !== owner.id);
  const pics = [...new Set(removed.map(user => user.pic).filter(Boolean).map(pic => path.basename(String(pic))))];
  const summary = { accounts: removed.length, ownerAccountsRetained: 1, relatedRecords: {}, profileFiles: pics.length };
  const preview = JSON.parse(JSON.stringify(db));
  summary.relatedRecords = dataChanges(preview, preview.users.find(user => user.id === owner.id), removed);
  console.log(JSON.stringify(summary, null, 2));
  if (dryRun) return;

  if (process.env.ENABLE_DESTRUCTIVE_MAINTENANCE !== '1') throw new Error('Set ENABLE_DESTRUCTIVE_MAINTENANCE=1 for this explicit maintenance run.');
  const initialPassword = process.env.OWNER_INITIAL_PASSWORD || '';
  process.env.OWNER_INITIAL_PASSWORD = '';
  delete process.env.OWNER_INITIAL_PASSWORD;
  let newHash;
  try {
    if (Buffer.byteLength(initialPassword, 'utf8') < 14 || maintPasswordIssues(initialPassword).length) throw new Error('OWNER_INITIAL_PASSWORD must be at least 14 characters and satisfy the system password policy.');
    newHash = require('../src/security').hashOwnerInitialPassword(initialPassword);
  } finally {
    // Environment value is cleared even when validation or hashing fails.
    process.env.OWNER_INITIAL_PASSWORD = '';
    delete process.env.OWNER_INITIAL_PASSWORD;
  }
  if (!process.env.SYSTEM_BACKUP_PATH) throw new Error('Set SYSTEM_BACKUP_PATH to a new encrypted backup path outside the application.');
  const backupPath = maint.writeBackup(process.env.SYSTEM_BACKUP_PATH);
  await maint.askConfirmation(`RESET ACCOUNTS KEEP OWNER ${maint.OWNER_EMAIL}`);

  const live = readDb();
  const liveOwner = live.users.find(user => user.id === owner.id && user.role === 'v_super_admin');
  if (!liveOwner) throw new Error('Owner changed after preview; no reset was performed.');
  const liveRemoved = live.users.filter(user => user.id !== liveOwner.id);
  const stage = maint.DB_FILE + `.reset-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const quarantine = path.join(maint.UPLOADS_DIR, `.reset-quarantine-${process.pid}`);
  const privateQuarantine = maint.PRIVATE_AGREEMENTS_DIR + `.reset-quarantine-${process.pid}`;
  const moved = [];
  let dbReplaced = false, privateMoved = false;
  try {
    liveOwner.passHash = newHash;
    dataChanges(live, liveOwner, liveRemoved);
    if (live.users.length !== 1 || live.users[0].role !== 'v_super_admin' || live.users[0].email !== maint.OWNER_EMAIL || !live.users[0].passwordChangeRequired) {
      throw new Error('Post-reset owner invariant failed; no changes were committed.');
    }
    fs.writeFileSync(stage, maint.encryptedDatabaseBytes(live), { mode: 0o600, flag: 'wx' });
    fs.mkdirSync(quarantine, { mode: 0o700 });
    if (fs.existsSync(privateQuarantine)) throw new Error('A previous private-agreement quarantine exists; inspect it before retrying.');
    if (fs.existsSync(maint.PRIVATE_AGREEMENTS_DIR)) {
      fs.renameSync(maint.PRIVATE_AGREEMENTS_DIR, privateQuarantine);
      privateMoved = true;
    }
    for (const name of pics) {
      if (path.basename(name) !== name) continue;
      const from = path.join(maint.UPLOADS_DIR, name);
      if (fs.existsSync(from)) { const to = path.join(quarantine, name); fs.renameSync(from, to); moved.push([to, from]); }
    }
    fs.renameSync(maint.DB_FILE, maint.DB_FILE + '.reset-rollback');
    try { fs.renameSync(stage, maint.DB_FILE); dbReplaced = true; }
    catch (error) { fs.renameSync(maint.DB_FILE + '.reset-rollback', maint.DB_FILE); throw error; }
    fs.chmodSync(maint.DB_FILE, 0o600);
    fs.rmSync(maint.DB_FILE + '.reset-rollback', { force: true });
    const cleanupFailures = [];
    try { fs.rmSync(quarantine, { recursive: true, force: true }); } catch { cleanupFailures.push('profile image quarantine'); }
    try { fs.rmSync(privateQuarantine, { recursive: true, force: true }); } catch { cleanupFailures.push('private agreement quarantine'); }
    console.log(`Account reset completed. Encrypted backup: ${backupPath}`);
    if (cleanupFailures.length) {
      console.error(`Account reset committed, but cleanup failed for: ${cleanupFailures.join(', ')}. Inspect the hidden quarantine paths immediately.`);
      process.exitCode = 1;
    }
  } catch (error) {
    if (dbReplaced) {
      try { fs.rmSync(maint.DB_FILE, { force: true }); } catch {}
      try { fs.renameSync(maint.DB_FILE + '.reset-rollback', maint.DB_FILE); } catch {}
    }
    for (const [from, to] of moved.reverse()) { try { if (fs.existsSync(from)) fs.renameSync(from, to); } catch {} }
    if (privateMoved) { try { if (fs.existsSync(privateQuarantine)) fs.renameSync(privateQuarantine, maint.PRIVATE_AGREEMENTS_DIR); } catch {} }
    try { fs.rmSync(quarantine, { recursive: true, force: true }); } catch {}
    throw error;
  } finally { try { fs.rmSync(stage, { force: true }); } catch {} }
  newHash = null;
}

function maintPasswordIssues(password) {
  return require('../src/security').passwordIssues(password);
}

main().catch(error => { console.error('[account reset]', error.message); process.exitCode = 1; });
