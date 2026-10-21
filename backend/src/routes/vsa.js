'use strict';
/* V SUPER ADMIN (Owner): full control.
 * Stage 4 Finance: Owner Loan Queue for ALL staff (SA/GA), item loan verification for staff,
 * Staff Chama item prices, staff member profile exports. */
const { Router } = require('../httpmini');
const dbm = require('../db');
const sec = require('../security');
const emailer = require('../emailer');
const reports = require('../reports');
const seed = require('../seed');
const hub = require('../hub');
const agreementViews = require('../system-agreement-views');
const dashboardData = require('../weekly-dashboard-trend');

const r = new Router();
r.use(sec.auth, sec.requireRole('v_super_admin'));
r.use((req, res, next) => {
  if (/^\/agreement\/(?:sign|upload)(?:\?|$)/.test(req.url)) {
    return res.status(410).json({ error: 'The legacy agreement flow is retired. Use the current system agreement endpoints.' });
  }
  next();
});
const now = () => new Date().toISOString();

// Owner may inspect agreement status metadata only; member files and profile snapshots remain private.
r.get('/system-agreements', (req, res) => agreementViews.listSystemAgreements(req, res));

const targetUser = (req) => dbm.db.users.find(u => u.id === Number(req.params.id) && !u.deleted);
const groupSummary = (g) => {
  const db = dbm.db;
  const members = db.users.filter(u => !u.deleted && ['member', 'group_admin'].includes(u.role) && u.groupId === g.id);
  const loans = db.cashLoans.filter(l => l.groupId === g.id).concat(db.itemLoans.filter(l => l.groupId === g.id));
  return {
    ...g,
    members: members.length,
    savingsCents: dbm.getGroupSavingsTotal(g.id),
    admins: db.users.filter(u => !u.deleted && u.role === 'group_admin' && u.groupId === g.id).length,
    pendingLoanRequests: loans.filter(l => l.status === 'pending').length,
    activeLoans: loans.filter(l => l.status === 'disbursed' || l.status === 'overdue').length,
    finesPaid: db.fines.filter(f => f.groupId === g.id && f.paid).reduce((n, f) => n + Number(f.amountCents || 0), 0),
    itemsBorrowed: db.itemLoans.filter(l => l.groupId === g.id && ['disbursed', 'overdue', 'cleared'].includes(l.status)).length,
    cashLoaned: db.cashLoans.filter(l => l.groupId === g.id && ['disbursed', 'overdue', 'cleared'].includes(l.status)).reduce((n, l) => n + Number(l.amountCents || 0), 0)
  };
};

// ---- overview ----
r.get('/overview', (req, res) => {
  const db = dbm.db;
  const owner = db.users.find(u => u.role === 'v_super_admin' && !u.deleted);
  if (!owner) {
    console.error('[vsa] /overview denied: no active Owner account');
    return res.status(404).json({ error: 'Owner account not found' });
  }
  const live = db.users.filter(u => !u.deleted);
  const pendingStaffLoans = db.cashLoans.filter(l => l.staffLoan && l.status === 'pending').length + db.itemLoans.filter(l => l.staffLoan && l.status === 'pending').length;
  res.json({
    users: { v_super_admin: live.filter(u => u.role === 'v_super_admin').length, super_admin: live.filter(u => u.role === 'super_admin').length, admin: live.filter(u => u.role === 'admin').length, group_admin: live.filter(u => u.role === 'group_admin').length, member: live.filter(u => u.role === 'member').length },
    groups: db.groups.filter(g => !g.isStaffChama).length,
    safeCodes: { active: db.safeCodes.filter(c => c.active && !c.usedBy).length, used: db.safeCodes.filter(c => c.usedBy).length },
    locked: live.filter(u => u.locked).length,
    disabled: live.filter(u => u.disabled).length,
    pendingRequests: db.requests.filter(q => q.status === 'pending').length,
    messages: db.messages.length,
    safeCodeRequired: db.settings.safe_code_required === '1',
    securityMonitorActive: true,
    failedLoginIpThreshold: 4,
    teamsAlertsConfigured: !!process.env.TEAMS_WEBHOOK_URL,
    aiAlertsConfigured: !!process.env.AI_API_KEY && !!process.env.AI_API_URL,
    auditEvents: db.audit.length,
    pendingStaffLoans,
  });
});

// ---- list users ----
r.get('/users', (req, res) => {
  const role = ['v_super_admin', 'super_admin', 'admin', 'group_admin', 'member'].includes(req.query.role) ? req.query.role : null;
  let list = dbm.db.users.filter(u => !u.deleted);
  if (role) list = list.filter(u => u.role === role);
  res.json({ users: list.map(dbm.maskedUser) });
});

// ---- create capped Super Admin / read-only Admin accounts ----
r.post('/users', (req, res) => {
  const b = req.body || {};
  const role = ['super_admin', 'admin'].includes(b.role) ? b.role : null;
  const firstName = sec.clean(b.firstName, 60).trim();
  const lastName = sec.clean(b.lastName, 60).trim();
  const email = sec.clean(b.email, 120).trim().toLowerCase();
  const phone = sec.clean(b.phone, 30).trim();
  const password = String(b.password || '');
  const confirm = String(b.confirmPassword || '');
  const groupId = null;
  const errors = {};
  if (!role) errors.role = 'Role must be super_admin or admin';
  if (role && dbm.db.users.filter(u => !u.deleted && u.role === role).length >= 2) errors.role = `The system supports at most two ${role === 'admin' ? 'Admin' : 'Super Admin'} accounts`;
  if (!sec.isName(firstName)) errors.firstName = 'Valid first name required';
  if (!sec.isName(lastName)) errors.lastName = 'Valid last name required';
  if (!sec.isEmail(email)) errors.email = 'Valid email required';
  else if (dbm.db.users.some(u => u.email === email && !u.deleted)) errors.email = 'Email already in use';
  if (!sec.isPhone(phone)) errors.phone = 'Valid phone required';
  const pwIssues = sec.passwordIssues(password);
  if (pwIssues.length) errors.password = 'Password needs ' + pwIssues.join(', ');
  if (password !== confirm) errors.confirmPassword = 'Passwords do not match';
  if (Object.keys(errors).length) return res.status(400).json({ errors });

  const ts = now();
  const staffGroup = dbm.staffChamaGroup();
  const memberGroupId = staffGroup ? staffGroup.id : null;
  const u = { id: dbm.next('user'), firstName, lastName, email, phone, role, groupId: memberGroupId, passHash: sec.hashPassword(password), passwordChangeRequired: true, pic: null, ecdhPub: null, failed: 0, locked: false, disabled: false, deleted: false, createdAt: ts, updatedAt: ts };
  dbm.db.users.push(u);
  dbm.db.memberProfiles.push({ id: dbm.next('memberProfile'), userId: u.id, groupId: memberGroupId, registrationFeePaid: false, registrationFeePaidAt: null, agreementSigned: false, agreementSignedAt: null, weeklySavingTarget: 0, createdAt: ts, updatedAt: ts });
  dbm.save();
  dbm.audit(req.user, 'vsa.user.created', `${role} ${email}`, req);
  emailer.emailVSA('Admin account created', `${req.user.email} created ${role} account ${email} at ${ts}.`);
  emailer.sendEmail(email, 'Your VonDonald051 admin account', `An administrator account was created for you.\nLogin: ${email}\nTemporary password: ${password}\nChange it after first login.`);
  res.status(201).json({ ok: true, user: dbm.maskedUser(u), temporaryPassword: password });
});

// ---- edit user ----
r.put('/users/:id', (req, res) => {
  const t = targetUser(req);
  if (!t) return res.status(404).json({ error: 'User not found' });
  if (t.id === req.user.id) return res.status(400).json({ error: 'Use the Profile tab to edit your own account' });
  if (t.role === 'v_super_admin') return res.status(403).json({ error: 'Owner accounts cannot be edited here' });
  if (!sec.reauthOK(req)) return res.status(403).json({ error: 'Re-authentication failed: wrong V Super Admin password' });
  const previousRole = t.role, previousGroupId = t.groupId || null;
  const b = req.body || {};
  const firstName = sec.clean(b.firstName || t.firstName, 60).trim();
  const lastName = sec.clean(b.lastName || t.lastName, 60).trim();
  const email = sec.clean(b.email || t.email, 120).trim().toLowerCase();
  const phone = sec.clean(b.phone || t.phone, 30).trim();
  if (!sec.isName(firstName) || !sec.isName(lastName)) return res.status(400).json({ error: 'Invalid name' });
  if (!sec.isEmail(email)) return res.status(400).json({ error: 'Invalid email' });
  if (dbm.db.users.some(u => u.email === email && u.id !== t.id && !u.deleted)) return res.status(400).json({ error: 'Email already in use' });
  if (!sec.isPhone(phone)) return res.status(400).json({ error: 'Invalid phone' });
  if (['group_admin', 'member'].includes(t.role) && b.groupId !== undefined) {
    const gid = Number(b.groupId) || null;
    const group = gid && dbm.db.groups.find(g => g.id === gid && !g.isStaffChama && !g.suspended);
    if (gid && !group) return res.status(400).json({ error: 'Choose an active savings group' });
    if (gid && dbm.getGroupParticipantCount(gid) - (t.groupId === gid ? 1 : 0) >= 30) return res.status(400).json({ error: 'This group has reached its 30-member limit' });
    t.groupId = gid;
    const mp = dbm.memberProfileFor(t.id);
    if (mp) { mp.groupId = gid; mp.updatedAt = now(); }
  }
  t.firstName = firstName; t.lastName = lastName; t.email = email; t.phone = phone; t.updatedAt = now();
  dbm.save();
  if (previousRole !== t.role || previousGroupId !== (t.groupId || null)) hub.revokeUser(t.id);
  dbm.audit(req.user, 'vsa.user.updated', email, req);
  res.json({ ok: true, user: dbm.maskedUser(t) });
});

// ---- delete user ----
r.delete('/users/:id', (req, res) => {
  const t = targetUser(req);
  if (!t) return res.status(404).json({ error: 'User not found' });
  if (t.role === 'v_super_admin' || t.id === req.user.id) return res.status(403).json({ error: 'Owner accounts cannot be deleted here' });
  if (!sec.reauthOK(req)) return res.status(403).json({ error: 'Re-authentication failed: wrong V Super Admin password' });
  t.deleted = true; t.deletedAt = now(); dbm.save(); dbm.killSessions(t.id);
  dbm.audit(req.user, 'vsa.user.deleted', `${t.role} ${t.email}`, req);
  emailer.emailVSA('Admin account deleted', `${req.user.email} deleted ${t.role} account ${t.email} at ${now()}.`);
  res.json({ ok: true });
});

// ---- reset password ----
r.post('/users/:id/reset-password', (req, res) => {
  const t = targetUser(req);
  if (!t) return res.status(404).json({ error: 'User not found' });
  if (!sec.reauthOK(req)) return res.status(403).json({ error: 'Re-authentication failed: wrong V Super Admin password' });
  const temp = sec.genPassword();
  t.passHash = sec.hashPassword(temp); t.passwordChangeRequired = true; t.failed = 0; t.locked = false; t.updatedAt = now();
  dbm.save(); dbm.killSessions(t.id);
  dbm.audit(req.user, 'vsa.password.reset', `${t.role} ${t.email}`, req);
  emailer.notifyUser(t.id, 'security', 'Your password was reset', `The V Super Admin reset your password at ${now()}. Log in and change it immediately.`);
  emailer.sendEmail(t.email, 'Your password was reset', `Temporary password: ${temp}\nChange it after logging in.`);
  emailer.emailVSA('Password reset performed', `${req.user.email} reset the password of ${t.role} ${t.email} at ${now()}.`);
  res.json({ ok: true, temporaryPassword: temp });
});

// ---- unlock ----
r.post('/users/:id/unlock', (req, res) => {
  const t = targetUser(req);
  if (!t) return res.status(404).json({ error: 'User not found' });
  t.locked = false; t.failed = 0; t.updatedAt = now(); dbm.save();
  dbm.audit(req.user, 'vsa.account.unlocked', t.email, req);
  emailer.notifyUser(t.id, 'security', 'Your account was re-enabled', `Your account was unlocked by the V Super Admin at ${now()}.`);
  emailer.emailVSA('Account unlocked', `${req.user.email} unlocked ${t.email}.`);
  res.json({ ok: true });
});

// ---- toggle disabled ----
r.post('/users/:id/toggle-disabled', (req, res) => {
  const t = targetUser(req);
  if (!t) return res.status(404).json({ error: 'User not found' });
  if (t.id === req.user.id) return res.status(400).json({ error: 'You cannot disable your own account' });
  if (t.role === 'v_super_admin') return res.status(403).json({ error: 'Cannot disable a V Super Admin' });
  if (!sec.reauthOK(req)) return res.status(403).json({ error: 'Re-authentication failed: wrong V Super Admin password' });
  t.disabled = !t.disabled; t.updatedAt = now(); dbm.save();
  if (t.disabled) dbm.killSessions(t.id);
  dbm.audit(req.user, t.disabled ? 'vsa.account.disabled' : 'vsa.account.enabled', t.email, req);
  emailer.emailVSA(`Account ${t.disabled ? 'disabled' : 'enabled'}`, `${req.user.email} ${t.disabled ? 'disabled' : 'enabled'} ${t.email} at ${now()}.`);
  res.json({ ok: true, disabled: t.disabled });
});

r.get('/financial-verifications', (req, res) => {
  const pendingSavings = dbm.db.savings.filter(s => s.status === 'pending' && !s.reversed).map(entry => ({
    id: entry.id, kind: 'saving', userId: entry.userId, groupId: entry.groupId,
    amountCents: entry.amountCents, week: entry.week, reportedAt: entry.reportedAt,
    staffRequest: !!entry.staffRequest || sec.isStaffRole(dbm.db.users.find(user => user.id === entry.userId && !user.deleted)),
    submittedRole: entry.submittedRole || ((dbm.db.users.find(user => user.id === entry.userId && !user.deleted) || {}).role || 'member'),
    member: dbm.maskedUser(dbm.db.users.find(u => u.id === entry.userId && !u.deleted)),
    group: (dbm.db.groups.find(g => g.id === entry.groupId) || {}).name || '-'
  }));
  const pendingFees = dbm.db.registrationFees.filter(f => f.status === 'pending' && !f.reversed).map(entry => ({
    id: entry.id, kind: 'registration_fee', userId: entry.userId, groupId: entry.groupId,
    amountCents: entry.amountCents, reportedAt: entry.reportedAt,
    staffRequest: !!entry.staffRequest || sec.isStaffRole(dbm.db.users.find(user => user.id === entry.userId && !user.deleted)),
    submittedRole: entry.submittedRole || ((dbm.db.users.find(user => user.id === entry.userId && !user.deleted) || {}).role || 'member'),
    member: dbm.maskedUser(dbm.db.users.find(u => u.id === entry.userId && !u.deleted)),
    group: (dbm.db.groups.find(g => g.id === entry.groupId) || {}).name || '-'
  }));
  res.json({ verifications: [...pendingFees, ...pendingSavings].sort((a, b) => String(b.reportedAt).localeCompare(String(a.reportedAt))) });
});

r.post('/financial-verifications/:kind/:id/verify', (req, res) => {
  const kind = req.params.kind;
  if (!['saving', 'registration_fee'].includes(kind)) return res.status(404).json({ error: 'Verification type not found' });
  const collection = kind === 'saving' ? dbm.db.savings : dbm.db.registrationFees;
  const entry = collection.find(record => record.id === Number(req.params.id) && record.status === 'pending' && !record.reversed);
  if (!entry) return res.status(404).json({ error: 'Pending payment report not found' });
  if (kind === 'registration_fee' && entry.amountCents !== 20000) return res.status(400).json({ error: 'Registration fee amount is invalid' });
  const member = dbm.db.users.find(u => u.id === entry.userId && !u.deleted);
  const profile = dbm.memberProfileFor(entry.userId);
  if (!member || !profile) return res.status(404).json({ error: 'Member account not found' });
  if (kind === 'registration_fee' && profile.registrationFeePaid) return res.status(409).json({ error: 'Registration fee is already marked paid' });

  entry.status = 'verified'; entry.verifiedAt = now(); entry.verifiedBy = req.user.id; entry.updatedAt = entry.verifiedAt;
  if (kind === 'registration_fee') {
    profile.registrationFeePaid = true; profile.registrationFeePaidAt = entry.verifiedAt; profile.updatedAt = entry.verifiedAt;
  }
  dbm.save(); dbm.audit(req.user, `owner.${kind}.verified`, `${member.email} KES ${dbm.fromCents(entry.amountCents)}`, req);
  emailer.notifyUser(member.id, kind, kind === 'saving' ? 'Savings contribution verified' : 'Registration fee verified', kind === 'saving' ? `Your KES ${dbm.fromCents(entry.amountCents)} savings contribution was verified.` : 'Your Group Admin or Owner confirmed receipt of your KES 200 registration fee.');
  res.json({ ok: true, entry });
});

// ---- diagnostic: owner account state (VSA only) ----
r.get('/debug/owner', (req, res) => {
  const owner = dbm.db.users.find(u => u.role === 'v_super_admin');
  const activeOwner = owner && !owner.deleted;
  res.json({
    ownerFound: !!owner,
    ownerActive: activeOwner,
    ownerId: owner ? owner.id : null,
    ownerEmail: owner ? owner.email : null,
    ownerDeleted: owner ? owner.deleted : null,
    ownerLocked: owner ? owner.locked : null,
    ownerDisabled: owner ? owner.disabled : null,
    totalUsers: dbm.db.users.length,
    activeUsers: dbm.db.users.filter(u => !u.deleted).length,
    settings: dbm.db.settings
  });
});

// ---- public health check (no auth) ----
const rHealth = new Router();
rHealth.get('/health', (req, res) => res.json({ ok: true }));
module.exports = r;
module.exports.genCode = seed.genCode;
module.exports.rHealth = rHealth;

// ---- settings ----
r.put('/settings', (req, res) => {
  const v = (req.body || {}).safe_code_required;
  if (!['0', '1'].includes(String(v))) return res.status(400).json({ error: 'safe_code_required must be 0 or 1' });
  dbm.db.settings.safe_code_required = String(v);
  dbm.save(); dbm.audit(req.user, 'vsa.settings.safecode', String(v), req);
  emailer.emailVSA('Safe code setting changed', `Safe code requirement at registration is now ${v === '1' ? 'ON' : 'OFF'} (changed by ${req.user.email}).`);
  res.json({ ok: true, safeCodeRequired: v === '1' });
});

// ---- groups ----
r.get('/groups', (req, res) => { res.json({ groups: dbm.db.groups.filter(g => !g.isStaffChama).map(groupSummary) }); });
r.get('/groups/:id/details', (req, res) => {
  const g = dbm.db.groups.find(x => x.id === Number(req.params.id));
  if (!g) return res.status(404).json({ error: 'Group not found' });
  res.json({
    group: groupSummary(g),
    admins: dbm.db.users.filter(u => !u.deleted && u.role === 'group_admin' && u.groupId === g.id).map(dbm.maskedUser),
    members: dbm.db.users.filter(u => !u.deleted && u.role === 'member' && u.groupId === g.id).map(dbm.maskedUser),
    items: dbm.db.items.filter(i => i.groupId === g.id).map(i => ({ ...i, priceCents: i.priceCents || 0 })),
    loans: [...dbm.db.cashLoans.filter(l => l.groupId === g.id), ...dbm.db.itemLoans.filter(l => l.groupId === g.id)].map(l => ({ ...l, borrower: dbm.maskedUser(dbm.db.users.find(u => u.id === l.userId)) }))
  });
});
r.put('/groups/:id', (req, res) => {
  const g = dbm.db.groups.find(x => x.id === Number(req.params.id));
  if (!g) return res.status(404).json({ error: 'Group not found' });
  const name = sec.clean((req.body || {}).name ?? g.name, 80).trim();
  const description = sec.clean((req.body || {}).description ?? g.description, 200);
  if (name.length < 3) return res.status(400).json({ error: 'Group name needs at least 3 characters' });
  g.name = name; g.description = description; dbm.save();
  dbm.audit(req.user, 'vsa.group.updated', name, req);
  res.json({ ok: true, group: g });
});
r.post('/groups/:id/toggle-suspended', (req, res) => {
  const g = dbm.db.groups.find(x => x.id === Number(req.params.id) && !x.isStaffChama);
  if (!g) return res.status(404).json({ error: 'Group not found' });
  if (!sec.reauthOK(req)) return res.status(403).json({ error: 'Re-authentication failed: wrong Owner password' });
  g.suspended = !g.suspended;
  g.suspendedAt = g.suspended ? now() : null;
  g.suspendedBy = g.suspended ? req.user.id : null;
  dbm.save();
  if (g.suspended) hub.revokeGroup(g.id);
  dbm.audit(req.user, g.suspended ? 'vsa.group.suspended' : 'vsa.group.restored', g.name, req);
  res.json({ ok: true, suspended: g.suspended });
});
r.delete('/groups/:id', (req, res) => {
  const g = dbm.db.groups.find(x => x.id === Number(req.params.id));
  if (!g) return res.status(404).json({ error: 'Group not found' });
  if (!sec.reauthOK(req)) return res.status(403).json({ error: 'Re-authentication failed: wrong V Super Admin password' });
  dbm.db.groups = dbm.db.groups.filter(x => x.id !== g.id);
  hub.revokeGroup(g.id);
  for (const u of dbm.db.users) if (u.groupId === g.id) u.groupId = null;
  dbm.save(); dbm.audit(req.user, 'vsa.group.deleted', g.name, req);
  res.json({ ok: true });
});

// ---- safe codes ----
r.get('/safe-codes', (req, res) => {
  const rows = dbm.db.safeCodes.slice(-300).reverse().map(c => ({ id: c.id, code: c.code, groupId: c.groupId, group: (dbm.db.groups.find(g => g.id === c.groupId) || {}).name || '-', used: !!c.usedBy, active: !!c.active, createdAt: c.createdAt, usedAt: c.usedAt }));
  res.json({ codes: rows });
});
r.delete('/safe-codes/:id', (req, res) => {
  const c = dbm.db.safeCodes.find(x => x.id === Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Code not found' });
  if (c.usedBy) return res.status(400).json({ error: 'Cannot revoke a code that was already used' });
  c.active = false; dbm.save(); dbm.audit(req.user, 'vsa.safecode.revoked', c.code, req);
  res.json({ ok: true });
});

// ---- audit ----
r.get('/audit', (req, res) => { res.json({ audit: dbm.db.audit.slice(-250).reverse() }); });

// ---- password reset approvals ----
r.get('/password-resets', (req, res) => {
  const rows = dbm.db.resets.filter(x => x.pendingApproval).slice(-250).reverse().map(x => {
    const u = dbm.db.users.find(a => a.id === x.userId && !a.deleted);
    return { id: x.id, email: u ? dbm.maskEmail(u.email) : 'Deleted account', name: u ? `${u.firstName} ${u.lastName}` : '-', requestedAt: x.at, status: x.approvedAt ? 'approved' : 'pending' };
  });
  res.json({ requests: rows });
});
r.post('/password-resets/:id/approve', (req, res) => {
  const rec = dbm.db.resets.find(x => x.id === Number(req.params.id) && x.pendingApproval && !x.approvedAt);
  if (!rec) return res.status(404).json({ error: 'Pending reset request not found' });
  const u = dbm.db.users.find(x => x.id === rec.userId && !x.deleted);
  if (!u) return res.status(404).json({ error: 'Account no longer exists' });
  const crypto = require('crypto');
  const token = crypto.randomBytes(24).toString('hex');
  rec.tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  rec.expires = Date.now() + 3600e3; rec.approvedAt = now(); rec.approvedBy = req.user.id; dbm.save();
  const link = `${req.protocol}://${req.headers.host}/reset.html?token=${token}`;
  emailer.sendEmail(u.email, 'Password reset approved - VonDonald051 Savings', `Your reset request was approved. Reset your password within 1 hour:\n${link}`);
  dbm.audit(req.user, 'vsa.password.reset.approved', u.email, req);
  res.json({ ok: true });
});

// ---- VSA notes ----
r.post('/notes', (req, res) => {
  const title = sec.clean((req.body || {}).title, 120).trim();
  const body = sec.clean((req.body || {}).body, 2000).trim();
  const groupId = Number((req.body || {}).groupId) || null;
  if (title.length < 3 || body.length < 3) return res.status(400).json({ error: 'Title and note must each be at least 3 characters' });
  if (groupId && !dbm.db.groups.some(g => g.id === groupId)) return res.status(400).json({ error: 'Unknown group' });
  const recipients = dbm.db.users.filter(u => !u.deleted && u.role === 'group_admin' && (!groupId || u.groupId === groupId));
  for (const u of recipients) emailer.notifyUser(u.id, 'vsa_note', title, body);
  dbm.add('notes', 'note', { title, body, groupId, sentBy: req.user.id, recipients: recipients.map(u => u.id), at: now() });
  dbm.audit(req.user, 'vsa.note.sent', `${groupId || 'all groups'}: ${title}`, req);
  res.status(201).json({ ok: true, delivered: recipients.length });
});

// ---- OWNER LOAN QUEUE: verify/disburse/clear staff (SA/GA) loans ----
r.get('/staff-loans', (req, res) => {
  const status = String((req.query || {}).status || 'pending');
  let loans = [...dbm.db.cashLoans.filter(l => l.staffLoan), ...dbm.db.itemLoans.filter(l => l.staffLoan)];
  if (status !== 'all') loans = loans.filter(l => l.status === status);
  const rows = loans.sort((a, b) => b.id - a.id).map(l => {
    const borrower = dbm.db.users.find(u => u.id === l.userId);
    const mp = dbm.memberProfileFor(l.userId);
    const savings = dbm.getUserSavingsTotal(l.userId);
    const loanHistory = l.type === 'cash' ? dbm.db.cashLoans.filter(cl => cl.userId === l.userId).length : dbm.db.itemLoans.filter(il => il.userId === l.userId).length;
    return { ...l, borrower: borrower ? { ...dbm.maskedUser(borrower), group: (dbm.db.groups.find(g => g.id === borrower.groupId) || {}).name } : null, borrowerSavingsCents: savings, borrowerBalanceCents: savings, loanHistory };
  });
  res.json({ loans: rows });
});

r.post('/staff-loans/:id/verify', (req, res) => {
  const isCash = req.body && req.body.type === 'cash';
  const loan = isCash ? dbm.db.cashLoans.find(x => x.id === Number(req.params.id)) : dbm.db.itemLoans.find(x => x.id === Number(req.params.id));
  if (!loan || !loan.staffLoan) return res.status(404).json({ error: 'Pending staff loan not found' });
  if (loan.status !== 'pending') return res.status(400).json({ error: 'Loan is not pending' });
  if (loan.userId === req.user.id) return res.status(403).json({ error: 'You cannot verify your own loan' });
  loan.status = 'verified'; loan.verifiedAt = now(); loan.verifiedBy = req.user.id; loan.updatedAt = now(); dbm.save();
  dbm.audit(req.user, 'owner.staff_loan.verified', `${isCash ? 'cash' : 'item'} loan #${loan.id}`, req);
  emailer.emailVSA('Staff loan verified', `Staff loan #${loan.id} for ${(dbm.db.users.find(u => u.id === loan.userId) || {}).email || 'unknown'} was verified by ${req.user.email} at ${now()}.`);
  try { hub.broadcastLoan(loan.userId, { id: loan.id, type: loan.type, status: loan.status, amountCents: loan.amountCents, dueAt: loan.dueAt }); } catch {}
  res.json({ ok: true, loan });
});
r.post('/staff-loans/:id/disburse', (req, res) => {
  const isCash = req.body && req.body.type === 'cash';
  const loan = isCash ? dbm.db.cashLoans.find(x => x.id === Number(req.params.id)) : dbm.db.itemLoans.find(x => x.id === Number(req.params.id));
  if (!loan || !loan.staffLoan) return res.status(404).json({ error: 'Active staff loan not found' });
  if (loan.status !== 'verified') return res.status(400).json({ error: 'Loan must be verified first' });
  if (!sec.canDisburseLoan(req, loan)) return res.status(403).json({ error: 'You cannot disburse this loan' });
  loan.status = 'disbursed'; loan.disbursedAt = now(); loan.dueAt = isCash ? new Date(Date.now() + 14 * 86400000).toISOString() : null; loan.updatedAt = now(); dbm.save();
  dbm.audit(req.user, 'owner.staff_loan.disbursed', `${isCash ? 'cash' : 'item'} loan #${loan.id}`, req);
  emailer.emailVSA('Staff loan disbursed', `Staff loan #${loan.id} for ${(dbm.db.users.find(u => u.id === loan.userId) || {}).email || 'unknown'} was disbursed by ${req.user.email} at ${now()}.`);
  try { hub.broadcastLoan(loan.userId, { id: loan.id, type: loan.type, status: loan.status, amountCents: loan.amountCents, dueAt: loan.dueAt }); } catch {}
  res.json({ ok: true, loan });
});
r.post('/staff-loans/:id/reject', (req, res) => {
  const isCash = req.body && req.body.type === 'cash';
  const loan = isCash ? dbm.db.cashLoans.find(x => x.id === Number(req.params.id)) : dbm.db.itemLoans.find(x => x.id === Number(req.params.id));
  if (!loan || !loan.staffLoan || loan.status !== 'pending') return res.status(404).json({ error: 'Pending staff loan not found' });
  loan.status = 'rejected'; loan.clearedAt = now(); loan.clearedBy = req.user.id; loan.updatedAt = now(); dbm.save();
  dbm.audit(req.user, 'owner.staff_loan.rejected', `${isCash ? 'cash' : 'item'} loan #${loan.id}`, req);
  emailer.emailVSA('Staff loan rejected', `Staff loan #${loan.id} for ${(dbm.db.users.find(u => u.id === loan.userId) || {}).email || 'unknown'} was rejected by ${req.user.email} at ${now()}.`);
  try { hub.broadcastLoan(loan.userId, { id: loan.id, type: loan.type, status: loan.status, amountCents: loan.amountCents, dueAt: loan.dueAt }); } catch {}
  res.json({ ok: true, loan });
});
r.post('/staff-loans/:id/clear', (req, res) => {
  const isCash = req.body && req.body.type === 'cash';
  const loan = isCash ? dbm.db.cashLoans.find(x => x.id === Number(req.params.id)) : dbm.db.itemLoans.find(x => x.id === Number(req.params.id));
  if (!loan || !loan.staffLoan || !['disbursed', 'overdue'].includes(loan.status)) return res.status(404).json({ error: 'Active staff loan not found' });
  if (loan.userId === req.user.id) return res.status(403).json({ error: 'You cannot clear your own loan' });
  if (loan.requiresPaymentReport && !loan.repaymentReportedAt) return res.status(400).json({ error: 'Borrower must report repayment before you can verify and clear this loan' });
  const fineCents = isCash ? dbm.overdueFineCents(loan) : 0;
  loan.status = 'cleared'; loan.clearedAt = now(); loan.clearedBy = req.user.id; loan.fineCents = (loan.fineCents || 0) + fineCents; loan.updatedAt = now(); dbm.save();
  if (fineCents > 0) dbm.appendFine(loan.userId, loan.groupId, loan.id, fineCents, `fine:loan:${loan.id}`);
  dbm.markLoanFinesPaid(loan.id, req.user.id);
  dbm.audit(req.user, 'owner.staff_loan.cleared', `${isCash ? 'cash' : 'item'} loan #${loan.id}`, req);
  emailer.emailVSA('Staff loan cleared', `Staff loan #${loan.id} for ${(dbm.db.users.find(u => u.id === loan.userId) || {}).email || 'unknown'} was cleared by ${req.user.email} at ${now()}.`);
  try { hub.broadcastLoan(loan.userId, { id: loan.id, type: loan.type, status: loan.status, amountCents: loan.amountCents, dueAt: loan.dueAt, fineCents: loan.fineCents }); } catch {}
  res.json({ ok: true, loan, fineCents });
});

// ---- Staff Chama item prices (Owner sets prices) ----
r.put('/staff-chama/items/:id/price', (req, res) => {
  const staffGroup = dbm.staffChamaGroup();
  if (!staffGroup) return res.status(400).json({ error: 'Staff Chama not found' });
  const item = dbm.db.items.find(x => x.id === Number(req.params.id) && x.groupId === staffGroup.id);
  if (!item) return res.status(404).json({ error: 'Item not found in Staff Chama' });
  const priceCents = dbm.toCents((req.body || {}).price);
  if (priceCents < 0) return res.status(400).json({ error: 'Price must be non-negative' });
  item.priceCents = priceCents; dbm.save();
  dbm.audit(req.user, 'owner.staff_item.price_updated', `item #${item.id} price=${dbm.fromCents(priceCents)}`, req);
  res.json({ ok: true, priceCents });
});

// ---- BRANDING: Owner only ----
r.get('/branding', (req, res) => {
  const current = dbm.currentBranding();
  res.json({ branding: current || null, history: dbm.brandingHistory() });
});

r.post('/branding', sec.limiter(60e3, 30), (req, res) => {
  const b = req.body || {};
  const name = sec.sanitizeBrandName(b.name);
  const logo = String(b.logo || '').trim();
  const roleKeys = ['v_super_admin', 'super_admin', 'admin', 'group_admin', 'member'];
  const colors = {};
  const errors = {};
  if (!name) errors.name = 'System name is required (2-60 chars)';
  else if (name.length < 2) errors.name = 'System name must be at least 2 characters';
  if (!logo && !name) return res.status(400).json({ error: 'Provide a name or logo' });
  if (logo) {
    const match = logo.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+=*)$/);
    if (!match || logo.length > 2800000) errors.logo = 'Logo must be a PNG, JPG or WebP image under 2MB';
    else {
      const bytes = Buffer.from(match[2], 'base64');
      const validPng = match[1] === 'png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const validJpeg = match[1] === 'jpeg' && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      const validWebp = match[1] === 'webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
      if (!bytes.length || bytes.length > 2 * 1024 * 1024 || !(validPng || validJpeg || validWebp)) errors.logo = 'Logo file is not a valid PNG, JPG or WebP image';
    }
  }
  if (b.colors != null) {
    if (!b.colors || typeof b.colors !== 'object' || Array.isArray(b.colors)) errors.colors = 'Invalid role color settings';
    else for (const role of roleKeys) {
      const value = b.colors[role];
      if (!value || typeof value !== 'object' || !/^#[0-9a-f]{6}$/i.test(value.accent || '') || !/^#[0-9a-f]{6}$/i.test(value.background || '')) {
        errors.colors = `Choose valid accent and background colors for ${role.replace(/_/g, ' ')}`; break;
      }
      colors[role] = { accent: value.accent.toLowerCase(), background: value.background.toLowerCase() };
    }
  }
  if (Object.keys(errors).length) return res.status(400).json({ errors });

  const prev = dbm.currentBranding();
  const entry = {
    id: dbm.next('branding'), name: name || (prev ? prev.name : 'VonDonald051 Savings'),
    logo: b.clearLogo ? null : (logo || (prev ? prev.logo : null)),
    colors: b.colors == null ? (prev && prev.colors || null) : colors,
    logo32: prev ? prev.logo32 : null, logo128: prev ? prev.logo128 : null, logo512: prev ? prev.logo512 : null,
    createdAt: new Date().toISOString(), createdBy: req.user.id, rolledBack: false
  };
  dbm.db.branding.push(entry); dbm.save();
  dbm.audit(req.user, 'vsa.branding.updated', entry.name, req);
  emailer.emailVSA('System branding updated', `System name is now "${entry.name}" (changed by ${req.user.email}).`);
  try { require('../hub').broadcastBranding({ name: entry.name, logo: entry.logo, colors: entry.colors }); } catch (e) { /* no-op */ }
  res.json({ ok: true, branding: entry });
});

r.post('/branding/:id/rollback', (req, res) => {
  const target = dbm.db.branding.find(b => b.id === Number(req.params.id));
  if (!target || target.rolledBack) return res.status(404).json({ error: 'Branding version not found' });
  const prev = dbm.currentBranding();
  if (prev && prev.id === target.id) return res.status(400).json({ error: 'This is already the current branding' });
  const entry = {
    id: dbm.next('branding'), name: target.name, logo: target.logo, colors: target.colors || null,
    logo32: target.logo32, logo128: target.logo128, logo512: target.logo512,
    createdAt: new Date().toISOString(), createdBy: req.user.id, rolledBack: false
  };
  dbm.db.branding.push(entry); dbm.save();
  dbm.audit(req.user, 'vsa.branding.rollback', `rolled back to "${target.name}" (v${target.id})`, req);
  emailer.emailVSA('System branding rolled back', `System branding was rolled back to "${target.name}" (version #${target.id}) by ${req.user.email}.`);
  try { require('../hub').broadcastBranding({ name: entry.name, logo: entry.logo, colors: entry.colors }); } catch (e) { /* no-op */ }
  res.json({ ok: true, branding: entry });
});

r.get('/charts/trends', (req, res) => res.json(dashboardData.buildWeeklyDashboardTrend(dbm.db, dbm.fromCents)));

// ---- reports ----
r.get('/reports/group-admin-summary', (req, res) => {
  const fmt = String(req.query.format || 'pdf').toLowerCase() === 'csv' ? 'csv' : 'pdf';
  dbm.audit(req.user, 'vsa.group_admin_summary.downloaded', fmt, req);
  reports.sendAdminSummary(res, fmt, req);
});
r.get('/groups/:id/report', (req, res) => {
  const g = dbm.db.groups.find(x => x.id === Number(req.params.id));
  if (!g) return res.status(404).json({ error: 'Group not found' });
  if (!sec.canExportGroup(req, g.id)) return res.status(403).json({ error: 'You cannot export reports for this group' });
  const fmt = String(req.query.format || 'pdf').toLowerCase();
  dbm.audit(req.user, 'vsa.report.downloaded', `${g.name} (${fmt})`, req);
  emailer.emailVSA('Group report downloaded', `${req.user.email} downloaded the ${fmt.toUpperCase()} report for "${g.name}" at ${now()}.`);
  if (fmt === 'csv') return reports.sendCSV(res, g, req);
  return reports.sendPDF(res, g, req);
});
r.get('/staff-chama/report', (req, res) => {
  const fmt = String(req.query.format || 'pdf').toLowerCase();
  const staffGroup = dbm.staffChamaGroup();
  if (!staffGroup) return res.status(404).json({ error: 'Staff Chama not found' });
  if (!sec.canExportGroup(req, staffGroup.id)) return res.status(403).json({ error: 'You cannot export reports for the Staff Chama' });
  dbm.audit(req.user, 'vsa.staff_chama.report.downloaded', fmt, req);
  if (fmt === 'csv') return reports.sendStaffChamaCSV(res, staffGroup, req);
  return reports.sendStaffChamaPDF(res, staffGroup, req);
});
r.get('/staff/:id/profile', (req, res) => {
  const u = dbm.db.users.find(x => x.id === Number(req.params.id) && !x.deleted);
  if (!u || !sec.isStaffRole(u)) return res.status(404).json({ error: 'Staff member not found' });
  if (!sec.canExportMember(req, u.id)) return res.status(403).json({ error: 'You cannot export profiles for this staff member' });
  const mp = dbm.memberProfileFor(u.id);
  const fmt = String(req.query.format || 'pdf').toLowerCase();
  dbm.audit(req.user, 'vsa.staff.profile.viewed', `${u.role} ${u.email}`, req);
  if (fmt === 'csv') return reports.sendStaffMemberCSV(res, u, mp, req);
  return reports.sendStaffMemberPDF(res, u, mp, req);
});

// ---- exports log ----
r.get('/exports', (req, res) => {
  res.json({ exports: dashboardData.exportHistory(dbm.db) });
});

module.exports = r;
module.exports.genCode = seed.genCode;
