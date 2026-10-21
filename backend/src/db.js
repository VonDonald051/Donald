'use strict';
/* JSON document store with atomic writes (crash-safe, zero SQL => no SQL injection by construction).
 * Stage 4 Finance + Stage 5 Branding/Agreements/Exports. */
const fs = require('fs');
const path = require('path');
const dbCrypto = require('./db-crypto');

// Tests may isolate the JSON store; production data lives outside the backend code.
const DIR = process.env.NODE_ENV === 'test' && process.env.VONDONALD_TEST_DATA_DIR
  ? path.resolve(process.env.VONDONALD_TEST_DATA_DIR)
  : path.resolve(process.env.VONDONALD_DATA_DIR || path.join(__dirname, '..', '..', 'database', 'data'));
const FILE = path.join(DIR, 'db.json');
fs.mkdirSync(DIR, { recursive: true });

let db = null;
let saving = false;

function blank() {
  return {
    meta: { v: 4, created: new Date().toISOString() },
    counters: { user: 0, group: 0, safeCode: 0, request: 0, message: 0, notification: 0, audit: 0, reset: 0, session: 0, item: 0, cashLoan: 0, itemLoan: 0, registrationFee: 0, saving: 0, fine: 0, reversal: 0, branding: 0, agreement: 0, export: 0 },
    users: [], groups: [], safeCodes: [], requests: [], messages: [],
    notifications: [], audit: [], resets: [], sessions: [], items: [],
    registrationFees: [], cashLoans: [], itemLoans: [], savings: [], fines: [], reversals: [],
    memberProfiles: [], notes: [],
    branding: [], agreements: [], exports: [],
    settings: { safe_code_required: '1', ownerOtpEnabled: '0', ownerOtpCode: null, ownerOtpExpires: null }
  };
}

function load() {
  try {
    dbCrypto.encryptionKey();
    const bytes = fs.existsSync(FILE) ? fs.readFileSync(FILE) : null;
    if (bytes && !dbCrypto.isEncrypted(bytes)) throw new Error('Database is plaintext; encrypt it offline before starting the application.');
    db = bytes ? JSON.parse(dbCrypto.decryptDatabase(bytes).toString('utf8')) : blank();
    if (!db || !Array.isArray(db.users)) throw new Error('corrupt db');
  } catch (e) {
    throw new Error(`[db] Refusing to replace unreadable data at ${FILE}: ${e.message}`);
  }
  if (!db.settings) db.settings = { safe_code_required: '1' };
  delete db.settings.ownerMfaEnforced;
  db.settings.ownerOtpEnabled = '0'; db.settings.ownerOtpCode = null; db.settings.ownerOtpExpires = null;
  for (const key of ['items', 'registrationFees', 'cashLoans', 'itemLoans', 'savings', 'fines', 'reversals', 'memberProfiles', 'notes', 'branding', 'agreements', 'exports']) if (!Array.isArray(db[key])) db[key] = [];
  for (const key of ['item', 'registrationFee', 'cashLoan', 'itemLoan', 'saving', 'fine', 'reversal', 'memberProfile', 'note', 'branding', 'agreement', 'export']) if (!Number.isFinite(db.counters[key])) db.counters[key] = 0;
  if (!db.meta.v || db.meta.v < 4) db.meta.v = 4;
  const legacyMfaUserFields = ['mfaRequired', 'mfaSecretEnc', 'mfaEnabled', 'mfaType', 'mfaPhone', 'mfaLastStep'];
  const legacyMfaSessionFields = ['mfaVerified', 'mfaPending', 'mfaRemember', 'mfaSetupSecretEnc', 'mfaSmsEnrollment', 'mfaSmsSetupPhone'];
  for (const user of db.users) {
    delete user.passVault;
    for (const field of legacyMfaUserFields) delete user[field];
  }
  if (Array.isArray(db.sessions)) {
    for (const session of db.sessions) for (const field of legacyMfaSessionFields) delete session[field];
  }

  // Migrate old loans array to new cashLoans/itemLoans if needed
  if (Array.isArray(db.loans) && db.loans.length > 0 && (!db.cashLoans || !db.itemLoans)) {
    for (const l of db.loans) {
      const entry = {
        id: l.id, userId: l.borrowerId, groupId: l.groupId,
        amountCents: Math.round(Number(l.principal || 0) * 100),
        totalDueCents: Math.round(Number(l.totalDue || 0) * 100),
        profitCents: Math.round(Number(l.profit || 0) * 100),
        week: l.week || '', status: l.status === 'paid' ? 'cleared' : l.status,
        dueAt: l.dueAt || null, verifiedAt: l.approvedAt || null, verifiedBy: l.approvedBy || null,
        disbursedAt: l.approvedAt || null, clearedAt: l.paidAt || null, clearedBy: null,
        fineCents: Math.round(Number(l.finePaid || 0) * 100),
        idempotencyKey: null, staffLoan: !!l.staffLoan,
        createdAt: l.createdAt, updatedAt: new Date().toISOString()
      };
      if (l.type === 'item') {
        entry.itemId = l.itemId; entry.itemName = l.description; entry.itemDescription = ''; entry.costCents = 0;
        db.itemLoans.push(entry); db.counters.itemLoan = Math.max(db.counters.itemLoan, l.id);
      } else {
        db.cashLoans.push(entry); db.counters.cashLoan = Math.max(db.counters.cashLoan, l.id);
      }
    }
    db.loans = [];
  }

  // Migrate existing users without member profiles
  const nowIso = new Date().toISOString();
  let staffGroup = db.groups.find(g => g.isStaffChama);
  if (!staffGroup) {
    const staffGroupId = next('group');
    staffGroup = { id: staffGroupId, name: 'Staff Chama', description: 'System-managed group for Super Admins and Admins (Owner acts as approver)', isStaffChama: true, createdAt: nowIso };
    db.groups.push(staffGroup);
  }
  for (const u of db.users) {
    const staffRole = ['super_admin', 'admin', 'group_admin'].includes(u.role);
    if (['super_admin', 'admin'].includes(u.role) && !u.groupId && staffGroup) u.groupId = staffGroup.id;
    if (!db.memberProfiles.some(p => p.userId === u.id)) {
      const groupId = u.role === 'group_admin' ? u.groupId : (staffRole && staffGroup ? staffGroup.id : u.groupId);
      db.memberProfiles.push({
        id: next('memberProfile'), userId: u.id, groupId: groupId || null,
        registrationFeePaid: false, registrationFeePaidAt: null,
        agreementSigned: false, agreementSignedAt: null,
        weeklySavingTarget: 0, createdAt: nowIso, updatedAt: nowIso
      });
    }
    const profile = db.memberProfiles.find(p => p.userId === u.id);
    if (profile && !profile.groupId && staffRole) profile.groupId = u.groupId || (u.role === 'group_admin' ? null : staffGroup.id);
  }
  const staffUserIds = new Set(db.users.filter(user => !user.deleted && ['super_admin', 'admin', 'group_admin'].includes(user.role)).map(user => user.id));
  for (const loan of [...db.cashLoans, ...db.itemLoans]) {
    if (staffUserIds.has(loan.userId)) loan.staffLoan = true;
  }

  // Seed default branding if none exists
  if (!db.branding || db.branding.length === 0) {
    db.branding.push({
      id: next('branding'), name: 'VonDonald051 Savings', logo: null, colors: null,
      logo32: null, logo128: null, logo512: null,
      createdAt: nowIso, createdBy: null, rolledBack: false
    });
  }

  save();
  return db;
}

function save() {
  if (saving) {
    const wait = () => new Promise(res => setImmediate(() => { if (saving) wait(); else res(); }));
    return new Promise(resolve => wait().then(() => { save().then(resolve); }));
  }
  saving = true;
  try {
    const tmp = FILE + '.tmp';
    dbCrypto.encryptionKey();
    fs.writeFileSync(tmp, dbCrypto.encryptDatabase(Buffer.from(JSON.stringify(db))), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, FILE);
    fs.chmodSync(FILE, 0o600);
    return Promise.resolve();
  } finally {
    saving = false;
  }
}

function reset() {
  db = blank();
  save();
  return db;
}

function next(kind) { db.counters[kind] = (db.counters[kind] || 0) + 1; return db.counters[kind]; }
function add(coll, kind, obj) { obj.id = next(kind); db[coll].push(obj); save(); return obj; }

function audit(actor, action, target, req) {
  const prev = db.audit.length ? db.audit[db.audit.length - 1] : null;
  const e = {
    id: next('audit'), actor: actor ? actor.id : null, actorRole: actor ? actor.role : null,
    action: String(action).slice(0, 80), target: String(target || '').slice(0, 160),
    ip: req ? String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '') : '',
    at: new Date().toISOString(),
    prevHash: prev ? sha256(JSON.stringify(prev)) : null,
    hash: null
  };
  e.hash = sha256(JSON.stringify(e));
  db.audit.push(e);
  if (db.audit.length > 5000) db.audit = db.audit.slice(-5000);
  save();
  return e;
}

function sha256(str) {
  const h = require('crypto').createHash('sha256').update(str).digest('hex');
  return h;
}

function killSessions(userId) {
  db.sessions = db.sessions.filter(s => s.userId !== userId); save();
  try { require('./hub').revokeUser(userId); } catch {}
}
function maskEmail(email) {
  const s = String(email || '');
  const [local, domain] = s.split('@');
  if (!domain) return s.slice(0, 2) + '#####';
  if (local.length <= 2) return local + '#####@' + domain;
  return local.slice(0, 2) + '#####@' + domain;
}
function maskPhone(phone) {
  const s = String(phone || '');
  if (s.length <= 6) return s.slice(0, 1) + '#####';
  return s.slice(0, 4) + '####' + s.slice(-2);
}

function notificationVisibleTo(notification, user) {
  if (!notification || !user || user.deleted || user.disabled) return false;
  if (['v_super_admin', 'super_admin'].includes(user.role) && ['admin', 'email', 'security'].includes(notification.type)) return false;
  if (user.role !== 'admin' && notification.type === 'security') return false;
  const recipientId = notification.recipientId != null ? notification.recipientId : notification.userId;
  if (recipientId != null) {
    if (Number(recipientId) !== Number(user.id)) return false;
    const role = notification.recipientRole;
    if (role && role !== user.role) return false;
    if (user.role === 'group_admin' && notification.groupId != null && Number(notification.groupId) !== Number(user.groupId)) return false;
    return true;
  }
  if (!notification.recipientRole || notification.recipientRole !== user.role) return false;
  if (user.role === 'v_super_admin' || user.role === 'super_admin') return false;
  return notification.groupId == null || Number(notification.groupId) === Number(user.groupId);
}

function visibleNotifications(user) {
  return db.notifications.filter(notification => notificationVisibleTo(notification, user));
}
function safeUser(u) {
  if (!u) return null;
  return { id: u.id, firstName: u.firstName, lastName: u.lastName, name: u.firstName + ' ' + u.lastName, email: u.email, phone: u.phone, role: u.role, groupId: u.groupId || null, pic: u.pic || null, locked: !!u.locked, disabled: !!u.disabled, passwordChangeRequired: !!u.passwordChangeRequired, failed: u.failed || 0, createdAt: u.createdAt, pub: u.ecdhPub || null };
}
function maskedUser(u) {
  if (!u) return null;
  return { id: u.id, firstName: u.firstName, lastName: u.lastName, name: u.firstName + ' ' + u.lastName, email: maskEmail(u.email), phone: maskPhone(u.phone), role: u.role, groupId: u.groupId || null, pic: u.pic || null, locked: !!u.locked, disabled: !!u.disabled, passwordChangeRequired: !!u.passwordChangeRequired, failed: u.failed || 0, createdAt: u.createdAt, pub: u.ecdhPub || null };
}

// member profile helpers
function memberProfileFor(userId) { return db.memberProfiles.find(p => p.userId === userId) || null; }
function staffChamaGroup() { return db.groups.find(g => g.isStaffChama) || null; }

// Branding helpers
function currentBranding() {
  const active = db.branding.filter(b => !b.rolledBack);
  return active.length ? active[active.length - 1] : null;
}
function brandingHistory() {
  return db.branding.slice(-50).reverse();
}

// Agreement helpers
function agreementFor(userId) {
  return db.agreements.find(a => a.userId === userId && !a.rolledBack) || null;
}

// Financial helpers (integer cents)
function toCents(amount) { return Math.round(Number(amount || 0) * 100); }
function fromCents(cents) { return (Number(cents || 0) / 100).toFixed(2); }
function centsToDisplay(cents) { return 'KES ' + fromCents(cents); }

// Ledger helpers (append-only)
function appendRegistrationFee(userId, groupId, amountCents, week, idempotencyKey) {
  if (db.registrationFees.some(f => f.idempotencyKey === idempotencyKey)) return db.registrationFees.find(f => f.idempotencyKey === idempotencyKey);
  return add('registrationFees', 'registrationFee', { userId, groupId, amountCents, week, idempotencyKey, reversed: false, reversalOf: null, createdAt: new Date().toISOString() });
}
function appendSaving(userId, groupId, amountCents, week, description, idempotencyKey) {
  if (db.savings.some(s => s.idempotencyKey === idempotencyKey)) return db.savings.find(s => s.idempotencyKey === idempotencyKey);
  return add('savings', 'saving', { userId, groupId, amountCents, week, description: description || 'Weekly saving', idempotencyKey, reversed: false, reversalOf: null, createdAt: new Date().toISOString() });
}
function appendFine(userId, groupId, loanId, amountCents, idempotencyKey) {
  if (db.fines.some(f => f.idempotencyKey === idempotencyKey)) return db.fines.find(f => f.idempotencyKey === idempotencyKey);
  return add('fines', 'fine', { userId, groupId, loanId, amountCents, paid: false, paidAt: null, idempotencyKey, reversed: false, reversalOf: null, createdAt: new Date().toISOString() });
}
function appendReversal(originalTable, originalId, reason, userId) {
  return add('reversals', 'reversal', { originalTable, originalId, reason, createdBy: userId, createdAt: new Date().toISOString() });
}

function getUserSavingsTotal(userId) {
  return db.savings.filter(s => s.userId === userId && !s.reversed && (!s.status || s.status === 'verified')).reduce((n, s) => n + Number(s.amountCents || 0), 0);
}
function getGroupSavingsTotal(groupId) {
  return db.savings.filter(s => s.groupId === groupId && !s.reversed && (!s.status || s.status === 'verified')).reduce((n, s) => n + Number(s.amountCents || 0), 0);
}
function getGroupMemberSavingsTotals(groupId) {
  const totals = {};
  for (const s of db.savings.filter(s => s.groupId === groupId && !s.reversed && (!s.status || s.status === 'verified'))) {
    totals[s.userId] = (totals[s.userId] || 0) + Number(s.amountCents || 0);
  }
  return totals;
}
function getGroupParticipantCount(groupId) {
  return db.users.filter(u => !u.deleted && u.groupId === groupId && ['member', 'group_admin'].includes(u.role)).length;
}
function hasUnclearedCashLoan(userId) {
  return db.cashLoans.some(l => l.userId === userId && !['cleared', 'rejected'].includes(l.status));
}
function getBorrowerSavings(userId) {
  return getUserSavingsTotal(userId);
}
function getUserLoanTotalCents(userId) {
  return db.cashLoans.filter(l => l.userId === userId && !['cleared', 'rejected'].includes(l.status)).reduce((n, l) => n + Number(l.amountCents || 0), 0);
}
function getUserFineTotalCents(userId) {
  return db.fines.filter(f => f.userId === userId && !f.reversed).reduce((n, f) => n + Number(f.amountCents || 0), 0);
}
function getUserFinePaidCents(userId) {
  return db.fines.filter(f => f.userId === userId && !f.reversed && f.paid).reduce((n, f) => n + Number(f.amountCents || 0), 0);
}

function markLoanFinesPaid(loanId, verifiedBy, paidAt = new Date().toISOString()) {
  let changed = false;
  for (const fine of db.fines.filter(entry => entry.loanId === loanId && !entry.reversed && !entry.paid)) {
    fine.paid = true; fine.paidAt = paidAt; fine.verifiedBy = verifiedBy; changed = true;
  }
  if (changed) save();
}

function overdueFineCents(loan, at = Date.now(), fines = db.fines) {
  if (!loan || loan.type !== 'cash' || !['disbursed', 'overdue'].includes(loan.status)) return 0;
  const dueAt = Date.parse(loan.dueAt || '');
  if (!Number.isFinite(dueAt) || at <= dueAt) return 0;
  if (fines.some(f => f.loanId === loan.id && !f.reversed)) return 0;
  return Math.round(Number(loan.amountCents || 0) * 0.01);
}

module.exports = {
  get db() { return db; },
  load, save, reset, next, add, audit, killSessions, safeUser, maskedUser, maskEmail, maskPhone, DIR,
  memberProfileFor, staffChamaGroup, notificationVisibleTo, visibleNotifications,
  currentBranding, brandingHistory, agreementFor,
  toCents, fromCents, centsToDisplay,
  appendRegistrationFee, appendSaving, appendFine, appendReversal,
  getUserSavingsTotal, getGroupSavingsTotal, getGroupMemberSavingsTotals, getGroupParticipantCount,
  hasUnclearedCashLoan, getBorrowerSavings,
  getUserLoanTotalCents, getUserFineTotalCents, getUserFinePaidCents, overdueFineCents, markLoanFinesPaid,
  sha256
};
