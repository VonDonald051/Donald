'use strict';
/* Authenticated self-service: profile, picture upload, change password, notifications, E2E public key.
 * Stage 4 Finance: registration fee, savings, member profile actions.
 * Patch 3: My Loans, My Fines, My Statement. */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dbm = require('../db');
const sec = require('../security');
const hub = require('../hub');
const emailer = require('../emailer');
const agreementCodes = require('../agreement-codes');
const agreementPdf = require('../agreement-pdf');
const agreementStorage = require('../agreement-storage');
const agreementUpload = require('../agreement-upload');
const financeTrends = require('../finance-trends');
const { currentWeekKey } = require('../week-key');
const { Router } = require('../httpmini');

const r = new Router();
r.use(sec.auth);
const now = () => new Date().toISOString();
r.use((req, res, next) => {
  if (/^\/member-profile\/agreement(?:\.pdf|\/upload)?(?:\?|$)/.test(req.url)) {
    return res.status(410).json({ error: 'The legacy agreement flow is retired. Use the current system agreement endpoints.' });
  }
  next();
});

const UP = path.join(__dirname, '..', '..', '..', 'database', 'uploads');
const PAGE = 10;

function requireSystemAgreements(req, res) {
  if (process.env.SYSTEM_AGREEMENTS_V2 !== '1') {
    res.status(404).json({ error: 'Not found' });
    return false;
  }
  if (!Array.isArray(dbm.db.systemAgreements)) {
    res.status(503).json({ error: 'System agreements are not available yet.' });
    return false;
  }
  if (req.user.role !== 'member') {
    res.status(403).json({ error: 'Member account required.' });
    return false;
  }
  return true;
}

function hasSignedAgreement(userId) {
  if (process.env.SYSTEM_AGREEMENTS_V2 === '1' && Array.isArray(dbm.db.systemAgreements)) {
    const latest = dbm.db.systemAgreements.filter(row => row.memberId === userId).sort((a, b) => b.id - a.id)[0];
    return !!latest && latest.status === 'SIGNED';
  }
  const profile = dbm.memberProfileFor(userId);
  return !!(profile && profile.agreementSigned);
}

function staffMemberAccount(req) { return sec.isStaffRole(req.user); }
function notifyOwnerOfStaffRequest(req, type, title, message) {
  const owner = dbm.db.users.find(user => user.role === 'v_super_admin' && !user.deleted && !user.disabled);
  if (!owner) return;
  emailer.notifyUser(owner.id, type, title, message);
  emailer.emailVSA(title, `${req.user.firstName} ${req.user.lastName} (${req.user.role}): ${message}`);
}

// Feature-flagged V2 issuance. No client-provided agreement contents, IDs, or codes are accepted.
r.post('/system-agreements', (req, res) => {
  if (!requireSystemAgreements(req, res)) return;
  const member = req.user;
  const profile = dbm.memberProfileFor(member.id);
  const group = profile && profile.groupId && dbm.db.groups.find(entry => entry.id === profile.groupId);
  if (!profile || !group || member.groupId !== profile.groupId || group.suspended) {
    return res.status(409).json({ error: 'A valid active group membership is required to issue an agreement.' });
  }

  const memberAgreements = dbm.db.systemAgreements.filter(row => row.memberId === member.id).sort((a, b) => b.id - a.id);
  const latest = memberAgreements[0] || null;
  if (latest && latest.status === 'SIGNED') return res.status(409).json({ error: 'A signed agreement already exists. Corrections require a linked new version.' });
  if (latest && latest.status === 'PENDING' && Date.parse(latest.expiresAt) > Date.now()) {
    return res.json({ ok: true, agreement: { agreementCode: latest.agreementCode, status: latest.status, createdAt: latest.createdAt, expiresAt: latest.expiresAt, version: latest.version } });
  }

  if (latest && latest.status === 'PENDING') {
    latest.status = 'EXPIRED';
    dbm.save();
    dbm.audit(member, 'agreement.expired', `system agreement #${latest.id}`, req);
  }

  let agreement;
  try {
    agreement = agreementCodes.createPending(member, profile.groupId);
    if (latest) {
      agreement.version = latest.version + 1;
      agreement.parentAgreementId = latest.id;
    }
  } catch (error) {
    return res.status(503).json({ error: error.message === 'Agreement code signing is not configured.' ? 'Agreement issuance is not configured.' : 'Unable to issue an agreement right now.' });
  }
  dbm.db.systemAgreements.push(agreement);
  dbm.save();
  dbm.audit(member, 'agreement.created', `system agreement #${agreement.id}`, req);
  res.status(201).json({ ok: true, agreement: { agreementCode: agreement.agreementCode, status: agreement.status, createdAt: agreement.createdAt, expiresAt: agreement.expiresAt, version: agreement.version } });
});

r.get('/system-agreements/current', (req, res) => {
  if (!requireSystemAgreements(req, res)) return;
  const agreement = dbm.db.systemAgreements.filter(row => row.memberId === req.user.id).sort((a, b) => b.id - a.id)[0] || null;
  if (!agreement) return res.json({ agreement: null });
  if (agreement.status === 'PENDING' && Date.parse(agreement.expiresAt) <= Date.now()) {
    agreement.status = 'EXPIRED';
    dbm.save();
    dbm.audit(req.user, 'agreement.expired', `system agreement #${agreement.id}`, req);
  }
  dbm.audit(req.user, 'agreement.read', `system agreement #${agreement.id}`, req);
  res.json({ agreement: { agreementCode: agreement.agreementCode, status: agreement.status, createdAt: agreement.createdAt, expiresAt: agreement.expiresAt, signedAt: agreement.signedAt, version: agreement.version } });
});

r.get('/system-agreements/current.pdf', (req, res) => {
  if (!requireSystemAgreements(req, res)) return;
  const agreement = dbm.db.systemAgreements.filter(row => row.memberId === req.user.id).sort((a, b) => b.id - a.id)[0] || null;
  if (!agreement) return res.status(404).json({ error: 'No system agreement is available.' });
  if (agreement.status === 'PENDING' && Date.parse(agreement.expiresAt) <= Date.now()) {
    agreement.status = 'EXPIRED';
    dbm.save();
    dbm.audit(req.user, 'agreement.expired', `system agreement #${agreement.id}`, req);
    return res.status(410).json({ error: 'This agreement has expired. Request a new agreement.' });
  }
  if (agreement.status !== 'PENDING') return res.status(409).json({ error: 'Only a pending agreement can be generated.' });
  const group = dbm.db.groups.find(entry => entry.id === agreement.groupId);
  if (!group || group.suspended || req.user.groupId !== agreement.groupId) return res.status(404).json({ error: 'Agreement is not available.' });
  let generated;
  try {
    const profile = dbm.memberProfileFor(req.user.id);
    const previousTime = agreement.pdfGeneratedAt ? new Date(agreement.pdfGeneratedAt) : new Date();
    generated = agreementPdf.create(agreement, req.user, profile, group, previousTime);
    if (agreement.profileSnapshot && JSON.stringify(agreement.profileSnapshot) !== JSON.stringify(generated.profileSnapshot)) {
      generated = agreementPdf.create(agreement, req.user, profile, group, new Date());
    }
  }
  catch {
    dbm.audit(req.user, 'agreement.pdf.generation.failed', `system agreement #${agreement.id}`, req);
    return res.status(503).json({ error: 'The agreement PDF could not be generated. Check agreement configuration and profile photo format.' });
  }
  const previousPdfHash = agreement.fileHash;
  agreement.fileHash = generated.fileHash;
  agreement.documentSeal = generated.seal;
  agreement.pdfGeneratedAt = generated.generatedAt;
  agreement.verificationUrl = generated.verifyUrl;
  agreement.profileSnapshot = generated.profileSnapshot;
  agreement.termsVersion = generated.termsVersion;
  agreement.signatureField = generated.signatureField;
  try {
    if (!agreement.originalFile || previousPdfHash !== generated.fileHash) {
      agreement.originalFile = agreementStorage.write(generated.buffer, 'original');
    }
  } catch {
    dbm.audit(req.user, 'agreement.pdf.storage.failed', `system agreement #${agreement.id}`, req);
    return res.status(503).json({ error: 'Private agreement storage is unavailable.' });
  }
  dbm.save();
  dbm.audit(req.user, 'agreement.downloaded', `system agreement #${agreement.id}`, req);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="agreement.pdf"');
  res.setHeader('Content-Length', generated.buffer.length);
  return res.send(generated.buffer);
});

r.post('/system-agreements/current/accept', sec.limiter(60e3, 5, 'Too many agreement acceptance attempts.'), (req, res) => {
  if (!requireSystemAgreements(req, res)) return;
  const agreement = dbm.db.systemAgreements.filter(row => row.memberId === req.user.id).sort((a, b) => b.id - a.id)[0] || null;
  if (!agreement) return res.status(404).json({ error: 'No system agreement is available.' });
  if (agreement.status === 'SIGNED' && agreement.signedFile) {
    return res.json({ ok: true, agreement: { agreementCode: agreement.agreementCode, status: agreement.status, signedAt: agreement.signedAt } });
  }
  if (agreement.status !== 'PENDING') return res.status(409).json({ error: 'Only a pending agreement can be accepted.' });
  if (Date.parse(agreement.expiresAt) <= Date.now()) {
    agreement.status = 'EXPIRED';
    dbm.save();
    dbm.audit(req.user, 'agreement.expired', `system agreement #${agreement.id}`, req);
    return res.status(410).json({ error: 'This agreement has expired. Request a new agreement.' });
  }
  const group = dbm.db.groups.find(entry => entry.id === agreement.groupId);
  if (!group || group.suspended || req.user.groupId !== agreement.groupId) return res.status(404).json({ error: 'Agreement is not available.' });

  const acceptedAt = new Date().toISOString();
  const acceptance = { memberId: req.user.id, acceptedAt, reference: crypto.randomUUID() };
  let generated, fileId;
  try {
    const profile = dbm.memberProfileFor(req.user.id);
    generated = agreementPdf.create(agreement, req.user, profile, group, new Date(agreement.pdfGeneratedAt || acceptedAt), acceptance);
    if (agreement.profileSnapshot && JSON.stringify(agreement.profileSnapshot) !== JSON.stringify(generated.profileSnapshot)) {
      return res.status(409).json({ error: 'Your profile changed after this agreement was issued. Request a current agreement before accepting.' });
    }
    fileId = agreementStorage.write(generated.buffer, 'signed');
  } catch {
    dbm.audit(req.user, 'agreement.acceptance.failed', `system agreement #${agreement.id}`, req);
    return res.status(503).json({ error: 'The accepted agreement could not be generated or stored. Please try again.' });
  }

  agreement.status = 'SIGNED';
  agreement.signedFile = fileId;
  agreement.signedFileHash = generated.fileHash;
  agreement.signedAt = acceptedAt;
  agreement.signedIp = String(req.ip || '').slice(0, 100);
  agreement.signedUserAgent = String(req.headers['user-agent'] || '').slice(0, 300);
  agreement.acceptance = acceptance;
  agreement.acceptanceSeal = generated.seal;
  agreement.acceptancePdfGeneratedAt = generated.generatedAt;
  agreement.acceptanceProfileSnapshot = generated.profileSnapshot;
  agreement.acceptanceVerifyUrl = generated.verifyUrl;
  agreement.acceptanceTermsVersion = generated.termsVersion;
  agreement.acceptanceSignatureField = generated.signatureField;
  const profile = dbm.memberProfileFor(req.user.id);
  if (profile) { profile.agreementSigned = true; profile.agreementSignedAt = acceptedAt; profile.updatedAt = acceptedAt; }
  dbm.save();
  dbm.audit(req.user, 'agreement.accepted', `system agreement #${agreement.id};${acceptance.reference}`, req);
  return res.json({ ok: true, agreement: { agreementCode: agreement.agreementCode, status: agreement.status, signedAt: agreement.signedAt } });
});

function uploadedPdf(req) {
  const contentType = String(req.contentType || '');
  if (/^application\/pdf(?:\s*;|$)/i.test(contentType)) return { mime: 'application/pdf', data: req.rawBuffer || Buffer.alloc(0) };
  const match = /multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!match) return null;
  const boundary = `--${match[1] || match[2]}`;
  const raw = req.rawBuffer || Buffer.alloc(0);
  const body = raw.toString('latin1');
  const start = body.indexOf(boundary + '\r\n');
  if (start < 0 || body.indexOf(boundary + '\r\n', start + boundary.length + 2) >= 0) return null;
  const headerEnd = body.indexOf('\r\n\r\n', start);
  const end = body.indexOf('\r\n' + boundary, headerEnd + 4);
  if (headerEnd < 0 || end < 0 || !body.slice(end).startsWith('\r\n' + boundary + '--')) return null;
  const headers = body.slice(start + boundary.length + 2, headerEnd);
  const mime = /(?:^|\r\n)Content-Type:\s*([^\r\n]+)/i.exec(headers);
  const disposition = /Content-Disposition:\s*form-data;[^\r\n]*\bfilename="[^"]*"/i.test(headers);
  if (!disposition) return null;
  return { mime: (mime && mime[1].trim().toLowerCase()) || 'application/octet-stream', data: Buffer.from(body.slice(headerEnd + 4, end), 'latin1') };
}

r.post('/system-agreements/current.pdf', sec.limiter(60e3, 5, 'Too many agreement upload attempts.'), (req, res) => {
  if (!requireSystemAgreements(req, res)) return;
  const agreement = dbm.db.systemAgreements.filter(row => row.memberId === req.user.id).sort((a, b) => b.id - a.id)[0] || null;
  const reject = (status, code, message) => {
    dbm.audit(req.user, 'agreement.upload.rejected', `system agreement #${agreement ? agreement.id : 0};${code}`, req);
    return res.status(status).json({ error: message });
  };
  if (!agreement) return reject(404, 'not_found', 'No system agreement is available.');
  if (agreement.status !== 'PENDING') return reject(409, 'not_pending', 'Only a pending agreement can be signed.');
  if (Date.parse(agreement.expiresAt) <= Date.now()) {
    agreement.status = 'EXPIRED'; dbm.save();
    return reject(410, 'expired', 'This agreement has expired. Request a new agreement.');
  }
  if (agreement.signedFile) return reject(409, 'already_used', 'This agreement code has already been used.');
  const upload = uploadedPdf(req);
  if (!upload || upload.mime !== 'application/pdf') return reject(400, 'mime_invalid', 'Upload one PDF file with application/pdf content type.');
  if (upload.data.length > agreementUpload.MAX_PDF_BYTES) return reject(413, 'size_limit', 'PDF must be at most 4 MB.');
  if (!agreement.originalFile) return reject(503, 'original_missing', 'The original system agreement is unavailable. Download it again before signing.');
  let signedHash, fileId;
  try {
    const original = agreementStorage.read(agreement.originalFile);
    const profile = dbm.memberProfileFor(req.user.id);
    const group = dbm.db.groups.find(entry => entry.id === agreement.groupId);
    const current = agreementPdf.create(agreement, req.user, profile, group, new Date(agreement.pdfGeneratedAt));
    if (JSON.stringify(current.profileSnapshot) !== JSON.stringify(agreement.profileSnapshot)) {
      return reject(409, 'profile_changed', 'Your profile changed after this PDF was generated. Download the current agreement again, then sign and upload it.');
    }
    signedHash = agreementUpload.inspect(upload.data, original, agreement);
    fileId = agreementStorage.write(upload.data, 'signed');
  } catch (error) {
    const status = error.publicStatus || 503;
    const code = error.publicCode || 'verification_unavailable';
    const message = error.publicStatus ? error.message : 'Agreement verification is unavailable. Contact support.';
    return reject(status, code, message);
  }
  const at = new Date().toISOString();
  agreement.status = 'SIGNED';
  agreement.signedFile = fileId;
  agreement.signedFileHash = signedHash;
  agreement.signedAt = at;
  agreement.signedIp = String(req.ip || '').slice(0, 100);
  agreement.signedUserAgent = String(req.headers['user-agent'] || '').slice(0, 300);
  const profile = dbm.memberProfileFor(req.user.id);
  if (profile) { profile.agreementSigned = true; profile.agreementSignedAt = at; profile.updatedAt = at; }
  dbm.save();
  dbm.audit(req.user, 'agreement.signed', `system agreement #${agreement.id}`, req);
  return res.json({ ok: true, agreement: { agreementCode: agreement.agreementCode, status: agreement.status, signedAt: agreement.signedAt } });
});

r.get('/system-agreements/current.signed.pdf', (req, res) => {
  if (!requireSystemAgreements(req, res)) return;
  const agreement = dbm.db.systemAgreements.filter(row => row.memberId === req.user.id).sort((a, b) => b.id - a.id)[0] || null;
  if (!agreement || agreement.status !== 'SIGNED' || !agreement.signedFile) return res.status(404).json({ error: 'Signed agreement is not available.' });
  let bytes;
  try {
    bytes = agreementStorage.read(agreement.signedFile);
    if (agreementUpload.hash(bytes) !== agreement.signedFileHash) throw new Error('Hash mismatch.');
  } catch {
    dbm.audit(req.user, 'agreement.signed.download.failed', `system agreement #${agreement.id}`, req);
    return res.status(503).json({ error: 'Signed agreement is unavailable.' });
  }
  dbm.audit(req.user, 'agreement.signed.downloaded', `system agreement #${agreement.id}`, req);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="signed-agreement.pdf"');
  res.setHeader('Content-Length', bytes.length);
  return res.send(bytes);
});

function magicOK(buf) {
  if (!buf || buf.length < 12) return false;
  const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const jpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const webp = buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  return png || jpg || webp;
}

function parseMultipart(buf, contentType) {
  const m = /boundary=([^;]+)/.exec(String(contentType || ''));
  if (!m) return null;
  const boundary = '--' + m[1].trim().replace(/^"|"$/g, '');
  const bufStr = buf.toString('latin1');
  let idx = bufStr.indexOf('filename="');
  if (idx < 0) return null;
  const headEnd = bufStr.indexOf('\r\n\r\n', idx);
  if (headEnd < 0) return null;
  const head = bufStr.slice(Math.max(0, bufStr.lastIndexOf(boundary, idx)), headEnd);
  const fnm = /filename="([^"]*)"/.exec(head);
  const ctm = /Content-Type:\s*([^\r\n]+)/i.exec(head);
  const dataStart = headEnd + 4;
  const endMarker = '\r\n' + boundary;
  let dataEnd = bufStr.indexOf(endMarker, dataStart);
  if (dataEnd < 0) dataEnd = buf.length;
  const data = Buffer.from(bufStr.slice(dataStart, dataEnd), 'latin1');
  return { filename: (fnm && fnm[1]) || 'file', mime: (ctm && ctm[1]).trim().toLowerCase() || 'application/octet-stream', data };
}

// ---- my profile ----
r.get('/', (req, res) => {
  const g = dbm.db.groups.find(x => x.id === req.user.groupId);
  const unread = dbm.visibleNotifications(req.user).filter(n => !n.readAt && !n.read).length;
  const mp = dbm.memberProfileFor(req.user.id);
  const savingsTotal = dbm.getUserSavingsTotal(req.user.id);
  res.json({
    me: dbm.safeUser(req.user),
    group: g ? { id: g.id, name: g.name, description: g.description } : null,
    unread,
    memberProfile: mp || null,
    registrationFeePending: dbm.db.registrationFees.some(f => f.userId === req.user.id && f.status === 'pending' && !f.reversed),
    savingsTotalCents: savingsTotal
  });
});

r.put('/profile', (req, res) => {
  const body = req.body || {};
  const allowed = new Set(['firstName', 'lastName', 'email', 'phone', 'currentPassword']);
  if (Object.keys(body).some(key => !allowed.has(key))) return res.status(400).json({ error: 'Only your name, email, and phone can be updated here.' });
  const firstName = body.firstName === undefined ? req.user.firstName : sec.clean(body.firstName, 60).trim();
  const lastName = body.lastName === undefined ? req.user.lastName : sec.clean(body.lastName, 60).trim();
  const email = body.email === undefined ? req.user.email : sec.clean(body.email, 120).trim().toLowerCase();
  const phone = body.phone === undefined ? req.user.phone || '' : sec.clean(body.phone, 30).trim();
  if (!sec.isName(firstName) || !sec.isName(lastName)) return res.status(400).json({ error: 'Enter a valid first and last name.' });
  if (!sec.isEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (phone && !sec.isPhone(phone)) return res.status(400).json({ error: 'Enter a valid phone number.' });
  if (dbm.db.users.some(user => !user.deleted && user.id !== req.user.id && user.email === email)) return res.status(409).json({ error: 'That email address is already in use.' });
  if ((email !== req.user.email || phone !== (req.user.phone || '')) && !sec.verifyPassword(String(body.currentPassword || ''), req.user.passHash)) {
    dbm.audit(req.user, 'profile.change.denied', 'contact reauthentication failed', req);
    return res.status(403).json({ error: 'Your current password is required to change your email or phone.' });
  }
  const changed = firstName !== req.user.firstName || lastName !== req.user.lastName || email !== req.user.email || phone !== (req.user.phone || '');
  if (changed) {
    Object.assign(req.user, { firstName, lastName, email, phone, updatedAt: new Date().toISOString() });
    const profile = dbm.memberProfileFor(req.user.id);
    if (profile) profile.updatedAt = req.user.updatedAt;
    dbm.save();
    dbm.audit(req.user, 'profile.self.updated', `user #${req.user.id}`, req);
  }
  return res.json({ ok: true, me: dbm.safeUser(req.user) });
});

// ---- registration fee ----
r.post('/member-profile/registration-fee', (req, res) => {
  const mp = dbm.memberProfileFor(req.user.id);
  if (!mp) return res.status(404).json({ error: 'Member profile not found' });
  if (mp.registrationFeePaid) return res.status(400).json({ error: 'Registration fee already paid' });
  const pending = dbm.db.registrationFees.find(f => f.userId === req.user.id && f.status === 'pending' && !f.reversed);
  if (pending) return res.json({ ok: true, pendingVerification: true, registrationFee: pending });
  const idempotencyKey = (req.body || {}).idempotencyKey || sec.generateIdempotencyKey('reg-fee');
  const existing = dbm.db.registrationFees.find(f => f.idempotencyKey === idempotencyKey);
  if (existing) return res.json({ ok: true, registrationFee: existing });
  const fee = dbm.appendRegistrationFee(req.user.id, mp.groupId, 20000, '', idempotencyKey);
  fee.status = 'pending'; fee.reportedAt = now(); fee.reportedBy = req.user.id;
  fee.staffRequest = staffMemberAccount(req); fee.submittedRole = req.user.role;
  dbm.save();
  dbm.audit(req.user, 'member.registration_fee.reported', '', req);
  if (fee.staffRequest) notifyOwnerOfStaffRequest(req, 'registration_fee', 'Staff registration fee awaiting Owner approval', `${req.user.firstName} ${req.user.lastName} reported payment of KES 200. Review it in Financial Verifications.`);
  else {
    const admins = dbm.db.users.filter(u => !u.deleted && !u.disabled && u.role === 'group_admin' && u.groupId === mp.groupId);
    for (const admin of admins) emailer.notifyUser(admin.id, 'registration_fee', 'Registration fee needs verification', `${req.user.firstName} ${req.user.lastName} reported payment of KES 200. Verify receipt before marking it paid.`);
  }
  res.json({ ok: true, pendingVerification: true, registrationFee: fee });
});

// ---- savings ----
r.post('/member-profile/savings', (req, res) => {
  const mp = dbm.memberProfileFor(req.user.id);
  if (!mp) return res.status(404).json({ error: 'Member profile not found' });
  if (!mp.registrationFeePaid) return res.status(400).json({ error: 'Pay registration fee first' });
  if (!staffMemberAccount(req) && !hasSignedAgreement(req.user.id)) return res.status(400).json({ error: 'Sign the current system agreement first' });
  const amountCents = dbm.toCents((req.body || {}).amount);
  const description = sec.clean((req.body || {}).description || '', 200);
  const currentWeek = currentWeekKey();
  const requestedWeek = sec.clean((req.body || {}).week || '', 8);
  if (requestedWeek && requestedWeek !== currentWeek) return res.status(400).json({ error: 'Savings can only be recorded for the current week' });
  const wk = currentWeek;
  if (!Number.isFinite(amountCents) || amountCents <= 0) return res.status(400).json({ error: 'Enter a valid amount' });
  const idempotencyKey = (req.body || {}).idempotencyKey || sec.generateIdempotencyKey('saving');
  const existing = dbm.db.savings.find(s => s.idempotencyKey === idempotencyKey);
  if (existing) return res.json({ ok: true, saving: existing });
  if (dbm.db.savings.some(s => s.userId === req.user.id && s.week === wk && !s.reversed)) return res.status(409).json({ error: 'A saving has already been recorded for this week' });
  const saving = dbm.appendSaving(req.user.id, mp.groupId, amountCents, wk, description, idempotencyKey);
  saving.status = 'pending'; saving.reportedAt = now(); saving.reportedBy = req.user.id;
  saving.staffRequest = staffMemberAccount(req); saving.submittedRole = req.user.role;
  dbm.save();
  dbm.audit(req.user, 'member.saving.reported', `KES ${dbm.fromCents(amountCents)}`, req);
  try { hub.broadcastSaving(req.user.id, mp.groupId); } catch {}
  if (saving.staffRequest) notifyOwnerOfStaffRequest(req, 'saving', 'Staff savings contribution awaiting Owner approval', `${req.user.firstName} ${req.user.lastName} reported KES ${dbm.fromCents(amountCents)} for ${wk}. Review it in Financial Verifications.`);
  else {
    const admins = dbm.db.users.filter(u => !u.deleted && !u.disabled && u.role === 'group_admin' && u.groupId === mp.groupId);
    for (const admin of admins) emailer.notifyUser(admin.id, 'saving', 'Savings contribution needs verification', `A KES ${dbm.fromCents(amountCents)} contribution for ${wk} needs review in your group.`);
  }
  res.status(201).json({ ok: true, pendingVerification: true, saving });
});

r.get('/member-profile/savings', (req, res) => {
  const mp = dbm.memberProfileFor(req.user.id);
  if (!mp) return res.status(404).json({ error: 'Member profile not found' });
  const savings = dbm.db.savings.filter(s => s.userId === req.user.id && !s.reversed).slice().reverse();
  const pendingCents = savings.filter(s => s.status === 'pending').reduce((sum, saving) => sum + Number(saving.amountCents || 0), 0);
  res.json({ savings, totalCents: dbm.getUserSavingsTotal(req.user.id), pendingCents });
});

r.get('/finance-trend', (req, res) => {
  const savings = dbm.db.savings.filter(entry => entry.userId === req.user.id);
  const loans = dbm.db.cashLoans.filter(loan => loan.userId === req.user.id).map(loan => ({ ...loan, type: 'cash' }))
    .concat(dbm.db.itemLoans.filter(loan => loan.userId === req.user.id).map(loan => ({ ...loan, type: 'item' })));
  res.json(financeTrends.buildTrend({ savings, loans }));
});

r.get('/member-profile/fines', (req, res) => {
  const mp = dbm.memberProfileFor(req.user.id);
  if (!mp) return res.status(404).json({ error: 'Member profile not found' });
  const fines = dbm.db.fines.filter(f => f.userId === req.user.id && !f.reversed).slice().reverse();
  res.json({ fines, totalCents: fines.reduce((n, f) => n + Number(f.amountCents || 0), 0) });
});

// ---- Patch 3: My Loans ----
function loanDetail(loan) {
  const borrower = dbm.db.users.find(u => u.id === loan.userId);
  const verifier = loan.verifiedBy ? dbm.db.users.find(u => u.id === loan.verifiedBy) : null;
  const clearer = loan.clearedBy ? dbm.db.users.find(u => u.id === loan.clearedBy) : null;
  const relatedFines = dbm.db.fines.filter(f => f.loanId === loan.id && !f.reversed);
  return {
    id: loan.id, type: loan.type, itemId: loan.itemId, itemName: loan.itemName,
    amountCents: loan.amountCents, totalDueCents: loan.totalDueCents, profitCents: loan.profitCents,
    costCents: loan.costCents, week: loan.week, status: loan.status,
    dueAt: loan.dueAt, verifiedAt: loan.verifiedAt, verifiedBy: verifier ? { role: verifier.role } : null,
    disbursedAt: loan.disbursedAt, clearedAt: loan.clearedAt, clearedBy: clearer ? { role: clearer.role } : null,
    fineCents: loan.fineCents, fineNowCents: dbm.overdueFineCents(loan), staffLoan: !!loan.staffLoan,
    requiresPaymentReport: !!loan.requiresPaymentReport, repaymentReportedAt: loan.repaymentReportedAt || null,
    createdAt: loan.createdAt, updatedAt: loan.updatedAt,
    fines: relatedFines.map(f => ({ id: f.id, amountCents: f.amountCents, paid: !!f.paid, paidAt: f.paidAt, createdAt: f.createdAt }))
  };
}

r.get('/loans', (req, res) => {
  const mp = dbm.memberProfileFor(req.user.id);
  if (!mp) return res.status(404).json({ error: 'Member profile not found' });
  const status = String((req.query || {}).status || '').toLowerCase();
  const page = Math.max(1, Number((req.query || {}).page) || 1);
  let loans = dbm.db.cashLoans.filter(l => l.userId === req.user.id).concat(dbm.db.itemLoans.filter(l => l.userId === req.user.id));
  if (status) loans = loans.filter(l => l.status === status);
  loans.sort((a, b) => b.id - a.id);
  const total = loans.length;
  const start = (page - 1) * PAGE;
  const pageLoans = loans.slice(start, start + PAGE).map(loanDetail);
  res.json({ loans: pageLoans, page, total, pages: Math.max(1, Math.ceil(total / PAGE)) });
});

r.get('/loans/:id', (req, res) => {
  const mp = dbm.memberProfileFor(req.user.id);
  if (!mp) return res.status(404).json({ error: 'Member profile not found' });
  const loan = dbm.db.cashLoans.find(l => l.id === Number(req.params.id) && l.userId === req.user.id) ||
               dbm.db.itemLoans.find(l => l.id === Number(req.params.id) && l.userId === req.user.id);
  if (!loan) {
    sec.sentinelAuthzDenied(req, 'me.loans.idor');
    return res.status(404).json({ error: 'Loan not found' });
  }
  res.json({ loan: loanDetail(loan) });
});

r.post('/loans/:id/repayment-report', (req, res) => {
  const loan = dbm.db.cashLoans.find(l => l.id === Number(req.params.id) && l.userId === req.user.id) ||
               dbm.db.itemLoans.find(l => l.id === Number(req.params.id) && l.userId === req.user.id);
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  if (!['disbursed', 'overdue'].includes(loan.status)) return res.status(400).json({ error: 'Only an active loan can be reported as repaid' });
  if (loan.repaymentReportedAt) return res.status(409).json({ error: 'Repayment is already awaiting Group Admin verification' });

  const fineCents = loan.type === 'cash' ? dbm.overdueFineCents(loan) : 0;
  if (fineCents > 0) {
    dbm.appendFine(loan.userId, loan.groupId, loan.id, fineCents, `fine:loan:${loan.id}`);
    loan.fineCents = (loan.fineCents || 0) + fineCents;
  }
  loan.repaymentReportedAt = now();
  loan.repaymentReportedBy = req.user.id;
  const outstandingFines = dbm.db.fines.filter(f => f.loanId === loan.id && !f.reversed && !f.paid).reduce((sum, fine) => sum + Number(fine.amountCents || 0), 0);
  loan.repaymentReportedCents = Number(loan.totalDueCents || loan.costCents || loan.amountCents || 0) + outstandingFines;
  loan.updatedAt = now(); dbm.save();
  dbm.audit(req.user, 'member.loan.repayment_reported', `${loan.type} loan #${loan.id}`, req);
  const approver = sec.getLoanApprover(loan);
  if (approver) emailer.notifyUser(approver.id, 'loan', 'Repayment needs verification', `A ${loan.type} loan repayment needs review in your group's loan queue.`);
  try { hub.broadcastLoan(req.user.id, { id: loan.id, type: loan.type, status: loan.status, repaymentReportedAt: loan.repaymentReportedAt }); } catch {}
  res.json({ ok: true, awaitingVerification: true, repaymentReportedAt: loan.repaymentReportedAt });
});

// ---- Patch 3: My Fines ----
function fineDetail(f) {
  const loan = f.loanId ? (dbm.db.cashLoans.find(l => l.id === f.loanId) || dbm.db.itemLoans.find(l => l.id === f.loanId)) : null;
  return {
    id: f.id, loanId: f.loanId, amountCents: f.amountCents, paid: !!f.paid, paidAt: f.paidAt,
    createdAt: f.createdAt, reversed: !!f.reversed, reversalOf: f.reversalOf,
    loanRef: loan ? '#' + loan.id : '-', loanType: loan ? loan.type : '-'
  };
}

r.get('/fines', (req, res) => {
  const mp = dbm.memberProfileFor(req.user.id);
  if (!mp) return res.status(404).json({ error: 'Member profile not found' });
  const page = Math.max(1, Number((req.query || {}).page) || 1);
  let fines = dbm.db.fines.filter(f => f.userId === req.user.id && !f.reversed).slice().reverse();
  const total = fines.length;
  const start = (page - 1) * PAGE;
  const pageFines = fines.slice(start, start + PAGE).map(fineDetail);
  const totalCents = fines.reduce((n, f) => n + Number(f.amountCents || 0), 0);
  const paidCents = fines.filter(f => f.paid).reduce((n, f) => n + Number(f.amountCents || 0), 0);
  res.json({ fines: pageFines, page, total, pages: Math.max(1, Math.ceil(total / PAGE)), totalCents, paidCents, outstandingCents: totalCents - paidCents });
});

r.get('/fines/:id', (req, res) => {
  const mp = dbm.memberProfileFor(req.user.id);
  if (!mp) return res.status(404).json({ error: 'Member profile not found' });
  const f = dbm.db.fines.find(x => x.id === Number(req.params.id) && x.userId === req.user.id);
  if (!f) {
    sec.sentinelAuthzDenied(req, 'me.fines.idor');
    return res.status(404).json({ error: 'Fine not found' });
  }
  res.json({ fine: fineDetail(f) });
});

// ---- Patch 3: My Statement ----
r.get('/statement', (req, res) => {
  const mp = dbm.memberProfileFor(req.user.id);
  if (!mp) return res.status(404).json({ error: 'Member profile not found' });
  const u = req.user;
  const fmt = String((req.query || {}).format || 'pdf').toLowerCase();
  const loans = dbm.db.cashLoans.filter(l => l.userId === u.id).concat(dbm.db.itemLoans.filter(l => l.userId === u.id)).sort((a, b) => b.id - a.id);
  const savings = dbm.db.savings.filter(s => s.userId === u.id && !s.reversed).sort((a, b) => b.id - a.id);
  const fines = dbm.db.fines.filter(f => f.userId === u.id && !f.reversed).sort((a, b) => b.id - a.id);
  const brand = dbm.currentBranding();
  if (fmt === 'csv') {
    const escCsv = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@\t\r].*/.test(s)) s = "'" + s; if (/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"'; return s; };
    const rows = [
      [`${brand ? brand.name : 'VonDonald051 Savings'} - My Statement`],
      ['Name', u.firstName + ' ' + u.lastName], ['Email', u.email], ['Phone', u.phone || ''], ['Role', u.role],
      ['Generated (UTC)', new Date().toISOString()],
      [],
      ['Savings'],
      ['ID', 'Amount (KES)', 'Week', 'Description', 'Date'],
      ...savings.map(s => [s.id, ((s.amountCents || 0) / 100).toFixed(2), s.week || '-', s.description || '-', (s.createdAt || '').slice(0, 10)]),
      [],
      ['Loans'],
      ['ID', 'Type', 'Amount (KES)', 'Due', 'Fine (KES)', 'Status', 'Created'],
      ...loans.map(l => [l.id, l.type, ((l.amountCents || 0) / 100).toFixed(2), l.dueAt ? (l.dueAt || '').slice(0, 10) : '-', ((l.fineCents || 0) / 100).toFixed(2), l.status, (l.createdAt || '').slice(0, 10)]),
      [],
      ['Fines'],
      ['ID', 'Amount (KES)', 'Paid', 'Loan ID', 'Created'],
      ...fines.map(f => [f.id, ((f.amountCents || 0) / 100).toFixed(2), f.paid ? 'YES' : 'NO', f.loanId || '-', (f.createdAt || '').slice(0, 10)])
    ];
    const csv = '\uFEFF' + rows.map(r => r.map(escCsv).join(',')).join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="my-statement-${u.id}.csv"`);
    return res.send(csv);
  }
  // PDF
  try {
    const { PdfDoc } = require('../pdf');
    const doc = new PdfDoc();
    doc.text(brand ? brand.name : 'VonDonald051 Savings', { size: 18, bold: true, color: [17, 17, 17], dy: 26 });
    doc.text('My Statement', { size: 13, color: [68, 68, 68], dy: 18 });
    doc.text(`Generated (UTC): ${new Date().toISOString()}`, { size: 9, color: [102, 102, 102], dy: 16 });
    doc.rule();
    doc.text(u.firstName + ' ' + u.lastName, { size: 14, bold: true, dy: 18 });
    doc.text(`Email: ${u.email}`, { size: 10, dy: 14 });
    doc.text(`Phone: ${u.phone || '-'}`, { size: 10, dy: 14 });
    doc.text(`Role: ${u.role}`, { size: 10, dy: 14 });
    doc.gap(8);
    doc.text('Savings', { size: 11, bold: true, dy: 16 });
    savings.forEach(s => doc.text(`KES ${((s.amountCents || 0) / 100).toFixed(2)}  |  ${s.week || '-'}  |  ${s.description || '-'}  |  ${(s.createdAt || '').slice(0, 10)}`, { size: 9, dy: 13 }));
    doc.gap(6);
    doc.text('Loans', { size: 11, bold: true, dy: 16 });
    loans.forEach(l => doc.text(`#${l.id}  ${l.type}  KES ${((l.amountCents || 0) / 100).toFixed(2)}  Due: ${l.dueAt ? (l.dueAt || '').slice(0, 10) : '-'}  Fine: KES ${((l.fineCents || 0) / 100).toFixed(2)}  Status: ${l.status}`, { size: 9, dy: 13 }));
    doc.gap(6);
    doc.text('Fines', { size: 11, bold: true, dy: 16 });
    fines.forEach(f => doc.text(`#${f.id}  KES ${((f.amountCents || 0) / 100).toFixed(2)}  Paid: ${f.paid ? 'YES' : 'NO'}  Loan: ${f.loanId || '-'}`, { size: 9, dy: 13 }));
    doc.gap(12);
    doc.text('Confidential - generated for the V Super Admin of VonDonald051 Savings.', { size: 8, color: [136, 136, 136] });
    const buf = doc.buffer();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="my-statement-${u.id}.pdf"`);
    res.setHeader('Content-Length', buf.length);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: 'PDF generation failed: ' + e.message });
  }
});

// ---- loan request (self-service) ----
r.post('/member-profile/loans', (req, res) => {
  const mp = dbm.memberProfileFor(req.user.id);
  if (!mp) return res.status(404).json({ error: 'Member profile not found' });
  if (!mp.registrationFeePaid) return res.status(400).json({ error: 'Pay registration fee first' });
  if (!staffMemberAccount(req) && !hasSignedAgreement(req.user.id)) return res.status(400).json({ error: 'Sign the current system agreement first' });
  if (dbm.hasUnclearedCashLoan(req.user.id)) return res.status(400).json({ error: 'You have an uncleared loan. Clear it before borrowing again.' });

  const b = req.body || {}, type = b.type === 'item' ? 'item' : b.type === 'cash' ? 'cash' : null;
  if (!type) return res.status(400).json({ error: 'Choose cash or item' });
  const wk = currentWeekKey();
  const idempotencyKey = b.idempotencyKey || sec.generateIdempotencyKey('member-loan');
  if (dbm.db.cashLoans.some(l => l.userId === req.user.id && l.type === 'cash' && l.week === wk && l.status !== 'rejected') || dbm.db.itemLoans.some(l => l.userId === req.user.id && l.type === 'item' && l.week === wk && l.status !== 'rejected')) {
    return res.status(400).json({ error: `Only one ${type} loan is allowed per week` });
  }

  let itemId = null, description = '', amountCents = 0, totalDueCents = 0, profitCents = 0, costCents = 0;
  if (type === 'item') {
    itemId = Number(b.itemId) || null;
    const item = dbm.db.items.find(i => i.id === itemId && i.groupId === mp.groupId && i.active !== false);
    if (!item) return res.status(400).json({ error: 'Choose an available group item' });
    if (!Number.isSafeInteger(item.priceCents) || item.priceCents <= 0) return res.status(400).json({ error: 'This item needs a valid price set by the Group Admin' });
    if (dbm.db.itemLoans.some(loan => loan.userId === req.user.id && loan.itemId === itemId && !['cleared', 'rejected'].includes(loan.status))) return res.status(409).json({ error: 'You already have an outstanding loan for this item' });
    description = item.name; costCents = item.priceCents || 0;
  } else {
    amountCents = dbm.toCents(b.amount);
    if (!Number.isFinite(amountCents) || amountCents <= 0 || amountCents > 100000000) return res.status(400).json({ error: 'Enter a valid cash amount' });
    const savings = dbm.getUserSavingsTotal(req.user.id);
    if (amountCents > Math.floor(savings * 0.5)) return res.status(400).json({ error: `Loan amount cannot exceed 50% of your savings (${dbm.centsToDisplay(Math.floor(savings * 0.5))})` });
    totalDueCents = amountCents;
  }

  const loan = {
    id: dbm.next(type === 'cash' ? 'cashLoan' : 'itemLoan'), userId: req.user.id, groupId: mp.groupId,
    type, itemId, itemName: description, itemDescription: '', amountCents, totalDueCents, profitCents, costCents,
    week: wk, status: 'pending',
    dueAt: null,
    verifiedAt: null, verifiedBy: null, disbursedAt: null, clearedAt: null, clearedBy: null,
    fineCents: 0, idempotencyKey, staffLoan: staffMemberAccount(req),
    requiresPaymentReport: true, repaymentReportedAt: null, repaymentReportedBy: null, repaymentReportedCents: null,
    createdAt: now(), updatedAt: now()
  };
  if (type === 'cash') dbm.db.cashLoans.push(loan); else dbm.db.itemLoans.push(loan);
  dbm.save(); dbm.audit(req.user, 'member.loan.requested', `${type} loan #${loan.id}`, req);
  try { hub.broadcastLoan(req.user.id, { id: loan.id, type: loan.type, status: loan.status, amountCents: loan.amountCents, dueAt: loan.dueAt }); } catch {}
  if (loan.staffLoan) {
    notifyOwnerOfStaffRequest(req, 'loan', 'Staff member loan request', `${req.user.firstName} ${req.user.lastName} requested a ${type} loan (${dbm.centsToDisplay(amountCents || costCents)}). Review it in Owner Loan Queue.`);
  } else {
    const admins = dbm.db.users.filter(u => !u.deleted && u.role === 'group_admin' && u.groupId === mp.groupId);
    for (const admin of admins) emailer.notifyUser(admin.id, 'loan', 'New loan request', `${req.user.firstName} ${req.user.lastName} requested a ${type} loan (${dbm.centsToDisplay(amountCents || costCents)}).`);
  }
  res.status(201).json({ ok: true, loan });
});

// ---- upload profile picture ----
r.post('/picture', (req, res) => {
  const part = parseMultipart(req.rawBuffer || Buffer.alloc(0), req.contentType);
  if (!part || !part.data.length) return res.status(400).json({ error: 'No image received' });
  const allowedImageTypes = process.env.SYSTEM_AGREEMENTS_V2 === '1' ? ['image/png', 'image/jpeg'] : ['image/png', 'image/jpeg', 'image/webp'];
  if (!allowedImageTypes.includes(part.mime)) {
    dbm.audit(req.user, 'upload.rejected.mime', part.mime, req);
    return res.status(400).json({ error: process.env.SYSTEM_AGREEMENTS_V2 === '1' ? 'Agreement profile photos must be PNG or JPG' : 'Only PNG, JPG or WEBP images allowed' });
  }
  if (part.data.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'Image too large (max 2MB)' });
  if (!magicOK(part.data)) {
    dbm.audit(req.user, 'upload.rejected.magic', part.filename, req);
    return res.status(400).json({ error: 'File is not a real image' });
  }
  const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[part.mime];
  const name = crypto.randomBytes(16).toString('hex') + ext;
  fs.writeFileSync(path.join(UP, name), part.data);
  const old = req.user.pic;
  req.user.pic = '/uploads/' + name;
  req.user.updatedAt = new Date().toISOString();
  dbm.save();
  if (old) { const f = path.join(UP, path.basename(old)); if (fs.existsSync(f)) fs.unlinkSync(f); }
  dbm.audit(req.user, 'profile.picture.updated', '', req);
  res.json({ ok: true, pic: req.user.pic });
});

// ---- change password ----
r.post('/password', sec.limiter(60e3, 6, 'Too many attempts'), (req, res) => {
  const b = req.body || {};
  if (!sec.verifyPassword(String(b.currentPassword || ''), req.user.passHash)) {
    dbm.audit(req.user, 'password.change.denied', '', req);
    return res.status(403).json({ error: 'Current password is wrong' });
  }
  const issues = sec.passwordIssues(String(b.newPassword || ''));
  if (issues.length) return res.status(400).json({ error: 'New password needs ' + issues.join(', ') });
  if (String(b.newPassword) !== String(b.confirmPassword || '')) return res.status(400).json({ error: 'Passwords do not match' });
  req.user.passHash = sec.hashPassword(b.newPassword);
  req.user.passwordChangeRequired = false;
  req.user.updatedAt = new Date().toISOString();
  dbm.save();
  const revoked = dbm.db.sessions.filter(s => s.userId === req.user.id && s.token !== req.session.token).map(s => s.token);
  dbm.db.sessions = dbm.db.sessions.filter(s => s.userId !== req.user.id || s.token === req.session.token);
  dbm.save();
  for (const token of revoked) hub.revokeSession(token);
  dbm.audit(req.user, 'password.changed', '', req);
  res.json({ ok: true, home: sec.ROLE_HOME[req.user.role] || '/login.html' });
});

// ---- E2E public key ----
r.post('/pubkey', (req, res) => {
  const jwk = String((req.body || {}).jwk || '');
  if (jwk.length < 50 || jwk.length > 2000) return res.status(400).json({ error: 'Invalid key' });
  try { const p = JSON.parse(jwk); if (p.kty !== 'EC' || p.crv !== 'P-256' || !p.x || !p.y) throw new Error('bad'); } catch { return res.status(400).json({ error: 'Invalid key format' }); }
  req.user.ecdhPub = jwk; dbm.save();
  res.json({ ok: true });
});

// ---- notifications ----
r.get('/notifications', (req, res) => {
  const mine = dbm.visibleNotifications(req.user).slice(-100).reverse();
  dbm.audit(req.user, 'notification.list.read', `count=${mine.length}`, req);
  res.json({ notifications: mine });
});
r.post('/notifications/:id/read', (req, res) => {
  const n = dbm.db.notifications.find(x => x.id === Number(req.params.id));
  if (!n || !dbm.notificationVisibleTo(n, req.user)) {
    dbm.audit(req.user, 'notification.read.denied', `notification #${String(req.params.id).slice(0, 24)}`, req);
    return res.status(404).json({ error: 'Notification not found.' });
  }
  n.read = true; n.readAt = new Date().toISOString(); dbm.save();
  dbm.audit(req.user, 'notification.read', `notification #${n.id}`, req);
  res.json({ ok: true });
});

module.exports = r;
