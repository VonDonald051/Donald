'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vondonald-phase9-'));
process.env.NODE_ENV = 'test';
process.env.VONDONALD_TEST_DATA_DIR = path.join(testDir, 'data');
process.env.DB_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.AGREEMENT_CODE_HMAC_KEY = crypto.randomBytes(48).toString('hex');
process.env.SYSTEM_BACKUP_KEY = crypto.randomBytes(48).toString('base64');
process.env.PDFSIG_BIN = path.join(testDir, 'pdfsig-stub');
fs.writeFileSync(process.env.PDFSIG_BIN, '#!/usr/bin/env node\nprocess.stdout.write("");\n', { mode: 0o700 });

const dbm = require('../src/db');
const dbCrypto = require('../src/db-crypto');
dbm.reset();
const codes = require('../src/agreement-codes');
const upload = require('../src/agreement-upload');
const chat = require('../src/chat-policy');
const Router = require('../src/httpmini').Router;
const maintenance = require('../scripts/maintenance-common');

test('database encryption key must be present and contain 32 bytes of hex', () => {
  assert.throws(() => dbCrypto.encryptionKey(''), /DB_ENCRYPTION_KEY is not set/);
  assert.throws(() => dbCrypto.encryptionKey('not-a-key'), /64 hexadecimal characters/);
  assert.equal(dbCrypto.encryptionKey('a'.repeat(64)).length, 32);
});

test('member registration-fee route records its timestamp', () => {
  const snapshot = JSON.parse(JSON.stringify(dbm.db));
  try {
    dbm.reset();
    const member = { ...user(21, 'member', 10), deleted: false };
    dbm.db.users.push(member);
    dbm.db.memberProfiles.push({ userId: member.id, groupId: 10, registrationFeePaid: false });
    const route = require('../src/routes/me').stack.find(entry =>
      entry.method === 'POST' && entry.path === '/member-profile/registration-fee');
    let statusCode = 200;
    let response;
    route.handlers[0]({
      user: member, body: {}, headers: {}, socket: { remoteAddress: '127.0.0.1' }
    }, {
      status(code) { statusCode = code; return this; },
      json(value) { response = value; return this; }
    });
    assert.equal(statusCode, 200);
    assert.equal(response.pendingVerification, true);
    assert.ok(Number.isFinite(Date.parse(response.registrationFee.reportedAt)));
  } finally {
    Object.assign(dbm.db, snapshot);
    dbm.save();
  }
});

test('security alert reports email configuration without throwing', async () => {
  const previousUsers = dbm.db.users;
  dbm.db.users = [];
  try {
    const result = await require('../src/emailer').securityAlert('Test alert', 'Test detail');
    assert.equal(result.recipients, 0);
    assert.equal(result.smtpConfigured, false);
  } finally {
    dbm.db.users = previousUsers;
  }
});

const groups = [
  { id: 10, suspended: false, isStaffChama: false },
  { id: 11, suspended: false, isStaffChama: false },
  { id: 12, suspended: true, isStaffChama: false }
];
const user = (id, role, groupId, extras = {}) => ({ id, role, groupId, firstName: `User${id}`, lastName: 'Test', ...extras });

test.after(() => fs.rmSync(testDir, { recursive: true, force: true }));

test('agreement codes are unique, authenticated, and tamper evident', () => {
  dbm.db.systemAgreements = [];
  dbm.db.counters.systemAgreement = 0;
  const first = codes.createPending(user(1, 'member', 10), 10, new Date('2026-01-01T00:00:00Z'));
  const second = codes.createPending(user(2, 'member', 10), 10, new Date('2026-01-01T00:00:00Z'));
  assert.notEqual(first.agreementCode, second.agreementCode);
  assert.equal(codes.verifyCode(first.agreementCode), true);
  assert.equal(codes.verifyCode(first.agreementCode.replace(/.$/, first.agreementCode.endsWith('0') ? '1' : '0')), false);
  const token = codes.verificationToken(first.agreementCode);
  assert.equal(codes.verifyToken(first.agreementCode, token), true);
  assert.equal(codes.verifyToken(second.agreementCode, token), false);
});

test('certificate-signature helper rejects forged or unsigned PDFs', () => {
  const original = Buffer.from('%PDF-1.7\nControlled system agreement\n%%EOF');
  const agreement = { agreementCode: 'AGR-2026-test', fileHash: upload.hash(original) };
  const edited = Buffer.from('%PDF-1.7\nReplaced agreement\n%%EOF\n');
  assert.throws(() => upload.validateSignature(edited, original), error => error.publicCode === 'document_changed');
  const unsigned = Buffer.concat([original, Buffer.from('\n% unsigned upload\n%%EOF')]);
  assert.throws(() => upload.validateSignature(unsigned, original), error => error.publicCode === 'signature_missing_or_invalid');
  const tooLarge = Buffer.concat([original, Buffer.alloc(upload.MAX_PDF_BYTES)]);
  assert.throws(() => upload.validateSignature(tooLarge, original), error => error.publicCode === 'size_limit');
  assert.equal(agreement.fileHash, upload.hash(original));
});

test('chat policy permits only intended same-group and admin combinations', () => {
  const memberA = user(1, 'member', 10), memberB = user(2, 'member', 10);
  const gaA = user(3, 'group_admin', 10), gaB = user(4, 'group_admin', 11);
  const admin = user(5, 'admin', null), owner = user(6, 'v_super_admin', null);
  assert.equal(chat.pairOK(memberA, gaA, groups), true);
  assert.equal(chat.pairOK(memberA, memberB, groups), false);
  assert.equal(chat.pairOK(memberA, gaB, groups), false);
  assert.equal(chat.pairOK(gaA, admin, groups), true);
  assert.equal(chat.pairOK(admin, user(7, 'admin', null), groups), true);
  assert.equal(chat.pairOK(owner, admin, groups), false);
  assert.equal(chat.pairOK(memberA, user(8, 'group_admin', 12), groups), false);
  assert.equal(chat.pairOK(memberA, { ...gaA, disabled: true }, groups), false);
});

test('notification visibility is recipient, role, and group scoped', () => {
  const member = user(1, 'member', 10), ga = user(2, 'group_admin', 10), otherGa = user(3, 'group_admin', 11);
  const owner = user(4, 'v_super_admin', null);
  const own = { type: 'notice', recipientId: 1, recipientRole: 'member', groupId: 10 };
  const groupNotice = { type: 'notice', recipientRole: 'group_admin', groupId: 10 };
  const adminOnly = { type: 'admin', recipientRole: 'admin', groupId: null };
  assert.equal(dbm.notificationVisibleTo(own, member), true);
  assert.equal(dbm.notificationVisibleTo(own, user(9, 'member', 10)), false);
  assert.equal(dbm.notificationVisibleTo(groupNotice, ga), true);
  assert.equal(dbm.notificationVisibleTo(groupNotice, otherGa), false);
  assert.equal(dbm.notificationVisibleTo(adminOnly, owner), false);
});

test('router stores all middleware in order', () => {
  const first = () => {}, second = () => {};
  const router = new Router().use(first, second);
  assert.deepEqual(router.stack.map(entry => entry.mw), [first, second]);
});

test('API request guard rejects cross-origin state changes', () => {
  const security = require('../src/security');
  const invoke = (middleware, req) => {
    let response;
    let statusCode = 200;
    let continued = false;
    middleware(req, {
      status(code) { statusCode = code; return this; },
      json(body) { response = body; return this; }
    }, () => { continued = true; });
    return { response, statusCode, continued };
  };

  const originMismatch = invoke(security.originGuard, {
    method: 'POST', protocol: 'https', headers: { origin: 'https://evil.example', host: 'app.example' }
  });
  assert.equal(originMismatch.statusCode, 403);
  assert.equal(originMismatch.response.code, 'ORIGIN_MISMATCH');
  assert.equal(invoke(security.originGuard, {
    method: 'POST', protocol: 'https', headers: { origin: 'https://app.example', host: 'app.example' }
  }).continued, true);
  const missingOrigin = invoke(security.originGuard, {
    method: 'POST', protocol: 'https', headers: { host: 'app.example' }
  });
  assert.equal(missingOrigin.statusCode, 403);
  assert.equal(missingOrigin.response.code, 'ORIGIN_REQUIRED');
});

test('public health endpoint does not disclose account counts or Owner status', () => {
  const health = require('../src/routes/vsa').rHealth.stack.find(entry => entry.path === '/health');
  let response;
  health.handlers[0]({}, { json(body) { response = body; } });
  assert.deepEqual(response, { ok: true });
});

test('Admin API exposes only read-only agreements and audit routes', () => {
  const adminRouter = require('../src/routes/admin');
  const paths = adminRouter.stack.filter(entry => entry.method).map(entry => `${entry.method} ${entry.path}`);
  assert.deepEqual(paths.sort(), ['GET /audit', 'GET /system-agreements']);
});

test('safe user projection excludes credentials and internal profile fields', () => {
  const projected = dbm.safeUser({ ...user(1, 'member', 10), passHash: 'private', mfaSecret: 'private', agreementSigned: true });
  assert.equal(projected.passHash, undefined);
  assert.equal(projected.mfaSecret, undefined);
  assert.equal(projected.agreementSigned, undefined);
});

test('encrypted backup self-check detects tampering and validates private agreement files', () => {
  assert.doesNotThrow(() => maintenance.selfCheck());
  const file = Buffer.from('encrypted agreement fixture');
  const name = `${crypto.randomUUID()}.signed.vda`;
  const database = Buffer.from(JSON.stringify({ users: [] }));
  const payload = {
    format: 1, database: database.toString('base64'), databaseSha256: maintenance.sha256(database),
    files: {}, privateAgreements: { [name]: { data: file.toString('base64'), sha256: maintenance.sha256(file) } }, auxiliary: {}
  };
  assert.doesNotThrow(() => maintenance.validatePayload(payload));
  assert.throws(() => maintenance.validatePayload({ ...payload, privateAgreements: { '../outside.vda': payload.privateAgreements[name] } }));
  assert.throws(() => maintenance.outsideApp(path.join(maintenance.ROOT, 'inside-backup')));
  const link = path.join(testDir, 'app-link');
  fs.symlinkSync(maintenance.ROOT, link, 'dir');
  assert.throws(() => maintenance.outsideApp(path.join(link, 'backup.vdb')));
});

test('MFA enrollment routes and security-page resources are removed', () => {
  const authRouter = require('../src/routes/auth');
  const paths = authRouter.stack.filter(entry => entry.method).map(entry => `${entry.method} ${entry.path}`);
  assert.equal(paths.some(route => route.includes('/mfa/')), false);
  assert.equal(fs.existsSync(path.join(__dirname, '..', '..', 'frontend', 'public', 'mfa.html')), false);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'src', 'mfa.js')), false);
});

test('privileged users can access the system before changing a temporary password', () => {
  const security = require('../src/security');
  const admin = { ...user(90, 'admin', null), deleted: false, disabled: false, passwordChangeRequired: true };
  dbm.db.users = [admin];
  dbm.db.sessions = [{ token: 'a'.repeat(64), userId: admin.id, expires: Date.now() + 60000, mfaVerified: false }];
  const req = { headers: { cookie: `sid=${'a'.repeat(64)}` }, originalUrl: '/api/admin/system-agreements' };
  let status = 200, body = null, proceeded = false;
  const res = { status(code) { status = code; return this; }, json(data) { body = data; return this; } };
  security.auth(req, res, () => { proceeded = true; });
  assert.equal(proceeded, true);
  assert.equal(status, 200);
  assert.equal(body, null);

  const pageRes = { redirect(target) { body = target; }, status(code) { status = code; return this; }, send(value) { body = value; } };
  security.pageAuth(['admin'])(req, pageRes, () => { proceeded = true; });
  assert.equal(body, null);
  assert.equal(status, 200);
});

test('database loading removes legacy MFA fields from encrypted records', () => {
  Object.assign(dbm.db.users[0], {
    mfaRequired: true, mfaSecretEnc: 'legacy-seed', mfaEnabled: true,
    mfaType: 'sms', mfaPhone: '+254769093524', mfaLastStep: 123
  });
  Object.assign(dbm.db.sessions[0], {
    mfaVerified: false, mfaPending: true, mfaRemember: true,
    mfaSetupSecretEnc: 'legacy-setup', mfaSmsEnrollment: true, mfaSmsSetupPhone: '+254769093524'
  });
  dbm.save();
  dbm.load();
  for (const field of ['mfaRequired', 'mfaSecretEnc', 'mfaEnabled', 'mfaType', 'mfaPhone', 'mfaLastStep']) {
    assert.equal(Object.hasOwn(dbm.db.users[0], field), false);
  }
  for (const field of ['mfaVerified', 'mfaPending', 'mfaRemember', 'mfaSetupSecretEnc', 'mfaSmsEnrollment', 'mfaSmsSetupPhone']) {
    assert.equal(Object.hasOwn(dbm.db.sessions[0], field), false);
  }
});

test('database files use authenticated encryption at rest', () => {
  const bytes = fs.readFileSync(path.join(process.env.VONDONALD_TEST_DATA_DIR, 'db.json'));
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'VDB1');
  const decrypted = JSON.parse(require('../src/db-crypto').decryptDatabase(bytes).toString('utf8'));
  assert.ok(Array.isArray(decrypted.users));
});
