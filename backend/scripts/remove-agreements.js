'use strict';

const crypto = require('crypto');
const fs = require('fs');
const maint = require('./maintenance-common');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (process.argv.slice(2).some(arg => arg !== '--dry-run')) {
    console.log('Usage: node scripts/remove-agreements.js [--dry-run]');
    process.exitCode = 2; return;
  }
  maint.checkServerStopped();
  const original = maint.readDatabase();
  if (!Array.isArray(original.agreements)) throw new Error('Agreement collection is missing; no changes made.');
  const systemAgreements = Array.isArray(original.systemAgreements) ? original.systemAgreements : [];
  const profiles = Array.isArray(original.memberProfiles) ? original.memberProfiles : [];
  const agreementFileCount = fs.existsSync(maint.PRIVATE_AGREEMENTS_DIR) ? fs.readdirSync(maint.PRIVATE_AGREEMENTS_DIR).length : 0;
  console.log(JSON.stringify({ legacyAgreementRecords: original.agreements.length, systemAgreementRecords: systemAgreements.length, profilesToClear: profiles.filter(profile => profile.agreementSigned || profile.agreementSignedAt).length, privateAgreementFiles: agreementFileCount }, null, 2));
  if (dryRun) return;

  if (process.env.ENABLE_DESTRUCTIVE_MAINTENANCE !== '1') throw new Error('Set ENABLE_DESTRUCTIVE_MAINTENANCE=1 for this explicit maintenance run.');
  if (!process.env.SYSTEM_BACKUP_PATH) throw new Error('Set SYSTEM_BACKUP_PATH to a new encrypted backup path outside the application.');
  const backupPath = maint.writeBackup(process.env.SYSTEM_BACKUP_PATH);
  await maint.askConfirmation('REMOVE ALL EXISTING AGREEMENTS');

  const current = maint.readDatabase();
  const removedCount = current.agreements.length;
  current.agreements = [];
  const removedSystemCount = Array.isArray(current.systemAgreements) ? current.systemAgreements.length : 0;
  if (Array.isArray(current.systemAgreements)) current.systemAgreements = [];
  for (const profile of current.memberProfiles || []) {
    profile.agreementSigned = false;
    profile.agreementSignedAt = null;
  }
  maint.appendAudit(current, 'maintenance.agreements.removed', `legacy=${removedCount}; system=${removedSystemCount}; privateFiles=${agreementFileCount}`);

  const temporary = maint.DB_FILE + `.agreements-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const previous = maint.DB_FILE + '.agreements-rollback';
  const privateQuarantine = maint.PRIVATE_AGREEMENTS_DIR + `.agreements-quarantine-${process.pid}`;
  let replaced = false, privateMoved = false;
  try {
    fs.writeFileSync(temporary, maint.encryptedDatabaseBytes(current), { mode: 0o600, flag: 'wx' });
    if (fs.existsSync(privateQuarantine)) throw new Error('A previous agreement quarantine exists; inspect it before retrying.');
    if (fs.existsSync(maint.PRIVATE_AGREEMENTS_DIR)) {
      fs.renameSync(maint.PRIVATE_AGREEMENTS_DIR, privateQuarantine);
      privateMoved = true;
    }
    fs.renameSync(maint.DB_FILE, previous);
    try { fs.renameSync(temporary, maint.DB_FILE); replaced = true; }
    catch (error) { fs.renameSync(previous, maint.DB_FILE); throw error; }
    fs.chmodSync(maint.DB_FILE, 0o600);
    fs.rmSync(previous, { force: true });
    let cleanupFailed = false;
    try { fs.rmSync(privateQuarantine, { recursive: true, force: true }); } catch { cleanupFailed = true; }
    console.log(`Agreement records removed. Encrypted backup: ${backupPath}`);
    if (cleanupFailed) {
      console.error('Agreement removal committed, but the private PDF quarantine could not be deleted. Inspect the hidden quarantine path immediately.');
      process.exitCode = 1;
    }
  } catch (error) {
    if (replaced) {
      try { fs.rmSync(maint.DB_FILE, { force: true }); } catch {}
      try { fs.renameSync(previous, maint.DB_FILE); } catch {}
    }
    if (privateMoved) { try { if (fs.existsSync(privateQuarantine)) fs.renameSync(privateQuarantine, maint.PRIVATE_AGREEMENTS_DIR); } catch {} }
    throw error;
  } finally { try { fs.rmSync(temporary, { force: true }); } catch {} }
}

main().catch(error => { console.error('[agreement removal]', error.message); process.exitCode = 1; });
