'use strict';
/* GROUP ADMIN (green / red roses dashboard): manage own group's members, GENERATE SAFE CODES
 * for new members, approve/reject access requests, announcements, reset member passwords.
 * Stage 4 Finance: item price management, loan verification flow, group savings totals.
 * Group Admin is also a member of their own group with a member profile. Their own loans
 * go to the Owner (V Super Admin) for verification. */
const { Router } = require('../httpmini');
const dbm = require('../db');
const sec = require('../security');
const emailer = require('../emailer');
const seed = require('../seed');
const reports = require('../reports');
const hub = require('../hub');
const agreementCodes = require('../agreement-codes');
const agreementViews = require('../system-agreement-views');
const financeTrends = require('../finance-trends');
const { currentWeekKey } = require('../week-key');

const r = new Router();
r.use(sec.auth, sec.requireRole('group_admin'));
r.use((req, res, next) => {
  if (/^\/members(?:\/|\?|$)/.test(req.url)) {
    dbm.audit(req.user, 'ga.member_account.access.denied', 'legacy member account route', req);
    return res.status(404).json({ error: 'Not found' });
  }
  next();
});
const now = () => new Date().toISOString();
const ownerReviewEntry = entry => !!entry.staffRequest || sec.isStaffRole(dbm.db.users.find(user => user.id === entry.userId && !user.deleted));

function myGroup(req) { return dbm.db.groups.find(g => g.id === req.user.groupId) || null; }
function memberFor(req, id) { return dbm.db.users.find(u => u.id === Number(id) && !u.deleted && u.role === 'member' && u.groupId === req.user.groupId); }

// Group Admin receives only status records for this group; no member IDs or profile data.
r.get('/system-agreements', (req, res) => agreementViews.listSystemAgreements(req, res, { groupOnly: true }));

r.get('/overview', (req, res) => {
  const db = dbm.db;
  const gid = req.user.groupId;
  const memberUsers = db.users.filter(u => !u.deleted && u.groupId === gid && u.role === 'member');
  const savingsTotals = dbm.getGroupMemberSavingsTotals(gid);
  const totalGroupSavings = Object.values(savingsTotals).reduce((n, v) => n + v, 0);
  res.json({
    group: myGroup(req),
    members: dbm.getGroupParticipantCount(gid),
    lockedMembers: memberUsers.filter(m => m.locked).length,
    codesLeft: db.safeCodes.filter(c => c.groupId === gid && c.active && !c.usedBy).length,
    codesUsed: db.safeCodes.filter(c => c.groupId === gid && c.usedBy).length,
    pendingRequests: db.requests.filter(q => q.groupId === gid && q.status === 'pending').length,
    messages: db.messages.filter(m => m.recipientId === req.user.id || m.senderId === req.user.id).length,
    pendingLoans: db.cashLoans.filter(l => l.groupId === gid && l.status === 'pending').length + db.itemLoans.filter(l => l.groupId === gid && l.status === 'pending').length,
    activeLoans: db.cashLoans.filter(l => l.groupId === gid && ['disbursed', 'overdue'].includes(l.status)).length + db.itemLoans.filter(l => l.groupId === gid && ['disbursed', 'overdue'].includes(l.status)).length,
    totalGroupSavingsCents: totalGroupSavings,
    safeCodeRequired: db.settings.safe_code_required === '1'
  });
});

// Group-level financial trends only; no member names, IDs, or per-member balances are returned.
r.get('/finance-trend', (req, res) => {
  const gid = req.user.groupId;
  if (!gid) return res.json(financeTrends.buildTrend({}));
  const memberIds = new Set(dbm.db.users.filter(user => !user.deleted && user.role === 'member' && user.groupId === gid).map(user => user.id));
  const savings = dbm.db.savings.filter(entry => entry.groupId === gid && memberIds.has(entry.userId));
  const loans = dbm.db.cashLoans.filter(loan => loan.groupId === gid && memberIds.has(loan.userId)).map(loan => ({ ...loan, type: 'cash' }))
    .concat(dbm.db.itemLoans.filter(loan => loan.groupId === gid && memberIds.has(loan.userId)).map(loan => ({ ...loan, type: 'item' })));
  res.json(financeTrends.buildTrend({ savings, loans, members: memberIds.size }));
});

// ---- my members ----
r.get('/members', (req, res) => {
  const list = dbm.db.users.filter(u => !u.deleted && u.groupId === req.user.groupId && u.role === 'member').map(u => {
    const agreement = dbm.agreementFor(u.id);
    return { ...dbm.maskedUser(u), savingsCents: dbm.getUserSavingsTotal(u.id), agreementSigned: !!agreement, agreementApproved: !!(agreement && agreement.groupAdminSignedAt) };
  });
  res.json({ members: list });
});

r.get('/registration-fees', (req, res) => {
  const fees = dbm.db.registrationFees.filter(f => f.groupId === req.user.groupId && f.status === 'pending' && !f.reversed && !ownerReviewEntry(f)).map(f => ({ id: f.id, groupId: f.groupId, amountCents: f.amountCents, reportedAt: f.reportedAt, status: f.status, createdAt: f.createdAt }));
  res.json({ fees });
});

r.post('/registration-fees/:id/verify', (req, res) => {
  const fee = dbm.db.registrationFees.find(f => f.id === Number(req.params.id) && f.groupId === req.user.groupId && f.status === 'pending' && !f.reversed);
  if (!fee) return res.status(404).json({ error: 'Pending registration fee not found' });
  if (ownerReviewEntry(fee)) return res.status(403).json({ error: 'Staff member payments require Owner approval.' });
  if (fee.amountCents !== 20000) return res.status(400).json({ error: 'Registration fee amount is invalid' });
  const member = dbm.db.users.find(u => u.id === fee.userId && !u.deleted && u.groupId === req.user.groupId);
  const profile = dbm.memberProfileFor(fee.userId);
  if (!member || !profile) return res.status(404).json({ error: 'Member account not found in your group' });
  if (member.id === req.user.id) return res.status(403).json({ error: 'You cannot verify your own registration fee; the Owner must review it' });
  if (profile.registrationFeePaid) return res.status(409).json({ error: 'Registration fee is already marked paid' });
  fee.status = 'verified'; fee.verifiedAt = now(); fee.verifiedBy = req.user.id;
  profile.registrationFeePaid = true; profile.registrationFeePaidAt = fee.verifiedAt; profile.updatedAt = fee.verifiedAt;
  dbm.save(); dbm.audit(req.user, 'ga.registration_fee.verified', `${member.email} KES 200`, req);
  emailer.notifyUser(member.id, 'registration_fee', 'Registration fee verified', 'Your Group Admin confirmed receipt of your KES 200 registration fee.');
  res.json({ ok: true, fee: { id: fee.id, amountCents: fee.amountCents, status: fee.status, verifiedAt: fee.verifiedAt } });
});

r.get('/savings', (req, res) => {
  const savings = dbm.db.savings.filter(s => s.groupId === req.user.groupId && s.status === 'pending' && !s.reversed && !ownerReviewEntry(s)).map(s => ({ id: s.id, groupId: s.groupId, amountCents: s.amountCents, week: s.week, reportedAt: s.reportedAt, status: s.status, createdAt: s.createdAt }));
  res.json({ savings });
});

r.post('/savings/:id/verify', (req, res) => {
  const saving = dbm.db.savings.find(s => s.id === Number(req.params.id) && s.groupId === req.user.groupId && s.status === 'pending' && !s.reversed);
  if (!saving) return res.status(404).json({ error: 'Pending savings contribution not found' });
  if (ownerReviewEntry(saving)) return res.status(403).json({ error: 'Staff member savings require Owner approval.' });
  if (saving.userId === req.user.id) return res.status(403).json({ error: 'You cannot verify your own savings contribution' });
  const member = dbm.db.users.find(u => u.id === saving.userId && !u.deleted && u.groupId === req.user.groupId);
  if (!member) return res.status(404).json({ error: 'Member account not found in your group' });
  saving.status = 'verified'; saving.verifiedAt = now(); saving.verifiedBy = req.user.id; saving.updatedAt = saving.verifiedAt;
  dbm.save(); dbm.audit(req.user, 'ga.saving.verified', `${member.email} KES ${dbm.fromCents(saving.amountCents)}`, req);
  try { hub.broadcastSaving(member.id, saving.groupId); } catch {}
  emailer.notifyUser(member.id, 'saving', 'Savings contribution verified', `Your KES ${dbm.fromCents(saving.amountCents)} savings contribution was verified.`);
  res.json({ ok: true, saving: { id: saving.id, amountCents: saving.amountCents, status: saving.status, verifiedAt: saving.verifiedAt } });
});

// ---- member lifecycle ----
r.post('/members', (req, res) => {
  const b = req.body || {};
  const firstName = sec.clean(b.firstName, 60).trim(), lastName = sec.clean(b.lastName, 60).trim();
  const email = sec.clean(b.email, 120).trim().toLowerCase(), phone = sec.clean(b.phone, 30).trim();
  if (!myGroup(req)) return res.status(400).json({ error: 'You are not assigned to a group' });
  const memberCount = dbm.getGroupParticipantCount(req.user.groupId);
  if (memberCount >= 30) return res.status(400).json({ error: 'Your group already has the maximum 30 members' });
  if (!sec.isName(firstName) || !sec.isName(lastName) || !sec.isEmail(email) || !sec.isPhone(phone)) return res.status(400).json({ error: 'Valid name, email and phone are required' });
  if (dbm.db.users.some(u => !u.deleted && u.email === email)) return res.status(400).json({ error: 'Email already in use' });
  const temp = sec.genPassword(), ts = now();
  const u = { id: dbm.next('user'), firstName, lastName, email, phone, role: 'member', groupId: req.user.groupId, passHash: sec.hashPassword(temp), passwordChangeRequired: true, pic: null, ecdhPub: null, failed: 0, locked: false, disabled: false, deleted: false, createdAt: ts, updatedAt: ts };
  let systemAgreement;
  try { systemAgreement = agreementCodes.maybeCreateForMember(u, u.groupId); }
  catch { return res.status(503).json({ error: 'System agreement issuance is temporarily unavailable.' }); }
  dbm.db.users.push(u);
  dbm.db.memberProfiles.push({ id: dbm.next('memberProfile'), userId: u.id, groupId: req.user.groupId, registrationFeePaid: false, registrationFeePaidAt: null, agreementSigned: false, agreementSignedAt: null, weeklySavingTarget: 0, createdAt: ts, updatedAt: ts });
  if (systemAgreement) dbm.db.systemAgreements.push(systemAgreement);
  dbm.save(); dbm.audit(req.user, 'ga.member.created', email, req);
  if (systemAgreement) dbm.audit(u, 'agreement.created', `system agreement #${systemAgreement.id}`, req);
  emailer.sendEmail(email, 'Your VonDonald051 member account', `Your group admin created your account. Login: ${email}\nTemporary password: ${temp}`);
  res.status(201).json({ ok: true, member: dbm.maskedUser(u), temporaryPassword: temp });
});
r.put('/members/:id', (req, res) => {
  const u = memberFor(req, req.params.id); if (!u) return res.status(404).json({ error: 'Member not found in your group' });
  const b = req.body || {}, firstName = sec.clean(b.firstName || u.firstName, 60).trim(), lastName = sec.clean(b.lastName || u.lastName, 60).trim(), email = sec.clean(b.email || u.email, 120).trim().toLowerCase(), phone = sec.clean(b.phone || u.phone, 30).trim();
  if (!sec.isName(firstName) || !sec.isName(lastName) || !sec.isEmail(email) || !sec.isPhone(phone)) return res.status(400).json({ error: 'Valid name, email and phone are required' });
  if (dbm.db.users.some(x => !x.deleted && x.id !== u.id && x.email === email)) return res.status(400).json({ error: 'Email already in use' });
  Object.assign(u, { firstName, lastName, email, phone, updatedAt: now() }); dbm.save(); dbm.audit(req.user, 'ga.member.updated', email, req); res.json({ ok: true, member: dbm.maskedUser(u) });
});
r.post('/members/:id/agreement/approve', (req, res) => {
  const member = memberFor(req, req.params.id);
  if (!member) return res.status(404).json({ error: 'Member not found in your group' });
  const agreement = dbm.agreementFor(member.id);
  if (!agreement || !agreement.accepted) return res.status(400).json({ error: 'Member has not accepted the agreement yet' });
  if (agreement.groupAdminSignedAt) return res.status(409).json({ error: 'Agreement has already been approved' });
  agreement.groupAdminSignedBy = req.user.id; agreement.groupAdminSignedAt = now();
  dbm.save(); dbm.audit(req.user, 'ga.agreement.approved', `${member.email} agreement #${agreement.id}`, req);
  emailer.notifyUser(member.id, 'agreement', 'Agreement approved', 'Your Group Admin digitally approved your accepted chama agreement.');
  res.json({ ok: true, agreement });
});
r.get('/members/:id/agreement.pdf', (req, res) => {
  const member = memberFor(req, req.params.id);
  if (!member) return res.status(404).json({ error: 'Member not found in your group' });
  return reports.sendAgreementPDF(res, member.id, req);
});
r.post('/members/:id/toggle-disabled', (req, res) => {
  const u = memberFor(req, req.params.id); if (!u) return res.status(404).json({ error: 'Member not found in your group' });
  u.disabled = !u.disabled; u.updatedAt = now(); dbm.save(); if (u.disabled) dbm.killSessions(u.id); dbm.audit(req.user, u.disabled ? 'ga.member.suspended' : 'ga.member.activated', u.email, req); res.json({ ok: true, disabled: u.disabled });
});
r.delete('/members/:id', (req, res) => {
  const u = memberFor(req, req.params.id); if (!u) return res.status(404).json({ error: 'Member not found in your group' });
  u.deleted = true; u.deletedAt = now(); dbm.save(); dbm.killSessions(u.id); dbm.audit(req.user, 'ga.member.deleted', u.email, req); res.json({ ok: true });
});

// ---- group inventory and loan administration ----
r.get('/items', (req, res) => res.json({ items: dbm.db.items.filter(i => i.groupId === req.user.groupId && i.active !== false).map(i => ({ ...i, priceCents: i.priceCents || 0 })) }));
r.post('/items', (req, res) => {
  const body = req.body || {};
  const name = sec.clean(body.name, 100).trim(), description = sec.clean(body.description, 500).trim();
  const category = ['general', 'cap', 'tshirt'].includes(body.category) ? body.category : 'general';
  const priceCents = dbm.toCents(body.price);
  if (name.length < 2 || description.length < 2) return res.status(400).json({ error: 'Item name and description are required' });
  if (!Number.isFinite(priceCents) || priceCents <= 0 || priceCents > 100000000) return res.status(400).json({ error: 'Item price must be greater than zero and within the supported limit' });
  const item = dbm.add('items', 'item', { groupId: req.user.groupId, name, description, category, priceCents, active: true, createdBy: req.user.id, createdAt: now() });
  dbm.audit(req.user, 'ga.item.created', name, req); res.status(201).json({ ok: true, item });
});

// ---- loan verification flow: pending -> verified -> disbursed -> cleared ----
r.get('/loans', (req, res) => {
  const safe = (l, type) => ({ id: l.id, type, groupId: l.groupId, amountCents: l.amountCents, totalDueCents: l.totalDueCents, itemName: l.itemName, dueAt: l.dueAt, fineCents: l.fineCents, fineNowCents: type === 'cash' ? dbm.overdueFineCents(l) : 0, status: l.status, createdAt: l.createdAt, verifiedAt: l.verifiedAt, disbursedAt: l.disbursedAt, repaidAt: l.repaidAt });
  const groupMemberLoan = loan => loan.groupId === req.user.groupId && !sec.isStaffRole(dbm.db.users.find(user => user.id === loan.userId && !user.deleted));
  const cashLoans = dbm.db.cashLoans.filter(groupMemberLoan).slice().reverse().map(l => safe(l, 'cash'));
  const itemLoans = dbm.db.itemLoans.filter(groupMemberLoan).slice().reverse().map(l => safe(l, 'item'));
  res.json({ loans: [...cashLoans, ...itemLoans].sort((a, b) => b.id - a.id) });
});

r.post('/loans/:id/verify', (req, res) => {
  const isCash = req.body && req.body.type === 'cash';
  const loan = isCash ? dbm.db.cashLoans.find(x => x.id === Number(req.params.id)) : dbm.db.itemLoans.find(x => x.id === Number(req.params.id));
  if (!loan || loan.groupId !== req.user.groupId) return res.status(404).json({ error: 'Loan not found' });
  if (loan.status !== 'pending') return res.status(400).json({ error: 'Loan is not pending' });
  if (!sec.canVerifyLoan(req, loan)) return res.status(403).json({ error: 'You cannot verify this loan' });
  loan.status = 'verified'; loan.verifiedAt = now(); loan.verifiedBy = req.user.id; loan.updatedAt = now(); dbm.save();
  dbm.audit(req.user, 'ga.loan.verified', `${isCash ? 'cash' : 'item'} loan #${loan.id}`, req);
  emailer.notifyUser(loan.userId, 'loan', 'Loan verified', `Your ${isCash ? 'cash' : 'item'} loan was verified by your Group Admin.`);
  try { hub.broadcastLoan(loan.userId, { id: loan.id, type: loan.type, status: loan.status, amountCents: loan.amountCents, dueAt: loan.dueAt }); } catch {}
  res.json({ ok: true, loan });
});
r.post('/loans/:id/disburse', (req, res) => {
  const isCash = req.body && req.body.type === 'cash';
  const loan = isCash ? dbm.db.cashLoans.find(x => x.id === Number(req.params.id)) : dbm.db.itemLoans.find(x => x.id === Number(req.params.id));
  if (!loan || loan.groupId !== req.user.groupId) return res.status(404).json({ error: 'Loan not found' });
  if (loan.status !== 'verified') return res.status(400).json({ error: 'Loan must be verified first' });
  if (!sec.canDisburseLoan(req, loan)) return res.status(403).json({ error: 'You cannot disburse this loan' });
  loan.status = 'disbursed'; loan.disbursedAt = now(); loan.dueAt = isCash ? new Date(Date.now() + 14 * 86400000).toISOString() : null; loan.updatedAt = now(); dbm.save();
  dbm.audit(req.user, 'ga.loan.disbursed', `${isCash ? 'cash' : 'item'} loan #${loan.id}`, req);
  emailer.notifyUser(loan.userId, 'loan', 'Loan disbursed', `Your ${isCash ? 'cash' : 'item'} loan has been disbursed.`);
  try { hub.broadcastLoan(loan.userId, { id: loan.id, type: loan.type, status: loan.status, amountCents: loan.amountCents, dueAt: loan.dueAt }); } catch {}
  res.json({ ok: true, loan });
});
r.post('/loans/:id/clear', (req, res) => {
  const isCash = req.body && req.body.type === 'cash';
  const loan = isCash ? dbm.db.cashLoans.find(x => x.id === Number(req.params.id)) : dbm.db.itemLoans.find(x => x.id === Number(req.params.id));
  if (!loan || loan.groupId !== req.user.groupId) return res.status(404).json({ error: 'Loan not found' });
  if (!['disbursed', 'overdue'].includes(loan.status)) return res.status(400).json({ error: 'Loan must be disbursed or overdue to clear' });
  if (!sec.canClearLoan(req, loan)) return res.status(403).json({ error: 'You cannot clear this loan' });
  if (loan.requiresPaymentReport && !loan.repaymentReportedAt) return res.status(400).json({ error: 'Member must report repayment before you can verify and clear this loan' });
  const fineCents = isCash ? dbm.overdueFineCents(loan) : 0;
  loan.status = 'cleared'; loan.clearedAt = now(); loan.clearedBy = req.user.id; loan.fineCents = (loan.fineCents || 0) + fineCents; loan.updatedAt = now(); dbm.save();
  if (fineCents > 0) dbm.appendFine(loan.userId, loan.groupId, loan.id, fineCents, `fine:loan:${loan.id}`);
  dbm.markLoanFinesPaid(loan.id, req.user.id);
  dbm.audit(req.user, 'ga.loan.cleared', `${isCash ? 'cash' : 'item'} loan #${loan.id}`, req);
  emailer.notifyUser(loan.userId, 'loan', 'Loan cleared', `Your ${isCash ? 'cash' : 'item'} loan has been cleared.`);
  try { hub.broadcastLoan(loan.userId, { id: loan.id, type: loan.type, status: loan.status, amountCents: loan.amountCents, dueAt: loan.dueAt, fineCents: loan.fineCents }); } catch {}
  res.json({ ok: true, loan, fineCents });
});

// GA self-loans go to Owner queue
r.post('/my-loans', (req, res) => {
  const b = req.body || {}, type = b.type === 'item' ? 'item' : b.type === 'cash' ? 'cash' : null;
  if (!type) return res.status(400).json({ error: 'Choose cash or item' });
  const memberProfile = dbm.memberProfileFor(req.user.id);
  if (!memberProfile || !memberProfile.registrationFeePaid) return res.status(400).json({ error: 'Pay the KES 200 registration fee first' });
  if (!sec.isStaffRole(req.user) && !memberProfile.agreementSigned) return res.status(400).json({ error: 'Sign the Kenya Chama Agreement first' });
  if (dbm.hasUnclearedCashLoan(req.user.id)) return res.status(400).json({ error: 'You have an uncleared loan. Clear it before borrowing again.' });
  const wk = currentWeekKey();
  const idempotencyKey = b.idempotencyKey || sec.generateIdempotencyKey('ga-loan');
  if (dbm.db.cashLoans.some(l => l.userId === req.user.id && l.type === 'cash' && l.week === wk && l.status !== 'rejected') || dbm.db.itemLoans.some(l => l.userId === req.user.id && l.type === 'item' && l.week === wk && l.status !== 'rejected')) {
    return res.status(400).json({ error: `Only one ${type} loan is allowed per week` });
  }
  let itemId = null, description = '', amountCents = 0, totalDueCents = 0, profitCents = 0, costCents = 0;
  if (type === 'item') {
    itemId = Number(b.itemId) || null;
    const item = dbm.db.items.find(i => i.id === itemId && i.groupId === req.user.groupId && i.active !== false);
    if (!item) return res.status(400).json({ error: 'Choose an available group item' });
    if (!Number.isSafeInteger(item.priceCents) || item.priceCents <= 0) return res.status(400).json({ error: 'This item needs a valid price set by the Group Admin' });
    if (dbm.db.itemLoans.some(loan => loan.userId === req.user.id && loan.itemId === itemId && !['cleared', 'rejected'].includes(loan.status))) return res.status(409).json({ error: 'You already have an outstanding loan for this item' });
    description = item.name; costCents = item.priceCents || 0;
  } else {
    amountCents = dbm.toCents(b.amount);
    if (!Number.isFinite(amountCents) || amountCents <= 0 || amountCents > 100000000) return res.status(400).json({ error: 'Enter a valid cash amount' });
    const limitCents = Math.floor(dbm.getUserSavingsTotal(req.user.id) * 0.5);
    if (amountCents > limitCents) return res.status(400).json({ error: `Loan amount cannot exceed 50% of your savings (${dbm.centsToDisplay(limitCents)})` });
    totalDueCents = amountCents;
  }
  const loan = {
    id: dbm.next(type === 'cash' ? 'cashLoan' : 'itemLoan'), userId: req.user.id, groupId: req.user.groupId,
    type, itemId, itemName: description, itemDescription: '', amountCents, totalDueCents, profitCents, costCents,
    week: wk, status: 'pending', dueAt: null,
    verifiedAt: null, verifiedBy: null, disbursedAt: null, clearedAt: null, clearedBy: null,
    fineCents: 0, idempotencyKey, staffLoan: true,
    requiresPaymentReport: true, repaymentReportedAt: null, repaymentReportedBy: null, repaymentReportedCents: null,
    createdAt: now(), updatedAt: now()
  };
  if (type === 'cash') dbm.db.cashLoans.push(loan); else dbm.db.itemLoans.push(loan);
  dbm.save(); dbm.audit(req.user, `ga.self_${type}_loan.requested`, `${type} loan #${loan.id}`, req);
  const owner = dbm.db.users.find(u => u.role === 'v_super_admin' && !u.deleted);
  if (owner) {
    emailer.notifyUser(owner.id, 'loan', 'Staff loan request', `Group Admin ${req.user.firstName} ${req.user.lastName} requested a ${type} loan (${dbm.centsToDisplay(amountCents || costCents)}). Requires Owner approval.`);
    emailer.emailVSA('Staff loan request', `Group Admin ${req.user.email} requested a ${type} loan (${dbm.centsToDisplay(amountCents || costCents)}). Approve from Owner Loan Queue.`);
  }
  res.status(201).json({ ok: true, loan });
});

// ---- reset a member's password ----
r.post('/members/:id/reset-password', (req, res) => {
  const t = dbm.db.users.find(u => u.id === Number(req.params.id) && !u.deleted);
  if (!t || t.role !== 'member' || t.groupId !== req.user.groupId) return res.status(404).json({ error: 'Member not found in your group' });
  const temp = sec.genPassword();
  t.passHash = sec.hashPassword(temp); t.passwordChangeRequired = true; t.failed = 0; t.locked = false; t.updatedAt = now();
  dbm.save(); dbm.killSessions(t.id);
  dbm.audit(req.user, 'ga.member.password.reset', t.email, req);
  emailer.notifyUser(t.id, 'security', 'Your password was reset', `Your group admin reset your password at ${now()}.`);
  emailer.emailVSA('Member password reset by Group Admin', `${req.user.email} reset the password of member ${t.email}.`);
  res.json({ ok: true, temporaryPassword: temp });
});

// ---- GENERATE SAFE CODES ----
r.post('/safe-codes', sec.limiter(60e3, 30), (req, res) => {
  if (!req.user.groupId) return res.status(400).json({ error: 'You are not assigned to a group' });
  const count = Math.min(Math.max(Number((req.body || {}).count) || 1, 1), 10);
  const made = [];
  for (let i = 0; i < count; i++) { const code = seed.genCode(); dbm.db.safeCodes.push({ id: dbm.next('safeCode'), code, groupId: req.user.groupId, generatedBy: req.user.id, usedBy: null, usedAt: null, active: true, createdAt: now() }); made.push(code); }
  dbm.save(); dbm.audit(req.user, 'ga.safecode.generated', made.join(','), req);
  emailer.emailVSA('Safe code(s) generated', `Group admin ${req.user.email} generated ${made.length} safe code(s) for "${(myGroup(req) || {}).name || 'their group'}":\n${made.join('\n')}`);
  res.status(201).json({ ok: true, codes: made });
});
r.get('/safe-codes', (req, res) => {
  const rows = dbm.db.safeCodes.filter(c => c.groupId === req.user.groupId).slice(-200).reverse().map(c => ({ id: c.id, code: c.code, used: !!c.usedBy, active: !!c.active, createdAt: c.createdAt, usedAt: c.usedAt }));
  res.json({ codes: rows });
});
r.delete('/safe-codes/:id', (req, res) => {
  const c = dbm.db.safeCodes.find(x => x.id === Number(req.params.id));
  if (!c || c.groupId !== req.user.groupId) return res.status(404).json({ error: 'Code not found' });
  if (c.usedBy) return res.status(400).json({ error: 'Cannot revoke a code that was already used' });
  c.active = false; dbm.save(); dbm.audit(req.user, 'ga.safecode.revoked', c.code, req); res.json({ ok: true });
});

// ---- access requests ----
r.get('/requests', (req, res) => { res.json({ requests: dbm.db.requests.filter(q => q.groupId === req.user.groupId).slice(-200).reverse() }); });
r.post('/requests/:id/approve', (req, res) => {
  const q = dbm.db.requests.find(x => x.id === Number(req.params.id) && x.groupId === req.user.groupId);
  if (!q) return res.status(404).json({ error: 'Request not found' });
  if (q.status !== 'pending') return res.status(400).json({ error: 'Request already handled' });
  const code = seed.genCode();
  dbm.db.safeCodes.push({ id: dbm.next('safeCode'), code, groupId: req.user.groupId, generatedBy: req.user.id, usedBy: null, usedAt: null, active: true, createdAt: now() });
  q.status = 'approved'; q.codeIssued = code; q.handledAt = now(); q.handledBy = req.user.id; dbm.save();
  dbm.audit(req.user, 'ga.request.approved', q.email, req);
  const gName = (myGroup(req) || {}).name || 'your group';
  emailer.sendEmail(q.email, 'Your safe code - VonDonald051 Savings', `Hello ${q.firstName},\n\nYour request to join "${gName}" was approved.\n\nYour SAFE CODE: ${code}\n\nUse it once on the Register page.`);
  emailer.emailVSA('Access request approved', `${req.user.email} approved ${q.email} and issued safe code ${code} for "${gName}".`);
  res.json({ ok: true, code });
});
r.post('/requests/:id/reject', (req, res) => {
  const q = dbm.db.requests.find(x => x.id === Number(req.params.id) && x.groupId === req.user.groupId);
  if (!q) return res.status(404).json({ error: 'Request not found' });
  if (q.status !== 'pending') return res.status(400).json({ error: 'Request already handled' });
  q.status = 'rejected'; q.handledAt = now(); q.handledBy = req.user.id; dbm.save();
  dbm.audit(req.user, 'ga.request.rejected', q.email, req);
  emailer.emailVSA('Access request rejected', `${req.user.email} rejected the request of ${q.email}.`);
  res.json({ ok: true });
});

// ---- announcements ----
r.post('/announce', sec.limiter(60e3, 20), (req, res) => {
  const title = sec.clean((req.body || {}).title, 100).trim();
  const body = sec.clean((req.body || {}).body, 1000);
  if (title.length < 3 || body.length < 3) return res.status(400).json({ error: 'Title and message required (3+ chars)' });
  const members = dbm.db.users.filter(u => !u.deleted && u.role === 'member' && u.groupId === req.user.groupId);
  for (const m of members) emailer.notifyUser(m.id, 'announcement', title, body + `\n\n— ${req.user.firstName} ${req.user.lastName} (Group Admin)`);
  dbm.audit(req.user, 'ga.announcement', title, req);
  res.json({ ok: true, delivered: members.length });
});

// ---- exports ----
r.get('/reports', (req, res) => {
  const g = myGroup(req);
  if (!g) return res.status(400).json({ error: 'You are not assigned to a group' });
  const fmt = String(req.query.format || 'pdf').toLowerCase();
  if (!sec.canExportGroup(req, g.id)) return res.status(403).json({ error: 'You cannot export reports for this group' });
  dbm.audit(req.user, 'ga.report.downloaded', `${g.name} (${fmt})`, req);
  if (fmt === 'csv') return reports.sendCSV(res, g, req);
  return reports.sendPDF(res, g, req);
});
r.get('/members/:id/report', (req, res) => {
  const u = memberFor(req, req.params.id);
  if (!u) return res.status(404).json({ error: 'Member not found in your group' });
  if (!sec.canExportMember(req, u.id)) return res.status(403).json({ error: 'You cannot export reports for this member' });
  const fmt = String(req.query.format || 'pdf').toLowerCase();
  dbm.audit(req.user, 'ga.member.report.downloaded', `${u.email} (${fmt})`, req);
  if (fmt === 'csv') return reports.sendStaffMemberCSV(res, u, dbm.memberProfileFor(u.id), req);
  return reports.sendStaffMemberPDF(res, u, dbm.memberProfileFor(u.id), req);
});

module.exports = r;
