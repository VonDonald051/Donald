'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'database', 'data', 'private-agreements');
const MAGIC = Buffer.from('VDA1');

function storageKey() {
  const value = String(process.env.AGREEMENT_STORAGE_KEY || '');
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error('Agreement private storage is not configured.');
  return Buffer.from(value, 'hex');
}

function assertConfigured() { storageKey(); }

function safeId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}\.original\.vda$/.test(value) && !/^[a-f0-9-]{36}\.signed\.vda$/.test(value)) {
    throw new Error('Invalid private agreement storage identifier.');
  }
  return path.join(ROOT, value);
}

function write(buffer, kind) {
  const key = storageKey();
  if (!Buffer.isBuffer(buffer) || !['original', 'signed'].includes(kind)) throw new Error('Invalid private agreement file.');
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  fs.chmodSync(ROOT, 0o700);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const envelope = Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
  const id = `${crypto.randomUUID()}.${kind}.vda`;
  const target = safeId(id);
  const fd = fs.openSync(target, 'wx', 0o600);
  try { fs.writeFileSync(fd, envelope); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return id;
}

function read(id) {
  const key = storageKey();
  const envelope = fs.readFileSync(safeId(id));
  if (envelope.length < 32 || !envelope.subarray(0, 4).equals(MAGIC)) throw new Error('Private agreement file is invalid.');
  const iv = envelope.subarray(4, 16), tag = envelope.subarray(16, 32), ciphertext = envelope.subarray(32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

module.exports = { assertConfigured, write, read };
