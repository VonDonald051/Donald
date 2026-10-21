'use strict';

// Shared, dependency-free maintenance helpers for the JSON-backed store.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dbCrypto = require('../src/db-crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const DATABASE_DIR = path.resolve(process.env.VONDONALD_DATA_DIR || path.join(ROOT, 'database', 'data'));
const DB_FILE = path.join(DATABASE_DIR, 'db.json');
const UPLOADS_DIR = path.join(ROOT, 'database', 'uploads');
const PRIVATE_AGREEMENTS_DIR = path.join(DATABASE_DIR, 'private-agreements');
const MAGIC = Buffer.from('VDONBK01');
const OWNER_EMAIL = 'jdonald@gmail.com';

function secret() {
  const value = process.env.SYSTEM_BACKUP_KEY || '';
  if (Buffer.byteLength(value, 'utf8') < 32) throw new Error('SYSTEM_BACKUP_KEY must contain at least 32 bytes.');
  return value;
}

function outsideApp(file) {
  const resolved = path.resolve(file);
  const appReal = fs.realpathSync(ROOT);
  let ancestor = resolved;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('Cannot resolve backup destination path.');
    ancestor = parent;
  }
  const physicalAncestor = fs.realpathSync(ancestor);
  const physicalTarget = fs.existsSync(resolved)
    ? fs.realpathSync(resolved)
    : path.resolve(physicalAncestor, path.relative(ancestor, resolved));
  if (physicalTarget === appReal || physicalTarget.startsWith(appReal + path.sep)) {
    throw new Error('Backup files must be stored outside the application directory.');
  }
  return resolved;
}

function collectPayload() {
  const dbStat = fs.lstatSync(DB_FILE);
  if (!dbStat.isFile() || dbStat.isSymbolicLink()) throw new Error('Database path must be a regular file; backup stopped.');
  const database = Buffer.from(JSON.stringify(readDatabase()));
  const files = {};
  const auxiliary = {};
  for (const entry of fs.readdirSync(path.dirname(DB_FILE), { withFileTypes: true })) {
    if (!entry.isFile() || ['db.json', 'server.pid'].includes(entry.name) || entry.name.includes('.tmp-')) continue;
    const bytes = fs.readFileSync(path.join(path.dirname(DB_FILE), entry.name));
    auxiliary[entry.name] = { data: bytes.toString('base64'), sha256: sha256(bytes) };
  }
  if (fs.existsSync(UPLOADS_DIR)) {
    const uploadStat = fs.lstatSync(UPLOADS_DIR);
    if (!uploadStat.isDirectory() || uploadStat.isSymbolicLink()) throw new Error('Uploads path must be a real directory; backup stopped.');
    for (const entry of fs.readdirSync(UPLOADS_DIR, { withFileTypes: true })) {
      if (!entry.isFile()) throw new Error('Uploads must contain regular files only; backup stopped.');
      const bytes = fs.readFileSync(path.join(UPLOADS_DIR, entry.name));
      files[entry.name] = { data: bytes.toString('base64'), sha256: sha256(bytes) };
    }
  }
  const privateAgreements = {};
  if (fs.existsSync(PRIVATE_AGREEMENTS_DIR)) {
    const privateStat = fs.lstatSync(PRIVATE_AGREEMENTS_DIR);
    if (!privateStat.isDirectory() || privateStat.isSymbolicLink()) throw new Error('Private agreement path must be a real directory; backup stopped.');
    for (const entry of fs.readdirSync(PRIVATE_AGREEMENTS_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-f0-9-]{36}\.(?:original|signed)\.vda$/i.test(entry.name)) throw new Error('Private agreement storage contains an unexpected entry; backup stopped.');
      const bytes = fs.readFileSync(path.join(PRIVATE_AGREEMENTS_DIR, entry.name));
      privateAgreements[entry.name] = { data: bytes.toString('base64'), sha256: sha256(bytes) };
    }
  }
  return { format: 1, createdAt: new Date().toISOString(), database: database.toString('base64'), databaseSha256: sha256(database), files, privateAgreements, auxiliary };
}

function sha256(data) { return crypto.createHash('sha256').update(data).digest('hex'); }

function readDatabase() {
  const bytes = fs.readFileSync(DB_FILE);
  let plaintext;
  if (dbCrypto.isEncrypted(bytes)) plaintext = dbCrypto.decryptDatabase(bytes);
  else if (dbCrypto.isPlaintextJson(bytes)) plaintext = bytes;
  else throw new Error('Database format is invalid; refusing maintenance operation.');
  const db = JSON.parse(plaintext.toString('utf8'));
  if (!db || !Array.isArray(db.users)) throw new Error('Database structure is invalid; refusing maintenance operation.');
  return db;
}

function encryptedDatabaseBytes(db) {
  dbCrypto.encryptionKey();
  return dbCrypto.encryptDatabase(Buffer.from(JSON.stringify(db)));
}

function encrypt(payload) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(secret(), salt, 32, { N: 32768, maxmem: 64 * 1024 * 1024 });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), ciphertext]);
}

function decrypt(backupBytes) {
  const minimum = MAGIC.length + 16 + 12 + 16 + 1;
  if (backupBytes.length < minimum || !backupBytes.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Unrecognized or truncated backup file.');
  const start = MAGIC.length;
  const salt = backupBytes.subarray(start, start + 16);
  const iv = backupBytes.subarray(start + 16, start + 28);
  const tag = backupBytes.subarray(start + 28, start + 44);
  const ciphertext = backupBytes.subarray(start + 44);
  const key = crypto.scryptSync(secret(), salt, 32, { N: 32768, maxmem: 64 * 1024 * 1024 });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const payload = JSON.parse(plaintext.toString('utf8'));
  validatePayload(payload);
  return payload;
}

function validatePayload(payload) {
  if (!payload || payload.format !== 1 || typeof payload.database !== 'string' || !payload.files || typeof payload.files !== 'object' || !payload.auxiliary || typeof payload.auxiliary !== 'object') throw new Error('Backup payload is invalid.');
  const database = Buffer.from(payload.database, 'base64');
  if (sha256(database) !== payload.databaseSha256) throw new Error('Database checksum mismatch.');
  const parsed = JSON.parse(database.toString('utf8'));
  if (!parsed || !Array.isArray(parsed.users)) throw new Error('Backup database is invalid.');
  for (const [name, record] of Object.entries(payload.files)) {
    if (path.basename(name) !== name || !record || typeof record.data !== 'string' || sha256(Buffer.from(record.data, 'base64')) !== record.sha256) throw new Error('Backup file checksum or path validation failed.');
  }
  for (const [name, record] of Object.entries(payload.privateAgreements || {})) {
    if (!/^[a-f0-9-]{36}\.(?:original|signed)\.vda$/i.test(name) || !record || typeof record.data !== 'string' || sha256(Buffer.from(record.data, 'base64')) !== record.sha256) throw new Error('Backup private agreement checksum or path validation failed.');
  }
  for (const [name, record] of Object.entries(payload.auxiliary)) {
    if (path.basename(name) !== name || ['db.json', 'server.pid'].includes(name) || !record || typeof record.data !== 'string' || sha256(Buffer.from(record.data, 'base64')) !== record.sha256) throw new Error('Backup data-file checksum or path validation failed.');
  }
}

function writeBackup(file) {
  const target = outsideApp(file);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (fs.existsSync(target)) throw new Error('Backup destination already exists; choose a new unique path.');
  const temporary = target + '.tmp-' + crypto.randomBytes(6).toString('hex');
  try {
    fs.writeFileSync(temporary, encrypt(collectPayload()), { mode: 0o600, flag: 'wx' });
    fs.linkSync(temporary, target);
    fs.unlinkSync(temporary);
    fs.chmodSync(target, 0o600);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
  return target;
}

function readBackup(file) {
  return decrypt(fs.readFileSync(outsideApp(file)));
}

function atomicWrite(file, bytes) {
  const temp = file + '.tmp-' + crypto.randomBytes(6).toString('hex');
  fs.writeFileSync(temp, bytes, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
}

function appendAudit(db, action, target) {
  if (!Array.isArray(db.audit)) db.audit = [];
  if (!db.counters) db.counters = {};
  db.counters.audit = (db.counters.audit || 0) + 1;
  const prev = db.audit.length ? db.audit[db.audit.length - 1] : null;
  const entry = {
    id: db.counters.audit, actor: null, actorRole: 'maintenance', action,
    target, ip: '', at: new Date().toISOString(), prevHash: prev ? sha256(Buffer.from(JSON.stringify(prev))) : null, hash: null
  };
  entry.hash = sha256(Buffer.from(JSON.stringify(entry)));
  db.audit.push(entry);
}

function askConfirmation(expected) {
  if (!process.stdin.isTTY) throw new Error('Destructive maintenance requires an interactive terminal.');
  return new Promise((resolve, reject) => {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(`Type exactly: ${expected}\n> `, answer => {
      rl.close();
      if (answer !== expected) reject(new Error('Confirmation did not match; no changes were made.'));
      else resolve();
    });
  });
}

function checkServerStopped() {
  const marker = path.join(DATABASE_DIR, 'server.pid');
  if (!fs.existsSync(marker)) return;
  const pid = Number(fs.readFileSync(marker, 'utf8').trim());
  if (Number.isInteger(pid) && pid > 1) {
    try { process.kill(pid, 0); throw new Error('Stop the application server before maintenance.'); }
    catch (error) { if (error.message.includes('Stop the application server')) throw error; if (error.code !== 'ESRCH') throw new Error('Cannot verify whether the application server is stopped.'); }
  }
  fs.unlinkSync(marker);
}

function selfCheck() {
  const payload = { format: 1, database: Buffer.from(JSON.stringify({ users: [] })).toString('base64'), databaseSha256: '', files: {}, auxiliary: {} };
  const dbBytes = Buffer.from(payload.database, 'base64');
  payload.databaseSha256 = sha256(dbBytes);
  const encoded = encrypt(payload);
  const decoded = decrypt(encoded);
  if (decoded.databaseSha256 !== payload.databaseSha256) throw new Error('Encryption/decryption self-check failed.');
  const damaged = Buffer.from(encoded); damaged[damaged.length - 1] ^= 1;
  let rejected = false;
  try { decrypt(damaged); } catch { rejected = true; }
  if (!rejected) throw new Error('Tampered-backup self-check failed.');
}

module.exports = {
  ROOT, DB_FILE, UPLOADS_DIR, PRIVATE_AGREEMENTS_DIR, OWNER_EMAIL, secret, outsideApp, collectPayload,
  readDatabase, encryptedDatabaseBytes,
  writeBackup, readBackup, atomicWrite, appendAudit, askConfirmation,
  checkServerStopped, selfCheck, validatePayload, sha256
};
