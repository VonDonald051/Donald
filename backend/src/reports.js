'use strict';
/* Per-group reports for the V Super Admin: PDF and CSV.
 * Stage 5 Branding: system name/logo in all reports.
 * Stage 5 Exports: role-scoped, formula-injection guard, export logging. */
const dbm = require('./db');
const { PdfDoc } = require('./pdf');
const qr = require('./qrcode');

function getBranding() {
  const b = dbm.currentBranding();
  return b || { name: 'VonDonald051 Savings', logo: null };
}

function escCsv(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r].*/.test(s)) s = "'" + s;
  if (/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function logExport(req, type, target, format) {
  dbm.add('exports', 'export', {
    userId: req.user ? req.user.id : null, userRole: req.user ? req.user.role : null,
    type, target, format, at: new Date().toISOString()
  });
}

const filename = (g, ext) => 'report-' + g.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + new Date().toISOString().slice(0, 10) + '.' + ext;

function groupData(g) {
  const db = dbm.db;
  const members = db.users.filter(u => !u.deleted && u.groupId === g.id && u.role === 'member');
  const admins = db.users.filter(u => !u.deleted && u.groupId === g.id && u.role === 'group_admin');
  const ids = new Set(members.map(m => m.id));
  const msgCount = id => db.messages.filter(m => m.senderId === id || m.recipientId === id).length;
  const codes = db.safeCodes.filter(c => c.groupId === g.id);
  const loans = [...db.cashLoans.filter(l => l.groupId === g.id), ...db.itemLoans.filter(l => l.groupId === g.id)];
  const savingsTotal = db.savings.filter(s => s.groupId === g.id && !s.reversed).reduce((n, s) => n + Number(s.amountCents || 0), 0);
  const finesTotal = db.fines.filter(f => f.groupId === g.id && !f.reversed).reduce((n, f) => n + Number(f.amountCents || 0), 0);
  const brand = getBranding();
  return {
    group: g, brand,
    admins: admins.map(a => ({ name: a.firstName + ' ' + a.lastName, email: dbm.maskEmail(a.email), phone: dbm.maskPhone(a.phone) })),
    members: members.map(m => ({
      name: m.firstName + ' ' + m.lastName, email: dbm.maskEmail(m.email), phone: dbm.maskPhone(m.phone),
      joined: (m.createdAt || '').slice(0, 10), locked: m.locked ? 'YES' : 'no',
      messages: msgCount(m.id), savingsCents: dbm.getUserSavingsTotal(m.id)
    })),
    totals: {
      members: members.length, admins: admins.length,
      messages: db.messages.filter(m => ids.has(m.senderId) || ids.has(m.recipientId)).length,
      codesUsed: codes.filter(c => c.usedBy).length,
      codesLeft: codes.filter(c => c.active && !c.usedBy).length,
      lockedAccounts: members.filter(m => m.locked).length,
      pendingLoans: loans.filter(l => l.status === 'pending').length,
      finesPaidCents: finesTotal,
      itemsBorrowed: db.itemLoans.filter(l => l.groupId === g.id && ['disbursed', 'overdue', 'cleared'].includes(l.status)).length,
      cashLoanedCents: db.cashLoans.filter(l => l.groupId === g.id && ['disbursed', 'overdue', 'cleared'].includes(l.status)).reduce((n, l) => n + Number(l.amountCents || 0), 0),
      savingsTotalCents: savingsTotal
    },
    generatedAt: new Date().toISOString()
  };
}

function staffChamaData() {
  const db = dbm.db;
  const staffGroup = dbm.staffChamaGroup();
  if (!staffGroup) return null;
  const staff = db.users.filter(u => !u.deleted && u.groupId === staffGroup.id);
  const admins = staff.filter(u => u.role === 'super_admin');
  const gas = staff.filter(u => u.role === 'group_admin');
  const loans = [...db.cashLoans.filter(l => l.groupId === staffGroup.id), ...db.itemLoans.filter(l => l.groupId === staffGroup.id)];
  const codes = db.safeCodes.filter(c => c.groupId === staffGroup.id);
  const msgCount = id => db.messages.filter(m => m.senderId === id || m.recipientId === id).length;
  const brand = getBranding();
  return {
    group: staffGroup, brand,
    admins: admins.map(a => ({ name: a.firstName + ' ' + a.lastName, email: dbm.maskEmail(a.email), phone: dbm.maskPhone(a.phone), role: a.role, joined: (a.createdAt || '').slice(0, 10), locked: a.locked ? 'YES' : 'no', messages: msgCount(a.id) })),
    gas: gas.map(a => ({ name: a.firstName + ' ' + a.lastName, email: dbm.maskEmail(a.email), phone: dbm.maskPhone(a.phone), role: a.role, joined: (a.createdAt || '').slice(0, 10), locked: a.locked ? 'YES' : 'no', messages: msgCount(a.id) })),
    totals: {
      totalMembers: staff.length,
      superAdmins: admins.length,
      groupAdmins: gas.length,
      messages: staff.reduce((n, m) => n + msgCount(m.id), 0),
      codesUsed: codes.filter(c => c.usedBy).length,
      codesLeft: codes.filter(c => c.active && !c.usedBy).length,
      pendingLoans: loans.filter(l => l.status === 'pending').length,
      activeLoans: loans.filter(l => l.status === 'disbursed' || l.status === 'overdue').length,
      finesPaidCents: db.fines.filter(f => f.groupId === staffGroup.id && !f.reversed).reduce((n, f) => n + Number(f.amountCents || 0), 0),
      cashLoanedCents: db.cashLoans.filter(l => l.groupId === staffGroup.id && ['disbursed', 'overdue', 'cleared'].includes(l.status)).reduce((n, l) => n + Number(l.amountCents || 0), 0)
    },
    generatedAt: new Date().toISOString()
  };
}

function table(doc, title, head, widths, rows) {
  if (doc.y > doc.H - 120) doc.newPage();
  doc.text(title, { size: 11, bold: true, color: [0, 0, 0], dy: 18 });
  if (doc.y > doc.H - 60) doc.newPage();
  let y = doc.y;
  let x = 46;
  head.forEach((hd, i) => { doc.cell(hd, x, y, widths[i], { bold: true, invert: true }); x += widths[i]; });
  y += 16;
  doc.y = y;
  if (!rows.length) { doc.text('  (none)', { size: 9, color: [120, 120, 120] }); return; }
  for (const row of rows) {
    if (doc.y > doc.H - 50) doc.newPage();
    y = doc.y;
    x = 46;
    row.forEach((c, i) => { doc.cell(String(c), x, y, widths[i], {}); x += widths[i]; });
    doc.hline(46, 46 + widths.reduce((a, b) => a + b, 0), y + 14);
    doc.y = y + 16;
  }
  doc.gap(10);
}

function sendCSV(res, g, req) {
  const d = groupData(g);
  if (req) logExport(req, 'group', g.id, 'csv');
  const rows = [
    [`${d.brand.name} - Group Report`],
    ['Group', d.group.name],
    ['Description', d.group.description || ''],
    ['Generated (UTC)', d.generatedAt],
    [],
    ['Summary'],
    ['Members', d.totals.members], ['Group admins', d.totals.admins], ['Chat messages (est.)', d.totals.messages],
    ['Safe codes used', d.totals.codesUsed], ['Safe codes remaining', d.totals.codesLeft], ['Locked accounts', d.totals.lockedAccounts],
    ['Pending loan requests', d.totals.pendingLoans], ['Fines paid (KES)', (d.totals.finesPaidCents / 100).toFixed(2)], ['Items borrowed', d.totals.itemsBorrowed],
    ['Cash loaned (KES)', (d.totals.cashLoanedCents / 100).toFixed(2)], ['Group savings total (KES)', (d.totals.savingsTotalCents / 100).toFixed(2)],
    [],
    ['Group admins'],
    ['Name', 'Email', 'Phone'],
    ...d.admins.map(a => [a.name, a.email, a.phone]),
    [],
    ['Members'],
    ['Name', 'Email', 'Phone', 'Joined', 'Locked', 'Messages', 'Savings (KES)'],
    ...d.members.map(m => [m.name, m.email, m.phone, m.joined, m.locked, m.messages, (m.savingsCents / 100).toFixed(2)])
  ];
  const csv = '﻿' + rows.map(r => r.map(escCsv).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename(g, 'csv')}"`);
  res.send(csv);
}

function sendPDF(res, g, req) {
  const d = groupData(g);
  if (req) logExport(req, 'group', g.id, 'pdf');
  const doc = new PdfDoc();
  doc.text(d.brand.name, { size: 20, bold: true, color: [17, 17, 17], dy: 26 });
  doc.text('Group Report', { size: 13, color: [68, 68, 68], dy: 18 });
  doc.text(`Generated (UTC): ${d.generatedAt}`, { size: 9, color: [102, 102, 102], dy: 16 });
  doc.rule();
  doc.text(d.group.name, { size: 14, bold: true, dy: 20 });
  if (d.group.description) doc.text(d.group.description, { size: 9, color: [85, 85, 85], dy: 14 });
  doc.gap(6);
  doc.text('Summary', { size: 11, bold: true, dy: 16 });
  for (const [k, v] of [
    ['Members', d.totals.members], ['Group admins', d.totals.admins], ['Chat messages (est.)', d.totals.messages],
    ['Safe codes used', d.totals.codesUsed], ['Safe codes remaining', d.totals.codesLeft], ['Locked accounts', d.totals.lockedAccounts],
    ['Pending loan requests', d.totals.pendingLoans], ['Fines paid (KES)', (d.totals.finesPaidCents / 100).toFixed(2)],
    ['Items borrowed', d.totals.itemsBorrowed], ['Cash loaned (KES)', (d.totals.cashLoanedCents / 100).toFixed(2)],
    ['Group savings total (KES)', (d.totals.savingsTotalCents / 100).toFixed(2)]
  ]) doc.text(`${k}:  ${v}`, { size: 10, dy: 15 });
  doc.gap(8);

  table(doc, 'Group Admins', ['Name', 'Email', 'Phone'], [170, 200, 130], d.admins.map(a => [a.name, a.email, a.phone]));
  table(doc, 'Members', ['Name', 'Email', 'Phone', 'Joined', 'Locked', 'Msgs', 'Savings (KES)'], [120, 160, 80, 60, 50, 50, 70],
    d.members.map(m => [m.name, m.email, m.phone, m.joined, m.locked, m.messages, (m.savingsCents / 100).toFixed(2)]));

  doc.gap(12);
  doc.text(`Confidential - generated for the V Super Admin of ${d.brand.name}.`, { size: 8, color: [136, 136, 136] });

  const buf = doc.buffer();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename(g, 'pdf')}"`);
  res.setHeader('Content-Length', buf.length);
  res.send(buf);
}

function sendAdminSummary(res, fmt, req) {
  if (req) logExport(req, 'group-admin-summary', 'all', fmt);
  const rows = dbm.db.users.filter(u => !u.deleted && u.role === 'group_admin').map(u => {
    const g = dbm.db.groups.find(x => x.id === u.groupId);
    return [u.firstName + ' ' + u.lastName, u.email, u.phone, g ? g.name : 'Unassigned', u.disabled ? 'Disabled' : u.locked ? 'Locked' : 'Active', (u.createdAt || '').slice(0, 10)];
  });
  const brand = getBranding();
  if (fmt === 'csv') {
    const csv = '﻿' + [[`${brand.name} - Group Admin Summary`], ['Generated (UTC)', new Date().toISOString()], [], ['Name', 'Email', 'Phone', 'Group', 'Status', 'Created'], ...rows].map(r => r.map(escCsv).join(',')).join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="group-admin-summary.csv"'); return res.send(csv);
  }
  const doc = new PdfDoc(); doc.text(brand.name, { size: 20, bold: true, dy: 26 }); doc.text('Group Admin Summary', { size: 13, dy: 18 }); doc.text(`Generated (UTC): ${new Date().toISOString()}`, { size: 9, color: [102, 102, 102], dy: 16 }); doc.rule();
  table(doc, 'Group Admin Accounts', ['Name', 'Email', 'Phone', 'Group', 'Status', 'Created'], [90, 135, 75, 105, 55, 45], rows);
  const buf = doc.buffer(); res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', 'attachment; filename="group-admin-summary.pdf"'); res.setHeader('Content-Length', buf.length); return res.send(buf);
}

function sendStaffChamaCSV(res, staffGroup, req) {
  const d = staffChamaData();
  if (!d) return res.status(404).send('Staff Chama not found');
  if (req) logExport(req, 'staff-chama', staffGroup.id, 'csv');
  const rows = [
    [`${d.brand.name} - Staff Chama Report`],
    ['Group', d.group.name],
    ['Description', d.group.description || ''],
    ['Generated (UTC)', d.generatedAt],
    [],
    ['Summary'],
    ['Total staff', d.totals.totalMembers], ['Super Admins', d.totals.superAdmins], ['Group Admins', d.totals.groupAdmins],
    ['Messages', d.totals.messages], ['Safe codes used', d.totals.codesUsed], ['Safe codes left', d.totals.codesLeft],
    ['Pending staff loans', d.totals.pendingLoans], ['Active staff loans', d.totals.activeLoans], ['Fines paid (KES)', (d.totals.finesPaidCents / 100).toFixed(2)], ['Cash loaned (KES)', (d.totals.cashLoanedCents / 100).toFixed(2)],
    [],
    ['Super Admins'],
    ['Name', 'Email', 'Phone', 'Joined', 'Locked', 'Messages'],
    ...d.admins.map(a => [a.name, a.email, a.phone, a.joined, a.locked, a.messages]),
    [],
    ['Group Admins'],
    ['Name', 'Email', 'Phone', 'Joined', 'Locked', 'Messages'],
    ...d.gas.map(a => [a.name, a.email, a.phone, a.joined, a.locked, a.messages])
  ];
  const csv = '﻿' + rows.map(r => r.map(escCsv).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="staff-chama-report.csv"`);
  res.send(csv);
}

function sendStaffChamaPDF(res, staffGroup, req) {
  const d = staffChamaData();
  if (!d) return res.status(404).send('Staff Chama not found');
  if (req) logExport(req, 'staff-chama', staffGroup.id, 'pdf');
  const doc = new PdfDoc();
  doc.text(d.brand.name, { size: 20, bold: true, color: [17, 17, 17], dy: 26 });
  doc.text('Staff Chama Report', { size: 13, color: [68, 68, 68], dy: 18 });
  doc.text(`Generated (UTC): ${d.generatedAt}`, { size: 9, color: [102, 102, 102], dy: 16 });
  doc.rule();
  doc.text(d.group.name, { size: 14, bold: true, dy: 20 });
  if (d.group.description) doc.text(d.group.description, { size: 9, color: [85, 85, 85], dy: 14 });
  doc.gap(6);
  doc.text('Summary', { size: 11, bold: true, dy: 16 });
  for (const [k, v] of [
    ['Total staff', d.totals.totalMembers], ['Super Admins', d.totals.superAdmins], ['Group Admins', d.totals.groupAdmins],
    ['Messages', d.totals.messages], ['Safe codes used', d.totals.codesUsed], ['Safe codes left', d.totals.codesLeft],
    ['Pending staff loans', d.totals.pendingLoans], ['Active staff loans', d.totals.activeLoans], ['Fines paid (KES)', (d.totals.finesPaidCents / 100).toFixed(2)], ['Cash loaned (KES)', (d.totals.cashLoanedCents / 100).toFixed(2)]
  ]) doc.text(`${k}:  ${v}`, { size: 10, dy: 15 });
  doc.gap(8);

  if (d.admins.length) table(doc, 'Super Admins', ['Name', 'Email', 'Phone', 'Joined', 'Locked', 'Msgs'], [120, 160, 80, 60, 50, 60], d.admins.map(a => [a.name, a.email, a.phone, a.joined, a.locked, a.messages]));
  if (d.gas.length) table(doc, 'Group Admins', ['Name', 'Email', 'Phone', 'Joined', 'Locked', 'Msgs'], [120, 160, 80, 60, 50, 60], d.gas.map(a => [a.name, a.email, a.phone, a.joined, a.locked, a.messages]));

  doc.gap(12);
  doc.text(`Confidential - generated for the V Super Admin of ${d.brand.name}.`, { size: 8, color: [136, 136, 136] });

  const buf = doc.buffer();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="staff-chama-report.pdf"`);
  res.setHeader('Content-Length', buf.length);
  res.send(buf);
}

function sendStaffMemberCSV(res, u, mp, req) {
  const loans = [...dbm.db.cashLoans.filter(l => l.userId === u.id), ...dbm.db.itemLoans.filter(l => l.userId === u.id)];
  const savings = dbm.db.savings.filter(s => s.userId === u.id && !s.reversed);
  const fines = dbm.db.fines.filter(f => f.userId === u.id && !f.reversed);
  if (req) logExport(req, 'staff-member', u.id, 'csv');
  const brand = getBranding();
  const rows = [
    [`${brand.name} - Staff Member Profile`],
    ['Name', u.firstName + ' ' + u.lastName],
    ['Email', u.email],
    ['Phone', u.phone || ''],
    ['Role', u.role],
    ['Group', (dbm.db.groups.find(g => g.id === u.groupId) || {}).name || '-'],
    ['Joined', (u.createdAt || '').slice(0, 10)],
    ['Registration fee paid', mp && mp.registrationFeePaid ? 'YES' : 'NO'],
    ['Agreement signed', mp && mp.agreementSigned ? 'YES' : 'NO'],
    ['Generated (UTC)', new Date().toISOString()],
    [],
    ['Loans'],
    ['ID', 'Type', 'Amount (KES)', 'Due', 'Fine (KES)', 'Status', 'Created'],
    ...loans.map(l => [l.id, l.type, ((l.amountCents || 0) / 100).toFixed(2), l.dueAt ? (l.dueAt || '').slice(0, 10) : '-', ((l.fineCents || 0) / 100).toFixed(2), l.status, (l.createdAt || '').slice(0, 10)]),
    [],
    ['Savings'],
    ['ID', 'Amount (KES)', 'Week', 'Description', 'Created'],
    ...savings.map(s => [s.id, ((s.amountCents || 0) / 100).toFixed(2), s.week, s.description || '', (s.createdAt || '').slice(0, 10)]),
    [],
    ['Fines'],
    ['ID', 'Amount (KES)', 'Paid', 'Loan ID', 'Created'],
    ...fines.map(f => [f.id, ((f.amountCents || 0) / 100).toFixed(2), f.paid ? 'YES' : 'NO', f.loanId || '-', (f.createdAt || '').slice(0, 10)])
  ];
  const csv = '﻿' + rows.map(r => r.map(escCsv).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="staff-${u.id}-profile.csv"`);
  res.send(csv);
}

function sendStaffMemberPDF(res, u, mp, req) {
  const loans = [...dbm.db.cashLoans.filter(l => l.userId === u.id), ...dbm.db.itemLoans.filter(l => l.userId === u.id)];
  const savings = dbm.db.savings.filter(s => s.userId === u.id && !s.reversed);
  const fines = dbm.db.fines.filter(f => f.userId === u.id && !f.reversed);
  if (req) logExport(req, 'staff-member', u.id, 'pdf');
  const brand = getBranding();
  const doc = new PdfDoc();
  doc.text(brand.name, { size: 20, bold: true, color: [17, 17, 17], dy: 26 });
  doc.text('Staff Member Profile', { size: 13, color: [68, 68, 68], dy: 18 });
  doc.text(`Generated (UTC): ${new Date().toISOString()}`, { size: 9, color: [102, 102, 102], dy: 16 });
  doc.rule();
  doc.text(u.firstName + ' ' + u.lastName, { size: 16, bold: true, dy: 20 });
  doc.text(`Email: ${u.email}`, { size: 10, dy: 14 });
  doc.text(`Phone: ${u.phone || '-'}`, { size: 10, dy: 14 });
  doc.text(`Role: ${u.role}`, { size: 10, dy: 14 });
  doc.text(`Group: ${(dbm.db.groups.find(g => g.id === u.groupId) || {}).name || '-'}`, { size: 10, dy: 14 });
  doc.text(`Registration fee: ${mp && mp.registrationFeePaid ? 'PAID' : 'UNPAID'}`, { size: 10, dy: 14 });
  doc.text(`Agreement signed: ${mp && mp.agreementSigned ? 'YES' : 'NO'}`, { size: 10, dy: 14 });
  doc.gap(8);

  if (loans.length) {
    table(doc, 'Loans', ['ID', 'Type', 'Amount (KES)', 'Due', 'Fine (KES)', 'Status'], [40, 50, 80, 60, 60, 60],
      loans.map(l => [l.id, l.type, ((l.amountCents || 0) / 100).toFixed(2), l.dueAt ? (l.dueAt || '').slice(0, 10) : '-', ((l.fineCents || 0) / 100).toFixed(2), l.status]));
  }
  if (savings.length) {
    table(doc, 'Savings', ['ID', 'Amount (KES)', 'Week', 'Description'], [40, 70, 60, 140],
      savings.map(s => [s.id, ((s.amountCents || 0) / 100).toFixed(2), s.week, s.description || '']));
  }
  if (fines.length) {
    table(doc, 'Fines', ['ID', 'Amount (KES)', 'Paid', 'Loan ID'], [40, 70, 50, 60],
      fines.map(f => [f.id, ((f.amountCents || 0) / 100).toFixed(2), f.paid ? 'YES' : 'NO', f.loanId || '-']));
  }

  doc.gap(12);
  doc.text(`Confidential - generated for the V Super Admin of ${brand.name}.`, { size: 8, color: [136, 136, 136] });

  const buf = doc.buffer();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="staff-${u.id}-profile.pdf"`);
  res.setHeader('Content-Length', buf.length);
  res.send(buf);
}

// ---- Super Admin group progress report ----
function sendSuperAdminGroupsPDF(res, groups, req) {
  if (req) logExport(req, 'super-admin-groups', 'all', 'pdf');
  const brand = getBranding();
  const doc = new PdfDoc();
  doc.text(brand.name, { size: 20, bold: true, color: [17, 17, 17], dy: 26 });
  doc.text('Group Progress Report', { size: 13, color: [68, 68, 68], dy: 18 });
  doc.text(`Generated (UTC): ${new Date().toISOString()}`, { size: 9, color: [102, 102, 102], dy: 16 });
  doc.rule();
  for (const g of groups) {
    if (doc.y > doc.H - 120) doc.newPage();
    const d = groupData(g);
    doc.text(d.group.name, { size: 12, bold: true, dy: 16 });
    doc.text(`Members: ${d.totals.members} | Savings: KES ${(d.totals.savingsTotalCents / 100).toFixed(2)} | Pending loans: ${d.totals.pendingLoans} | Fines: KES ${(d.totals.finesPaidCents / 100).toFixed(2)}`, { size: 9, color: [85, 85, 85], dy: 14 });
    doc.gap(6);
  }
  doc.gap(12);
  doc.text(`Confidential - generated for the V Super Admin of ${brand.name}.`, { size: 8, color: [136, 136, 136] });
  const buf = doc.buffer();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="super-admin-groups-report.pdf"');
  res.setHeader('Content-Length', buf.length);
  res.send(buf);
}

function sendSuperAdminGroupsCSV(res, groups, req) {
  if (req) logExport(req, 'super-admin-groups', 'all', 'csv');
  const brand = getBranding();
  const rows = [
    [`${brand.name} - Group Progress Report`],
    ['Generated (UTC)', new Date().toISOString()],
    [],
    ['Group', 'Members', 'Group Admins', 'Savings (KES)', 'Pending Loans', 'Fines (KES)', 'Cash Loaned (KES)', 'Items Borrowed'],
    ...groups.map(g => {
      const d = groupData(g);
      return [d.group.name, d.totals.members, d.totals.admins, (d.totals.savingsTotalCents / 100).toFixed(2), d.totals.pendingLoans, (d.totals.finesPaidCents / 100).toFixed(2), (d.totals.cashLoanedCents / 100).toFixed(2), d.totals.itemsBorrowed];
    })
  ];
  const csv = '﻿' + rows.map(r => r.map(escCsv).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="super-admin-groups-report.csv"');
  res.send(csv);
}

// ---- Agreement PDF with QR code ----
function sendAgreementPDFWithQR(res, userId, agreement, req) {
  const u = dbm.db.users.find(x => x.id === userId && !x.deleted);
  if (!u) return res.status(404).send('User not found');
  const mp = dbm.memberProfileFor(userId);
  const brand = getBranding();
  const group = dbm.db.groups.find(g => g.id === u.groupId);
  const doc = new PdfDoc();
  doc.text(brand.name, { size: 18, bold: true, color: [17, 17, 17], dy: 26 });
  doc.text('Kenya Chama Agreement - DRAFT', { size: 14, bold: true, color: [68, 68, 68], dy: 18 });
  doc.text(`Generated (UTC): ${new Date().toISOString()}`, { size: 9, color: [102, 102, 102], dy: 16 });
  doc.rule();
  doc.text('Member Details', { size: 11, bold: true, dy: 16 });
  doc.text(`Name: ${u.firstName} ${u.lastName}`, { size: 10, dy: 14 });
  doc.text(`Email: ${u.email}`, { size: 10, dy: 14 });
  doc.text(`Phone: ${u.phone || '-'}`, { size: 10, dy: 14 });
  doc.text(`Group: ${group ? group.name : '-'}`, { size: 10, dy: 14 });
  doc.text(`Role: ${u.role}`, { size: 10, dy: 14 });
  doc.gap(6);
  doc.text('Terms and Conditions', { size: 11, bold: true, dy: 16 });
  doc.text('1. Cash loans are limited to 50% of the borrower\'s current savings.', { size: 9, dy: 13 });
  doc.text('2. Cash loans are due in 14 days from disbursement.', { size: 9, dy: 13 });
  doc.text('3. A one-time fine of 1% of the cash loan principal applies after the due date.', { size: 9, dy: 13 });
  doc.text('4. No new loan can be requested until the previous loan is cleared.', { size: 9, dy: 13 });
  doc.text('5. All transactions are recorded in an append-only ledger.', { size: 9, dy: 13 });
  doc.text('6. Loans cannot be verified or cleared by the borrower themselves.', { size: 9, dy: 13 });
  doc.gap(6);
  doc.text('Verification', { size: 11, bold: true, dy: 16 });
  doc.text(`Agreement ID: ${agreement.id}`, { size: 9, dy: 13 });
  doc.text(`Verification Token: ${agreement.verificationToken}`, { size: 9, dy: 13 });
  doc.text(`Document Hash: ${agreement.documentHash}`, { size: 9, dy: 13 });
  doc.gap(4);
  doc.text('Scan this QR code to verify this agreement was generated by the system:', { size: 9, dy: 13 });
  const qrData = JSON.stringify({ id: agreement.id, userId: u.id, token: agreement.verificationToken, hash: agreement.documentHash });
  const qrImg = qr.renderQR(qrData, 6);
  doc.image(qrImg.buffer, qrImg.width, qrImg.height, 46, doc.y - qrImg.height - 6, qrImg.width, qrImg.height);
  doc.gap(12);
  doc.text(`Confidential member agreement - ${brand.name}.`, { size: 8, color: [136, 136, 136] });
  const buf = doc.buffer();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="agreement-${userId}-${agreement.id}.pdf"`);
  res.setHeader('Content-Length', buf.length);
  res.send(buf);
}

// ---- Agreement PDF (signed) ----
function sendAgreementPDF(res, userId, req) {
  const u = dbm.db.users.find(x => x.id === userId && !x.deleted);
  if (!u) return res.status(404).send('User not found');
  const mp = dbm.memberProfileFor(userId);
  const agreement = dbm.agreementFor(userId);
  if (!agreement || !agreement.accepted) return res.status(403).send('Agreement has not been signed');
  const brand = getBranding();
  const group = dbm.db.groups.find(g => g.id === u.groupId);
  const doc = new PdfDoc();
  doc.text(brand.name, { size: 18, bold: true, color: [17, 17, 17], dy: 26 });
  doc.text('Kenya Chama Agreement', { size: 14, bold: true, color: [68, 68, 68], dy: 18 });
  doc.text(`Generated (UTC): ${new Date().toISOString()}`, { size: 9, color: [102, 102, 102], dy: 16 });
  doc.rule();
  doc.text('Member Details', { size: 11, bold: true, dy: 16 });
  doc.text(`Name: ${u.firstName} ${u.lastName}`, { size: 10, dy: 14 });
  doc.text(`Email: ${u.email}`, { size: 10, dy: 14 });
  doc.text(`Phone: ${u.phone || '-'}`, { size: 10, dy: 14 });
  doc.text(`Group: ${group ? group.name : '-'}`, { size: 10, dy: 14 });
  doc.text(`Role: ${u.role}`, { size: 10, dy: 14 });
  doc.gap(6);
  doc.text('Terms and Conditions', { size: 11, bold: true, dy: 16 });
  doc.text('1. Cash loans are limited to 50% of the borrower\'s current savings.', { size: 9, dy: 13 });
  doc.text('2. Cash loans are due in 14 days from disbursement.', { size: 9, dy: 13 });
  doc.text('3. A one-time fine of 1% of the cash loan principal applies after the due date.', { size: 9, dy: 13 });
  doc.text('4. No new loan can be requested until the previous loan is cleared.', { size: 9, dy: 13 });
  doc.text('5. All transactions are recorded in an append-only ledger.', { size: 9, dy: 13 });
  doc.text('6. Loans cannot be verified or cleared by the borrower themselves.', { size: 9, dy: 13 });
  doc.gap(6);
  if (agreement) {
    doc.text('Member Acceptance', { size: 11, bold: true, dy: 16 });
    doc.text(`Accepted electronically at: ${agreement.signedAt}`, { size: 9, dy: 13 });
    doc.text(`Terms version: ${agreement.termsVersion || 'legacy'}`, { size: 9, dy: 13 });
    doc.text(`Document hash: ${agreement.documentHash}`, { size: 9, dy: 13 });
    const approver = agreement.groupAdminSignedBy ? dbm.db.users.find(user => user.id === agreement.groupAdminSignedBy) : null;
    doc.gap(4);
    doc.text('Group Admin Approval', { size: 11, bold: true, dy: 16 });
    doc.text(approver ? `Digitally approved by ${approver.firstName} ${approver.lastName} at ${agreement.groupAdminSignedAt}.` : 'Awaiting Group Admin approval.', { size: 9, dy: 13 });
  } else {
    doc.text('Agreement not yet signed.', { size: 10, color: [200, 0, 0], dy: 14 });
  }
  doc.gap(12);
  doc.text(`Confidential member agreement - ${brand.name}.`, { size: 8, color: [136, 136, 136] });
  const buf = doc.buffer();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="agreement-${userId}.pdf"`);
  res.setHeader('Content-Length', buf.length);
  res.send(buf);
}

module.exports = {
  sendPDF, sendCSV, sendAdminSummary, groupData,
  sendStaffChamaPDF, sendStaffChamaCSV, sendStaffMemberPDF, sendStaffMemberCSV,
  sendSuperAdminGroupsPDF, sendSuperAdminGroupsCSV, sendAgreementPDF, sendAgreementPDFWithQR,
  getBranding, logExport, escCsv
};
