'use strict';

const crypto = require('crypto');
const dbm = require('./db');

const CODE_PATTERN = /^AGR-(\d{4})-([a-f0-9]{32})-([a-f0-9]{64})$/;

function signingKey() {
  const value = process.env.AGREEMENT_CODE_HMAC_KEY || '';
  if (Buffer.byteLength(value, 'utf8') < 32) throw new Error('Agreement code signing is not configured.');
  return value;
}

function assertConfigured() {
  signingKey();
  pendingTtlDays();
  if (!Array.isArray(dbm.db && dbm.db.systemAgreements)) throw new Error('System agreement migration has not been applied.');
}

function checksum(year, randomPart) {
  return crypto.createHmac('sha256', signingKey()).update(`AGR-${year}-${randomPart}`).digest('hex');
}

function generateCode(now = new Date()) {
  const year = String(now.getUTCFullYear());
  const randomPart = crypto.randomBytes(16).toString('hex');
  return `AGR-${year}-${randomPart}-${checksum(year, randomPart)}`;
}

function verifyCode(code) {
  if (typeof code !== 'string') return false;
  const match = CODE_PATTERN.exec(code);
  if (!match) return false;
  let expected;
  try { expected = Buffer.from(checksum(match[1], match[2]), 'hex'); } catch { return false; }
  const actual = Buffer.from(match[3], 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function verificationToken(code) {
  return crypto.createHmac('sha256', signingKey()).update(`agreement-verification:${code}`).digest('base64url').slice(0, 22);
}

function verifyToken(code, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(token)) return false;
  let expected;
  try { expected = Buffer.from(verificationToken(code)); } catch { return false; }
  const actual = Buffer.from(token);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function nextAgreementId() {
  const db = dbm.db;
  if (!db || !Array.isArray(db.systemAgreements)) throw new Error('System agreement migration has not been applied.');
  db.counters.systemAgreement = (db.counters.systemAgreement || 0) + 1;
  return db.counters.systemAgreement;
}

function pendingTtlDays() {
  const raw = process.env.AGREEMENT_PENDING_TTL_DAYS || '30';
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('AGREEMENT_PENDING_TTL_DAYS must be an integer from 1 to 90.');
  return days;
}

function createPending(member, groupId, now = new Date()) {
  const db = dbm.db;
  if (!db || !Array.isArray(db.systemAgreements)) throw new Error('System agreement migration has not been applied.');
  const expires = new Date(now.getTime() + pendingTtlDays() * 86400000);
  let code = '';
  for (let attempts = 0; attempts < 5; attempts++) {
    code = generateCode(now);
    if (!db.systemAgreements.some(agreement => agreement.agreementCode === code)) break;
    code = '';
  }
  if (!code) throw new Error('Agreement code collision; retry the request.');
  return {
    id: nextAgreementId(), agreementCode: code,
    memberId: member.id, groupId,
    status: 'PENDING', fileHash: null, signedFileHash: null,
    createdAt: now.toISOString(), expiresAt: expires.toISOString(), signedAt: null,
    version: 1, parentAgreementId: null
  };
}

function maybeCreateForMember(member, groupId) {
  return process.env.SYSTEM_AGREEMENTS_V2 === '1' ? createPending(member, groupId) : null;
}

module.exports = { CODE_PATTERN, generateCode, verifyCode, verificationToken, verifyToken, createPending, maybeCreateForMember, pendingTtlDays, assertConfigured };
