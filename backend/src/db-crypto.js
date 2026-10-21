'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAGIC = Buffer.from('VDB1');

const LOCAL_ENV_KEYS = [
  'DB_ENCRYPTION_KEY', 'SYSTEM_AGREEMENTS_V2', 'AGREEMENT_CODE_HMAC_KEY',
  'AGREEMENT_PENDING_TTL_DAYS', 'AGREEMENT_PDF_SEAL_KEY',
  'AGREEMENT_STORAGE_KEY', 'AGREEMENT_VERIFY_BASE_URL',
  'AGREEMENT_CLAMSCAN_BIN', 'AGREEMENT_QRSCAN_BIN', 'PDFINFO_BIN',
  'PDFTOPPM_BIN', 'PDFSIG_BIN', 'LOGIN_PHONE_OTP_ENABLED',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI',
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_VERIFY_SERVICE_SID'
];
let localEnvironmentLoaded = false;

function loadLocalEnvironment() {
  if (localEnvironmentLoaded) return;
  // The private local .env file lives at the project root, alongside package.json.
  const envFile = path.join(__dirname, '..', '..', '.env');
  let stat;
  try {
    stat = fs.lstatSync(envFile);
  } catch (error) {
    if (error.code === 'ENOENT') { localEnvironmentLoaded = true; return; }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Local .env must be a regular file.');
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error('Local .env permissions are too broad; restrict it with chmod 600 .env.');
  }

  const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
  for (const key of LOCAL_ENV_KEYS) {
    if (process.env.NODE_ENV === 'test' && key !== 'DB_ENCRYPTION_KEY') continue;
    if (process.env[key] !== undefined) continue;
    const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
    const assignments = lines.filter(line => pattern.test(line));
    if (assignments.length > 1) throw new Error(`Local .env contains multiple ${key} entries.`);
    if (!assignments.length) continue;
    const assignment = assignments[0].replace(new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*`), '').trim();
    const quoted = assignment.match(/^(['"])(.*?)\1(?:\s+#.*)?$/);
    process.env[key] = quoted ? quoted[2] : assignment.replace(/\s+#.*$/, '').trim();
  }
  localEnvironmentLoaded = true;
}

function encryptionKey(value) {
  loadLocalEnvironment();
  if (value === undefined) value = process.env.DB_ENCRYPTION_KEY;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('DB_ENCRYPTION_KEY is not set. Provide it through the environment or a private local .env file.');
  }
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error('DB_ENCRYPTION_KEY must be 64 hexadecimal characters from the secret manager.');
  }
  return Buffer.from(value, 'hex');
}

function isEncrypted(bytes) { return Buffer.isBuffer(bytes) && bytes.length >= 32 && bytes.subarray(0, 4).equals(MAGIC); }

function encryptDatabase(plaintext, value) {
  const key = encryptionKey(value);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

function decryptDatabase(envelope, value) {
  if (!isEncrypted(envelope)) throw new Error('Database is not encrypted (VDB1 envelope required). Run the offline database-encryption migration.');
  const key = encryptionKey(value);
  const iv = envelope.subarray(4, 16);
  const tag = envelope.subarray(16, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(envelope.subarray(32)), decipher.final()]);
}

function isPlaintextJson(bytes) {
  try { const value = JSON.parse(bytes.toString('utf8')); return !!value && Array.isArray(value.users); }
  catch { return false; }
}

module.exports = { MAGIC, encryptionKey, isEncrypted, isPlaintextJson, encryptDatabase, decryptDatabase };
