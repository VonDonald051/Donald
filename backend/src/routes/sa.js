'use strict';
/* SUPER ADMIN (black / stars + moon dashboard): system oversight - view group admins,
 * members and groups, create/edit groups and group admins, read-only monitoring.
 * Stage 4 Finance: verify Group Admin loans (GA loans -> SA verifier).
 * Super Admin is also a member of the Staff Chama with a member profile. They can perform
 * self-service member actions on their own member profile only. Their own loans go to
 * the Owner (V Super Admin) for verification. */
const { Router } = require('../httpmini');
const dbm = require('../db');
const sec = require('../security');
const emailer = require('../emailer');
const reports = require('../reports');
const hub = require('../hub');
const agreementViews = require('../system-agreement-views');

const r = new Router();
r.use(sec.auth, sec.requireRole('super_admin'));
const now = () => new Date().toISOString();

r.get('/system-agreements', (req, res) => agreementViews.listSystemAgreements(req, res));

r.get('/overview', (req, res) => {
  const db = dbm.db;
  const live = db.users.filter(u => !u.deleted);
  res.json({
    groups: db.groups.filter(g => !g.isStaffChama).length,
    groupAdmins: live.filter(u => u.role === 'group_admin').length,
    members: live.filter(u => u.role === 'member').length,
    locked: live.filter(u => u.locked).length,
    pendingRequests: db.requests.filter(q => q.status === 'pending').length,
    messages: db.messages.length,
    teamsAlertsConfigured: !!process.env.TEAMS_WEBHOOK_URL,
    aiAlertsConfigured: !!process.env.AI_API_KEY && !!process.env.AI_API_URL
  });
});

r.get('/groups', (req, res) => {
  const gs = dbm.db.groups.filter(g => !g.isStaffChama).map(g => ({
    ...g,
    members: dbm.getGroupParticipantCount(g.id),
    savingsCents: dbm.getGroupSavingsTotal(g.id),
    admins: dbm.db.users.filter(u => !u.deleted && u.groupId === g.id && u.role === 'group_admin').length
  }));
  res.json({ groups: gs });
});
r.post('/groups', (req, res) => {
  const name = sec.clean((req.body || {}).name, 80).trim();
  const description = sec.clean((req.body || {}).description, 200);
  if (name.length < 3) return res.status(400).json({ error: 'Group name needs at least 3 characters' });
  if (dbm.db.groups.some(g => g.name.toLowerCase() === name.toLowerCase())) return res.status(400).json({ error: 'Group name already exists' });
  const g = dbm.add('groups', 'group', { name, description, isStaffChama: false, createdAt: now() });
  dbm.audit(req.user, 'sa.group.created', name, req);
  res.status(201).json({ ok: true, group: g });
});
r.put('/groups/:id', (req, res) => {
  const g = dbm.db.groups.find(x => x.id === Number(req.params.id));
  if (!g || g.isStaffChama) return res.status(404).json({ error: 'Group not found' });
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'description')) return res.status(403).json({ error: 'Super Admins may only edit the group name' });
  const name = sec.clean((req.body || {}).name ?? g.name, 80).trim();
  if (name.length < 3) return res.status(400).json({ error: 'Group name needs at least 3 characters' });
  g.name = name;
  dbm.save(); dbm.audit(req.user, 'sa.group.updated', name, req);
  res.json({ ok: true });
});

r.post('/groups/:id/suspend', (req, res) => {
  const g = dbm.db.groups.find(x => x.id === Number(req.params.id) && !x.isStaffChama);
  if (!g) return res.status(404).json({ error: 'Group not found' });
  if (g.suspended) return res.status(400).json({ error: 'Group is already suspended' });
  g.suspended = true; g.suspendedAt = now(); g.suspendedBy = req.user.id;
  dbm.save(); hub.revokeGroup(g.id); dbm.audit(req.user, 'sa.group.suspended', g.name, req);
  res.json({ ok: true, suspended: true });
});

r.get('/group-admins', (req, res) => {
  const list = dbm.db.users.filter(u => !u.deleted && u.role === 'group_admin').map(u => ({ ...dbm.maskedUser(u), group: (dbm.db.groups.find(g => g.id === u.groupId) || {}).name || null }));
  res.json({ users: list });
});

r.post('/group-admins', (req, res) => {
  const b = req.body || {};
  const firstName = sec.clean(b.firstName, 60).trim();
  const lastName = sec.clean(b.lastName, 60).trim();
  const email = sec.clean(b.email, 120).trim().toLowerCase();
  const phone = sec.clean(b.phone, 30).trim();
  const groupId = Number(b.groupId) || null;
  const password = String(b.password || '');
  const confirm = String(b.confirmPassword || '');
  const group = dbm.db.groups.find(g => g.id === groupId && !g.isStaffChama && !g.suspended);
  const members = dbm.getGroupParticipantCount(groupId);
  const errors = {};
  if (!sec.isName(firstName)) errors.firstName = 'Valid first name required';
  if (!sec.isName(lastName)) errors.lastName = 'Valid last name required';
  if (!sec.isEmail(email)) errors.email = 'Valid email required';
  else if (dbm.db.users.some(u => !u.deleted && u.email === email)) errors.email = 'Email already in use';
  if (!sec.isPhone(phone)) errors.phone = 'Valid phone required';
  const pwIssues = sec.passwordIssues(password);
  if (pwIssues.length) errors.password = 'Password needs ' + pwIssues.join(', ');
  if (password !== confirm) errors.confirmPassword = 'Passwords do not match';
  if (!group) errors.groupId = 'Choose an active savings group';
  else if (members >= 30) errors.groupId = 'This group has reached its 30-member limit';
  if (Object.keys(errors).length) return res.status(400).json({ errors });

  const createdAt = now();
  const user = {
    id: dbm.next('user'), firstName, lastName, email, phone, role: 'group_admin', groupId,
    passHash: sec.hashPassword(password), passwordChangeRequired: true,
    pic: null, ecdhPub: null, failed: 0, locked: false, disabled: false, deleted: false,
    createdAt, updatedAt: createdAt
  };
  dbm.db.users.push(user);
  dbm.db.memberProfiles.push({
    id: dbm.next('memberProfile'), userId: user.id, groupId,
    registrationFeePaid: false, registrationFeePaidAt: null,
    agreementSigned: false, agreementSignedAt: null, weeklySavingTarget: 0,
    createdAt, updatedAt: createdAt
  });
  dbm.save();
  dbm.audit(req.user, 'sa.group_admin.created', `${email} in group #${groupId}`, req);
  emailer.sendEmail(email, 'Your Group Admin account', `Your account for ${group.name} is ready.\nLogin: ${email}\nTemporary password: ${password}\nChange it after logging in.`);
  res.status(201).json({ ok: true, user: dbm.maskedUser(user), temporaryPassword: password });
});

r.get('/members', (req, res) => {
  const list = dbm.db.users.filter(u => !u.deleted && u.role === 'member').map(u => ({ ...dbm.maskedUser(u), group: (dbm.db.groups.find(g => g.id === u.groupId) || {}).name || null }));
  res.json({ users: list });
});

// ---- GA loan verification (GA loans -> SA) ----
r.get('/ga-loans', (req, res) => {
  const gaId = Number(req.query.gaId);
  if (!gaId) return res.status(400).json({ error: 'gaId required' });
  const ga = dbm.db.users.find(u => u.id === gaId && !u.deleted && u.role === 'group_admin');
  if (!ga) return res.status(404).json({ error: 'Group Admin not found' });
  const cashLoans = dbm.db.cashLoans.filter(l => l.userId === gaId).slice().reverse().map(l => ({ ...l, type: 'cash' }));
  const itemLoans = dbm.db.itemLoans.filter(l => l.userId === gaId).slice().reverse().map(l => ({ ...l, type: 'item' }));
  res.json({ loans: [...cashLoans, ...itemLoans].sort((a, b) => b.id - a.id) });
});

r.post('/ga-loans/:id/verify', (req, res) => {
  const isCash = req.body && req.body.type === 'cash';
  const loan = isCash ? dbm.db.cashLoans.find(x => x.id === Number(req.params.id)) : dbm.db.itemLoans.find(x => x.id === Number(req.params.id));
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  if (!loan.staffLoan) return res.status(403).json({ error: 'Only staff loans can be verified here' });
  if (loan.status !== 'pending') return res.status(400).json({ error: 'Loan is not pending' });
  if (loan.userId === req.user.id) return res.status(403).json({ error: 'You cannot verify your own loan' });
  const approver = sec.getLoanApprover(loan);
  if (!approver || approver.id !== req.user.id) return res.status(403).json({ error: 'You are not the designated approver for this loan' });
  loan.status = 'verified'; loan.verifiedAt = now(); loan.verifiedBy = req.user.id; loan.updatedAt = now(); dbm.save();
  dbm.audit(req.user, 'sa.ga_loan.verified', `${isCash ? 'cash' : 'item'} loan #${loan.id}`, req);
  emailer.notifyUser(loan.userId, 'loan', 'Loan verified', `Your ${isCash ? 'cash' : 'item'} loan was verified by the Super Admin.`);
  try { hub.broadcastLoan(loan.userId, { id: loan.id, type: loan.type, status: loan.status, amountCents: loan.amountCents, dueAt: loan.dueAt }); } catch {}
  res.json({ ok: true, loan });
});
r.post('/ga-loans/:id/disburse', (req, res) => {
  const isCash = req.body && req.body.type === 'cash';
  const loan = isCash ? dbm.db.cashLoans.find(x => x.id === Number(req.params.id)) : dbm.db.itemLoans.find(x => x.id === Number(req.params.id));
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  if (loan.status !== 'verified') return res.status(400).json({ error: 'Loan must be verified first' });
  if (!sec.canDisburseLoan(req, loan)) return res.status(403).json({ error: 'You cannot disburse this loan' });
  loan.status = 'disbursed'; loan.disbursedAt = now(); loan.dueAt = isCash ? new Date(Date.now() + 14 * 86400000).toISOString() : null; loan.updatedAt = now(); dbm.save();
  dbm.audit(req.user, 'sa.ga_loan.disbursed', `${isCash ? 'cash' : 'item'} loan #${loan.id}`, req);
  emailer.notifyUser(loan.userId, 'loan', 'Loan disbursed', `Your ${isCash ? 'cash' : 'item'} loan has been disbursed.`);
  try { hub.broadcastLoan(loan.userId, { id: loan.id, type: loan.type, status: loan.status, amountCents: loan.amountCents, dueAt: loan.dueAt }); } catch {}
  res.json({ ok: true, loan });
});
r.post('/ga-loans/:id/clear', (req, res) => {
  const isCash = req.body && req.body.type === 'cash';
  const loan = isCash ? dbm.db.cashLoans.find(x => x.id === Number(req.params.id)) : dbm.db.itemLoans.find(x => x.id === Number(req.params.id));
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  if (!['disbursed', 'overdue'].includes(loan.status)) return res.status(400).json({ error: 'Loan must be disbursed or overdue to clear' });
  if (!sec.canClearLoan(req, loan)) return res.status(403).json({ error: 'You cannot clear this loan' });
  if (loan.requiresPaymentReport && !loan.repaymentReportedAt) return res.status(400).json({ error: 'Borrower must report repayment before you can verify and clear this loan' });
  const fineCents = isCash ? dbm.overdueFineCents(loan) : 0;
  loan.status = 'cleared'; loan.clearedAt = now(); loan.clearedBy = req.user.id; loan.fineCents = (loan.fineCents || 0) + fineCents; loan.updatedAt = now(); dbm.save();
  if (fineCents > 0) dbm.appendFine(loan.userId, loan.groupId, loan.id, fineCents, `fine:loan:${loan.id}`);
  dbm.markLoanFinesPaid(loan.id, req.user.id);
  dbm.audit(req.user, 'sa.ga_loan.cleared', `${isCash ? 'cash' : 'item'} loan #${loan.id}`, req);
  emailer.notifyUser(loan.userId, 'loan', 'Loan cleared', `Your ${isCash ? 'cash' : 'item'} loan has been cleared.`);
  try { hub.broadcastLoan(loan.userId, { id: loan.id, type: loan.type, status: loan.status, amountCents: loan.amountCents, dueAt: loan.dueAt, fineCents: loan.fineCents }); } catch {}
  res.json({ ok: true, loan, fineCents });
});

// ---- REPORTS: Super Admin group progress ----
r.get('/reports', (req, res) => {
  const fmt = String(req.query.format || 'pdf').toLowerCase();
  const groups = dbm.db.groups.filter(g => !g.isStaffChama);
  if (fmt === 'csv') return reports.sendSuperAdminGroupsCSV(res, groups, req);
  return reports.sendSuperAdminGroupsPDF(res, groups, req);
});
r.get('/groups/:id/report', (req, res) => {
  const g = dbm.db.groups.find(x => x.id === Number(req.params.id));
  if (!g) return res.status(404).json({ error: 'Group not found' });
  if (!sec.canExportGroup(req, g.id)) return res.status(403).json({ error: 'You cannot export reports for this group' });
  const fmt = String(req.query.format || 'pdf').toLowerCase();
  dbm.audit(req.user, 'sa.report.downloaded', `${g.name} (${fmt})`, req);
  if (fmt === 'csv') return reports.sendCSV(res, g, req);
  return reports.sendPDF(res, g, req);
});
r.get('/charts/trends', (req, res) => {
  const weeks = 12;
  const now = new Date();
  const labels = [];
  const savingsData = [];
  const loansData = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i * 7));
    const yr = d.getUTCFullYear();
    const wk = Math.ceil((((d - new Date(Date.UTC(yr, 0, 1))) / 86400000) + new Date(Date.UTC(yr, 0, 1)).getUTCDay() + 1) / 7);
    const key = `${yr}-${wk}`;
    labels.push(key);
    const sTotal = dbm.db.savings.filter(s => s.week === key && !s.reversed && (!s.status || s.status === 'verified')).reduce((n, s) => n + Number(s.amountCents || 0), 0);
    const lTotal = dbm.db.cashLoans.filter(l => l.week === key && !['rejected', 'cleared'].includes(l.status)).reduce((n, l) => n + Number(l.amountCents || 0), 0) + dbm.db.itemLoans.filter(l => l.week === key && !['rejected', 'cleared'].includes(l.status)).reduce((n, l) => n + Number(l.costCents || l.amountCents || 0), 0);
    savingsData.push(dbm.fromCents(sTotal));
    loansData.push(dbm.fromCents(lTotal));
  }
  res.json({ labels, savings: savingsData, loans: loansData });
});
r.get('/members/:id/report', (req, res) => {
  const u = dbm.db.users.find(x => x.id === Number(req.params.id) && !x.deleted && x.role === 'member');
  if (!u) return res.status(404).json({ error: 'Member not found' });
  if (!sec.canExportMember(req, u.id)) return res.status(403).json({ error: 'You cannot export reports for this member' });
  const fmt = String(req.query.format || 'pdf').toLowerCase();
  dbm.audit(req.user, 'sa.member.report.downloaded', `${u.email} (${fmt})`, req);
  if (fmt === 'csv') return reports.sendStaffMemberCSV(res, u, dbm.memberProfileFor(u.id), req);
  return reports.sendStaffMemberPDF(res, u, dbm.memberProfileFor(u.id), req);
});
r.get('/exports', (req, res) => {
  const rows = dbm.db.exports.slice(-250).reverse().map(e => ({
    id: e.id, userId: e.userId, userRole: e.userRole, type: e.type, target: e.target, format: e.format, at: e.at
  }));
  res.json({ exports: rows });
});

module.exports = r;
