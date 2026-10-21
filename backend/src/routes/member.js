'use strict';
/* MEMBER (blue / Kenya notes dashboard): own group info, group admin contact, announcements feed.
 * Stage 4 Finance: loan request with cents, repayment, savings, registration fee. */
const { Router } = require('../httpmini');
const dbm = require('../db');
const sec = require('../security');
const hub = require('../hub');
const emailer = require('../emailer');

const r = new Router();
r.use(sec.auth, sec.requireRole('member', 'admin', 'super_admin', 'group_admin'));
const now = () => new Date().toISOString();
const weekKey = () => { const d = new Date(); const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)); return `${d.getUTCFullYear()}-${Math.ceil((((d - start) / 86400000) + start.getUTCDay() + 1) / 7)}`; };

r.get('/overview', (req, res) => {
  const db = dbm.db;
  const group = db.groups.find(g => g.id === req.user.groupId);
  const ga = db.users.find(u => !u.deleted && u.role === 'group_admin' && u.groupId === req.user.groupId);
  const msgs = db.messages.filter(m => m.senderId === req.user.id || m.recipientId === req.user.id).length;
  const announcements = dbm.visibleNotifications(req.user).filter(n => n.type === 'announcement').length;
  const savingsTotal = dbm.getUserSavingsTotal(req.user.id);
  const activeLoans = db.cashLoans.filter(l => l.userId === req.user.id && ['disbursed', 'overdue'].includes(l.status)).length + db.itemLoans.filter(l => l.userId === req.user.id && ['disbursed', 'overdue'].includes(l.status)).length;
  const kit = ['cap', 'tshirt'].map(category => {
    const items = db.items.filter(item => item.groupId === req.user.groupId && item.category === category && item.active !== false).map(item => {
      const loan = db.itemLoans.find(entry => entry.userId === req.user.id && entry.itemId === item.id && !['rejected'].includes(entry.status));
      return { itemId: item.id, name: item.name, description: item.description, priceCents: item.priceCents, status: loan ? loan.status : 'available' };
    });
    return { category, items };
  });
  res.json({
    me: dbm.safeUser(req.user),
    group,
    groupAdmin: ga ? { id: ga.id, name: ga.firstName + ' ' + ga.lastName, email: ga.email, phone: ga.phone, pic: ga.pic } : null,
    stats: { messages: msgs, announcements, joined: req.user.createdAt, activeLoans, savingsTotalCents: savingsTotal },
    kit
  });
});

r.get('/items', (req, res) => res.json({ items: dbm.db.items.filter(i => i.groupId === req.user.groupId && i.active !== false).map(i => ({ ...i, priceCents: i.priceCents || 0 })) }));

r.get('/loans', (req, res) => {
  const cashLoans = dbm.db.cashLoans.filter(l => l.userId === req.user.id).slice().reverse().map(l => ({ ...l, type: 'cash', fineNowCents: dbm.overdueFineCents(l) }));
  const itemLoans = dbm.db.itemLoans.filter(l => l.userId === req.user.id).slice().reverse().map(l => ({ ...l, type: 'item' }));
  res.json({ loans: [...cashLoans, ...itemLoans].sort((a, b) => b.id - a.id) });
});

// Member loan request
r.post('/loans', (req, res) => {
  const mp = dbm.memberProfileFor(req.user.id);
  if (!mp) return res.status(400).json({ error: 'Member profile not found' });
  if (!mp.registrationFeePaid) return res.status(400).json({ error: 'Pay the KES 200 registration fee first' });
  if (!sec.isStaffRole(req.user) && !mp.agreementSigned) return res.status(400).json({ error: 'Sign the Kenya Chama Agreement first' });
  if (dbm.hasUnclearedCashLoan(req.user.id)) return res.status(400).json({ error: 'You have an uncleared loan. Clear it before borrowing again.' });

  const b = req.body || {}, type = b.type === 'item' ? 'item' : b.type === 'cash' ? 'cash' : null;
  if (!req.user.groupId) return res.status(400).json({ error: 'You are not assigned to a group' });
  if (!type) return res.status(400).json({ error: 'Loan type must be cash or item' });

  const wk = weekKey();
  const idempotencyKey = b.idempotencyKey || sec.generateIdempotencyKey('member-loan');
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
    // 50% of savings cap
    const savings = dbm.getUserSavingsTotal(req.user.id);
    if (amountCents > Math.floor(savings * 0.5)) return res.status(400).json({ error: `Loan amount cannot exceed 50% of your savings (${dbm.centsToDisplay(Math.floor(savings * 0.5))})` });
    totalDueCents = amountCents;
  }

  const loan = {
    id: dbm.next(type === 'cash' ? 'cashLoan' : 'itemLoan'), userId: req.user.id, groupId: req.user.groupId,
    type, itemId, itemName: description, itemDescription: '', amountCents, totalDueCents, profitCents, costCents,
    week: wk, status: 'pending',
    dueAt: null,
    verifiedAt: null, verifiedBy: null, disbursedAt: null, clearedAt: null, clearedBy: null,
    fineCents: 0, idempotencyKey, staffLoan: sec.isStaffRole(req.user),
    requiresPaymentReport: true, repaymentReportedAt: null, repaymentReportedBy: null, repaymentReportedCents: null,
    createdAt: now(), updatedAt: now()
  };
  if (type === 'cash') dbm.db.cashLoans.push(loan); else dbm.db.itemLoans.push(loan);
  dbm.save(); dbm.audit(req.user, 'member.loan.requested', `${type} loan #${loan.id}`, req);
  try { hub.broadcastLoan(req.user.id, { id: loan.id, type: loan.type, status: loan.status, amountCents: loan.amountCents, dueAt: loan.dueAt }); } catch {}
  if (loan.staffLoan) {
    const owner = dbm.db.users.find(user => user.role === 'v_super_admin' && !user.deleted);
    if (owner) emailer.notifyUser(owner.id, 'loan', 'Staff loan request', `${req.user.firstName} ${req.user.lastName} (${req.user.role}) requested a ${type} loan. Review it in Owner Loan Queue.`);
    emailer.emailVSA('Staff member loan request', `${req.user.firstName} ${req.user.lastName} (${req.user.role}) requested a ${type} loan (${dbm.centsToDisplay(amountCents || costCents)}).`);
  } else {
    const admins = dbm.db.users.filter(u => !u.deleted && u.role === 'group_admin' && u.groupId === req.user.groupId);
    for (const a of admins) emailer.notifyUser(a.id, 'loan', 'New loan request', `A ${type} loan request needs review in your group's loan queue.`);
  }
  res.status(201).json({ ok: true, loan });
});

// Member repayment
r.post('/loans/:id/repay', (req, res) => {
  const isCash = req.body && req.body.type === 'cash';
  const loan = isCash ? dbm.db.cashLoans.find(x => x.id === Number(req.params.id)) : dbm.db.itemLoans.find(x => x.id === Number(req.params.id));
  if (!loan || loan.userId !== req.user.id) return res.status(404).json({ error: 'Loan not found' });
  if (!sec.canRepayLoan(req, loan)) return res.status(403).json({ error: 'You cannot repay this loan' });
  if (loan.repaymentReportedAt) return res.status(409).json({ error: 'Repayment is already awaiting verification' });
  const fineCents = isCash ? dbm.overdueFineCents(loan) : 0;
  if (fineCents > 0) {
    dbm.appendFine(loan.userId, loan.groupId, loan.id, fineCents, `fine:loan:${loan.id}`);
    loan.fineCents = (loan.fineCents || 0) + fineCents;
  }
  loan.repaymentReportedAt = now(); loan.repaymentReportedBy = req.user.id;
  loan.repaymentReportedCents = Number(loan.totalDueCents || loan.costCents || loan.amountCents || 0) + fineCents;
  loan.updatedAt = now(); dbm.save();
  dbm.audit(req.user, 'member.loan.repaid', `${isCash ? 'cash' : 'item'} loan #${loan.id}`, req);
  try { hub.broadcastLoan(req.user.id, { id: loan.id, type: loan.type, status: loan.status, repaymentReportedAt: loan.repaymentReportedAt }); } catch {}
  const approver = sec.getLoanApprover(loan);
  if (approver) emailer.notifyUser(approver.id, 'loan', 'Loan repayment', `A ${isCash ? 'cash' : 'item'} loan repayment needs review in your group's loan queue.`);
  res.json({ ok: true, loan, fineCents });
});

module.exports = r;
