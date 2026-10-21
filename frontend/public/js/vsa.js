'use strict';
document.addEventListener('DOMContentLoaded', async () => {
  initBG('stars');
  const { me } = await api.get('/api/me');
  const loaders = {};

  const stat = (num, cap) => h('div', { class: 'card stat' }, h('div', { class: 'num' }, String(num)), h('div', { class: 'cap' }, cap));
  const badge = (t, k) => h('span', { class: 'badge ' + k }, t);
  const askVsaPw = () => prompt('Enter YOUR V Super Admin password to confirm this sensitive action:') ?? '';

  // ---------------- overview ----------------
  loaders.ov = async () => {
    const o = await api.get('/api/vsa/overview');
    const { groups } = await api.get('/api/vsa/groups');
    const s = document.getElementById('ov-stats');
    s.innerHTML = '';
    s.append(
      stat(o.users.super_admin, 'Super Admins'), stat(o.users.group_admin, 'Group Admins'),
      stat(o.users.admin, 'Admins'), stat(o.users.member, 'Members'), stat(o.groups, 'Groups'),
      stat(o.safeCodes.active, 'Safe codes unused'), stat(o.safeCodes.used, 'Safe codes used'),
      stat(o.locked, 'Locked accounts'), stat(o.pendingRequests, 'Pending requests'),
      stat(o.pendingStaffLoans, 'Pending staff loans'));
    const secBox = document.getElementById('ov-sec');
    secBox.innerHTML = '';
    const kv = [
      ['Safe-code gate at registration', o.safeCodeRequired ? 'ON ✅' : 'OFF ⚠️'],
      ['Locked after 4 failed logins', 'ENFORCED ✅'],
      ['Chat encryption', 'End-to-end AES-256-GCM ✅'],
      ['Password storage', 'salted scrypt ✅'],
      ['Security monitor', o.securityMonitorActive ? `Armed · ${o.failedLoginIpThreshold} failed logins per IP / 15m` : 'Inactive'],
      ['Teams security alerts', o.teamsAlertsConfigured ? 'Configured' : 'Not configured'],
      ['AI alerting', o.aiAlertsConfigured ? 'Configured' : 'Not enabled'],
      ['Audit events recorded', String(o.auditEvents)],
      ['Total chat messages (ciphertext)', String(o.messages)],
      ['Disabled accounts', String(o.disabled)]
    ];
    for (const [k, v] of kv) { secBox.append(h('div', { class: 'k' }, k), h('div', {}, v)); }
    renderTrendChart('vsa-trend-chart');
  };

  // ---------------- admins ----------------
  const groupName = async () => {
    const { groups } = await api.get('/api/vsa/groups');
    return groups;
  };
  loaders.admins = async () => {
    const groups = await groupName();
    const [sa, admin, ga] = await Promise.all([
      api.get('/api/vsa/users?role=super_admin'), api.get('/api/vsa/users?role=admin'), api.get('/api/vsa/users?role=group_admin')
    ]);
    const tbl = document.getElementById('admins-tbl');
    tbl.innerHTML = '';
    tbl.append(h('tr', {}, h('th', {}, 'User'), h('th', {}, 'Email'), h('th', {}, 'Phone'), h('th', {}, 'Role'), h('th', {}, 'Group'), h('th', {}, 'Status'), h('th', {}, 'Actions')));
    const gmap = Object.fromEntries(groups.map(g => [g.id, g.name]));
    for (const u of [...sa.users, ...admin.users, ...ga.users]) {
      const status = h('span', {}, badge(u.role.replace('_', ' '), 'acc'),
        u.locked ? ' ' : null, u.locked ? badge('locked', 'bad') : null,
        u.disabled ? ' ' : null, u.disabled ? badge('disabled', 'bad') : null);
      const acts = h('div', { class: 'btnrow' },
        h('button', { class: 'btn sm ghost', onclick: () => editAdmin(u, gmap) }, '✏ Edit'),
        h('button', {
          class: 'btn sm ghost', onclick: async () => {
            if (!confirm(`Reset password for ${u.email}?`)) return;
            try {
              const r = await api.post(`/api/vsa/users/${u.id}/reset-password`, { currentPassword: askVsaPw() });
              alert(`New temporary password for ${u.email}:\n\n${r.temporaryPassword}\n\n(all their sessions were killed)`);
            } catch (e) { toast(e.message, 'err'); }
          }
        }, '🔑 Reset password'),
        h('button', { class: 'btn sm ghost', onclick: async () => { try { const r = await api.post(`/api/vsa/users/${u.id}/toggle-disabled`, { currentPassword: askVsaPw() }); toast(r.disabled ? 'Account suspended' : 'Account activated'); loaders.admins(); } catch (e) { toast(e.message, 'err'); } } }, u.disabled ? 'Activate' : 'Suspend'),
        h('button', {
          class: 'btn sm danger', onclick: async () => {
            if (!confirm(`DELETE ${u.role} ${u.email}? This cannot be undone.`)) return;
            try { await api.del(`/api/vsa/users/${u.id}`, { currentPassword: askVsaPw() }); toast('Deleted'); loaders.admins(); }
            catch (e) { toast(e.message, 'err'); }
          }
        }, '🗑 Delete'),
        h('button', { class: 'btn sm ghost', onclick: async () => { try { window.open(api.url(`/api/vsa/staff/${u.id}/profile?format=pdf`), '_blank'); } catch (e) { toast(e.message, 'err'); } } }, '📄 Profile'));
      tbl.append(h('tr', {},
        h('td', {}, pic(u.pic, 'av'), u.name),
        h('td', {}, u.email), h('td', {}, u.phone || '-'),
        h('td', {}, badge(u.role.replace('_', ' '), 'acc')),
        h('td', {}, u.groupId ? (gmap[u.groupId] || '-') : '-'),
        h('td', {}, status), h('td', {}, acts)));
    }
  };
  async function editAdmin(u, gmap) {
    const fn = prompt('First name:', u.firstName); if (fn == null) return;
    const ln = prompt('Last name:', u.lastName); if (ln == null) return;
    const em = prompt('Email (leave empty to keep current masked value):', '');
    const ph = prompt('Phone (leave empty to keep current masked value):', '');
    const body = { firstName: fn, lastName: ln };
    if (em) body.email = em;
    if (ph) body.phone = ph;
    if (['group_admin', 'member'].includes(u.role)) {
      const g = prompt(`Group (id) — options: ${Object.entries(gmap).map(([i, n]) => i + '=' + n).join(', ')}:`, u.groupId || '');
      if (g) body.groupId = g;
    }
    try { body.currentPassword = askVsaPw(); await api.put(`/api/vsa/users/${u.id}`, body); toast('Updated'); loaders.admins(); }
    catch (e) { toast(e.message, 'err'); }
  }
  document.getElementById('na-go').addEventListener('click', async () => {
    try {
      const r = await api.post('/api/vsa/users', {
        firstName: document.getElementById('na-fn').value, lastName: document.getElementById('na-ln').value,
        email: document.getElementById('na-em').value, phone: document.getElementById('na-ph').value,
        role: document.getElementById('na-role').value,
        password: document.getElementById('na-pw').value,
        confirmPassword: document.getElementById('na-cp').value
      });
      alert(`${r.user.role.replace('_', ' ')} account created for ${r.user.email}.\nTemporary password:\n\n${r.temporaryPassword}\n\nShare it securely. A copy was emailed when email is configured.`);
      ['na-fn', 'na-ln', 'na-em', 'na-ph', 'na-pw', 'na-cp'].forEach(i => document.getElementById(i).value = '');
      loaders.admins();
    } catch (e) {
      const errs = e.data && e.data.errors;
      toast(errs ? Object.values(errs).join(' · ') : e.message, 'err');
    }
  });

  // ---------------- charts ----------------
  async function renderTrendChart(canvasId) {
    const target = document.getElementById(canvasId);
    if (!target || !window.FinanceChart) return;
    let data;
    try { data = await api.get('/api/vsa/charts/trends'); } catch { return; }
    FinanceChart.render(target, data.labels, [
      { name: 'Savings (KES)', values: data.savings.map(value => Number(value || 0) * 100), color: '#4ade80' },
      { name: 'Loans (KES)', values: data.loans.map(value => Number(value || 0) * 100), color: '#f2c14e' }
    ]);
  }

  // ---------------- groups ----------------
  loaders.groups = async () => {
    const { groups } = await api.get('/api/vsa/groups');
    const tbl = document.getElementById('groups-tbl');
    tbl.innerHTML = '';
    tbl.append(h('tr', {}, h('th', {}, 'ID'), h('th', {}, 'Name'), h('th', {}, 'Description'), h('th', {}, 'Members'), h('th', {}, 'Pending loans'), h('th', {}, 'Fines paid'), h('th', {}, 'Items borrowed'), h('th', {}, 'Admins'), h('th', {}, 'Created'), h('th', {}, 'Status'), h('th', {}, 'Actions')));
    for (const g of groups) {
      tbl.append(h('tr', {},
        h('td', {}, String(g.id)), h('td', {}, g.name), h('td', { class: 'muted' }, g.description || '-'),
        h('td', {}, String(g.members) + ' / 30'), h('td', {}, String(g.pendingLoanRequests || 0)), h('td', {}, 'KES ' + Number(g.finesPaid || 0).toFixed(2)), h('td', {}, String(g.itemsBorrowed || 0)), h('td', {}, String(g.admins)), h('td', {}, fmtDate(g.createdAt)), h('td', {}, g.suspended ? badge('Suspended', 'bad') : badge('Active', 'ok')),
        h('td', {}, h('div', { class: 'btnrow' },
          h('button', { class: 'btn sm ghost', onclick: async () => { try { const d = await api.get('/api/vsa/groups/' + g.id + '/details'); alert(`${d.group.name}\n\nMembers: ${d.members.length}/30\nGroup admins: ${d.admins.map(a => a.name).join(', ') || '-'}\nItems: ${d.items.map(i => i.name).join(', ') || '-'}\nLoans: ${d.loans.length}\nPending loan requests: ${d.group.pendingLoanRequests}\nFines paid: KES ${Number(d.group.finesPaid).toFixed(2)}`); } catch (e) { toast(e.message, 'err'); } } }, 'View details'),
          h('button', {
            class: 'btn sm ghost', onclick: async () => {
              const n = prompt('Group name:', g.name); if (n == null) return;
              const d = prompt('Description:', g.description || ''); if (d == null) return;
              try { await api.put('/api/vsa/groups/' + g.id, { name: n, description: d }); toast('Saved'); loaders.groups(); }
              catch (e) { toast(e.message, 'err'); }
            }
          }, '✏'),
          h('button', { class: 'btn sm ghost', onclick: async () => { try { const r = await api.post('/api/vsa/groups/' + g.id + '/toggle-suspended', { currentPassword: askVsaPw() }); toast(r.suspended ? 'Group suspended' : 'Group restored'); loaders.groups(); } catch (e) { toast(e.message, 'err'); } } }, g.suspended ? 'Restore' : 'Suspend'),
          h('button', {
            class: 'btn sm danger', onclick: async () => {
              if (!confirm(`Delete group "${g.name}"? Members keep accounts but lose the group.`)) return;
              try { await api.del('/api/vsa/groups/' + g.id, { currentPassword: askVsaPw() }); toast('Deleted'); loaders.groups(); }
              catch (e) { toast(e.message, 'err'); }
            }
          }, '🗑')))));
    }
  };

  // ---------------- Owner Loan Queue ----------------
  loaders['financial-verifications'] = async () => {
    const { verifications } = await api.get('/api/vsa/financial-verifications');
    const table = document.getElementById('financial-verifications-tbl');
    table.replaceChildren(h('tr', {}, h('th', {}, 'Account / role'), h('th', {}, 'Group'), h('th', {}, 'Type'), h('th', {}, 'Amount'), h('th', {}, 'Week'), h('th', {}, 'Reported'), h('th', {}, 'Action')));
    for (const item of verifications) table.append(h('tr', {},
      h('td', {}, item.member ? `${item.member.name} (${item.member.email}) · ${String(item.submittedRole || 'member').replace(/_/g, ' ')}` : 'Deleted account'),
      h('td', {}, item.group), h('td', {}, item.kind === 'saving' ? 'Savings' : 'Registration fee'),
      h('td', {}, 'KES ' + (Number(item.amountCents || 0) / 100).toFixed(2)), h('td', {}, item.week || '-'), h('td', {}, fmtDate(item.reportedAt)),
      h('td', {}, h('button', { class: 'btn sm', onclick: async () => {
        if (!confirm('Confirm that you received this payment?')) return;
        try { await api.post(`/api/vsa/financial-verifications/${item.kind}/${item.id}/verify`); toast('Payment verified'); loaders['financial-verifications'](); }
        catch (error) { toast(error.message, 'err'); }
      } }, 'Verify receipt'))));
    if (!verifications.length) table.append(h('tr', {}, h('td', { colspan: '7', class: 'muted' }, 'No financial reports are waiting for Owner verification.')));
  };

  // ---------------- safe codes ----------------
  loaders.codes = async () => {
    const o = await api.get('/api/vsa/overview');
    document.getElementById('sc-toggle').checked = o.safeCodeRequired;
    const { codes } = await api.get('/api/vsa/safe-codes');
    const tbl = document.getElementById('codes-tbl');
    tbl.innerHTML = '';
    tbl.append(h('tr', {}, h('th', {}, 'Code'), h('th', {}, 'Group'), h('th', {}, 'Status'), h('th', {}, 'Created'), h('th', {}, 'Used at'), h('th', {}, 'Actions')));
    for (const c of codes) {
      const st = c.used ? badge('used', 'ok') : (c.active ? badge('active', 'acc') : badge('revoked', 'bad'));
      tbl.append(h('tr', {},
        h('td', {}, h('code', {}, c.code)), h('td', {}, c.group), h('td', {}, st),
        h('td', {}, fmtDate(c.createdAt)), h('td', {}, c.usedAt ? fmtDate(c.usedAt) : '-'),
        h('td', {}, (!c.used && c.active) ? h('button', {
          class: 'btn sm danger', onclick: async () => {
            try { await api.del('/api/vsa/safe-codes/' + c.id); toast('Revoked'); loaders.codes(); } catch (e) { toast(e.message, 'err'); }
          }
        }, 'Revoke') : '-')));
    }
  };
  document.getElementById('sc-toggle').addEventListener('change', async e => {
    try {
      await api.put('/api/vsa/settings', { safe_code_required: e.target.checked ? '1' : '0' });
      toast('Safe code gate is now ' + (e.target.checked ? 'ON' : 'OFF'));
    } catch (er) { toast(er.message, 'err'); e.target.checked = !e.target.checked; }
  });

  // ---------------- locked / disabled ----------------
  loaders.locked = async () => {
    const { users } = await api.get('/api/vsa/users');
    const rows = users.filter(u => u.locked || u.disabled);
    const tbl = document.getElementById('locked-tbl');
    tbl.innerHTML = '';
    if (!rows.length) { tbl.append(h('tr', {}, h('td', { class: 'muted' }, '✅ No locked or disabled accounts right now.'))); return; }
    tbl.append(h('tr', {}, h('th', {}, 'User'), h('th', {}, 'Email'), h('th', {}, 'Role'), h('th', {}, 'State'), h('th', {}, 'Failed logins'), h('th', {}, 'Actions')));
    for (const u of rows) {
      tbl.append(h('tr', {},
        h('td', {}, pic(u.pic, 'av'), u.name), h('td', {}, u.email),
        h('td', {}, u.role.replace('_', ' ')),
        h('td', {}, u.locked ? badge('LOCKED (4 strikes)', 'bad') : badge('DISABLED', 'warn')),
        h('td', {}, String(u.failed || 0)),
        h('td', {}, h('div', { class: 'btnrow' },
          h('button', {
            class: 'btn sm', onclick: async () => {
              try { await api.post(`/api/vsa/users/${u.id}/unlock`); toast('Unlocked'); loaders.locked(); } catch (e) { toast(e.message, 'err'); }
            }
          }, '🔓 Unlock / re-enable'),
          h('button', {
            class: 'btn sm ghost', onclick: async () => {
              try { const r = await api.post(`/api/vsa/users/${u.id}/toggle-disabled`, { currentPassword: askVsaPw() }); toast(r.disabled ? 'Login disabled' : 'Login enabled'); loaders.locked(); }
              catch (e) { toast(e.message, 'err'); }
            }
          }, u.disabled ? 'Enable login' : 'Disable login')))));
    }
  };

  // ---------------- all users ----------------
  loaders.users = async () => {
    const [{ users }, groups] = await Promise.all([api.get('/api/vsa/users'), groupName()]);
    const groupMap = Object.fromEntries(groups.map(group => [group.id, group.name]));
    const tbl = document.getElementById('users-tbl');
    tbl.innerHTML = '';
    tbl.append(h('tr', {}, h('th', {}, 'User'), h('th', {}, 'Email'), h('th', {}, 'Phone'), h('th', {}, 'Role'), h('th', {}, 'Group'), h('th', {}, 'Joined'), h('th', {}, 'State'), h('th', {}, 'Actions')));
    for (const u of users) {
      tbl.append(h('tr', {},
        h('td', {}, pic(u.pic, 'av'), u.name), h('td', {}, u.email), h('td', {}, u.phone || '-'),
        h('td', {}, u.role.replace('_', ' ')), h('td', {}, groupMap[u.groupId] || '-'), h('td', {}, fmtDate(u.createdAt)),
        h('td', {}, u.locked ? badge('locked', 'bad') : u.disabled ? badge('disabled', 'warn') : badge('active', 'ok')),
        h('td', {}, u.id === me.id ? '-' : h('div', { class: 'btnrow' },
          h('button', { class: 'btn sm ghost', onclick: () => editAdmin(u, groupMap) }, 'Edit'),
          h('button', {
            class: 'btn sm ghost', onclick: async () => {
              if (!confirm(`Reset password for ${u.email}?`)) return;
              try {
                const r = await api.post(`/api/vsa/users/${u.id}/reset-password`, { currentPassword: askVsaPw() });
                alert(`Temporary password for ${u.email}:\n\n${r.temporaryPassword}`);
              } catch (e) { toast(e.message, 'err'); }
            }
          }, 'Reset password')))));
    }
  };

  // ---------------- Owner Loan Queue ----------------
  loaders['owner-loans'] = async () => {
    const { loans } = await api.get('/api/vsa/staff-loans');
    const tbl = document.getElementById('owner-loans-tbl');
    tbl.innerHTML = '';
    tbl.append(h('tr', {}, h('th', {}, 'Borrower'), h('th', {}, 'Type'), h('th', {}, 'Amount'), h('th', {}, 'Savings'), h('th', {}, 'Due'), h('th', {}, 'Fine'), h('th', {}, 'Status'), h('th', {}, 'Actions')));
    for (const l of loans) {
      const borrowerName = l.borrower ? (l.borrower.firstName + ' ' + l.borrower.lastName) : 'Unknown';
      const borrowerGroup = l.borrower ? (l.borrower.group || '-') : '-';
      const amount = l.type === 'cash' ? 'KES ' + ((l.amountCents || 0) / 100).toFixed(2) : l.itemName;
      const fine = l.type === 'cash' ? 'KES ' + ((l.fineCents || 0) / 100).toFixed(2) : '-';
      const actions = [];
      if (l.status === 'pending') {
        actions.push(h('button', { class: 'btn sm', onclick: async () => { try { await api.post('/api/vsa/staff-loans/' + l.id + '/verify', { type: l.type }); toast('Verified'); loaders['owner-loans'](); loaders.ov(); } catch (e) { toast(e.message, 'err'); } } }, '✅ Verify'));
        actions.push(h('button', { class: 'btn sm danger', onclick: async () => { try { await api.post('/api/vsa/staff-loans/' + l.id + '/reject', { type: l.type }); toast('Rejected'); loaders['owner-loans'](); loaders.ov(); } catch (e) { toast(e.message, 'err'); } } }, '❌ Reject'));
      }
      if (l.status === 'verified') {
        actions.push(h('button', { class: 'btn sm', onclick: async () => { try { await api.post('/api/vsa/staff-loans/' + l.id + '/disburse', { type: l.type }); toast('Disbursed'); loaders['owner-loans'](); loaders.ov(); } catch (e) { toast(e.message, 'err'); } } }, '💰 Disburse'));
      }
      if (['disbursed', 'overdue'].includes(l.status)) {
        actions.push(h('button', { class: 'btn sm ghost', onclick: async () => { try { const x = await api.post('/api/vsa/staff-loans/' + l.id + '/clear', { type: l.type }); toast('Cleared: KES ' + (x.amountDue / 100).toFixed(2)); loaders['owner-loans'](); loaders.ov(); } catch (e) { toast(e.message, 'err'); } } }, '✔ Clear'));
      }
      tbl.append(h('tr', {},
        h('td', {}, `${borrowerName} (${borrowerGroup}) · ${(l.borrower && l.borrower.role || 'staff').replace(/_/g, ' ')}`), h('td', {}, l.type),
        h('td', {}, amount), h('td', {}, 'KES ' + ((l.borrowerSavingsCents || 0) / 100).toFixed(2)),
        h('td', {}, l.dueAt ? fmtDate(l.dueAt) : '-'), h('td', {}, fine),
        h('td', {}, badge(l.status, l.status === 'pending' ? 'warn' : l.status === 'cleared' ? 'ok' : l.status === 'rejected' ? 'bad' : 'acc')),
        h('td', {}, h('div', { class: 'btnrow' }, ...actions))));
    }
    if (!loans.length) tbl.append(h('tr', {}, h('td', { class: 'muted', colspan: '8' }, 'No staff loans pending.')));
  };

  // ---------------- reports ----------------
  loaders.reports = async () => {
    const { groups } = await api.get('/api/vsa/groups');
    const sel = document.getElementById('rp-group');
    sel.innerHTML = '';
    groups.forEach(g => sel.append(h('option', { value: g.id }, g.name)));
  };
  const download = async (fmt) => {
    const gid = document.getElementById('rp-group').value;
    if (!gid) return toast('No group available', 'err');
    try {
      const r = await fetch(api.url(`/api/vsa/groups/${gid}/report?format=${fmt}`), { headers: { 'X-Requested-With': 'XMLHttpRequest' }, credentials: 'include' });
      if (!r.ok) { const j = await r.json().catch(() => null); throw new Error((j && j.error) || 'Download failed'); }
      const blob = await r.blob();
      const cd = r.headers.get('Content-Disposition') || '';
      const name = (cd.match(/filename="([^"]+)"/) || [])[1] || `report.${fmt}`;
      const a = h('a', { href: URL.createObjectURL(blob), download: name });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast(fmt.toUpperCase() + ' report downloaded');
    } catch (e) { toast(e.message, 'err'); }
  };
  document.getElementById('rp-pdf').addEventListener('click', () => download('pdf'));
  document.getElementById('rp-csv').addEventListener('click', () => download('csv'));
  const downloadAdminSummary = async (fmt) => {
    try { const r = await fetch(api.url(`/api/vsa/reports/group-admin-summary?format=${fmt}`), { headers: { 'X-Requested-With': 'XMLHttpRequest' }, credentials: 'include' }); if (!r.ok) throw new Error('Download failed'); const a = h('a', { href: URL.createObjectURL(await r.blob()), download: `group-admin-summary.${fmt}` }); document.body.append(a); a.click(); a.remove(); toast('Group admin summary downloaded'); } catch (e) { toast(e.message, 'err'); }
  };
  document.getElementById('gas-pdf').addEventListener('click', () => downloadAdminSummary('pdf'));
  document.getElementById('gas-csv').addEventListener('click', () => downloadAdminSummary('csv'));
  const downloadStaffChama = async (fmt) => {
    try { const r = await fetch(api.url(`/api/vsa/staff-chama/report?format=${fmt}`), { headers: { 'X-Requested-With': 'XMLHttpRequest' }, credentials: 'include' }); if (!r.ok) throw new Error('Download failed'); const a = h('a', { href: URL.createObjectURL(await r.blob()), download: `staff-chama-report.${fmt}` }); document.body.append(a); a.click(); a.remove(); toast('Staff Chama report downloaded'); } catch (e) { toast(e.message, 'err'); }
  };
  document.getElementById('staff-pdf').addEventListener('click', () => downloadStaffChama('pdf'));
  document.getElementById('staff-csv').addEventListener('click', () => downloadStaffChama('csv'));

  loaders.resets = async () => {
    const { requests } = await api.get('/api/vsa/password-resets'); const tbl = document.getElementById('reset-tbl'); tbl.innerHTML = '';
    tbl.append(h('tr', {}, h('th', {}, 'Account'), h('th', {}, 'Requested'), h('th', {}, 'Status'), h('th', {}, 'Action')));
    for (const q of requests) tbl.append(h('tr', {}, h('td', {}, q.name + ' · ' + q.email), h('td', {}, fmtDate(q.requestedAt)), h('td', {}, q.status), h('td', {}, q.status === 'pending' ? h('button', { class: 'btn sm', onclick: async () => { try { await api.post('/api/vsa/password-resets/' + q.id + '/approve'); toast('Approved; reset link sent'); loaders.resets(); } catch (e) { toast(e.message, 'err'); } } }, 'Approve') : '-')));
  };
  loaders.notes = async () => {
    const { groups } = await api.get('/api/vsa/groups'); const s = document.getElementById('note-group'); s.innerHTML = ''; s.append(h('option', { value: '' }, 'All group admins')); groups.forEach(g => s.append(h('option', { value: g.id }, g.name)));
  };
  document.getElementById('note-send').addEventListener('click', async () => { try { const r = await api.post('/api/vsa/notes', { title: document.getElementById('note-title').value, body: document.getElementById('note-body').value, groupId: document.getElementById('note-group').value }); toast(`Note delivered to ${r.delivered} group admin(s)`); document.getElementById('note-title').value = ''; document.getElementById('note-body').value = ''; } catch (e) { toast(e.message, 'err'); } });

  // ---------------- audit ----------------
  loaders.audit = async () => {
    const { audit } = await api.get('/api/vsa/audit');
    const tbl = document.getElementById('audit-tbl');
    tbl.innerHTML = '';
    tbl.append(h('tr', {}, h('th', {}, 'Time'), h('th', {}, 'Actor role'), h('th', {}, 'Action'), h('th', {}, 'Target'), h('th', {}, 'IP')));
    for (const a of audit) {
      tbl.append(h('tr', {}, h('td', {}, fmtDate(a.at)), h('td', {}, a.actorRole || 'system'),
        h('td', {}, h('code', {}, a.action)), h('td', { class: 'muted' }, a.target || '-'), h('td', { class: 'muted' }, a.ip || '-')));
    }
  };

  loaders.branding = async () => {
    const { branding } = await api.get('/api/vsa/branding');
    const current = branding || { name: 'VonDonald051 Savings', logo: null, colors: null };
    const defaults = {
      v_super_admin: { accent: '#f2c14e', background: '#04060b' },
      super_admin: { accent: '#f2c14e', background: '#04060b' },
      admin: { accent: '#f2c14e', background: '#04060b' },
      group_admin: { accent: '#57b5df', background: '#07182a' },
      member: { accent: '#187e67', background: '#f4f8f6' }
    };
    const colors = Object.fromEntries(Object.entries(defaults).map(([role, value]) => [role, current.colors?.[role] || value]));
    const editor = document.getElementById('branding-editor');
    editor.replaceChildren();
    const name = h('input', { class: 'inp', maxlength: '60', value: current.name || '', placeholder: 'System name' });
    const logoFile = h('input', { class: 'inp', type: 'file', accept: 'image/png,image/jpeg,image/webp' });
    const logoPreview = h('img', { alt: 'Current system logo', style: 'width:88px;height:88px;object-fit:contain;border-radius:14px;border:1px solid var(--line);background:var(--panel);padding:8px' });
    logoPreview.hidden = !current.logo;
    if (current.logo) logoPreview.src = current.logo;
    const clearLogo = h('input', { type: 'checkbox' });
    logoFile.addEventListener('change', () => {
      const file = logoFile.files[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) { logoFile.value = ''; return toast('Logo must be 2MB or smaller', 'err'); }
      logoPreview.src = URL.createObjectURL(file);
      logoPreview.hidden = false;
      clearLogo.checked = false;
    });
    const colorInputs = {};
    const roleNames = { v_super_admin: 'V Super Admin (Owner)', super_admin: 'Super Admin', admin: 'Admin', group_admin: 'Group Admin', member: 'Member' };
    const colorGrid = h('div', { class: 'grid cols2 mt' });
    let savedColors = Object.fromEntries(Object.entries(colors).map(([role, value]) => [role, { ...value }]));
    for (const [role, label] of Object.entries(roleNames)) {
      const accent = h('input', { class: 'inp', type: 'color', value: colors[role].accent, 'aria-label': `${label} accent` });
      const background = h('input', { class: 'inp', type: 'color', value: colors[role].background, 'aria-label': `${label} background` });
      colorInputs[role] = { accent, background };
      const saveRole = h('button', { class: 'btn sm' }, 'Save colors');
      const resetRole = h('button', { class: 'btn sm ghost' }, 'Reset');
      const roleCard = h('div', { class: 'card' }, h('h3', { class: 'mb' }, label), h('label', { class: 'f' }, 'Accent color'), accent, h('label', { class: 'f mt' }, 'Background color'), background, h('div', { class: 'btnrow mt' }, saveRole, resetRole));
      const persistRole = async (value) => {
        saveRole.disabled = resetRole.disabled = true;
        try {
          const nextColors = Object.fromEntries(Object.entries(savedColors).map(([key, item]) => [key, { ...item }]));
          nextColors[role] = value;
          const result = await api.post('/api/vsa/branding', { name: current.name, colors: nextColors });
          savedColors = nextColors;
          current.colors = nextColors;
          DASH.applyBranding(result.branding, me.role);
          toast(`${label} colors ${value.accent === defaults[role].accent && value.background === defaults[role].background ? 'reset' : 'saved'}`);
        } catch (error) { toast(error.message, 'err'); }
        finally { saveRole.disabled = resetRole.disabled = false; }
      };
      saveRole.addEventListener('click', () => persistRole({ accent: accent.value, background: background.value }));
      resetRole.addEventListener('click', () => {
        accent.value = defaults[role].accent;
        background.value = defaults[role].background;
        persistRole({ ...defaults[role] });
      });
      colorGrid.append(roleCard);
    }
    const saveIdentity = h('button', { class: 'btn' }, 'Save system name and logo');
    saveIdentity.addEventListener('click', async () => {
      saveIdentity.disabled = true;
      try {
        let logo = '';
        const file = logoFile.files[0];
        if (file) {
          if (file.size > 2 * 1024 * 1024) throw new Error('Logo must be 2MB or smaller');
          logo = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('Could not read logo file')); reader.readAsDataURL(file); });
        }
        const result = await api.post('/api/vsa/branding', { name: name.value, logo, clearLogo: clearLogo.checked && !logo });
        current.name = result.branding.name;
        current.logo = result.branding.logo;
        DASH.applyBranding(result.branding, me.role);
        logoPreview.hidden = !result.branding.logo;
        if (result.branding.logo) logoPreview.src = result.branding.logo;
        else logoPreview.removeAttribute('src');
        logoFile.value = '';
        clearLogo.checked = false;
        toast('System name and logo saved');
      } catch (error) { toast(error.message, 'err'); }
      finally { saveIdentity.disabled = false; }
    });
    editor.append(h('div', { class: 'card mb' }, h('h3', { class: 'mb' }, 'System name and login logo'), h('label', { class: 'f' }, 'System name'), name,
      h('div', { class: 'btnrow mt' }, logoPreview, h('div', {}, h('label', { class: 'f' }, 'Logo (PNG, JPG or WebP · up to 2MB)'), logoFile, h('label', { class: 'check mt' }, clearLogo, 'Remove current logo')))),
      h('div', { class: 'card mb' }, h('h3', { class: 'mb' }, 'Role colors'), h('div', { class: 'small muted' }, 'Edit colors freely; each role changes only when its Save colors button is clicked. Reset restores that role’s original palette.'), colorGrid));
    editor.querySelector('.card').append(saveIdentity);
  };

   // ---------------- chrome ----------------
   const NAV = [
     ['ov', '🏠', 'Command Center'], ['branding', '🎨', 'System Branding'], ['admins', '🛡️', 'Admins'], ['groups', '👥', 'Groups'],
     ['codes', '🔐', 'Safe Codes'], ['locked', '🔒', 'Locked Accounts'], ['users', '📇', 'All Users'],
    ['owner-loans', '💳', 'Owner Loan Queue'], ['financial-verifications', '✓', 'Financial Verifications'], ['reports', '📊', 'Reports'], ['resets', '🔑', 'Reset Approvals'], ['notes', '📝', 'Admin Notes'], ['chat', '✉', 'Admin Chat'], ['notif', '🔔', 'Notifications'], ['audit', '🧾', 'Audit Trail'], ['profile', '🖼️', 'My Profile']
   ];
   let chatStarted = false;
   let notifLoad = DASH.notifView('view-notif');
   let currentBranding = { name: 'VonDonald051 Savings', logo: null, colors: null };
   try { const { branding } = await api.get('/api/auth/branding'); if (branding) currentBranding = branding; } catch (e) { /* noop */ }
   DASH.buildChrome(me, currentBranding.name + ' · V SUPER ADMIN', NAV, id => {
    if (id === 'notif') notifLoad();
    else if (id === 'branding') loaders.branding();
    else if (id === 'owner-loans') loaders['owner-loans']();
    else if (id === 'chat' && !chatStarted) { chatStarted = true; CHAT.init(me); }
    else if (loaders[id]) loaders[id]();
  }, currentBranding);
  DASH.wireProfile(me);
  loaders.ov();
});
